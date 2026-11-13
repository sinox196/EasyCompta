import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, loadCompany } from '../auth.js';
import { entriesWithLines } from './documents.js';
import { toMillimes, fromMillimes } from '../accounting/money.js';
import { partnerKey } from '../accounting/entries.js';
import { computeDeclaration } from '../accounting/declaration.js';
import { afterChange } from '../worker.js';
import { ACCOUNTS, JOURNALS, DOC_TYPES, EXPENSE_CATEGORIES, BANK_CATEGORIES, accountLabel } from '../accounting/plan-comptable.js';

export const entriesRouter = Router();

entriesRouter.get('/plan-comptable', (req, res) => {
  res.json({ accounts: ACCOUNTS, journals: JOURNALS, doc_types: DOC_TYPES, expense_categories: EXPENSE_CATEGORIES, bank_categories: BANK_CATEGORIES });
});

entriesRouter.use(requireAuth);

function periodFilter(req, params, alias = 'e') {
  let sql = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) {
    params.push(req.query.from);
    sql += ` AND ${alias}.entry_date >= $${params.length}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) {
    params.push(req.query.to);
    sql += ` AND ${alias}.entry_date <= $${params.length}`;
  }
  if (req.query.status === 'validated' || req.query.status === 'draft') {
    params.push(req.query.status);
    sql += ` AND ${alias}.status = $${params.length}`;
  }
  return sql;
}

entriesRouter.get('/companies/:companyId/entries', loadCompany, async (req, res) => {
  const params = [req.company.id];
  let where = 'e.company_id = $1' + periodFilter(req, params);
  if (JOURNALS[req.query.journal]) {
    params.push(req.query.journal);
    where += ` AND e.journal = $${params.length}`;
  }
  res.json({ entries: await entriesWithLines(where, params) });
});

function validateLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length < 2) return { error: 'Une écriture a au moins 2 lignes' };
  const lines = [];
  for (const l of rawLines) {
    const account = String(l.account || '').trim();
    if (!/^\d{2,10}$/.test(account)) return { error: `Compte invalide : "${account}"` };
    const debit = toMillimes(l.debit);
    const credit = toMillimes(l.credit);
    if (debit < 0 || credit < 0) return { error: 'Montants négatifs interdits' };
    if (debit === 0 && credit === 0) continue;
    lines.push({
      account,
      account_label: String(l.account_label || accountLabel(account) || '').slice(0, 200),
      label: String(l.label || '').slice(0, 250),
      third_party: String(l.third_party || '').slice(0, 200),
      debit,
      credit,
    });
  }
  const d = lines.reduce((a, l) => a + l.debit, 0);
  const c = lines.reduce((a, l) => a + l.credit, 0);
  if (d !== c) return { error: `Écriture déséquilibrée : débit ${fromMillimes(d)} ≠ crédit ${fromMillimes(c)}` };
  if (d === 0) return { error: 'Écriture vide' };
  return { lines };
}

async function writeLines(client, entryId, lines) {
  await client.query('DELETE FROM entry_lines WHERE entry_id = $1', [entryId]);
  let n = 0;
  for (const l of lines) {
    await client.query(
      `INSERT INTO entry_lines (entry_id, line_no, account, account_label, label, third_party, debit, credit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entryId, n++, l.account, l.account_label, l.label, l.third_party, fromMillimes(l.debit), fromMillimes(l.credit)]
    );
  }
}

// Compte "principal" d'une écriture, celui qu'on mémorise pour le tiers.
function mainLine(scope, lines) {
  if (scope === 'achat') return lines.find((l) => l.debit > 0 && /^[26]/.test(l.account)) || lines.find((l) => l.credit > 0 && /^[26]/.test(l.account));
  if (scope === 'vente') return lines.find((l) => l.credit > 0 && l.account.startsWith('7')) || lines.find((l) => l.debit > 0 && l.account.startsWith('7'));
  if (scope === 'banque') return lines.find((l) => l.account !== '532');
  return null;
}

