import { api, esc, money, fmtDate, fmtDateTime, badge, toast, compressImage, uploadWithProgress, DOC_TYPE_LABELS, STATUS_LABELS as STATUS_TEXT, logo, countUp, downloadCSV } from './common.js';

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

async function loadPlan() {
  if (!state.plan) state.plan = await api('/plan-comptable');
  return state.plan;
}

window.addEventListener('hashchange', () => state.user && route());

// --- Authentification ----------------------------------------------------------

function renderAuth(mode = 'login') {
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

const NAV = [
  ['dashboard', 'Tableau de bord'],
  ['assistant', '✨ Assistant IA'],
  ['documents', 'Documents'],
  ['journal', 'Écritures'],
  ['echeancier', 'Échéancier & lettrage'],
  ['balance', 'Balance & grand livre'],
  ['etats', 'Bilan & résultat'],
  ['immobilisations', 'Immobilisations'],
  ['controles', 'Contrôles'],
  ['declaration', 'Déclaration fiscale'],
  ['tva', 'TVA de l\'année'],
  ['telephone', 'Connecter mon téléphone'],
  ['dossiers', 'Sociétés'],
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
        <label for="company-select">Société</label>
        <select id="company-select"></select>
      </div>
      <nav class="nav" id="nav"></nav>
      <div class="spacer"></div>
      <div class="small muted">${esc(state.user.email)}</div>
      <button class="ghost small" id="logout">Se déconnecter</button>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  setTimeout(() => root.querySelector('#sidebar')?.classList.remove('intro'), 1200);
  root.querySelector('#menu-btn').addEventListener('click', () => root.querySelector('#sidebar').classList.toggle('open'));
  root.querySelector('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    location.hash = '';
    renderAuth();
  });
  root.querySelector('#company-select').addEventListener('change', (e) => {
    state.companyId = Number(e.target.value);
    store('ec_company', String(state.companyId));
    route();
  });
  renderSidebar();
}

