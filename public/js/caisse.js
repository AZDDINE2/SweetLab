const state = {
  products: [],        // stock du jour (en parts), renvoyé par /api/stock
  packaging: { parts: { remaining: 0 }, molds: { remaining: 0 } }, // emballages restants du jour
  settings: { parts_per_mold: 8, packaging_price_cents: 0, mold_packaging_cents: 0, toppings: [] },
  cart: new Map(),     // clé "produit|format|place|suppléments" -> { pid, format, place, toppings: [id], qty }
  moldsReturned: 0,    // moules rapportés par le client (pas de prix de moule pour ceux-là)
  category: 'all',
  submitting: false,
  opt: null,           // choix en cours dans la fenêtre d'options
};

const $ = (id) => document.getElementById(id);
const PPM = () => state.settings.parts_per_mold;

const productById = (id) => state.products.find((p) => p.id === id);
const toppingById = (id) => state.settings.toppings.find((t) => t.id === id);
const lineKey = (pid, format, place, toppings) => `${pid}|${format}|${place || ''}|${[...toppings].sort((a, b) => a - b).join(',')}`;
const PLACE_LABELS = { sur_place: 'Sur place', emporter: 'À emporter' };
const partsOf = (line) => line.qty * (line.format === 'moule' ? PPM() : 1);

// "29" -> "3 moules + 5 parts" pour un produit en moule.
function formatParts(parts, p) {
  if (!p || !p.is_flan) return `${parts}`;
  const m = Math.floor(parts / PPM());
  const r = parts % PPM();
  if (!m) return `${r} part${r > 1 ? 's' : ''}`;
  return `${m} moule${m > 1 ? 's' : ''}${r ? ` + ${r}` : ''}`;
}

function partsInCart(pid) {
  let n = 0;
  for (const l of state.cart.values()) if (l.pid === pid) n += partsOf(l);
  return n;
}

function unitPrice(line) {
  const p = productById(line.pid);
  const base = line.format === 'moule' ? p.mold_price_cents : p.price_cents;
  return base + line.toppings.reduce((s, id) => s + (toppingById(id)?.price_cents || 0), 0);
}

function cartLines() {
  return [...state.cart].map(([key, l]) => ({ key, ...l, p: productById(l.pid) })).filter((l) => l.p);
}

// Total de la commande : articles + emballages (à emporter) + prix des moules non rapportés.
function computeTotals() {
  const lines = cartLines();
  const items = lines.reduce((s, l) => s + l.qty * unitPrice(l), 0);
  // 1 emballage par part (produit en moule) emportée.
  const packagingCount = lines.filter((l) => l.p.is_flan && l.format === 'part' && l.place === 'emporter').reduce((s, l) => s + l.qty, 0);
  const packaging = packagingCount * state.settings.packaging_price_cents;
  const molds = lines.filter((l) => l.format === 'moule').reduce((s, l) => s + l.qty, 0);
  if (state.moldsReturned > molds) state.moldsReturned = molds;
  const deposit = (molds - state.moldsReturned) * state.settings.mold_packaging_cents; // emballage moule
  return { lines, items, packagingCount, packaging, molds, deposit, total: items + packaging + deposit };
}

// ---------- Rendu ----------

// Une couleur du logo par catégorie (dans l'ordre d'apparition) : repérer les produits d'un coup d'œil.
const CAT_COLORS = ['#d4633a', '#3f9c8c', '#efaa2e', '#e68da0', '#45281d'];
function catColor(categoryId) {
  const ids = [...new Set(state.products.map((p) => p.category_id))];
  return CAT_COLORS[Math.max(0, ids.indexOf(categoryId)) % CAT_COLORS.length];
}

function renderCategories() {
  const cats = [];
  for (const p of state.products) {
    if (!cats.some((c) => c.id === p.category_id)) cats.push({ id: p.category_id, name: p.category_name });
  }
  if (state.category !== 'all' && !cats.some((c) => c.id === state.category)) state.category = 'all';
  $('cats').innerHTML = [{ id: 'all', name: 'Tout' }, ...cats]
    .map((c) => `<button data-cat="${c.id}" class="${c.id === state.category ? 'active' : ''}"${c.id === 'all' ? '' : ` style="--accent:${catColor(c.id)}"`}>${esc(c.name)}</button>`)
    .join('');
}

