# Microservice XActions (publication X + stats via API interne, sans navigateur).
# Node 22 minimum : le générateur de `x-client-transaction-id` utilise
# ArrayBuffer.prototype.transfer, absent de Node 20 (échec « output.buffer.transfer
# is not a function » vérifié).
FROM node:22-slim

WORKDIR /app

# Pas de navigateur nécessaire (on utilise le client HTTP/GraphQL de xactions) →
# on évite de télécharger Chromium/Chrome au build (puppeteer/playwright sont des
# deps transitives mais inutilisées ici).
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    PORT=3001

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Patch lib : remonter les erreurs GraphQL de X sur les mutations (sinon échec opaque
# « xactions:unknown » quand X refuse silencieusement une écriture). Échoue le build si
# l'ancre a changé.
COPY patch-xactions.cjs /tmp/patch-xactions.cjs
RUN node /tmp/patch-xactions.cjs \
    && grep -q "X GraphQL error" /app/node_modules/xactions/src/scrapers/twitter/http/client.js \
    || (echo "ERREUR: patch xactions non applique" && exit 1)

COPY server.js browser-transport.js ./

# Garde de build : le transport durci doit charger (impit = module natif Rust, il
# doit avoir un binaire prébuilt pour cette plateforme) et exposer browserFetch.
RUN node -e "import('./browser-transport.js').then(m => { if (typeof m.browserFetch !== 'function') { throw new Error('browserFetch absent'); } console.log('transport OK'); }).catch(e => { console.error('ERREUR transport:', e.message); process.exit(1); })"

EXPOSE 3001
CMD ["node", "server.js"]
