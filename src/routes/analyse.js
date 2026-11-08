import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, loadCompany } from '../auth.js';
import { toMillimes, fromMillimes } from '../accounting/money.js';
import { financialStatements } from '../accounting/etats.js';
import {
  runLettrage, clearLettrage, echeancier, immobilisationsWithSchedule, generateDotations, runControls, syncImmobilisations,
} from '../accounting/automation.js';
import { askAI, aiConfigured } from '../ai/extract.js';

export const analyseRouter = Router();
analyseRouter.use('/companies/:companyId', requireAuth, loadCompany);

const yearOf = (req) => Number(req.query.year || req.body?.year) || new Date().getFullYear();
const mapMoney = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'number' ? fromMillimes(v) : v]));

// --- Lettrage et échéancier ----------------------------------------------------

analyseRouter.post('/companies/:companyId/lettrage/auto', async (req, res) => {
  res.json({ matched: await runLettrage(req.company.id) });
});

analyseRouter.delete('/companies/:companyId/lettrage/:code', async (req, res) => {
  await clearLettrage(req.company.id, req.params.code);
  res.json({ ok: true });
});

analyseRouter.get('/companies/:companyId/lettrage', async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.account, l.third_party, l.label, l.debit, l.credit, l.lettrage, e.journal, e.document_id,
            to_char(e.entry_date, 'YYYY-MM-DD') AS date
       FROM entry_lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND (l.account LIKE '401%' OR l.account LIKE '404%' OR l.account LIKE '411%')
      ORDER BY l.lettrage NULLS FIRST, e.entry_date, l.id`,
    [req.company.id]
  );
  res.json({ lines: rows });
});

analyseRouter.get('/companies/:companyId/echeancier', async (req, res) => {
  res.json({ items: await echeancier(req.company.id) });
});

// --- Immobilisations -------------------------------------------------------------

analyseRouter.get('/companies/:companyId/immobilisations', async (req, res) => {
  await syncImmobilisations(req.company.id);
  res.json({ year: yearOf(req), items: await immobilisationsWithSchedule(req.company.id, yearOf(req)) });
});

analyseRouter.put('/companies/:companyId/immobilisations/:id', async (req, res) => {
  const rate = Number(req.body?.rate);
  if (!(rate > 0 && rate <= 100)) return res.status(400).json({ error: 'Taux entre 0 et 100 %' });
  const { rowCount } = await query(`UPDATE immobilisations SET rate = $3, label = COALESCE($4, label) WHERE id = $1 AND company_id = $2`, [
    Number(req.params.id), req.company.id, rate, req.body?.label ?? null,
  ]);
  if (!rowCount) return res.status(404).json({ error: 'Immobilisation introuvable' });
  res.json({ ok: true });
});

analyseRouter.post('/companies/:companyId/immobilisations/dotations', async (req, res) => {
  res.json(await generateDotations(req.company.id, yearOf(req)));
});

// --- États financiers et contrôles -----------------------------------------------

async function balanceUntil(companyId, from, to) {
  const { rows } = await query(
    `SELECT l.account, sum(l.debit) AS debit, sum(l.credit) AS credit
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND e.entry_date BETWEEN $2::date AND $3::date
      GROUP BY l.account`,
    [companyId, from, to]
  );
  return rows.map((r) => ({ account: r.account, debit: toMillimes(r.debit), credit: toMillimes(r.credit) }));
}

analyseRouter.get('/companies/:companyId/etats', async (req, res) => {
  const year = yearOf(req);
  // Bilan : tous les mouvements jusqu'au 31/12 ; résultat : l'année seule.
  const [cumul, annee] = await Promise.all([
    balanceUntil(req.company.id, '1900-01-01', `${year}-12-31`),
    balanceUntil(req.company.id, `${year}-01-01`, `${year}-12-31`),
  ]);
  const { bilan } = financialStatements(cumul);
  const { resultat } = financialStatements(annee);
  // Le résultat des années précédentes non affecté reste dans le bilan comme « report ».
  const resultatCumul = financialStatements(cumul).resultat.net;
  const report = resultatCumul - resultat.net;
  const passif = bilan.passif.map((l) => (l.label === 'Résultat de la période' ? { ...l, amount: resultat.net } : l));
  if (report) passif.splice(1, 0, { label: 'Résultats des années précédentes', amount: report });
  res.json({
    year,
    resultat: {
      lines: resultat.lines.map(mapMoney),
      exploitation: fromMillimes(resultat.exploitation),
      totalProduits: fromMillimes(resultat.totalProduits),
      totalCharges: fromMillimes(resultat.totalCharges),
      net: fromMillimes(resultat.net),
    },
    bilan: {
      actif: bilan.actif.map(mapMoney),
      passif: passif.map(mapMoney),
      totalActif: fromMillimes(bilan.totalActif),
      totalPassif: fromMillimes(passif.reduce((s, l) => s + l.amount, 0)),
    },
  });
});

analyseRouter.get('/companies/:companyId/controles', async (req, res) => {
  res.json({ checks: await runControls(req.company.id, yearOf(req)) });
});

analyseRouter.get('/companies/:companyId/evolution', async (req, res) => {
  const { rows } = await query(
    `SELECT to_char(e.entry_date, 'MM') AS month,
            COALESCE(sum(CASE WHEN l.account LIKE '7%' THEN l.credit - l.debit END), 0) AS produits,
            COALESCE(sum(CASE WHEN l.account LIKE '6%' THEN l.debit - l.credit END), 0) AS charges
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND date_part('year', e.entry_date) = $2
      GROUP BY 1 ORDER BY 1`,
    [req.company.id, yearOf(req)]
  );
  const { rows: lettrer } = await query(
    `SELECT count(*)::int AS n FROM entry_lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND l.lettrage IS NULL AND (l.account LIKE '401%' OR l.account LIKE '404%' OR l.account LIKE '411%')`,
    [req.company.id]
  );
  const { rows: lastBank } = await query(
    `SELECT max(processed_at) AS at FROM documents WHERE company_id = $1 AND doc_type = 'releve_bancaire'`,
    [req.company.id]
  );
  res.json({ months: rows, a_lettrer: lettrer[0].n, dernier_releve: lastBank[0].at });
});

// --- Assistant IA ----------------------------------------------------------------

async function assistantContext(company, year) {
  const [bal, ech, checks] = await Promise.all([
    balanceUntil(company.id, `${year}-01-01`, `${year}-12-31`),
    echeancier(company.id),
    runControls(company.id, year),
  ]);
  const { rows: partners } = await query(
    `SELECT l.third_party, l.account, sum(l.debit) AS debit, sum(l.credit) AS credit, count(*)::int AS n
       FROM entries e JOIN entry_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND date_part('year', e.entry_date) = $2 AND l.third_party <> ''
        AND (l.account LIKE '40%' OR l.account LIKE '411%' OR l.account LIKE '6%' OR l.account LIKE '7%')
      GROUP BY 1, 2 ORDER BY sum(l.debit + l.credit) DESC LIMIT 40`,
    [company.id, year]
  );
  const { rows: recent } = await query(
    `SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS date, e.journal, e.label,
            (SELECT sum(debit) FROM entry_lines WHERE entry_id = e.id) AS montant
       FROM entries e WHERE e.company_id = $1 ORDER BY e.entry_date DESC, e.id DESC LIMIT 30`,
    [company.id]
  );
  const { resultat, bilan } = financialStatements(bal);
  return {
    societe: { nom: company.name, matricule_fiscal: company.matricule_fiscal, activite: company.activity },
    exercice: year,
    date_du_jour: new Date().toISOString().slice(0, 10),
    resultat: { produits: fromMillimes(resultat.totalProduits), charges: fromMillimes(resultat.totalCharges), net: fromMillimes(resultat.net), detail: resultat.lines.map(mapMoney) },
    tresorerie: bilan.actif.find((l) => l.label.startsWith('Banques')) ? fromMillimes(bilan.actif.find((l) => l.label.startsWith('Banques')).amount) : '0.000',
    balance: bal.map((b) => ({ compte: b.account, debit: fromMillimes(b.debit), credit: fromMillimes(b.credit) })),
    tiers: partners,
    factures_non_reglees: ech.slice(0, 60),
    controles: checks,
    dernieres_ecritures: recent,
  };
}

const ASSISTANT_PROMPT = `Tu es l'assistant comptable d'EasyCompta, une application tunisienne de comptabilité automatique. Ton interlocuteur n'est pas comptable : explique simplement, sans jargon (ou en expliquant le jargon), avec des chiffres précis tirés des données.

Règles :
- Réponds dans la langue de la question (français, arabe ou dialecte tunisien en lettres latines).
- Utilise UNIQUEMENT les données JSON fournies ci-dessous. Si l'information n'y est pas, dis-le et indique quel document scanner.
- Montants en dinars tunisiens avec 3 décimales.
- Pour une question fiscale ou juridique, donne la réponse générale puis recommande de la faire confirmer par un expert-comptable.
- Réponses courtes : quelques phrases ou une petite liste.

Données comptables de la société (JSON) :
`;

analyseRouter.post('/companies/:companyId/assistant', async (req, res) => {
  if (!aiConfigured()) return res.status(503).json({ error: 'IA non configurée sur le serveur' });
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Question manquante' });
  const context = await assistantContext(req.company, yearOf(req));
  try {
    const answer = await askAI(ASSISTANT_PROMPT + JSON.stringify(context), messages);
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: err.message || 'L\'assistant ne répond pas, réessayez.' });
  }
});
