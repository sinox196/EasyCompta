// Résolution des comptes : la logique comptable (entries.js) raisonne avec des
// racines de comptes (« 43666 », « 401 »...) ; on les traduit en comptes réels du
// plan comptable de la société (codes à 8 chiffres : 43666000, 40110007...).

const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/\b(sarl|suarl|sa|ste|societe|ets|etablissements?|ste\.)\b/g, ' ')
  .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
  .trim();

export function normalizeName(s) {
  return norm(s);
}

/**
 * @param {Map<string,{code:string,label:string,nature:string}>} plan  comptes de la société
 * @param {string} root  racine ou compte complet
 * @returns {string} compte de détail (nature « C ») le plus adapté
 */
export function resolveAccount(plan, root) {
  const code = String(root || '').trim();
  if (!code) return code;
  const exact = plan.get(code);
  if (exact && exact.nature !== 'R') return code;
  // Compte général : la racine complétée de zéros (401 -> 40100000, 43666 -> 43666000)...
  const padded = code.padEnd(8, '0');
  const p = plan.get(padded);
  if (p && p.nature !== 'R') return padded;
  // ... sinon le premier compte de détail « rond » (hors sous-comptes de tiers) commençant par la racine.
  const candidates = [...plan.values()]
    .filter((a) => a.nature !== 'R' && a.code.startsWith(code))
    .sort((a, b) => a.code.localeCompare(b.code));
  const round = candidates.find((a) => a.code.length === 8 && a.code.endsWith('000'));
  return (round || candidates[0])?.code || padded;
}

// Compte collectif sous lequel on ouvre les comptes auxiliaires de tiers.
export const AUX_BASE = { '401': '4011', '404': '4041', '411': '4111' };

export function isAuxiliary(code) {
  return code.length === 8 && !code.endsWith('000') && Object.values(AUX_BASE).some((b) => code.startsWith(b));
}

/**
 * Cherche le compte auxiliaire d'un tiers (fournisseur / client) par son nom.
 * @returns {{code:string}|null}
 */
export function findAuxiliary(plan, root, name) {
  const base = AUX_BASE[root];
  const n = norm(name);
  if (!base || !n) return null;
  const aux = [...plan.values()].filter((a) => a.nature !== 'R' && a.code.startsWith(base) && isAuxiliary(a.code));
  const exact = aux.find((a) => norm(a.label) === n);
  if (exact) return exact;
  // Nom approchant : l'un contient l'autre (« STEG » / « STEG DISTRICT TUNIS »), au moins 3 lettres.
  const close = aux.filter((a) => {
    const l = norm(a.label);
    return (l.length >= 3 && n.includes(l)) || (n.length >= 3 && l.includes(n));
  });
  return close.length === 1 ? close[0] : null;
}

// Prochain numéro libre pour un nouveau tiers : 40110000 -> 40110001, 40110002...
export function nextAuxiliaryCode(plan, root) {
  const base = AUX_BASE[root];
  const general = resolveAccount(plan, base);
  const prefix = general.slice(0, 4);
  let max = Number(general);
  for (const a of plan.values()) if (a.code.length === 8 && a.code.startsWith(prefix)) max = Math.max(max, Number(a.code));
  return String(max + 1).padStart(8, '0');
}
