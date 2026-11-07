// Lecture des documents avec Google Gemini (API REST "generateContent").
// Activé par AI_PROVIDER=gemini et GEMINI_API_KEY (clé gratuite sur aistudio.google.com).

const API = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
// "flash-lite" a le quota gratuit le plus large ; GEMINI_MODEL permet d'en choisir un autre
// (ex. gemini-flash-latest, plus précis mais avec très peu de requêtes gratuites par jour).
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(model, body) {
  const res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw new GeminiError(`Quota Gemini atteint (${msg.slice(0, 160)})`, 429);
    throw new GeminiError(`Gemini : ${msg.slice(0, 300)}`, res.status);
  }
  return data;
}

function responseText(data) {
  const cand = data?.candidates?.[0];
  if (!cand) {
    const reason = data?.promptFeedback?.blockReason;
    throw new GeminiError(reason ? `Document refusé par Gemini (${reason})` : 'Réponse Gemini vide', 400);
  }
  if (cand.finishReason === 'MAX_TOKENS') throw new GeminiError('Document trop long : découpez-le en plusieurs envois.', 400);
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'RECITATION') {
    throw new GeminiError(`Document refusé par Gemini (${cand.finishReason})`, 400);
  }
  return (cand.content?.parts || []).map((p) => p.text || '').join('');
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new GeminiError('Réponse de l\'IA illisible (JSON invalide).', 502);
  }
}

/**
 * @param {string} system
 * @param {{mime: string, data: Buffer}[]} pages
 * @param {string} userText
 * @param {object} schema  JSON Schema imposé à la réponse
 */
export async function extractWithGemini(system, pages, userText, schema) {
  const parts = pages.map((p) => ({ inline_data: { mime_type: p.mime, data: p.data.toString('base64') } }));
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { temperature: 0, maxOutputTokens: 32768, responseMimeType: 'application/json' },
  };

  try {
    const data = await call(GEMINI_MODEL, {
      ...base,
      contents: [{ role: 'user', parts: [...parts, { text: userText }] }],
      generationConfig: { ...base.generationConfig, responseJsonSchema: schema },
    });
    return parseJson(responseText(data));
  } catch (err) {
    // Certains modèles n'acceptent pas le schéma JSON complet : on le donne alors dans la consigne.
    if (!(err instanceof GeminiError) || err.status !== 400 || !/schema/i.test(err.message)) throw err;
  }
  const data = await call(GEMINI_MODEL, {
    ...base,
    contents: [
      {
        role: 'user',
        parts: [
          ...parts,
          { text: `${userText}\nRéponds uniquement avec un objet JSON conforme à ce schéma (tous les champs obligatoires) :\n${JSON.stringify(schema)}` },
        ],
      },
    ],
  });
  return parseJson(responseText(data));
}
