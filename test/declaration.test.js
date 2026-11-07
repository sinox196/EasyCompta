import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDeclaration, vatCreditBefore, deadline } from '../src/accounting/declaration.js';

test('crédit de TVA reporté de mois en mois', () => {
  assert.equal(vatCreditBefore([
    { month: '2026-01', collectee: 100, deductible: 300 }, // crédit 200
    { month: '2026-02', collectee: 150, deductible: 0 },   // 150 - 200 = crédit 50
  ]), 50);
  assert.equal(vatCreditBefore([{ month: '2026-01', collectee: 500, deductible: 100 }]), 0);
});

test('déclaration : TVA nette du crédit, timbre, FODEC, TCL, RS', () => {
  const d = computeDeclaration({
    month: '2026-10',
    current: { collectee: 190000, deductible: 50000, caHt: 1000000, rs: 15000 },
    history: [{ month: '2026-09', collectee: 0, deductible: 40000 }],
    salesTaxes: { stamp: 1000, fodec: 10000 },
  });
  assert.equal(d.tva.creditReporte, 40000);
  assert.equal(d.tva.aPayer, 100000);
  assert.equal(d.lines.find((l) => l.code === 'TCL').amount, 2380); // 0,2 % de 1 190 DT
  assert.equal(d.total, 100000 + 15000 + 1000 + 10000 + 2380);
  assert.equal(d.deadline, '2026-11-28');
});

test('crédit à reporter quand la TVA déductible dépasse la collectée', () => {
  const d = computeDeclaration({ month: '2026-12', current: { collectee: 0, deductible: 30000, caHt: 0, rs: 0 }, history: [], salesTaxes: { stamp: 0, fodec: 0 } });
  assert.equal(d.tva.aPayer, 0);
  assert.equal(d.tva.creditAReporter, 30000);
  assert.equal(d.deadline, '2027-01-28');
});