function renderGrid() {
  const list = state.products.filter((p) => state.category === 'all' || p.category_id === state.category);
  if (!list.length) {
    $('grid').innerHTML = '<div class="empty">Aucun produit. Le gérant doit d’abord créer des produits.</div>';
    return;
  }
  $('grid').innerHTML = list
    .map((p) => {
      const used = partsInCart(p.id);
      const left = Math.max(p.remaining - used, 0);
      const items = [...state.cart.values()].filter((l) => l.pid === p.id).reduce((s, l) => s + l.qty, 0);
      const badge = p.quantity === 0 ? '<span class="badge badge-muted">Non mis en vente</span>'
        : left === 0 ? '<span class="badge badge-out">Épuisé</span>'
          : `<span class="badge ${left <= 4 ? 'badge-low' : 'badge-ok'}">Reste ${formatParts(left, p)}</span>`;
      return `<button class="product-tile ${used ? 'in-cart' : ''}" data-id="${p.id}" style="--accent:${catColor(p.category_id)}" ${left <= 0 ? 'disabled' : ''}>
          ${items ? `<span class="p-qty" aria-label="${items} dans la commande">${items}</span>` : ''}
          <span class="p-cat">${esc(p.category_name)}</span>
          <span class="p-name">${esc(p.name)}</span>
          ${badge}
        </button>`;
    })
    .join('');
}

const lineDetails = (l) => [l.format === 'moule' ? `Moule entier (${PPM()} parts) · À emporter` : l.p.is_flan ? 'Part' : '',
  l.format !== 'moule' ? PLACE_LABELS[l.place] : '',
  ...l.toppings.map((id) => toppingById(id)?.name).filter(Boolean)].filter(Boolean).join(' · ');

// Panier : uniquement les produits choisis (sans prix). Le montant s'affiche à l'encaissement.
function renderCart() {
  const lines = cartLines();
  $('cartLines').innerHTML = lines.length
    ? lines.map((l) => {
        const details = lineDetails(l);
        const canInc = partsInCart(l.pid) + (l.format === 'moule' ? PPM() : 1) <= l.p.remaining;
        return `<div class="cart-line cart-line-noprice">
            <div class="l-info"><div class="l-name">${esc(l.p.name)}</div>${details ? `<div class="l-sub">${esc(details)}</div>` : ''}</div>
            <div class="qty">
              <button data-dec="${l.key}" aria-label="Retirer un">−</button>
              <span>${l.qty}</span>
              <button data-inc="${l.key}" aria-label="Ajouter un" ${canInc ? '' : 'disabled'}>+</button>
            </div>
            <button class="btn-icon btn-ghost l-del" data-del="${l.key}" aria-label="Supprimer ${esc(l.p.name)}" title="Supprimer">${icon('close')}</button>
          </div>`;
      }).join('')
    : '<div class="empty">Touchez un produit pour l’ajouter.</div>';

  const count = lines.reduce((s, l) => s + l.qty, 0);
  $('cartCount').textContent = count ? `${count} article${count > 1 ? 's' : ''}` : 'Aucun article';
  $('validateBtn').disabled = !lines.length;
  $('cartBarCount').textContent = count;
  $('cartBar').disabled = !lines.length;
  if (!lines.length) closeCart();
}

// ---------- Encaissement : montant de la commande ----------

function openCheckout() {
  if (!state.cart.size) return;
  state.moldsReturned = 0;
  $('checkoutTitle').textContent = 'Encaissement';
  renderPay();
  $('checkoutDialog').showModal();
}

function renderPay() {
  const t = computeTotals();
  const rows = t.lines.map((l) => {
    const details = lineDetails(l);
    return `<div class="pay-line"><span>${l.qty} × ${esc(l.p.name)}${details ? `<small>${esc(details)}</small>` : ''}</span><strong>${money(l.qty * unitPrice(l))}</strong></div>`;
  });
  if (t.packagingCount) {
    const left = state.packaging.parts.remaining;
    const short = t.packagingCount > left;
    rows.push(`<div class="pay-line ${short ? 'warn' : ''}"><span>Emballage${t.packagingCount > 1 ? 's' : ''} part
      <small>${t.packagingCount} × ${money(state.settings.packaging_price_cents)}${short ? ` · plus assez d’emballages déclarés (${left})` : ''}</small></span><strong>${money(t.packaging)}</strong></div>`);
    if (short) rows.push('<div class="pay-line pay-alert"><span>La vente n’est pas bloquée.</span><button type="button" class="btn-sm" data-pack-alert>Prévenir le gérant</button></div>');
  }
  if (t.molds) {
    const needed = t.molds - state.moldsReturned;
    rows.push(`<div class="pay-line"><span>Emballage${needed > 1 ? 's' : ''} moule
      <small>${needed} × ${money(state.settings.mold_packaging_cents)}</small></span><strong>${money(t.deposit)}</strong></div>
      <div class="pay-line pay-return">
        <span>Ancien moule rapporté par le client</span>
        <div class="qty">
          <button data-ret="-1" aria-label="Un de moins" ${state.moldsReturned ? '' : 'disabled'}>−</button>
          <span>${state.moldsReturned}</span>
          <button data-ret="1" aria-label="Un de plus" ${state.moldsReturned < t.molds ? '' : 'disabled'}>+</button>
        </div>
      </div>`);
  }
  $('payLines').innerHTML = rows.join('');
  $('payTotal').textContent = money(t.total);
}

