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
  BEARER_TOKEN,
  GRAPHQL,
  buildGraphQLUrl,
  DEFAULT_FEATURES,
} from 'xactions/scrapers/twitter/http'
import { ProxyAgent } from 'undici'

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

function cookieString(c) {
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')
  return ''
}

function clientFor(cookies) {
  return new TwitterHttpClient({ cookies, proxy: PROXY })
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
      return res.json({ ok: true, ids, id: ids[0] || null, results })
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
    res.json({ ok: true, id, url: id ? `https://x.com/i/web/status/${id}` : null, result })
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

// DEBUG : capture le corps BRUT de la réponse X pour une lecture (diagnostic du
// 403/404 — voir si c'est un queryId périmé, un souci de features, ou autre).
app.post('/debug/read', async (req, res) => {
  try {
    const cookies = cookieString(req.body.cookies)
    const userId = (req.body.userId || '').toString()
    const ct0 = (cookies.match(/ct0=([^;]+)/) || [])[1] || ''
    const { queryId, operationName } = GRAPHQL.UserByRestId
    const url = buildGraphQLUrl(queryId, operationName, { userId, withSafetyModeUserFields: true }, DEFAULT_FEATURES)
    const headers = {
      authorization: 'Bearer ' + decodeURIComponent(BEARER_TOKEN),
      'x-csrf-token': ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'content-type': 'application/json',
      accept: '*/*',
      cookie: cookies,
    }
    const opts = { headers }
    if (PROXY) opts.dispatcher = new ProxyAgent(PROXY)
    const r = await fetch(url, opts)
    const body = await r.text()
    res.json({ status: r.status, queryId, operationName, url: url.slice(0, 120), body: body.slice(0, 800) })
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
