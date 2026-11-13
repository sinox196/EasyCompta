import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveAccount, findAuxiliary, nextAuxiliaryCode } from '../src/accounting/plan-resolve.js';

const defaults = JSON.parse(fs.readFileSync(new URL('../src/accounting/plan-tunisien.json', import.meta.url)));
const plan = new Map(defaults.map((a) => [a.code, a]));

test('racines traduites vers les comptes du plan tunisien', () => {
  assert.equal(resolveAccount(plan, '43666'), '43666000'); // TVA sur autres biens et services
  assert.equal(resolveAccount(plan, '43671'), '43671000'); // TVA collectée
  assert.equal(resolveAccount(plan, '401'), '40110000');
  assert.equal(resolveAccount(plan, '626'), '62600000');
  assert.equal(resolveAccount(plan, '6278'), '62780000');
  assert.equal(resolveAccount(plan, '5321'), '53210000');
  assert.equal(resolveAccount(plan, '2283'), '22830000');
  assert.equal(resolveAccount(plan, '28283'), '28283000');
  assert.equal(resolveAccount(plan, '705'), '70500000');
  assert.equal(resolveAccount(plan, '461'), '46100000');
  assert.equal(resolveAccount(plan, '62600000'), '62600000');
});

test('comptes auxiliaires de tiers', () => {
  const p = new Map(plan);
  assert.equal(findAuxiliary(p, '401', 'Tunisie Telecom'), null);
  assert.equal(nextAuxiliaryCode(p, '401'), '40110001');
  p.set('40110001', { code: '40110001', label: 'TELECOM', nature: 'C' });
  p.set('40110002', { code: '40110002', label: 'STEG', nature: 'C' });
  assert.equal(findAuxiliary(p, '401', 'Tunisie Telecom SA')?.code, '40110001');
  assert.equal(findAuxiliary(p, '401', 'steg')?.code, '40110002');
  assert.equal(nextAuxiliaryCode(p, '401'), '40110003');
  assert.equal(nextAuxiliaryCode(p, '411'), '41110001');
});
