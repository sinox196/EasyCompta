// Plan comptable des sociétés (base de données) : initialisation avec le plan
// tunisien, comptes auxiliaires de tiers créés automatiquement, import Excel/CSV.

import ExcelJS from 'exceljs';
import { query, withTransaction } from '../db.js';
import { DEFAULT_PLAN, LEGACY_ROOTS } from './plan-comptable.js';
import { resolveAccount, findAuxiliary, nextAuxiliaryCode, isAuxiliary, AUX_BASE, normalizeName } from './plan-resolve.js';

export const PLAN_VERSION = 1;

export async function loadPlan(companyId) {
  const { rows } = await query('SELECT code, label, nature, sens, auxiliary FROM accounts WHERE company_id = $1', [companyId]);
  return new Map(rows.map((r) => [r.code, r]));
}

async function insertAccounts(client, companyId, accounts) {
  // Insertion par lots (plus rapide qu'une requête par compte).
  for (let i = 0; i < accounts.length; i += 200) {
    const chunk = accounts.slice(i, i + 200);
    const values = [];
    const params = [companyId];
    chunk.forEach((a, j) => {
      const b = j * 5;
      values.push(`($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
      params.push(a.code, a.label, a.nature === 'R' ? 'R' : 'C', a.sens || '', Boolean(a.auxiliary));
    });
    await client.query(
      `INSERT INTO accounts (company_id, code, label, nature, sens, auxiliary) VALUES ${values.join(',')}
       ON CONFLICT (company_id, code) DO UPDATE SET label = EXCLUDED.label, nature = EXCLUDED.nature, sens = EXCLUDED.sens,
         auxiliary = EXCLUDED.auxiliary`,
      params
    );
  }
}

// Plan par défaut pour une société qui n'en a pas, puis conversion de ses écritures
// éventuelles (première version d'EasyCompta) vers les comptes du plan.
export async function ensurePlan(companyId) {
  const { rows } = await query('SELECT plan_version FROM companies WHERE id = $1', [companyId]);
  if (!rows[0] || rows[0].plan_version >= PLAN_VERSION) return;
  await withTransaction(async (client) => {
    const { rows: existing } = await client.query('SELECT count(*)::int AS n FROM accounts WHERE company_id = $1', [companyId]);
    if (!existing[0].n) await insertAccounts(client, companyId, DEFAULT_PLAN);
    await client.query('UPDATE companies SET plan_version = $2 WHERE id = $1', [companyId, PLAN_VERSION]);
  });
  await convertLegacyEntries(companyId);
}

export async function ensureAllPlans() {
  const { rows } = await query('SELECT id FROM companies WHERE plan_version < $1', [PLAN_VERSION]);
  for (const r of rows) await ensurePlan(r.id);
}

async function createAuxiliary(companyId, plan, root, name) {
  const code = nextAuxiliaryCode(plan, root);
  const label = String(name).trim().toUpperCase().slice(0, 120);
  await query(
    `INSERT INTO accounts (company_id, code, label, nature, sens, auxiliary) VALUES ($1, $2, $3, 'C', 'DC', true)
     ON CONFLICT (company_id, code) DO NOTHING`,
    [companyId, code, label]
  );
  const acc = { code, label, nature: 'C', sens: 'DC', auxiliary: true };
  plan.set(code, acc);
  return acc;
}

/**
 * Compte réel pour une ligne : racine -> compte du plan ; fournisseurs et clients
 * -> compte auxiliaire du tiers (créé s'il n'existe pas encore).
 * @param {{createAuxiliaries?: boolean}} opts  false pour les relevés bancaires : on
 *   ne crée pas de tiers à partir d'un simple libellé de virement.
 */
export async function accountFor(companyId, plan, root, thirdParty, { createAuxiliaries = true } = {}) {
  if (AUX_BASE[root] && thirdParty) {
    const found = findAuxiliary(plan, root, thirdParty);
    if (found) return found;
    if (createAuxiliaries) return createAuxiliary(companyId, plan, root, thirdParty);
  }
  const code = resolveAccount(plan, root);
  if (!plan.has(code)) {
    // Racine absente du plan de la société : on crée le compte de détail.
    const parent = [...plan.values()].filter((a) => code.startsWith(a.code)).sort((a, b) => b.code.length - a.code.length)[0];
    const label = parent?.label || '';
    await query('INSERT INTO accounts (company_id, code, label) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [companyId, code, label]);
    plan.set(code, { code, label, nature: 'C', sens: '', auxiliary: false });
  }
  return plan.get(code);
}

// Traduit les écritures produites par entries.js en comptes du plan de la société.
export async function mapEntriesToPlan(companyId, entries, opts = {}) {
  const plan = await loadPlan(companyId);
  for (const e of entries) {
    for (const l of e.lines) {
      const acc = await accountFor(companyId, plan, l.account, l.third_party, opts);
      l.account = acc.code;
      l.account_label = acc.label || l.account_label;
    }
  }
  return entries;
}

async function convertLegacyEntries(companyId) {
  const plan = await loadPlan(companyId);
  const { rows } = await query(
    `SELECT l.id, l.account, l.third_party, e.journal FROM entry_lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND length(l.account) < 8`,
    [companyId]
  );
  for (const r of rows) {
    const root = LEGACY_ROOTS[r.account] || r.account;
    const acc = await accountFor(companyId, plan, root, r.third_party, { createAuxiliaries: r.journal !== 'BQ' });
    await query('UPDATE entry_lines SET account = $2, account_label = $3 WHERE id = $1', [r.id, acc.code, acc.label]);
  }
  // Règles apprises et immobilisations enregistrées avec d'anciennes racines.
  const { rows: rules } = await query('SELECT id, account FROM partner_rules WHERE company_id = $1 AND length(account) < 8', [companyId]);
  for (const r of rules) {
    const acc = await accountFor(companyId, plan, LEGACY_ROOTS[r.account] || r.account, '');
    await query('UPDATE partner_rules SET account = $2, account_label = $3 WHERE id = $1', [r.id, acc.code, acc.label]);
  }
  await query(
    `UPDATE immobilisations i SET account = l.account FROM entry_lines l
      WHERE i.company_id = $1 AND i.entry_line_id = l.id AND length(i.account) < 8`,
    [companyId]
  );
}

// --- Import d'un plan comptable (Excel ou CSV) ---------------------------------------

const HEADERS = {
  code: /^(code|compte|n[°o]?\s*(de\s*)?compte|numero|account)$/i,
  label: /^(libelle|intitule|designation|label|nom)$/i,
  nature: /^(nature|type)$/i,
  sens: /^(sens)$/i,
};
const plain = (t) => String(t ?? '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '');

function normalizeRow(raw) {
  const code = String(raw.code ?? '').replace(/\s/g, '').replace(/\.0+$/, '');
  if (!/^\d{1,10}$/.test(code)) return null;
  const label = String(raw.label ?? '').replace(/''/g, '\'').replace(/\s+/g, ' ').trim();
  const nat = String(raw.nature ?? '').trim().toUpperCase();
  return {
    code,
    label,
    nature: nat.startsWith('R') || (!nat && code.length < 8) ? 'R' : 'C',
    sens: String(raw.sens ?? '').trim().toUpperCase().slice(0, 2),
    auxiliary: isAuxiliary(code),
  };
}

export function rowsFromMatrix(matrix) {
  const out = [];
  let cols = null;
  for (const cells of matrix) {
    const texts = cells.map((c) => String(c ?? '').trim());
    if (!cols) {
      const found = {};
      texts.forEach((t, i) => {
        for (const [k, re] of Object.entries(HEADERS)) if (found[k] === undefined && re.test(plain(t))) found[k] = i;
      });
      if (found.code !== undefined && found.label !== undefined) {
        cols = found;
        continue;
      }
      if (/^\d{1,10}$/.test(texts[0]) && texts[1]) cols = { code: 0, label: 1, nature: 2, sens: 3 }; // fichier sans en-tête
      else continue;
    }
    const pick = (k) => (cols[k] !== undefined ? texts[cols[k]] : '');
    const r = normalizeRow({ code: pick('code'), label: pick('label'), nature: pick('nature'), sens: pick('sens') });
    if (r) out.push(r);
  }
  return out;
}

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return v.text ?? v.result ?? (v.richText ? v.richText.map((t) => t.text).join('') : '');
  return v;
};

export async function parsePlanFile(buffer, filename) {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // un .xlsx est une archive zip
  if (!isZip) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const first = text.split('\n')[0];
    const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
    const matrix = text.split(/\r?\n/).filter((l) => l.trim()).map((line) => line.split(sep).map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"')));
    return rowsFromMatrix(matrix);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const all = [];
  wb.eachSheet((ws) => {
    const matrix = [];
    ws.eachRow({ includeEmpty: false }, (row) => matrix.push(row.values.slice(1).map(cellText)));
    all.push(...rowsFromMatrix(matrix));
  });
  return all;
}

// Un compte déjà utilisé dans des écritures garde son intitulé : on ne renomme pas
// un tiers existant (« 40110001 TUNISIE TELECOM ») avec le contenu d'un autre fichier.
export async function importPlan(companyId, accounts) {
  const unique = [...new Map(accounts.map((a) => [a.code, a])).values()];
  const { rows: used } = await query(
    `SELECT a.code, a.label FROM accounts a WHERE a.company_id = $1 AND EXISTS (
       SELECT 1 FROM entry_lines l JOIN entries e ON e.id = l.entry_id WHERE e.company_id = a.company_id AND l.account = a.code)`,
    [companyId]
  );
  const usedLabels = new Map(used.map((u) => [u.code, u.label]));
  const conflicts = [];
  const toWrite = unique.filter((a) => {
    const current = usedLabels.get(a.code);
    if (current === undefined || normalizeName(current) === normalizeName(a.label)) return true;
    conflicts.push({ code: a.code, current, imported: a.label });
    return false;
  });
  await withTransaction((client) => insertAccounts(client, companyId, toWrite));
  return { imported: toWrite.length, conflicts };
}