function renderSidebar() {
  const sel = root.querySelector('#company-select');
  if (!sel) return;
  sel.innerHTML = state.companies.length
    ? state.companies.map((c) => `<option value="${c.id}" ${c.id === state.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    : '<option>Aucune société</option>';
  const current = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'dashboard';
  const toReview = company()?.to_review || 0;
  root.querySelector('#nav').innerHTML = NAV.map(
    ([id, label], i) =>
      `<a href="#/${id}" style="--i:${i}" class="${current === id ? 'active' : ''}">${label}${id === 'documents' && toReview ? `<span class="count">${toReview}</span>` : ''}</a>`
  ).join('');
}

function main() {
  return root.querySelector('#main');
}

async function route() {
  clearInterval(pollTimer);
  root.querySelector('#sidebar')?.classList.remove('open');
  const [page = 'dashboard', arg] = location.hash.replace(/^#\/?/, '').split('/');
  renderSidebar();
  if (!state.companyId && !['dossiers', 'aide'].includes(page)) return viewNoCompany();
  const loader = root.querySelector('#top-loader');
  loader?.classList.add('on');
  const views = { dashboard: viewDashboard, documents: arg ? () => viewDocument(Number(arg)) : viewDocuments, journal: viewJournal, balance: viewBalance, ledger: () => viewLedger(arg), tva: viewTva, declaration: viewDeclaration, assistant: viewAssistant, echeancier: viewEcheancier, etats: viewEtats, immobilisations: viewImmobilisations, controles: viewControles, telephone: viewPhone, dossiers: viewCompanies, aide: viewHelp };
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
  main().innerHTML = `
    <div class="card" style="max-width:560px">
      <h1>Bienvenue 👋</h1>
      <p>Commencez par créer la société dont vous voulez tenir la comptabilité.</p>
      <a class="btn primary" href="#/dossiers">Ajouter une société</a>
    </div>`;
}

async function refreshCompanyCounts() {
  const { companies } = await api('/companies');
  state.companies = companies;
  renderSidebar();
}

// --- Tableau de bord -----------------------------------------------------------

async function viewDashboard() {
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
  if (inQueue) pollTimer = setInterval(() => softRefresh(viewDashboard), 4000);
}

async function softRefresh(view) {
  if (document.hidden) return;
  const y = window.scrollY;
  await view();
  window.scrollTo(0, y);
  refreshCompanyCounts().catch(() => {});
}

function uploadCard() {
  return `
  <div class="card">
    <h2>Ajouter des documents</h2>
    <div class="dropzone" id="dropzone">
      <div class="drop-icon" aria-hidden="true">📄</div>
      <p><b>Glissez vos factures, tickets ou relevés bancaires ici</b><br><span class="muted small">PDF, JPG, PNG — un fichier = un document. L'IA les lit et passe les écritures automatiquement.</span></p>
      <div class="row" style="justify-content:center">
        <select id="type-hint" style="width:auto">
          <option value="auto">Type : détection automatique</option>
          <option value="facture_achat">Factures d'achat / tickets</option>
          <option value="facture_vente">Factures de vente</option>
          <option value="releve_bancaire">Relevés bancaires</option>
        </select>
        <label class="btn primary" style="margin:0;color:#fff">Choisir des fichiers<input type="file" id="file-input" multiple accept="image/*,application/pdf" class="hidden"></label>
      </div>
      <div id="upload-status" class="small muted" style="margin-top:8px"></div>
    </div>
  </div>`;
}

function bindUpload(after) {
  const zone = main().querySelector('#dropzone');
  const input = main().querySelector('#file-input');
  const status = main().querySelector('#upload-status');
  const send = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    status.textContent = 'Préparation…';
    const form = new FormData();
    for (const f of files) form.append('files', await compressImage(f));
    form.append('type_hint', main().querySelector('#type-hint').value);
    form.append('mode', 'separate');
    try {
      const res = await uploadWithProgress(`/companies/${state.companyId}/documents`, form, (p) => (status.textContent = `Envoi… ${Math.round(p * 100)} %`));
      const dup = res.duplicates?.length || 0;
      status.textContent = dup ? `Déjà importé(s), ignoré(s) : ${res.duplicates.map((d) => d.name).join(', ')}` : '';
      if (res.ids.length) toast(`${res.ids.length} document(s) envoyé(s). L'IA s'en occupe.${dup ? ` ${dup} doublon(s) ignoré(s).` : ''}`);
      else toast(dup > 1 ? 'Ces documents ont déjà été importés.' : 'Ce document a déjà été importé.', 'error');
      after();
    } catch (err) {
      status.textContent = err.message;
    }
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
async function viewDocuments() {
  const c = company();
  const { documents } = await api(`/companies/${c.id}/documents?limit=300${docFilter ? `&status=${docFilter}` : ''}`);
  const filters = [['', 'Tous'], ['review', 'À vérifier'], ['pending', 'En attente'], ['processing', 'En cours'], ['done', 'Comptabilisés'], ['duplicate', 'Doublons'], ['error', 'Erreurs']];
  main().innerHTML = `
    <div class="page-head"><h1>Documents</h1><span class="spacer"></span><button id="docs-export">⬇ Exporter la liste</button></div>
    ${uploadCard()}
    <div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:10px">${filters.map(([v, l]) => `<button class="${docFilter === v ? 'primary' : ''}" data-filter="${v}">${l}</button>`).join('')}
        ${documents.some((d) => d.status === 'error') ? '<span class="spacer"></span><button id="retry-errors">↻ Relancer les documents en erreur</button>' : ''}</div>
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
    pollTimer = setInterval(() => softRefresh(viewDocuments), 4000);
  }
}

async function viewDocument(id) {
  const [{ document: doc, pages, entries }, plan] = await Promise.all([api(`/documents/${id}`), loadPlan()]);
  const x = doc.extracted || {};
  const inv = x.invoice || {};
  const isBank = x.doc_type === 'releve_bancaire';
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
          <dl class="kv">
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
          </dl>
        </div>` : ''}
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">Écritures générées (${entries.length})</h2><span class="spacer"></span>
          ${entries.some((e) => e.status === 'draft') ? '<button class="primary" id="validate-all">✓ Tout valider</button>' : ''}
        </div>
        <datalist id="accounts">${Object.entries(plan.accounts).map(([n, l]) => `<option value="${n}">${esc(l)}</option>`).join('')}</datalist>
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
    pollTimer = setInterval(async () => {
      const { document: d } = await api(`/documents/${id}`);
      if (d.status !== 'pending' && d.status !== 'processing') { clearInterval(pollTimer); viewDocument(id); refreshCompanyCounts(); }
    }, 3000);
  }
}

function entryEditor(e) {
  const journals = state.plan.journals;
  const lineRow = (l = {}) => `
    <tr>
      <td style="width:110px"><input class="mono" list="accounts" name="account" value="${esc(l.account)}" aria-label="Compte"></td>
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
  for (let i = account.length; i > 0; i--) if (accounts[account.slice(0, i)]) return accounts[account.slice(0, i)];
  return '';
}

// --- Écritures (journal) -------------------------------------------------------

const period = { from: `${new Date().getFullYear()}-01-01`, to: `${new Date().getFullYear()}-12-31`, journal: '' };

