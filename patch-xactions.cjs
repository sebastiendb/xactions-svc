// Patch de la lib xactions installée dans node_modules : fait remonter les erreurs
// GraphQL de X sur les MUTATIONS (écritures).
//
// PROBLÈME : X répond souvent HTTP 200 + { errors:[...] } quand il REFUSE une écriture
// (tweet doublon, compte restreint, « automated behavior », feature manquante). La
// méthode graphql() de la lib fait `return this.request(...)` sans regarder json.errors
// → tweet_results vide → id null → l'app voit un échec opaque « xactions:unknown » sans
// jamais connaître le motif réel de X.
//
// FIX : sur la branche mutation, si json.errors est non vide, on throw TwitterApiError
// avec le message de X → le svc renvoie ok:false + le vrai motif. On NE TOUCHE PAS les
// lectures (timelines) qui peuvent contenir des errors partiels légitimes.
//
// Échoue le build si l'ancre a changé (au lieu de déployer un patch silencieusement inerte).

const fs = require('fs');
const FILE = '/app/node_modules/xactions/src/scrapers/twitter/http/client.js';

let s = fs.readFileSync(FILE, 'utf8');

const anchor =
`      return this.request(url, {
        method: 'POST',
        body: { variables, features, queryId },
      });`;

const replacement =
`      const __mutJson = await this.request(url, {
        method: 'POST',
        body: { variables, features, queryId },
      });
      // X renvoie souvent HTTP 200 + { errors:[...] } quand il REFUSE l'écriture
      // (doublon, compte restreint, « automated behavior »…). Sans ce check l'erreur
      // est avalée → tweet_results vide → id null → échec opaque côté app.
      if (__mutJson && Array.isArray(__mutJson.errors) && __mutJson.errors.length) {
        const __msg = __mutJson.errors
          .map(function (e) { return (e && (e.message || e.code)) || 'unknown'; })
          .join(' | ');
        throw new TwitterApiError('X GraphQL error: ' + __msg, { endpoint: url, data: __mutJson });
      }
      return __mutJson;`;

const idx = s.indexOf(anchor);
if (idx === -1) {
  console.error('PATCH XACTIONS: ancre introuvable (la branche mutation de graphql() a change) — build interrompu');
  process.exit(1);
}
if (s.indexOf(anchor, idx + anchor.length) !== -1) {
  console.error('PATCH XACTIONS: ancre non unique — build interrompu');
  process.exit(1);
}

s = s.slice(0, idx) + replacement + s.slice(idx + anchor.length);
fs.writeFileSync(FILE, s);
console.log('PATCH XACTIONS: applique (remontee des erreurs GraphQL X sur les mutations)');
