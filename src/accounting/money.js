// Le dinar tunisien a 3 décimales (millimes). Tous les calculs se font en entiers
// (millimes) pour éviter les erreurs d'arrondi des nombres flottants.

export function toMillimes(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

export function fromMillimes(m) {
  return (m / 1000).toFixed(3);
}

export function sumMillimes(values) {
  return values.reduce((acc, v) => acc + v, 0);
}
