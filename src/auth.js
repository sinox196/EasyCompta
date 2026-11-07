import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query } from './db.js';

let secret = process.env.JWT_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET absent : clé temporaire générée (les sessions seront perdues au redémarrage).');
}

const COOKIE = 'ec_session';
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);

export function setSession(res, user, { days = 30, device = 'web' } = {}) {
  const token = jwt.sign({ uid: user.id, device }, secret, { expiresIn: `${days}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: days * 24 * 3600 * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE);
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    const payload = jwt.verify(token, secret);
    const { rows } = await query('SELECT id, email, name FROM users WHERE id = $1', [payload.uid]);
    if (!rows[0]) return res.status(401).json({ error: 'Session invalide' });
    req.user = rows[0];
    req.device = payload.device;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée' });
  }
}

// Vérifie que la société demandée appartient bien à l'utilisateur connecté.
export async function loadCompany(req, res, next) {
  const id = Number(req.params.companyId || req.body?.company_id || req.query.company_id);
  if (!id) return res.status(400).json({ error: 'Société manquante' });
  const { rows } = await query('SELECT * FROM companies WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Société introuvable' });
  req.company = rows[0];
  next();
}
