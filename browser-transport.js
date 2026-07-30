// Transport HTTP « navigateur » pour la lib xactions.
//
// POURQUOI (incident 2026-07, compte flaggé par X) : le client HTTP de la lib
// `xactions` présente trois signatures de bot que X (code 226 « looks like it might
// be automated ») lit sans effort :
//
//  1. Le PROXY EST UN NO-OP côté lib : `TwitterHttpClient` stocke `options.proxy`
//     mais ne l'applique JAMAIS à ses requêtes (vérifié en prod : sortie
//     37.187.254.130 = datacenter OVH, alors que les cookies viennent de la maison).
//     Cookie résidentiel + IP datacenter = incohérence majeure.
//  2. USER-AGENT TIRÉ AU HASARD à chaque requête, dans un pool figé Chrome 120 /
//     Firefox 121 (fin 2023) → le même compte se présente en Windows, puis macOS,
//     puis Linux, avec des versions périmées de ~2,5 ans.
//  3. EMPREINTE TLS de Node : JA4 `t13d5212h1_…` (HTTP/1.1, 52 ciphers) — aucune
//     ressemblance avec un navigateur. Aucun patch d'en-tête ne peut la corriger :
//     elle se joue sous la couche HTTP.
//
// CE QUE FAIT CE MODULE : un `fetch` compatible API Fetch, injectable dans la lib
// (`new TwitterHttpClient({ fetch })` — la lib fait `options.fetch || globalThis.fetch`),
// qui route TOUT via `impit` (Rust) en émulation Chrome :
//   - empreinte TLS + HTTP/2 réelles de Chrome (JA4 `t13d1516h2_…`, vérifié) ;
//   - proxy réellement appliqué (sortie = IP résidentielle du Mac mini) ;
//   - user-agent / sec-ch-ua posés PAR impit, donc cohérents avec le TLS annoncé.
//     ⚠️ On SUPPRIME l'UA de la lib : un UA explicite n'est PAS écrasé par impit et
//     produirait « UA Chrome 120 Windows » + « sec-ch-ua 142 macOS » = incohérence.
//   - en-têtes d'un vrai appel XHR x.com : accept, referer/origin, sec-fetch-* (cors),
//     accept-language FR (le compte est français) ;
//   - `x-client-transaction-id` calculé par requête (paquet `x-client-transaction-id`),
//     en-tête anti-bot que tout vrai client x.com envoie et que la lib omettait.

import { Impit } from 'impit';
import { parseHTML } from 'linkedom';
import { ClientTransaction } from 'x-client-transaction-id';

const BROWSER = process.env.XACTIONS_BROWSER || 'chrome142';
const PROXY = process.env.XACTIONS_PROXY || undefined;
const TIMEOUT_MS = Number(process.env.XACTIONS_TIMEOUT_MS || 30000);
// L'init du générateur télécharge la home x.com + son bundle `ondemand.s` : on la
// garde en cache et on la rafraîchit périodiquement (X fait tourner les clés).
const TX_TTL_MS = Number(process.env.XACTIONS_TX_TTL_MS || 30 * 60 * 1000);

const impit = new Impit({
    browser: BROWSER,
    proxyUrl: PROXY,
    timeout: TIMEOUT_MS,
    followRedirects: true,
});

let txCache = { tx: null, at: 0, initializing: null };

/**
 * Générateur de transaction-id, mis en cache. Best-effort : si X change son bundle
 * ou que le réseau tombe, on renvoie null → la requête part SANS l'en-tête (comme
 * avant ce module) plutôt que d'échouer sèchement.
 */
async function transactionGenerator() {
    const fresh = txCache.tx && Date.now() - txCache.at < TX_TTL_MS;
    if (fresh) return txCache.tx;
    if (txCache.initializing) return txCache.initializing;

    txCache.initializing = (async () => {
        try {
            // ⚠️ Le paquet appelle `globalThis.fetch` en DUR à 3 endroits (home x.com,
            // guest/activate, bundle `ondemand.s`) avec des en-têtes figés
            // (Chrome 135 Windows, accept-language « ja ») et ignore tout fetch
            // injecté. Or ces requêtes DOIVENT partir de la même IP et de la même
            // empreinte que les appels qui utiliseront l'id, sinon X voit deux
            // clients différents. On substitue donc le fetch global le temps de
            // l'init (sérialisée par `initializing`), puis on le restaure.
            const doc = await withGlobalFetch(async () => {
                const res = await impit.fetch('https://x.com/home', {
                    headers: {
                        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'accept-language': process.env.XACTIONS_ACCEPT_LANGUAGE || 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
                        'cache-control': 'no-cache',
                        pragma: 'no-cache',
                    },
                });
                if (!res.ok) throw new Error('x.com/home HTTP '.concat(String(res.status)));

                return parseHTML(await res.text()).window.document;
            });

            const tx = await withGlobalFetch(() => ClientTransaction.create(doc));
            txCache = { tx, at: Date.now(), initializing: null };
            return tx;
        } catch (e) {
            console.warn('[transport] init transaction-id impossible:', e?.message || e);
            txCache = { tx: null, at: Date.now(), initializing: null };
            return null;
        }
    })();

    return txCache.initializing;
}

