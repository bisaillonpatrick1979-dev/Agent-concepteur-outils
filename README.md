# Agent concepteur d'outils

Agent expert en construction residentielle/commerciale et en conception d'outils de chantier - pour **HailHits Exteriors**, Calgary (AB).

Ce depot n'est pas un chatbot. C'est un agent bati sur quatre couches :

| Couche | Role | Etat |
|---|---|---|
| 1. Cerveau | API Anthropic (raisonnement) | Phase 1 |
| 2. Connaissance | RAG : pgvector + recherche hybride | **Phase 1** |
| 3. Outils deterministes | Calculs de charges, portees, mecanique | Phase 2 |
| 4. CAD generatif | CadQuery -> STEP/STL, boucle de validation | Phase 3 |

La regle qui gouverne tout : **le modele decide *quoi* calculer, le code calcule *combien*.** Un LLM ne produit jamais un chiffre structural de lui-meme.

---

## Phase 1 - Base de connaissances

### Ce que ca fait

- Tu verses tes documents (code du batiment, fiches Hardie/LP/Kaycan, tes methodes, tes prix, tes soumissions) dans une table vectorisee.
- La recherche est **hybride** : vectorielle (le sens) + plein texte FR/EN (les mots exacts, les numeros d'article), fusionnees par RRF. Une question floue comme « quel espacement pour les fourrures » et une recherche precise comme « 9.23.13 » fonctionnent toutes les deux.
- Chaque reponse est **citee** et **journalisee**. Si un client conteste, tu remontes a la source.

### Embeddings : gratuits

On utilise `gte-small` (384 dimensions), integre directement au runtime des Edge Functions Supabase. **Aucune cle d'API d'embedding, aucun cout.** Le seul appel payant est celui a Anthropic dans `kb-ask`.

---

## Deploiement (100 % mobile, depuis Termux)

```bash
npm i -g supabase
supabase login
supabase link --project-ref <TON_PROJECT_REF>

# 1. Schema
supabase db push

# 2. Secret pour kb-ask
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# 3. Fonctions
supabase functions deploy kb-ingest
supabase functions deploy kb-search
supabase functions deploy kb-ask
```

> Sans CLI : la migration se colle telle quelle dans le SQL Editor du tableau de bord Supabase, et les fonctions se creent via l'onglet Edge Functions.

---

## Utilisation

### Ajouter une source

```bash
curl -X POST "$SUPABASE_URL/functions/v1/kb-ingest" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "James Hardie - HardiePlank HZ5 Installation",
    "source_type": "fiche_technique",
    "publisher": "James Hardie",
    "jurisdiction": "CA",
    "discipline": ["enveloppe"],
    "authority_level": 3,
    "version": "2024",
    "text": "...contenu complet du document..."
  }'
```

### Poser une question

```bash
curl -X POST "$SUPABASE_URL/functions/v1/kb-ask" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"question": "Quel chevauchement minimum pour du HardiePlank en HZ5?", "disciplines": ["enveloppe"]}'
```

Reponse : texte cite `[S1]`, `[S2]`... + tableau `sources` avec titre, editeur, section, niveau d'autorite.

---

## Niveaux d'autorite

| Niveau | Type | Exemple |
|---|---|---|
| 1 | Code / loi | CNB 2020, Alberta Building Code |
| 2 | Norme | CSA A123, ASTM E2357 |
| 3 | Fabricant | fiches Hardie, LP SmartSide, Kaycan |
| 4 | Methode interne | ta facon de faire, tes prix |
| 5 | Note | observation de chantier |

En cas de contradiction, l'agent privilegie le niveau le plus fort et signale le conflit.

---

## Garde-fou non negociable

Tout element structural, toute charge portante et tout equipement de levage **doivent etre scelles par un ingenieur inscrit a l'APEGA** en Alberta. Cet agent est un outil de pre-conception et de verification - jamais la signature finale. Cette regle est codee dans le prompt systeme de `kb-ask` et ne doit pas en etre retiree.

---

## Prochaines etapes

**Phase 2 - Outils deterministes.** Fonctions de calcul appelees par le modele : charges de neige et de vent (Calgary), portees de solives, flexion de poutre, couple moteur, dimensionnement de vis-mere, moment d'inertie. Exposees a l'API comme `tools`.

**Phase 3 - CAD generatif.** Boucle : concept -> CadQuery parametrique -> validation par les fonctions de Phase 2 -> iteration automatique -> fichier STEP/STL. Conteneur Python sur Modal ou Fly.io (le seul morceau qui ne roule pas dans Supabase).
