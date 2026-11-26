import { api, esc, money, fmtDate, fmtDateTime, badge, toast, compressImage, uploadWithProgress, DOC_TYPE_LABELS, STATUS_LABELS as STATUS_TEXT, logo, countUp, downloadCSV, autocomplete } from './common.js';

const root = document.getElementById('root');
const state = { user: null, companies: [], companyId: null, plan: null };
let pollTimer = null;

function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
  return null;
}

const company = () => state.companies.find((c) => c.id === state.companyId);

// --- Démarrage -----------------------------------------------------------------

async function boot() {
  if (location.pathname === '/invite') return renderInvite(new URLSearchParams(location.search).get('token'));
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    await loadCompanies();
    renderShell();
    route();
  } catch {
    renderAuth();
  }
}

async function loadCompanies() {
  const { companies } = await api('/companies');
  state.companies = companies;
  const saved = Number(store('ec_company'));
  state.companyId = companies.find((c) => c.id === saved)?.id || companies[0]?.id || null;
}

// Plan comptable : journaux et types (communs) + comptes de la société courante.
async function loadPlan(force = false) {
  if (!state.plan) state.plan = await api('/plan-comptable');
  if (state.companyId && !isClient() && (force || state.accountsFor !== state.companyId)) {
    const { accounts } = await api(`/companies/${state.companyId}/accounts`);
    state.accountList = accounts;
    state.plan.accounts = Object.fromEntries(accounts.map((a) => [a.code, a.label]));
    state.accountsFor = state.companyId;
    state.tiers = null;
  }
  return state.plan;
}

// Sources des suggestions (dès 2 caractères).
function accountItems(detailOnly = true) {
  return (state.accountList || [])
    .filter((a) => !detailOnly || a.nature !== 'R')
    .map((a) => ({ value: a.code, label: a.label, hint: a.auxiliary ? (a.code.startsWith('411') ? 'client' : 'fournisseur') : a.nature === 'R' ? 'regroupement' : '' }));
}
async function loadTiers() {
  if (!state.tiers && state.companyId) state.tiers = (await api(`/companies/${state.companyId}/tiers`)).tiers;
  return state.tiers || [];
}
function tiersItems() {
  return (state.tiers || []).map((t) => ({ value: '', label: t, hint: 'tiers', fill: t }));
}

// Champs « compte » des éditeurs d'écritures : suggestions + intitulé mis à jour.
function bindAccountAC(scope) {
  scope.querySelectorAll('input[name=account]').forEach((inp) => autocomplete(inp, {
    source: () => accountItems(true),
    onPick: () => {
      const lbl = inp.closest('tr')?.querySelector('.acc-label');
      if (lbl) lbl.textContent = accountLabelOf(inp.value);
      inp.closest('tr')?.querySelector('[name=label]')?.focus();
    },
  }));
}

window.addEventListener('hashchange', () => state.user && route());

// --- Authentification ----------------------------------------------------------

function renderAuth(mode = 'login') {
  document.body.classList.remove('peek-open');
  root.innerHTML = `
  <div class="auth-wrap">
    <section class="auth-hero">
      <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
      ${logo('', true)}
      <h1>Votre comptabilité se fait toute seule.</h1>
      <p class="lead">Scannez vos factures et relevés bancaires avec le téléphone : l'IA les lit et passe les écritures selon le plan comptable tunisien.</p>
      <ul>
        <li><span>📷</span>Scan depuis le téléphone, sans ressaisie</li>
        <li><span>✨</span>Écritures, lettrage et contrôles automatiques</li>
        <li><span>🧾</span>Déclaration mensuelle, bilan et TVA prêts</li>
      </ul>
    </section>
    <div class="auth-side">
    <div class="card auth-card">
      <div style="text-align:center">${logo()}</div>
      <p class="muted" style="text-align:center">Connectez-vous pour accéder à vos dossiers.</p>
      <div class="tabs" role="tablist">
        <button data-mode="login" class="${mode === 'login' ? 'active' : ''}">Connexion</button>
        <button data-mode="register" class="${mode === 'register' ? 'active' : ''}">Créer un compte</button>
      </div>
      <form id="auth-form">
        ${mode === 'register' ? `
          <div class="field"><label for="f-name">Votre nom</label><input id="f-name" name="name" autocomplete="name"></div>
          <div class="field"><label for="f-company">Nom de votre société (ou cabinet)</label><input id="f-company" name="company_name" required></div>` : ''}
        <div class="field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="f-pass">Mot de passe</label><input id="f-pass" name="password" type="password" minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></div>
        <div id="auth-error" class="alert error hidden"></div>
        <button class="primary" style="width:100%;justify-content:center;min-height:46px">${mode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
      </form>
    </div>
    </div>
  </div>`;
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  root.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const errBox = root.querySelector('#auth-error');
    try {
      await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
      boot();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
}

// --- Squelette -----------------------------------------------------------------

// Le client (espace client) ne voit que ses documents ; le cabinet voit tout.
const CLIENT_NAV = [
  ['dashboard', 'Mon espace'],
  ['documents', 'Mes documents'],
  ['telephone', 'Scanner avec mon téléphone'],
  ['aide', 'Comment ça marche ?'],
];
const isClient = () => company()?.role === 'client' || (state.user?.kind === 'client' && !state.companies.some((c) => c.role !== 'client'));
const navItems = () => (isClient() ? CLIENT_NAV : NAV);

const NAV = [
  ['clients', '👥 Mes clients'],
  ['dashboard', 'Tableau de bord'],
  ['documents', 'Documents'],
  ['journal', 'Écritures'],
  ['echeancier', 'Échéancier & lettrage'],
  ['balance', 'Balance & grand livre'],
  ['plan', 'Plan comptable'],
  ['etats', 'Bilan & résultat'],
  ['immobilisations', 'Immobilisations'],
  ['controles', 'Contrôles'],
  ['declaration', 'Déclaration fiscale'],
  ['tva', 'TVA de l\'année'],
  ['telephone', 'Connecter mon téléphone'],
  ['aide', 'Comment ça marche ?'],
];

function renderShell() {
  root.innerHTML = `
  <div class="mobile-bar">
    <button class="ghost" id="menu-btn" aria-label="Menu">☰</button>
    ${logo()}
  </div>
  <div class="top-loader" id="top-loader"></div>
  <div class="layout">
    <aside class="sidebar intro" id="sidebar">
      <a href="#/dashboard" aria-label="Tableau de bord">${logo('', true)}</a>
      <div>
        <label for="company-search">${state.user.kind === 'client' ? 'Ma société' : 'Dossier client'}</label>
        <div class="company-current" id="company-current"></div>
        <input type="search" id="company-search" class="company-search" placeholder="🔍 Rechercher un client…" aria-label="Rechercher un dossier client">
        <button class="peek-btn hidden" id="peek-btn" title="Afficher les documents d'un autre client à côté, sans quitter ce dossier"></button>
      </div>
      <nav class="nav" id="nav"></nav>
      <div class="spacer"></div>
      <div class="small muted">${esc(state.user.email)}</div>
      <button class="ghost small" id="logout">Se déconnecter</button>
    </aside>
    <main class="main" id="main"></main>
  </div>
  <button class="ai-fab hidden" id="ai-fab" aria-label="Assistant IA" title="Assistant IA"><span class="ai-fab-icon">✨</span></button>
  <section class="ai-panel hidden" id="ai-panel" role="dialog" aria-label="Assistant IA"></section>
  <aside class="peek hidden" id="peek" aria-label="Autre dossier affiché à côté"></aside>
  <button class="peek-pill hidden" id="peek-pill" title="Réafficher l'autre dossier à côté"></button>`;
  loadPeekState();
  bindPeekShell();
  root.querySelector('#ai-fab').addEventListener('click', () => {
    root.querySelector('#ai-fab').classList.remove('unread');
    if (isAssistantOpen()) closeAssistant(); else openAssistant();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isAssistantOpen() && !document.querySelector('.modal-backdrop')) closeAssistant(); });
  setTimeout(() => root.querySelector('#sidebar')?.classList.remove('intro'), 1200);
  root.querySelector('#menu-btn').addEventListener('click', () => root.querySelector('#sidebar').classList.toggle('open'));
  root.querySelector('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    try { localStorage.removeItem('ec_peek'); } catch { /* stockage indisponible */ }
    location.hash = '';
    renderAuth();
  });
  // Choix du dossier : 2 lettres (nom, matricule fiscal, activité) et les clients
  // correspondants sont proposés ; au clic sans rien taper, les premiers dossiers.
  autocomplete(root.querySelector('#company-search'), {
    source: () => state.companies.map((c) => ({
      value: '', id: c.id, fill: c.name,
      label: c.name,
      hint: [c.matricule_fiscal, c.role === 'client' ? '' : c.to_review ? `${c.to_review} à vérifier` : '', c.id === state.companyId ? 'dossier ouvert' : ''].filter(Boolean).join(' · '),
      search: `${c.matricule_fiscal || ''} ${c.activity || ''}`,
    })),
    emptyList: 8,
    clearOnPick: true,
    onPick: (it) => switchCompany(it.id),
  });
  renderSidebar();
}

function switchCompany(id) {
  if (!id || id === state.companyId) return;
  state.companyId = id;
  store('ec_company', String(id));
  const page = location.hash.replace(/^#\/?/, '').split('/')[0];
  // Une page de détail (document, compte) n'existe pas dans l'autre dossier.
  if (['documents', 'ledger'].includes(page) && location.hash.split('/').length > 2) location.hash = `#/${page}`;
  else if (page === 'clients' || !page) location.hash = '#/dashboard';
  else route();
  toast(`Dossier ouvert : ${company()?.name || ''}`);
}

function renderSidebar() {
  const cur = root.querySelector('#company-current');
  if (!cur) return;
  updateAiFab();
  syncPeek();
  const c = company();
  cur.innerHTML = c
    ? `<div class="client-avatar sm" aria-hidden="true">${esc(c.name.trim().slice(0, 2).toUpperCase())}</div><div class="cc-text"><b>${esc(c.name)}</b>${c.matricule_fiscal ? `<span>${esc(c.matricule_fiscal)}</span>` : ''}</div>`
    : '<span class="small">Aucun dossier</span>';
  root.querySelector('#company-search').classList.toggle('hidden', state.companies.length < 2);
  const current = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'dashboard';
  const toReview = company()?.to_review || 0;
  root.querySelector('#nav').innerHTML = navItems().map(
    ([id, label], i) =>
      `<a href="#/${id}" style="--i:${i}" class="${current === id ? 'active' : ''}">${label}${id === 'documents' && toReview ? `<span class="count">${toReview}</span>` : ''}</a>`
  ).join('');
}

function main() {
  return root.querySelector('#main');
}

let routeSeq = 0; // incrémenté à chaque changement de page

async function route() {
  routeSeq++;
  clearInterval(pollTimer);
  if (uploadReport && uploadReport.at !== location.hash) uploadReport = null;
  root.querySelector('#sidebar')?.classList.remove('open');
  let [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  // Page d'accueil : « Mes clients » pour un cabinet qui suit plusieurs dossiers.
  if (!page) page = !isClient() && state.companies.filter((c) => c.role !== 'client').length > 1 ? 'clients' : 'dashboard';
  renderSidebar();
  if (!state.companyId && !['clients', 'dossiers', 'aide'].includes(page)) return viewNoCompany();
  if (isClient() && !CLIENT_NAV.some(([id]) => id === page) && page !== 'documents') { location.hash = '#/dashboard'; return; }
  const loader = root.querySelector('#top-loader');
  loader?.classList.add('on');
  const views = { dashboard: viewDashboard, documents: arg ? () => viewDocument(Number(arg)) : viewDocuments, journal: viewJournal, balance: viewBalance, ledger: () => viewLedger(arg), tva: viewTva, declaration: viewDeclaration, assistant: () => { openAssistant(); return viewDashboard(); }, echeancier: viewEcheancier, etats: viewEtats, immobilisations: viewImmobilisations, controles: viewControles, plan: viewPlanComptable, telephone: viewPhone, clients: viewClients, dossiers: viewClients, aide: viewHelp };
  try {
    await (views[page] || viewDashboard)();
  } catch (err) {
    if (err.status === 401) return renderAuth();
    main().innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  } finally {
    loader?.classList.remove('on');
  }
  animatePage();
  window.scrollTo({ top: 0 });
}

// Entrée de page : les blocs apparaissent les uns après les autres, puis les
// rafraîchissements automatiques (documents en cours) se font sans animation.
let enterTimer;
function animatePage() {
  const m = main();
  if (!m) return;
  [...m.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 8)));
  m.classList.remove('page-enter');
  void m.offsetWidth;
  m.classList.add('page-enter');
  countUp(m);
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => m.classList.remove('page-enter'), 1400);
}

function viewNoCompany() {
  main().innerHTML = state.user.kind === 'client'
    ? `<div class="card" style="max-width:560px"><h1>Bienvenue 👋</h1><p>Votre comptable ne vous a pas encore donné accès à un dossier. Demandez-lui un lien d'invitation.</p></div>`
    : `<div class="card" style="max-width:560px">
      <h1>Bienvenue 👋</h1>
      <p>Commencez par ajouter votre premier client (ou votre propre société).</p>
      <a class="btn primary" href="#/clients">Ajouter un client</a>
    </div>`;
}

async function refreshCompanyCounts() {
  const { companies } = await api('/companies');
  state.companies = companies;
  renderSidebar();
}

// --- Tableau de bord -----------------------------------------------------------

async function viewDashboard(seq = routeSeq) {
  if (isClient()) return viewClientHome(seq);
  const c = company();
  const year = new Date().getFullYear();
  const [stats, { documents, ai_ready }, evo, { checks }] = await Promise.all([
    api(`/companies/${c.id}/stats`),
    api(`/companies/${c.id}/documents?limit=8`),
    api(`/companies/${c.id}/evolution?year=${year}`),
    api(`/companies/${c.id}/controles?year=${year}`),
  ]);
  const issues = checks.filter((k) => k.level !== 'ok');
  const d = stats.documents;
  const inQueue = (d.pending || 0) + (d.processing || 0);
  if (seq !== routeSeq) return; // l'utilisateur a changé de page entre-temps
  main().innerHTML = `
    <div class="page-head"><h1>${esc(c.name)}</h1><span class="muted">Exercice ${new Date().getFullYear()}</span></div>
    ${ai_ready ? '' : '<div class="alert warn">L\'IA n\'est pas encore configurée sur le serveur (variable <b>GEMINI_API_KEY</b> ou <b>ANTHROPIC_API_KEY</b>). Les documents restent en attente.</div>'}
    <div class="kpis">
      <div class="card kpi hero"><div class="label">Chiffre d'affaires ${year}</div><div class="value" data-count="${Number(stats.totals.produits)}" data-decimals="3">${money(stats.totals.produits)}</div></div>
      <div class="card kpi hoverable"><div class="label">Charges ${year}</div><div class="value" data-count="${Number(stats.totals.charges)}" data-decimals="3">${money(stats.totals.charges)}</div></div>
      <div class="card kpi hoverable"><div class="label">Banque (mouvements)</div><div class="value" data-count="${Number(stats.totals.banque)}" data-decimals="3">${money(stats.totals.banque)}</div></div>
      <div class="card kpi hoverable"><div class="label">En cours de lecture</div><div class="value" data-count="${inQueue}">${inQueue}</div></div>
      <a class="card kpi" href="#/documents" style="text-decoration:none;color:inherit"><div class="label">À vérifier</div><div class="value" style="color:var(--warn)" data-count="${d.review || 0}">${d.review || 0}</div></a>
      <div class="card kpi hoverable"><div class="label">Comptabilisés</div><div class="value" style="color:var(--ok)" data-count="${d.done || 0}">${d.done || 0}</div></div>
      <a class="card kpi" href="#/echeancier" style="text-decoration:none;color:inherit"><div class="label">Lignes à lettrer</div><div class="value" data-count="${evo.a_lettrer}">${evo.a_lettrer}</div></a>
    </div>
    <div class="dash-grid" style="margin-top:16px;align-items:start">
      <div class="card">
        <div class="row" style="margin-bottom:6px"><h2 style="margin:0">Chiffre d'affaires et charges ${year}</h2><span class="spacer"></span>
          <span class="small"><span class="legend-dot" style="background:var(--teal)"></span>CA <span class="legend-dot" style="background:var(--navy-soft);margin-left:10px"></span>Charges</span></div>
        ${barChart(evo.months)}
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:6px"><h2 style="margin:0">Contrôles automatiques</h2><span class="spacer"></span><a href="#/controles">Détail →</a></div>
        ${issues.length ? `<ul class="checks">${issues.slice(0, 5).map(checkItem).join('')}</ul>` : '<p style="color:var(--ok)">✓ Aucune anomalie détectée.</p>'}
        ${evo.dernier_releve ? '' : '<p class="small muted">Aucun relevé bancaire scanné pour l\'instant.</p>'}
      </div>
    </div>
    <div class="dash-grid" style="margin-top:16px">
      <div class="stack">
        ${uploadCard()}
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Derniers documents</h2><span class="spacer"></span><a href="#/documents">Tout voir →</a></div>
          ${documentsTable(documents)}
        </div>
      </div>
      <div class="card">
        <h2>📱 Scanner avec le téléphone</h2>
        <p class="muted small">Scannez ce QR code avec l'appareil photo du téléphone : il s'ouvre directement sur l'application de scan, connecté à ${esc(c.name)}.</p>
        <div id="qr-slot" class="qr-box"><span class="muted small">Génération…</span></div>
        <p class="small muted" style="margin-top:8px">Astuce : sur le téléphone, « Ajouter à l'écran d'accueil » pour l'avoir comme une application.</p>
      </div>
    </div>`;
  bindUpload(() => viewDashboard());
  bindDocRows();
  generateQr(main().querySelector('#qr-slot'));
  if (inQueue) startPolling(viewDashboard, 4000);
  else stopPolling();
}

