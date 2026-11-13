import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { requireAuth, loadCompany } from '../auth.js';
import { kickWorker, afterChange } from '../worker.js';
import { ensurePlan } from '../accounting/plan.js';
import { aiConfigured } from '../ai/extract.js';

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Format non supporté (${file.mimetype}). Utilisez JPG, PNG, WEBP ou PDF.`));
  },
});

// --- Sociétés (dossiers) ----------------------------------------------------

documentsRouter.get('/companies', async (req, res) => {
  const { rows } = await query(
    `SELECT c.*,
            (SELECT count(*) FROM documents d WHERE d.company_id = c.id)::int AS documents,
            (SELECT count(*) FROM documents d WHERE d.company_id = c.id AND d.status = 'review')::int AS to_review
       FROM companies c WHERE c.user_id = $1 ORDER BY c.name`,
    [req.user.id]
  );
  res.json({ companies: rows });
});

function companyFields(body) {
  const sales = ['services', 'marchandises', 'produits'];
  return {
    name: String(body?.name || '').trim(),
    matricule_fiscal: String(body?.matricule_fiscal || '').trim(),
    activity: String(body?.activity || '').trim(),
    sales_type: sales.includes(body?.sales_type) ? body.sales_type : 'services',
  };
}

documentsRouter.post('/companies', async (req, res) => {
  const f = companyFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Nom de la société obligatoire' });
  const { rows } = await query(
    `INSERT INTO companies (user_id, name, matricule_fiscal, activity, sales_type) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.id, f.name, f.matricule_fiscal, f.activity, f.sales_type]
  );
  await ensurePlan(rows[0].id);
  res.json({ company: rows[0] });
});

documentsRouter.put('/companies/:companyId', loadCompany, async (req, res) => {
  const f = companyFields({ ...req.company, ...req.body });
  if (!f.name) return res.status(400).json({ error: 'Nom de la société obligatoire' });
  const { rows } = await query(
    `UPDATE companies SET name = $2, matricule_fiscal = $3, activity = $4, sales_type = $5 WHERE id = $1 RETURNING *`,
    [req.company.id, f.name, f.matricule_fiscal, f.activity, f.sales_type]
  );
  res.json({ company: rows[0] });
});

documentsRouter.delete('/companies/:companyId', loadCompany, async (req, res) => {
  await query('DELETE FROM companies WHERE id = $1', [req.company.id]);
  res.json({ ok: true });
});

// --- Documents ----------------------------------------------------------------