async function loadEntry(req, res, next) {
  const { rows } = await query(
    `SELECT e.* FROM entries e JOIN companies c ON c.id = e.company_id WHERE e.id = $1 AND c.user_id = $2`,
    [Number(req.params.id), req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Écriture introuvable' });
  req.entry = rows[0];
  next();
}

entriesRouter.put('/entries/:id', loadEntry, async (req, res) => {
  const { lines, error } = validateLines(req.body?.lines);
  if (error) return res.status(400).json({ error });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.entry_date || '') ? req.body.entry_date : null;
  const journal = JOURNALS[req.body?.journal] ? req.body.journal : req.entry.journal;
  const status = req.body?.validate ? 'validated' : req.entry.status;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE entries SET journal = $2, entry_date = COALESCE($3::date, entry_date), label = $4, piece_ref = $5, status = $6
        WHERE id = $1`,
      [req.entry.id, journal, date, String(req.body?.label ?? req.entry.label).slice(0, 250), String(req.body?.piece_ref ?? req.entry.piece_ref).slice(0, 100), status]
    );
    // Une écriture modifiée doit être re-lettrée : on libère ses codes et ceux de ses partenaires.
    await client.query(
      `UPDATE entry_lines SET lettrage = NULL WHERE lettrage IN
         (SELECT lettrage FROM entry_lines WHERE entry_id = $1 AND lettrage IS NOT NULL)`,
      [req.entry.id]
    );
    await writeLines(client, req.entry.id, lines);

    // Apprentissage : le compte choisi par l'utilisateur pour ce tiers sera
    // réutilisé automatiquement pour ses prochains documents.
    const key = partnerKey(req.entry.partner_scope, req.entry.partner);
    const main = key ? mainLine(req.entry.partner_scope, lines) : null;
    if (main) {
      await client.query(
        `INSERT INTO partner_rules (company_id, partner_key, account, account_label) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, partner_key) DO UPDATE SET account = EXCLUDED.account, account_label = EXCLUDED.account_label, updated_at = now()`,
        [req.entry.company_id, key, main.account, main.account_label]
      );
    }

    if (req.entry.document_id) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS drafts FROM entries WHERE document_id = $1 AND status = 'draft'`,
        [req.entry.document_id]
      );
      if (rows[0].drafts === 0) {
        await client.query(`UPDATE documents SET status = 'done' WHERE id = $1 AND status = 'review'`, [req.entry.document_id]);
      }
    }
  });
  await afterChange(req.entry.company_id);
  const [entry] = await entriesWithLines('e.id = $1', [req.entry.id]);
  res.json({ entry });
});