// Rafraîchissement automatique pendant que l'IA lit des documents. Une seule
// minuterie à la fois (startPolling), jamais deux rafraîchissements en même temps,
// et un rafraîchissement lancé avant un changement de page n'écrit rien.
let refreshing = false;
function startPolling(view, ms) {
  clearInterval(pollTimer);
  const seq = routeSeq;
  pollTimer = setInterval(() => {
    if (seq !== routeSeq) return clearInterval(pollTimer);
    softRefresh(view, seq);
  }, ms);
}
function stopPolling() {
  clearInterval(pollTimer);
}
async function softRefresh(view, seq) {
  if (document.hidden || refreshing) return;
  refreshing = true;
  const y = window.scrollY;
  try {
    await view(seq);
  } catch {
    // Erreur réseau passagère : on réessaiera au prochain passage.
  } finally {
    refreshing = false;
  }
  if (seq !== routeSeq) return;
  window.scrollTo(0, y);
  refreshCompanyCounts().catch(() => {});
}

function uploadCard() {
  return `
  <div class="card">
    <h2>Ajouter des documents</h2>
    <div class="dropzone" id="dropzone">
      <div class="drop-icon" aria-hidden="true">📄</div>
      <p><b>Glissez vos factures, tickets ou relevés bancaires ici</b> — autant que vous voulez en une fois<br><span class="muted small">PDF, JPG, PNG. L'IA les lit et passe les écritures automatiquement.</span></p>
      <div class="row" style="justify-content:center">
        <select id="upload-mode" style="width:auto" aria-label="Regroupement des fichiers">
          <option value="separate">Chaque fichier = un document</option>
          <option value="single">Tous les fichiers = un seul document (plusieurs pages)</option>
        </select>
        <select id="type-hint" style="width:auto">
          <option value="auto">Type : détection automatique</option>
          <option value="facture_achat">Factures d'achat / tickets</option>
          <option value="facture_vente">Factures de vente</option>
          <option value="releve_bancaire">Relevés bancaires</option>
        </select>
        <label class="btn primary" style="margin:0;color:#fff">Choisir des fichiers<input type="file" id="file-input" multiple accept="image/*,application/pdf" class="hidden"></label>
      </div>
      <div id="upload-status" class="small muted" style="margin-top:8px">${esc(uploadReport?.status || '')}</div>
      <div class="progress hidden" id="upload-progress"><div></div></div>
      <ul class="upload-list" id="upload-list">${uploadReport?.list || ''}</ul>
    </div>
  </div>`;
}

// Résultat du dernier envoi, conservé quand la page se rafraîchit (documents en cours).
let uploadReport = null;

function bindUpload(after) {
  const seq = routeSeq;
  const zone = main().querySelector('#dropzone');
  const input = main().querySelector('#file-input');
  const status = main().querySelector('#upload-status');
  const list = main().querySelector('#upload-list');
  const bar = main().querySelector('#upload-progress');
  const BATCH = 8; // fichiers par envoi : de gros lots passent aussi sur une connexion lente
  const send = async (fileList) => {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (!files.length) return;
    const mode = main().querySelector('#upload-mode').value;
    const typeHint = main().querySelector('#type-hint').value;
    // En mode « un seul document », tout part dans un seul envoi.
    const batches = mode === 'single' ? [files] : Array.from({ length: Math.ceil(files.length / BATCH) }, (_, i) => files.slice(i * BATCH, (i + 1) * BATCH));
    list.innerHTML = files.map((f, i) => `<li data-f="${i}"><span class="t">${esc(f.name)}</span><span class="badge pending">En attente</span></li>`).join('');
    bar.classList.remove('hidden');
    let done = 0, sent = 0, dups = 0, failed = 0;
    const mark = (i, cls, label) => { const li = list.querySelector(`[data-f="${i}"] .badge`); if (li) { li.className = `badge ${cls}`; li.textContent = label; } };
    for (const batch of batches) {
      const first = files.indexOf(batch[0]);
      status.textContent = `Préparation des fichiers ${first + 1} à ${first + batch.length} sur ${files.length}…`;
      const form = new FormData();
      for (const f of batch) form.append('files', await compressImage(f));
      form.append('type_hint', typeHint);
      form.append('mode', mode);
      batch.forEach((_, j) => mark(first + j, 'processing', 'Envoi…'));
      try {
        const res = await uploadWithProgress(`/companies/${state.companyId}/documents`, form, (p) => {
          bar.firstElementChild.style.width = `${Math.round(((done + p * batch.length) / files.length) * 100)}%`;
        });
        // Un résultat par document, dans l'ordre : un par fichier, ou un seul en mode « un document ».
        batch.forEach((f, j) => {
          const r = res.results?.[mode === 'single' ? 0 : j];
          if (r?.duplicate) mark(first + j, 'duplicate', 'Déjà importé');
          else mark(first + j, 'done', 'Envoyé');
        });
        dups += (res.results || []).filter((r) => r.duplicate).length;
        sent += res.ids.length;
      } catch (err) {
        failed += batch.length;
        batch.forEach((_, j) => mark(first + j, 'error', err.message.slice(0, 60)));
      }
      done += batch.length;
      bar.firstElementChild.style.width = `${Math.round((done / files.length) * 100)}%`;
    }
    status.textContent = `${sent} document(s) envoyé(s)${dups ? `, ${dups} déjà importé(s)` : ''}${failed ? `, ${failed} fichier(s) en erreur` : ''}.`;
    uploadReport = { status: status.textContent, list: list.innerHTML, at: location.hash };
    if (sent) toast(`${sent} document(s) envoyé(s). L'IA s'en occupe.`);
    else if (dups && !failed) toast('Ces documents ont déjà été importés.', 'error');
    input.value = '';
    setTimeout(() => { if (seq === routeSeq) after(); }, 1200);
  };
  input.addEventListener('change', () => send(input.files));
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => send(e.dataTransfer.files));
}

async function generateQr(slot, onPaired) {
  try {
    const { qr, url, token } = await api('/pairing', { method: 'POST', body: { company_id: state.companyId } });
    slot.innerHTML = qr;
    slot.title = url;
    if (onPaired) {
      const t = setInterval(async () => {
        if (!document.body.contains(slot)) return clearInterval(t);
        const s = await api(`/pairing/${token}`).catch(() => null);
        if (s?.used) { clearInterval(t); onPaired(); }
        if (s?.expired) { clearInterval(t); slot.innerHTML = '<button id="qr-renew">QR expiré — générer un nouveau</button>'; slot.querySelector('#qr-renew').onclick = () => generateQr(slot, onPaired); }
      }, 3000);
    }
    return url;
  } catch (err) {
    slot.innerHTML = `<span class="small">${esc(err.message)}</span>`;
    return null;
  }
}

// --- Documents -----------------------------------------------------------------

function documentsTable(documents) {
  if (!documents.length) return '<p class="muted">Aucun document pour l\'instant.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Reçu le</th><th>Document</th><th>Type</th><th>Statut</th></tr></thead>
    <tbody>${documents.map((d) => `
      <tr class="clickable" data-doc="${d.id}">
        <td class="small">${fmtDateTime(d.created_at)}<br><span class="muted">${d.source === 'mobile' ? '📱 téléphone' : '💻 web'}</span></td>
        <td>${esc(d.summary || d.original_name)}${d.error ? (d.status === 'pending'
          ? `<div class="small muted">⏳ Nouvel essai automatique dans quelques minutes (${esc(d.error)})</div>`
          : `<div class="small" style="color:var(--danger)">${esc(d.error)}</div>`) : ''}</td>
        <td class="small">${esc(DOC_TYPE_LABELS[d.doc_type] || (d.status === 'pending' || d.status === 'processing' ? '…' : ''))}</td>
        <td>${badge(d.status)}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

function bindDocRows() {
  main().querySelectorAll('[data-doc]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/documents/${tr.dataset.doc}`)));
}

let docFilter = '';
async function viewDocuments(seq = routeSeq) {
  const c = company();
  const { documents } = await api(`/companies/${c.id}/documents?limit=300${docFilter ? `&status=${docFilter}` : ''}`);
  const filters = [['', 'Tous'], ['review', 'À vérifier'], ['pending', 'En attente'], ['processing', 'En cours'], ['done', 'Comptabilisés'], ['duplicate', 'Doublons'], ['error', 'Erreurs']];
  if (seq !== routeSeq) return;
  main().innerHTML = `
    <div class="page-head"><h1>Documents</h1><span class="spacer"></span><button id="docs-export">⬇ Exporter la liste</button></div>
    ${uploadCard()}
    <div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:10px">${filters.map(([v, l]) => `<button class="${docFilter === v ? 'primary' : ''}" data-filter="${v}">${l}</button>`).join('')}
        ${!isClient() && documents.some((d) => d.status === 'error') ? '<span class="spacer"></span><button id="retry-errors">↻ Relancer les documents en erreur</button>' : ''}</div>
      ${documentsTable(documents)}
    </div>`;
  main().querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { docFilter = b.dataset.filter; viewDocuments(); }));
  bindUpload(() => viewDocuments());
  bindDocRows();
  main().querySelector('#docs-export').addEventListener('click', () => {
    downloadCSV(`documents-${c.name}`, ['N°', 'Reçu le', 'Source', 'Type', 'Document', 'Statut', 'Erreur'],
      documents.map((d) => [d.id, fmtDateTime(d.created_at), d.source === 'mobile' ? 'Téléphone' : 'Web', DOC_TYPE_LABELS[d.doc_type] || '', d.summary || d.original_name, STATUS_TEXT[d.status] || d.status, d.error || '']));
  });
  main().querySelector('#retry-errors')?.addEventListener('click', async () => {
    const { count } = await api(`/companies/${c.id}/documents/retry-errors`, { method: 'POST' });
    toast(`${count} document(s) renvoyé(s) à l'IA`);
    viewDocuments();
  });
  if (documents.some((d) => d.status === 'pending' || d.status === 'processing')) {
    startPolling(viewDocuments, 4000);
  } else {
    stopPolling();
  }
}

async function viewDocument(id) {
  const data = await api(`/documents/${id}`);
  if (data.role === 'client') return viewClientDocument(data);
  const [{ document: doc, pages, entries }, plan] = [data, await loadPlan()];
  const notes = (doc.warnings || []).filter((w) => w.startsWith('Note IA'));
  const warnings = (doc.warnings || []).filter((w) => !w.startsWith('Note IA'));
  const preview = pages
    .map((p) => (p.mime === 'application/pdf'
      ? `<iframe src="/api/documents/${doc.id}/pages/${p.page_no}" title="Page ${p.page_no}"></iframe>`
      : `<a href="/api/documents/${doc.id}/pages/${p.page_no}" target="_blank"><img src="/api/documents/${doc.id}/pages/${p.page_no}" alt="Page ${p.page_no}" loading="lazy"></a>`))
    .join('');

  main().innerHTML = `
    <div class="page-head">
      <a href="#/documents" class="btn">← Documents</a>
      <h1>${esc(doc.summary || doc.original_name)}</h1>
      ${badge(doc.status)}
      <span class="spacer"></span>
      <button id="compare-side" title="Garder ce document ouvert et afficher un autre document (de ce client ou d'un autre) à côté">⧉ Comparer à côté</button>
    </div>
    <div class="doc-grid">
      <div class="card preview">${preview}</div>
      <div>
        ${doc.status === 'pending' || doc.status === 'processing' ? '<div class="alert info">L\'IA lit ce document… la page se met à jour toute seule.</div>' : ''}
        ${doc.status === 'duplicate' ? `<div class="alert warn"><b>Document déjà importé.</b> Il n'a pas été comptabilisé une deuxième fois.
          <div class="row" style="margin-top:8px">${doc.duplicate_of ? `<a class="btn small" href="#/documents/${doc.duplicate_of}">Voir l'original (n° ${doc.duplicate_of})</a>` : ''}
          <button class="small" id="not-duplicate">Ce n'est pas un doublon : comptabiliser</button></div></div>` : ''}
        ${doc.error ? `<div class="alert ${doc.status === 'pending' ? 'info' : 'error'}">${doc.status === 'pending' ? '⏳ Nouvel essai automatique dans quelques minutes : ' : ''}${esc(doc.error)}</div>` : ''}
        ${notes.map((n) => `<div class="alert info">${esc(n)}</div>`).join('')}
        ${warnings.length ? `<div class="alert warn"><b>Points à vérifier</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
        ${doc.extracted ? `<div class="card" style="margin-bottom:14px">
          <h2>Ce que l'IA a lu</h2>
          ${extractedDetails(doc.extracted)}
        </div>` : ''}
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">Écritures générées (${entries.length})</h2><span class="spacer"></span>
          ${entries.some((e) => e.status === 'draft') ? '<button class="primary" id="validate-all">✓ Tout valider</button>' : ''}
        </div>
        <div id="entries">${entries.map(entryEditor).join('')}</div>
        <div class="card" style="margin-top:14px">
          <h3>Le document a été mal lu ?</h3>
          <div class="row">
            <select id="reprocess-type" style="width:auto">
              <option value="auto">Détection automatique</option>
              <option value="facture_achat">C'est une facture d'achat</option>
              <option value="facture_vente">C'est une facture de vente</option>
              <option value="releve_bancaire">C'est un relevé bancaire</option>
            </select>
            <button id="reprocess">↻ Relancer l'IA</button>
            <span class="spacer"></span>
            <button class="danger" id="delete-doc">Supprimer le document</button>
          </div>
        </div>
      </div>
    </div>`;

  main().querySelectorAll('.entry-card').forEach(bindEntryEditor);
  main().querySelector('#compare-side').addEventListener('click', () => openPeek());
  main().querySelector('#validate-all')?.addEventListener('click', async () => {
    await api(`/documents/${doc.id}/validate`, { method: 'POST' });
    toast('Écritures validées');
    refreshCompanyCounts();
    viewDocument(id);
  });
  main().querySelector('#not-duplicate')?.addEventListener('click', async () => {
    await api(`/documents/${doc.id}/not-duplicate`, { method: 'POST' });
    toast('Le document va être comptabilisé');
    viewDocument(id);
  });
  main().querySelector('#reprocess').addEventListener('click', async () => {
    await api(`/documents/${doc.id}/reprocess`, { method: 'POST', body: { type_hint: main().querySelector('#reprocess-type').value } });
    toast('Document renvoyé à l\'IA');
    viewDocument(id);
  });
  main().querySelector('#delete-doc').addEventListener('click', async () => {
    if (!confirm('Supprimer ce document et ses écritures ?')) return;
    await api(`/documents/${doc.id}`, { method: 'DELETE' });
    refreshCompanyCounts();
    location.hash = '#/documents';
  });
  if (doc.status === 'pending' || doc.status === 'processing') {
    clearInterval(pollTimer);
    const seq = routeSeq;
    pollTimer = setInterval(async () => {
      if (seq !== routeSeq) return clearInterval(pollTimer);
      const r = await api(`/documents/${id}`).catch(() => null);
      if (!r || seq !== routeSeq) return;
      if (r.document.status !== 'pending' && r.document.status !== 'processing') { clearInterval(pollTimer); viewDocument(id); refreshCompanyCounts(); }
    }, 3000);
  }
}

// Résumé de ce que l'IA a lu (page du document et panneau « à côté »).
function extractedDetails(x = {}) {
  const inv = x.invoice || {};
  const isBank = x.doc_type === 'releve_bancaire';
  return `<dl class="kv">
    <dt>Type</dt><dd>${esc(DOC_TYPE_LABELS[x.doc_type] || x.doc_type)}</dd>
    ${isBank ? `
      <dt>Banque</dt><dd>${esc(x.bank?.bank_name)} ${esc(x.bank?.account_number)}</dd>
      <dt>Période</dt><dd>${fmtDate(x.bank?.period_start)} → ${fmtDate(x.bank?.period_end)}</dd>
      <dt>Solde initial / final</dt><dd class="mono">${money(x.bank?.opening_balance)} / ${money(x.bank?.closing_balance)}</dd>
      <dt>Mouvements</dt><dd>${x.bank?.transactions?.length || 0}</dd>` : `
      <dt>Fournisseur</dt><dd>${esc(inv.supplier_name)} <span class="muted small">${esc(inv.supplier_tax_id)}</span></dd>
      <dt>Client</dt><dd>${esc(inv.customer_name)} <span class="muted small">${esc(inv.customer_tax_id)}</span></dd>
      <dt>N° / date</dt><dd>${esc(inv.number)} — ${fmtDate(inv.date)}</dd>
      <dt>HT / TVA / TTC</dt><dd class="mono">${money(inv.total_ht)} / ${money(inv.total_vat)} / ${money(inv.total_ttc)}</dd>
      ${inv.stamp_duty ? `<dt>Timbre</dt><dd class="mono">${money(inv.stamp_duty)}</dd>` : ''}
      ${inv.fodec ? `<dt>FODEC</dt><dd class="mono">${money(inv.fodec)}</dd>` : ''}
      ${inv.withholding_tax ? `<dt>Retenue à la source</dt><dd class="mono">${money(inv.withholding_tax)}</dd>` : ''}
      <dt>Objet</dt><dd>${esc(inv.description)}</dd>`}
    <dt>Confiance IA</dt><dd>${Math.round((x.confidence || 0) * 100)} %</dd>
  </dl>`;
}

// --- Écran partagé : un autre dossier ouvert à côté ------------------------------
// Le dossier de travail reste à gauche. Le panneau de droite affiche, en lecture
// seule, les documents d'un autre client (ou un autre document du même client).
// Il reste ouvert quand on change de page et après un rechargement. Sur grand
// écran les deux côtés sont visibles en même temps ; sur un petit écran le
// panneau passe par-dessus et se réduit en une pastille.

const PEEK_STATUS = [['', 'Tous'], ['review', 'À vérifier'], ['done', 'Comptabilisés'], ['pending', 'En attente'], ['duplicate', 'Doublons'], ['error', 'Erreurs']];
const SIDEBAR_W = 260;
const peek = { mode: 'closed', companyId: null, docId: null, status: '', q: '', zoom: 1, width: 0, recent: [], docs: null, docsFor: null };
let peekSeq = 0;

function loadPeekState() {
  try {
    const saved = JSON.parse(store('ec_peek') || '{}');
    for (const k of ['mode', 'companyId', 'docId', 'status', 'zoom', 'width', 'recent']) if (saved[k] !== undefined) peek[k] = saved[k];
  } catch { /* état illisible : valeurs par défaut */ }
  const ids = new Set(state.companies.map((c) => c.id));
  if (!ids.has(peek.companyId)) { peek.companyId = null; peek.docId = null; }
  peek.recent = (Array.isArray(peek.recent) ? peek.recent : []).filter((id) => ids.has(id));
  if (!['open', 'min'].includes(peek.mode)) peek.mode = 'closed';
  peek.docs = null;
  peek.docsFor = null;
  peek.q = '';
}

function savePeek() {
  const { mode, companyId, docId, status, zoom, width, recent } = peek;
  store('ec_peek', JSON.stringify({ mode, companyId, docId, status, zoom, width, recent }));
}

const peekAvailable = () => Boolean(state.user && !isClient() && state.companies.some((c) => c.role !== 'client'));
const peekCompany = () => state.companies.find((c) => c.id === peek.companyId);
const initials = (name) => esc(String(name || '').trim().slice(0, 2).toUpperCase());

// Largeur du panneau : réglable à la souris, sans jamais écraser le dossier de travail.
function peekWidth() {
  const avail = window.innerWidth - SIDEBAR_W;
  const w = peek.width || Math.round(avail * 0.45);
  return Math.max(340, Math.min(w, avail - 420));
}

function setPeekCompany(id) {
  if (id !== peek.companyId) {
    peek.docs = null;
    peek.docsFor = null;
    peek.status = '';
    peek.q = '';
    peek.docId = null;
  }
  peek.companyId = id;
  if (id) peek.recent = [id, ...peek.recent.filter((r) => r !== id)].slice(0, 5);
}

function openPeek({ companyId, docId } = {}) {
  if (!peekAvailable()) return;
  if (companyId !== undefined) setPeekCompany(companyId);
  if (docId !== undefined) peek.docId = docId;
  peek.mode = 'open';
  savePeek();
  syncPeek();
  renderPeek().then(() => document.querySelector('#peek #peek-q')?.focus({ preventScroll: true }));
}

function minimizePeek() {
  peek.mode = 'min';
  savePeek();
  syncPeek();
}

function closePeek() {
  peek.mode = 'closed';
  peek.companyId = null;
  peek.docId = null;
  peek.docs = null;
  peek.docsFor = null;
  savePeek();
  syncPeek();
}

// Met la page en deux colonnes (ou non) et tient à jour le bouton et la pastille.
function syncPeek() {
  const panel = document.getElementById('peek');
  if (!panel) return;
  const ok = peekAvailable();
  const open = ok && peek.mode === 'open';
  document.body.classList.toggle('peek-open', open);
  panel.classList.toggle('hidden', !open);
  document.documentElement.style.setProperty('--peek-w', `${peekWidth()}px`);
  const c = peekCompany();
  const pill = document.getElementById('peek-pill');
  pill.classList.toggle('hidden', !(ok && peek.mode === 'min'));
  pill.innerHTML = `<span class="peek-pill-icon" aria-hidden="true">⧉</span><span class="peek-pill-text">${c ? esc(c.name) : 'Autre dossier'}</span>`;
  const btn = document.getElementById('peek-btn');
  btn.classList.toggle('hidden', !ok);
  btn.classList.toggle('active', open);
  btn.innerHTML = open
    ? '<span aria-hidden="true">⧉</span> Fermer l\'écran partagé'
    : peek.mode === 'min' && c ? `<span aria-hidden="true">⧉</span> Réafficher ${esc(c.name)}` : '<span aria-hidden="true">⧉</span> Voir un autre dossier à côté';
}

function bindPeekShell() {
  document.getElementById('peek-btn').addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    if (peek.mode === 'open') closePeek();
    else openPeek();
  });
  document.getElementById('peek-pill').addEventListener('click', () => openPeek());
  if (!window.__peekResize) {
    window.__peekResize = true;
    window.addEventListener('resize', () => document.documentElement.style.setProperty('--peek-w', `${peekWidth()}px`));
  }
  syncPeek();
  if (peek.mode === 'open') renderPeek();
}

