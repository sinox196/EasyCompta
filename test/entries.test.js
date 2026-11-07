import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, isBalanced, partnerKey } from '../src/accounting/entries.js';

const baseInvoice = {
  number: 'F1', date: '2026-10-15', due_date: '', supplier_name: 'Tunisie Telecom', supplier_tax_id: '',
  customer_name: 'Ma Société', customer_tax_id: '', currency: 'TND',
  vat_breakdown: [{ rate: 19, base_ht: 1000, vat: 190 }], fodec: 0, stamp_duty: 1,
  total_ht: 1000, total_vat: 190, total_ttc: 1191, withholding_tax: 0, paid_in_cash: false,
  expense_category: 'telecom_internet', description: 'Internet',
};
const emptyBank = { bank_name: '', account_number: '', period_start: '', period_end: '', opening_balance: 0, closing_balance: 0, currency: '', transactions: [] };
const doc = (doc_type, invoice = baseInvoice, bank = emptyBank) => ({ doc_type, confidence: 0.95, readable: true, notes: '', invoice, bank });
const byAccount = (lines) => Object.fromEntries(lines.map((l) => [l.account, l]));

test('facture d\'achat : charge + TVA déductible + timbre / fournisseur', () => {
  const r = buildEntries(doc('facture_achat'), { sales_type: 'services' });
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.journal, 'ACH');
  assert.ok(isBalanced(e.lines));
  const a = byAccount(e.lines);
  assert.equal(a['626'].debit, 1000000);
  assert.equal(a['4366'].debit, 190000);
  assert.equal(a['66'].debit, 1000);
  assert.equal(a['401'].credit, 1191000);
  assert.equal(r.needsReview, false);
});

test('facture de vente : client / produit + TVA collectée + timbre', () => {
  const r = buildEntries(doc('facture_vente', { ...baseInvoice, customer_name: 'Alpha' }), { sales_type: 'marchandises' });
  const a = byAccount(r.entries[0].lines);
  assert.equal(r.entries[0].journal, 'VTE');
  assert.equal(a['411'].debit, 1191000);
  assert.equal(a['707'].credit, 1000000);
  assert.equal(a['4367'].credit, 190000);
  assert.equal(a['4368'].credit, 1000);
  assert.ok(isBalanced(r.entries[0].lines));
});

test('avoir fournisseur : sens inversé', () => {
  const r = buildEntries(doc('avoir_achat'), {});
  const a = byAccount(r.entries[0].lines);
  assert.equal(a['401'].debit, 1191000);
  assert.equal(a['626'].credit, 1000000);
});

test('immobilisation : fournisseur d\'immobilisations 404', () => {
  const r = buildEntries(doc('facture_achat', { ...baseInvoice, expense_category: 'immo_informatique' }), {});
  const a = byAccount(r.entries[0].lines);
  assert.ok(a['2283']);
  assert.equal(a['404'].credit, 1191000);
});

test('ticket de caisse : journal caisse, crédit 541', () => {
  const r = buildEntries(doc('ticket_caisse', { ...baseInvoice, expense_category: 'carburant', vat_breakdown: [], total_ht: 0, total_vat: 0, stamp_duty: 0, total_ttc: 80 }), {});
  const e = r.entries[0];
  assert.equal(e.journal, 'CAI');
  assert.equal(byAccount(e.lines)['541'].credit, 80000);
  assert.ok(isBalanced(e.lines));
});

test('écart de total : équilibré et signalé', () => {
  const r = buildEntries(doc('facture_achat', { ...baseInvoice, total_ttc: 1250 }), {});
  assert.ok(isBalanced(r.entries[0].lines));
  assert.equal(r.needsReview, true);
});

test('règle apprise : le compte du fournisseur est réutilisé', () => {
  const rules = new Map([[partnerKey('achat', 'Tunisie Telecom'), { account: '6064', account_label: 'X' }]]);
  const r = buildEntries(doc('facture_achat'), {}, rules);
  assert.ok(byAccount(r.entries[0].lines)['6064']);
});

test('relevé bancaire : une écriture par mouvement et contrôle des soldes', () => {
  const bank = {
    ...emptyBank, bank_name: 'BIAT', opening_balance: 1000, closing_balance: 1500,
    transactions: [
      { date: '2026-10-02', label: 'VIR CLIENT', amount_out: 0, amount_in: 600, category: 'encaissement_client', counterparty: 'Alpha' },
      { date: '2026-10-05', label: 'FRAIS', amount_out: 100, amount_in: 0, category: 'frais_bancaires', counterparty: '' },
    ],
  };
  const r = buildEntries(doc('releve_bancaire', baseInvoice, bank), {});
  assert.equal(r.entries.length, 2);
  r.entries.forEach((e) => assert.ok(isBalanced(e.lines)));
  assert.equal(byAccount(r.entries[0].lines)['532'].debit, 600000);
  assert.equal(byAccount(r.entries[0].lines)['411'].credit, 600000);
  assert.equal(byAccount(r.entries[1].lines)['627'].debit, 100000);
  assert.equal(r.needsReview, false);

  const bad = buildEntries(doc('releve_bancaire', baseInvoice, { ...bank, closing_balance: 9999 }), {});
  assert.equal(bad.needsReview, true);
});

test('faible confiance : à vérifier', () => {
  const r = buildEntries({ ...doc('facture_achat'), confidence: 0.4 }, {});
  assert.equal(r.needsReview, true);
});
