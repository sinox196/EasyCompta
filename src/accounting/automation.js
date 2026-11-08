// Traitements automatiques lancés après chaque document lu par l'IA (et à la demande) :
// lettrage, création des immobilisations, contrôles. Accès base de données.

import { query, withTransaction } from '../db.js';
import { toMillimes, fromMillimes } from './money.js';
import { matchLines } from './lettrage.js';
import { depreciationFor, accountLabel } from './plan-comptable.js';
import { dotationForYear } from './amortissement.js';

export async function runLettrage(companyId) {
  // Codes orphelins (facture ou paiement supprimé / modifié) : on les libère.
  await query(
    `UPDATE entry_lines SET lettrage = NULL WHERE lettrage IN (
       SELECT l.lettrage FROM entry_lines l JOIN entries e ON e.id = l.entry_id
        WHERE e.company_id = $1 AND l.lettrage IS NOT NULL GROUP BY l.lettrage HAVING count(*) < 2)`,
    [companyId]
  );
  const { rows } = await query(
    `SELECT l.id, l.account, l.third_party, l.debit, l.credit, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            COALESCE((d.extracted->'invoice'->>'withholding_tax')::numeric, 0) AS withholding
       FROM entry_lines l
       JOIN entries e ON e.id = l.entry_id
       LEFT JOIN documents d ON d.id = e.document_id
      WHERE e.company_id = $1 AND l.lettrage IS NULL
        AND (l.account LIKE '401%' OR l.account LIKE '404%' OR l.account LIKE '411%')`,
    [companyId]
  );
  const matches = matchLines(
    rows.map((r) => ({ ...r, debit: toMillimes(r.debit), credit: toMillimes(r.credit), withholding: toMillimes(r.withholding) }))
  );
  for (const m of matches) {
    await query(`UPDATE entry_lines SET lettrage = $1 WHERE id = ANY($2::int[])`, [m.partial ? `${m.code}P` : m.code, m.lineIds]);
  }
  return matches.length;
}

export async function clearLettrage(companyId, code) {
  await query(
    `UPDATE entry_lines l SET lettrage = NULL FROM entries e
      WHERE e.id = l.entry_id AND e.company_id = $1 AND l.lettrage = $2`,
    [companyId, code]
  );
}

// Toute ligne au débit d'un compte d'immobilisation (classe 2, hors amortissements)
// devient une fiche d'immobilisation, avec le taux d'amortissement usuel.
export async function syncImmobilisations(companyId) {
  const { rows } = await query(
    `SELECT l.id, l.account, l.label, l.debit, e.document_id, to_char(e.entry_date, 'YYYY-MM-DD') AS date
       FROM entry_lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND l.account LIKE '2%' AND l.account NOT LIKE '28%' AND l.debit > 0
        AND NOT EXISTS (SELECT 1 FROM immobilisations i WHERE i.entry_line_id = l.id)`,
    [companyId]
  );
  for (const r of rows) {
    await query(
      `INSERT INTO immobilisations (company_id, document_id, entry_line_id, label, account, acquisition_date, value, rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (entry_line_id) DO NOTHING`,
      [companyId, r.document_id, r.id, r.label || accountLabel(r.account), r.account, r.date, r.debit, depreciationFor(r.account).rate]
    );
  }
  return rows.length;
}

export async function immobilisationsWithSchedule(companyId, year) {
  const { rows } = await query(
    `SELECT id, document_id, label, account, to_char(acquisition_date, 'YYYY-MM-DD') AS acquisition_date, value, rate
       FROM immobilisations WHERE company_id = $1 ORDER BY acquisition_date, id`,
    [companyId]
  );
  return rows.map((r) => {
    const s = dotationForYear({ value: toMillimes(r.value), rate: Number(r.rate), acquisition_date: r.acquisition_date }, year);
    return {
      ...r,
      account_label: accountLabel(r.account),
      amort_account: depreciationFor(r.account).account,
      dotation: fromMillimes(s.dotation),
      cumul_avant: fromMillimes(s.cumulBefore),
      vnc: fromMillimes(s.vnc),
    };
  });
}

