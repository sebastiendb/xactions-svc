// Microservice mince autour de XActions (nirholas/XActions, lib `xactions`).
// Publie sur X/Twitter (texte, médias, threads, replies) + lit les stats + supprime,
// via l'API INTERNE de X (GraphQL, cookies auth_token+ct0 — pas de navigateur).
// Appelé par PurrPlan, par compte. Auth Bearer (XACTIONS_API_KEY). Sortie via proxy
// résidentiel optionnel (XACTIONS_PROXY) pour une IP cohérente avec les cookies
// (sinon X renvoie l'erreur 226 « automated »).
//
// On utilise TwitterHttpClient + fonctions directes (PAS createHttpScraper, qui
// appelle verify_credentials = 404 chez X aujourd'hui).
import express from 'express'
import {
  TwitterHttpClient,
  postTweet,
  postThread,
  deleteTweet,
  scrapeTweetById,
  scrapeProfileById,
  scrapeTweets,
  uploadMedia,
} from 'xactions/scrapers/twitter/http'
import { browserFetch, transportSelfTest } from './browser-transport.js'

const app = express()
app.use(express.json({ limit: '4mb' }))

const API_KEY = process.env.XACTIONS_API_KEY || ''
const PROXY = process.env.XACTIONS_PROXY || undefined

app.use((req, res, next) => {
  if (req.path === '/health') return next()
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!API_KEY || token !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
  next()
})

app.get('/health', (req, res) => res.json({ ok: true, service: 'xactions-svc' }))

// Diagnostic du transport : IP de sortie RÉELLE, empreinte TLS (JA4) et
// disponibilité du transaction-id. Sert à vérifier d'un coup d'œil qu'on sort bien
// par l'IP résidentielle avec une signature Chrome (et pas par le datacenter en
// signature Node, ce qui faisait flagger le compte). Auth requise.
app.get('/transport', async (req, res) => {
  try {
    res.json({ ok: true, ...(await transportSelfTest()) })
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

function cookieString(c) {
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')
  return ''
}

function clientFor(cookies) {
  // `fetch: browserFetch` = TOUT le trafic X part avec l'empreinte TLS/HTTP2 de
  // Chrome, par le proxy résidentiel, avec les en-têtes d'un vrai client x.com
  // (dont x-client-transaction-id). ⚠️ `proxy:` est conservé pour mémoire mais la
  // lib ne l'applique PAS (no-op vérifié en prod) : c'est notre fetch qui proxifie.
  return new TwitterHttpClient({ cookies, proxy: PROXY, fetch: browserFetch })
}

// Identifiant d'un tweet à partir de l'objet renvoyé par CreateTweet.
function tweetId(result) {
  return (result && (result.rest_id || (result.legacy && result.legacy.id_str) || result.id_str || result.id)) || null
}

// Télécharge des URLs média et les upload via XActions → media_ids.
async function uploadMediaUrls(client, urls) {
  const ids = []
  for (const url of (urls || [])) {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`media fetch ${resp.status} ${url}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    const mediaType = resp.headers.get('content-type') || undefined
    const r = await uploadMedia(client, buf, mediaType ? { mediaType } : {})
    const id = (r && (r.media_id_string || r.mediaIdString || r.media_id || r.id)) || (typeof r === 'string' ? r : null)
    if (id) ids.push(String(id))
  }
  return ids
}

// Publier un tweet (texte + médias + reply) ou un thread.
app.post('/tweet', async (req, res) => {
  try {
    const cookies = cookieString(req.body.cookies)
    if (!cookies) return res.status(400).json({ ok: false, error: 'cookies required (auth_token + ct0)' })
    const client = clientFor(cookies)

    // Thread : [{text, mediaUrls?}]
    if (Array.isArray(req.body.tweets) && req.body.tweets.length) {
      const prepared = []
      for (const t of req.body.tweets) {
        const mediaIds = await uploadMediaUrls(client, t.mediaUrls)
        prepared.push({ text: (t.text || '').toString(), mediaIds })
      }
      const results = await postThread(client, prepared)
      const ids = (results || []).map(tweetId)
      // ok reflète la RÉALITÉ : au moins un tweet créé (id non nul). X peut renvoyer
      // 200 sans créer le tweet → id null → ce n'est PAS un succès.
      return res.json({ ok: ids.some(Boolean), ids, id: ids[0] || null, results })
    }

    const text = (req.body.text || '').toString()
    const mediaIds = await uploadMediaUrls(client, req.body.mediaUrls)
    if (!text.trim() && !mediaIds.length) return res.status(400).json({ ok: false, error: 'text or media required' })

    const options = { mediaIds }
    if (req.body.replyTo) options.replyTo = String(req.body.replyTo)
    if (req.body.quoteTweetId) options.quoteTweetId = String(req.body.quoteTweetId)
    if (req.body.premium) options.premium = true

    const result = await postTweet(client, text, options)
    const id = tweetId(result)
    // Si X n'a pas renvoyé d'id, le tweet N'A PAS été créé (souvent 200 + errors
    // avalés en amont, ou tweet_results vide) → ok:false + error explicite, pas un
    // faux succès. Le patch lib (patch-xactions.cjs) fait remonter le motif exact de X.
    if (!id) {
      return res.status(502).json({ ok: false, error: 'x_no_tweet_id', result })
    }
    res.json({ ok: true, id, url: `https://x.com/i/web/status/${id}`, result })
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

// Stats d'un tweet (likes, retweets, replies, views…).
app.post('/tweet/stats', async (req, res) => {
  try {
    const cookies = cookieString(req.body.cookies)
    const id = (req.body.id || '').toString()
    if (!cookies || !id) return res.status(400).json({ ok: false, error: 'cookies and id required' })
    const tweet = await scrapeTweetById(clientFor(cookies), id)
    res.json({ ok: true, tweet })
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

// Mes tweets récents (pour stats + gestion). userId déduit du cookie `twid`.
app.post('/me/tweets', async (req, res) => {
  try {
    const cookies = cookieString(req.body.cookies)
    if (!cookies) return res.status(400).json({ ok: false, error: 'cookies required' })
    const client = clientFor(cookies)
    const twid = (cookies.match(/twid=([^;]+)/) || [])[1] || ''
    const uid = decodeURIComponent(twid).replace(/^u[=:]/, '')
    if (!uid) return res.status(400).json({ ok: false, error: 'twid cookie required to resolve user' })
    const profile = await scrapeProfileById(client, uid)
    const username = profile && (profile.username || profile.screen_name)
    const tweets = await scrapeTweets(client, username, { limit: req.body.limit || 20 })
    res.json({
      ok: true,
      username,
      tweets: (tweets || []).map((t) => ({
        id: t.id || t.rest_id || (t.legacy && t.legacy.id_str),
        text: t.text || t.full_text || (t.legacy && t.legacy.full_text) || '',
        metrics: t.metrics || t.public_metrics || (t.legacy ? {
          likes: t.legacy.favorite_count, retweets: t.legacy.retweet_count, replies: t.legacy.reply_count, quotes: t.legacy.quote_count,
        } : null),
      })),
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

// Supprimer un tweet.
app.post('/tweet/delete', async (req, res) => {
  try {
    const cookies = cookieString(req.body.cookies)
    const id = (req.body.id || '').toString()
    if (!cookies || !id) return res.status(400).json({ ok: false, error: 'cookies and id required' })
    const result = await deleteTweet(clientFor(cookies), id)
    res.json({ ok: true, result })
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`xactions-svc écoute sur :${PORT} (proxy=${PROXY ? 'on' : 'off'})`))
