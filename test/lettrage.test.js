import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLines } from '../src/accounting/lettrage.js';

const L = (id, account, third_party, debit, credit, date, withholding = 0) => ({ id, account, third_party, debit, credit, date, withholding });

test('facture fournisseur lettrée avec son paiement (nom approchant)', () => {
  const m = matchLines([L(1, '401', 'STEG', 0, 214500, '2026-10-01'), L(2, '401', 'STEG DISTRICT TUNIS', 214500, 0, '2026-10-10')]);
  assert.deepEqual(m.map((x) => x.lineIds), [[1, 2]]);
});

test('client : un virement règle deux factures', () => {
  const m = matchLines([
    L(1, '411', 'Alpha SARL', 1000000, 0, '2026-09-01'),
    L(2, '411', 'Alpha', 500000, 0, '2026-09-15'),
    L(3, '411', 'ALPHA', 0, 1500000, '2026-10-03'),
  ]);
  assert.deepEqual(m[0].lineIds, [1, 2, 3]);
});

test('paiement net de retenue à la source : lettrage partiel', () => {
  const m = matchLines([L(1, '401', 'Cabinet X', 0, 1000000, '2026-10-01', 15000), L(2, '401', 'Cabinet X', 985000, 0, '2026-10-20')]);
  assert.equal(m.length, 1);
  assert.equal(m[0].partial, true);
});

test('pas de lettrage entre tiers différents ou montants différents', () => {
  const m = matchLines([L(1, '401', 'STEG', 0, 100000, '2026-10-01'), L(2, '401', 'SONEDE', 100000, 0, '2026-10-02'), L(3, '401', 'STEG', 90000, 0, '2026-10-03')]);
  assert.equal(m.length, 0);
});

test('paiement sans nom : seulement si le montant est unique', () => {
  assert.equal(matchLines([L(1, '401', 'A', 0, 50000, '2026-10-01'), L(2, '401', '', 50000, 0, '2026-10-02')]).length, 1);
  assert.equal(matchLines([L(1, '401', 'A', 0, 50000, '2026-10-01'), L(3, '401', 'B', 0, 50000, '2026-10-01'), L(2, '401', '', 50000, 0, '2026-10-02')]).length, 0);
});
