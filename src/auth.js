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
    const { rows } = await query('SELECT id, email, name, kind FROM users WHERE id = $1', [payload.uid]);
    if (!rows[0]) return res.status(401).json({ error: 'Session invalide' });
    req.user = rows[0];
    req.device = payload.device;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée' });
  }
}

// Rôle de l'utilisateur sur un dossier : owner (cabinet qui l'a créé), staff
// (collaborateur invité, mêmes droits), client (le client lui-même), ou null.
export async function companyRole(userId, companyId) {
  const { rows } = await query(
    `SELECT c.*, CASE WHEN c.user_id = $2 THEN 'owner' ELSE m.role END AS role
       FROM companies c LEFT JOIN company_members m ON m.company_id = c.id AND m.user_id = $2
      WHERE c.id = $1 AND (c.user_id = $2 OR m.user_id IS NOT NULL)`,
    [companyId, userId]
  );
  return rows[0] || null;
}

// Ce qu'un client peut faire sur son dossier : envoyer des documents et suivre
// leur traitement. Tout le reste (écritures, plan, états...) est réservé au cabinet.
const CLIENT_ALLOWED = [
  ['GET', /^\/api\/companies\/\d+\/(documents|stats)(\?|$)/],
  ['POST', /^\/api\/companies\/\d+\/documents(\?|$)/],
];
export function clientAllowed(method, url) {
  return CLIENT_ALLOWED.some(([m, re]) => m === method && re.test(url));
}

// Vérifie que l'utilisateur a accès au dossier demandé.
export async function loadCompany(req, res, next) {
  const id = Number(req.params.companyId || req.body?.company_id || req.query.company_id);
  if (!id) return res.status(400).json({ error: 'Société manquante' });
  const company = await companyRole(req.user.id, id);
  if (!company) return res.status(404).json({ error: 'Société introuvable' });
  if (company.role === 'client' && !clientAllowed(req.method, req.originalUrl)) {
    return res.status(403).json({ error: 'Réservé au cabinet comptable' });
  }
  req.role = company.role;
  req.company = company;
  next();
}

export function requireCabinet(req, res, next) {
  if (req.role === 'client') return res.status(403).json({ error: 'Réservé au cabinet comptable' });
  next();
}
