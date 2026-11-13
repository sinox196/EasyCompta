import { query, withTransaction } from './db.js';
import { extractDocument, isRetryable, aiConfigured } from './ai/extract.js';
import { buildEntries } from './accounting/entries.js';
import { fromMillimes } from './accounting/money.js';
import { runLettrage, syncImmobilisations, findDuplicate } from './accounting/automation.js';

// File de traitement en arrière-plan, stockée dans PostgreSQL : chaque document
// envoyé (web ou téléphone) est pris par le worker, lu par l'IA, puis transformé
// en écritures. Plusieurs instances peuvent tourner en parallèle (SKIP LOCKED).

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 2);
const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);
// Un quota dépassé (429) est réessayé plus longtemps : le quota gratuit Gemini se
// recharge à la minute ou au jour.
const MAX_ATTEMPTS = 6;

let running = 0;
let timer = null;

async function claimNext() {
  const { rows } = await query(
    `UPDATE documents SET status = 'processing', attempts = attempts + 1, started_at = now(), error = NULL
      WHERE id = (
        SELECT id FROM documents WHERE status = 'pending' AND (retry_after IS NULL OR retry_after <= now())
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`
  );
  return rows[0] || null;
}

async function loadRules(companyId) {
  const { rows } = await query('SELECT partner_key, account, account_label FROM partner_rules WHERE company_id = $1', [companyId]);
  return new Map(rows.map((r) => [r.partner_key, { account: r.account, account_label: r.account_label }]));
}

export async function saveEntries(client, doc, entries, status) {
  await client.query('DELETE FROM entries WHERE document_id = $1', [doc.id]);
  for (const e of entries) {
    const { rows } = await client.query(
      `INSERT INTO entries (company_id, document_id, journal, entry_date, piece_ref, label, partner, partner_scope, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [doc.company_id, doc.id, e.journal, e.date, e.piece_ref, e.label, e.partner || '', e.partner_scope || '', status]
    );
    let n = 0;
    for (const l of e.lines) {
      await client.query(
        `INSERT INTO entry_lines (entry_id, line_no, account, account_label, label, third_party, debit, credit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [rows[0].id, n++, l.account, l.account_label, l.label, l.third_party, fromMillimes(l.debit), fromMillimes(l.credit)]
      );
    }
  }
}

export async function processDocument(doc) {
  const { rows: companies } = await query('SELECT * FROM companies WHERE id = $1', [doc.company_id]);
  const company = companies[0];
  const { rows: pages } = await query('SELECT mime, data FROM document_pages WHERE document_id = $1 ORDER BY page_no', [doc.id]);
  if (!company || pages.length === 0) throw new Error('Document ou société introuvable');

  const extracted = await extractDocument(company, pages, doc.type_hint);
  const rules = await loadRules(doc.company_id);
  const built = buildEntries(extracted, company, rules);
  const { entries, warnings, summary } = built;
  let { needsReview } = built;
  // Document déjà importé (même facture ou même relevé) : aucune écriture n'est
  // passée, sauf si l'utilisateur a confirmé que ce n'est pas un doublon.
  const duplicateOf = doc.allow_duplicate ? null : await findDuplicate(doc, extracted);
  if (duplicateOf) {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM entries WHERE document_id = $1', [doc.id]);
      await client.query(
        `UPDATE documents SET status = 'duplicate', duplicate_of = $2, doc_type = $3, extracted = $4, summary = $5,
                warnings = $6, processed_at = now(), error = NULL
          WHERE id = $1`,
        [doc.id, duplicateOf, extracted.doc_type, JSON.stringify(extracted), summary,
          JSON.stringify([`Ce document a déjà été importé (document n° ${duplicateOf}) : il n'a pas été comptabilisé une deuxième fois.`])]
      );
    });
    await afterChange(doc.company_id);
    return;
  }
  const docStatus = needsReview ? 'review' : 'done';
  const entryStatus = needsReview ? 'draft' : 'validated';

  await withTransaction(async (client) => {
    await saveEntries(client, doc, entries, entryStatus);
    await client.query(
      `UPDATE documents SET status = $2, doc_type = $3, extracted = $4, warnings = $5, summary = $6,
              processed_at = now(), error = NULL
        WHERE id = $1`,
      [doc.id, docStatus, extracted.doc_type, JSON.stringify(extracted), JSON.stringify(warnings), summary]
    );
  });
  await afterChange(doc.company_id);
}

// Après chaque changement d'écritures : lettrage et immobilisations automatiques.
export async function afterChange(companyId) {
  try {
    await syncImmobilisations(companyId);
    await runLettrage(companyId);
  } catch (err) {
    console.error('[auto] lettrage/immobilisations :', err.message);
  }
}

async function runOne(doc) {
  try {
    await processDocument(doc);
    console.log(`[worker] document ${doc.id} traité`);
  } catch (err) {
    const retry = isRetryable(err) && doc.attempts < MAX_ATTEMPTS;
    // Attente croissante : 1, 2, 4, 8, 16 minutes.
    const waitMin = 2 ** (doc.attempts - 1);
    console.error(`[worker] document ${doc.id} : ${err.message}${retry ? ` (nouvel essai dans ${waitMin} min)` : ''}`);
    await query(
      `UPDATE documents SET status = $2, error = $3, retry_after = CASE WHEN $2 = 'pending' THEN now() + make_interval(mins => $4::int) END
        WHERE id = $1`,
      [doc.id, retry ? 'pending' : 'error', String(err.message || err).slice(0, 500), waitMin]
    );
  }
}

async function tick() {
  if (!aiConfigured()) return;
  try {
    while (running < CONCURRENCY) {
      const doc = await claimNext();
      if (!doc) break;
      running++;
      runOne(doc).finally(() => {
        running--;
        setImmediate(tick);
      });
    }
  } catch (err) {
    console.error('[worker] erreur de file :', err.message);
  }
}

export function startWorker() {
  if (!aiConfigured()) {
    console.warn('[worker] Aucune clé d\'IA (GEMINI_API_KEY ou ANTHROPIC_API_KEY) : les documents resteront en attente.');
  }
  timer = setInterval(tick, POLL_MS);
  tick();
}

export function kickWorker() {
  setImmediate(tick);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
}
