import { api, esc, money, fmtDate, fmtDateTime, badge, toast, compressImage, uploadWithProgress, DOC_TYPE_LABELS } from './common.js';

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
    <div class="card auth-card">
      <div class="brand" style="margin-bottom:6px"><img src="/icons/icon.svg" alt=""> EasyCompta</div>
      <p class="muted">Scannez vos factures et relevés : l'IA fait la saisie comptable.</p>
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
        <button class="primary" style="width:100%;justify-content:center">${mode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
      </form>
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
  ['documents', 'Documents'],
  ['journal', 'Écritures'],
  ['balance', 'Balance & grand livre'],
  ['tva', 'TVA mensuelle'],
  ['telephone', 'Connecter mon téléphone'],
  ['dossiers', 'Sociétés'],
  ['aide', 'Comment ça marche ?'],
];

function renderShell() {
  root.innerHTML = `
  <div class="mobile-bar">
    <button class="ghost" id="menu-btn" aria-label="Menu">☰</button>
    <div class="brand"><img src="/icons/icon.svg" alt=""> EasyCompta</div>
  </div>
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><img src="/icons/icon.svg" alt=""> EasyCompta</div>
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
    ([id, label]) =>
      `<a href="#/${id}" class="${current === id ? 'active' : ''}">${label}${id === 'documents' && toReview ? `<span class="count">${toReview}</span>` : ''}</a>`
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
  const views = { dashboard: viewDashboard, documents: arg ? () => viewDocument(Number(arg)) : viewDocuments, journal: viewJournal, balance: viewBalance, ledger: () => viewLedger(arg), tva: viewTva, telephone: viewPhone, dossiers: viewCompanies, aide: viewHelp };
  try {
    await (views[page] || viewDashboard)();
  } catch (err) {
    if (err.status === 401) return renderAuth();
    main().innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
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
  const [stats, { documents, ai_ready }] = await Promise.all([
    api(`/companies/${c.id}/stats`),
    api(`/companies/${c.id}/documents?limit=8`),
  ]);
  const d = stats.documents;
  const inQueue = (d.pending || 0) + (d.processing || 0);
  main().innerHTML = `
    <div class="page-head"><h1>${esc(c.name)}</h1><span class="muted">Exercice ${new Date().getFullYear()}</span></div>
    ${ai_ready ? '' : '<div class="alert warn">L\'IA n\'est pas encore configurée sur le serveur (variable <b>GEMINI_API_KEY</b> ou <b>ANTHROPIC_API_KEY</b>). Les documents restent en attente.</div>'}
    <div class="kpis">
      <div class="card kpi"><div class="label">En cours de lecture</div><div class="value">${inQueue}</div></div>
      <div class="card kpi"><div class="label">À vérifier</div><div class="value" style="color:var(--warn)">${d.review || 0}</div></div>
      <div class="card kpi"><div class="label">Comptabilisés</div><div class="value" style="color:var(--ok)">${d.done || 0}</div></div>
      <div class="card kpi"><div class="label">Charges ${new Date().getFullYear()}</div><div class="value">${money(stats.totals.charges)}</div></div>
      <div class="card kpi"><div class="label">Chiffre d'affaires</div><div class="value">${money(stats.totals.produits)}</div></div>
      <div class="card kpi"><div class="label">Banque (mouvements)</div><div class="value">${money(stats.totals.banque)}</div></div>
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
      await uploadWithProgress(`/companies/${state.companyId}/documents`, form, (p) => (status.textContent = `Envoi… ${Math.round(p * 100)} %`));
      toast(`${files.length} document(s) envoyé(s). L'IA s'en occupe.`);
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
        <td>${esc(d.summary || d.original_name)}${d.error ? `<div class="small" style="color:var(--danger)">${esc(d.error)}</div>` : ''}</td>
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
  const filters = [['', 'Tous'], ['review', 'À vérifier'], ['pending', 'En attente'], ['processing', 'En cours'], ['done', 'Comptabilisés'], ['error', 'Erreurs']];
  main().innerHTML = `
    <div class="page-head"><h1>Documents</h1></div>
    ${uploadCard()}
    <div class="card" style="margin-top:16px">
      <div class="row" style="margin-bottom:10px">${filters.map(([v, l]) => `<button class="${docFilter === v ? 'primary' : ''}" data-filter="${v}">${l}</button>`).join('')}
        ${documents.some((d) => d.status === 'error') ? '<span class="spacer"></span><button id="retry-errors">↻ Relancer les documents en erreur</button>' : ''}</div>
      ${documentsTable(documents)}
    </div>`;
  main().querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { docFilter = b.dataset.filter; viewDocuments(); }));
  bindUpload(() => viewDocuments());
  bindDocRows();
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
        ${doc.error ? `<div class="alert error">${esc(doc.error)}</div>` : ''}
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
      toast(err.message);
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
  let td = 0, tc = 0;
  const rows = entries.map((e) => {
    const lines = e.lines.map((l) => {
      td += Number(l.debit); tc += Number(l.credit);
      return `<tr><td></td><td class="mono">${esc(l.account)}</td><td>${esc(l.label)}<div class="small muted">${esc(l.account_label)}</div></td><td class="num">${Number(l.debit) ? money(l.debit) : ''}</td><td class="num">${Number(l.credit) ? money(l.credit) : ''}</td></tr>`;
    }).join('');
    return `<tr class="entry-head"><td>${fmtDate(e.entry_date)}</td><td>${e.journal}</td><td>${esc(e.label)} ${e.document_id ? `<a href="#/documents/${e.document_id}" class="small">pièce</a>` : ''}</td><td colspan="2" style="text-align:right">${badge(e.status)}</td></tr>${lines}`;
  }).join('');
  main().innerHTML = `
    <div class="page-head"><h1>Écritures comptables</h1><span class="spacer"></span>
      <a class="btn" href="/api/companies/${c.id}/export.csv?${qs}">⬇ Exporter (Excel / CSV)</a></div>
    <div class="card" style="margin-bottom:14px">${periodForm(true)}</div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">Aucune écriture sur la période.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">Total (${entries.length} écritures)</td><td class="num">${money(td)}</td><td class="num">${money(tc)}</td></tr></tfoot>
    </table></div></div>`;
  bindPeriod(viewJournal);
}

