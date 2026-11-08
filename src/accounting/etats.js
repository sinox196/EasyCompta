// Bilan et état de résultat simplifiés, calculés à partir des soldes des comptes.
// Montants en millimes. Présentation inspirée du modèle tunisien (NC 01), regroupée
// par classes de comptes pour rester lisible par un non-comptable.

const RESULT_GROUPS = [
  { key: 'revenus', label: 'Revenus (ventes et prestations)', prefixes: ['70'], sign: 1 },
  { key: 'autres_produits', label: 'Autres produits d\'exploitation', prefixes: ['71', '72', '73', '74'], sign: 1 },
  { key: 'achats', label: 'Achats consommés', prefixes: ['60'], sign: -1 },
  { key: 'services', label: 'Services extérieurs et autres charges', prefixes: ['61', '62', '63'], sign: -1 },
  { key: 'personnel', label: 'Charges de personnel', prefixes: ['64'], sign: -1 },
  { key: 'impots', label: 'Impôts et taxes', prefixes: ['66'], sign: -1 },
  { key: 'dotations', label: 'Dotations aux amortissements et provisions', prefixes: ['68'], sign: -1 },
  { key: 'financier', label: 'Résultat financier (produits − charges financières)', prefixes: ['65', '75', '76'], sign: 1, net: true },
  { key: 'exceptionnel', label: 'Gains et pertes extraordinaires', prefixes: ['67', '77', '78', '79'], sign: 1, net: true },
  { key: 'impot_benefices', label: 'Impôt sur les bénéfices', prefixes: ['69'], sign: -1 },
];

/**
 * @param {{account:string, debit:number, credit:number}[]} balance  totaux par compte (millimes)
 */
export function financialStatements(balance) {
  const solde = (a) => a.debit - a.credit; // > 0 : débiteur
  const match = (acc, prefixes) => prefixes.some((p) => acc.startsWith(p));

  // État de résultat
  const resultat = RESULT_GROUPS.map((g) => {
    const net = balance.filter((a) => match(a.account, g.prefixes)).reduce((s, a) => s + (a.credit - a.debit), 0);
    return { key: g.key, label: g.label, amount: g.net ? net : g.sign > 0 ? net : -net };
  });
  const totalProduits = balance.filter((a) => a.account.startsWith('7')).reduce((s, a) => s + a.credit - a.debit, 0);
  const totalCharges = balance.filter((a) => a.account.startsWith('6')).reduce((s, a) => s + a.debit - a.credit, 0);
  const resultatNet = totalProduits - totalCharges;
  const exploitation = resultat
    .filter((r) => ['revenus', 'autres_produits'].includes(r.key)).reduce((s, r) => s + r.amount, 0)
    - resultat.filter((r) => ['achats', 'services', 'personnel', 'impots', 'dotations'].includes(r.key)).reduce((s, r) => s + r.amount, 0);

  // Bilan
  const sum = (filter, fn) => balance.filter(filter).reduce((s, a) => s + fn(a), 0);
  // Classe 28 : amortissements, 29 : provisions pour dépréciation (en diminution de l'actif).
  const isAmort = (acc) => acc.startsWith('28') || acc.startsWith('29');
  const immoBrut = sum((a) => a.account.startsWith('2') && !isAmort(a.account), solde);
  const amort = sum((a) => a.account.startsWith('2') && isAmort(a.account), (a) => -solde(a));
  const stocks = sum((a) => a.account.startsWith('3'), solde);
  const thirdDebit = sum((a) => a.account.startsWith('4') && solde(a) > 0, solde);
  const thirdCredit = sum((a) => a.account.startsWith('4') && solde(a) < 0, (a) => -solde(a));
  const cashDebit = sum((a) => a.account.startsWith('5') && solde(a) > 0, solde);
  const cashCredit = sum((a) => a.account.startsWith('5') && solde(a) < 0, (a) => -solde(a));
  const capitaux = sum((a) => a.account.startsWith('1') && !a.account.startsWith('16'), (a) => -solde(a));
  const emprunts = sum((a) => a.account.startsWith('16'), (a) => -solde(a));

  const actif = [
    { label: 'Immobilisations (valeur brute)', amount: immoBrut },
    { label: 'Moins : amortissements', amount: -amort },
    { label: 'Stocks', amount: stocks },
    { label: 'Clients, Etat et autres créances', amount: thirdDebit },
    { label: 'Banques et caisse', amount: cashDebit },
  ];
  const passif = [
    { label: 'Capitaux propres', amount: capitaux },
    { label: 'Résultat de la période', amount: resultatNet },
    { label: 'Emprunts', amount: emprunts },
    { label: 'Fournisseurs, Etat et autres dettes', amount: thirdCredit },
    { label: 'Concours bancaires (découverts)', amount: cashCredit },
  ];
  const totalActif = actif.reduce((s, l) => s + l.amount, 0);
  const totalPassif = passif.reduce((s, l) => s + l.amount, 0);

  return {
    resultat: { lines: resultat, exploitation, totalProduits, totalCharges, net: resultatNet },
    bilan: { actif, passif, totalActif, totalPassif, equilibre: totalActif === totalPassif },
  };
}