// Le bandeau du panneau (nom du client, échanger, réduire, fermer) est le même
// sur les trois écrans : choix du client, liste des documents, document.
function peekHeader() {
  const c = peekCompany();
  const same = c && c.id === state.companyId;
  return `
    <div class="peek-resize" title="Glisser pour élargir ou réduire · double-clic : moitié-moitié" aria-hidden="true"></div>
    <header class="peek-head">
      ${c ? `<button class="peek-who" data-peek="clients" title="Changer de client">
        <span class="client-avatar sm peek-avatar" aria-hidden="true">${initials(c.name)}</span>
        <span class="peek-who-text"><span class="peek-kicker">À côté · lecture seule${same ? ' · même dossier' : ''}</span><b>${esc(c.name)}</b></span>
        <span class="peek-caret" aria-hidden="true">▾</span>
      </button>` : '<div class="peek-who static"><span class="peek-who-text"><span class="peek-kicker">Écran partagé</span><b>Choisir un dossier</b></span></div>'}
      ${c && !same ? '<button class="ghost small" data-peek="swap" title="Travailler sur ce dossier : les deux côtés s\'échangent">⇄<span class="peek-lbl"> Échanger</span></button>' : ''}
      <button class="ghost small" data-peek="min" title="Réduire (le panneau reste disponible en bas de l'écran)" aria-label="Réduire">–</button>
      <button class="ghost small" data-peek="close" title="Fermer l'écran partagé" aria-label="Fermer">✕</button>
    </header>`;
}

async function renderPeek() {
  const panel = document.getElementById('peek');
  if (!panel || peek.mode !== 'open') return;
  const seq = ++peekSeq;
  const c = peekCompany();
  let body;
  try {
    if (!c) body = peekChooser();
    else if (peek.docId) body = await peekDocument(seq);
    else body = await peekList(seq);
  } catch (err) {
    if (err.status === 404 && peek.docId) { peek.docId = null; savePeek(); return renderPeek(); }
    body = `<div class="peek-body"><div class="alert error">${esc(err.message)}</div><button class="small" data-peek="list">← Retour à la liste</button></div>`;
  }
  if (body === null || seq !== peekSeq) return;
  panel.innerHTML = peekHeader() + body;
  bindPeek(panel);
}

// 1. Choix du client : les dossiers consultés récemment, puis tous les dossiers.
function peekChooser() {
  return `<div class="peek-body">
    <p class="peek-intro">Le dossier <b>${esc(company()?.name || '')}</b> reste ouvert à gauche. Choisissez ce que vous voulez voir à côté :</p>
    <input type="search" id="peek-q" class="peek-search" placeholder="🔍 Rechercher un client (nom, matricule, activité)…" aria-label="Rechercher un client" autocomplete="off">
    <div id="peek-clients" class="peek-clients">${peekClientItems('')}</div>
  </div>`;
}

function peekClientItems(q) {
  const f = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const match = (c) => !f || [c.name, c.matricule_fiscal, c.activity].join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(f);
  const item = (c) => `<button class="peek-client ${c.id === state.companyId ? 'current' : ''}" data-pc="${c.id}">
      <span class="client-avatar sm" aria-hidden="true">${initials(c.name)}</span>
      <span class="peek-client-text"><b>${esc(c.name)}</b><span>${[c.matricule_fiscal, `${c.documents || 0} document(s)`, c.to_review ? `${c.to_review} à vérifier` : ''].filter(Boolean).map(esc).join(' · ')}</span></span>
      ${c.id === state.companyId ? '<span class="peek-tag">ouvert à gauche</span>' : ''}
    </button>`;
  const all = state.companies.filter(match);
  const recent = f ? [] : peek.recent.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  const rest = all.filter((c) => !recent.includes(c));
  if (!all.length) return '<p class="muted small">Aucun dossier ne correspond.</p>';
  return `${recent.length ? `<div class="peek-section">Consultés récemment</div>${recent.map(item).join('')}` : ''}
    ${rest.length ? `${recent.length ? '<div class="peek-section">Tous les dossiers</div>' : ''}${rest.map(item).join('')}` : ''}`;
}

async function loadPeekDocs(seq) {
  if (peek.docs && peek.docsFor === peek.companyId) return peek.docs;
  const id = peek.companyId;
  const { documents } = await api(`/companies/${id}/documents?limit=500`);
  if (seq !== undefined && seq !== peekSeq) return null;
  peek.docs = documents;
  peek.docsFor = id;
  return documents;
}

function peekFiltered() {
  const words = peek.q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
  return (peek.docs || []).filter((d) => {
    if (peek.status && !(d.status === peek.status || (peek.status === 'pending' && d.status === 'processing'))) return false;
    if (!words.length) return true;
    const text = [d.summary, d.original_name, DOC_TYPE_LABELS[d.doc_type], fmtDate(d.created_at), d.id].join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return words.every((w) => text.includes(w));
  });
}

// 2. Liste des documents du client, avec recherche et filtres.
async function peekList(seq) {
  const docs = await loadPeekDocs(seq);
  if (!docs) return null;
  const count = (s) => (s ? docs.filter((d) => d.status === s || (s === 'pending' && d.status === 'processing')).length : docs.length);
  return `<div class="peek-body">
    <div class="peek-filters">
      <input type="search" id="peek-dq" class="peek-search" placeholder="🔍 Fournisseur, client, n°, date…" value="${esc(peek.q)}" aria-label="Rechercher un document" autocomplete="off">
      <button class="ghost small" data-peek="refresh" title="Actualiser la liste" aria-label="Actualiser">↻</button>
    </div>
    <div class="chip-filter peek-chips">${PEEK_STATUS.filter(([s]) => !s || count(s)).map(([s, l]) => `<button class="small ${peek.status === s ? 'active' : ''}" data-ps="${s}">${l} <span class="peek-n">${count(s)}</span></button>`).join('')}</div>
    <div id="peek-docs" class="peek-docs">${peekDocItems()}</div>
  </div>`;
}

function peekDocItems() {
  const list = peekFiltered();
  if (!peek.docs?.length) return '<p class="muted small">Ce dossier ne contient encore aucun document.</p>';
  if (!list.length) return '<p class="muted small">Aucun document ne correspond à la recherche.</p>';
  return list.map((d) => `<button class="peek-doc" data-pd="${d.id}">
      <span class="peek-doc-text"><b>${esc(d.summary || d.original_name)}</b>
      <span>${esc(DOC_TYPE_LABELS[d.doc_type] || '')}${d.doc_type ? ' · ' : ''}reçu le ${fmtDate(d.created_at)}${d.page_count > 1 ? ` · ${d.page_count} pages` : ''}</span></span>
      ${badge(d.status)}
    </button>`).join('');
}

// 3. Un document : les pages (avec zoom), ce que l'IA a lu et les écritures.
async function peekDocument(seq) {
  const [data] = await Promise.all([api(`/documents/${peek.docId}`), loadPeekDocs(seq).catch(() => null)]);
  if (seq !== peekSeq) return null;
  const { document: doc, pages, entries } = data;
  if (doc.company_id !== peek.companyId) { setPeekCompany(doc.company_id); peek.docId = doc.id; }
  const list = peekFiltered();
  let i = list.findIndex((d) => d.id === doc.id);
  const nav = i >= 0 ? list : peek.docs || [];
  if (i < 0) i = nav.findIndex((d) => d.id === doc.id);
  const prev = i > 0 ? nav[i - 1] : null;
  const next = i >= 0 && i < nav.length - 1 ? nav[i + 1] : null;
  const src = (p) => `/api/documents/${doc.id}/pages/${p.page_no}`;
  const pagesHtml = pages.map((p) => (p.mime === 'application/pdf'
    ? `<iframe src="${src(p)}" title="Page ${p.page_no}"></iframe>`
    : `<img src="${src(p)}" alt="Page ${p.page_no}" loading="lazy" data-zoomable title="Cliquer pour zoomer">`)).join('');
  const entriesHtml = entries.map((e) => {
    const d = e.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const c = e.lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    return `<div class="peek-entry">
      <div class="peek-entry-head"><span class="mono">${esc(e.journal)}</span><span>${fmtDate(e.entry_date)}</span><span class="peek-entry-label">${esc(e.label)}</span>${badge(e.status)}</div>
      <div class="table-wrap"><table class="peek-table">
        <thead><tr><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th></tr></thead>
        <tbody>${e.lines.map((l) => `<tr><td class="mono">${esc(l.account)}</td><td>${esc(l.label)}${l.account_label ? `<div class="small muted">${esc(l.account_label)}</div>` : ''}</td>
          <td class="num">${Number(l.debit) ? money(l.debit) : ''}</td><td class="num">${Number(l.credit) ? money(l.credit) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td></td><td></td><td class="num">${money(d)}</td><td class="num">${money(c)}</td></tr></tfoot>
      </table></div>
    </div>`;
  }).join('');
  const warnings = (doc.warnings || []).filter((w) => !w.startsWith('Note IA'));
  return `<div class="peek-body peek-doc-view ${peek.zoom > 1 ? 'zoomed' : ''}" style="--zoom:${peek.zoom}">
    <div class="peek-toolbar">
      <button class="small" data-peek="list" title="Revenir à la liste des documents">← Documents</button>
      <span class="spacer"></span>
      <button class="ghost small" data-pd="${prev?.id || ''}" ${prev ? '' : 'disabled'} title="Document précédent" aria-label="Document précédent">‹</button>
      ${i >= 0 ? `<span class="small muted peek-pos">${i + 1} / ${nav.length}</span>` : ''}
      <button class="ghost small" data-pd="${next?.id || ''}" ${next ? '' : 'disabled'} title="Document suivant" aria-label="Document suivant">›</button>
    </div>
    <div class="peek-doc-title"><h3>${esc(doc.summary || doc.original_name)}</h3>${badge(doc.status)}</div>
    ${pages.length ? `<div class="peek-zoom">
      <button class="ghost small" data-zoom="-1" aria-label="Dézoomer" ${peek.zoom <= 1 ? 'disabled' : ''}>－</button>
      <span class="small muted">${Math.round(peek.zoom * 100)} %</span>
      <button class="ghost small" data-zoom="1" aria-label="Zoomer" ${peek.zoom >= 3 ? 'disabled' : ''}>＋</button>
      <span class="spacer"></span>
      <a class="small" href="${src(pages[0])}" target="_blank" rel="noopener">Ouvrir dans un onglet ↗</a>
    </div>
    <div class="peek-pages">${pagesHtml}</div>` : ''}
    ${warnings.length ? `<div class="alert warn small"><b>Points à vérifier</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${doc.extracted ? `<details class="peek-details" open><summary>Ce que l'IA a lu</summary>${extractedDetails(doc.extracted)}</details>` : ''}
    ${entries.length ? `<details class="peek-details" open><summary>Écritures (${entries.length})</summary>${entriesHtml}</details>` : ''}
    ${doc.company_id !== state.companyId
      ? '<button class="peek-edit" data-peek="swap">✎ Modifier ce document : l\'ouvrir à gauche <span class="muted small">(les deux côtés s\'échangent)</span></button>'
      : `<a class="btn peek-edit" href="#/documents/${doc.id}">✎ Ouvrir ce document à gauche pour le modifier</a>`}
  </div>`;
}

// « Échanger » : le dossier de droite devient le dossier de travail et celui de
// gauche passe à droite (avec le document qui y était ouvert).
function swapPeek() {
  const c = peekCompany();
  if (!c) return;
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const leftDoc = page === 'documents' && arg ? Number(arg) : null;
  const leftCompany = state.companyId;
  const target = peek.docId ? `#/documents/${peek.docId}` : '#/documents';
  state.companyId = c.id;
  store('ec_company', String(c.id));
  setPeekCompany(state.companies.some((x) => x.id === leftCompany) ? leftCompany : null);
  peek.docId = leftDoc;
  savePeek();
  if (location.hash === target) route(); else location.hash = target;
  renderPeek();
  toast(`Vous travaillez maintenant sur ${c.name}`);
}

function bindPeek(panel) {
  panel.querySelectorAll('[data-peek]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.peek;
    if (a === 'close') closePeek();
    else if (a === 'min') minimizePeek();
    else if (a === 'swap') swapPeek();
    else if (a === 'clients') { setPeekCompany(null); savePeek(); renderPeek().then(() => panel.querySelector('#peek-q')?.focus()); }
    else if (a === 'list') { peek.docId = null; savePeek(); renderPeek(); }
    else if (a === 'refresh') { peek.docs = null; renderPeek(); }
  }));
  const pickClient = (id) => { setPeekCompany(id); savePeek(); syncPeek(); renderPeek(); };
  const bindClients = () => panel.querySelectorAll('[data-pc]').forEach((b) => b.addEventListener('click', () => pickClient(Number(b.dataset.pc))));
  bindClients();
  const q = panel.querySelector('#peek-q');
  q?.addEventListener('input', () => { panel.querySelector('#peek-clients').innerHTML = peekClientItems(q.value); bindClients(); });
  q?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const first = panel.querySelector('[data-pc]'); if (first) pickClient(Number(first.dataset.pc)); }
  });
  const bindDocs = () => panel.querySelectorAll('[data-pd]').forEach((b) => b.addEventListener('click', () => {
    if (!b.dataset.pd) return;
    peek.docId = Number(b.dataset.pd);
    savePeek();
    renderPeek().then(() => panel.querySelector('.peek-body')?.scrollTo({ top: 0 }));
  }));
  bindDocs();
  const dq = panel.querySelector('#peek-dq');
  dq?.addEventListener('input', () => { peek.q = dq.value; panel.querySelector('#peek-docs').innerHTML = peekDocItems(); bindDocs(); });
  dq?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); panel.querySelector('#peek-docs [data-pd]')?.click(); }
  });
  panel.querySelectorAll('[data-ps]').forEach((b) => b.addEventListener('click', () => { peek.status = b.dataset.ps; savePeek(); renderPeek(); }));
  const setZoom = (z) => {
    peek.zoom = Math.max(1, Math.min(3, z));
    savePeek();
    const view = panel.querySelector('.peek-doc-view');
    view?.style.setProperty('--zoom', peek.zoom);
    view?.classList.toggle('zoomed', peek.zoom > 1);
    const label = panel.querySelector('.peek-zoom .muted');
    if (label) label.textContent = `${Math.round(peek.zoom * 100)} %`;
    panel.querySelector('[data-zoom="-1"]')?.toggleAttribute('disabled', peek.zoom <= 1);
    panel.querySelector('[data-zoom="1"]')?.toggleAttribute('disabled', peek.zoom >= 3);
  };
  panel.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => setZoom(peek.zoom + Number(b.dataset.zoom) * 0.5)));
  panel.querySelectorAll('[data-zoomable]').forEach((img) => img.addEventListener('click', () => setZoom(peek.zoom > 1 ? 1 : 2)));
  // Poignée de redimensionnement (bord gauche du panneau).
  const handle = panel.querySelector('.peek-resize');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('peek-resizing');
    const move = (ev) => {
      peek.width = window.innerWidth - ev.clientX;
      document.documentElement.style.setProperty('--peek-w', `${peekWidth()}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('peek-resizing');
      peek.width = peekWidth();
      savePeek();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    peek.width = Math.round((window.innerWidth - SIDEBAR_W) / 2);
    document.documentElement.style.setProperty('--peek-w', `${peekWidth()}px`);
    savePeek();
  });
}

function entryEditor(e) {
  const journals = state.plan.journals;
  const lineRow = (l = {}) => `
    <tr>
      <td style="width:110px"><input class="mono" name="account" value="${esc(l.account)}" aria-label="Compte"></td>
      <td><input name="label" value="${esc(l.label)}" aria-label="Libellé"><div class="small muted acc-label">${esc(l.account_label)}</div></td>
      <td style="width:120px"><input class="num" name="debit" inputmode="decimal" value="${Number(l.debit) ? Number(l.debit).toFixed(3) : ''}" aria-label="Débit"></td>
      <td style="width:120px"><input class="num" name="credit" inputmode="decimal" value="${Number(l.credit) ? Number(l.credit).toFixed(3) : ''}" aria-label="Crédit"></td>
      <td style="width:36px"><button class="ghost small" data-remove title="Supprimer la ligne">✕</button></td>
    </tr>`;
  return `
  <div class="entry-card" data-entry="${e.id}">
    <div class="head">
      <select name="journal" style="width:auto">${Object.entries(journals).map(([k, l]) => `<option value="${k}" ${k === e.journal ? 'selected' : ''} title="${esc(l)}">${k}</option>`).join('')}</select>
      <input type="date" name="entry_date" value="${esc(e.entry_date)}">
      <input name="label" value="${esc(e.label)}" style="flex:1;min-width:160px" aria-label="Libellé de l'écriture">
      ${badge(e.status)}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th><th></th></tr></thead>
      <tbody>${e.lines.map(lineRow).join('')}</tbody>
      <tfoot><tr><td></td><td class="balance-msg"></td><td class="num tot-d"></td><td class="num tot-c"></td><td></td></tr></tfoot>
    </table></div>
    <template class="row-tpl">${lineRow()}</template>
    <div class="foot">
      <button class="ghost" data-add>+ Ligne</button><span class="spacer"></span>
      <button class="danger ghost" data-del-entry>Supprimer</button>
      <button class="primary" data-save>Enregistrer et valider</button>
    </div>
  </div>`;
}

function bindEntryEditor(card) {
  const id = card.dataset.entry;
  const recompute = () => {
    let d = 0, c = 0;
    card.querySelectorAll('tbody tr').forEach((tr) => {
      d += Math.round(parseFloat((tr.querySelector('[name=debit]').value || '0').replace(',', '.')) * 1000) || 0;
      c += Math.round(parseFloat((tr.querySelector('[name=credit]').value || '0').replace(',', '.')) * 1000) || 0;
    });
    card.querySelector('.tot-d').textContent = money(d / 1000);
    card.querySelector('.tot-c').textContent = money(c / 1000);
    const msg = card.querySelector('.balance-msg');
    msg.textContent = d === c ? '✓ Équilibrée' : `Écart : ${money((d - c) / 1000)}`;
    msg.style.color = d === c ? 'var(--ok)' : 'var(--danger)';
  };
  const bindRow = (tr) => {
    tr.querySelector('[data-remove]').addEventListener('click', () => { tr.remove(); recompute(); });
    tr.querySelectorAll('input').forEach((i) => i.addEventListener('input', recompute));
    bindAccountAC(tr);
    tr.querySelector('[name=account]').addEventListener('change', (ev) => {
      tr.querySelector('.acc-label').textContent = accountLabelOf(ev.target.value);
    });
  };
  card.querySelectorAll('tbody tr').forEach(bindRow);
  card.querySelector('[data-add]').addEventListener('click', () => {
    const tbody = card.querySelector('tbody');
    tbody.insertAdjacentHTML('beforeend', card.querySelector('.row-tpl').innerHTML);
    bindRow(tbody.lastElementChild);
  });
  card.querySelector('[data-del-entry]').addEventListener('click', async () => {
    if (!confirm('Supprimer cette écriture ?')) return;
    await api(`/entries/${id}`, { method: 'DELETE' });
    card.remove();
  });
  card.querySelector('[data-save]').addEventListener('click', async () => {
    const lines = [...card.querySelectorAll('tbody tr')].map((tr) => ({
      account: tr.querySelector('[name=account]').value,
      label: tr.querySelector('[name=label]').value,
      account_label: tr.querySelector('.acc-label').textContent,
      debit: tr.querySelector('[name=debit]').value.replace(',', '.'),
      credit: tr.querySelector('[name=credit]').value.replace(',', '.'),
    }));
    try {
      await api(`/entries/${id}`, {
        method: 'PUT',
        body: {
          journal: card.querySelector('[name=journal]').value,
          entry_date: card.querySelector('[name=entry_date]').value,
          label: card.querySelector('.head [name=label]').value,
          lines,
          validate: true,
        },
      });
      toast('Écriture enregistrée. Le compte choisi sera retenu pour ce tiers.');
      card.querySelector('.head .badge').outerHTML = badge('validated');
      refreshCompanyCounts();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  recompute();
}

function accountLabelOf(account) {
  const accounts = state.plan?.accounts || {};
  const code = String(account || '');
  for (let i = code.length; i > 0; i--) if (accounts[code.slice(0, i)]) return accounts[code.slice(0, i)];
  return '';
}

// --- Écritures (journal) -------------------------------------------------------

// Par défaut : toutes les dates (une facture de l'année précédente doit apparaître).
const period = { from: '', to: '', journal: '', preset: 'all' };

function presetRange(preset) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  switch (preset) {
    case 'year': return [`${y}-01-01`, `${y}-12-31`];
    case 'last-year': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case 'month': return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case 'last-month': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    default: return ['', ''];
  }
}
const PRESETS = [['all', 'Toutes les dates'], ['year', 'Cette année'], ['last-year', 'L\'année dernière'], ['month', 'Ce mois'], ['last-month', 'Mois dernier'], ['custom', 'Personnalisée']];

const periodSlug = () => (period.from || period.to ? `${period.from || 'debut'}-${period.to || 'fin'}` : 'toutes-dates');

function periodForm(withJournal) {
  return `<div class="row">
    <div><label for="p-preset">Période</label><select id="p-preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${period.preset === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div><label for="p-from">Du</label><input type="date" id="p-from" value="${period.from}"></div>
    <div><label for="p-to">Au</label><input type="date" id="p-to" value="${period.to}"></div>
    ${withJournal ? `<div><label for="p-journal">Journal</label><select id="p-journal"><option value="">Tous</option>${Object.entries(state.plan.journals).map(([k, l]) => `<option value="${k}" ${period.journal === k ? 'selected' : ''}>${k} — ${esc(l)}</option>`).join('')}</select></div>` : ''}
  </div>`;
}

function bindPeriod(view) {
  main().querySelector('#p-preset')?.addEventListener('change', (e) => {
    period.preset = e.target.value;
    if (period.preset !== 'custom') [period.from, period.to] = presetRange(period.preset);
    view();
  });
  ['p-from', 'p-to', 'p-journal'].forEach((id) => main().querySelector(`#${id}`)?.addEventListener('change', (e) => {
    period[{ 'p-from': 'from', 'p-to': 'to', 'p-journal': 'journal' }[id]] = e.target.value;
    if (id !== 'p-journal') period.preset = period.from || period.to ? 'custom' : 'all';
    view();
  }));
}

