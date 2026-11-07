import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithGemini, GeminiError } from '../src/ai/gemini.js';

const pages = [{ mime: 'image/jpeg', data: Buffer.from('img') }];
const schema = { type: 'object' };

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const r = responses.shift();
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  return calls;
}

const ok = (obj) => ({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] } });

test('envoie image + schéma et lit le JSON', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const calls = stubFetch([ok({ doc_type: 'facture_achat' })]);
  const r = await extractWithGemini('sys', pages, 'texte', schema);
  assert.equal(r.doc_type, 'facture_achat');
  assert.match(calls[0].url, /:generateContent$/);
  assert.equal(calls[0].headers['x-goog-api-key'], 'k');
  assert.equal(calls[0].body.contents[0].parts[0].inline_data.mime_type, 'image/jpeg');
  assert.deepEqual(calls[0].body.generationConfig.responseJsonSchema, schema);
});

test('schéma refusé : nouvel essai avec le schéma dans la consigne', async () => {
  const calls = stubFetch([{ status: 400, body: { error: { message: 'Invalid JSON schema field' } } }, ok({ doc_type: 'autre' })]);
  const r = await extractWithGemini('sys', pages, 'texte', schema);
  assert.equal(r.doc_type, 'autre');
  assert.equal(calls[1].body.generationConfig.responseJsonSchema, undefined);
});

test('quota dépassé : erreur 429', async () => {
  stubFetch([{ status: 429, body: { error: { message: 'Resource exhausted' } } }]);
  await assert.rejects(extractWithGemini('sys', pages, 'texte', schema), (e) => e instanceof GeminiError && e.status === 429);
});
