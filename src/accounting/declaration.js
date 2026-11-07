// Déclaration mensuelle des impôts (Tunisie) : calcul à partir des écritures et des
// documents lus par l'IA. Montants en millimes. Les taux sont regroupés ici pour
// pouvoir être ajustés facilement (lois de finances).

export const RATES = {
  TCL: 0.002, // Taxe sur les établissements (TCL) : 0,2 % du chiffre d'affaires brut local TTC
};

// Date limite de dépôt : le 28 du mois suivant pour les personnes morales,
// le 15 pour les personnes physiques.
export function deadline(month, personneMorale = true) {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, personneMorale ? 28 : 15));
  return next.toISOString().slice(0, 10);
}

/**
 * Crédit de TVA reporté au début du mois demandé : on rejoue tous les mois précédents.
 * @param {{month: string, collectee: number, deductible: number}[]} history  mois < mois demandé
 */
export function vatCreditBefore(history) {
  let credit = 0;
  for (const h of [...history].sort((a, b) => a.month.localeCompare(b.month))) {
    const net = h.collectee - h.deductible - credit;
    credit = net < 0 ? -net : 0;
  }
  return credit;
}

/**
 * @param {object} p
 * @param {string} p.month                 'AAAA-MM'
 * @param {{collectee:number, deductible:number, caHt:number, rs:number}} p.current  totaux du mois (écritures)
 * @param {{month:string, collectee:number, deductible:number}[]} p.history          mois précédents
 * @param {{stamp:number, fodec:number}} p.salesTaxes                                timbre et FODEC collectés
 */
export function computeDeclaration({ month, current, history, salesTaxes }) {
  const creditReporte = vatCreditBefore(history);
  const tvaNet = current.collectee - current.deductible - creditReporte;
  const tvaAPayer = Math.max(0, tvaNet);
  const creditAReporter = Math.max(0, -tvaNet);
  const caTtc = current.caHt + current.collectee;
  const tcl = Math.max(0, Math.round(caTtc * RATES.TCL));

  const lines = [
    { code: 'TVA', label: 'TVA à payer', base: null, amount: tvaAPayer },
    { code: 'RS', label: 'Retenues à la source à reverser', base: null, amount: Math.max(0, current.rs) },
    { code: 'TIMBRE', label: 'Droit de timbre collecté sur les factures de vente', base: null, amount: Math.max(0, salesTaxes.stamp) },
    { code: 'FODEC', label: 'FODEC collecté (1 %)', base: null, amount: Math.max(0, salesTaxes.fodec) },
    { code: 'TCL', label: 'TCL (0,2 % du chiffre d\'affaires TTC)', base: caTtc, amount: tcl },
  ];

  return {
    month,
    deadline: deadline(month),
    tva: {
      collectee: current.collectee,
      deductible: current.deductible,
      creditReporte,
      aPayer: tvaAPayer,
      creditAReporter,
    },
    chiffreAffairesHt: current.caHt,
    chiffreAffairesTtc: caTtc,
    lines,
    total: lines.reduce((a, l) => a + l.amount, 0),
  };
}