// Rien sur la période choisie mais des écritures ailleurs : on le dit, avec un bouton.
function otherPeriodsHint(total, shown, view) {
  if (shown || !total) return '';
  return `<div class="alert info no-print">Aucune écriture sur cette période, mais ${total} écriture(s) existent à d'autres dates.
    <button class="small" style="margin-left:8px" data-all-dates>Afficher toutes les dates</button></div>`;
}
function bindOtherPeriods(view) {
  main().querySelector('[data-all-dates]')?.addEventListener('click', () => {
    Object.assign(period, { from: '', to: '', preset: 'all', journal: '' });
    journalSearch = '';
    view();
  });
}

async function viewJournal() {
  await loadPlan();
  const c = company();
  const qs = `from=${period.from}&to=${period.to}${period.journal ? `&journal=${period.journal}` : ''}`;
  const { entries, total_all: totalAll } = await api(`/companies/${c.id}/entries?${qs}`);
  const q = (journalSearch || '').toLowerCase();
  const shown = q
    ? entries.filter((e) => [e.label, e.piece_ref, ...e.lines.flatMap((l) => [l.account, l.label, l.third_party])].join(' ').toLowerCase().includes(q))
    : entries;
  let td = 0, tc = 0;
  const rows = shown.map((e) => {
    const lines = e.lines.map((l) => {
      td += Number(l.debit); tc += Number(l.credit);
      return `<tr><td></td><td class="mono">${esc(l.account)}</td><td>${esc(l.label)}<div class="small muted">${esc(l.account_label)}${l.third_party ? ` · ${esc(l.third_party)}` : ''}</div></td><td class="num">${Number(l.debit) ? money(l.debit) : ''}</td><td class="num">${Number(l.credit) ? money(l.credit) : ''}</td></tr>`;
    }).join('');
    return `<tr class="entry-head"><td>${fmtDate(e.entry_date)}</td><td>${e.journal}</td><td>${esc(e.label)}${e.piece_ref ? ` <span class="muted small">· ${esc(e.piece_ref)}</span>` : ''} ${e.document_id ? `<a href="#/documents/${e.document_id}" class="small">pièce</a>` : '<span class="small muted">· saisie manuelle</span>'}</td>
      <td colspan="2" style="text-align:right">${badge(e.status)} <button class="ghost small" data-edit="${e.id}" title="Modifier">✎ Modifier</button></td></tr>${lines}`;
  }).join('');
  main().innerHTML = `
    <div class="page-head"><h1>Écritures comptables</h1><span class="spacer"></span>
      <button class="primary" id="new-entry">＋ Nouvelle écriture</button>
      <a class="btn" href="/api/companies/${c.id}/export.csv?${qs}">⬇ Exporter (Excel)</a></div>
    <div class="card" style="margin-bottom:14px"><div class="filters">${periodForm(true)}
      <div><label for="j-search">Rechercher</label><input type="search" id="j-search" placeholder="Libellé, compte, tiers, pièce…" value="${esc(journalSearch)}"></div></div></div>
    ${otherPeriodsHint(totalAll, shown.length, viewJournal)}
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">Aucune écriture${journalSearch ? ` pour « ${esc(journalSearch)} »` : ''} sur la période.</td></tr>`}</tbody>
      <tfoot><tr><td colspan="3">Total (${shown.length} écritures)</td><td class="num">${money(td)}</td><td class="num">${money(tc)}</td></tr></tfoot>
    </table></div></div>`;
  bindPeriod(viewJournal);
  bindOtherPeriods(viewJournal);
  const search = main().querySelector('#j-search');
  await loadTiers();
  autocomplete(search, { source: () => [...accountItems(false), ...tiersItems()] });
  search.addEventListener('change', () => { journalSearch = search.value; viewJournal(); });
  main().querySelector('#new-entry').addEventListener('click', () => openEntryModal(null, viewJournal));
  main().querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    openEntryModal(entries.find((e) => e.id === Number(b.dataset.edit)), viewJournal);
  }));
}
let journalSearch = '';

// Saisie manuelle (ou modification) d'une écriture, dans une fenêtre.
function openEntryModal(entry, onSaved) {
  const isNew = !entry;
  const e = entry || {
    journal: 'OD', entry_date: new Date().toISOString().slice(0, 10), label: '', piece_ref: '', status: 'draft',
    lines: [{ account: '', label: '', debit: '', credit: '' }, { account: '', label: '', debit: '', credit: '' }],
  };
  const journals = state.plan.journals;
  const lineRow = (l = {}) => `
    <tr>
      <td style="width:120px"><input class="mono" name="account" value="${esc(l.account)}" placeholder="ex. 626" aria-label="Compte"></td>
      <td><input name="label" value="${esc(l.label)}" placeholder="Libellé" aria-label="Libellé"><div class="small muted acc-label">${esc(l.account_label || accountLabelOf(l.account || ''))}</div></td>
      <td style="width:150px"><input name="third_party" value="${esc(l.third_party)}" placeholder="Tiers" aria-label="Tiers"></td>
      <td style="width:120px"><input class="num" name="debit" inputmode="decimal" value="${Number(l.debit) ? Number(l.debit).toFixed(3) : ''}" aria-label="Débit"></td>
      <td style="width:120px"><input class="num" name="credit" inputmode="decimal" value="${Number(l.credit) ? Number(l.credit).toFixed(3) : ''}" aria-label="Crédit"></td>
      <td style="width:36px"><button type="button" class="ghost small" data-remove title="Supprimer la ligne">✕</button></td>
    </tr>`;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${isNew ? 'Nouvelle écriture' : 'Modifier l\'écriture'}">
      <header><h2>${isNew ? 'Nouvelle écriture' : 'Modifier l\'écriture'}</h2><span class="spacer"></span><button class="ghost" data-close aria-label="Fermer">✕</button></header>
      <div class="entry-card">
        <div class="head">
          <select name="journal" aria-label="Journal">${Object.entries(journals).map(([k, l]) => `<option value="${k}" ${k === e.journal ? 'selected' : ''}>${k} — ${esc(l)}</option>`).join('')}</select>
          <input type="date" name="entry_date" value="${esc(e.entry_date)}" aria-label="Date">
          <input name="piece_ref" value="${esc(e.piece_ref)}" placeholder="N° pièce" style="width:130px" aria-label="Numéro de pièce">
          <input name="label" value="${esc(e.label)}" placeholder="Libellé de l'écriture" style="flex:1;min-width:180px" aria-label="Libellé de l'écriture">
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Compte</th><th>Libellé</th><th>Tiers</th><th class="num">Débit</th><th class="num">Crédit</th><th></th></tr></thead>
          <tbody>${e.lines.map(lineRow).join('')}</tbody>
          <tfoot><tr><td></td><td class="balance-msg" colspan="2"></td><td class="num tot-d"></td><td class="num tot-c"></td><td></td></tr></tfoot>
        </table></div>
        <div class="foot">
          <button type="button" class="ghost" data-add>＋ Ligne</button>
          <button type="button" class="ghost" data-balance title="Mettre l'écart sur la dernière ligne">⇄ Équilibrer</button>
          <span class="spacer"></span>
          ${isNew ? '' : '<button type="button" class="danger ghost" data-delete>Supprimer</button>'}
          <button type="button" data-close>Annuler</button>
          <button type="button" class="primary" data-save>${isNew ? 'Enregistrer l\'écriture' : 'Enregistrer'}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const tbody = wrap.querySelector('tbody');
  const parse = (v) => Math.round(parseFloat(String(v || '0').replace(/\s/g, '').replace(',', '.')) * 1000) || 0;
  const totals = () => {
    let d = 0, c = 0;
    tbody.querySelectorAll('tr').forEach((tr) => { d += parse(tr.querySelector('[name=debit]').value); c += parse(tr.querySelector('[name=credit]').value); });
    return { d, c };
  };
  const recompute = () => {
    const { d, c } = totals();
    wrap.querySelector('.tot-d').textContent = money(d / 1000);
    wrap.querySelector('.tot-c').textContent = money(c / 1000);
    const msg = wrap.querySelector('.balance-msg');
    msg.textContent = d === c && d > 0 ? '✓ Équilibrée' : `Écart : ${money((d - c) / 1000)}`;
    msg.style.color = d === c && d > 0 ? 'var(--ok)' : 'var(--danger)';
  };
  const bindRow = (tr) => {
    tr.querySelector('[data-remove]').addEventListener('click', () => { tr.remove(); recompute(); });
    tr.querySelectorAll('input').forEach((i) => i.addEventListener('input', recompute));
    bindAccountAC(tr);
    tr.querySelector('[name=account]').addEventListener('input', (ev) => { tr.querySelector('.acc-label').textContent = accountLabelOf(ev.target.value); });
  };
  tbody.querySelectorAll('tr').forEach(bindRow);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  wrap.querySelector('[data-add]').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', lineRow());
    bindRow(tbody.lastElementChild);
    tbody.lastElementChild.querySelector('[name=account]').focus();
  });
  wrap.querySelector('[data-balance]').addEventListener('click', () => {
    const { d, c } = totals();
    const last = [...tbody.querySelectorAll('tr')].pop();
    if (!last || d === c) return;
    const field = d > c ? 'credit' : 'debit';
    const input = last.querySelector(`[name=${field}]`);
    input.value = ((parse(input.value) + Math.abs(d - c)) / 1000).toFixed(3);
    recompute();
  });
  wrap.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!confirm('Supprimer cette écriture ?')) return;
    await api(`/entries/${e.id}`, { method: 'DELETE' });
    toast('Écriture supprimée');
    close();
    onSaved?.();
  });
  wrap.querySelector('[data-save]').addEventListener('click', async () => {
    const lines = [...tbody.querySelectorAll('tr')].map((tr) => ({
      account: tr.querySelector('[name=account]').value.trim(),
      label: tr.querySelector('[name=label]').value,
      third_party: tr.querySelector('[name=third_party]').value,
      account_label: tr.querySelector('.acc-label').textContent,
      debit: tr.querySelector('[name=debit]').value.replace(',', '.'),
      credit: tr.querySelector('[name=credit]').value.replace(',', '.'),
    })).filter((l) => l.account || Number(l.debit) || Number(l.credit));
    const body = {
      journal: wrap.querySelector('[name=journal]').value,
      entry_date: wrap.querySelector('[name=entry_date]').value,
      piece_ref: wrap.querySelector('.head [name=piece_ref]').value,
      label: wrap.querySelector('.head [name=label]').value,
      lines,
      validate: true,
    };
    try {
      if (isNew) await api(`/companies/${state.companyId}/entries`, { method: 'POST', body });
      else await api(`/entries/${e.id}`, { method: 'PUT', body });
      toast(isNew ? 'Écriture enregistrée' : 'Écriture modifiée');
      close();
      onSaved?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  recompute();
  wrap.querySelector(isNew ? '.head [name=label]' : '[data-save]').focus();
}

// --- Balance & grand livre -----------------------------------------------------

const balanceFilter = { account: '', label: '', cls: '' };
async function viewBalance() {
  await loadPlan();
  const c = company();
  const { accounts } = await api(`/companies/${c.id}/balance?from=${period.from}&to=${period.to}`);
  const all = accounts.map((a) => ({ ...a, label: accountLabelOf(a.account) || a.account_label || '' }));
  const render = () => {
    const f = balanceFilter;
    const list = all.filter((a) => (!f.cls || a.account.startsWith(f.cls))
      && (!f.account || a.account.startsWith(f.account.trim()))
      && (!f.label || a.label.toLowerCase().includes(f.label.toLowerCase())));
    let td = 0, tc = 0, sd = 0, sc = 0;
    const rows = list.map((a) => {
      const d = Number(a.debit), cr = Number(a.credit);
      td += d; tc += cr;
      const solde = d - cr;
      if (solde > 0) sd += solde; else sc -= solde;
      return `<tr class="clickable" data-acc="${esc(a.account)}"><td class="mono">${esc(a.account)}</td><td>${esc(a.label)}</td><td class="num">${money(d)}</td><td class="num">${money(cr)}</td><td class="num">${solde > 0 ? money(solde) : ''}</td><td class="num">${solde < 0 ? money(-solde) : ''}</td></tr>`;
    }).join('');
    main().querySelector('#bal-body').innerHTML = rows || '<tr><td colspan="6" class="muted">Aucun compte ne correspond.</td></tr>';
    main().querySelector('#bal-foot').innerHTML = `<tr><td colspan="2">Total (${list.length} comptes)</td><td class="num">${money(td)}</td><td class="num">${money(tc)}</td><td class="num">${money(sd)}</td><td class="num">${money(sc)}</td></tr>`;
    main().querySelectorAll('[data-acc]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/ledger/${tr.dataset.acc}`)));
    main().querySelectorAll('[data-cls]').forEach((b) => b.classList.toggle('active', b.dataset.cls === f.cls));
    return list;
  };
  const classes = [['', 'Toutes'], ['1', '1 Capitaux'], ['2', '2 Immobilisations'], ['3', '3 Stocks'], ['4', '4 Tiers'], ['5', '5 Trésorerie'], ['6', '6 Charges'], ['7', '7 Produits']];
  const balanced = Math.round(all.reduce((s, a) => s + Number(a.debit) - Number(a.credit), 0) * 1000) === 0;
  main().innerHTML = `
    <div class="page-head"><h1>Balance générale</h1>${all.length ? `<span class="badge ${balanced ? 'done' : 'error'}">${balanced ? 'équilibrée' : 'déséquilibrée'}</span>` : ''}
      <span class="spacer"></span><a class="btn" href="#/ledger">Grand livre complet</a><button id="bal-export">⬇ Exporter (Excel)</button></div>
    <div class="card" style="margin-bottom:14px">
      <div class="filters">${periodForm(false)}
        <div><label for="f-acc">Compte</label><input id="f-acc" class="mono" placeholder="ex. 401" value="${esc(balanceFilter.account)}" inputmode="numeric"></div>
        <div><label for="f-lab">Intitulé</label><input type="search" id="f-lab" placeholder="ex. fournisseurs" value="${esc(balanceFilter.label)}"></div>
      </div>
      <div class="chip-filter" style="margin-top:12px">${classes.map(([k, l]) => `<button class="small" data-cls="${k}">${l}</button>`).join('')}</div>
      <p class="small muted" style="margin:10px 0 0">Cliquez sur un compte pour voir son grand livre (le détail des mouvements).</p>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Compte</th><th>Intitulé</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde débiteur</th><th class="num">Solde créditeur</th></tr></thead>
      <tbody id="bal-body"></tbody><tfoot id="bal-foot"></tfoot>
    </table></div></div>`;
  bindPeriod(viewBalance);
  let shown = render();
  main().querySelector('#f-acc').addEventListener('input', (ev) => { balanceFilter.account = ev.target.value; shown = render(); });
  main().querySelector('#f-lab').addEventListener('input', (ev) => { balanceFilter.label = ev.target.value; shown = render(); });
  autocomplete(main().querySelector('#f-acc'), { source: () => accountItems(false) });
  autocomplete(main().querySelector('#f-lab'), { source: () => accountItems(false), fill: 'label' });
  main().querySelectorAll('[data-cls]').forEach((b) => b.addEventListener('click', () => { balanceFilter.cls = b.dataset.cls; shown = render(); }));
  main().querySelector('#bal-export').addEventListener('click', () => {
    downloadCSV(`balance-${c.name}-${periodSlug()}`, ['Compte', 'Intitulé', 'Débit', 'Crédit', 'Solde débiteur', 'Solde créditeur'],
      shown.map((a) => { const so = Number(a.debit) - Number(a.credit); return [a.account, a.label, Number(a.debit), Number(a.credit), so > 0 ? so : 0, so < 0 ? -so : 0]; }));
  });
}