function periodForm(withJournal) {
  return `<div class="row">
    <div><label for="p-from">Du</label><input type="date" id="p-from" value="${period.from}"></div>
    <div><label for="p-to">Au</label><input type="date" id="p-to" value="${period.to}"></div>
    ${withJournal ? `<div><label for="p-journal">Journal</label><select id="p-journal"><option value="">Tous</option>${Object.entries(state.plan.journals).map(([k, l]) => `<option value="${k}" ${period.journal === k ? 'selected' : ''}>${k} — ${esc(l)}</option>`).join('')}</select></div>` : ''}
  </div>`;
}

function bindPeriod(view) {
  ['p-from', 'p-to', 'p-journal'].forEach((id) => main().querySelector(`#${id}`)?.addEventListener('change', (e) => {
    period[{ 'p-from': 'from', 'p-to': 'to', 'p-journal': 'journal' }[id]] = e.target.value;
    view();
  }));
}

async function viewJournal() {
  await loadPlan();
  const c = company();
  const qs = `from=${period.from}&to=${period.to}${period.journal ? `&journal=${period.journal}` : ''}`;
  const { entries } = await api(`/companies/${c.id}/entries?${qs}`);
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
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">Aucune écriture sur la période.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">Total (${shown.length} écritures)</td><td class="num">${money(td)}</td><td class="num">${money(tc)}</td></tr></tfoot>
    </table></div></div>`;
  bindPeriod(viewJournal);
  const search = main().querySelector('#j-search');
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
      <td style="width:120px"><input class="mono" list="accounts" name="account" value="${esc(l.account)}" placeholder="ex. 626" aria-label="Compte"></td>
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
      <datalist id="accounts">${Object.entries(state.plan.accounts).map(([n, l]) => `<option value="${n}">${esc(l)}</option>`).join('')}</datalist>
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
  main().querySelectorAll('[data-cls]').forEach((b) => b.addEventListener('click', () => { balanceFilter.cls = b.dataset.cls; shown = render(); }));
  main().querySelector('#bal-export').addEventListener('click', () => {
    downloadCSV(`balance-${c.name}-${period.from}-${period.to}`, ['Compte', 'Intitulé', 'Débit', 'Crédit', 'Solde débiteur', 'Solde créditeur'],
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
    <datalist id="accounts">${Object.entries(state.plan.accounts).map(([n, l]) => `<option value="${n}">${esc(l)}</option>`).join('')}</datalist>
    <div class="card" style="margin-bottom:14px">
      <div class="filters">${periodForm(false)}
        <div><label for="gl-acc">Compte (ou début de compte)</label><input id="gl-acc" class="mono" list="accounts" placeholder="ex. 401, 6…" value="${esc(account)}"></div>
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
  acc.addEventListener('change', () => { location.hash = acc.value.trim() ? `#/ledger/${encodeURIComponent(acc.value.trim())}` : '#/ledger'; });
  main().querySelector('#gl-q').addEventListener('input', (ev) => { ledgerFilter.q = ev.target.value; shown = render(); });
  main().querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { ledgerFilter.side = b.dataset.side; shown = render(); }));
  main().querySelector('#gl-export').addEventListener('click', () => {
    downloadCSV(`grand-livre-${c.name}-${account || 'tous'}-${period.from}-${period.to}`,
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

// --- Sociétés ------------------------------------------------------------------

async function viewCompanies() {
  await refreshCompanyCounts();
  const salesLabel = { services: 'Prestations de services (706)', marchandises: 'Vente de marchandises (707)', produits: 'Vente de produits fabriqués (701)' };
  const form = (c = {}) => `
    <form class="company-form" data-id="${c.id || ''}">
      <div class="grid-2">
        <div class="field"><label>Raison sociale</label><input name="name" value="${esc(c.name)}" required></div>
        <div class="field"><label>Matricule fiscal</label><input name="matricule_fiscal" value="${esc(c.matricule_fiscal)}" placeholder="1234567/A/M/000"></div>
        <div class="field"><label>Activité</label><input name="activity" value="${esc(c.activity)}" placeholder="ex. agence web, commerce de détail…"></div>
        <div class="field"><label>Ce que vend la société</label><select name="sales_type">${Object.entries(salesLabel).map(([k, l]) => `<option value="${k}" ${c.sales_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="row"><button class="primary">${c.id ? 'Enregistrer' : 'Ajouter la société'}</button>${c.id ? '<button type="button" class="danger ghost" data-delete>Supprimer</button>' : ''}</div>
    </form>`;
  main().innerHTML = `
    <div class="page-head"><h1>Sociétés</h1></div>
    <p class="muted">Un cabinet peut gérer plusieurs sociétés : chaque société a ses propres documents et sa propre comptabilité.</p>
    <div class="stack">
      ${state.companies.map((c) => `<div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">${esc(c.name)}</h2><span class="muted small">${c.documents} document(s)</span></div>${form(c)}</div>`).join('')}
      <div class="card"><h2>Nouvelle société</h2>${form()}</div>
    </div>`;
  main().querySelectorAll('.company-form').forEach((f) => {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      try {
        const res = f.dataset.id
          ? await api(`/companies/${f.dataset.id}`, { method: 'PUT', body })
          : await api('/companies', { method: 'POST', body });
        if (!f.dataset.id) { state.companyId = res.company.id; store('ec_company', String(res.company.id)); }
        toast('Société enregistrée');
        viewCompanies();
      } catch (err) { toast(err.message, 'error'); }
    });
    f.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm('Supprimer cette société, tous ses documents et toutes ses écritures ?')) return;
      await api(`/companies/${f.dataset.id}`, { method: 'DELETE' });
      if (state.companyId === Number(f.dataset.id)) state.companyId = null;
      await loadCompanies();
      viewCompanies();
    });
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
      <tr><td class="mono">626</td><td>Charge : télécommunications</td><td class="num">1 000,000</td><td></td></tr>
      <tr><td class="mono">4366</td><td>TVA déductible (récupérable)</td><td class="num">190,000</td><td></td></tr>
      <tr><td class="mono">66</td><td>Droit de timbre</td><td class="num">1,000</td><td></td></tr>
      <tr><td class="mono">401</td><td>Dette envers le fournisseur</td><td></td><td class="num">1 191,000</td></tr>
    </tbody></table></div>
    <p style="margin-top:10px"><b>Paiement par banque</b> du fournisseur : débit 401 (la dette disparaît) / crédit 532 (l'argent sort de la banque).</p>
    <h2>Petit lexique</h2>
    <dl>
      <dt>Débit / Crédit</dt><dd>Les deux colonnes d'une écriture. Chaque opération est enregistrée deux fois : d'où vient l'argent et où il va.</dd>
      <dt>Journal</dt><dd>Classement des écritures : ACH (achats), VTE (ventes), BQ (banque), CAI (caisse), OD (opérations diverses).</dd>
      <dt>Plan comptable</dt><dd>La liste officielle des comptes (classe 2 immobilisations, 4 tiers, 5 trésorerie, 6 charges, 7 produits).</dd>
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

async function viewAssistant() {
  const c = company();
  const history = (chats[c.id] ||= []);
  const suggestions = ['Chhal 3andi fel banque taw ?', 'Chkoun mel clients ma 5allasnich ?', 'Chnowa akbar masrouf 3andi hal 3am ?', 'Est-ce que la société est bénéficiaire cette année ?', 'Chnowa lezem n3adi fel déclaration mta3 hal chhar ?'];
  main().innerHTML = `
    <div class="page-head"><h1>✨ Assistant IA</h1><span class="spacer"></span>${history.length ? '<button class="ghost" id="chat-clear">Nouvelle conversation</button>' : ''}</div>
    <div class="card chat">
      <div class="chat-log" id="chat-log">
        ${history.length ? '' : `<div class="muted">Posez une question sur la comptabilité de <b>${esc(c.name)}</b>, en français ou en tounsi. L'assistant répond à partir de vos documents et écritures.</div>
          <div class="chips" style="margin-top:12px">${suggestions.map((q, i) => `<button class="small" style="animation-delay:${i * 60}ms" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
        ${history.map((m) => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.content) : formatAnswer(m.content)}</div>`).join('')}
      </div>
      <form id="chat-form" class="row" style="margin-top:12px;flex-wrap:nowrap">
        <input id="chat-input" placeholder="Votre question…" autocomplete="off" required>
        <button class="primary">Envoyer</button>
      </form>
    </div>`;
  const log = main().querySelector('#chat-log');
  log.scrollTop = log.scrollHeight;
  const ask = async (q) => {
    history.push({ role: 'user', content: q });
    viewAssistant();
    const l = main().querySelector('#chat-log');
    l.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="thinking"><span class="typing"><i></i><i></i><i></i></span></div>');
    l.scrollTop = l.scrollHeight;
    try {
      const { answer } = await api(`/companies/${c.id}/assistant`, { method: 'POST', body: { messages: history } });
      history.push({ role: 'assistant', content: answer });
    } catch (err) {
      history.push({ role: 'assistant', content: `⚠ ${err.message}` });
    }
    if (location.hash.startsWith('#/assistant')) viewAssistant();
  };
  main().querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = main().querySelector('#chat-input').value.trim();
    if (q) ask(q);
  });
  main().querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  main().querySelector('#chat-clear')?.addEventListener('click', () => { chats[c.id] = []; viewAssistant(); });
  main().querySelector('#chat-input').focus();
}

boot();
