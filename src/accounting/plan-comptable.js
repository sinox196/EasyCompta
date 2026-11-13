// Plan comptable tunisien (Système Comptable des Entreprises) : plan par défaut de
// chaque société, chargé depuis plan-tunisien.json. Chaque société a ensuite son
// propre plan en base (table accounts), qu'elle peut compléter ou importer depuis Excel.
//
// La logique comptable désigne les comptes par leur racine (« 43666 », « 626 »...) ;
// plan-resolve.js les traduit en comptes réels à 8 chiffres du plan de la société.
import fs from 'node:fs';

export const DEFAULT_PLAN = JSON.parse(fs.readFileSync(new URL('./plan-tunisien.json', import.meta.url), 'utf8'));
export const ACCOUNTS = Object.fromEntries(DEFAULT_PLAN.map((a) => [a.code, a.label]));

// Catégories de dépenses que l'IA choisit -> compte de charge (ou d'immobilisation).
export const EXPENSE_CATEGORIES = {
  marchandises: { account: '607', label: 'Marchandises destinées à la revente' },
  matieres_premieres: { account: '601', label: 'Matières premières' },
  approvisionnements: { account: '602', label: 'Emballages, pièces, autres approvisionnements stockés' },
  fournitures_consommables: { account: '606', label: 'Petites fournitures, produits d\'entretien' },
  eau_electricite_gaz: { account: '606', label: 'Factures STEG, SONEDE, gaz' },
  carburant: { account: '606', label: 'Carburant' },
  fournitures_bureau: { account: '606', label: 'Papeterie, fournitures de bureau' },
  sous_traitance: { account: '611', label: 'Sous-traitance' },
  loyer: { account: '613', label: 'Loyer, location de matériel ou de véhicule' },
  entretien_reparation: { account: '615', label: 'Entretien, réparation, maintenance' },
  assurance: { account: '616', label: 'Assurances' },
  honoraires: { account: '622', label: 'Honoraires (avocat, comptable, consultant)' },
  publicite: { account: '623', label: 'Publicité, marketing, cadeaux clients' },
  transport: { account: '624', label: 'Transport de marchandises' },
  deplacement_restaurant: { account: '625', label: 'Déplacements, hôtels, restaurants' },
  telecom_internet: { account: '626', label: 'Téléphone, internet, poste' },
  frais_bancaires: { account: '6278', label: 'Frais et commissions bancaires' },
  prestations_services: { account: '604', label: 'Autres prestations de services' },
  impots_taxes: { account: '6651', label: 'Impôts et taxes (hors TVA)' },
  immo_informatique: { account: '2283', label: 'Ordinateurs, serveurs, imprimantes (immobilisation)' },
  immo_mobilier_bureau: { account: '2282', label: 'Mobilier, matériel de bureau (immobilisation)' },
  immo_transport: { account: '2244', label: 'Véhicules (immobilisation)' },
  immo_materiel: { account: '2234', label: 'Machines, outillage industriel (immobilisation)' },
  immo_logiciel: { account: '213', label: 'Logiciels, licences (immobilisation)' },
  autre: { account: '606', label: 'Autre charge' },
};

// Catégories de mouvements bancaires -> compte de contrepartie.
export const BANK_CATEGORIES = {
  paiement_fournisseur: { account: '401', label: 'Paiement d\'un fournisseur' },
  encaissement_client: { account: '411', label: 'Encaissement d\'un client' },
  frais_bancaires: { account: '6278', label: 'Frais, commissions, agios' },
  interets: { account: '6516', label: 'Intérêts d\'emprunt ou débiteurs' },
  salaire: { account: '425', label: 'Paiement des salaires' },
  cnss: { account: '45311', label: 'Cotisations CNSS' },
  impots_taxes: { account: '43651', label: 'Paiement déclaration fiscale (TVA, RS...)' },
  emprunt: { account: '1621', label: 'Déblocage ou remboursement d\'emprunt' },
  especes: { account: '5411', label: 'Retrait ou versement d\'espèces' },
  virement_interne: { account: '58', label: 'Virement entre comptes de la société' },
  autre: { account: '461', label: 'À classer' },
};

// Amortissement linéaire : compte d'amortissement et taux annuel par compte
// d'immobilisation. Taux usuels, à faire confirmer par l'expert-comptable.
export const DEPRECIATION = {
  '213': { account: '2813', rate: 33.333 },
  '222': { account: '2822', rate: 5 },
  '2225': { account: '28225', rate: 10 },
  '2231': { account: '28231', rate: 15 },
  '2234': { account: '28234', rate: 15 },
  '2235': { account: '28235', rate: 15 },
  '2241': { account: '28241', rate: 20 },
  '2244': { account: '28244', rate: 20 },
  '2281': { account: '28281', rate: 10 },
  '2282': { account: '28282', rate: 10 },
  '2283': { account: '28283', rate: 33.333 },
};

export function depreciationFor(account) {
  for (let i = account.length; i > 0; i--) {
    const d = DEPRECIATION[account.slice(0, i)];
    if (d) return d;
  }
  return { account: `28${account.slice(1, 4)}`, rate: 10 };
}

export const JOURNALS = {
  ACH: 'Journal des achats',
  VTE: 'Journal des ventes',
  BQ: 'Journal de banque',
  CAI: 'Journal de caisse',
  OD: 'Opérations diverses',
};

export const DOC_TYPES = {
  facture_achat: 'Facture d\'achat',
  facture_vente: 'Facture de vente',
  avoir_achat: 'Avoir fournisseur',
  avoir_vente: 'Avoir client',
  ticket_caisse: 'Ticket / reçu payé en espèces',
  releve_bancaire: 'Relevé bancaire',
  autre: 'Autre document',
};

export function accountLabel(account) {
  if (ACCOUNTS[account]) return ACCOUNTS[account];
  // Compte plus détaillé que ceux connus : on remonte au parent le plus proche.
  for (let i = account.length - 1; i > 0; i--) {
    const parent = account.slice(0, i);
    if (ACCOUNTS[parent]) return ACCOUNTS[parent];
  }
  return '';
}

// 705 : études et prestations de services ; 707 : marchandises ; 7011 : produits finis.
export function salesAccount(salesType) {
  if (salesType === 'marchandises') return '707';
  if (salesType === 'produits') return '7011';
  return '705';
}

// Compte de dotation selon la nature de l'immobilisation (incorporelle ou corporelle).
export function dotationAccountFor(assetAccount) {
  return assetAccount.startsWith('21') ? '68111' : '68112';
}

// Anciennes racines (première version d'EasyCompta) -> racines du plan tunisien.
export const LEGACY_ROOTS = {
  '4366': '43666', '4367': '43671', '4368': '43678', '471': '461', '421': '425', '453': '45311', '436': '43651',
  '161': '1621', '627': '6278', '651': '6516', '66': '6654', '6061': '606', '6062': '606', '6063': '606', '6064': '606',
  '6581': '606', '706': '705', '701': '7011', '532': '5321', '541': '5411', '581': '58', '6811': '68112', '223': '2234', '224': '2244',
  '2823': '28234', '2824': '28244',
};