const ledgerFilter = { q: '', side: '' };
async function viewLedger(account = '') {
  await loadPlan();
  const c = company();
  const { lines } = await api(`/companies/${c.id}/ledger?account=${encodeURIComponent(account)}&from=${period.from}&to=${period.to}`);
  const render = () => {
    const q = ledgerFilter.q.toLowerCase();
    const list = lines.filter((l) => (!q || [l.label, l.third_party, l.piece_ref, l.account].join(' ').toLowerCase().includes(q))
      && (!ledgerFilter.side || (ledgerFilter.side === 'd' ? Number(l.debit) > 0 : Number(l.credit) > 0)));
    // Regroupement par compte, avec solde progressif et sous-total.
    const groups = new Map();
    for (const l of list) (groups.get(l.account) || groups.set(l.account, []).get(l.account)).push(l);
    let td = 0, tc = 0;
    const html = [...groups.entries()].map(([acc, ls]) => {
      let solde = 0, gd = 0, gc = 0;
      const rows = ls.map((l) => {
        const d = Number(l.debit), cr = Number(l.credit);
        solde += d - cr; gd += d; gc += cr;
        return `<tr><td>${fmtDate(l.entry_date)}</td><td>${l.journal}</td><td class="small">${esc(l.piece_ref)}</td><td>${esc(l.label)}${l.third_party ? `<div class="small muted">${esc(l.third_party)}</div>` : ''}</td><td class="num">${d ? money(d) : ''}</td><td class="num">${cr ? money(cr) : ''}</td><td class="num">${money(solde)}</td><td>${l.document_id ? `<a href="#/documents/${l.document_id}" class="small">pièce</a>` : ''}</td></tr>`;
      }).join('');
      td += gd; tc += gc;
      return `<tr class="entry-head"><td colspan="8"><a href="#/ledger/${esc(acc)}" class="mono">${esc(acc)}</a> — ${esc(accountLabelOf(acc) || ls[0].account_label)}</td></tr>${rows}
        <tr class="subtotal"><td colspan="4">Total ${esc(acc)}</td><td class="num">${money(gd)}</td><td class="num">${money(gc)}</td><td class="num">${money(gd - gc)}</td><td></td></tr>`;
    }).join('');
    main().querySelector('#gl-body').innerHTML = html || '<tr><td colspan="8" class="muted">Aucun mouvement.</td></tr>';
    main().querySelector('#gl-foot').innerHTML = `<tr><td colspan="4">Total général (${list.length} lignes)</td><td class="num">${money(td)}</td><td class="num">${money(tc)}</td><td class="num">${money(td - tc)}</td><td></td></tr>`;
    main().querySelectorAll('[data-side]').forEach((b) => b.classList.toggle('active', b.dataset.side === ledgerFilter.side));
    return list;
  };
  const title = account ? `${account} ${accountLabelOf(account)}` : 'tous les comptes';
  main().innerHTML = `
    <div class="page-head"><a class="btn" href="#/balance">← Balance</a><h1>Grand livre — ${esc(title)}</h1><span class="spacer"></span><button id="gl-export">⬇ Exporter (Excel)</button></div>
    <div class="card" style="margin-bottom:14px">
      <div class="filters">${periodForm(false)}
        <div><label for="gl-acc">Compte (ou début de compte)</label><input id="gl-acc" class="mono" placeholder="ex. 401, 6…" value="${esc(account)}"></div>
        <div><label for="gl-q">Rechercher</label><input type="search" id="gl-q" placeholder="Libellé, tiers, pièce…" value="${esc(ledgerFilter.q)}"></div>
        <div class="chip-filter">${[['', 'Tous'], ['d', 'Débits'], ['c', 'Crédits']].map(([k, l]) => `<button class="small" data-side="${k}">${l}</button>`).join('')}</div>
      </div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Jnl</th><th>Pièce</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde</th><th></th></tr></thead>
      <tbody id="gl-body"></tbody><tfoot id="gl-foot"></tfoot>
    </table></div></div>`;
  bindPeriod(() => viewLedger(account));
  let shown = render();
  const acc = main().querySelector('#gl-acc');
  autocomplete(acc, { source: () => accountItems(false) });
  await loadTiers();
  autocomplete(main().querySelector('#gl-q'), { source: tiersItems });
  acc.addEventListener('change', () => { location.hash = acc.value.trim() ? `#/ledger/${encodeURIComponent(acc.value.trim())}` : '#/ledger'; });
  main().querySelector('#gl-q').addEventListener('input', (ev) => { ledgerFilter.q = ev.target.value; shown = render(); });
  main().querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { ledgerFilter.side = b.dataset.side; shown = render(); }));
  main().querySelector('#gl-export').addEventListener('click', () => {
    downloadCSV(`grand-livre-${c.name}-${account || 'tous'}-${periodSlug()}`,
      ['Compte', 'Intitulé compte', 'Date', 'Journal', 'Pièce', 'Libellé', 'Tiers', 'Débit', 'Crédit'],
      shown.map((l) => [l.account, accountLabelOf(l.account) || l.account_label, l.entry_date, l.journal, l.piece_ref, l.label, l.third_party, Number(l.debit), Number(l.credit)]));
  });
}

// --- TVA -----------------------------------------------------------------------

