import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { requireAuth, loadCompany } from '../auth.js';
import { ensurePlan, loadPlan, parsePlanFile, importPlan } from '../accounting/plan.js';
import { isAuxiliary, nextAuxiliaryCode, AUX_BASE } from '../accounting/plan-resolve.js';

export const accountsRouter = Router();
accountsRouter.use('/companies/:companyId', requireAuth, loadCompany);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

// Plan comptable de la société (avec le nombre de lignes d'écritures par compte).
accountsRouter.get('/companies/:companyId/accounts', async (req, res) => {
  await ensurePlan(req.company.id);
  const { rows } = await query(
    `SELECT a.code, a.label, a.nature, a.sens, a.auxiliary,
            (SELECT count(*)::int FROM entry_lines l JOIN entries e ON e.id = l.entry_id
              WHERE e.company_id = a.company_id AND l.account = a.code) AS used
       FROM accounts a WHERE a.company_id = $1 ORDER BY a.code`,
    [req.company.id]
  );
  res.json({ accounts: rows });
});

function validAccount(body) {
  const code = String(body?.code || '').trim();
  const label = String(body?.label || '').replace(/\s+/g, ' ').trim();
  if (!/^\d{1,10}$/.test(code)) return { error: 'Le numéro de compte ne contient que des chiffres (8 en général)' };
  if (!label) return { error: 'Intitulé obligatoire' };
  return { code, label: label.slice(0, 200), nature: body?.nature === 'R' ? 'R' : 'C', sens: String(body?.sens || '').toUpperCase().slice(0, 2) };
}

accountsRouter.post('/companies/:companyId/accounts', async (req, res) => {
  const a = validAccount(req.body);
  if (a.error) return res.status(400).json(a);
  const { rowCount } = await query(
    `INSERT INTO accounts (company_id, code, label, nature, sens, auxiliary) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [req.company.id, a.code, a.label, a.nature, a.sens, isAuxiliary(a.code)]
  );
  if (!rowCount) return res.status(409).json({ error: `Le compte ${a.code} existe déjà` });
  res.json({ account: a });
});

// Numéro proposé pour un nouveau fournisseur (401) ou client (411).
accountsRouter.get('/companies/:companyId/accounts/next/:root', async (req, res) => {
  if (!AUX_BASE[req.params.root]) return res.status(400).json({ error: 'Racine inconnue' });
  res.json({ code: nextAuxiliaryCode(await loadPlan(req.company.id), req.params.root) });
});

accountsRouter.put('/companies/:companyId/accounts/:code', async (req, res) => {
  const label = String(req.body?.label || '').replace(/\s+/g, ' ').trim();
  if (!label) return res.status(400).json({ error: 'Intitulé obligatoire' });
  const { rowCount } = await query('UPDATE accounts SET label = $3 WHERE company_id = $1 AND code = $2', [req.company.id, req.params.code, label.slice(0, 200)]);
  if (!rowCount) return res.status(404).json({ error: 'Compte introuvable' });
  // Les écritures gardent l'intitulé à jour.
  await query(
    `UPDATE entry_lines l SET account_label = $3 FROM entries e
      WHERE e.id = l.entry_id AND e.company_id = $1 AND l.account = $2`,
    [req.company.id, req.params.code, label.slice(0, 200)]
  );
  res.json({ ok: true });
});

accountsRouter.delete('/companies/:companyId/accounts/:code', async (req, res) => {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM entry_lines l JOIN entries e ON e.id = l.entry_id WHERE e.company_id = $1 AND l.account = $2`,
    [req.company.id, req.params.code]
  );
  if (rows[0].n) return res.status(409).json({ error: `Compte utilisé dans ${rows[0].n} ligne(s) d'écriture : impossible de le supprimer` });
  await query('DELETE FROM accounts WHERE company_id = $1 AND code = $2', [req.company.id, req.params.code]);
  res.json({ ok: true });
});

// Import d'un plan comptable Excel (.xlsx) ou CSV : colonnes Code, Libellé, Nature, Sens.
// Les comptes existants sont mis à jour, les nouveaux ajoutés, aucun n'est supprimé.
accountsRouter.post('/companies/:companyId/accounts/import', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
      let rows;
      try {
        rows = await parsePlanFile(req.file.buffer, req.file.originalname);
      } catch {
        return res.status(400).json({ error: 'Fichier illisible : envoyez un fichier Excel (.xlsx) ou CSV.' });
      }
      if (!rows.length) return res.status(400).json({ error: 'Aucun compte trouvé : il faut au moins les colonnes « Code » et « Libellé ».' });
      await ensurePlan(req.company.id);
      const { imported, conflicts } = await importPlan(req.company.id, rows);
      res.json({ imported, auxiliaries: rows.filter((r) => r.auxiliary).length, conflicts });
    } catch (e) {
      next(e);
    }
  });
});

// Tiers déjà rencontrés (suggestions de recherche).
accountsRouter.get('/companies/:companyId/tiers', async (req, res) => {
  const { rows } = await query(
    `SELECT l.third_party AS name, count(*)::int AS n FROM entry_lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND l.third_party <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 500`,
    [req.company.id]
  );
  res.json({ tiers: rows.map((r) => r.name) });
});
