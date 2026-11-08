import pg from 'pg';

// Les montants NUMERIC sont renvoyés en string par défaut : on les garde en string
// et on les convertit explicitement (millimes) dans le code métier.
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error(
    '[db] DATABASE_URL manquant. Sur Railway : ajoutez un service PostgreSQL et ' +
      'référencez ${{Postgres.DATABASE_URL}} dans les variables du service web.'
  );
}

const useSsl = process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
     id            SERIAL PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     name          TEXT NOT NULL DEFAULT '',
     password_hash TEXT NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS companies (
     id               SERIAL PRIMARY KEY,
     user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name             TEXT NOT NULL,
     matricule_fiscal TEXT NOT NULL DEFAULT '',
     activity         TEXT NOT NULL DEFAULT '',
     sales_type       TEXT NOT NULL DEFAULT 'services',
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS documents (
     id            SERIAL PRIMARY KEY,
     company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     source        TEXT NOT NULL DEFAULT 'web',
     type_hint     TEXT NOT NULL DEFAULT 'auto',
     doc_type      TEXT,
     status        TEXT NOT NULL DEFAULT 'pending',
     original_name TEXT NOT NULL DEFAULT '',
     page_count    INTEGER NOT NULL DEFAULT 0,
     attempts      INTEGER NOT NULL DEFAULT 0,
     error         TEXT,
     warnings      JSONB NOT NULL DEFAULT '[]'::jsonb,
     extracted     JSONB,
     summary       TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     started_at    TIMESTAMPTZ,
     processed_at  TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS documents_status_idx ON documents(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS documents_company_idx ON documents(company_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS document_pages (
     id          SERIAL PRIMARY KEY,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     page_no     INTEGER NOT NULL,
     mime        TEXT NOT NULL,
     data        BYTEA NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS document_pages_doc_idx ON document_pages(document_id, page_no)`,
  `CREATE TABLE IF NOT EXISTS entries (
     id          SERIAL PRIMARY KEY,
     company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
     journal     TEXT NOT NULL,
     entry_date  DATE NOT NULL,
     piece_ref   TEXT NOT NULL DEFAULT '',
     label       TEXT NOT NULL DEFAULT '',
     partner     TEXT NOT NULL DEFAULT '',
     partner_scope TEXT NOT NULL DEFAULT '',
     status      TEXT NOT NULL DEFAULT 'draft',
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS entries_company_idx ON entries(company_id, entry_date)`,
  `CREATE TABLE IF NOT EXISTS entry_lines (
     id            SERIAL PRIMARY KEY,
     entry_id      INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
     line_no       INTEGER NOT NULL DEFAULT 0,
     account       TEXT NOT NULL,
     account_label TEXT NOT NULL DEFAULT '',
     label         TEXT NOT NULL DEFAULT '',
     third_party   TEXT NOT NULL DEFAULT '',
     debit         NUMERIC(15,3) NOT NULL DEFAULT 0,
     credit        NUMERIC(15,3) NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS entry_lines_entry_idx ON entry_lines(entry_id)`,
  `CREATE TABLE IF NOT EXISTS pairing_tokens (
     token      TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     used_at    TIMESTAMPTZ
   )`,
  // Règles apprises : quand l'utilisateur corrige le compte d'un fournisseur/client,
  // on s'en souvient pour les prochains documents du même tiers.
  `CREATE TABLE IF NOT EXISTS partner_rules (
     id            SERIAL PRIMARY KEY,
     company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     partner_key   TEXT NOT NULL,
     account       TEXT NOT NULL,
     account_label TEXT NOT NULL DEFAULT '',
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (company_id, partner_key)
   )`,
];

// Colonnes ajoutées après la première version (idempotent).
MIGRATIONS.push(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ`);
// Lettrage : même code sur une facture et son règlement.
MIGRATIONS.push(`ALTER TABLE entry_lines ADD COLUMN IF NOT EXISTS lettrage TEXT`);
MIGRATIONS.push(`CREATE INDEX IF NOT EXISTS entry_lines_account_idx ON entry_lines(account)`);
// Immobilisations créées automatiquement à partir des factures d'achat.
MIGRATIONS.push(`CREATE TABLE IF NOT EXISTS immobilisations (
   id               SERIAL PRIMARY KEY,
   company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
   document_id      INTEGER REFERENCES documents(id) ON DELETE SET NULL,
   entry_line_id    INTEGER UNIQUE REFERENCES entry_lines(id) ON DELETE SET NULL,
   label            TEXT NOT NULL DEFAULT '',
   account          TEXT NOT NULL,
   acquisition_date DATE NOT NULL,
   value            NUMERIC(15,3) NOT NULL,
   rate             NUMERIC(6,3) NOT NULL,
   created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
 )`);

export async function migrate() {
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
  // Documents restés "processing" après un redémarrage : on les remet en file.
  await pool.query(
    `UPDATE documents SET status = 'pending'
      WHERE status = 'processing' AND started_at < now() - interval '10 minutes'`
  );
}
