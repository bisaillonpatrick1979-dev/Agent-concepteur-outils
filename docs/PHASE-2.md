# Phase 2 - Outils deterministes

Deploye dans le projet Supabase `pnpdftlehrzwqltdokyo`.

## Le principe

Un LLM est excellent pour decider **quoi** calculer et mauvais pour calculer **combien**.
La Phase 2 separe les deux : le modele raisonne, le code compte.

```
question -> agent (Claude + outils)
              |-- rechercher_connaissances --> kb_hybrid_search (Phase 1)
              +-- outil de calcul ----------> /calc (mathematiques pures)
```

Aucun chiffre d'ingenierie ne sort du modele lui-meme.

## Fonctions deployees

| Fonction | JWT | Role |
|---|---|---|
| `calc` | non | Moteur de calcul pur. Aucun acces aux donnees. |
| `agent` | oui | Orchestrateur : Claude + connaissances + calculs. |

`calc` est ouvert parce qu'il ne touche a aucune donnee : il recoit des nombres, il retourne des nombres. `agent` exige un JWT parce qu'il lit la base de connaissances sous RLS.

## Les sept outils de calcul

| Outil | Entrees principales | Sortie |
|---|---|---|
| `proprietes_section` | forme + dimensions | aire, inertie, module, rayon de giration |
| `flexion_poutre` | portee, E, I, charge | moment, cisaillement, fleche, verdicts |
| `flambement_colonne` | E, I, longueur, K | charge critique d'Euler, elancement, FS |
| `charge_neige` | Ss, Sr, coefficients | charge en kPa (forme CNB) |
| `charge_vent` | q, Cp, coefficients | pression en kPa, force totale |
| `couple_vis_mere` | force axiale, pas, dm, mu | couple requis, rendement, auto-blocage |
| `couple_moteur` | inertie, acceleration | couple a l'arbre + marge 1,5 |

Formes de section : `rectangle`, `tube_rectangulaire`, `tube_rond`, `barre_ronde`, `profile_i`.

Unites partout : **mm, N, MPa, kPa, kg, Nm**.

## Decision de conception importante

Les valeurs climatiques (`Ss`, `Sr`, `q`) et les proprietes de materiaux ne sont **pas** codees en dur dans les outils. Elles sont des **entrees**, que l'agent doit aller chercher dans la base de connaissances.

Raison : une constante figee dans du code devient fausse des que le code du batiment change, et personne ne s'en apercoit. En passant par la base, la valeur est datee, citee et remplacable. Le prompt systeme interdit explicitement a l'agent de les deviner.

Consequence directe : tant que tu n'as pas verse les donnees climatiques du CNB pour Calgary, l'agent va refuser de calculer une charge de neige. C'est voulu.

## Traçabilite

Chaque appel de calcul est enregistre dans `kb_calculs` : outil, entrees, sorties, erreur, session. Tu peux reconstruire n'importe quel chiffre remis a un client.

```sql
select outil, entrees, sorties, created_at
from kb_calculs
order by created_at desc
limit 20;
```

## Utilisation

### Calcul direct, sans LLM

```bash
curl -X POST "$SUPABASE_URL/functions/v1/calc" \
  -H "Content-Type: application/json" \
  -d '{"outil":"proprietes_section","params":{"forme":"tube_rectangulaire","b_mm":50,"h_mm":100,"t_mm":3}}'
```

Liste des outils : `{"outil":"liste"}`

### L'agent complet

```bash
curl -X POST "$SUPABASE_URL/functions/v1/agent" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"question":"Ma traverse de table CNC fait 2400 mm de portee en HSS 100x50x3. Est-ce que 500 N au centre passe en fleche L/360?"}'
```

Reponse : `reponse` (texte), `trace` (chaque outil appele avec ses entrees), `sources`, `calculs_effectues`.

## Recuperer le code source dans ce depot

Le code est deploye. Pour le rapatrier localement depuis Termux :

```bash
supabase functions download calc  --project-ref pnpdftlehrzwqltdokyo
supabase functions download agent --project-ref pnpdftlehrzwqltdokyo
```

## Validation

Formules verifiees sur cas reels :

- HSS 100x50x3 : A = 864 mm2, I = 1 121 192 mm4, S = 22 424 mm3
- Portee 2400 mm, 500 N au centre : M = 0,300 kNm, fleche = 0,642 mm (limite L/360 = 6,67 mm)
- Tube rond 50x2, L = 1200 mm : Pcr = 119,3 kN, elancement 70,6
- Vis a billes 800 N / pas 5 / dm 10 / mu 0,015 : T = 0,698 Nm, rendement 0,912

Le rendement de 0,912 tombe dans la plage attendue de 0,85 a 0,95 pour une vis a billes : le modele de frottement se comporte correctement.

## Ce que la Phase 2 ne fait pas

- Pas de flambement local, pas de voilement d'ame, pas de torsion.
- Pas de combinaisons de charges du code (1,25D + 1,5L, etc.).
- Pas de connexions : boulons, soudures, ancrages.
- Pas d'analyse par elements finis.

Ce sont des cas simples et isoles. Utile pour degrossir un concept en dix minutes au lieu de deux heures, insuffisant pour signer un plan.

## Garde-fou

Tout element structural, porteur ou de levage doit etre scelle par un ingenieur inscrit a l'**APEGA** en Alberta. Chaque sortie de calcul structural porte cet avis dans son champ `avis`, et le prompt systeme de l'agent le rappelle. Ne pas le retirer.