let tvaYear = new Date().getFullYear();
async function viewTva() {
  const c = company();
  const { months } = await api(`/companies/${c.id}/tva?year=${tvaYear}`);
  const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  let credit = 0;
  const rows = months.map((m) => {
    const net = Number(m.collectee) - Number(m.deductible) - credit;
    const due = net > 0 ? net : 0;
    credit = net < 0 ? -net : 0;
    return `<tr><td>${monthName(m.month)}</td><td class="num">${money(m.chiffre_affaires)}</td><td class="num">${money(m.collectee)}</td><td class="num">${money(m.deductible)}</td><td class="num"><b>${money(due)}</b></td><td class="num">${credit ? money(credit) : ''}</td></tr>`;
  }).join('');
  main().innerHTML = `
    <div class="page-head"><h1>TVA mensuelle</h1>
      <button id="tva-export" style="order:3">⬇ Exporter (Excel)</button>
      <select id="tva-year" style="width:auto">${[0, 1, 2, 3].map((i) => new Date().getFullYear() - i).map((y) => `<option ${y === tvaYear ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
    <div class="alert info">En Tunisie, la TVA se déclare chaque mois (avant le 28 du mois suivant pour les sociétés). <b>TVA à payer</b> = TVA collectée sur vos ventes − TVA déductible sur vos achats. Si le résultat est négatif, c'est un crédit de TVA reporté sur le mois suivant. Montants indicatifs, à faire valider avant déclaration.</div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Mois</th><th class="num">CA HT</th><th class="num">TVA collectée</th><th class="num">TVA déductible</th><th class="num">TVA à payer</th><th class="num">Crédit reporté</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">Aucune donnée pour cette année.</td></tr>'}</tbody>
    </table></div></div>`;
  main().querySelector('#tva-year').addEventListener('change', (e) => { tvaYear = Number(e.target.value); viewTva(); });
  main().querySelector('#tva-export').addEventListener('click', () => {
    let cr = 0;
    downloadCSV(`tva-${c.name}-${tvaYear}`, ['Mois', 'CA HT', 'TVA collectée', 'TVA déductible', 'TVA à payer', 'Crédit reporté'], months.map((m) => {
      const net = Number(m.collectee) - Number(m.deductible) - cr;
      cr = net < 0 ? -net : 0;
      return [m.month, Number(m.chiffre_affaires), Number(m.collectee), Number(m.deductible), net > 0 ? net : 0, cr];
    }));
  });
}

// --- Déclaration mensuelle -----------------------------------------------------

function previousMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
let declMonth = previousMonth();

async function viewDeclaration() {
  const c = company();
  const d = await api(`/companies/${c.id}/declaration?month=${declMonth}`);
  const monthLabel = new Date(`${d.month}-01T00:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const late = new Date(`${d.deadline}T23:59:59`) < new Date();
  main().innerHTML = `
    <div class="page-head no-print"><h1>Déclaration fiscale mensuelle</h1>
      <input type="month" id="decl-month" value="${d.month}" style="width:auto">
      <span class="spacer"></span><button id="decl-export">⬇ Exporter (Excel)</button><button id="print">🖨 Imprimer / PDF</button></div>
    <div class="alert info no-print">Chaque mois, la société déclare et paie les impôts du mois précédent : la TVA, les retenues à la source, le droit de timbre, le FODEC et la TCL. Pour une société, la date limite est le <b>28 du mois suivant</b> (le 15 pour une personne physique). EasyCompta prépare les montants à partir des documents scannés. Vous les reportez ensuite sur le portail de déclaration en ligne du ministère des Finances, ou vous les transmettez à votre comptable.</div>
    ${d.drafts ? `<div class="alert warn no-print">${d.drafts} écriture(s) de ce mois sont encore « À vérifier » : validez-les avant de déclarer. <a href="#/documents">Voir les documents</a></div>` : ''}
    ${d.sales_documents === 0 && Number(d.chiffreAffairesHt) > 0 ? '<div class="alert warn no-print">Des ventes ont été saisies sans facture scannée : le timbre et le FODEC collectés ne sont peut-être pas complets.</div>' : ''}
    <div class="card">
      <div class="row" style="align-items:flex-start">
        <div>
          <h2 style="margin-bottom:4px">Déclaration mensuelle — ${esc(monthLabel)}</h2>
          <div>${esc(d.company.name)}${d.company.matricule_fiscal ? ` — MF ${esc(d.company.matricule_fiscal)}` : ' — <span class="muted">matricule fiscal à renseigner dans Sociétés</span>'}</div>
        </div>
        <span class="spacer"></span>
        <div style="text-align:right">
          <div class="muted small">Date limite de dépôt</div>
          <div style="font-weight:700;color:${late ? 'var(--danger)' : 'inherit'}">${fmtDate(d.deadline)}${late ? ' (dépassée)' : ''}</div>
        </div>
      </div>

      <h3 style="margin-top:18px">1. TVA</h3>
      <div class="table-wrap"><table>
        <tbody>
          <tr><td>Chiffre d'affaires HT du mois</td><td class="num">${money(d.chiffreAffairesHt)}</td></tr>
          <tr><td>TVA collectée sur les ventes</td><td class="num">${money(d.tva.collectee)}</td></tr>
          <tr><td>− TVA déductible sur les achats</td><td class="num">${money(d.tva.deductible)}</td></tr>
          <tr><td>− Crédit de TVA du mois précédent</td><td class="num">${money(d.tva.creditReporte)}</td></tr>
          <tr><td><b>TVA à payer</b></td><td class="num"><b>${money(d.tva.aPayer)}</b></td></tr>
          ${Number(d.tva.creditAReporter) ? `<tr><td>Crédit de TVA à reporter sur le mois suivant</td><td class="num">${money(d.tva.creditAReporter)}</td></tr>` : ''}
        </tbody>
      </table></div>

      <h3 style="margin-top:18px">2. Récapitulatif à payer</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Impôt / taxe</th><th class="num">Base</th><th class="num">Montant (DT)</th></tr></thead>
        <tbody>${d.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="num">${l.base === null ? '' : money(l.base)}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="2">Total à payer</td><td class="num">${money(d.total)}</td></tr></tfoot>
      </table></div>

      ${d.withholding_detected.length ? `
      <h3 style="margin-top:18px">3. Retenues à la source repérées sur les factures d'achat</h3>
      <p class="small muted">Quand vous payez ces fournisseurs, vous devez retenir ces montants et les reverser à l'Etat. Ils comptent dans la ligne « Retenues à la source à reverser » seulement s'ils ont été passés en écriture au compte 432.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Fournisseur</th><th>Facture</th><th class="num">Retenue</th></tr></thead>
        <tbody>${d.withholding_detected.map((r) => `<tr><td><a href="#/documents/${r.document_id}">${esc(r.supplier)}</a></td><td>${esc(r.number)}</td><td class="num">${money(r.amount)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}

      <p class="small muted" style="margin-top:16px">Ces montants sont indicatifs et calculés automatiquement à partir des écritures. Les charges sur salaires (retenues sur salaires, TFP, FOPROLOS) ne sont pas encore calculées. Faites vérifier la déclaration avant de la déposer.</p>
    </div>`;
  main().querySelector('#decl-month').addEventListener('change', (e) => { if (e.target.value) { declMonth = e.target.value; viewDeclaration(); } });
  main().querySelector('#decl-export').addEventListener('click', () => {
    downloadCSV(`declaration-${c.name}-${d.month}`, ['Rubrique', 'Base', 'Montant'], [
      ['Chiffre d\'affaires HT', '', Number(d.chiffreAffairesHt)],
      ['TVA collectée', '', Number(d.tva.collectee)],
      ['TVA déductible', '', Number(d.tva.deductible)],
      ['Crédit de TVA reporté', '', Number(d.tva.creditReporte)],
      ['Crédit de TVA à reporter', '', Number(d.tva.creditAReporter)],
      ...d.lines.map((l) => [l.label, l.base === null ? '' : Number(l.base), Number(l.amount)]),
      ['Total à payer', '', Number(d.total)],
      ['Date limite de dépôt', '', d.deadline],
    ]);
  });
  main().querySelector('#print').addEventListener('click', () => window.print());
}

// --- Téléphone -----------------------------------------------------------------

async function viewPhone() {
  main().innerHTML = `
    <div class="page-head"><h1>Connecter mon téléphone</h1></div>
    <div class="grid-2">
      <div class="card">
        <h2>1. Scannez ce QR code</h2>
        <p class="muted">Ouvrez l'appareil photo de votre téléphone et visez le code. Le lien s'ouvre sur l'application de scan, déjà connectée à <b>${esc(company().name)}</b>. Le code est valable 10 minutes et ne sert qu'une fois.</p>
        <div id="qr-slot" class="qr-box"><span class="muted small">Génération…</span></div>
        <p class="small" id="pair-status"></p>
      </div>
      <div class="card">
        <h2>2. Installez l'application</h2>
        <p><b>Android (Chrome)</b> : menu ⋮ → « Installer l'application » ou « Ajouter à l'écran d'accueil ».</p>
        <p><b>iPhone (Safari)</b> : bouton Partager → « Sur l'écran d'accueil ».</p>
        <h2 style="margin-top:16px">3. Scannez vos documents</h2>
        <p class="muted">Photographiez chaque page à plat, bien éclairée. Les documents arrivent ici en quelques secondes et l'IA passe les écritures toute seule.</p>
        <p class="small muted">Lien direct : <a href="/scan" target="_blank">${esc(location.origin)}/scan</a></p>
      </div>
    </div>`;
  await generateQr(main().querySelector('#qr-slot'), () => {
    main().querySelector('#pair-status').innerHTML = '<span style="color:var(--ok)">✓ Téléphone connecté ! Vous pouvez scanner.</span>';
  });
}

// --- Aide ----------------------------------------------------------------------

function viewHelp() {
  main().innerHTML = `
  <div class="card help" style="max-width:860px">
    <h1>Comment ça marche ?</h1>
    <p>EasyCompta remplace la <b>saisie comptable</b> : le travail qui consiste à recopier chaque facture et chaque ligne de relevé bancaire dans la comptabilité, sous forme d'<b>écritures</b>.</p>
    <h2>Le circuit</h2>
    <ol>
      <li><b>Scan</b> : photographiez le document avec le téléphone (ou déposez un PDF sur le site).</li>
      <li><b>Lecture par l'IA</b> : en arrière-plan, l'IA identifie le type de document, le fournisseur ou le client, la date, le HT, la TVA, le timbre, le TTC, ou chaque ligne du relevé.</li>
      <li><b>Écritures automatiques</b> : le logiciel crée les écritures selon le plan comptable tunisien, toujours équilibrées (total débit = total crédit).</li>
      <li><b>Contrôle</b> : si tout est cohérent, c'est <span class="badge done">Comptabilisé</span>. En cas de doute (photo floue, totaux qui ne collent pas…), le document passe <span class="badge review">À vérifier</span> avec l'explication.</li>
      <li><b>Apprentissage</b> : si vous corrigez le compte d'un fournisseur, EasyCompta le retient pour ses prochaines factures.</li>
      <li><b>Plusieurs clients</b> : chaque client a son dossier (page « Mes clients »). Invitez-le avec un lien : il envoie lui-même ses factures depuis son téléphone et ne voit que son dossier.</li>
      <li><b>Lettrage</b> : chaque paiement trouvé sur un relevé bancaire est relié à sa facture. L'<b>échéancier</b> montre qui vous doit de l'argent et qui vous devez payer.</li>
      <li><b>Immobilisations</b> : un achat de matériel durable est amorti automatiquement sur plusieurs années.</li>
      <li><b>Contrôles</b> : EasyCompta signale les doublons, les relevés manquants, les factures en retard…</li>
      <li><b>Assistant IA</b> : posez vos questions (« chhal 3andi fel banque ? ») et il répond à partir de vos chiffres.</li>
      <li><b>Déclaration fiscale</b> : chaque mois, EasyCompta prépare la déclaration (TVA, retenues à la source, timbre, FODEC, TCL) avec le total à payer et la date limite.</li>
      <li><b>Export</b> : la balance, le grand livre et l'export Excel sont prêts pour l'expert-comptable.</li>
    </ol>
    <h2>Les exemples d'écritures</h2>
    <p><b>Facture d'achat</b> (ex. internet 1 000 HT + 190 TVA + 1 timbre = 1 191 TTC) :</p>
    <div class="table-wrap"><table><thead><tr><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th></tr></thead><tbody>
      <tr><td class="mono">62600000</td><td>Charge : frais de télécommunications</td><td class="num">1 000,000</td><td></td></tr>
      <tr><td class="mono">43666000</td><td>TVA déductible (récupérable)</td><td class="num">190,000</td><td></td></tr>
      <tr><td class="mono">66540000</td><td>Droit de timbre</td><td class="num">1,000</td><td></td></tr>
      <tr><td class="mono">40110001</td><td>Dette envers le fournisseur (son compte à lui)</td><td></td><td class="num">1 191,000</td></tr>
    </tbody></table></div>
    <p style="margin-top:10px"><b>Paiement par banque</b> du fournisseur : débit 40110001 (la dette disparaît) / crédit 53210000 (l'argent sort de la banque).</p>
    <h2>Petit lexique</h2>
    <dl>
      <dt>Débit / Crédit</dt><dd>Les deux colonnes d'une écriture. Chaque opération est enregistrée deux fois : d'où vient l'argent et où il va.</dd>
      <dt>Journal</dt><dd>Classement des écritures : ACH (achats), VTE (ventes), BQ (banque), CAI (caisse), OD (opérations diverses).</dd>
      <dt>Plan comptable</dt><dd>La liste officielle des comptes (classe 2 immobilisations, 4 tiers, 5 trésorerie, 6 charges, 7 produits). Chaque fournisseur et chaque client a son propre compte (4011xxxx, 4111xxxx), créé automatiquement.</dd>
      <dt>Balance</dt><dd>Le total de chaque compte. Elle doit toujours être équilibrée.</dd>
      <dt>Grand livre</dt><dd>Le détail de tous les mouvements d'un compte.</dd>
      <dt>TVA collectée / déductible</dt><dd>La TVA facturée à vos clients (due à l'Etat) et celle payée à vos fournisseurs (récupérable).</dd>
      <dt>Immobilisation</dt><dd>Un bien durable (ordinateur, voiture, machine) : il n'est pas une charge de l'année mais un actif amorti sur plusieurs années.</dd>
      <dt>Retenue à la source</dt><dd>Part de certains paiements (honoraires, loyers, marchés…) retenue et versée directement à l'Etat.</dd>
    </dl>
    <p class="small muted">EasyCompta automatise la saisie. Les états de fin d'année (bilan, état de résultat, déclarations) restent à faire valider par un expert-comptable.</p>
  </div>`;
}

// --- Graphique et contrôles (tableau de bord) ------------------------------------

function barChart(months) {
  const data = Array.from({ length: 12 }, (_, i) => {
    const m = months.find((x) => Number(x.month) === i + 1) || {};
    return { p: Number(m.produits || 0), c: Number(m.charges || 0) };
  });
  const max = Math.max(1, ...data.flatMap((d) => [d.p, d.c]));
  const W = 600, H = 180, bw = 16, gap = W / 12;
  const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const bars = data.map((d, i) => {
    const x = i * gap + gap / 2 - bw;
    const hp = (d.p / max) * (H - 24), hc = (d.c / max) * (H - 24);
    return `<rect class="bar" style="animation-delay:${i * 50}ms" x="${x}" y="${H - 20 - hp}" width="${bw - 2}" height="${hp}" rx="4" fill="url(#gTeal)"><title>CA ${names[i]} : ${money(d.p)}</title></rect>
      <rect class="bar" style="animation-delay:${i * 50 + 25}ms" x="${x + bw}" y="${H - 20 - hc}" width="${bw - 2}" height="${hc}" rx="4" fill="url(#gNavy)"><title>Charges : ${money(d.c)}</title></rect>
      <text x="${i * gap + gap / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="var(--muted)">${names[i]}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Chiffre d'affaires et charges par mois">
    <defs><linearGradient id="gTeal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14c2b0"/><stop offset="1" stop-color="#02a091"/></linearGradient>
    <linearGradient id="gNavy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d5a6d"/><stop offset="1" stop-color="#063643"/></linearGradient></defs><line x1="0" x2="${W}" y1="${H - 20}" y2="${H - 20}" stroke="var(--border)"/>${bars}</svg>`;
}

const CHECK_ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️', ok: '✅' };
function checkItem(k) {
  return `<li class="check ${k.level}"><span>${CHECK_ICON[k.level]}</span><div><b>${esc(k.title)}</b><div class="small muted">${esc(k.detail)}</div></div>${k.link ? `<a class="btn small" href="${k.link}">Voir</a>` : ''}</li>`;
}

function yearSelect(id, value) {
  const y = new Date().getFullYear();
  return `<select id="${id}" style="width:auto">${[1, 0, -1, -2, -3].map((i) => y + i).map((v) => `<option ${v === value ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
}

// --- Contrôles -------------------------------------------------------------------

let ctrlYear = new Date().getFullYear();
async function viewControles() {
  const { checks } = await api(`/companies/${company().id}/controles?year=${ctrlYear}`);
  main().innerHTML = `
    <div class="page-head"><h1>Contrôles automatiques</h1>${yearSelect('ctrl-year', ctrlYear)}</div>
    <p class="muted">EasyCompta vérifie le dossier à chaque document : doublons, comptes qui ne devraient pas avoir ce solde, relevés manquants, factures impayées… Corrigez ce qui est signalé en rouge en priorité.</p>
    <div class="card"><ul class="checks">${checks.map(checkItem).join('')}</ul></div>`;
  main().querySelector('#ctrl-year').addEventListener('change', (e) => { ctrlYear = Number(e.target.value); viewControles(); });
}

// --- Échéancier & lettrage ---------------------------------------------------------

async function viewEcheancier() {
  const c = company();
  const [{ items }, { lines }] = await Promise.all([api(`/companies/${c.id}/echeancier`), api(`/companies/${c.id}/lettrage`)]);
  const section = (type, title, help) => {
    const list = items.filter((i) => i.type === type);
    const total = list.reduce((s, i) => s + Number(i.amount), 0);
    const late = list.filter((i) => i.late).reduce((s, i) => s + Number(i.amount), 0);
    return `<div class="card">
      <div class="row"><h2 style="margin:0">${title}</h2><span class="spacer"></span><b class="mono">${money(total)} DT</b></div>
      <p class="small muted">${help}${late ? ` Dont <b style="color:var(--danger)">${money(late)} DT en retard</b>.` : ''}</p>
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Tiers</th><th>Pièce</th><th>Date</th><th>Échéance</th><th class="num">Montant</th></tr></thead><tbody>
        ${list.map((i) => `<tr><td>${esc(i.partner || '—')}${i.partial ? ' <span class="badge review">retenue à la source</span>' : ''}</td>
          <td>${i.document_id ? `<a href="#/documents/${i.document_id}">${esc(i.piece_ref || 'voir')}</a>` : esc(i.piece_ref)}</td>
          <td>${fmtDate(i.date)}</td><td>${fmtDate(i.due_date)} ${i.late ? `<span class="badge error">${i.days_late} j de retard</span>` : ''}</td>
          <td class="num">${money(i.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Rien en attente.</p>'}
    </div>`;
  };
  const groups = {};
  for (const l of lines) if (l.lettrage) (groups[l.lettrage] ||= []).push(l);
  const lettered = Object.entries(groups);
  main().innerHTML = `
    <div class="page-head"><h1>Échéancier & lettrage</h1><span class="spacer"></span><button id="ech-export">⬇ Exporter (Excel)</button><button class="primary" id="auto-lettrage">↻ Lettrage automatique</button></div>
    <p class="muted">Le <b>lettrage</b> relie chaque facture à son paiement trouvé dans les relevés bancaires. Il se fait tout seul après chaque document scanné. Ce qui reste non lettré est encore dû.</p>
    <div class="grid-2">
      ${section('a_encaisser', 'À encaisser (clients)', 'Factures de vente dont le paiement n\'apparaît pas encore sur un relevé.')}
      ${section('a_payer', 'À payer (fournisseurs)', 'Factures d\'achat dont le règlement n\'apparaît pas encore sur un relevé.')}
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Rapprochements effectués (${lettered.length})</h2>
      ${lettered.length ? `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Date</th><th>Tiers</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th><th></th></tr></thead><tbody>
        ${lettered.map(([code, ls]) => ls.map((l, i) => `<tr class="${i === 0 ? 'entry-head' : ''}"><td class="mono">${i === 0 ? esc(code) : ''}</td><td>${fmtDate(l.date)}</td><td>${esc(l.third_party)}</td><td>${esc(l.label)}</td>
          <td class="num">${Number(l.debit) ? money(l.debit) : ''}</td><td class="num">${Number(l.credit) ? money(l.credit) : ''}</td>
          <td>${i === 0 ? `<button class="ghost small" data-unletter="${esc(code)}">Défaire</button>` : ''}</td></tr>`).join('')).join('')}
      </tbody></table></div>` : '<p class="muted">Aucun rapprochement pour l\'instant : scannez vos relevés bancaires.</p>'}
    </div>`;
  main().querySelector('#ech-export').addEventListener('click', () => {
    downloadCSV(`echeancier-${c.name}`, ['Type', 'Tiers', 'Pièce', 'Date', 'Échéance', 'Jours de retard', 'Montant'],
      items.map((i) => [i.type === 'a_encaisser' ? 'À encaisser' : 'À payer', i.partner, i.piece_ref, i.date, i.due_date, i.days_late, Number(i.amount)]));
  });
  main().querySelector('#auto-lettrage').addEventListener('click', async () => {
    const { matched } = await api(`/companies/${c.id}/lettrage/auto`, { method: 'POST' });
    toast(matched ? `${matched} rapprochement(s) trouvé(s)` : 'Aucun nouveau rapprochement');
    viewEcheancier();
  });
  main().querySelectorAll('[data-unletter]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/companies/${c.id}/lettrage/${encodeURIComponent(b.dataset.unletter)}`, { method: 'DELETE' });
    viewEcheancier();
  }));
}

// --- Bilan & résultat --------------------------------------------------------------

let etatsYear = new Date().getFullYear();
async function viewEtats() {
  const d = await api(`/companies/${company().id}/etats?year=${etatsYear}`);
  const rows = (ls) => ls.map((l) => `<tr><td>${esc(l.label)}</td><td class="num">${money(l.amount)}</td></tr>`).join('');
  const net = Number(d.resultat.net);
  main().innerHTML = `
    <div class="page-head no-print"><h1>Bilan & état de résultat</h1>${yearSelect('etats-year', etatsYear)}<span class="spacer"></span><button id="etats-export">⬇ Exporter (Excel)</button><button id="print">🖨 Imprimer / PDF</button></div>
    <p class="muted no-print">Calculés automatiquement à partir de toutes les écritures. Le <b>résultat</b> dit si la société gagne ou perd de l'argent sur l'année ; le <b>bilan</b> montre ce qu'elle possède (actif) et ce qu'elle doit (passif) au 31/12. Version simplifiée, indicative : les états officiels de fin d'année restent à établir avec l'expert-comptable.</p>
    <div class="card" style="margin-bottom:16px">
      <h2>État de résultat ${d.year} — ${esc(company().name)}</h2>
      <div class="table-wrap"><table><tbody>${rows(d.resultat.lines)}
        <tr class="entry-head"><td>Résultat d'exploitation</td><td class="num">${money(d.resultat.exploitation)}</td></tr></tbody>
        <tfoot><tr><td>Résultat net (${net >= 0 ? 'bénéfice' : 'perte'})</td><td class="num" style="color:${net >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(net)}</td></tr></tfoot></table></div>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Actif au 31/12/${d.year}</h2><div class="table-wrap"><table><tbody>${rows(d.bilan.actif)}</tbody><tfoot><tr><td>Total actif</td><td class="num">${money(d.bilan.totalActif)}</td></tr></tfoot></table></div></div>
      <div class="card"><h2>Passif au 31/12/${d.year}</h2><div class="table-wrap"><table><tbody>${rows(d.bilan.passif)}</tbody><tfoot><tr><td>Total passif</td><td class="num">${money(d.bilan.totalPassif)}</td></tr></tfoot></table></div></div>
    </div>
    ${Math.round(Number(d.bilan.totalActif) * 1000) === Math.round(Number(d.bilan.totalPassif) * 1000) ? '<p class="small" style="color:var(--ok)">✓ Bilan équilibré</p>' : '<p class="small" style="color:var(--danger)">⚠ Bilan déséquilibré : vérifiez les écritures</p>'}`;
  main().querySelector('#etats-year').addEventListener('change', (e) => { etatsYear = Number(e.target.value); viewEtats(); });
  main().querySelector('#etats-export').addEventListener('click', () => {
    downloadCSV(`etats-financiers-${company().name}-${d.year}`, ['État', 'Rubrique', 'Montant'], [
      ...d.resultat.lines.map((l) => ['Résultat', l.label, Number(l.amount)]),
      ['Résultat', 'Résultat d\'exploitation', Number(d.resultat.exploitation)],
      ['Résultat', 'Résultat net', Number(d.resultat.net)],
      ...d.bilan.actif.map((l) => ['Bilan - actif', l.label, Number(l.amount)]),
      ['Bilan - actif', 'Total actif', Number(d.bilan.totalActif)],
      ...d.bilan.passif.map((l) => ['Bilan - passif', l.label, Number(l.amount)]),
      ['Bilan - passif', 'Total passif', Number(d.bilan.totalPassif)],
    ]);
  });
  main().querySelector('#print').addEventListener('click', () => window.print());
}

// --- Immobilisations -----------------------------------------------------------------

let immoYear = new Date().getFullYear();
async function viewImmobilisations() {
  const c = company();
  const { items } = await api(`/companies/${c.id}/immobilisations?year=${immoYear}`);
  const total = (k) => items.reduce((s, i) => s + Number(i[k]), 0);
  main().innerHTML = `
    <div class="page-head"><h1>Immobilisations</h1>${yearSelect('immo-year', immoYear)}<span class="spacer"></span>
      ${items.length ? '<button id="immo-export">⬇ Exporter (Excel)</button>' : ''}
      ${items.length ? `<button class="primary" id="dotations">Passer les dotations ${immoYear}</button>` : ''}</div>
    <p class="muted">Quand l'IA lit l'achat d'un bien durable (ordinateur, véhicule, mobilier, machine, logiciel), il est ajouté ici automatiquement. Son coût est réparti sur plusieurs années : c'est l'<b>amortissement</b>. Le taux proposé est le taux usuel ; modifiez-le si votre comptable le demande.</p>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Bien</th><th>Compte</th><th>Acquis le</th><th class="num">Valeur</th><th class="num">Taux %</th><th class="num">Amorti avant ${immoYear}</th><th class="num">Dotation ${immoYear}</th><th class="num">Valeur restante</th></tr></thead>
      <tbody>${items.map((i) => `<tr>
        <td>${i.document_id ? `<a href="#/documents/${i.document_id}">${esc(i.label)}</a>` : esc(i.label)}</td>
        <td><span class="mono">${esc(i.account)}</span><div class="small muted">${esc(i.account_label)}</div></td>
        <td>${fmtDate(i.acquisition_date)}</td><td class="num">${money(i.value)}</td>
        <td class="num"><input class="num" style="width:80px" data-rate="${i.id}" value="${Number(i.rate)}" inputmode="decimal" aria-label="Taux"></td>
        <td class="num">${money(i.cumul_avant)}</td><td class="num">${money(i.dotation)}</td><td class="num">${money(i.vnc)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucune immobilisation : elles apparaîtront dès qu\'une facture d\'achat de matériel sera scannée.</td></tr>'}</tbody>
      ${items.length ? `<tfoot><tr><td colspan="3">Total</td><td class="num">${money(total('value'))}</td><td></td><td class="num">${money(total('cumul_avant'))}</td><td class="num">${money(total('dotation'))}</td><td class="num">${money(total('vnc'))}</td></tr></tfoot>` : ''}
    </table></div></div>`;
  main().querySelector('#immo-year').addEventListener('change', (e) => { immoYear = Number(e.target.value); viewImmobilisations(); });
  main().querySelector('#immo-export')?.addEventListener('click', () => {
    downloadCSV(`immobilisations-${c.name}-${immoYear}`, ['Bien', 'Compte', 'Intitulé', 'Acquis le', 'Valeur', 'Taux %', `Amorti avant ${immoYear}`, `Dotation ${immoYear}`, 'Valeur restante'],
      items.map((i) => [i.label, i.account, i.account_label, i.acquisition_date, Number(i.value), String(Number(i.rate)).replace('.', ','), Number(i.cumul_avant), Number(i.dotation), Number(i.vnc)]));
  });
  main().querySelectorAll('[data-rate]').forEach((inp) => inp.addEventListener('change', async () => {
    try {
      await api(`/companies/${c.id}/immobilisations/${inp.dataset.rate}`, { method: 'PUT', body: { rate: inp.value.replace(',', '.') } });
      viewImmobilisations();
    } catch (err) { toast(err.message, 'error'); }
  }));
  main().querySelector('#dotations')?.addEventListener('click', async () => {
    const r = await api(`/companies/${c.id}/immobilisations/dotations`, { method: 'POST', body: { year: immoYear } });
    toast(`Écriture de dotations ${immoYear} : ${money(r.total)} DT (journal OD, 31/12)`);
  });
}

// --- Assistant IA ----------------------------------------------------------------------

const chats = {};
function formatAnswer(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[-*•] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n/g, '<br>');
}

// Bulle flottante (bouton ✨ en bas à droite) : disponible sur toutes les pages du
// cabinet, la conversation est gardée par dossier.
const AI_SUGGESTIONS = ['Chhal 3andi fel banque taw ?', 'Chkoun mel clients ma 5allasnich ?', 'Chnowa akbar masrouf 3andi hal 3am ?', 'Est-ce que la société est bénéficiaire cette année ?', 'Chnowa lezem n3adi fel déclaration mta3 hal chhar ?'];
let aiBusy = false;

function aiAvailable() {
  return Boolean(state.user && state.companyId && !isClient());
}

function updateAiFab() {
  const fab = document.getElementById('ai-fab');
  if (!fab) return;
  fab.classList.toggle('hidden', !aiAvailable());
  if (!aiAvailable()) closeAssistant();
  else if (isAssistantOpen()) renderAssistant();
}

const isAssistantOpen = () => !document.getElementById('ai-panel')?.classList.contains('hidden');

function openAssistant() {
  if (!aiAvailable()) return;
  const panel = document.getElementById('ai-panel');
  panel.classList.remove('hidden');
  document.getElementById('ai-fab').classList.add('open');
  renderAssistant();
  panel.querySelector('#chat-input')?.focus();
}

function closeAssistant() {
  document.getElementById('ai-panel')?.classList.add('hidden');
  document.getElementById('ai-fab')?.classList.remove('open');
}

function renderAssistant() {
  const panel = document.getElementById('ai-panel');
  const c = company();
  if (!panel || !c) return;
  const history = (chats[c.id] ||= []);
  panel.innerHTML = `
    <header>
      <div class="ai-avatar" aria-hidden="true">✨</div>
      <div style="flex:1;min-width:0"><b>Assistant IA</b><div class="small muted ai-company">${esc(c.name)}</div></div>
      ${history.length ? '<button class="ghost small" id="chat-clear" title="Nouvelle conversation">↺</button>' : ''}
      <button class="ghost small" id="ai-close" aria-label="Fermer">✕</button>
    </header>
    <div class="chat-log" id="chat-log">
      ${history.length ? '' : `<div class="msg assistant">Bonjour 👋 Posez-moi une question sur la comptabilité de <b>${esc(c.name)}</b>, en français ou en tounsi.</div>
        <div class="chips">${AI_SUGGESTIONS.map((q, i) => `<button class="small" style="animation-delay:${i * 60}ms" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
      ${history.map((m) => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.content) : formatAnswer(m.content)}</div>`).join('')}
      ${aiBusy ? '<div class="msg assistant"><span class="typing"><i></i><i></i><i></i></span></div>' : ''}
    </div>
    <form id="chat-form">
      <input id="chat-input" placeholder="Votre question…" autocomplete="off" required ${aiBusy ? 'disabled' : ''}>
      <button class="primary" aria-label="Envoyer" ${aiBusy ? 'disabled' : ''}>➤</button>
    </form>`;
  const log = panel.querySelector('#chat-log');
  log.scrollTop = log.scrollHeight;
  panel.querySelector('#ai-close').addEventListener('click', closeAssistant);
  panel.querySelector('#chat-clear')?.addEventListener('click', () => { chats[c.id] = []; renderAssistant(); });
  panel.querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = panel.querySelector('#chat-input').value.trim();
    if (q) askAssistant(q);
  });
  panel.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => askAssistant(b.dataset.q)));
}

async function askAssistant(q) {
  const c = company();
  if (!c || aiBusy) return;
  const history = (chats[c.id] ||= []);
  history.push({ role: 'user', content: q });
  aiBusy = true;
  renderAssistant();
  try {
    const { answer } = await api(`/companies/${c.id}/assistant`, { method: 'POST', body: { messages: history } });
    history.push({ role: 'assistant', content: answer });
  } catch (err) {
    history.push({ role: 'assistant', content: `⚠ ${err.message}` });
  }
  aiBusy = false;
  if (isAssistantOpen()) {
    renderAssistant();
    document.querySelector('#ai-panel #chat-input')?.focus();
  } else {
    document.getElementById('ai-fab')?.classList.add('unread');
  }
}

// --- Plan comptable ---------------------------------------------------------------------

const planFilter = { q: '', cls: '', only: '' };
async function viewPlanComptable() {
  await loadPlan(true);
  const c = company();
  const all = state.accountList;
  const render = () => {
    const q = planFilter.q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const list = all.filter((a) => (!planFilter.cls || a.code.startsWith(planFilter.cls))
      && (!planFilter.only || (planFilter.only === 'aux' ? a.auxiliary : planFilter.only === 'used' ? a.used > 0 : true))
      && (!q || a.code.startsWith(q) || a.label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q)));
    const shown = list.slice(0, 400);
    main().querySelector('#plan-body').innerHTML = shown.map((a) => {
      const lvl = a.nature === 'R' ? (a.code.length <= 1 ? 'lvl1' : '') : '';
      return `<tr class="${a.nature === 'R' ? `acc-group ${lvl}` : ''}" data-code="${esc(a.code)}">
        <td class="mono">${esc(a.code)}</td>
        <td><span class="lbl">${esc(a.label)}</span>
          ${a.auxiliary ? ` <span class="badge pending" style="animation:none">${a.code.startsWith('411') ? 'client' : 'fournisseur'}</span>` : ''}</td>
        <td class="small muted">${a.nature === 'R' ? 'Regroupement' : 'Détail'}</td>
        <td class="small">${esc(a.sens)}</td>
        <td class="num small">${a.used ? `<a href="#/ledger/${esc(a.code)}">${a.used}</a>` : ''}</td>
        <td style="white-space:nowrap;text-align:right"><button class="ghost small" data-edit title="Renommer">✎</button>${a.used ? '' : '<button class="ghost small danger" data-del title="Supprimer">✕</button>'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">Aucun compte ne correspond.</td></tr>';
    main().querySelector('#plan-count').textContent = `${list.length} compte(s)${list.length > shown.length ? ` — ${shown.length} affichés, affinez la recherche` : ''}`;
    main().querySelectorAll('[data-cls]').forEach((b) => b.classList.toggle('active', b.dataset.cls === planFilter.cls));
    main().querySelectorAll('[data-only]').forEach((b) => b.classList.toggle('active', b.dataset.only === planFilter.only));
    main().querySelectorAll('#plan-body [data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const code = b.closest('tr').dataset.code;
      const acc = all.find((a) => a.code === code);
      const label = prompt(`Nouvel intitulé du compte ${code}`, acc.label);
      if (!label || label === acc.label) return;
      try { await api(`/companies/${c.id}/accounts/${code}`, { method: 'PUT', body: { label } }); toast('Compte renommé'); viewPlanComptable(); } catch (err) { toast(err.message, 'error'); }
    }));
    main().querySelectorAll('#plan-body [data-del]').forEach((b) => b.addEventListener('click', async () => {
      const code = b.closest('tr').dataset.code;
      if (!confirm(`Supprimer le compte ${code} ?`)) return;
      try { await api(`/companies/${c.id}/accounts/${code}`, { method: 'DELETE' }); toast('Compte supprimé'); viewPlanComptable(); } catch (err) { toast(err.message, 'error'); }
    }));
    return list;
  };
  const classes = [['', 'Toutes'], ['1', '1 Capitaux'], ['2', '2 Immobilisations'], ['3', '3 Stocks'], ['4', '4 Tiers'], ['5', '5 Financiers'], ['6', '6 Charges'], ['7', '7 Produits']];
  main().innerHTML = `
    <div class="page-head"><h1>Plan comptable</h1><span class="muted">${all.length} comptes</span><span class="spacer"></span>
      <label class="btn" style="margin:0">⬆ Importer (Excel)<input type="file" id="plan-file" accept=".xlsx,.csv" class="hidden"></label>
      <button id="plan-export">⬇ Exporter (Excel)</button></div>
    <p class="muted">Le plan comptable tunisien est installé par défaut. L'IA s'en sert pour chaque écriture et ouvre automatiquement un compte pour chaque nouveau fournisseur (4011xxxx) ou client (4111xxxx). Vous pouvez importer votre propre plan (colonnes <b>Code</b>, <b>Libellé</b>, et si possible <b>Nature</b> et <b>Sens</b>) : les comptes sont ajoutés ou mis à jour, aucun n'est supprimé.</p>
    <div id="plan-import-result"></div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="filters">
          <div style="flex:1"><label for="plan-q">Rechercher un compte</label><input type="search" id="plan-q" placeholder="Numéro ou intitulé (ex. 6066, télécom, STEG)" value="${esc(planFilter.q)}"></div>
        </div>
        <div class="chip-filter" style="margin-top:12px">${classes.map(([k, l]) => `<button class="small" data-cls="${k}">${l}</button>`).join('')}</div>
        <div class="chip-filter" style="margin-top:8px">${[['', 'Tous'], ['aux', 'Fournisseurs et clients'], ['used', 'Utilisés']].map(([k, l]) => `<button class="small" data-only="${k}">${l}</button>`).join('')}</div>
      </div>
      <div class="card">
        <h3>Ajouter un compte</h3>
        <form id="plan-add" class="filters">
          <div style="min-width:130px"><label for="pa-code">Numéro</label><input id="pa-code" class="mono" inputmode="numeric" placeholder="ex. 60610000" required></div>
          <div style="flex:1"><label for="pa-label">Intitulé</label><input id="pa-label" placeholder="ex. Achats de carburant" required></div>
          <div><label for="pa-nature">Type</label><select id="pa-nature"><option value="C">Détail</option><option value="R">Regroupement</option></select></div>
          <button class="primary">Ajouter</button>
        </form>
        <div class="row" style="margin-top:10px"><button class="small" data-new="401">＋ Nouveau fournisseur</button><button class="small" data-new="411">＋ Nouveau client</button></div>
      </div>
    </div>
    <div class="card">
      <div class="small muted" id="plan-count" style="margin-bottom:8px"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Compte</th><th>Intitulé</th><th>Type</th><th>Sens</th><th class="num">Lignes</th><th></th></tr></thead>
        <tbody id="plan-body"></tbody>
      </table></div>
    </div>`;
  let shown = render();
  const qInput = main().querySelector('#plan-q');
  qInput.addEventListener('input', () => { planFilter.q = qInput.value; shown = render(); });
  autocomplete(qInput, { source: () => accountItems(false) });
  main().querySelectorAll('[data-cls]').forEach((b) => b.addEventListener('click', () => { planFilter.cls = b.dataset.cls; shown = render(); }));
  main().querySelectorAll('[data-only]').forEach((b) => b.addEventListener('click', () => { planFilter.only = b.dataset.only; shown = render(); }));
  main().querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', async () => {
    const { code } = await api(`/companies/${c.id}/accounts/next/${b.dataset.new}`);
    main().querySelector('#pa-code').value = code;
    main().querySelector('#pa-label').value = '';
    main().querySelector('#pa-label').placeholder = b.dataset.new === '411' ? 'Nom du client' : 'Nom du fournisseur';
    main().querySelector('#pa-label').focus();
  }));
  main().querySelector('#plan-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/companies/${c.id}/accounts`, { method: 'POST', body: { code: main().querySelector('#pa-code').value, label: main().querySelector('#pa-label').value, nature: main().querySelector('#pa-nature').value } });
      toast('Compte ajouté');
      viewPlanComptable();
    } catch (err) { toast(err.message, 'error'); }
  });
  main().querySelector('#plan-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const box = main().querySelector('#plan-import-result');
    box.innerHTML = '<div class="alert info">Import en cours…</div>';
    try {
      const r = await api(`/companies/${c.id}/accounts/import`, { method: 'POST', form });
      await loadPlan(true);
      viewPlanComptable().then(() => {
        main().querySelector('#plan-import-result').innerHTML = `<div class="alert info">✓ ${r.imported} compte(s) importé(s) dont ${r.auxiliaries} fournisseur(s)/client(s).
          ${r.conflicts.length ? `<br>${r.conflicts.length} compte(s) déjà utilisé(s) dans vos écritures ont gardé leur intitulé actuel : ${r.conflicts.slice(0, 8).map((x) => `${esc(x.code)} « ${esc(x.current)} » (fichier : « ${esc(x.imported)} »)`).join(', ')}${r.conflicts.length > 8 ? '…' : ''}` : ''}</div>`;
      });
    } catch (err) {
      box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    }
  });
  main().querySelector('#plan-export').addEventListener('click', () => {
    downloadCSV(`plan-comptable-${c.name}`, ['Code', 'Libelle', 'Nature', 'Sens'],
      shown.map((a) => [a.code, a.label, a.nature === 'R' ? 'Regroupement' : 'Comptable', a.sens]));
  });
}

