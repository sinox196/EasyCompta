// Amortissement linéaire prorata temporis (au jour près, base 365 jours).

/**
 * @param {{value:number, rate:number, acquisition_date:string}} immo  value en millimes, rate en %
 * @param {number} year
 * @returns {{dotation:number, cumulBefore:number, vnc:number}}  en millimes
 */
export function dotationForYear(immo, year) {
  const annual = (immo.value * immo.rate) / 100;
  const acq = new Date(`${immo.acquisition_date}T00:00:00Z`);
  const daysInYear = (y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
  const share = (y) => {
    if (y < acq.getUTCFullYear()) return 0;
    if (y > acq.getUTCFullYear()) return 1;
    const end = Date.UTC(y, 11, 31);
    return ((end - acq.getTime()) / 86400000 + 1) / daysInYear(y);
  };
  let cumul = 0;
  for (let y = acq.getUTCFullYear(); y < year; y++) cumul = Math.min(immo.value, cumul + Math.round(annual * share(y)));
  const dotation = Math.max(0, Math.min(immo.value - cumul, Math.round(annual * share(year))));
  return { dotation, cumulBefore: cumul, vnc: immo.value - cumul - dotation };
}
