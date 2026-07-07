# Microservice XActions (publication X + stats via API interne, sans navigateur).
FROM node:20-slim

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

COPY server.js ./

EXPOSE 3001
CMD ["node", "server.js"]
