# L'empreinte TLS se joue sous la couche des en-têtes

**Date** : 2026-07-30 · **Contexte** : compte X flaggé (erreur 226) malgré un proxy résidentiel configuré

## Ce qui a été appris

Un client HTTP peut présenter des en-têtes parfaits et rester identifiable comme non-navigateur : la poignée de main TLS et le cadrage HTTP/2 arrivent **avant** le premier en-tête. Mesuré ici :

| Transport | JA4 | Protocole |
|---|---|---|
| `fetch` de Node (undici) | `t13d5212h1_b262b3658495_8e6e362c5eac` | HTTP/1.1 |
| impit `browser:'chrome142'` | `t13d1516h2_8daaf6152771_02713d6af862` | HTTP/2 |

Aucune quantité de `sec-ch-ua` ne rapproche la première ligne de la seconde.

## Les pièges concrets rencontrés

1. **Une option de configuration acceptée n'est pas une option appliquée.** `TwitterHttpClient` stocke `options.proxy` et ne s'en sert jamais — le trafic sortait du datacenter pendant des mois avec une variable d'env qui donnait l'illusion du contraire. **Toujours vérifier l'effet, pas la configuration** : une requête vers un service d'écho d'IP tranche en dix secondes.
2. **Un user-agent explicite gagne sur l'émulation.** impit ne l'écrase pas → passer un UA maison produit « UA Chrome 120 Windows » + « sec-ch-ua v142 macOS » : pire que de ne rien faire. **Supprimer l'UA** et laisser l'outil d'émulation poser le sien.
3. **Une lib peut ignorer le transport qu'on lui injecte.** `x-client-transaction-id` appelle `globalThis.fetch` en dur à trois endroits, avec des en-têtes figés (Chrome 135 Windows, `accept-language: ja`). L'init serait partie d'une autre IP avec une autre empreinte que les requêtes qui utilisent son résultat. Contournement : substituer `globalThis.fetch` le temps de l'init, puis le restaurer.
4. **Injecter plutôt que patcher.** La lib acceptait déjà `options.fetch` — tout le durcissement tient dans un module externe, sans toucher à son code, donc sans ancre de patch à re-vérifier à chaque montée de version.
5. **Node 22 minimum** pour ce générateur (`ArrayBuffer.prototype.transfer`) : sur Node 20 l'échec est tardif et opaque (« output.buffer.transfer is not a function »). D'où une garde de build qui charge le transport au lieu de découvrir ça en prod.

## Vérification qui fait foi

Un endpoint `GET /transport` renvoie l'IP de sortie réelle, le JA4 et l'état du générateur. C'est ce qui distingue « configuré » de « effectif » — la confusion à l'origine de tout l'incident.
