import { toMillimes, fromMillimes, sumMillimes } from './money.js';
import { EXPENSE_CATEGORIES, BANK_CATEGORIES, accountLabel, salesAccount, DOC_TYPES } from './plan-comptable.js';

// Transforme les données extraites par l'IA en écritures comptables équilibrées.
// Toute la logique comptable est ici, de façon déterministe : l'IA ne fait que lire
// le document, elle ne décide jamais seule d'un montant au débit ou au crédit.

const MIN_CONFIDENCE = Number(process.env.AI_MIN_CONFIDENCE || 0.75);

export function partnerKey(scope, name) {
  const norm = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(sarl|suarl|sa|ste|societe|ets|etablissements?)\b/g, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, '');
  return norm ? `${scope}:${norm}` : '';
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : s;
}

function line(account, label, thirdParty, debit, credit, accountLabelOverride) {
  return {
    account,
    account_label: accountLabelOverride || accountLabel(account),
    label: String(label || '').slice(0, 250),
    third_party: String(thirdParty || '').slice(0, 200),
    debit: Math.max(0, debit),
    credit: Math.max(0, credit),
  };
}

// Inverse débit/crédit (pour les avoirs).
function reverse(lines) {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

function compact(lines) {
  return lines.filter((l) => l.debit !== 0 || l.credit !== 0);
}

export function isBalanced(lines) {
  return sumMillimes(lines.map((l) => l.debit)) === sumMillimes(lines.map((l) => l.credit));
}

/**
 * @param {object} data       réponse de l'IA (EXTRACTION_SCHEMA)
 * @param {object} company    { name, sales_type }
 * @param {Map<string,{account:string,account_label:string}>} rules  règles apprises par tiers
 * @returns {{ entries: object[], warnings: string[], needsReview: boolean, summary: string }}
 */
export function buildEntries(data, company, rules = new Map()) {
  const warnings = [];
  let needsReview = false;
  const flag = (msg, review = true) => {
    warnings.push(msg);
    if (review) needsReview = true;
  };

  if (!data || typeof data !== 'object') {
    return { entries: [], warnings: ['Aucune donnée extraite'], needsReview: true, summary: '' };
  }
  if (data.readable === false) flag('Document peu lisible : vérifiez les montants ou rescannez-le.');
  if (typeof data.confidence === 'number' && data.confidence < MIN_CONFIDENCE) {
    flag(`Confiance de l'IA faible (${Math.round(data.confidence * 100)} %).`);
  }
  if (data.notes) warnings.push(`Note IA : ${data.notes}`);

  let result;
  switch (data.doc_type) {
    case 'facture_achat':
    case 'avoir_achat':
    case 'ticket_caisse':
      result = buildPurchase(data, rules, flag);
      break;
    case 'facture_vente':
    case 'avoir_vente':
      result = buildSale(data, company, rules, flag);
      break;
    case 'releve_bancaire':
      result = buildBank(data, rules, flag);
      break;
    default:
      flag('Type de document non reconnu : aucune écriture générée.');
      result = { entries: [], summary: DOC_TYPES.autre };
  }

  for (const e of result.entries) {
    if (!isBalanced(e.lines)) {
      // Ne devrait jamais arriver : chaque constructeur équilibre ses écritures.
      flag(`Écriture "${e.label}" déséquilibrée.`);
    }
  }
  return { entries: result.entries, warnings, needsReview, summary: result.summary };
}

function invoiceAmounts(inv, flag) {
  const breakdown = Array.isArray(inv.vat_breakdown) ? inv.vat_breakdown : [];
  let ht = sumMillimes(breakdown.map((b) => toMillimes(b.base_ht)));
  let vat = sumMillimes(breakdown.map((b) => toMillimes(b.vat)));
  if (ht === 0) ht = toMillimes(inv.total_ht);
  if (vat === 0) vat = toMillimes(inv.total_vat);
  const fodec = toMillimes(inv.fodec);
  const stamp = toMillimes(inv.stamp_duty);
  let ttc = toMillimes(inv.total_ttc);
  const computed = ht + fodec + vat + stamp;

  if (ttc === 0 && computed === 0) {
    flag('Aucun montant lisible sur la facture.');
  } else if (ttc === 0) {
    ttc = computed;
  } else if (ht === 0) {
    // Seul le TTC est connu : on considère qu'il n'y a pas de TVA identifiable.
    ht = ttc - vat - fodec - stamp;
    flag('Montant HT non trouvé : déduit du TTC.');
  }

  // Écart d'arrondi entre le total imprimé et la somme des composants.
  const gap = ttc - (ht + fodec + vat + stamp);
  if (gap !== 0) {
    const big = Math.abs(gap) > 1000;
    flag(`Écart de ${fromMillimes(gap)} DT entre le TTC et HT + TVA + taxes ; reporté sur le HT.`, big);
    ht += gap;
  }

  const currency = String(inv.currency || 'TND').toUpperCase();
  if (currency && !['TND', 'DT', 'DTN', ''].includes(currency)) {
    flag(`Facture en devise (${currency}) : convertissez en dinars au taux du jour.`);
  }
  return { ht, vat, fodec, stamp, ttc };
}

function entryDate(inv, flag) {
  const d = validDate(inv.date);
  if (d) return d;
  flag('Date du document illisible : date du jour utilisée.');
  return new Date().toISOString().slice(0, 10);
}

function buildPurchase(data, rules, flag) {
  const inv = data.invoice || {};
  const supplier = inv.supplier_name || 'Fournisseur';
  const { ht, vat, fodec, stamp, ttc } = invoiceAmounts(inv, flag);
  const date = entryDate(inv, flag);

  const category = EXPENSE_CATEGORIES[inv.expense_category] || EXPENSE_CATEGORIES.autre;
  const learned = rules.get(partnerKey('achat', supplier));
  const chargeAccount = learned?.account || category.account;
  const chargeLabel = learned?.account_label || accountLabel(chargeAccount) || category.label;
  if (!learned && (inv.expense_category === 'autre' || !EXPENSE_CATEGORIES[inv.expense_category])) {
    flag('Nature de la dépense incertaine : vérifiez le compte de charge.');
  }

  const isAsset = chargeAccount.startsWith('2');
  const isCash = data.doc_type === 'ticket_caisse' || inv.paid_in_cash === true;
  const isCredit = data.doc_type === 'avoir_achat';
  const counterAccount = isCash ? '541' : isAsset ? '404' : '401';
  const journal = isCash ? 'CAI' : 'ACH';
  const piece = inv.number || '';
  const label = `${isCredit ? 'Avoir' : isCash ? 'Ticket' : 'Fact.'} ${supplier}${piece ? ` n° ${piece}` : ''}`.trim();

  let lines = compact([
    // Le FODEC payé à l'achat n'est pas récupérable : il s'ajoute au coût.
    line(chargeAccount, inv.description || label, supplier, ht + fodec, 0, chargeLabel),
    line('4366', `TVA déductible - ${supplier}`, supplier, vat, 0),
    line('66', `Droit de timbre - ${supplier}`, supplier, stamp, 0),
    line(counterAccount, label, supplier, 0, ttc),
  ]);
  if (isCredit) lines = reverse(lines);

  const withholding = toMillimes(inv.withholding_tax);
  if (withholding > 0) {
    flag(`Retenue à la source de ${fromMillimes(withholding)} DT mentionnée : à déduire lors du paiement et à déclarer.`, false);
  }

  return {
    entries: [{ journal, date, piece_ref: piece, label, lines, partner: supplier, partner_scope: 'achat' }],
    summary: `${label} — ${fromMillimes(ttc)} DT TTC`,
  };
}

function buildSale(data, company, rules, flag) {
  const inv = data.invoice || {};
  const customer = inv.customer_name || 'Client';
  const { ht, vat, fodec, stamp, ttc } = invoiceAmounts(inv, flag);
  const date = entryDate(inv, flag);
  const learned = rules.get(partnerKey('vente', customer));
  const revenueAccount = learned?.account || salesAccount(company?.sales_type);
  const isCredit = data.doc_type === 'avoir_vente';
  const piece = inv.number || '';
  const label = `${isCredit ? 'Avoir' : 'Fact.'} ${customer}${piece ? ` n° ${piece}` : ''}`.trim();

  let lines = compact([
    line('411', label, customer, ttc, 0),
    line(revenueAccount, inv.description || label, customer, 0, ht, learned?.account_label),
    line('4367', `TVA collectée - ${customer}`, customer, 0, vat),
    line('4368', `FODEC / droit de timbre - ${customer}`, customer, 0, fodec + stamp),
  ]);
  if (isCredit) lines = reverse(lines);

  return {
    entries: [{ journal: 'VTE', date, piece_ref: piece, label, lines, partner: customer, partner_scope: 'vente' }],
    summary: `${label} — ${fromMillimes(ttc)} DT TTC`,
  };
}

function buildBank(data, rules, flag) {
  const bank = data.bank || {};
  const txs = Array.isArray(bank.transactions) ? bank.transactions : [];
  const bankName = bank.bank_name || 'Banque';
  const entries = [];
  let totalIn = 0;
  let totalOut = 0;

  if (txs.length === 0) flag('Aucun mouvement trouvé sur le relevé.');

  txs.forEach((tx, i) => {
    const amountIn = toMillimes(tx.amount_in);
    const amountOut = toMillimes(tx.amount_out);
    totalIn += amountIn;
    totalOut += amountOut;
    const net = amountIn - amountOut;
    if (net === 0) return;

    let date = validDate(tx.date);
    if (!date) {
      date = validDate(bank.period_end) || new Date().toISOString().slice(0, 10);
      flag(`Ligne ${i + 1} : date illisible.`);
    }
    const category = BANK_CATEGORIES[tx.category] || BANK_CATEGORIES.autre;
    const partner = tx.counterparty || '';
    const learned = partner ? rules.get(partnerKey('banque', partner)) : null;
    const counterAccount = learned?.account || category.account;
    if (!learned && counterAccount === '471') flag(`Ligne ${i + 1} « ${tx.label} » : nature inconnue, mise en compte d'attente 471.`);

    const label = String(tx.label || category.label).slice(0, 200);
    const lines =
      net > 0
        ? [line('532', label, bankName, net, 0), line(counterAccount, label, partner, 0, net, learned?.account_label)]
        : [line(counterAccount, label, partner, -net, 0, learned?.account_label), line('532', label, bankName, 0, -net)];
    entries.push({ journal: 'BQ', date, piece_ref: `${bankName} L${i + 1}`, label, lines, partner, partner_scope: 'banque' });
  });

  const opening = toMillimes(bank.opening_balance);
  const closing = toMillimes(bank.closing_balance);
  if (opening !== 0 || closing !== 0) {
    const expected = opening + totalIn - totalOut;
    if (expected !== closing) {
      flag(
        `Contrôle du relevé : solde initial + mouvements = ${fromMillimes(expected)} DT mais solde final imprimé = ${fromMillimes(closing)} DT. Une ligne a peut-être été mal lue.`
      );
    }
  }

  return {
    entries,
    summary: `Relevé ${bankName}${bank.period_start ? ` du ${bank.period_start} au ${bank.period_end}` : ''} — ${entries.length} mouvement(s)`,
  };
}
