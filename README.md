# EasyCompta — saisie comptable automatique par IA (Tunisie)

On scanne une facture, un ticket ou un relevé bancaire avec le téléphone. L'IA lit le document en arrière-plan, puis EasyCompta passe les écritures selon le plan comptable tunisien. Personne n'a besoin de faire la saisie à la main.

## Fonctionnalités

- **Application de scan sur téléphone** (`/scan`, une PWA qu'on installe sur l'écran d'accueil) : photo de chaque page, un document peut avoir plusieurs pages, import depuis la galerie ou en PDF. Les photos sont compressées avant l'envoi.
- **Liaison téléphone ↔ site par QR code** : on scanne le code affiché sur le site et le téléphone se connecte au même compte et à la même société, sans mot de passe.
- **Traitement en arrière-plan** : une file de documents stockée dans PostgreSQL. En cas d'erreur réseau ou d'API, le document est réessayé automatiquement.
- **Lecture par l'IA (Google Gemini, gratuit, ou Claude)** : le type de document est détecté (facture d'achat ou de vente, avoir, ticket de caisse, relevé bancaire). L'IA extrait le fournisseur ou le client, le matricule fiscal, la date, le HT et la TVA par taux (19 / 13 / 7 %), le FODEC, le droit de timbre, le TTC et la retenue à la source, ou chaque ligne du relevé.
- **Écritures automatiques et toujours équilibrées** (en millimes, montants à 3 décimales) :
  - Achat : 6xx (ou 2xx pour une immobilisation) + 4366 TVA déductible + 66 timbre / 401 (ou 404 pour un fournisseur d'immobilisations, 541 si payé en espèces)
  - Vente : 411 / 706-707-701 + 4367 TVA collectée + 4368 timbre et FODEC
  - Relevé : une écriture par mouvement, 532 ↔ 401, 411, 627, 651, 421, 453, 436, 161, 541, 581 ou 471
  - Avoirs : écriture inversée
- **Contrôles automatiques** : la cohérence HT + TVA + taxes = TTC, le rapprochement du solde initial, des mouvements et du solde final du relevé, la confiance de l'IA, la lisibilité, les factures en devise. Si un point est douteux, le document passe en **À vérifier** avec une explication. Sinon il est **Comptabilisé** directement.
- **Apprentissage** : quand on corrige le compte d'un fournisseur, d'un client ou d'un libellé bancaire, EasyCompta le retient pour les prochains documents de ce tiers.
- **États** : journal, balance, grand livre, synthèse de TVA mensuelle, export CSV (s'ouvre dans Excel).
- **Multi-sociétés** : un cabinet peut gérer plusieurs dossiers.
- Une page **« Comment ça marche ? »** explique la comptabilité aux non-comptables.

## Architecture

```
Téléphone (PWA /scan) ─┐
                       ├─► Express (Node 20+) ─► PostgreSQL (documents, pages, écritures, file d'attente)
Navigateur (site web) ─┘           │
                                   └─► worker en arrière-plan ─► API Claude (lecture du document)
                                                               └─► src/accounting/entries.js (écritures)
```

- `src/ai/extract.js` : consigne et schéma JSON communs, appel à Claude (structured outputs).
- `src/ai/gemini.js` : appel à Gemini avec le même schéma (`responseJsonSchema`).
- `src/accounting/plan-comptable.js` : les comptes utilisés. **C'est le seul fichier à adapter** si votre expert-comptable veut d'autres numéros de comptes.
- `src/accounting/entries.js` : la logique comptable, déterministe et testée (`npm test`). L'IA lit le document mais ne choisit jamais elle-même le débit et le crédit.
- `src/worker.js` : la file de traitement.
- `public/` : le site (`index.html`, `app.js`) et l'application de scan (`scan.html`, `scan.js`, `manifest.webmanifest`, `sw.js`). Il n'y a pas d'étape de build.

## Déploiement sur Railway

1. Dans le projet Railway relié à ce dépôt GitHub : **+ New → Database → PostgreSQL**.
2. Dans le service web, onglet **Variables** :
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `AI_PROVIDER` = `gemini` et `GEMINI_API_KEY` = clé gratuite créée sur https://aistudio.google.com/apikey
     (ou `AI_PROVIDER` = `claude` et `ANTHROPIC_API_KEY` = clé payante créée sur https://console.anthropic.com)
   - `JWT_SECRET` = une longue chaîne aléatoire (par exemple `openssl rand -hex 32`)
3. Onglet **Settings → Networking → Generate Domain** pour obtenir l'adresse publique en HTTPS. Le HTTPS est nécessaire pour la caméra et l'installation de la PWA.
4. Vérifiez que la branche déployée (Settings → Source) est bien celle qui contient ce code.

Les tables sont créées automatiquement au démarrage. Railway vérifie que l'application répond grâce au healthcheck `/api/health`.

Variables optionnelles : `GEMINI_MODEL` (par défaut `gemini-flash-lite-latest`, le quota gratuit le plus large), `AI_MODEL` (Claude, par défaut `claude-opus-5-5`), `AI_EFFORT` (`medium`), `AI_MIN_CONFIDENCE` (0.75), `WORKER_CONCURRENCY` (2), `PUBLIC_URL`, `PGSSL=true` (si la base exige SSL), `AI_FALLBACKS=off`, `AI_MOCK=1` (mode démo sans IA).

## En local

```bash
npm install
cp .env.example .env   # puis remplissez les variables
export $(cat .env | xargs) && npm run dev
```

Ouvrez http://localhost:3000, créez un compte, puis allez dans **Connecter mon téléphone**. Pour tester sans clé API, lancez avec `AI_MOCK=1` : l'IA renvoie alors des données factices.

## Limites connues

- **Gemini gratuit** : le quota (requêtes par minute et par jour) est limité et Google peut le changer. Quand il est dépassé, les documents attendent puis sont réessayés automatiquement (1, 2, 4, 8, 16 min). Surtout, **sur le niveau gratuit Google peut utiliser les documents envoyés pour améliorer ses produits** : factures et relevés contiennent des données de vos clients et fournisseurs. Pour de vraies données, activez la facturation Google (niveau payant) ou utilisez Claude.

- Les comptes choisis suivent la nomenclature du Système Comptable des Entreprises. Faites-les valider par un expert-comptable avant un usage en production.
- La retenue à la source est détectée et signalée, mais elle n'est pas encore comptabilisée automatiquement au moment du paiement.
- Les factures en devise sont marquées « À vérifier » : la conversion en dinars se fait à la main.
- Les fichiers sont stockés dans PostgreSQL. C'est simple et persistant sur Railway, mais pour de gros volumes il vaudra mieux passer à un stockage objet (S3, R2).