// Écriture de dotations de l'année (OD au 31/12), recalculée à chaque appel.
export async function generateDotations(companyId, year) {
  const immos = await immobilisationsWithSchedule(companyId, year);
  const lines = [];
  for (const i of immos) {
    const amount = toMillimes(i.dotation);
    if (amount <= 0) continue;
    lines.push({ account: '6811', label: `Dotation ${year} - ${i.label}`, debit: amount, credit: 0 });
    lines.push({ account: i.amort_account, label: `Amortissement ${year} - ${i.label}`, debit: 0, credit: amount });
  }
  const piece = `AMORT-${year}`;
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM entries WHERE company_id = $1 AND piece_ref = $2 AND journal = 'OD'`, [companyId, piece]);
    if (!lines.length) return { lines: 0, total: '0.000' };
    const { rows } = await client.query(
      `INSERT INTO entries (company_id, journal, entry_date, piece_ref, label, status)
       VALUES ($1, 'OD', $2, $3, $4, 'validated') RETURNING id`,
      [companyId, `${year}-12-31`, piece, `Dotations aux amortissements ${year}`]
    );
    let n = 0;
    for (const l of lines) {
      await client.query(
        `INSERT INTO entry_lines (entry_id, line_no, account, account_label, label, debit, credit) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rows[0].id, n++, l.account, accountLabel(l.account), l.label, fromMillimes(l.debit), fromMillimes(l.credit)]
      );
    }
    const total = lines.reduce((s, l) => s + l.debit, 0);
    return { lines: lines.length / 2, total: fromMillimes(total) };
  });
}

