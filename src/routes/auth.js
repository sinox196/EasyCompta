import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { query } from '../db.js';
import { setSession, clearSession, requireAuth } from '../auth.js';

export const authRouter = Router();

authRouter.post('/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const companyName = String(req.body?.company_name || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email invalide' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });

  const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists.rows.length) return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name', [
    email,
    name,
    hash,
  ]);
  if (companyName) {
    await query('INSERT INTO companies (user_id, name) VALUES ($1, $2)', [rows[0].id, companyName]);
  }
  setSession(res, rows[0]);
  res.json({ user: rows[0] });
});

authRouter.post('/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }
  const mobile = req.body?.device === 'mobile';
  setSession(res, user, mobile ? { days: 180, device: 'mobile' } : undefined);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

authRouter.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user, device: req.device });
});

// --- Liaison du téléphone (QR code) -----------------------------------------
// Le web génère un QR code contenant un lien à usage unique ; le téléphone qui
// l'ouvre est connecté au même compte sans retaper de mot de passe.

function publicBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.get('host')}`;
}

authRouter.post('/pairing', requireAuth, async (req, res) => {
  const companyId = req.body?.company_id ? Number(req.body.company_id) : null;
  if (companyId) {
    const { rows } = await query('SELECT 1 FROM companies WHERE id = $1 AND user_id = $2', [companyId, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Société introuvable' });
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  await query('INSERT INTO pairing_tokens (token, user_id, company_id, expires_at) VALUES ($1, $2, $3, $4)', [
    token,
    req.user.id,
    companyId,
    expires,
  ]);
  const url = `${publicBaseUrl(req)}/scan?pair=${token}`;
  const qr = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
  res.json({ token, url, qr, expires_at: expires });
});

authRouter.get('/pairing/:token', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT used_at, expires_at FROM pairing_tokens WHERE token = $1 AND user_id = $2', [
    req.params.token,
    req.user.id,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'Lien inconnu' });
  res.json({ used: Boolean(rows[0].used_at), expired: rows[0].expires_at < new Date() });
});

authRouter.post('/pairing/claim', async (req, res) => {
  const token = String(req.body?.token || '');
  const { rows } = await query(
    `UPDATE pairing_tokens SET used_at = now()
      WHERE token = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, company_id`,
    [token]
  );
  if (!rows[0]) return res.status(400).json({ error: 'QR code expiré ou déjà utilisé. Générez-en un nouveau depuis le site.' });
  const { rows: users } = await query('SELECT id, email, name FROM users WHERE id = $1', [rows[0].user_id]);
  setSession(res, users[0], { days: 180, device: 'mobile' });
  res.json({ user: users[0], company_id: rows[0].company_id });
});