entriesRouter.post('/companies/:companyId/entries', loadCompany, async (req, res) => {
  const { lines, error } = validateLines(req.body?.lines);
  if (error) return res.status(400).json({ error });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.entry_date || '') ? req.body.entry_date : new Date().toISOString().slice(0, 10);
  const journal = JOURNALS[req.body?.journal] ? req.body.journal : 'OD';
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO entries (company_id, journal, entry_date, piece_ref, label, status) VALUES ($1, $2, $3, $4, $5, 'validated') RETURNING id`,
      [req.company.id, journal, date, String(req.body?.piece_ref || '').slice(0, 100), String(req.body?.label || '').slice(0, 250)]
    );
    await writeLines(client, rows[0].id, lines);
    return rows[0].id;
  });
  await afterChange(req.company.id);
  const [entry] = await entriesWithLines('e.id = $1', [id]);
  res.json({ entry });
});

entriesRouter.delete('/entries/:id', loadEntry, async (req, res) => {
  await query('DELETE FROM entries WHERE id = $1', [req.entry.id]);
  await afterChange(req.entry.company_id);
  res.json({ ok: true });
});

// --- États ------------------------------------------------------------------

entriesRouter.get('/companies/:companyId/stats', loadCompany, async (req, res) => {
  const { rows: docs } = await query(
    `SELECT status, count(*)::int AS n FROM documents WHERE company_id = $1 GROUP BY status`,
    [req.company.id]
  );
  const { rows: totals } = await query(
    `SELECT
        COALESCE(sum(CASE WHEN l.account LIKE '6%' THEN l.debit - l.credit END), 0) AS charges,
        COALESCE(sum(CASE WHEN l.account LIKE '7%' THEN l.credit - l.debit END), 0) AS produits,
        COALESCE(sum(CASE WHEN l.account = '532' OR l.account LIKE '532%' THEN l.debit - l.credit END), 0) AS banque,
        count(DISTINCT e.id)::int AS entries
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND date_part('year', e.entry_date) = $2`,
    [req.company.id, Number(req.query.year) || new Date().getFullYear()]
  );
  res.json({ documents: Object.fromEntries(docs.map((d) => [d.status, d.n])), totals: totals[0] });
});

entriesRouter.get('/companies/:companyId/balance', loadCompany, async (req, res) => {
  const params = [req.company.id];
  const where = periodFilter(req, params);
  const { rows } = await query(
    `SELECT l.account, max(l.account_label) AS account_label, sum(l.debit) AS debit, sum(l.credit) AS credit
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 ${where}
      GROUP BY l.account ORDER BY l.account`,
    params
  );
  res.json({ accounts: rows });
});

entriesRouter.get('/companies/:companyId/ledger', loadCompany, async (req, res) => {
  // Sans compte : grand livre de tous les comptes.
  const account = String(req.query.account || '');
  if (account && !/^\d{1,10}$/.test(account)) return res.status(400).json({ error: 'Compte invalide' });
  const params = [req.company.id, `${account}%`];
  const where = periodFilter(req, params);
  const { rows } = await query(
    `SELECT e.id AS entry_id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.journal, e.piece_ref, e.document_id,
            l.account, l.account_label, l.label, l.third_party, l.debit, l.credit
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND l.account LIKE $2 ${where}
      ORDER BY l.account, e.entry_date, e.id, l.line_no`,
    params
  );
  res.json({ lines: rows });
});

// Synthèse TVA mensuelle (aide à la déclaration mensuelle des impôts).
entriesRouter.get('/companies/:companyId/tva', loadCompany, async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const { rows } = await query(
    `SELECT to_char(e.entry_date, 'YYYY-MM') AS month,
            COALESCE(sum(CASE WHEN l.account LIKE '4367%' THEN l.credit - l.debit END), 0) AS collectee,
            COALESCE(sum(CASE WHEN l.account LIKE '4366%' THEN l.debit - l.credit END), 0) AS deductible,
            COALESCE(sum(CASE WHEN l.account LIKE '7%' THEN l.credit - l.debit END), 0) AS chiffre_affaires
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND date_part('year', e.entry_date) = $2
      GROUP BY 1 ORDER BY 1`,
    [req.company.id, year]
  );
  res.json({ year, months: rows });
});

// Déclaration mensuelle des impôts (aide au dépôt, montants indicatifs).
entriesRouter.get('/companies/:companyId/declaration', loadCompany, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const start = `${month}-01`;
  const id = req.company.id;
  const m = (v) => toMillimes(v);

  const totals = `
    COALESCE(sum(CASE WHEN l.account LIKE '4367%' THEN l.credit - l.debit END), 0) AS collectee,
    COALESCE(sum(CASE WHEN l.account LIKE '4366%' THEN l.debit - l.credit END), 0) AS deductible`;
  const [{ rows: cur }, { rows: hist }, { rows: sales }, { rows: rsDocs }, { rows: drafts }] = await Promise.all([
    query(
      `SELECT ${totals},
              COALESCE(sum(CASE WHEN l.account LIKE '7%' THEN l.credit - l.debit END), 0) AS ca_ht,
              COALESCE(sum(CASE WHEN l.account LIKE '432%' THEN l.credit - l.debit END), 0) AS rs
         FROM entries e JOIN entry_lines l ON l.entry_id = e.id
        WHERE e.company_id = $1 AND e.entry_date >= $2::date AND e.entry_date < ($2::date + interval '1 month')`,
      [id, start]
    ),
    query(
      `SELECT to_char(e.entry_date, 'YYYY-MM') AS month, ${totals}
         FROM entries e JOIN entry_lines l ON l.entry_id = e.id
        WHERE e.company_id = $1 AND e.entry_date < $2::date GROUP BY 1`,
      [id, start]
    ),
    query(
      `SELECT d.id, d.doc_type, d.extracted->'invoice'->>'number' AS number, d.extracted->'invoice'->>'customer_name' AS customer,
              COALESCE((d.extracted->'invoice'->>'stamp_duty')::numeric, 0) AS stamp,
              COALESCE((d.extracted->'invoice'->>'fodec')::numeric, 0) AS fodec
         FROM documents d
        WHERE d.company_id = $1 AND d.doc_type IN ('facture_vente', 'avoir_vente') AND d.status IN ('done', 'review')
          AND EXISTS (SELECT 1 FROM entries e WHERE e.document_id = d.id
                       AND e.entry_date >= $2::date AND e.entry_date < ($2::date + interval '1 month'))`,
      [id, start]
    ),
    query(
      `SELECT d.id, d.extracted->'invoice'->>'supplier_name' AS supplier, d.extracted->'invoice'->>'number' AS number,
              (d.extracted->'invoice'->>'withholding_tax')::numeric AS amount
         FROM documents d
        WHERE d.company_id = $1 AND d.doc_type IN ('facture_achat', 'ticket_caisse')
          AND COALESCE((d.extracted->'invoice'->>'withholding_tax')::numeric, 0) > 0
          AND EXISTS (SELECT 1 FROM entries e WHERE e.document_id = d.id
                       AND e.entry_date >= $2::date AND e.entry_date < ($2::date + interval '1 month'))`,
      [id, start]
    ),
    query(
      `SELECT count(*)::int AS n FROM entries
        WHERE company_id = $1 AND status = 'draft' AND entry_date >= $2::date AND entry_date < ($2::date + interval '1 month')`,
      [id, start]
    ),
  ]);

  const salesTaxes = { stamp: 0, fodec: 0 };
  for (const s of sales) {
    const sign = s.doc_type === 'avoir_vente' ? -1 : 1;
    salesTaxes.stamp += sign * m(s.stamp);
    salesTaxes.fodec += sign * m(s.fodec);
  }
  const decl = computeDeclaration({
    month,
    current: { collectee: m(cur[0].collectee), deductible: m(cur[0].deductible), caHt: m(cur[0].ca_ht), rs: m(cur[0].rs) },
    history: hist.map((h) => ({ month: h.month, collectee: m(h.collectee), deductible: m(h.deductible) })),
    salesTaxes,
  });

  const dt = (v) => fromMillimes(v);
  res.json({
    ...decl,
    tva: Object.fromEntries(Object.entries(decl.tva).map(([k, v]) => [k, dt(v)])),
    chiffreAffairesHt: dt(decl.chiffreAffairesHt),
    chiffreAffairesTtc: dt(decl.chiffreAffairesTtc),
    lines: decl.lines.map((l) => ({ ...l, base: l.base === null ? null : dt(l.base), amount: dt(l.amount) })),
    total: dt(decl.total),
    company: { name: req.company.name, matricule_fiscal: req.company.matricule_fiscal },
    drafts: drafts[0].n,
    sales_documents: sales.length,
    withholding_detected: rsDocs.map((r) => ({ document_id: r.id, supplier: r.supplier, number: r.number, amount: r.amount })),
  });
});

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

entriesRouter.get('/companies/:companyId/export.csv', loadCompany, async (req, res) => {
  const params = [req.company.id];
  const where = 'e.company_id = $1' + periodFilter(req, params);
  const entries = await entriesWithLines(where, params);
  const header = ['Date', 'Journal', 'N° pièce', 'Compte', 'Intitulé compte', 'Libellé', 'Tiers', 'Débit', 'Crédit', 'Statut'];
  const out = [header.join(';')];
  for (const e of entries) {
    for (const l of e.lines) {
      out.push(
        [e.entry_date, e.journal, e.piece_ref, l.account, l.account_label, l.label || e.label, l.third_party,
          String(l.debit).replace('.', ','), String(l.credit).replace('.', ','), e.status === 'validated' ? 'Validée' : 'Brouillon']
          .map(csvCell)
          .join(';')
      );
    }
  }
  const filename = `ecritures-${req.company.name.replace(/[^a-z0-9]+/gi, '-')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + out.join('\r\n'));
});