function renderAll() {
  renderCategories();
  renderGrid();
  renderCart();
}

// ---------- Panier ----------

// Sur téléphone, le panier s'ouvre en volet par-dessus les produits.
function openCart() {
  if (state.cart.size) document.body.classList.add('cart-open');
}

function closeCart() {
  document.body.classList.remove('cart-open');
}

function addLine(pid, format, place, toppings, qty) {
  const p = productById(pid);
  if (!p) return false;
  const need = qty * (format === 'moule' ? PPM() : 1);
  const left = p.remaining - partsInCart(pid);
  if (need > left) {
    playSound('error');
    toast(`Il ne reste que ${formatParts(Math.max(left, 0), p)} de « ${p.name} »`, 'error');
    return false;
  }
  const key = lineKey(pid, format, place, toppings);
  const line = state.cart.get(key) || { pid, format, place, toppings: [...toppings], qty: 0 };
  line.qty += qty;
  state.cart.set(key, line);
  playSound('add');
  if (navigator.vibrate) navigator.vibrate(10);
  renderGrid();
  renderCart();
  return true;
}

function changeLine(key, delta) {
  const line = state.cart.get(key);
  if (!line) return;
  if (delta > 0) {
    addLine(line.pid, line.format, line.place, line.toppings, 1);
    return;
  }
  line.qty += delta;
  if (line.qty <= 0) state.cart.delete(key);
  renderGrid();
  renderCart();
}

function clearCart() {
  $('payNote').value = ''; // la note va avec la commande en cours
  state.cart.clear();
  state.moldsReturned = 0;
  renderGrid();
  renderCart();
}

// ---------- Fenêtre d'options (produits en moule) ----------

function openOptions(pid) {
  const p = productById(pid);
  state.opt = { pid, format: 'part', place: null, toppings: new Set(), qty: 1 };
  $('optName').textContent = p.name;
  $('optFormatSec').classList.toggle('hidden', p.mold_price_cents == null);
  $('optToppingsSec').classList.toggle('hidden', !state.settings.toppings.length);
  $('optToppings').innerHTML = state.settings.toppings.map((t) =>
    `<button type="button" class="chip" data-topping="${t.id}" aria-pressed="false">${esc(t.name)}</button>`).join('');
  renderOptions();
  $('optDialog').showModal();
}

function maxQty() {
  const { pid, format } = state.opt;
  const p = productById(pid);
  const left = p.remaining - partsInCart(pid);
  return format === 'moule' ? Math.floor(left / PPM()) : left;
}