// --- Fenêtre générique -----------------------------------------------------------------

function openModal(title, html, { width = 720 } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="max-width:${width}px">
    <header><h2>${esc(title)}</h2><span class="spacer"></span><button class="ghost" data-close aria-label="Fermer">✕</button></header>
    <div class="modal-body">${html}</div></div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  return { el: wrap, close };
}

// --- Mes clients (cabinet) ---------------------------------------------------------------

const SALES_LABEL = { services: 'Prestations de services (705)', marchandises: 'Vente de marchandises (707)', produits: 'Vente de produits fabriqués (701)' };
const clientsFilter = { q: '', only: '' };

function sinceText(date) {
  if (!date) return 'Aucun document';
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  if (days <= 0) return 'Dernier document aujourd\'hui';
  if (days === 1) return 'Dernier document hier';
  return `Dernier document il y a ${days} j`;
}

async function viewClients() {
  await refreshCompanyCounts();
  const list = state.companies;
  const cabinet = list.filter((c) => c.role !== 'client');
  const total = (k) => cabinet.reduce((sum, c) => sum + (c[k] || 0), 0);
  const quiet = cabinet.filter((c) => !c.last_30_days).length;
  const render = () => {
    const q = clientsFilter.q.trim().toLowerCase();
    const shown = cabinet
      .filter((c) => !q || [c.name, c.matricule_fiscal, c.activity].join(' ').toLowerCase().includes(q))
      .filter((c) => !clientsFilter.only || (clientsFilter.only === 'todo' ? c.to_review || c.errors : !c.last_30_days))
      .sort((a, b) => (b.to_review + b.errors) - (a.to_review + a.errors) || a.name.localeCompare(b.name));
    main().querySelector('#client-grid').innerHTML = shown.map((c) => `
      <div class="card client-card hoverable ${c.id === state.companyId ? 'current' : ''}">
        <div class="row" style="align-items:flex-start;flex-wrap:nowrap">
          <div class="client-avatar" aria-hidden="true">${esc(c.name.trim().slice(0, 2).toUpperCase())}</div>
          <div style="flex:1;min-width:0">
            <h3 style="margin:0">${esc(c.name)}</h3>
            <div class="small muted">${esc(c.matricule_fiscal || 'Matricule fiscal non renseigné')}${c.activity ? ` · ${esc(c.activity)}` : ''}</div>
          </div>
          ${c.role === 'staff' ? '<span class="badge pending" style="animation:none">collaborateur</span>' : ''}
        </div>
        <div class="row small" style="margin:12px 0 4px;gap:6px">
          ${c.to_review ? `<span class="badge review">${c.to_review} à vérifier</span>` : ''}
          ${c.in_progress ? `<span class="badge processing">${c.in_progress} en cours</span>` : ''}
          ${c.errors ? `<span class="badge error">${c.errors} en erreur</span>` : ''}
          ${!c.to_review && !c.in_progress && !c.errors && c.documents ? '<span class="badge done">À jour</span>' : ''}
          <span class="muted">${c.documents} document(s)</span>
        </div>
        <div class="small muted">${sinceText(c.last_document)} · ${c.client_users ? `👤 ${c.client_users} accès client` : 'Client pas encore invité'}</div>
        <div class="row" style="margin-top:12px">
          <button class="primary small" data-open="${c.id}">Ouvrir le dossier</button>
          <button class="small" data-side="${c.id}" title="Voir ses documents à côté du dossier ouvert">⧉ À côté</button>
          <button class="small" data-invite="${c.id}">👤 Accès client</button>
          <button class="ghost small" data-edit="${c.id}" title="Modifier">✎</button>
        </div>
      </div>`).join('') || `<div class="card muted">${cabinet.length ? 'Aucun client ne correspond.' : 'Aucun client pour l\'instant : ajoutez le premier.'}</div>`;
    main().querySelectorAll('[data-only]').forEach((b) => b.classList.toggle('active', b.dataset.only === clientsFilter.only));
    main().querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      state.companyId = Number(b.dataset.open);
      store('ec_company', String(state.companyId));
      location.hash = '#/dashboard';
    }));
    main().querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => openPeek({ companyId: Number(b.dataset.side) })));
    main().querySelectorAll('[data-invite]').forEach((b) => b.addEventListener('click', () => openAccessModal(list.find((c) => c.id === Number(b.dataset.invite)))));
    main().querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openClientModal(list.find((c) => c.id === Number(b.dataset.edit)))));
  };
  main().innerHTML = `
    <div class="page-head"><h1>Mes clients</h1><span class="muted">${cabinet.length} dossier(s)</span><span class="spacer"></span>
      <button class="primary" id="new-client">＋ Nouveau client</button></div>
    <div class="kpis" style="margin-bottom:16px">
      <div class="card kpi hero"><div class="label">Clients</div><div class="value" data-count="${cabinet.length}">${cabinet.length}</div></div>
      <div class="card kpi hoverable"><div class="label">Documents à vérifier</div><div class="value" style="color:var(--warn)" data-count="${total('to_review')}">${total('to_review')}</div></div>
      <div class="card kpi hoverable"><div class="label">En cours de lecture</div><div class="value" data-count="${total('in_progress')}">${total('in_progress')}</div></div>
      <div class="card kpi hoverable"><div class="label">Sans document depuis 30 j</div><div class="value" data-count="${quiet}">${quiet}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px"><div class="filters">
      <div style="flex:1"><label for="client-q">Rechercher un client</label><input type="search" id="client-q" placeholder="Nom, matricule fiscal, activité…" value="${esc(clientsFilter.q)}"></div>
      <div class="chip-filter">${[['', 'Tous'], ['todo', 'À traiter'], ['quiet', 'Sans document récent']].map(([k, l]) => `<button class="small" data-only="${k}">${l}</button>`).join('')}</div>
    </div></div>
    <div class="client-grid" id="client-grid"></div>`;
  render();
  const qi = main().querySelector('#client-q');
  qi.addEventListener('input', () => { clientsFilter.q = qi.value; render(); });
  autocomplete(qi, { source: () => cabinet.map((c) => ({ value: '', label: c.name, hint: c.matricule_fiscal || '', fill: c.name })) });
  main().querySelectorAll('[data-only]').forEach((b) => b.addEventListener('click', () => { clientsFilter.only = b.dataset.only; render(); }));
  main().querySelector('#new-client').addEventListener('click', () => openClientModal(null));
}

