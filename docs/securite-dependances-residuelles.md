# Sécurité : dépendances résiduelles signalées par les scanners

Zéro avis corrigeable n'est pas zéro avis. Après la mise à jour du lockfile
(nodemailer, basic-ftp, @rspack/core) et le retrait de npm de l'image, il reste des
paquets que les scanners peuvent signaler. Ils arrivent tous transitivement par
`xactions`, mais le service ne les exécute pas. Le service tourne sous l'utilisateur
`node` (uid 1000) et n'écrit rien sur disque.

## Constat (image construite, `npm ls --omit=dev --all`)

| Paquet | Version(s) | Introduit par (sous `xactions@3.5.0`) |
|---|---|---|
| extract-zip | 2.0.1 | `puppeteer` → `@puppeteer/browsers` |
| deepmerge | 4.3.1 | `puppeteer-extra`, `puppeteer-extra-plugin-user-preferences` |
| glob | 7.2.3, 10.5.0 | `exceljs` (archiver, unzipper), `puppeteer-extra-plugin-user-data-dir`, `googleapis` (rimraf) |
| minimatch | 3.1.5, 5.1.9, 9.0.9 | `glob`, `readdir-glob` (exceljs/archiver) |
| uuid | 8.3.2 | `bull`, `exceljs` |
| zod | 3.25.76, 4.5.4, 4.6.7 | `@atproto/*`, `@modelcontextprotocol/sdk`, `@remotion/*`, `@x402/*`, `chromium-bidi` |

Aucune de ces dépendances n'est tirée par `express`, `impit`, `linkedom` ou
`x-client-transaction-id` : tous les chemins passent par `xactions`.

## Pourquoi ils ne s'appliquent pas ici

- **extract-zip** sert à `@puppeteer/browsers` pour décompresser les navigateurs
  téléchargés. Ce téléchargement est désactivé au build (`PUPPETEER_SKIP_DOWNLOAD=1`),
  et le service n'utilise pas Puppeteer.
- **deepmerge, glob, minimatch, uuid, zod** appartiennent à des fonctions de
  `xactions` que le service n'utilise pas : plugins Puppeteer, export Excel, files
  `bull`, SDK MCP, Remotion, x402, AT Protocol.
- `server.js` n'importe que `xactions/scrapers/twitter/http`
  (`node_modules/xactions/src/scrapers/twitter/http/`). Un grep de ce répertoire ne
  trouve aucune référence à `extract-zip`, `deepmerge`, `glob`, `minimatch`, `uuid`,
  `zod`, ni à une extraction ZIP. Ses imports se limitent à ses propres fichiers,
  `crypto`, `node:fs*`, `node:path`, `node:stream*` et un `import('playwright')`
  dynamique (dans `playwright-session.js`, absent du chemin HTTP utilisé).
- Contrôle dynamique : au démarrage de `server.js` dans l'image, avec un
  `module.registerHooks` qui enregistre chaque résolution (382 modules), aucun de ces
  paquets n'est chargé. Seul `playwright-session.js` est chargé, sans que
  `playwright` le soit.

Aucun exploit n'a été démontré contre ce service par ces paquets. Si un avis
devient corrigeable sans casser `xactions`, la mise à jour reste préférable.

## tinypool : corrigé, pas absent

`tinypool` n'apparaît pas dans `npm ls` et n'existe pas dans `node_modules/tinypool`.
Il est cependant embarqué (vendored) dans `@rspack/core@2.3.0`, sous
`node_modules/@rspack/core/compiled/tinypool`, en version **2.2.0**. C'est la version
corrigée qu'apporte l'override `@rspack/core ^2.3.0`. Le paquet est donc présent dans
l'image, en version corrigée. `@rspack/core` est tiré par `@remotion/bundler`, que le
service ne charge pas.

## Vérification

```sh
docker build -t xsvc .
# npm est retiré de l'image : on le réinjecte dans une image jetable pour npm ls
printf 'FROM xsvc\nCOPY --from=node:22-slim /usr/local/lib/node_modules/npm /opt/npm\n' \
  | docker build -t xsvc-npmls -
docker run --rm --network none xsvc-npmls node /opt/npm/bin/npm-cli.js ls --omit=dev --all \
  extract-zip deepmerge glob minimatch uuid zod tinypool @rspack/core
docker run --rm --network none xsvc sh -c \
  'grep -rnE "extract-zip|deepmerge|minimatch|\bglob\b|uuid|zod|unzip|\.zip" \
     node_modules/xactions/src/scrapers/twitter/http; \
   grep "\"version\"" node_modules/@rspack/core/compiled/tinypool/package.json'
```
