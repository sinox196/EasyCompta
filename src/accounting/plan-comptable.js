// Extrait du plan comptable tunisien (Système Comptable des Entreprises - NC 01,
// nomenclature des comptes). Seuls les comptes utilisés par la saisie automatique
// sont listés ici. Adaptez ce fichier avec votre expert-comptable si besoin :
// c'est la seule source de vérité pour les numéros de comptes.

export const ACCOUNTS = {
  // Classe 2 - Actifs non courants
  '213': 'Logiciels',
  '223': 'Installations techniques, matériel et outillage industriels',
  '224': 'Matériel de transport',
  '2282': 'Mobilier et matériel de bureau',
  '2283': 'Matériel informatique',

  // Classe 1 - Capitaux propres et passifs non courants
  '161': 'Emprunts',

  // Classe 4 - Comptes de tiers
  '401': 'Fournisseurs d\'exploitation',
  '404': 'Fournisseurs d\'immobilisations',
  '411': 'Clients',
  '421': 'Personnel - rémunérations dues',
  '432': 'Etat, impôts et taxes retenus à la source',
  '436': 'Etat, taxes sur le chiffre d\'affaires (déclaration)',
  '4366': 'Etat, TVA déductible',
  '4367': 'Etat, TVA collectée',
  '4368': 'Etat, autres taxes collectées (FODEC, droit de timbre)',
  '453': 'Sécurité sociale (CNSS)',
  '471': 'Compte d\'attente',

  // Classe 5 - Comptes financiers
  '532': 'Banques',
  '541': 'Caisse',
  '581': 'Virements internes',

  // Classe 6 - Charges
  '601': 'Achats de matières premières',
  '602': 'Achats d\'autres approvisionnements',
  '604': 'Achats d\'études et prestations de services',
  '6061': 'Achats non stockés - fournitures consommables',
  '6062': 'Achats non stockés - eau, électricité, gaz',
  '6063': 'Achats non stockés - carburant',
  '6064': 'Achats non stockés - fournitures de bureau',
  '607': 'Achats de marchandises',
  '611': 'Sous-traitance générale',
  '613': 'Locations',
  '615': 'Entretien et réparations',
  '616': 'Primes d\'assurances',
  '622': 'Rémunérations d\'intermédiaires et honoraires',
  '623': 'Publicité, publications, relations publiques',
  '624': 'Transports de biens et transport collectif du personnel',
  '625': 'Déplacements, missions et réceptions',
  '626': 'Frais postaux et de télécommunications',
  '627': 'Services bancaires et assimilés',
  '64': 'Charges de personnel',
  '651': 'Charges d\'intérêts',
  '66': 'Impôts, taxes et versements assimilés',
  '6581': 'Autres charges ordinaires',

  // Classe 7 - Produits
  '706': 'Prestations de services',
  '707': 'Ventes de marchandises',
  '701': 'Ventes de produits finis',
};

// Catégories de dépenses que l'IA choisit -> compte de charge (ou d'immobilisation).
export const EXPENSE_CATEGORIES = {
  marchandises: { account: '607', label: 'Marchandises destinées à la revente' },
  matieres_premieres: { account: '601', label: 'Matières premières' },
  approvisionnements: { account: '602', label: 'Emballages, pièces, autres approvisionnements stockés' },
  fournitures_consommables: { account: '6061', label: 'Petites fournitures, produits d\'entretien' },
  eau_electricite_gaz: { account: '6062', label: 'Factures STEG, SONEDE, gaz' },
  carburant: { account: '6063', label: 'Carburant' },
  fournitures_bureau: { account: '6064', label: 'Papeterie, fournitures de bureau' },
  sous_traitance: { account: '611', label: 'Sous-traitance' },
  loyer: { account: '613', label: 'Loyer, location de matériel ou de véhicule' },
  entretien_reparation: { account: '615', label: 'Entretien, réparation, maintenance' },
  assurance: { account: '616', label: 'Assurances' },
  honoraires: { account: '622', label: 'Honoraires (avocat, comptable, consultant)' },
  publicite: { account: '623', label: 'Publicité, marketing, cadeaux clients' },
  transport: { account: '624', label: 'Transport de marchandises' },
  deplacement_restaurant: { account: '625', label: 'Déplacements, hôtels, restaurants' },
  telecom_internet: { account: '626', label: 'Téléphone, internet, poste' },
  frais_bancaires: { account: '627', label: 'Frais et commissions bancaires' },
  prestations_services: { account: '604', label: 'Autres prestations de services' },
  impots_taxes: { account: '66', label: 'Impôts et taxes (hors TVA)' },
  immo_informatique: { account: '2283', label: 'Ordinateurs, serveurs, imprimantes (immobilisation)' },
  immo_mobilier_bureau: { account: '2282', label: 'Mobilier, matériel de bureau (immobilisation)' },
  immo_transport: { account: '224', label: 'Véhicules (immobilisation)' },
  immo_materiel: { account: '223', label: 'Machines, outillage industriel (immobilisation)' },
  immo_logiciel: { account: '213', label: 'Logiciels, licences (immobilisation)' },
  autre: { account: '6581', label: 'Autre charge' },
};

// Catégories de mouvements bancaires -> compte de contrepartie.
export const BANK_CATEGORIES = {
  paiement_fournisseur: { account: '401', label: 'Paiement d\'un fournisseur' },
  encaissement_client: { account: '411', label: 'Encaissement d\'un client' },
  frais_bancaires: { account: '627', label: 'Frais, commissions, agios' },
  interets: { account: '651', label: 'Intérêts d\'emprunt ou débiteurs' },
  salaire: { account: '421', label: 'Paiement des salaires' },
  cnss: { account: '453', label: 'Cotisations CNSS' },
  impots_taxes: { account: '436', label: 'Paiement déclaration fiscale (TVA, RS...)' },
  emprunt: { account: '161', label: 'Déblocage ou remboursement d\'emprunt' },
  especes: { account: '541', label: 'Retrait ou versement d\'espèces' },
  virement_interne: { account: '581', label: 'Virement entre comptes de la société' },
  autre: { account: '471', label: 'À classer' },
};

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

export function salesAccount(salesType) {
  if (salesType === 'marchandises') return '707';
  if (salesType === 'produits') return '701';
  return '706';
}