function openClientModal(c) {
  const isNew = !c;
  c = c || {};
  const m = openModal(isNew ? 'Nouveau client' : `Modifier ${c.name}`, `
    <form id="client-form" style="padding:18px 20px">
      <div class="grid-2">
        <div class="field"><label for="cf-name">Raison sociale</label><input id="cf-name" name="name" value="${esc(c.name)}" required></div>
        <div class="field"><label for="cf-mf">Matricule fiscal</label><input id="cf-mf" name="matricule_fiscal" value="${esc(c.matricule_fiscal)}" placeholder="1234567/A/M/000"></div>
        <div class="field"><label for="cf-act">Activité</label><input id="cf-act" name="activity" value="${esc(c.activity)}" placeholder="ex. pharmacie, commerce de détail…"></div>
        <div class="field"><label for="cf-sales">Ce que vend la société</label><select id="cf-sales" name="sales_type">${Object.entries(SALES_LABEL).map(([k, l]) => `<option value="${k}" ${c.sales_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <p class="small muted">Chaque client a son propre dossier : ses documents, son plan comptable et sa comptabilité sont séparés des autres.</p>
      <div class="row"><span class="spacer"></span>
        ${!isNew && c.role === 'owner' ? '<button type="button" class="danger ghost" id="cf-delete">Supprimer le dossier</button>' : ''}
        <button type="button" data-close>Annuler</button><button class="primary">${isNew ? 'Créer le dossier' : 'Enregistrer'}</button></div>
    </form>`, { width: 760 });
  m.el.querySelector('#client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const res = isNew ? await api('/companies', { method: 'POST', body }) : await api(`/companies/${c.id}`, { method: 'PUT', body });
      if (isNew) { state.companyId = res.company.id; store('ec_company', String(res.company.id)); }
      m.close();
      toast(isNew ? 'Dossier client créé' : 'Client enregistré');
      if (isNew) openAccessModal(res.company, true);
      viewClients();
    } catch (err) { toast(err.message, 'error'); }
  });
  m.el.querySelector('#cf-delete')?.addEventListener('click', async () => {
    if (!confirm(`Supprimer le dossier ${c.name}, tous ses documents et toutes ses écritures ?`)) return;
    await api(`/companies/${c.id}`, { method: 'DELETE' });
    m.close();
    if (state.companyId === c.id) state.companyId = null;
    await loadCompanies();
    renderSidebar();
    viewClients();
  });
}

// Accès au dossier : inviter le client (ou un collaborateur), voir et retirer les accès.
async function openAccessModal(c, justCreated = false) {
  const m = openModal(`Accès au dossier ${c.name}`, '<div style="padding:18px 20px" id="access-body">Chargement…</div>', { width: 820 });
  const body = m.el.querySelector('#access-body');
  const load = async () => {
    const { owner, members, invitations } = await api(`/companies/${c.id}/members`);
    const roleLabel = { owner: 'Cabinet (propriétaire)', staff: 'Collaborateur', client: 'Client' };
    body.innerHTML = `
      ${justCreated ? '<div class="alert info">Dossier créé ✓ Invitez maintenant votre client : il pourra scanner et envoyer ses documents lui-même, depuis son téléphone.</div>' : ''}
      <div class="grid-2">
        <div>
          <h3>Inviter</h3>
          <div class="field"><label for="inv-role">Qui ?</label><select id="inv-role">
            <option value="client">Le client — envoie ses documents et suit leur traitement</option>
            <option value="staff">Un collaborateur du cabinet — accès complet au dossier</option></select></div>
          <div class="field"><label for="inv-label">Nom (facultatif)</label><input id="inv-label" placeholder="ex. M. Ben Salah, gérant"></div>
          <button class="primary" id="inv-create">Créer le lien d'invitation</button>
          <div id="inv-result"></div>
        </div>
        <div>
          <h3>Personnes ayant accès</h3>
          <ul class="checks">
            ${owner ? `<li class="check"><span>🏢</span><div><b>${esc(owner.name || owner.email)}</b><div class="small muted">${esc(owner.email)} · ${roleLabel.owner}</div></div></li>` : ''}
            ${members.map((u) => `<li class="check"><span>${u.role === 'client' ? '👤' : '🧑‍💼'}</span><div><b>${esc(u.name || u.email)}</b><div class="small muted">${esc(u.email)} · ${roleLabel[u.role] || u.role}</div></div>
              <button class="ghost small danger" data-revoke="${u.id}">Retirer</button></li>`).join('')}
          </ul>
          ${invitations.length ? `<h3 style="margin-top:14px">Invitations en attente</h3><ul class="checks">${invitations.map((i) => `<li class="check"><span>✉️</span><div><b>${esc(i.label || roleLabel[i.role])}</b>
            <div class="small muted">${roleLabel[i.role]} · valable jusqu'au ${fmtDate(i.expires_at)}</div></div>
            <button class="ghost small" data-copy="${esc(i.url)}">Copier</button><button class="ghost small danger" data-cancel="${esc(i.token)}">Annuler</button></li>`).join('')}</ul>` : ''}
        </div>
      </div>`;
    body.querySelector('#inv-create').addEventListener('click', async () => {
      const role = body.querySelector('#inv-role').value;
      const r = await api(`/companies/${c.id}/invitations`, { method: 'POST', body: { role, label: body.querySelector('#inv-label').value } });
      const msg = role === 'client'
        ? `Bonjour, voici votre accès EasyCompta pour envoyer vos factures et relevés à votre comptable (${c.name}) : ${r.url}`
        : `Accès au dossier ${c.name} sur EasyCompta : ${r.url}`;
      body.querySelector('#inv-result').innerHTML = `
        <div class="invite-box">
          <div class="qr-box">${r.qr}</div>
          <input readonly value="${esc(r.url)}" id="inv-url" aria-label="Lien d'invitation">
          <div class="row" style="margin-top:8px">
            <button class="small" id="inv-copy">📋 Copier le lien</button>
            <a class="btn small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">WhatsApp</a>
            <a class="btn small" href="mailto:?subject=${encodeURIComponent('Votre accès EasyCompta')}&body=${encodeURIComponent(msg)}">E-mail</a>
          </div>
          <p class="small muted" style="margin:8px 0 0">Lien à usage unique, valable 14 jours. Le client peut aussi scanner le QR code avec son téléphone.</p>
        </div>`;
      body.querySelector('#inv-copy').addEventListener('click', () => copyText(r.url));
    });
    body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
    body.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/companies/${c.id}/invitations/${encodeURIComponent(b.dataset.cancel)}`, { method: 'DELETE' });
      load();
    }));
    body.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Retirer l\'accès de cette personne au dossier ?')) return;
      await api(`/companies/${c.id}/members/${b.dataset.revoke}`, { method: 'DELETE' });
      toast('Accès retiré');
      load();
    }));
  };
  try { await load(); } catch (err) { body.innerHTML = `<div class="alert error">${esc(err.message)}</div>`; }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Lien copié'); } catch { prompt('Copiez le lien :', text); }
}

// --- Espace client ---------------------------------------------------------------------

async function viewClientHome(seq = routeSeq) {
  const c = company();
  const { documents } = await api(`/companies/${c.id}/documents?limit=15`);
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = documents.filter((d) => String(d.created_at).startsWith(month)).length;
  const inProgress = documents.filter((d) => d.status === 'pending' || d.status === 'processing').length;
  const done = documents.filter((d) => d.status === 'done').length;
  if (seq !== routeSeq) return;
  main().innerHTML = `
    <div class="page-head"><h1>Bonjour ${esc(state.user.name || '')} 👋</h1><span class="muted">${esc(c.name)}</span></div>
    <div class="alert info">Envoyez ici toutes vos pièces : factures d'achat et de vente, tickets, relevés bancaires. Votre comptable les reçoit immédiatement et l'IA en fait la saisie.</div>
    <div class="kpis">
      <div class="card kpi hero"><div class="label">Envoyés ce mois-ci</div><div class="value" data-count="${thisMonth}">${thisMonth}</div></div>
      <div class="card kpi hoverable"><div class="label">En cours de lecture</div><div class="value" data-count="${inProgress}">${inProgress}</div></div>
      <div class="card kpi hoverable"><div class="label">Traités</div><div class="value" style="color:var(--ok)" data-count="${done}">${done}</div></div>
    </div>
    <div class="dash-grid" style="margin-top:16px">
      <div class="stack">
        ${uploadCard()}
        <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">Mes derniers envois</h2><span class="spacer"></span><a href="#/documents">Tout voir →</a></div>${documentsTable(documents)}</div>
      </div>
      <div class="card">
        <h2>📱 Scanner avec mon téléphone</h2>
        <p class="muted small">Scannez ce QR code avec l'appareil photo de votre téléphone : vous pourrez photographier vos factures directement.</p>
        <div id="qr-slot" class="qr-box"><span class="muted small">Génération…</span></div>
      </div>
    </div>`;
  bindUpload(() => viewClientHome());
  bindDocRows();
  generateQr(main().querySelector('#qr-slot'));
  if (inProgress) startPolling(viewClientHome, 5000);
  else stopPolling();
}

function viewClientDocument({ document: doc, pages }) {
  const x = doc.extracted || {};
  const inv = x.invoice || {};
  const preview = pages.map((p) => (p.mime === 'application/pdf'
    ? `<iframe src="/api/documents/${doc.id}/pages/${p.page_no}" title="Page ${p.page_no}"></iframe>`
    : `<img src="/api/documents/${doc.id}/pages/${p.page_no}" alt="Page ${p.page_no}" loading="lazy">`)).join('');
  const statusText = {
    pending: 'Votre document est dans la file : l\'IA va le lire dans un instant.',
    processing: 'L\'IA est en train de lire votre document.',
    done: 'Document lu et transmis à votre comptable ✓',
    review: 'Document lu ; votre comptable va vérifier quelques points.',
    duplicate: 'Ce document avait déjà été envoyé : il n\'est pas compté deux fois.',
    error: 'Le document n\'a pas pu être lu. Votre comptable est prévenu ; vous pouvez aussi le renvoyer avec une photo plus nette.',
  };
  main().innerHTML = `
    <div class="page-head"><a href="#/documents" class="btn">← Mes documents</a><h1>${esc(doc.summary || doc.original_name)}</h1>${badge(doc.status)}</div>
    <div class="doc-grid">
      <div class="card preview">${preview}</div>
      <div class="stack">
        <div class="alert ${doc.status === 'error' ? 'error' : doc.status === 'done' ? 'info' : 'warn'}">${statusText[doc.status] || ''}</div>
        ${doc.extracted && x.doc_type !== 'releve_bancaire' ? `<div class="card"><h2>Ce que l'IA a lu</h2><dl class="kv">
          <dt>Type</dt><dd>${esc(DOC_TYPE_LABELS[x.doc_type] || x.doc_type)}</dd>
          <dt>Fournisseur</dt><dd>${esc(inv.supplier_name)}</dd>
          <dt>Client</dt><dd>${esc(inv.customer_name)}</dd>
          <dt>N° / date</dt><dd>${esc(inv.number)} — ${fmtDate(inv.date)}</dd>
          <dt>Total TTC</dt><dd class="mono">${money(inv.total_ttc)} DT</dd></dl></div>` : ''}
        ${x.doc_type === 'releve_bancaire' ? `<div class="card"><h2>Relevé bancaire</h2><p>${x.bank?.transactions?.length || 0} mouvement(s) lus, du ${fmtDate(x.bank?.period_start)} au ${fmtDate(x.bank?.period_end)}.</p></div>` : ''}
        <p class="small muted">Envoyé le ${fmtDateTime(doc.created_at)} ${doc.source === 'mobile' ? 'depuis le téléphone' : 'depuis le site'}.</p>
      </div>
    </div>`;
  if (doc.status === 'pending' || doc.status === 'processing') {
    clearInterval(pollTimer);
    const seq = routeSeq;
    pollTimer = setInterval(async () => {
      if (seq !== routeSeq) return clearInterval(pollTimer);
      const d = await api(`/documents/${doc.id}`).catch(() => null);
      if (d && seq === routeSeq && d.document.status !== doc.status) { clearInterval(pollTimer); viewClientDocument(d); }
    }, 4000);
  }
}

// --- Invitation (lien reçu par le client ou un collaborateur) --------------------------------

async function renderInvite(token, mode = 'new', error = '') {
  let info;
  try { info = await api(`/invitations/${encodeURIComponent(token || '')}`); } catch (err) { info = { error: err.message }; }
  root.innerHTML = `
  <div class="auth-wrap">
    <section class="auth-hero">
      <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
      ${logo('', true)}
      <h1>${info.error ? 'Invitation' : `${esc(info.inviter_name || 'Votre comptable')} vous invite sur EasyCompta`}</h1>
      <p class="lead">${info.error ? '' : info.role === 'client'
        ? `Envoyez vos factures et relevés bancaires de <b>${esc(info.company_name)}</b> en les photographiant : votre comptable les reçoit tout de suite.`
        : `Accès complet au dossier <b>${esc(info.company_name)}</b>.`}</p>
    </section>
    <div class="auth-side"><div class="card auth-card">
      <div style="text-align:center">${logo()}</div>
      ${info.error ? `<div class="alert error" style="margin-top:14px">${esc(info.error)}</div><a class="btn primary" href="/" style="width:100%">Aller à la connexion</a>` : `
      <div class="tabs" role="tablist">
        <button data-mode="new" class="${mode === 'new' ? 'active' : ''}">Créer mon accès</button>
        <button data-mode="existing" class="${mode === 'existing' ? 'active' : ''}">J'ai déjà un compte</button>
      </div>
      <form id="invite-form">
        ${mode === 'new' ? '<div class="field"><label for="iv-name">Votre nom</label><input id="iv-name" name="name" autocomplete="name" required></div>' : ''}
        <div class="field"><label for="iv-email">Email</label><input id="iv-email" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="iv-pass">Mot de passe</label><input id="iv-pass" name="password" type="password" minlength="8" autocomplete="${mode === 'new' ? 'new-password' : 'current-password'}" required></div>
        ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
        <button class="primary" style="width:100%;min-height:46px">${mode === 'new' ? 'Créer mon accès' : 'Me connecter et rejoindre'}</button>
      </form>`}
    </div></div>
  </div>`;
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderInvite(token, b.dataset.mode)));
  root.querySelector('#invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      store('ec_company', String(r.company_id));
      location.href = '/#/dashboard';
    } catch (err) {
      renderInvite(token, mode, err.message);
    }
  });
}

boot();
