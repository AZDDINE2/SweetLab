// Fonctions partagées par toutes les pages.
const CURRENCY = 'DH';
const LOGIN_PATH = '/'; // page de connexion du personnel (port 3000)

async function api(path, { method = 'GET', body, noRedirect = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (res.status === 401 && !noRedirect) {
    location.href = LOGIN_PATH;
    throw new Error('Non connecté');
  }
  if (!res.ok) throw new Error((data && data.error) || 'Erreur serveur');
  return data;
}

function money(cents) {
  return (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + CURRENCY;
}

function toCents(value) {
  const n = Number(String(value).trim().replace(',', '.'));
  return value === '' || !Number.isFinite(n) ? NaN : Math.round(n * 100);
}

function centsToInput(cents) {
  return (cents / 100).toFixed(2);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

let toastTimer;
function toast(message, type = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), type === 'error' ? 4500 : 2500);
}

// Page d'accueil après connexion (donnée par le serveur ; valeur de secours si elle manque).
function homeFor(me) {
  if (me && me.home) return me.home;
  return me && me.role === 'gerant' ? '/gerant.html' : '/caisse.html';
}

// Vérifie la session et le rôle ; redirige sinon. Le gérant a aussi accès à la caisse.
async function requireRole(...roles) {
  const me = await api('/api/me');
  if (!roles.includes(me.role)) {
    location.href = homeFor(me);
    throw new Error('Redirection');
  }
  return me;
}

async function logout() {
  await api('/api/logout', { method: 'POST', noRedirect: true });
  location.href = LOGIN_PATH;
}

const ICONS = {
  recap: '<path d="M3 3v18h18"/><path d="M8 17v-6M13 17V7M18 17v-3"/>',
  stock: '<path d="M21 8 12 3 3 8l9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  ventes: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  produits: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5.5-4.5-6.5"/>',
  caisse: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L22 7H6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-4"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v9h14v-9"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  matieres: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  store: '<path d="M3 9l2-5h14l2 5"/><path d="M4 9h16v11H4z"/><path d="M9 20v-6h6v6"/>',
  bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  note: '<path d="M4 4h16v12l-4 4H4z"/><path d="M16 20v-4h4M8 9h8M8 13h5"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/><path d="M19 8v6M16 11h6"/>',
  flan: '<path d="M5 19h14l-2.2-9H7.2z"/><path d="M7.2 10c.6-2.4 2.6-4 4.8-4s4.2 1.6 4.8 4"/><path d="M9 10.5c1 .8 2 .8 3 0s2-.8 3 0"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// Liens SweetLab affichés sur les pages client.
const SHOP_LINKS = {
  instagram: { url: 'https://www.instagram.com/sweetlab_212/', label: '@sweetlab_212' },
  maps: { url: 'https://maps.app.goo.gl/sCFkV68TnB44kcH88', label: 'Nous trouver' },
};

// Remplit les éléments <... data-icon="nom"> du HTML statique.
document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

// Remplit les éléments <... data-shop-links> (Instagram + localisation).
document.querySelectorAll('[data-shop-links]').forEach((el) => {
  el.innerHTML = `
    <a class="shop-link" href="${SHOP_LINKS.instagram.url}" target="_blank" rel="noopener">${icon('instagram')}<span>${SHOP_LINKS.instagram.label}</span></a>
    <a class="shop-link" href="${SHOP_LINKS.maps.url}" target="_blank" rel="noopener">${icon('pin')}<span>${SHOP_LINKS.maps.label}</span></a>`;
});

function stockBadge(remaining, quantity) {
  if (quantity === 0) return '<span class="badge badge-muted">Non mis en vente</span>';
  if (remaining === 0) return '<span class="badge badge-out">Épuisé</span>';
  if (remaining <= Math.max(2, Math.ceil(quantity * 0.2))) return `<span class="badge badge-low">Reste ${remaining}</span>`;
  return `<span class="badge badge-ok">Reste ${remaining}</span>`;
}