// --- Balance & grand livre -----------------------------------------------------

async function viewBalance() {
  await loadPlan();
  const c = company();
  const { accounts } = await api(`/companies/${c.id}/balance?from=${period.from}&to=${period.to}`);
  let td = 0, tc = 0;
  const rows = accounts.map((a) => {
    const d = Number(a.debit), cr = Number(a.credit);
    td += d; tc += cr;
    const solde = d - cr;
    return `<tr class="clickable" data-acc="${esc(a.account)}"><td class="mono">${esc(a.account)}</td><td>${esc(accountLabelOf(a.account) || a.account_label)}</td><td class="num">${money(d)}</td><td class="num">${money(cr)}</td><td class="num">${solde > 0 ? money(solde) : ''}</td><td class="num">${solde < 0 ? money(-solde) : ''}</td></tr>`;
  }).join('');
  main().innerHTML = `
    <div class="page-head"><h1>Balance générale</h1></div>
    <div class="card" style="margin-bottom:14px">${periodForm(false)}<p class="small muted" style="margin:8px 0 0">Cliquez sur un compte pour voir son grand livre (le détail des mouvements).</p></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Compte</th><th>Intitulé</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde débiteur</th><th class="num">Solde créditeur</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">Aucune écriture.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${money(td)}</td><td class="num">${money(tc)}</td><td colspan="2" class="num">${Math.round(td * 1000) === Math.round(tc * 1000) ? '✓ équilibrée' : '⚠ déséquilibrée'}</td></tr></tfoot>
    </table></div></div>`;
  bindPeriod(viewBalance);
  main().querySelectorAll('[data-acc]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/ledger/${tr.dataset.acc}`)));
}

async function viewLedger(account) {
  await loadPlan();
  const c = company();
  const { lines } = await api(`/companies/${c.id}/ledger?account=${encodeURIComponent(account)}&from=${period.from}&to=${period.to}`);
  let solde = 0;
  const rows = lines.map((l) => {
    solde += Number(l.debit) - Number(l.credit);
    return `<tr><td>${fmtDate(l.entry_date)}</td><td>${l.journal}</td><td>${esc(l.label)}${l.third_party ? `<div class="small muted">${esc(l.third_party)}</div>` : ''}</td><td class="num">${Number(l.debit) ? money(l.debit) : ''}</td><td class="num">${Number(l.credit) ? money(l.credit) : ''}</td><td class="num">${money(solde)}</td><td>${l.document_id ? `<a href="#/documents/${l.document_id}" class="small">pièce</a>` : ''}</td></tr>`;
  }).join('');
  main().innerHTML = `
    <div class="page-head"><a class="btn" href="#/balance">← Balance</a><h1>Grand livre — ${esc(account)} ${esc(accountLabelOf(account))}</h1></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Jnl</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">Aucun mouvement.</td></tr>'}</tbody>
    </table></div></div>`;
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
      <select id="tva-year" style="width:auto">${[0, 1, 2, 3].map((i) => new Date().getFullYear() - i).map((y) => `<option ${y === tvaYear ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
    <div class="alert info">En Tunisie, la TVA se déclare chaque mois (avant le 28 du mois suivant pour les sociétés). <b>TVA à payer</b> = TVA collectée sur vos ventes − TVA déductible sur vos achats. Si le résultat est négatif, c'est un crédit de TVA reporté sur le mois suivant. Montants indicatifs, à faire valider avant déclaration.</div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Mois</th><th class="num">CA HT</th><th class="num">TVA collectée</th><th class="num">TVA déductible</th><th class="num">TVA à payer</th><th class="num">Crédit reporté</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">Aucune donnée pour cette année.</td></tr>'}</tbody>
    </table></div></div>`;
  main().querySelector('#tva-year').addEventListener('change', (e) => { tvaYear = Number(e.target.value); viewTva(); });
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
      } catch (err) { toast(err.message); }
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
      <li><b>Export</b> : la balance, le grand livre, la TVA du mois et l'export Excel sont prêts pour l'expert-comptable ou la déclaration.</li>
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

boot();
