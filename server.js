// Microservice mince autour de XActions (nirholas/XActions, lib `xactions`).
// Publie sur X/Twitter + lit les stats via l'API INTERNE de X (GraphQL CreateTweet,
// cookies auth_token+ct0 — pas de navigateur). Appelé par PurrPlan, par compte.
//
// Auth : Bearer (clé partagée XACTIONS_API_KEY), comme l'instance camofox.
// Cookies du compte passés PAR REQUÊTE (multi-tenant). Proxy résidentiel optionnel
// (XACTIONS_PROXY) pour faire sortir les appels sur une IP cohérente avec les cookies.
import express from 'express'
import { createHttpScraper } from 'xactions/scrapers/twitter/http'

const app = express()
app.use(express.json({ limit: '2mb' }))

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

// Accepte cookies en string "auth_token=..; ct0=.." ou en objet {auth_token, ct0}.
function cookieString(c) {
  if (typeof c === 'string') return c
  if (c && typeof c === 'object') return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')
  return ''
}

async function scraperFor(cookies) {
  return createHttpScraper({ cookies, proxy: PROXY })
}

// Publier un tweet (ou un thread si `tweets` fourni).
app.post('/tweet', async (req, res) => {
  try {
    const cookies = cookieString(req.body.cookies)
    if (!cookies) return res.status(400).json({ ok: false, error: 'cookies required (auth_token + ct0)' })
    const scraper = await scraperFor(cookies)

    if (Array.isArray(req.body.tweets) && req.body.tweets.length) {
      const result = await scraper.postThread(req.body.tweets)
      return res.json({ ok: true, result })
    }
    const text = (req.body.text || '').toString()
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' })
    const result = await scraper.postTweet(text, req.body.options || {})
    res.json({ ok: true, result })
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

// Stats d'un tweet (public metrics : likes, retweets, replies, views…).
app.post('/tweet/stats', async (req, res) => {
  try {
    const cookies = cookieString(req.body.cookies)
    const id = (req.body.id || '').toString()
    if (!cookies || !id) return res.status(400).json({ ok: false, error: 'cookies and id required' })
    const scraper = await scraperFor(cookies)
    const tweet = await scraper.scrapeTweetById(id)
    res.json({ ok: true, tweet })
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`xactions-svc écoute sur :${PORT} (proxy=${PROXY ? 'on' : 'off'})`))
