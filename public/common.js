// Utilitaires partagés entre le site web et l'application de scan.

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erreur ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export function money(v) {
  const n = Number(v || 0);
  return nf.format(n);
}

export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export const STATUS_LABELS = {
  pending: 'En attente',
  processing: 'Lecture IA…',
  review: 'À vérifier',
  done: 'Comptabilisé',
  error: 'Erreur',
  draft: 'Brouillon',
  duplicate: 'Doublon',
  validated: 'Validée',
};

export const DOC_TYPE_LABELS = {
  facture_achat: 'Facture d\'achat',
  facture_vente: 'Facture de vente',
  avoir_achat: 'Avoir fournisseur',
  avoir_vente: 'Avoir client',
  ticket_caisse: 'Ticket de caisse',
  releve_bancaire: 'Relevé bancaire',
  autre: 'Autre',
};

export function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

let toastTimer;
export function toast(msg, type = 'ok') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3800);
}

// Réduit les photos avant envoi (une photo de téléphone fait souvent 4-8 Mo) et
// les convertit en JPEG (gère aussi le HEIC des iPhone quand le navigateur sait le lire).
export async function compressImage(file, maxSide = 2200, quality = 0.85) {
  if (!file.type.startsWith('image/')) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image illisible'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale === 1 && file.type === 'image/jpeg' && file.size < 1.5 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}

// Envoi avec barre de progression.
export function uploadWithProgress(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* vide */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Erreur ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Connexion impossible. Vérifiez internet.'));
    xhr.send(form);
  });
}

// Export CSV lisible directement par Excel (séparateur « ; », virgule décimale, BOM UTF-8).
// Les cellules numériques (type number) sont écrites avec 3 décimales.
export function downloadCSV(filename, headers, rows) {
  const cell = (v) => {
    if (typeof v === 'number') return v.toFixed(3).replace('.', ',');
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  a.download = `${safe}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Logo adapté au thème (clair / sombre).
export function logo(cls = '', forceLight = false) {
  if (forceLight) return `<img class="brand-logo ${cls}" src="/brand/logo-light.png" alt="EasyCompta">`;
  return `<picture><source srcset="/brand/logo-light.png" media="(prefers-color-scheme: dark)"><img class="brand-logo ${cls}" src="/brand/logo.png" alt="EasyCompta"></picture>`;
}

// Animation des chiffres (compteur qui monte jusqu'à la valeur finale).
export function countUp(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const decimals = Number(el.dataset.decimals || 0);
    const fmt = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const start = performance.now();
    const dur = 900;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt.format(target * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// --- Suggestions (autocomplétion) --------------------------------------------------
// Dès 2 caractères, propose les éléments dont le code commence par la saisie ou
// dont l'intitulé contient tous les mots tapés (sans tenir compte des accents).
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function suggest(items, q, limit = 12) {
  const query = fold(q).trim();
  if (!query) return [];
  const words = query.split(/\s+/);
  const scored = [];
  for (const it of items) {
    const v = fold(it.value);
    const l = fold(it.label);
    let score = -1;
    if (v.startsWith(query)) score = 3 - Math.min(2, (v.length - query.length) / 8);
    else if (words.every((w) => l.includes(w) || v.includes(w))) {
      // Mots qui commencent par la saisie avant les correspondances en milieu de mot.
      const wordStart = words.every((w) => l.split(/[^a-z0-9]+/).some((x) => x.startsWith(w)));
      score = l.startsWith(query) ? 2 : wordStart ? 1.5 : 1;
    }
    if (score >= 0) scored.push([score, it]);
  }
  return scored.sort((a, b) => b[0] - a[0] || String(a[1].value).localeCompare(String(b[1].value))).slice(0, limit).map((s) => s[1]);
}

function highlight(text, q) {
  const t = String(text ?? '');
  const i = fold(t).indexOf(fold(q).trim());
  if (!q || i < 0) return esc(t);
  return `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.trim().length))}</mark>${esc(t.slice(i + q.trim().length))}`;
}

/**
 * @param {HTMLInputElement} input
 * @param {{source: () => {value:string,label:string,hint?:string}[], onPick?: (item) => void, minChars?: number, fill?: 'value'|'label'}} opts
 */
export function autocomplete(input, { source, onPick, minChars = 2, fill = 'value' }) {
  if (input.dataset.acBound) return;
  input.dataset.acBound = '1';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  let box = null;
  let items = [];
  let active = -1;
  const close = () => { box?.remove(); box = null; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const place = () => {
    if (!box) return;
    const r = input.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 368))}px`;
    box.style.top = `${r.bottom + 4}px`;
    box.style.minWidth = `${Math.max(r.width, 260)}px`;
  };
  const pick = (it) => {
    input.value = it.fill ?? (fill === 'label' ? it.label : it.value);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    onPick?.(it);
  };
  const render = () => {
    const q = input.value;
    if (q.trim().length < minChars) return close();
    items = suggest(source() || [], q);
    if (!items.length) return close();
    if (!box) {
      box = document.createElement('div');
      box.className = 'ac-box';
      box.setAttribute('role', 'listbox');
      document.body.appendChild(box);
      input.setAttribute('aria-expanded', 'true');
    }
    active = Math.min(active, items.length - 1);
    box.innerHTML = items.map((it, i) => `<div class="ac-item ${i === active ? 'active' : ''}" role="option" data-i="${i}">
      <span class="ac-code">${highlight(it.value, q)}</span><span class="ac-label">${highlight(it.label, q)}</span>${it.hint ? `<span class="ac-hint">${esc(it.hint)}</span>` : ''}</div>`).join('');
    box.querySelectorAll('.ac-item').forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(items[Number(el.dataset.i)]); }));
    place();
  };
  input.addEventListener('input', (e) => { if (e.isTrusted) { active = -1; render(); } });
  input.addEventListener('focus', () => { if (input.value.trim().length >= minChars) render(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (!box) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape') close();
  });
  window.addEventListener('scroll', place, true);
}
