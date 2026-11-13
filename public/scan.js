import { api, esc, badge, toast, compressImage, uploadWithProgress, fmtDateTime, logo } from './common.js';

const root = document.getElementById('root');
const state = { companies: [], companyId: null, type: 'auto', pages: [], sending: false };
let pollTimer = null;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
  return null;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const pair = params.get('pair');
  if (pair) {
    history.replaceState(null, '', '/scan');
    try {
      const res = await api('/pairing/claim', { method: 'POST', body: { token: pair } });
      if (res.company_id) store('ec_scan_company', String(res.company_id));
      toast('Téléphone connecté à votre compte ✓');
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  try {
    await api('/auth/me');
  } catch {
    return renderLogin();
  }
  const { companies } = await api('/companies');
  state.companies = companies;
  const saved = Number(store('ec_scan_company'));
  state.companyId = companies.find((c) => c.id === saved)?.id || companies[0]?.id || null;
  render();
}

function renderLogin(error = '') {
  root.innerHTML = `
    <div class="scan-top">${logo('', true)}</div>
    <div class="alert info">Le plus simple : sur l'ordinateur, ouvrez EasyCompta → <b>Connecter mon téléphone</b> et scannez le QR code avec l'appareil photo.</div>
    <div class="card login-card">
      <h2>Ou connectez-vous</h2>
      <form id="login">
        <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="p">Mot de passe</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
        ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
        <button class="primary" style="width:100%;justify-content:center;min-height:46px">Se connecter</button>
      </form>
    </div>`;
  root.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/login', { method: 'POST', body: { ...Object.fromEntries(new FormData(e.target)), device: 'mobile' } });
      boot();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

const TYPES = [
  ['auto', 'Auto'],
  ['facture_achat', 'Achat / ticket'],
  ['facture_vente', 'Vente'],
  ['releve_bancaire', 'Relevé bancaire'],
];

function render() {
  if (!state.companyId) {
    root.innerHTML = `<div class="card"><h2>Aucune société</h2><p>Créez d'abord une société sur le site EasyCompta.</p><a class="btn primary" href="/#/dossiers">Ouvrir le site</a></div>`;
    return;
  }
  root.innerHTML = `
    <div class="scan-top">
      ${logo('', true)}
      <select id="company" aria-label="Société">${state.companies.map((c) => `<option value="${c.id}" ${c.id === state.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    </div>
    <div class="chips" role="radiogroup" aria-label="Type de document">
      ${TYPES.map(([k, l]) => `<button role="radio" aria-checked="${state.type === k}" class="${state.type === k ? 'active' : ''}" data-type="${k}">${l}</button>`).join('')}
    </div>
    <div style="margin-top:12px">
      <label class="btn shoot" for="camera" style="margin:0">
        <span class="big" aria-hidden="true">📷</span>
        ${state.pages.length ? 'Ajouter une page' : 'Scanner un document'}
        <span class="small" style="font-weight:400">facture, ticket, relevé bancaire…</span>
      </label>
      <input id="camera" type="file" accept="image/*" capture="environment" class="hidden">
      <div class="row" style="margin-top:8px;justify-content:center">
        <label class="btn gallery-btn" for="gallery">🖼 Importer depuis la galerie / PDF</label>
        <input id="gallery" type="file" accept="image/*,application/pdf" multiple class="hidden">
      </div>
    </div>
    <div class="pages" id="pages"></div>
    <p class="small muted" id="hint" style="margin-top:8px"></p>
    <div class="card recent" style="margin-top:16px">
      <h2>Derniers envois</h2>
      <ul id="recent"><li class="muted">Chargement…</li></ul>
      <p class="small muted" style="margin:8px 0 0"><a href="/#/documents">Voir tout sur le site →</a></p>
    </div>
    <div class="sendbar ${state.pages.length ? '' : 'hidden'}" id="sendbar">
      <div class="inner">
        <button id="clear">Annuler</button>
        <button class="primary" id="send">Envoyer (${state.pages.length} page${state.pages.length > 1 ? 's' : ''})</button>
      </div>
      <div class="inner"><div class="progress" style="flex:1"><div id="bar"></div></div></div>
    </div>`;

  root.querySelector('#company').addEventListener('change', (e) => {
    state.companyId = Number(e.target.value);
    store('ec_scan_company', String(state.companyId));
    loadRecent();
  });
  root.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => { state.type = b.dataset.type; render(); }));
  root.querySelector('#camera').addEventListener('change', (e) => addFiles(e.target.files));
  root.querySelector('#gallery').addEventListener('change', (e) => addFiles(e.target.files));
  root.querySelector('#clear').addEventListener('click', () => { state.pages = []; render(); });
  root.querySelector('#send').addEventListener('click', send);
  renderPages();
  loadRecent();
}

function renderPages() {
  const el = root.querySelector('#pages');
  el.innerHTML = state.pages
    .map((p, i) => `<div class="page">${p.url ? `<img src="${p.url}" alt="Page ${i + 1}">` : '<span>📄 PDF</span>'}<span class="n">${i + 1}</span><button data-rm="${i}" aria-label="Retirer la page">✕</button></div>`)
    .join('');
  el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
    const [p] = state.pages.splice(Number(b.dataset.rm), 1);
    if (p.url) URL.revokeObjectURL(p.url);
    render();
  }));
  root.querySelector('#hint').textContent = state.pages.length
    ? 'Plusieurs pages = un seul document. Pour un autre document, envoyez d\'abord celui-ci.'
    : '';
}

async function addFiles(fileList) {
  for (const f of [...fileList]) {
    try {
      const file = await compressImage(f);
      state.pages.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
    } catch (err) {
      toast(`${f.name} : ${err.message}`, 'error');
    }
  }
  render();
}

async function send() {
  if (state.sending || !state.pages.length) return;
  state.sending = true;
  const btn = root.querySelector('#send');
  btn.disabled = true;
  btn.textContent = 'Envoi…';
  const form = new FormData();
  state.pages.forEach((p) => form.append('files', p.file));
  form.append('type_hint', state.type);
  form.append('source', 'mobile');
  // Un PDF est déjà un document complet : on envoie chaque PDF séparément.
  form.append('mode', state.pages.some((p) => p.file.type === 'application/pdf') ? 'separate' : 'single');
  try {
    const res = await uploadWithProgress(`/companies/${state.companyId}/documents`, form, (p) => {
      const bar = root.querySelector('#bar');
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    });
    if (!res.ids?.length) {
      toast('Ce document a déjà été importé : il n\'est pas envoyé une deuxième fois.', 'error');
    } else {
      if (navigator.vibrate) navigator.vibrate(60);
      showSuccess();
      if (res.duplicates?.length) toast(`${res.duplicates.length} fichier(s) déjà importé(s) ignoré(s)`, 'error');
    }
    state.pages.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    state.pages = [];
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.sending = false;
    render();
  }
}

async function loadRecent() {
  clearTimeout(pollTimer);
  const list = root.querySelector('#recent');
  if (!list) return;
  try {
    const { documents } = await api(`/companies/${state.companyId}/documents?limit=10`);
    list.innerHTML = documents.length
      ? documents.map((d) => `<li><span class="t">${esc(d.summary || d.original_name)}<br><span class="small muted">${fmtDateTime(d.created_at)}</span></span>${badge(d.status)}</li>`).join('')
      : '<li class="muted">Rien pour l\'instant. Scannez votre premier document !</li>';
    if (documents.some((d) => d.status === 'pending' || d.status === 'processing')) {
      pollTimer = setTimeout(loadRecent, 4000);
    }
  } catch (err) {
    if (err.status === 401) return renderLogin();
    list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
}

// Confirmation animée après l'envoi.
function showSuccess() {
  const el = document.createElement('div');
  el.className = 'success';
  el.innerHTML = `<div class="box">
    <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r="30" fill="none" stroke="#02a091" stroke-width="5"/>
      <path d="M25 39l9 9 18-19" fill="none" stroke="#02a091" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <h2 style="margin:10px 0 4px">Envoyé !</h2><p class="muted" style="margin:0">L'IA s'occupe de la saisie.</p></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), 1800);
}

boot();