documentsRouter.post('/companies/:companyId/documents', loadCompany, (req, res, next) => {
  upload.array('files', 30)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' });
      const typeHint = ['facture_achat', 'facture_vente', 'releve_bancaire'].includes(req.body.type_hint)
        ? req.body.type_hint
        : 'auto';
      const source = req.body.source === 'mobile' ? 'mobile' : 'web';
      // "single" : toutes les photos sont les pages d'un même document (scan mobile).
      // "separate" : chaque fichier est un document différent (glisser-déposer web).
      const groups = req.body.mode === 'single' ? [files] : files.map((f) => [f]);

      // Un fichier identique (même empreinte) déjà importé dans cette société n'est
      // pas importé une deuxième fois.
      const hashOf = (group) => {
        const h = crypto.createHash('sha256');
        for (const f of group) h.update(f.buffer);
        return h.digest('hex');
      };
      const duplicates = [];
      const ids = await withTransaction(async (client) => {
        const created = [];
        const seen = new Set();
        for (const group of groups) {
          const name = group.length > 1 ? `${group[0].originalname} (+${group.length - 1} pages)` : group[0].originalname;
          const hash = hashOf(group);
          const { rows: existing } = await client.query(
            `SELECT id FROM documents WHERE company_id = $1 AND file_hash = $2 ORDER BY id LIMIT 1`,
            [req.company.id, hash]
          );
          if (existing[0] || seen.has(hash)) {
            duplicates.push({ name, existing_id: existing[0]?.id || null });
            continue;
          }
          seen.add(hash);
          const { rows } = await client.query(
            `INSERT INTO documents (company_id, user_id, source, type_hint, original_name, page_count, file_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [req.company.id, req.user.id, source, typeHint, name.slice(0, 200), group.length, hash]
          );
          let pageNo = 1;
          for (const f of group) {
            await client.query('INSERT INTO document_pages (document_id, page_no, mime, data) VALUES ($1, $2, $3, $4)', [
              rows[0].id,
              pageNo++,
              f.mimetype,
              f.buffer,
            ]);
          }
          created.push(rows[0].id);
        }
        return created;
      });
      kickWorker();
      res.json({ ids, duplicates, ai_ready: aiConfigured() });
    } catch (e) {
      next(e);
    }
  });
});

documentsRouter.get('/companies/:companyId/documents', loadCompany, async (req, res) => {
  const params = [req.company.id];
  let where = 'company_id = $1';
  if (req.query.status) {
    params.push(String(req.query.status));
    where += ` AND status = $${params.length}`;
  }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await query(
    `SELECT id, source, type_hint, doc_type, status, original_name, page_count, error, warnings, summary,
            created_at, processed_at
       FROM documents WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params
  );
  res.json({ documents: rows, ai_ready: aiConfigured() });
});

// Relance d'un coup tous les documents en erreur d'une société.
documentsRouter.post('/companies/:companyId/documents/retry-errors', loadCompany, async (req, res) => {
  const { rowCount } = await query(
    `UPDATE documents SET status = 'pending', attempts = 0, error = NULL, retry_after = NULL
      WHERE company_id = $1 AND status = 'error'`,
    [req.company.id]
  );
  kickWorker();
  res.json({ count: rowCount });
});

async function loadDocument(req, res, next) {
  const { rows } = await query(
    `SELECT d.* FROM documents d JOIN companies c ON c.id = d.company_id
      WHERE d.id = $1 AND c.user_id = $2`,
    [Number(req.params.id), req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Document introuvable' });
  req.doc = rows[0];
  next();
}

export async function entriesWithLines(whereSql, params) {
  const { rows: entries } = await query(
    `SELECT e.*, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date FROM entries e WHERE ${whereSql}
      ORDER BY e.entry_date, e.id`,
    params
  );
  if (!entries.length) return [];
  const { rows: lines } = await query(
    `SELECT * FROM entry_lines WHERE entry_id = ANY($1::int[]) ORDER BY entry_id, line_no, id`,
    [entries.map((e) => e.id)]
  );
  const byEntry = new Map(entries.map((e) => [e.id, { ...e, lines: [] }]));
  for (const l of lines) byEntry.get(l.entry_id).lines.push(l);
  return [...byEntry.values()];
}

documentsRouter.get('/documents/:id', loadDocument, async (req, res) => {
  const { rows: pages } = await query('SELECT page_no, mime FROM document_pages WHERE document_id = $1 ORDER BY page_no', [
    req.doc.id,
  ]);
  const entries = await entriesWithLines('e.document_id = $1', [req.doc.id]);
  res.json({ document: req.doc, pages, entries });
});

documentsRouter.get('/documents/:id/pages/:page', loadDocument, async (req, res) => {
  const { rows } = await query('SELECT mime, data FROM document_pages WHERE document_id = $1 AND page_no = $2', [
    req.doc.id,
    Number(req.params.page),
  ]);
  if (!rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(rows[0].data);
});

documentsRouter.post('/documents/:id/reprocess', loadDocument, async (req, res) => {
  const hint = ['facture_achat', 'facture_vente', 'releve_bancaire', 'auto'].includes(req.body?.type_hint)
    ? req.body.type_hint
    : req.doc.type_hint;
  await query(`UPDATE documents SET status = 'pending', attempts = 0, error = NULL, retry_after = NULL, type_hint = $2 WHERE id = $1`, [
    req.doc.id,
    hint,
  ]);
  kickWorker();
  res.json({ ok: true });
});

// « Ce n'est pas un doublon » : on relance la lecture en acceptant le document.
documentsRouter.post('/documents/:id/not-duplicate', loadDocument, async (req, res) => {
  await query(
    `UPDATE documents SET status = 'pending', attempts = 0, error = NULL, retry_after = NULL, allow_duplicate = true, duplicate_of = NULL
      WHERE id = $1`,
    [req.doc.id]
  );
  kickWorker();
  res.json({ ok: true });
});

documentsRouter.post('/documents/:id/validate', loadDocument, async (req, res) => {
  await withTransaction(async (client) => {
    await client.query(`UPDATE entries SET status = 'validated' WHERE document_id = $1`, [req.doc.id]);
    await client.query(`UPDATE documents SET status = 'done' WHERE id = $1`, [req.doc.id]);
  });
  res.json({ ok: true });
});

documentsRouter.delete('/documents/:id', loadDocument, async (req, res) => {
  await query('DELETE FROM documents WHERE id = $1', [req.doc.id]);
  await afterChange(req.doc.company_id);
  res.json({ ok: true });
});