function renderOptions() {
  const o = state.opt;
  const p = productById(o.pid);
  const left = p.remaining - partsInCart(o.pid);
  $('optPlaceSec').classList.toggle('hidden', o.format === 'moule');
  $('optMoldNote').classList.toggle('hidden', o.format !== 'moule');
  document.querySelectorAll('#optPlace [data-place]').forEach((b) => {
    const on = b.dataset.place === o.place;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('optFormat').innerHTML = `
    <button type="button" data-format="part" class="${o.format === 'part' ? 'active' : ''}">Part</button>
    <button type="button" data-format="moule" class="${o.format === 'moule' ? 'active' : ''}" ${left < PPM() ? 'disabled' : ''}>
      Moule entier<small>${PPM()} parts</small></button>`;
  document.querySelectorAll('#optToppings [data-topping]').forEach((b) => {
    const on = o.toppings.has(Number(b.dataset.topping));
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const max = maxQty();
  if (o.qty > max) o.qty = Math.max(1, max);
  $('optQty').textContent = o.qty;
  $('optMinus').disabled = o.qty <= 1;
  $('optPlus').disabled = o.qty >= max;
  // Une part doit préciser sur place ou à emporter ; un moule est toujours à emporter.
  const needPlace = o.format === 'part' && !o.place;
  $('optAdd').textContent = needPlace ? 'Choisissez sur place ou à emporter' : 'Ajouter à la commande';
  $('optAdd').disabled = max < 1 || needPlace;
}

$('optFormat').addEventListener('click', (e) => {
  const b = e.target.closest('[data-format]');
  if (!b || b.disabled) return;
  state.opt.format = b.dataset.format;
  state.opt.qty = 1;
  renderOptions();
});
$('optPlace').addEventListener('click', (e) => {
  const b = e.target.closest('[data-place]');
  if (!b) return;
  state.opt.place = b.dataset.place;
  renderOptions();
});
$('optToppings').addEventListener('click', (e) => {
  const b = e.target.closest('[data-topping]');
  if (!b) return;
  const id = Number(b.dataset.topping);
  if (state.opt.toppings.has(id)) state.opt.toppings.delete(id); else state.opt.toppings.add(id);
  renderOptions();
});
$('optMinus').addEventListener('click', () => { state.opt.qty = Math.max(1, state.opt.qty - 1); renderOptions(); });
$('optPlus').addEventListener('click', () => { state.opt.qty = Math.min(maxQty(), state.opt.qty + 1); renderOptions(); });
$('optAdd').addEventListener('click', () => {
  const o = state.opt;
  if (o.format === 'part' && !o.place) return;
  if (addLine(o.pid, o.format, o.format === 'moule' ? 'emporter' : o.place, [...o.toppings], o.qty)) $('optDialog').close();
});
$('optClose').addEventListener('click', () => $('optDialog').close());
$('optDialog').addEventListener('click', (e) => { if (e.target === $('optDialog')) $('optDialog').close(); });

// ---------- Son au clic (généré par le navigateur, aucun fichier audio) ----------

let soundOn = true;
try { soundOn = localStorage.getItem('sweetlab_sound') !== 'off'; } catch { /* stockage indisponible */ }
let audioCtx = null;

// Petit "bip" : aigu pour un produit ajouté, grave pour une erreur (stock épuisé).
function playSound(kind = 'add') {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const [from, to, length] = kind === 'error' ? [320, 200, 0.22] : [880, 1320, 0.12];
    osc.type = kind === 'error' ? 'square' : 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + length * 0.6);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(kind === 'error' ? 0.12 : 0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + length + 0.01);
  } catch { /* son non disponible sur cet appareil */ }
}

function renderSoundBtn() {
  const btn = $('soundBtn');
  btn.innerHTML = icon(soundOn ? 'sound' : 'mute');
  btn.title = soundOn ? 'Couper le son' : 'Activer le son';
  btn.setAttribute('aria-label', btn.title);
}

$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem('sweetlab_sound', soundOn ? 'on' : 'off'); } catch { /* ignore */ }
  renderSoundBtn();
  playSound();
});
renderSoundBtn();

// ---------- Données ----------

// ---------- Emballages terminés : prévenir le gérant ----------

async function reportPackaging() {
  if (!confirm('Prévenir le gérant que les emballages des parts sont terminés ?')) return;
  try {
    await api('/api/alertes', { method: 'POST', body: { kind: 'emballages_parts' } });
    toast('Le gérant est prévenu', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}
$('packAlertBtn').addEventListener('click', reportPackaging);

function renderPackAlert() {
  const p = state.packaging.parts || {};
  $('packAlertBtn').classList.toggle('is-out', (p.declared > 0 || p.used > 0) && p.remaining <= 0);
}

async function loadStock() {
  const data = await api('/api/stock');
  state.products = data.products;
  state.packaging = data.packaging;
  renderPackAlert();
  // Si le stock a baissé entre-temps (autre caisse), on retire du panier ce qui n'est plus disponible.
  for (const [key, l] of state.cart) {
    const p = productById(l.pid);
    if (!p || partsInCart(l.pid) > p.remaining) state.cart.delete(key);
  }
  renderAll();
}

async function loadSettings() {
  state.settings = await api('/api/vente/settings');
  state.packaging = state.settings.packaging;
}

// ---------- Ticket de caisse ----------

// « Imprimer le ticket » : le choix est retenu sur cet appareil (sinon le réglage du gérant).
async function initTicket() {
  const cfg = await ticketConfig();
  let saved = null;
  try { saved = localStorage.getItem('sweetlab_ticket'); } catch { /* stockage indisponible */ }
  $('payPrint').checked = saved === null ? cfg.print_default : saved === 'on';
}
$('payPrint').addEventListener('change', (e) => {
  try { localStorage.setItem('sweetlab_ticket', e.target.checked ? 'on' : 'off'); } catch { /* ignore */ }
});

// Mes ventes du jour, avec un bouton pour réimprimer chaque ticket.
let mySalesOrders = [];
$('mySales').addEventListener('click', () => {
  const list = [...mySalesOrders].reverse();
  $('salesList').innerHTML = list.length
    ? list.map((o) => `<div class="sale-row">
        <div><strong>N° ${o.number}</strong> <span class="muted">${o.created_at.slice(11, 16)}</span>
          <div class="muted sale-items">${o.items.map((i) => `${i.quantity} × ${esc(i.product_name)}`).join(', ')}</div></div>
        <strong class="num">${money(o.total_cents)}</strong>
        <button type="button" class="btn-sm" data-ticket="${o.id}" data-icon="printer"><span>Ticket</span></button>
      </div>`).join('')
    : '<div class="empty">Aucune vente aujourd’hui.</div>';
  $('salesList').querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));
  $('salesDialog').showModal();
});
$('salesList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ticket]');
  if (b) printTicket(Number(b.dataset.ticket)).catch((err) => toast(err.message, 'error'));
});
$('salesClose').addEventListener('click', () => $('salesDialog').close());

