import Anthropic from '@anthropic-ai/sdk';
import { EXPENSE_CATEGORIES, BANK_CATEGORIES } from '../accounting/plan-comptable.js';
import { extractWithGemini, askGemini, GeminiError, GEMINI_MODEL } from './gemini.js';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium';
const USE_FALLBACKS = process.env.AI_FALLBACKS !== 'off';

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// Fournisseur d'IA : "claude" (API Anthropic) ou "gemini" (Google, quota gratuit).
// Par défaut : Gemini si GEMINI_API_KEY est défini, sinon Claude.
export const PROVIDER = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'claude')).toLowerCase();

export function aiConfigured() {
  if (process.env.AI_MOCK === '1') return true;
  if (PROVIDER === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function aiDescription() {
  if (process.env.AI_MOCK === '1') return 'démo';
  return PROVIDER === 'gemini' ? `gemini:${GEMINI_MODEL}` : `claude:${MODEL}`;
}

const str = { type: 'string' };
const num = { type: 'number' };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

// Schéma d'UN document. Pas de null : les champs absents valent "" ou 0.
export const DOC_SCHEMA = obj({
  pages: { type: 'array', items: { type: 'integer' } },
  doc_type: {
    type: 'string',
    enum: ['facture_achat', 'facture_vente', 'avoir_achat', 'avoir_vente', 'ticket_caisse', 'releve_bancaire', 'autre'],
  },
  confidence: num,
  readable: { type: 'boolean' },
  notes: str,
  invoice: obj({
    number: str,
    date: str,
    due_date: str,
    supplier_name: str,
    supplier_tax_id: str,
    customer_name: str,
    customer_tax_id: str,
    currency: str,
    vat_breakdown: { type: 'array', items: obj({ rate: num, base_ht: num, vat: num }) },
    fodec: num,
    stamp_duty: num,
    total_ht: num,
    total_vat: num,
    total_ttc: num,
    withholding_tax: num,
    paid_in_cash: { type: 'boolean' },
    expense_category: { type: 'string', enum: Object.keys(EXPENSE_CATEGORIES) },
    description: str,
  }),
  bank: obj({
    bank_name: str,
    account_number: str,
    period_start: str,
    period_end: str,
    opening_balance: num,
    closing_balance: num,
    currency: str,
    transactions: {
      type: 'array',
      items: obj({
        date: str,
        label: str,
        amount_out: num,
        amount_in: num,
        category: { type: 'string', enum: Object.keys(BANK_CATEGORIES) },
        counterparty: str,
      }),
    },
  }),
});

// Réponse complète : un envoi peut contenir plusieurs documents (plusieurs factures
// photographiées à la suite, un PDF qui en regroupe plusieurs, deux tickets sur une photo).
export const EXTRACTION_SCHEMA = obj({
  documents: { type: 'array', items: DOC_SCHEMA },
});

// Accepte la réponse en plusieurs documents ou l'ancien format (un seul document).
export function splitExtraction(raw) {
  if (Array.isArray(raw?.documents) && raw.documents.length) return raw.documents;
  if (raw?.doc_type) return [raw];
  return [];
}

function categoryList(categories) {
  return Object.entries(categories)
    .map(([key, c]) => `- ${key} : ${c.label}`)
    .join('\n');
}

const SYSTEM_PROMPT = `Tu es l'assistant de saisie comptable d'un cabinet tunisien. On te donne des pages scannées (souvent photographiées au téléphone) : factures, avoirs, tickets de caisse ou relevés bancaires d'une entreprise tunisienne. Tu en extrais les données exactes ; un programme génère ensuite les écritures comptables à partir de ta réponse.

Un envoi contient UN OU PLUSIEURS documents distincts : plusieurs factures photographiées à la suite, un PDF qui regroupe plusieurs factures, deux tickets sur une même photo. Retourne dans "documents" un élément par document distinct, dans l'ordre, sans en oublier aucun. Les pages d'un même document (page 1/2 et 2/2, même numéro de facture, suite d'un relevé) forment UN seul élément. Pour chaque élément, "pages" liste les numéros des pages (à partir de 1) où il apparaît.

Contexte tunisien :
- Monnaie : dinar tunisien (TND, DT), 3 décimales (millimes). "1.250,000" ou "1 250.000" = 1250 dinars. Ne confonds jamais les séparateurs.
- Taux de TVA usuels : 19 %, 13 %, 7 %, et 0 % (exonéré / suspendu).
- Droit de timbre (timbre fiscal) : petit montant fixe ajouté au TTC des factures (souvent 1,000 DT).
- FODEC : 1 % sur certains produits industriels, ajouté avant la TVA.
- Retenue à la source (RS) : parfois mentionnée sur la facture ou le paiement ; ne la retire pas du TTC.
- Le matricule fiscal ressemble à 1234567/A/M/000.
- Documents en français, arabe ou anglais.

Règles :
- Dates au format AAAA-MM-JJ. Montants en nombres (pas de texte), positifs.
- Pour savoir si c'est un achat ou une vente : la société pour laquelle on travaille est "{{COMPANY}}"{{MF}}. Si elle est le client, c'est un achat ; si elle est l'émetteur, c'est une vente. Si tu ne peux pas trancher, un document reçu est en général un achat.
- vat_breakdown : une ligne par taux de TVA (base HT et montant de TVA). Si la facture n'affiche qu'un total, déduis-le.
- total_ttc = montant net à payer, timbre inclus.
- Un ticket de caisse ou reçu payé comptant : doc_type = ticket_caisse et paid_in_cash = true.
- expense_category (achats uniquement) : choisis parmi :
{{EXPENSE_CATEGORIES}}
  Un bien durable de plus de 500 DT HT (ordinateur, meuble, véhicule, machine) est une immobilisation (catégories immo_*).
- Relevé bancaire : extrais CHAQUE ligne de mouvement, sans en oublier, dans l'ordre. amount_out = sortie d'argent du compte (colonne Débit du relevé), amount_in = entrée d'argent (colonne Crédit). Ignore les lignes de solde ou de report. Pour category, choisis parmi :
{{BANK_CATEGORIES}}
  counterparty = nom du fournisseur / client / organisme si identifiable dans le libellé, sinon "".
- Remplis seulement la partie qui correspond au type (invoice OU bank) ; l'autre reste vide ("" , 0, [] , false, "autre").
- confidence entre 0 et 1 : ta certitude globale sur les montants. readable = false si le document est illisible, flou ou coupé.
- notes : courte remarque utile au comptable (en français), ou "".
- N'invente jamais un montant illisible : mets 0 et signale-le dans notes avec une confidence basse.`;

function buildSystemPrompt(company) {
  return SYSTEM_PROMPT.replace('{{COMPANY}}', company.name)
    .replace('{{MF}}', company.matricule_fiscal ? ` (matricule fiscal ${company.matricule_fiscal})` : '')
    .replace('{{EXPENSE_CATEGORIES}}', categoryList(EXPENSE_CATEGORIES))
    .replace('{{BANK_CATEGORIES}}', categoryList(BANK_CATEGORIES));
}

const HINTS = {
  facture_achat: 'Indication de l\'utilisateur : il s\'agit d\'une facture d\'achat (ou ticket).',
  facture_vente: 'Indication de l\'utilisateur : il s\'agit d\'une facture de vente émise par la société.',
  releve_bancaire: 'Indication de l\'utilisateur : il s\'agit d\'un relevé bancaire.',
};

/**
 * @param {{name: string, matricule_fiscal: string}} company
 * @param {{mime: string, data: Buffer}[]} pages
 * @param {string} typeHint
 */
/** @returns {Promise<object[]>} un élément par document distinct trouvé dans l'envoi */
export async function extractDocument(company, pages, typeHint = 'auto') {
  if (process.env.AI_MOCK === '1') return mockExtraction(typeHint, pages.length);

  const userText = [`Envoi de ${pages.length} page(s), numérotées de 1 à ${pages.length} dans l'ordre. Repère chaque document distinct et extrais ses données selon le schéma.`, HINTS[typeHint] || '']
    .filter(Boolean)
    .join('\n');
  if (PROVIDER === 'gemini') {
    return splitExtraction(await extractWithGemini(buildSystemPrompt(company), pages, userText, EXTRACTION_SCHEMA));
  }

  const content = pages.map((p) =>
    p.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data.toString('base64') } }
  );
  content.push({ type: 'text', text: userText });

  const params = {
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    system: buildSystemPrompt(company),
    messages: [{ role: 'user', content }],
  };
  if (USE_FALLBACKS) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  const message = await getClient().beta.messages.stream(params).finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new PermanentError('L\'IA a refusé de traiter ce document.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new PermanentError('Document trop long : découpez-le en plusieurs envois.');
  }
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Réponse de l\'IA illisible (JSON invalide).');
  }
  return splitExtraction(parsed);
}

