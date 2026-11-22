import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { query, withTransaction } from '../db.js';
import { requireAuth, loadCompany, requireCabinet, setSession } from '../auth.js';

// Cabinet multi-clients : invitations et accès aux dossiers.
//  - client : le client envoie ses documents (site ou téléphone) et suit leur traitement
//  - staff  : collaborateur du cabinet, accès complet au dossier
export const membersRouter = Router();

const ROLES = { client: 'Client', staff: 'Collaborateur du cabinet' };
const INVITE_DAYS = 14;

function publicBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.get('host')}`;
}

membersRouter.get('/companies/:companyId/members', requireAuth, loadCompany, requireCabinet, async (req, res) => {
  const { rows: owner } = await query('SELECT id, name, email FROM users WHERE id = $1', [req.company.user_id]);
  const { rows: members } = await query(
    `SELECT u.id, u.name, u.email, m.role, m.created_at FROM company_members m JOIN users u ON u.id = m.user_id
      WHERE m.company_id = $1 ORDER BY m.role, u.name`,
    [req.company.id]
  );
  const { rows: invites } = await query(
    `SELECT token, role, label, expires_at, created_at FROM invitations
      WHERE company_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [req.company.id]
  );
  const base = publicBaseUrl(req);
  res.json({
    owner: owner[0] ? { ...owner[0], role: 'owner' } : null,
    members,
    invitations: invites.map((i) => ({ ...i, url: `${base}/invite?token=${i.token}` })),
  });
});

membersRouter.post('/companies/:companyId/invitations', requireAuth, loadCompany, requireCabinet, async (req, res) => {
  const role = ROLES[req.body?.role] ? req.body.role : 'client';
  const label = String(req.body?.label || '').trim().slice(0, 120);
  const token = crypto.randomBytes(18).toString('base64url');
  const expires = new Date(Date.now() + INVITE_DAYS * 24 * 3600 * 1000);
  await query(
    'INSERT INTO invitations (token, company_id, created_by, role, label, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [token, req.company.id, req.user.id, role, label, expires]
  );
  const url = `${publicBaseUrl(req)}/invite?token=${token}`;
  const qr = await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 });
  res.json({ token, url, qr, role, expires_at: expires });
});

membersRouter.delete('/companies/:companyId/invitations/:token', requireAuth, loadCompany, requireCabinet, async (req, res) => {
  await query('DELETE FROM invitations WHERE token = $1 AND company_id = $2', [req.params.token, req.company.id]);
  res.json({ ok: true });
});

membersRouter.delete('/companies/:companyId/members/:userId', requireAuth, loadCompany, requireCabinet, async (req, res) => {
  await query('DELETE FROM company_members WHERE company_id = $1 AND user_id = $2', [req.company.id, Number(req.params.userId)]);
  res.json({ ok: true });
});

// --- Côté invité (lien reçu par WhatsApp, e-mail, QR code) ------------------------

async function loadInvitation(token) {
  const { rows } = await query(
    `SELECT i.*, c.name AS company_name, u.name AS inviter_name
       FROM invitations i JOIN companies c ON c.id = i.company_id JOIN users u ON u.id = i.created_by
      WHERE i.token = $1`,
    [String(token || '')]
  );
  const inv = rows[0];
  if (!inv) return { error: 'Invitation introuvable' };
  if (inv.used_at) return { error: 'Cette invitation a déjà été utilisée. Connectez-vous avec votre compte.' };
  if (new Date(inv.expires_at) < new Date()) return { error: 'Invitation expirée : demandez un nouveau lien à votre comptable.' };
  return { inv };
}

membersRouter.get('/invitations/:token', async (req, res) => {
  const { inv, error } = await loadInvitation(req.params.token);
  if (error) return res.status(400).json({ error });
  res.json({ company_name: inv.company_name, inviter_name: inv.inviter_name, role: inv.role, role_label: ROLES[inv.role] });
});

async function addMember(client, inv, userId) {
  await client.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [inv.company_id, userId, inv.role]
  );
  await client.query('UPDATE invitations SET used_at = now(), used_by = $2 WHERE token = $1', [inv.token, userId]);
}

// Acceptation : nouveau compte (nom, email, mot de passe) ou compte existant
// (email + mot de passe). Le dossier est ensuite accessible avec ce compte.
membersRouter.post('/invitations/:token/accept', async (req, res) => {
  const { inv, error } = await loadInvitation(req.params.token);
  if (error) return res.status(400).json({ error });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email invalide' });

  const { rows: existing } = await query('SELECT * FROM users WHERE email = $1', [email]);
  let user = existing[0];
  if (user) {
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Un compte existe déjà avec cet email : saisissez son mot de passe.' });
    }
  } else {
    if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      'INSERT INTO users (email, name, password_hash, kind) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, name, hash, inv.role === 'client' ? 'client' : 'cabinet']
    );
    user = rows[0];
  }
  await withTransaction((client) => addMember(client, inv, user.id));
  setSession(res, user);
  res.json({ user: { id: user.id, email: user.email, name: user.name, kind: user.kind }, company_id: inv.company_id });
});