// Échéancier : factures non lettrées (donc non réglées), avec leur date d'échéance.
export async function echeancier(companyId) {
  const { rows } = await query(
    `SELECT l.id, l.account, l.third_party, l.debit, l.credit, l.lettrage, e.document_id, e.piece_ref,
            to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            NULLIF(d.extracted->'invoice'->>'due_date', '') AS due_date
       FROM entry_lines l JOIN entries e ON e.id = l.entry_id
       LEFT JOIN documents d ON d.id = e.document_id
      WHERE e.company_id = $1 AND (l.lettrage IS NULL OR l.lettrage LIKE '%P')
        AND ((l.account LIKE '40%' AND l.credit > 0) OR (l.account LIKE '411%' AND l.debit > 0))
      ORDER BY e.entry_date`,
    [companyId]
  );
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => {
    let due = /^\d{4}-\d{2}-\d{2}$/.test(r.due_date || '') ? r.due_date : null;
    if (!due) {
      const d = new Date(`${r.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 30); // échéance par défaut : 30 jours
      due = d.toISOString().slice(0, 10);
    }
    const isClient = r.account.startsWith('411');
    return {
      line_id: r.id,
      type: isClient ? 'a_encaisser' : 'a_payer',
      partner: r.third_party,
      amount: isClient ? r.debit : r.credit,
      date: r.date,
      due_date: due,
      late: due < today,
      days_late: due < today ? Math.round((Date.parse(today) - Date.parse(due)) / 86400000) : 0,
      document_id: r.document_id,
      piece_ref: r.piece_ref,
      partial: Boolean(r.lettrage),
    };
  });
}

// Contrôles automatiques du dossier : chaque point renvoie un niveau, une explication
// simple et un lien vers l'écran où corriger.
export async function runControls(companyId, year) {
  const checks = [];
  const add = (level, title, detail, link) => checks.push({ level, title, detail, link });

  const { rows: dup } = await query(
    `SELECT d.extracted->'invoice'->>'number' AS number,
            CASE WHEN d.doc_type IN ('facture_vente', 'avoir_vente') THEN d.extracted->'invoice'->>'customer_name'
                 ELSE d.extracted->'invoice'->>'supplier_name' END AS partner,
            array_agg(d.id ORDER BY d.id) AS ids
       FROM documents d
      WHERE d.company_id = $1 AND d.status IN ('done', 'review') AND d.doc_type <> 'releve_bancaire'
        AND COALESCE(d.extracted->'invoice'->>'number', '') <> ''
      GROUP BY 1, 2, d.extracted->'invoice'->>'total_ttc' HAVING count(*) > 1`,
    [companyId]
  );
  for (const d of dup) {
    add('error', `Facture en double : ${d.partner} n° ${d.number}`, `Scannée ${d.ids.length} fois : supprimez le doublon pour ne pas compter la dépense deux fois.`, `#/documents/${d.ids[1]}`);
  }

  const { rows: bal } = await query(
    `SELECT l.account, sum(l.debit - l.credit) AS solde
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND date_part('year', e.entry_date) <= $2
      GROUP BY l.account`,
    [companyId, year]
  );
  const soldeOf = (pred) => bal.filter((b) => pred(b.account)).reduce((s, b) => s + Number(b.solde), 0);
  const attente = soldeOf((a) => a.startsWith('471'));
  if (Math.abs(attente) > 0.0005) {
    add('warn', 'Compte d\'attente 471 non soldé', `${fromMillimes(toMillimes(Math.abs(attente)))} DT de mouvements bancaires n'ont pas pu être classés. Ouvrez le relevé et choisissez le bon compte.`, '#/ledger/471');
  }
  const caisse = soldeOf((a) => a.startsWith('54'));
  if (caisse < -0.0005) {
    add('error', 'Caisse négative', 'La caisse ne peut pas avoir un solde négatif : une recette en espèces manque probablement.', '#/ledger/541');
  }
  const fournisseurs = soldeOf((a) => a.startsWith('401'));
  if (fournisseurs > 0.0005) {
    add('warn', 'Fournisseurs débiteurs', 'Vous avez payé plus que les factures fournisseurs enregistrées : une facture d\'achat n\'a sans doute pas été scannée.', '#/ledger/401');
  }
  const clients = soldeOf((a) => a.startsWith('411'));
  if (clients < -0.0005) {
    add('warn', 'Clients créditeurs', 'Vous avez reçu plus que les factures de vente enregistrées : une facture de vente manque sans doute.', '#/ledger/411');
  }

  const { rows: review } = await query(`SELECT count(*)::int AS n FROM documents WHERE company_id = $1 AND status IN ('review', 'error')`, [companyId]);
  if (review[0].n) add('warn', `${review[0].n} document(s) à vérifier ou en erreur`, 'Leurs écritures ne sont pas encore validées.', '#/documents');

  // Mois de l'année sans relevé bancaire alors qu'il y a des opérations.
  const { rows: months } = await query(
    `SELECT to_char(e.entry_date, 'MM') AS m, bool_or(e.journal = 'BQ') AS bank
       FROM entries e WHERE e.company_id = $1 AND date_part('year', e.entry_date) = $2 GROUP BY 1 ORDER BY 1`,
    [companyId, year]
  );
  const missing = months.filter((m) => !m.bank).map((m) => m.m);
  if (missing.length) {
    add('info', 'Relevés bancaires manquants', `Aucun relevé bancaire pour le(s) mois ${missing.join(', ')}/${year} alors que des factures existent. Scannez-les pour que les paiements soient rapprochés.`, '#/documents');
  }

  const items = await echeancier(companyId);
  const late = items.filter((i) => i.late);
  const lateClients = late.filter((i) => i.type === 'a_encaisser');
  const lateSuppliers = late.filter((i) => i.type === 'a_payer');
  if (lateClients.length) add('warn', `${lateClients.length} facture(s) client en retard de paiement`, 'Relancez ces clients.', '#/echeancier');
  if (lateSuppliers.length) add('info', `${lateSuppliers.length} facture(s) fournisseur échue(s) non réglée(s)`, 'Ou leur paiement n\'apparaît pas encore dans un relevé scanné.', '#/echeancier');

  const { rows: unbalanced } = await query(
    `SELECT e.id FROM entries e JOIN entry_lines l ON l.entry_id = e.id WHERE e.company_id = $1
      GROUP BY e.id HAVING sum(l.debit) <> sum(l.credit) LIMIT 5`,
    [companyId]
  );
  if (unbalanced.length) add('error', 'Écritures déséquilibrées', `${unbalanced.length} écriture(s) ont un débit différent du crédit.`, '#/journal');

  if (!checks.length) add('ok', 'Tout est en ordre', 'Aucune anomalie détectée.', null);
  return checks;
}

// Doublon d'une facture au moment de sa lecture.
export async function findDuplicate(doc, extracted) {
  const inv = extracted?.invoice;
  if (!inv?.number || extracted.doc_type === 'releve_bancaire') return null;
  const { rows } = await query(
    `SELECT id FROM documents
      WHERE company_id = $1 AND id <> $2 AND status IN ('done', 'review')
        AND extracted->'invoice'->>'number' = $3
        AND (extracted->'invoice'->>'total_ttc')::numeric = $4::numeric
      LIMIT 1`,
    [doc.company_id, doc.id, inv.number, Number(inv.total_ttc) || 0]
  );
  return rows[0]?.id || null;
}