/** Exécute `fn` avec `globalThis.fetch` routé par impit, puis restaure l'original. */
async function withGlobalFetch(fn) {
    const original = globalThis.fetch;
    globalThis.fetch = (u, o) => impit.fetch(typeof u === 'string' ? u : String(u), o || {});

    try {
        return await fn();
    } finally {
        globalThis.fetch = original;
    }
}

/** Chemin d'API attendu par le générateur (ex. `/i/api/graphql/<qid>/CreateTweet`). */
function apiPath(urlString) {
    try {
        const u = new URL(urlString);
        return u.pathname;
    } catch {
        return null;
    }
}

/** Cet appel vise-t-il l'API x.com (→ en-têtes XHR + transaction-id) ? */
function isXApi(urlString) {
    return /(^|\.)(x|twitter)\.com$/.test(safeHost(urlString)) || /api\.(x|twitter)\.com$/.test(safeHost(urlString));
}

function safeHost(urlString) {
    try {
        return new URL(urlString).host;
    } catch {
        return '';
    }
}

/** Normalise les en-têtes entrants (objet | Headers | tableau) en objet minuscule. */
function toPlainHeaders(headers) {
    const out = {};
    if (!headers) return out;

    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
        headers.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
        return out;
    }

    for (const [k, v] of Array.isArray(headers) ? headers : Object.entries(headers)) {
        if (k === undefined || v === undefined) continue;
        out[String(k).toLowerCase()] = String(v);
    }

    return out;
}

/**
 * `fetch` durci à injecter dans TwitterHttpClient.
 * Signature identique au fetch global (url, init) → Response.
 */
export async function browserFetch(url, init = {}) {
    const urlString = typeof url === 'string' ? url : String(url?.url || url);
    const headers = toPlainHeaders(init.headers);

    // L'UA de la lib est incohérent avec le TLS émulé → on le retire pour laisser
    // impit poser SON user-agent (aligné sur sec-ch-ua et sur l'empreinte TLS).
    delete headers['user-agent'];
    delete headers['accept-encoding']; // impit gère (gzip/br/zstd) ; un doublon détonne.

    if (isXApi(urlString)) {
        const method = (init.method || 'GET').toUpperCase();

        // En-têtes d'un vrai appel XHR depuis l'app web x.com.
        headers.accept = headers.accept || '*/*';
        headers['accept-language'] = process.env.XACTIONS_ACCEPT_LANGUAGE || 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';
        headers.referer = headers.referer || 'https://x.com/';
        headers.origin = headers.origin || 'https://x.com';
        headers['sec-fetch-site'] = 'same-origin';
        headers['sec-fetch-mode'] = 'cors';
        headers['sec-fetch-dest'] = 'empty';
        headers['x-twitter-active-user'] = headers['x-twitter-active-user'] || 'yes';

        const path = apiPath(urlString);
        if (path) {
            const tx = await transactionGenerator();
            if (tx) {
                try {
                    headers['x-client-transaction-id'] = await tx.generateTransactionId(method, path);
                } catch (e) {
                    console.warn('[transport] transaction-id non généré:', e?.message || e);
                }
            }
        }
    }

    return impit.fetch(urlString, { ...init, headers });
}

/** Diagnostic : IP de sortie + empreinte TLS réellement présentées (pour /health). */
export async function transportSelfTest() {
    const out = { browser: BROWSER, proxy: PROXY ? 'on' : 'off', ip: null, ja4: null, transaction_id: null };

    try {
        out.ip = (await impit.fetch('https://api.ipify.org').then((r) => r.text())).trim();
    } catch (e) {
        out.ip_error = String(e?.message || e);
    }

    try {
        const tls = await impit.fetch('https://tls.peet.ws/api/clean').then((r) => r.json());
        out.ja4 = tls?.ja4 || null;
    } catch (e) {
        out.ja4_error = String(e?.message || e);
    }

    try {
        const tx = await transactionGenerator();
        out.transaction_id = tx ? 'ok' : 'unavailable';
    } catch {
        out.transaction_id = 'unavailable';
    }

    return out;
}