async function loadMySales() {
  const { orders } = await api('/api/orders');
  mySalesOrders = orders.filter((o) => o.status === 'valide');
  const valid = orders.filter((o) => o.status === 'valide');
  const total = valid.reduce((s, o) => s + o.total_cents, 0);
  $('mySales').textContent = `${valid.length} vente${valid.length > 1 ? 's' : ''} · ${money(total)}`;
  $('mySales').title = 'Mes ventes du jour';
}

async function validateOrder() {
  if (state.submitting || !state.cart.size) return;
  state.submitting = true;
  $('payValidate').disabled = true;
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: {
        molds_returned: state.moldsReturned,
        note: $('payNote').value,
        items: [...state.cart.values()].map((l) => ({ product_id: l.pid, format: l.format, place: l.place, quantity: l.qty, toppings: l.toppings })),
      },
    });
    toast(`Commande n°${order.number} validée : ${money(order.total_cents)}`, 'success');
    $('checkoutDialog').close();
    if ($('payPrint').checked) printTicket(order.id).catch((err) => toast(`Ticket : ${err.message}`, 'error'));
    $('payNote').value = '';
    clearCart();
  } catch (err) {
    playSound('error');
    toast(err.message, 'error');
  } finally {
    state.submitting = false;
    $('payValidate').disabled = false;
    await Promise.all([loadStock(), loadMySales()]).catch(() => {});
  }
}

// ---------- Événements ----------

$('cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.category = b.dataset.cat === 'all' ? 'all' : Number(b.dataset.cat);
  renderCategories();
  renderGrid();
});

$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b || b.disabled) return;
  const p = productById(Number(b.dataset.id));
  // Produit en moule : part ou moule, sur place ou à emporter, suppléments. Autre produit : ajout direct.
  if (p.is_flan) openOptions(p.id);
  else addLine(p.id, 'part', null, [], 1);
});

$('cartLines').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.inc) changeLine(b.dataset.inc, 1);
  if (b.dataset.dec) changeLine(b.dataset.dec, -1);
  if (b.dataset.del) { state.cart.delete(b.dataset.del); renderGrid(); renderCart(); }
});

// Encaissement
$('validateBtn').addEventListener('click', openCheckout);
$('payLines').addEventListener('click', (e) => {
  if (e.target.closest('[data-pack-alert]')) { reportPackaging(); return; }
  const b = e.target.closest('[data-ret]');
  if (!b) return;
  state.moldsReturned = Math.max(0, state.moldsReturned + Number(b.dataset.ret));
  renderPay();
});
$('payBack').addEventListener('click', () => $('checkoutDialog').close());
$('payValidate').addEventListener('click', validateOrder);
$('checkoutClose').addEventListener('click', () => $('checkoutDialog').close());
$('clearBtn').addEventListener('click', clearCart);
$('cartBar').addEventListener('click', openCart);
$('closeCartBtn').addEventListener('click', closeCart);
$('backdrop').addEventListener('click', closeCart);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeCart());
$('logoutBtn').addEventListener('click', logout);

(async function init() {
  const me = await requireRole('caisse', 'gerant');
  $('userName').textContent = me.name;
  $('today').textContent = formatDate(me.today);
  if (me.role === 'gerant') $('gerantLink').classList.remove('hidden');
  await loadSettings();
  initTicket().catch(() => {});
  await Promise.all([loadStock(), loadMySales()]);
  // Rafraîchit le stock régulièrement (ajouts du gérant, ventes des autres caisses) et les réglages.
  setInterval(() => !state.submitting && loadStock().catch(() => {}), 15000);
  setInterval(() => loadSettings().catch(() => {}), 60000);
})();
