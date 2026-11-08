import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financialStatements } from '../src/accounting/etats.js';
import { dotationForYear } from '../src/accounting/amortissement.js';

test('bilan équilibré et résultat = produits − charges', () => {
  const bal = [
    { account: '706', debit: 0, credit: 1000000 },
    { account: '4367', debit: 0, credit: 190000 },
    { account: '411', debit: 1191000, credit: 0 },
    { account: '4368', debit: 0, credit: 1000 },
    { account: '626', debit: 300000, credit: 0 },
    { account: '4366', debit: 57000, credit: 0 },
    { account: '401', debit: 0, credit: 357000 },
    { account: '2283', debit: 2000000, credit: 0 },
    { account: '532', debit: 0, credit: 2000000 },
  ];
  const { bilan, resultat } = financialStatements(bal);
  assert.equal(resultat.net, 700000);
  assert.equal(bilan.equilibre, true);
  assert.equal(bilan.actif[0].amount, 2000000); // 2283 = immobilisation, pas un amortissement
});

test('amortissements en diminution de l\'actif', () => {
  const { bilan } = financialStatements([
    { account: '2283', debit: 2500000, credit: 0 },
    { account: '28283', debit: 0, credit: 666660 },
    { account: '6811', debit: 666660, credit: 0 },
    { account: '404', debit: 0, credit: 2500000 },
  ]);
  assert.equal(bilan.actif[0].amount, 2500000);
  assert.equal(bilan.actif[1].amount, -666660);
  assert.equal(bilan.equilibre, true);
});

test('amortissement linéaire prorata temporis', () => {
  const immo = { value: 3650000, rate: 20, acquisition_date: '2025-07-02' }; // 183 jours en 2025
  const y1 = dotationForYear(immo, 2025);
  assert.equal(y1.dotation, Math.round(730000 * 183 / 365));
  assert.equal(dotationForYear(immo, 2026).dotation, 730000);
  assert.equal(dotationForYear(immo, 2031).vnc, 0); // totalement amorti
  assert.equal(dotationForYear(immo, 2024).dotation, 0);
});