// Erreur qu'il ne sert à rien de réessayer.
export class PermanentError extends Error {}

export function isRetryable(err) {
  if (err instanceof PermanentError) return false;
  if (err instanceof GeminiError) return err.status === 429 || err.status >= 500;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err instanceof TypeError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.AuthenticationError) return false;
  if (err instanceof Anthropic.BadRequestError) return false;
  if (err instanceof Anthropic.APIError) return (err.status ?? 500) >= 500;
  return true;
}

// Mode démo (AI_MOCK=1) : réponse factice pour tester sans clé API.
function mockExtraction(typeHint, pageCount = 1) {
  const one = mockOne(typeHint);
  if (typeHint === 'releve_bancaire' || pageCount < 2) return [{ ...one, pages: [1] }];
  // Démo : plusieurs pages = plusieurs factures différentes.
  return Array.from({ length: pageCount }, (_, i) => ({
    ...one,
    pages: [i + 1],
    invoice: { ...one.invoice, number: `${one.invoice.number}-${i + 1}`, total_ht: 1000 + i * 100, total_ttc: 1191 + i * 119,
      total_vat: 190 + i * 19, vat_breakdown: [{ rate: 19, base_ht: 1000 + i * 100, vat: 190 + i * 19 }] },
  }));
}

function mockOne(typeHint) {
  const emptyInvoice = {
    number: '', date: '', due_date: '', supplier_name: '', supplier_tax_id: '', customer_name: '',
    customer_tax_id: '', currency: '', vat_breakdown: [], fodec: 0, stamp_duty: 0, total_ht: 0,
    total_vat: 0, total_ttc: 0, withholding_tax: 0, paid_in_cash: false, expense_category: 'autre', description: '',
  };
  const emptyBank = {
    bank_name: '', account_number: '', period_start: '', period_end: '', opening_balance: 0,
    closing_balance: 0, currency: '', transactions: [],
  };
  if (typeHint === 'releve_bancaire') {
    return {
      doc_type: 'releve_bancaire', confidence: 0.95, readable: true, notes: 'Données de démonstration',
      invoice: emptyInvoice,
      bank: {
        ...emptyBank, bank_name: 'Banque Démo', account_number: '10 000 0000000000000 00', currency: 'TND',
        period_start: '2026-10-01', period_end: '2026-10-31', opening_balance: 5000, closing_balance: 6430.5,
        transactions: [
          { date: '2026-10-03', label: 'VIR RECU CLIENT ALPHA SARL', amount_out: 0, amount_in: 2380, category: 'encaissement_client', counterparty: 'Alpha SARL' },
          { date: '2026-10-10', label: 'CHQ 1234567 STEG', amount_out: 214.5, amount_in: 0, category: 'paiement_fournisseur', counterparty: 'STEG' },
          { date: '2026-10-28', label: 'VIR SALAIRES OCT', amount_out: 700, amount_in: 0, category: 'salaire', counterparty: '' },
          { date: '2026-10-31', label: 'FRAIS TENUE DE COMPTE', amount_out: 35, amount_in: 0, category: 'frais_bancaires', counterparty: '' },
        ],
      },
    };
  }
  const isSale = typeHint === 'facture_vente';
  return {
    doc_type: isSale ? 'facture_vente' : 'facture_achat', confidence: 0.92, readable: true, notes: 'Données de démonstration',
    invoice: {
      ...emptyInvoice,
      number: isSale ? 'FV-2026-041' : 'F-88412',
      date: '2026-10-15',
      supplier_name: isSale ? 'Ma Société' : 'Tunisie Telecom',
      customer_name: isSale ? 'Alpha SARL' : 'Ma Société',
      currency: 'TND',
      vat_breakdown: [{ rate: 19, base_ht: 1000, vat: 190 }],
      stamp_duty: 1,
      total_ht: 1000,
      total_vat: 190,
      total_ttc: 1191,
      expense_category: isSale ? 'autre' : 'telecom_internet',
      description: isSale ? 'Prestation de conseil octobre' : 'Abonnement internet fibre',
    },
    bank: emptyBank,
  };
}

/**
 * Assistant : répond à une question à partir du contexte comptable fourni.
 * @param {string} system
 * @param {{role:'user'|'assistant', content:string}[]} messages
 */
export async function askAI(system, messages) {
  if (process.env.AI_MOCK === '1') {
    return 'Mode démo : l\'assistant répondra ici à partir des chiffres de votre comptabilité.';
  }
  if (PROVIDER === 'gemini') return askGemini(system, messages);
  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system,
    messages,
  });
  if (message.stop_reason === 'refusal') throw new PermanentError('L\'assistant a refusé de répondre.');
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}
