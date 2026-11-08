// Lettrage automatique : rapproche chaque facture (fournisseur ou client) de son
// règlement (ligne de relevé bancaire, caisse...). Une facture et son paiement
// reçoivent le même code de lettrage ; ce qui reste non lettré est dû.

import { partnerKey } from './entries.js';

// Côté "facture" de chaque compte de tiers : 401/404 au crédit, 411 au débit.
const SIDES = [
  { prefix: '401', invoiceSide: 'credit' },
  { prefix: '404', invoiceSide: 'credit' },
  { prefix: '411', invoiceSide: 'debit' },
];

export function sideFor(account) {
  return SIDES.find((s) => account.startsWith(s.prefix)) || null;
}

function key(name) {
  return partnerKey('t', name).slice(2);
}

// Deux noms désignent le même tiers si l'un contient l'autre une fois normalisés
// ("STEG" et "STEG DISTRICT TUNIS", "ALPHA SARL" et "Alpha").
function samePartner(a, b) {
  if (!a || !b) return false;
  return a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b));
}

/**
 * @param {{id:number, account:string, third_party:string, debit:number, credit:number, date:string, withholding?:number}[]} lines
 *   lignes non lettrées des comptes 401/404/411 (montants en millimes)
 * @returns {{code:string, lineIds:number[], partial:boolean}[]}
 */
export function matchLines(lines) {
  const matches = [];
  for (const { prefix, invoiceSide } of SIDES) {
    const pool = lines.filter((l) => l.account.startsWith(prefix)).map((l) => ({ ...l, k: key(l.third_party) }));
    const amountOf = (l, side) => (side === 'debit' ? l.debit : l.credit);
    const paySide = invoiceSide === 'debit' ? 'credit' : 'debit';
    const invoices = pool.filter((l) => amountOf(l, invoiceSide) > 0).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const payments = pool.filter((l) => amountOf(l, paySide) > 0).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const used = new Set();

    for (const pay of payments) {
      const amount = amountOf(pay, paySide);
      // Factures du même tiers (ou toutes si le paiement n'a pas de nom de tiers).
      const candidates = invoices.filter((inv) => !used.has(inv.id) && (pay.k ? samePartner(inv.k, pay.k) : true));
      // 1. Une facture du même montant (ou du montant net de la retenue à la source).
      let hit = candidates.find((inv) => amountOf(inv, invoiceSide) === amount);
      let partial = false;
      if (!hit) {
        hit = candidates.find((inv) => inv.withholding > 0 && amountOf(inv, invoiceSide) - inv.withholding === amount);
        partial = Boolean(hit);
      }
      // Sans nom de tiers, un montant identique ne suffit que s'il est unique.
      if (hit && !pay.k && candidates.filter((inv) => amountOf(inv, invoiceSide) === amountOf(hit, invoiceSide)).length > 1) hit = null;
      if (hit) {
        used.add(hit.id);
        matches.push({ code: `L${pay.id}`, lineIds: [hit.id, pay.id], partial });
        continue;
      }
      // 2. Un paiement qui règle plusieurs factures du même tiers (les plus anciennes d'abord).
      if (!pay.k) continue;
      let sum = 0;
      const group = [];
      for (const inv of candidates) {
        sum += amountOf(inv, invoiceSide);
        group.push(inv);
        if (sum >= amount) break;
      }
      if (group.length > 1 && sum === amount) {
        group.forEach((g) => used.add(g.id));
        matches.push({ code: `L${pay.id}`, lineIds: [...group.map((g) => g.id), pay.id], partial: false });
      }
    }
  }
  return matches;
}
