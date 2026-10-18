const $ = (id) => document.getElementById(id);
const state = { me: null, tab: 'recap', date: null, categories: [] };

const DATE_TABS = ['recap', 'stock', 'ventes', 'fond'];

// cards: true -> sur téléphone, chaque ligne devient une fiche (libellés repris des en-têtes).
function table(headers, rows, foot, { cards = false, empty = 'Aucune donnée pour cette journée.' } = {}) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  const th = headers.map((h) => `<th class="${h.num ? 'num' : ''}">${h.label}</th>`).join('');
  const html = `<table class="${cards ? 'cards' : ''}"><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table>`;
  if (!cards) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((td, i) => headers[i] && headers[i].label && td.setAttribute('data-label', headers[i].label));
  });
  return tpl.innerHTML;
}

async function run(action, successMsg) {
  try {
    const r = await action();
    if (successMsg) toast(successMsg, 'success');
    return r;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

// ---------- Récap ----------

async function loadRecap() {
  const s = await api(`/api/summary?date=${state.date}`);
  const t = s.totals;
  // byProduct est trié par quantité décroissante : le premier est le top vente.
  const top = s.byProduct[0];
  const topKpi = top
    ? `<div class="kpi kpi-top"><div class="label">Top vente du jour</div>
         <div class="value value-text" title="${esc(top.name)}">${esc(top.name)}</div>
         <div class="sub">${[top.parts ? `${top.parts} part${top.parts > 1 ? 's' : ''}` : '', top.molds ? `${top.molds} moule${top.molds > 1 ? 's' : ''}` : ''].filter(Boolean).join(' + ')} · ${money(top.revenue_cents)}</div></div>`
    : `<div class="kpi kpi-top"><div class="label">Top vente du jour</div><div class="value muted">—</div></div>`;
  $('kpis').innerHTML = topKpi + [
    ['Nombre de ventes', t.orders],
    ['Chiffre d’affaires', money(t.revenue_cents)],
    ['Parts vendues', t.parts_sold],
    ['Moules entiers vendus', t.molds_sold],
    ['Panier moyen', money(t.average_cents)],
    ['À emporter', `${t.takeaway_orders} commande${t.takeaway_orders > 1 ? 's' : ''}`],
    ['Emballages parts', `${t.packaging_count} · ${money(t.packaging_cents)}`],
    ['Emballages moules', `${t.mold_packaging_count} · ${money(t.mold_deposit_cents)}${t.molds_returned ? ` (+${t.molds_returned} rapporté${t.molds_returned > 1 ? 's' : ''})` : ''}`],
  ].map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  $('byProduct').innerHTML = table(
    [{ label: 'Produit' }, { label: 'Parts', num: true }, { label: 'Moules', num: true }, { label: 'Montant', num: true }],
    s.byProduct.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.parts}</td><td class="num">${r.molds}</td><td class="num">${money(r.revenue_cents)}</td></tr>`),
    s.byProduct.length
      ? (t.packaging_cents ? `<tr class="muted"><td>Emballages parts</td><td class="num" colspan="2">${t.packaging_count}</td><td class="num">${money(t.packaging_cents)}</td></tr>` : '')
        + (t.mold_deposit_cents ? `<tr class="muted"><td>Emballages moules</td><td class="num" colspan="2">${t.mold_packaging_count}</td><td class="num">${money(t.mold_deposit_cents)}</td></tr>` : '')
        + `<tr><td>Total</td><td class="num">${t.parts_sold}</td><td class="num">${t.molds_sold}</td><td class="num">${money(t.revenue_cents)}</td></tr>`
      : ''
  );
  $('byCategory').innerHTML = table(
    [{ label: 'Catégorie' }, { label: 'Qté', num: true }, { label: 'Montant', num: true }],
    s.byCategory.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.quantity}</td><td class="num">${money(r.revenue_cents)}</td></tr>`)
  );
  $('byCashier').innerHTML = table(
    [{ label: 'Caissier' }, { label: 'Ventes', num: true }, { label: 'Montant', num: true }],
    s.byCashier.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.orders}</td><td class="num">${money(r.revenue_cents)}</td></tr>`)
  );
  $('lastDays').innerHTML = table(
    [{ label: 'Jour' }, { label: 'Ventes', num: true }, { label: 'Montant', num: true }],
    s.lastDays.map((r) => {
      const d = new Date(r.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
      const strong = r.date === s.date ? ' style="font-weight:700"' : '';
      return `<tr${strong}><td>${d}</td><td class="num">${r.orders}</td><td class="num">${money(r.revenue_cents)}</td></tr>`;
    })
  );
  $('recapStock').innerHTML = stockSummaryTable(s.stock);

  columnChart($('daysChart'), s.lastDays.map((r) => {
    const d = new Date(r.date + 'T12:00:00');
    return {
      label: d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }),
      value: r.revenue_cents,
      title: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
      orders: r.orders,
    };
  }), 'Chiffre d’affaires des 7 derniers jours');
}

// ---------- Graphiques (barres verticales en SVG) ----------

const charts = new Map(); // élément -> { rows, label }, pour redessiner au redimensionnement

function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

const compactDH = (dh) => (dh >= 1000 ? `${(dh / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}k` : String(dh));

// Barre arrondie (4px) côté valeur, carrée côté ligne de base.
function barPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function columnChart(el, rows, label) {
  charts.set(el, { rows, label });
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) {
    el.innerHTML = '<div class="empty">Aucune vente sur cette période.</div>';
    return;
  }

  const W = Math.max(el.clientWidth, 260), H = 220;
  const m = { t: 22, r: 4, b: 26, l: 44 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const maxDH = max / 100;
  const step = niceStep(maxDH);
  const top = Math.ceil(maxDH / step) * step;
  const y = (cents) => m.t + ph - (cents / 100 / top) * ph;
  const band = pw / rows.length;
  const bw = Math.min(24, band * 0.6);
  const labelEvery = Math.ceil(34 / band); // évite que les libellés de l'axe se chevauchent
  const maxIndex = rows.findIndex((r) => r.value === max);

  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = y(v * 100);
    svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text class="tick" x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${compactDH(v)}</text>`;
  }
  rows.forEach((r, i) => {
    const cx = m.l + band * i + band / 2;
    if (r.value > 0) {
      const yy = y(r.value);
      svg += `<path class="bar" data-i="${i}" d="${barPath(cx - bw / 2, yy, bw, m.t + ph - yy)}"/>`;
    }
    if (i === maxIndex) {
      svg += `<text class="cap" x="${cx}" y="${y(r.value) - 6}" text-anchor="middle">${Math.round(r.value / 100).toLocaleString('fr-FR')} ${CURRENCY}</text>`;
    }
    if (i % labelEvery === 0) {
      svg += `<text class="tick" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>`;
    }
    svg += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>`;
  });

  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${svg}</svg><div class="chart-tip" hidden></div>`;
}

function showChartTip(el, i) {
  const { rows } = charts.get(el);
  const r = rows[i];
  const tip = el.querySelector('.chart-tip');
  const hit = el.querySelector(`.hit[data-i="${i}"]`);
  el.querySelectorAll('.bar').forEach((b) => b.classList.toggle('hover', b.dataset.i === String(i)));
  tip.innerHTML = `<strong>${esc(r.title)}</strong><div>${money(r.value)}</div><div class="muted">${r.orders} vente(s)</div>`;
  tip.hidden = false;
  const cx = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
  const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), el.clientWidth - tip.offsetWidth);
  tip.style.left = `${left}px`;
}

function hideChartTip(el) {
  const tip = el.querySelector('.chart-tip');
  if (tip) tip.hidden = true;
  el.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
}

for (const id of ['daysChart']) {
  const el = $(id);
  const onPointer = (e) => {
    const hit = e.target.closest('.hit');
    if (hit) showChartTip(el, Number(hit.dataset.i));
  };
  el.addEventListener('pointermove', onPointer);
  el.addEventListener('pointerdown', onPointer); // toucher sur téléphone / tablette
  el.addEventListener('pointerleave', () => hideChartTip(el));
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [el, { rows, label }] of charts) if (el.offsetParent) columnChart(el, rows, label);
  }, 150);
});

// ---------- Quantités en moules + parts ----------

const PPM = 8; // 1 moule = 8 parts

// 29 -> "3 moules + 5" pour un produit en moule ; nombre simple pour les autres produits.
function fmtParts(parts, p) {
  if (!p || !p.is_flan) return `${parts}`;
  const m = Math.floor(parts / PPM);
  const r = parts % PPM;
  if (!m) return `${r} part${r > 1 ? 's' : ''}`;
  return `${m} moule${m > 1 ? 's' : ''}${r ? ` + ${r}` : ''}`;
}

function stockSummaryTable(products) {
  return table(
    [{ label: 'Produit' }, { label: 'Préparation', num: true }, { label: 'Mis en vente', num: true }, { label: 'Vendu', num: true }, { label: 'Restant', num: true }, { label: '' }],
    products.map((p) => `<tr>
      <td class="c-title"><strong>${esc(p.name)}</strong><div class="cell-sub">${esc(p.category_name)}</div></td>
      <td class="num">${fmtParts(p.prep, p)}</td>
      <td class="num">${fmtParts(p.quantity, p)}</td>
      <td class="num">${fmtParts(p.sold, p)}</td>
      <td class="num"><strong>${fmtParts(p.remaining, p)}</strong></td>
      <td>${stockBadge(p.remaining, p.quantity).replace(/Reste \d+/, `Reste ${fmtParts(p.remaining, p)}`)}</td></tr>`),
    '',
    { cards: true }
  );
}

// ---------- Stock : préparation, vente, emballages ----------

let stockData = null;

const MOVE_LABELS = {
  production: 'Production',
  mise_en_vente: 'Mise en vente (préparation → vente)',
  correction_preparation: 'Correction préparation',
  correction_vente: 'Ouverture (stock de vente)',
};

async function loadStock() {
  const [data, vente] = await Promise.all([api(`/api/stock?date=${state.date}`), api('/api/vente/settings')]);
  stockData = data;
  const f = $('venteForm');
  f.packaging_price.value = centsToInput(vente.packaging_price_cents).replace('.', ',');
  f.mold_packaging.value = centsToInput(vente.mold_packaging_cents).replace('.', ',');
  renderStock();
}

function renderStock() {
  const { products, packaging, moves } = stockData;
  const unitLabel = (p) => (p.is_flan ? 'Moules' : 'Unités');

  $('prepTable').innerHTML = table(
    [{ label: 'Produit' }, { label: 'En préparation', num: true }, { label: 'Quantité' }],
    products.map((p) => `<tr data-id="${p.id}">
      <td class="c-title"><strong>${esc(p.name)}</strong><div class="cell-sub">${esc(p.category_name)}</div></td>
      <td class="num"><strong>${fmtParts(p.prep, p)}</strong></td>
      <td class="c-full"><div class="stock-actions">
        <div class="stock-qty">
          <label class="mini">${unitLabel(p)} <input type="number" min="1" step="1" inputmode="numeric" placeholder="0" data-q="qty"></label>
        </div>
        <div class="cell-actions">
          <button class="btn-sm" data-act="production">+ Production</button>
          <button class="btn-sm btn-primary" data-act="vente"${p.prep < (p.is_flan ? PPM : 1) ? ' disabled title="Rien à mettre en vente"' : ''}>Mettre en vente →</button>
          <button class="btn-sm btn-ghost" data-act="corriger">Corriger</button>
        </div>
      </div></td></tr>`),
    '',
    { cards: true, empty: 'Aucun produit actif.' }
  );

  $('venteTable').innerHTML = table(
    [{ label: 'Produit' }, { label: 'Ouverture', num: true }, { label: '+ Préparation', num: true }, { label: 'Vendu', num: true },
      { label: 'Restant', num: true }, { label: 'Stock d’ouverture' }],
    products.map((p) => `<tr data-id="${p.id}">
      <td class="c-title"><strong>${esc(p.name)}</strong><div class="cell-sub">${esc(p.category_name)} · ${money(p.price_cents)}${p.mold_price_cents != null ? ` · moule ${money(p.mold_price_cents)}` : ''}</div></td>
      <td class="num">${fmtParts(p.opening, p)}</td>
      <td class="num">${p.transferred ? `+${fmtParts(p.transferred, p)}` : '—'}</td>
      <td class="num">${fmtParts(p.sold, p)}</td>
      <td class="num">${stockBadge(p.remaining, p.quantity).replace(/Reste \d+/, `Reste ${fmtParts(p.remaining, p)}`)}</td>
      <td class="c-full"><div class="stock-actions">
        <div class="stock-qty">
          <label class="mini">${unitLabel(p)} <input type="number" min="0" step="1" inputmode="numeric" placeholder="${p.is_flan ? Math.floor(p.opening / PPM) : p.opening}" data-q="open"></label>
        </div>
        <div class="cell-actions"><button class="btn-sm" data-act="ouverture">Définir</button></div>
      </div></td></tr>`),
    '',
    { cards: true, empty: 'Aucun produit actif.' }
  );

  $('packBlocks').innerHTML = [['part', 'Emballages parts', packaging.parts]]
    .map(([kind, label, b]) => `<div class="pack-block" data-kind="${kind}">
      <div class="pack-head">
        <strong>${label}</strong>
        <span class="muted">${b.used} utilisé${b.used > 1 ? 's' : ''} sur ${b.declared}</span>
        <span class="badge ${b.remaining ? 'badge-ok' : 'badge-out'}">Reste ${b.remaining}</span>
      </div>
      <div class="row">
        <input type="number" min="0" step="1" inputmode="numeric" placeholder="0" data-pack-qty style="width:110px" aria-label="Nombre d’${label.toLowerCase()}">
        <button class="btn-sm btn-primary" data-pack="add">Ajouter</button>
        <button class="btn-sm" data-pack="set">Corriger le total</button>
      </div>
    </div>`).join('');

  $('movesList').innerHTML = moves.length
    ? `<table><tbody>${moves.map((m) => `<tr>
        <td class="muted" style="width:52px">${m.created_at.slice(11, 16)}</td>
        <td>${MOVE_LABELS[m.kind] || m.kind}</td>
        <td>${esc(m.product_name)}</td>
        <td class="num"><strong>${m.parts > 0 ? '+' : m.parts < 0 ? '−' : ''}${fmtParts(Math.abs(m.parts), stockData.products.find((p) => p.name === m.product_name) || {})}</strong></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Aucun mouvement pour cette journée.</div>';
  renderCount();
}

let correcting = null;

// Les produits en moule se produisent et se mettent en vente par moules entiers (1 moule = 8 parts).
$('prepTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const tr = b.closest('tr');
  const id = Number(tr.dataset.id);
  const p = stockData.products.find((x) => x.id === id);
  if (b.dataset.act === 'corriger') {
    correcting = p;
    $('correctTitle').textContent = `Corriger la préparation « ${p.name} »`;
    $('correctMoldsLabel').classList.toggle('hidden', !p.is_flan);
    $('correctPartsName').textContent = p.is_flan ? 'Parts' : 'Unités';
    $('correctMolds').value = p.is_flan ? Math.floor(p.prep / PPM) : 0;
    $('correctParts').value = p.is_flan ? p.prep % PPM : p.prep;
    $('correctDialog').showModal();
    return;
  }
  const qty = Number(tr.querySelector('[data-q="qty"]').value || 0);
  if (!Number.isInteger(qty) || qty < 1) return toast('Saisissez une quantité', 'error');
  const parts = p.is_flan ? qty * PPM : qty;
  const production = b.dataset.act === 'production';
  if (!production && parts > p.prep) {
    return toast(`Pas assez en préparation : ${fmtParts(p.prep, p)} disponible(s)`, 'error');
  }
  try {
    stockData = await api(production ? '/api/stock/preparation' : '/api/stock/mise-en-vente', {
      method: 'POST', body: { date: state.date, product_id: id, parts },
    });
    toast(production
      ? `Production : +${fmtParts(parts, p)} — ${p.name}`
      : `Mis en vente : ${fmtParts(parts, p)} — ${p.name} (préparation −${fmtParts(parts, p)})`, 'success');
    renderStock();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Stock d'ouverture du stock de vente (ex. 3 moules le matin). Il ne touche pas à la préparation.
$('venteTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act="ouverture"]');
  if (!b) return;
  const tr = b.closest('tr');
  const p = stockData.products.find((x) => x.id === Number(tr.dataset.id));
  const raw = tr.querySelector('[data-q="open"]').value;
  const qty = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(qty) || qty < 0) return toast('Saisissez une quantité', 'error');
  const parts = p.is_flan ? qty * PPM : qty;
  try {
    stockData = await api('/api/stock/ouverture', { method: 'POST', body: { date: state.date, product_id: p.id, parts } });
    toast(`Ouverture : ${fmtParts(parts, p)} — ${p.name}`, 'success');
    renderStock();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('correctCancel').addEventListener('click', () => $('correctDialog').close());
$('correctSave').addEventListener('click', async () => {
  const p = correcting;
  const molds = p.is_flan ? Number($('correctMolds').value || 0) : 0;
  const rest = Number($('correctParts').value || 0);
  if (![molds, rest].every((n) => Number.isInteger(n) && n >= 0)) return toast('Quantités invalides', 'error');
  const prep = molds * PPM + rest;
  try {
    if (prep !== p.prep) stockData = await api('/api/stock/preparation', { method: 'POST', body: { date: state.date, product_id: p.id, parts: prep, mode: 'set' } });
    toast('Stock de préparation corrigé', 'success');
    $('correctDialog').close();
  } catch (err) {
    toast(err.message, 'error');
  }
  loadStock();
});

// ----- Comptage de fin de journée : ce qui reste vraiment dans le stock de vente -----

// Écart compté − attendu, en clair : « Juste », « Manque 2 parts », « En plus 1 moule ».
function countGap(counted, expected, p) {
  if (!Number.isFinite(counted)) return '<span class="muted">—</span>';
  const d = counted - expected;
  if (d === 0) return '<span class="badge badge-ok">Juste</span>';
  return d < 0
    ? `<span class="badge badge-out">Manque ${fmtParts(-d, p)}</span>`
    : `<span class="badge badge-low">En plus ${fmtParts(d, p)}</span>`;
}

// Quantité saisie sur une ligne de comptage (en parts pour un produit en moule), NaN si rien n'est saisi.
function countedFromRow(row, isMold) {
  const val = (q) => row.querySelector(`[data-c="${q}"]`)?.value.trim() ?? '';
  const molds = val('molds');
  const parts = val('parts');
  if (molds === '' && parts === '') return NaN;
  const m = Number(molds || 0);
  const r = Number(parts || 0);
  if (![m, r].every((n) => Number.isInteger(n) && n >= 0)) return NaN;
  return isMold ? m * PPM + r : r;
}

function renderCount() {
  const { products, packaging, count } = stockData;
  // Valeurs déjà tapées : gardées si le tableau est redessiné (après une mise en vente, par exemple).
  const typed = {};
  document.querySelectorAll('#countTable [data-count-row]').forEach((row) => {
    const vals = [...row.querySelectorAll('input')].map((i) => i.value);
    if (vals.some((v) => v.trim() !== '')) typed[row.dataset.countRow] = vals;
  });

  const onSale = products.filter((p) => p.quantity > 0);
  const packs = [['part', 'Emballages parts', packaging.parts]]
    .filter(([, , b]) => b.declared > 0 || b.used > 0);
  if (!onSale.length && !packs.length) {
    $('countTable').innerHTML = '<div class="empty">Rien n’a été mis en vente pour cette journée.</div>';
    $('countSave').disabled = true;
    $('countStatus').textContent = '';
    return;
  }
  $('countSave').disabled = false;

  const saved = (id) => count?.products?.[id];
  const inputs = (key, isMold, savedParts) => {
    const v = typed[key];
    const molds = v ? v[0] : (savedParts != null && isMold ? Math.floor(savedParts / PPM) : '');
    const parts = v ? v[isMold ? 1 : 0] : (savedParts != null ? (isMold ? savedParts % PPM : savedParts) : '');
    return isMold
      ? `<label class="mini">Moules <input type="number" min="0" step="1" inputmode="numeric" data-c="molds" value="${molds}" placeholder="0"></label>
         <label class="mini">Parts <input type="number" min="0" step="1" inputmode="numeric" data-c="parts" value="${parts}" placeholder="0"></label>`
      : `<label class="mini">${key.startsWith('pack-') ? 'Nombre' : 'Unités'} <input type="number" min="0" step="1" inputmode="numeric" data-c="parts" value="${parts}" placeholder="0"></label>`;
  };

  const rows = onSale.map((p) => {
    const s = saved(p.id);
    const counted = typed[`p-${p.id}`] ? NaN : (s ? s.counted : NaN);
    return `<tr data-count-row="p-${p.id}" data-id="${p.id}">
      <td class="c-title"><strong>${esc(p.name)}</strong><div class="cell-sub">${esc(p.category_name)}</div></td>
      <td class="num">${fmtParts(p.remaining, p)}</td>
      <td class="c-full"><div class="stock-qty">${inputs(`p-${p.id}`, Boolean(p.is_flan), s ? s.counted : null)}</div></td>
      <td class="num" data-gap>${countGap(counted, p.remaining, p)}</td></tr>`;
  });
  for (const [kind, label, b] of packs) {
    const s = count?.packaging?.[kind];
    rows.push(`<tr data-count-row="pack-${kind}" data-kind="${kind}" class="count-pack">
      <td class="c-title"><strong>${label}</strong><div class="cell-sub">${b.used} utilisé${b.used > 1 ? 's' : ''} sur ${b.declared}</div></td>
      <td class="num">${b.remaining}</td>
      <td class="c-full"><div class="stock-qty">${inputs(`pack-${kind}`, false, s ? s.counted : null)}</div></td>
      <td class="num" data-gap>${countGap(typed[`pack-${kind}`] ? NaN : (s ? s.counted : NaN), b.remaining, null)}</td></tr>`);
  }
  $('countTable').innerHTML = table(
    [{ label: 'Produit' }, { label: 'Devrait rester', num: true }, { label: 'Reste compté' }, { label: 'Écart', num: true }],
    rows, '', { cards: true }
  );
  // Recalcule l'écart des lignes tapées avant le redessin.
  document.querySelectorAll('#countTable [data-count-row]').forEach((row) => typed[row.dataset.countRow] && updateCountRow(row));
  renderCountStatus();
}

function updateCountRow(row) {
  if (row.dataset.kind) {
    const b = stockData.packaging.parts;
    row.querySelector('[data-gap]').innerHTML = countGap(countedFromRow(row, false), b.remaining, null);
    return;
  }
  const p = stockData.products.find((x) => x.id === Number(row.dataset.id));
  row.querySelector('[data-gap]').innerHTML = countGap(countedFromRow(row, Boolean(p.is_flan)), p.remaining, p);
}

// Résumé du comptage enregistré : ce qui reste, et les écarts.
function renderCountStatus() {
  const { count, products } = stockData;
  if (!count) { $('countStatus').textContent = 'Pas encore de comptage pour cette journée.'; return; }
  const left = [];
  const gaps = [];
  for (const p of products) {
    const c = count.products[p.id];
    if (!c) continue;
    if (c.counted > 0) left.push(`${esc(p.name)} : ${fmtParts(c.counted, p)}`);
    if (c.counted !== c.expected) gaps.push(`${esc(p.name)} ${c.counted < c.expected ? '−' : '+'}${fmtParts(Math.abs(c.counted - c.expected), p)}`);
  }
  for (const [kind, label] of [['part', 'emballages parts']]) {
    const c = count.packaging[kind];
    if (!c) continue;
    if (c.counted > 0) left.push(`${c.counted} ${label}`);
    if (c.counted !== c.expected) gaps.push(`${label} ${c.counted < c.expected ? '−' : '+'}${Math.abs(c.counted - c.expected)}`);
  }
  $('countStatus').innerHTML = `<span class="badge badge-ok">Comptage enregistré à ${count.created_at.slice(11, 16)}${count.user_name ? ` par ${esc(count.user_name)}` : ''}</span>
    <div><strong>Reste :</strong> ${left.length ? left.join(' · ') : 'rien'}</div>
    ${gaps.length ? `<div class="count-gaps"><strong>Écarts :</strong> ${gaps.join(' · ')}</div>` : '<div>Aucun écart.</div>'}`;
}

$('countTable').addEventListener('input', (e) => {
  const row = e.target.closest('[data-count-row]');
  if (row) updateCountRow(row);
});

$('countSave').addEventListener('click', async () => {
  const products = [];
  const packaging = {};
  let bad = false;
  document.querySelectorAll('#countTable [data-count-row]').forEach((row) => {
    if (row.dataset.kind) {
      const v = countedFromRow(row, false);
      if (Number.isFinite(v)) packaging[row.dataset.kind] = v;
      else if ([...row.querySelectorAll('input')].some((i) => i.value.trim() !== '')) bad = true;
      return;
    }
    const p = stockData.products.find((x) => x.id === Number(row.dataset.id));
    const v = countedFromRow(row, Boolean(p.is_flan));
    if (Number.isFinite(v)) products.push({ product_id: p.id, parts: v });
    else if ([...row.querySelectorAll('input')].some((i) => i.value.trim() !== '')) bad = true;
  });
  if (bad) return toast('Quantités invalides (nombres entiers)', 'error');
  if (!products.length && !Object.keys(packaging).length) return toast('Saisissez au moins une quantité comptée', 'error');
  try {
    stockData = await api('/api/stock/comptage', { method: 'POST', body: { date: state.date, products, packaging } });
    renderStock();
    toast('Comptage enregistré', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('packBlocks').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pack]');
  if (!b) return;
  const block = b.closest('[data-kind]');
  const kind = block.dataset.kind;
  const mode = b.dataset.pack;
  const quantity = Number(block.querySelector('[data-pack-qty]').value);
  if (!Number.isInteger(quantity) || quantity < (mode === 'add' ? 1 : 0)) return toast('Nombre d’emballages invalide', 'error');
  try {
    stockData = await api('/api/stock/emballages', { method: 'POST', body: { date: state.date, kind, quantity, mode } });
    const what = kind === 'moule' ? 'emballage(s) moule' : 'emballage(s) part';
    toast(mode === 'add' ? `+${quantity} ${what}` : `Total corrigé : ${quantity} ${what}`, 'success');
    renderStock();
    loadAlerts().catch(() => {}); // l'alerte « emballages terminés » est traitée par l'ajout
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('venteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const packaging_price_cents = toCents(f.packaging_price.value);
  const mold_packaging_cents = toCents(f.mold_packaging.value);
  if (![packaging_price_cents, mold_packaging_cents].every((v) => Number.isFinite(v) && v >= 0)) return toast('Prix invalide', 'error');
  await run(() => api('/api/vente/settings', { method: 'PUT', body: { packaging_price_cents, mold_packaging_cents } }),
    'Prix des emballages enregistrés').catch(() => {});
  loadStock();
});

// ---------- Ventes ----------

async function loadOrders() {
  const { orders } = await api(`/api/orders?date=${state.date}`);
  if (!orders.length) {
    $('ordersList').innerHTML = '<div class="card empty">Aucune vente pour cette journée.</div>';
    return;
  }
  $('ordersList').innerHTML = orders.map((o) => {
    const cancelled = o.status === 'annulee';
    const items = o.items.map((i) => {
      const extra = [i.format === 'moule' ? 'moule' : '', i.place === 'emporter' && i.format !== 'moule' ? 'à emporter' : i.place === 'sur_place' ? 'sur place' : '',
        ...(i.toppings || [])].filter(Boolean).join(', ');
      return `${i.quantity} × ${esc(i.product_name)}${extra ? ` <span class="muted">(${esc(extra)})</span>` : ''}`;
    }).join(' · ');
    const extras = [
      o.packaging_count ? `${o.packaging_count} emballage${o.packaging_count > 1 ? 's' : ''} part ${money(o.packaging_cents)}` : '',
      o.molds_count ? `emballage${o.molds_count > 1 ? 's' : ''} moule : ${o.mold_deposit_cents ? money(o.mold_deposit_cents) : 'moule rapporté'}${o.molds_returned && o.mold_deposit_cents ? ` (${o.molds_returned} rapporté)` : ''}` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="order ${cancelled ? 'cancelled' : ''}">
      <div class="order-head">
        <strong>N° ${o.number}</strong>
        <span class="muted">${o.created_at.slice(11, 16)} · ${esc(o.cashier_name)}</span>
        <span class="badge ${o.mode === 'sur_place' ? 'badge-muted' : 'badge-low'}">${{ emporter: 'À emporter', mixte: 'Sur place + à emporter' }[o.mode] || 'Sur place'}</span>
        ${cancelled ? `<span class="badge badge-out">Annulée à ${o.cancelled_at.slice(11, 16)}</span>` : ''}
        <span class="order-total">${money(o.total_cents)}</span>
        <button class="btn-sm btn-icon" data-ticket="${o.id}" title="Imprimer le ticket" aria-label="Imprimer le ticket n° ${o.number}">${icon('printer')}</button>
      </div>
      <div class="order-items">${items}${extras ? `<br>${extras}` : ''}</div>
      ${o.note ? `<div class="order-note">${icon('note')}<span>${esc(o.note)}</span></div>` : ''}
    </div>`;
  }).join('');
}

// ---------- Produits, suppléments, réglages de vente, catégories ----------

function categoryOptions(selected) {
  return state.categories.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

// "" -> null (pas de prix moule) ; sinon centimes.
function optionalCents(value) {
  if (String(value).trim() === '') return null;
  return toCents(value);
}

async function loadCatalogue() {
  const [categories, products, toppings] = await Promise.all([api('/api/categories'), api('/api/products'), api('/api/toppings')]);
  state.categories = categories;
  $('newProductForm').category_id.innerHTML = categoryOptions();

  $('productsTable').innerHTML = table(
    [{ label: 'Nom' }, { label: 'Catégorie' }, { label: 'Prix part (DH)' }, { label: 'Prix moule (DH)' }, { label: 'En moule' }, { label: 'Actif' }, { label: '' }],
    products.map((p) => `<tr data-id="${p.id}">
      <td class="c-full"><input type="text" name="name" value="${esc(p.name)}" aria-label="Nom"></td>
      <td class="c-full"><select name="category_id" aria-label="Catégorie">${categoryOptions(p.category_id)}</select></td>
      <td><input name="price" inputmode="decimal" value="${centsToInput(p.price_cents)}" style="width:95px" aria-label="Prix de la part"></td>
      <td><input name="mold_price" inputmode="decimal" value="${p.mold_price_cents != null ? centsToInput(p.mold_price_cents) : ''}" placeholder="—" style="width:95px" aria-label="Prix du moule"></td>
      <td><input type="checkbox" name="is_flan" ${p.is_flan ? 'checked' : ''} aria-label="En moule" title="Préparé en moules de 8 parts : vente à la part ou au moule entier, suppléments, emballages"></td>
      <td><input type="checkbox" name="active" ${p.active ? 'checked' : ''} aria-label="Actif"></td>
      <td class="c-full"><div class="cell-actions">
        <button class="btn-sm btn-primary" data-save-product>Enregistrer</button>
        <button class="btn-sm btn-danger" data-delete-product>Supprimer</button>
      </div></td></tr>`),
    '',
    { cards: true, empty: 'Aucun produit.' }
  );

  $('toppingsTable').innerHTML = table(
    [{ label: 'Supplément' }, { label: 'Prix (DH)' }, { label: 'Actif' }, { label: '' }],
    toppings.map((t) => `<tr data-id="${t.id}">
      <td class="c-full"><input type="text" name="name" value="${esc(t.name)}" aria-label="Nom"></td>
      <td><input name="price" inputmode="decimal" value="${centsToInput(t.price_cents)}" style="width:90px" aria-label="Prix"></td>
      <td><input type="checkbox" name="active" ${t.active ? 'checked' : ''} aria-label="Actif"></td>
      <td><button class="btn-sm btn-primary" data-save-topping>Enregistrer</button></td></tr>`),
    '',
    { cards: true, empty: 'Aucun supplément.' }
  );


  $('categoriesTable').innerHTML = table(
    [{ label: 'Nom' }, { label: 'Produits', num: true }, { label: '' }],
    categories.map((c) => `<tr data-id="${c.id}">
      <td class="c-full"><input type="text" name="name" value="${esc(c.name)}" aria-label="Nom"></td>
      <td class="num">${c.product_count}</td>
      <td class="c-full"><div class="cell-actions">
        <button class="btn-sm btn-primary" data-save-category>Enregistrer</button>
        <button class="btn-sm btn-danger" data-delete-category>Supprimer</button>
      </div></td></tr>`),
    '',
    { cards: true, empty: 'Aucune catégorie.' }
  );
}

$('newProductForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const price_cents = toCents(f.price.value);
  const mold_price_cents = optionalCents(f.mold_price.value);
  if (!Number.isFinite(price_cents) || price_cents < 0) return toast('Prix de la part invalide', 'error');
  if (mold_price_cents !== null && (!Number.isFinite(mold_price_cents) || mold_price_cents < 0)) return toast('Prix du moule invalide', 'error');
  await run(() => api('/api/products', {
    method: 'POST',
    body: { name: f.name.value, category_id: Number(f.category_id.value), price_cents, mold_price_cents, is_flan: f.is_flan.checked },
  }), 'Produit ajouté').then(() => { f.name.value = ''; f.price.value = ''; f.mold_price.value = ''; }).catch(() => {});
  loadCatalogue();
});

$('productsTable').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.closest('[data-save-product]')) {
    const price_cents = toCents(tr.querySelector('[name=price]').value);
    const mold_price_cents = optionalCents(tr.querySelector('[name=mold_price]').value);
    if (!Number.isFinite(price_cents) || price_cents < 0) return toast('Prix de la part invalide', 'error');
    if (mold_price_cents !== null && (!Number.isFinite(mold_price_cents) || mold_price_cents < 0)) return toast('Prix du moule invalide', 'error');
    await run(() => api(`/api/products/${id}`, {
      method: 'PUT',
      body: {
        name: tr.querySelector('[name=name]').value,
        category_id: Number(tr.querySelector('[name=category_id]').value),
        price_cents,
        mold_price_cents,
        is_flan: tr.querySelector('[name=is_flan]').checked,
        active: tr.querySelector('[name=active]').checked,
      },
    }), 'Produit enregistré').catch(() => {});
    loadCatalogue();
  }
  if (e.target.closest('[data-delete-product]')) {
    if (!confirm('Supprimer ce produit ? (s’il a déjà été vendu, il sera seulement désactivé)')) return;
    const r = await run(() => api(`/api/products/${id}`, { method: 'DELETE' })).catch(() => null);
    if (r) toast(r.deleted ? 'Produit supprimé' : 'Produit déjà vendu : désactivé', 'success');
    loadCatalogue();
  }
});

$('newToppingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const price_cents = toCents(f.price.value);
  if (!Number.isFinite(price_cents) || price_cents < 0) return toast('Prix invalide', 'error');
  await run(() => api('/api/toppings', { method: 'POST', body: { name: f.name.value, price_cents } }), 'Supplément ajouté')
    .then(() => f.reset()).catch(() => {});
  loadCatalogue();
});

$('toppingsTable').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-save-topping]')) return;
  const tr = e.target.closest('tr[data-id]');
  const price_cents = toCents(tr.querySelector('[name=price]').value);
  if (!Number.isFinite(price_cents) || price_cents < 0) return toast('Prix invalide', 'error');
  await run(() => api(`/api/toppings/${tr.dataset.id}`, {
    method: 'PUT',
    body: { name: tr.querySelector('[name=name]').value, price_cents, active: tr.querySelector('[name=active]').checked },
  }), 'Supplément enregistré').catch(() => {});
  loadCatalogue();
});

$('newCategoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await run(() => api('/api/categories', { method: 'POST', body: { name: f.name.value } }), 'Catégorie ajoutée')
    .then(() => { f.name.value = ''; })
    .catch(() => {});
  loadCatalogue();
});

$('categoriesTable').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.closest('[data-save-category]')) {
    await run(() => api(`/api/categories/${id}`, {
      method: 'PUT',
      body: { name: tr.querySelector('[name=name]').value },
    }), 'Catégorie enregistrée').catch(() => {});
    loadCatalogue();
  }
  if (e.target.closest('[data-delete-category]')) {
    if (!confirm('Supprimer cette catégorie ?')) return;
    await run(() => api(`/api/categories/${id}`, { method: 'DELETE' }), 'Catégorie supprimée').catch(() => {});
    loadCatalogue();
  }
});

// ---------- Utilisateurs ----------

// ---------- Ticket de caisse : réglages et aperçu ----------

// Commande d'exemple pour l'aperçu et l'impression de test.
const SAMPLE_ORDER = {
  number: 12, created_at: `${new Date().toISOString().slice(0, 10)} 15:42:00`, cashier_name: 'Caisse 1', mode: 'mixte', status: 'valide',
  items: [
    { quantity: 2, product_name: 'Quesillo classique', format: 'part', place: 'sur_place', toppings: ['Sauce Nutella'], line_total_cents: 5000 },
    { quantity: 1, product_name: 'Quesillo coco', format: 'moule', place: 'emporter', toppings: [], line_total_cents: 18000 },
    { quantity: 1, product_name: 'Café', format: 'part', place: null, toppings: [], line_total_cents: 1000 },
  ],
  packaging_count: 0, packaging_cents: 0, molds_count: 1, molds_returned: 0, mold_deposit_cents: 2000,
  total_cents: 25000, note: 'Au nom de Sara',
};

function ticketFormValues() {
  const f = $('ticketForm');
  return { phone: f.phone.value, address: f.address.value, instagram: f.instagram.value, footer: f.footer.value,
    width: Number(f.width.value), print_default: f.print_default.checked };
}
function renderTicketPreview() {
  const cfg = ticketFormValues();
  $('ticketPreview').className = `ticket w${cfg.width}`;
  $('ticketPreview').innerHTML = ticketHtml(SAMPLE_ORDER, cfg);
}
async function loadTicketSettings() {
  const cfg = await ticketConfig(true);
  const f = $('ticketForm');
  f.phone.value = cfg.phone; f.address.value = cfg.address; f.instagram.value = cfg.instagram; f.footer.value = cfg.footer;
  f.width.value = String(cfg.width); f.print_default.checked = cfg.print_default;
  renderTicketPreview();
}
$('ticketForm').addEventListener('input', renderTicketPreview);
$('ticketForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await run(() => api('/api/ticket/settings', { method: 'PUT', body: ticketFormValues() }), 'Ticket enregistré').catch(() => {});
  loadTicketSettings().catch(() => {});
});
$('ticketTest').addEventListener('click', async () => {
  await api('/api/ticket/settings', { method: 'PUT', body: ticketFormValues() }).catch(() => {});
  await ticketConfig(true);
  printTicket(SAMPLE_ORDER).catch((err) => toast(err.message, 'error'));
});

// Réimpression depuis l'onglet Ventes.
$('ordersList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ticket]');
  if (b) printTicket(Number(b.dataset.ticket)).catch((err) => toast(err.message, 'error'));
});

async function loadUsers() {
  loadTicketSettings().catch(() => {});
  const users = await api('/api/users');
  $('usersTable').innerHTML = table(
    [{ label: 'Identifiant' }, { label: 'Nom' }, { label: 'Rôle' }, { label: 'Nouveau mot de passe' }, { label: 'Actif' }, { label: '' }],
    users.map((u) => `<tr data-id="${u.id}">
      <td class="c-title"><strong>${esc(u.username)}</strong></td>
      <td class="c-full"><input type="text" name="name" value="${esc(u.name)}" aria-label="Nom"></td>
      <td>${u.role === 'gerant' ? 'Gérant' : 'Caisse'}</td>
      <td class="c-full"><input type="password" name="password" placeholder="(inchangé)" autocomplete="new-password" style="width:150px" aria-label="Nouveau mot de passe"></td>
      <td><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${u.id === state.me.id ? 'disabled' : ''} aria-label="Actif"></td>
      <td class="c-full"><div class="cell-actions"><button class="btn-sm btn-primary" data-save-user>Enregistrer</button></div></td></tr>`),
    '',
    { cards: true }
  );
}

$('newUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await run(() => api('/api/users', {
    method: 'POST',
    body: { username: f.username.value, name: f.name.value, role: f.role.value, password: f.password.value },
  }), 'Utilisateur créé').then(() => f.reset()).catch(() => {});
  loadUsers();
});

$('usersTable').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-save-user]')) return;
  const tr = e.target.closest('tr[data-id]');
  await run(() => api(`/api/users/${tr.dataset.id}`, {
    method: 'PUT',
    body: {
      name: tr.querySelector('[name=name]').value,
      password: tr.querySelector('[name=password]').value || undefined,
      active: tr.querySelector('[name=active]').checked,
    },
  }), 'Utilisateur enregistré').catch(() => {});
  loadUsers();
});

// ---------- Navigation ----------

// ---------- Clients fidélité : toute la gestion de la fidélité ----------

const formatDay = (dt) => (dt ? new Date(dt.replace(' ', 'T')).toLocaleDateString('fr-FR') : '—');
const formatPhone = (p) => (p.startsWith('+') ? p : p.replace(/(\d{2})(?=\d)/g, '$1 '));
let loyalty = null;

// Adresse du QR code : l'adresse publique réglée, sinon le port 3001 de cette machine.
function loyaltyBase() {
  return loyalty.public_url || `${location.protocol}//${location.hostname}:${loyalty.public_port}`;
}

async function loadClients() {
  const search = $('clientSearch').value.trim();
  const [{ stamps_required: req, totals, customers }, settings] = await Promise.all([
    api(`/api/fidelite/clients?q=${encodeURIComponent(search)}`),
    loyalty ? Promise.resolve(loyalty) : api('/api/loyalty/settings'),
  ]);
  if (!loyalty) {
    loyalty = settings;
    renderLoyaltySettings();
  }
  const withReward = customers.filter((c) => c.stamps >= req).length;
  $('clientsKpis').innerHTML = [
    ['Clients inscrits', totals.customers],
    ['Visites aujourd’hui', totals.visits_today],
    ['Récompense disponible', withReward],
    ['Récompenses utilisées', totals.rewards_used],
  ].map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  $('clientsTable').innerHTML = table(
    [{ label: 'Client' }, { label: 'Carte' }, { label: 'Visites', num: true }, { label: 'Récompenses', num: true }, { label: 'Dernière visite' }, { label: '' }],
    customers.map((c) => `<tr data-id="${c.id}" data-name="${esc(c.name)}">
      <td class="c-title"><strong>${esc(c.name)}</strong><div class="cell-sub">${esc(formatPhone(c.phone))}</div></td>
      <td><strong>${c.stamps}</strong> / ${req} ${c.stamps >= req ? '<span class="badge badge-ok">Récompense</span>' : ''}</td>
      <td class="num">${c.visits}</td>
      <td class="num">${c.rewards_used}</td>
      <td>${formatDay(c.last_visit)}</td>
      <td class="c-full"><div class="cell-actions">
        <button class="btn-sm ${c.visited_today ? '' : 'btn-primary'}" data-visit ${c.visited_today ? 'disabled' : ''}>${c.visited_today ? 'Visite comptée ✓' : '+ Visite'}</button>
        ${c.stamps >= req ? '<button class="btn-sm btn-success" data-redeem>Offrir la récompense</button>' : ''}
        <button class="btn-sm btn-icon" data-adjust="-1" title="Retirer une visite de la carte" aria-label="Retirer une visite de la carte">−1</button>
        <button class="btn-sm btn-icon" data-adjust="1" title="Ajouter une visite sur la carte" aria-label="Ajouter une visite sur la carte">+1</button>
      </div></td></tr>`),
    '',
    { cards: true, empty: search ? 'Aucun client trouvé.' : 'Aucun client inscrit pour l’instant.' }
  );
}

function renderLoyaltySettings() {
  const f = $('loyaltyForm');
  f.stamps_required.value = loyalty.stamps_required;
  f.reward_label.value = loyalty.reward_label;
  f.public_url.value = loyalty.public_url || '';
  const url = `${loyaltyBase()}/`;
  $('joinQr').src = `/api/qr.svg?data=${encodeURIComponent(url)}`;
  $('downloadQr').href = `/api/qr.png?data=${encodeURIComponent(url)}`;
  $('posterText').textContent = `${loyalty.stamps_required} visites = ${loyalty.reward_label}`;
  $('posterInsta').textContent = `Instagram ${SHOP_LINKS.instagram.label}`;
  $('posterLink').textContent = `Lien du QR code : ${url}`;
  $('urlWarn').classList.toggle('hidden', !/\/\/(localhost|127\.|\[::1\])/.test(url));
}

let clientSearchTimer;
$('clientSearch').addEventListener('input', () => {
  clearTimeout(clientSearchTimer);
  clientSearchTimer = setTimeout(() => loadClients().catch((err) => toast(err.message, 'error')), 250);
});

$('clientsTable').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  const b = e.target.closest('button');
  if (!tr || !b) return;
  const { id, name } = tr.dataset;
  try {
    if (b.hasAttribute('data-visit')) {
      const c = await api(`/api/fidelite/clients/${id}/visit`, { method: 'POST' });
      toast(`Visite comptée pour ${c.name} (${c.stamps}/${loyalty.stamps_required})`, 'success');
    } else if (b.hasAttribute('data-redeem')) {
      if (!confirm(`Offrir « ${loyalty.reward_label} » à ${name} ?`)) return;
      await api(`/api/fidelite/clients/${id}/redeem`, { method: 'POST' });
      toast(`Récompense offerte à ${name}`, 'success');
    } else if (b.dataset.adjust) {
      await api(`/api/fidelite/clients/${id}/adjust`, { method: 'POST', body: { stamps: Number(b.dataset.adjust) } });
    } else return;
  } catch (err) {
    toast(err.message, 'error');
  }
  loadClients().catch(() => {});
});

$('loyaltyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await run(() => api('/api/loyalty/settings', {
    method: 'PUT',
    body: { stamps_required: Number(f.stamps_required.value), reward_label: f.reward_label.value, public_url: f.public_url.value },
  }), 'Réglages enregistrés').catch(() => {});
  loyalty = await api('/api/loyalty/settings');
  renderLoyaltySettings();
  loadClients().catch(() => {});
});

// Impression directe de l'affiche depuis la page (sans fenêtre pop-up, souvent bloquée).
$('printPoster').addEventListener('click', () => {
  const img = $('joinQr');
  const doPrint = () => {
    document.body.classList.add('print-poster');
    window.print();
  };
  if (img.complete && img.naturalWidth) doPrint();
  else img.addEventListener('load', doPrint, { once: true });
});
window.addEventListener('afterprint', () => document.body.classList.remove('print-poster'));

// ---------- Matières premières et factures ----------

let rawMaterials = [];
let draft = null;           // facture en cours : { image, source, totalTouched }
let openInvoiceId = null;

const fmtQty = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 3 });
const toNumber = (v) => Number(String(v ?? '').trim().replace(',', '.'));

async function loadMatieres() {
  const [raws, invoices] = await Promise.all([api('/api/matieres'), api('/api/factures')]);
  rawMaterials = raws;
  $('rawList').innerHTML = raws.map((r) => `<option value="${esc(r.name)}">${esc(r.unit)}</option>`).join('');

  $('rawTable').innerHTML = table(
    [{ label: 'Matière' }, { label: 'En stock', num: true }, { label: 'Dernier prix', num: true }, { label: '' }],
    raws.map((r) => `<tr data-id="${r.id}" data-name="${esc(r.name)}" data-unit="${esc(r.unit)}" data-qty="${r.quantity}">
      <td class="c-title"><strong>${esc(r.name)}</strong></td>
      <td class="num"><strong>${fmtQty(r.quantity)}</strong> ${esc(r.unit)}</td>
      <td class="num">${r.last_price_cents != null ? `${money(r.last_price_cents)} / ${esc(r.unit)}` : '—'}</td>
      <td class="c-full"><div class="cell-actions">
        <button class="btn-sm" data-raw="utilisation">Utiliser</button>
        <button class="btn-sm btn-ghost" data-raw="correction">Corriger</button>
        <button class="btn-icon btn-ghost btn-danger" data-raw="supprimer" title="Supprimer « ${esc(r.name)} »" aria-label="Supprimer ${esc(r.name)}">${icon('close')}</button>
      </div></td></tr>`),
    '',
    { cards: true, empty: 'Aucune matière première. Elles s’ajoutent automatiquement avec les factures.' }
  );

  $('invoicesList').innerHTML = invoices.length
    ? `<table><tbody>${invoices.map((f) => `<tr class="click-row" data-invoice="${f.id}">
        <td class="muted" style="white-space:nowrap">${f.invoice_date ? new Date(f.invoice_date + 'T12:00:00').toLocaleDateString('fr-FR') : '—'}</td>
        <td><strong>${esc(f.supplier || 'Fournisseur inconnu')}</strong><div class="cell-sub">${f.lines_count} ligne${f.lines_count > 1 ? 's' : ''}${f.pdf ? ' · PDF' : f.photo ? ' · photo' : ''}${f.source === 'ia' ? ' · lue par IA' : f.source === 'ocr' ? ' · lue sur le PC' : f.source === 'pdf' ? ' · lue depuis le PDF' : ''}</div></td>
        <td class="num"><strong>${money(f.total_cents)}</strong></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Aucune facture enregistrée.</div>';
}

// ----- Matières : utilisation / correction / ajout -----

$('rawTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-raw]');
  if (!b) return;
  const tr = b.closest('tr');
  const { id, name, unit, qty } = tr.dataset;
  const kind = b.dataset.raw;
  if (kind === 'supprimer') {
    if (!confirm(`Supprimer « ${name} » du stock de matières premières ?\nLes factures sont gardées.`)) return;
    await run(() => api(`/api/matieres/${id}`, { method: 'DELETE' }), `« ${name} » supprimée`).catch(() => {});
    loadMatieres();
    return;
  }
  const value = prompt(kind === 'utilisation'
    ? `Quantité de « ${name} » utilisée (${unit}) :`
    : `Quantité réelle de « ${name} » en stock (${unit}) :`, kind === 'correction' ? fmtQty(qty) : '');
  if (value === null) return;
  const quantity = toNumber(value);
  if (!Number.isFinite(quantity) || quantity < 0) return toast('Quantité invalide', 'error');
  await run(() => api(`/api/matieres/${id}/mouvement`, { method: 'POST', body: { kind, quantity } }),
    kind === 'utilisation' ? `${fmtQty(quantity)} ${unit} de ${name} utilisé(s)` : 'Stock corrigé').catch(() => {});
  loadMatieres();
});

$('rawDeleteAll').addEventListener('click', async () => {
  if (!rawMaterials.length) return toast('Le stock de matières premières est déjà vide');
  if (!confirm(`Supprimer les ${rawMaterials.length} matières premières du stock ?\nLes factures sont gardées. Cette action est définitive.`)) return;
  await run(() => api('/api/matieres', { method: 'DELETE' }), 'Stock de matières premières vidé').catch(() => {});
  loadMatieres();
});

$('newRawForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const quantity = f.quantity.value.trim() === '' ? 0 : toNumber(f.quantity.value);
  if (!Number.isFinite(quantity) || quantity < 0) return toast('Quantité invalide', 'error');
  await run(() => api('/api/matieres', { method: 'POST', body: { name: f.name.value, unit: f.unit.value || 'unité', quantity } }), 'Matière ajoutée')
    .then(() => f.reset()).catch(() => {});
  loadMatieres();
});

// ----- Nouvelle facture : photo -> lecture IA -> vérification -> enregistrement -----

// Réduit la photo (1600 px max, JPEG) pour l'envoyer rapidement.
async function resizeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Version de la photo préparée pour la lecture gratuite : agrandie (petites photos de téléphone),
// éclairage égalisé (ombres et plis effacés), en noir et blanc bien contrasté, traits du tableau retirés.
// source : le fichier photo, ou une page de PDF déjà dessinée (canvas).
// Deux réglages sont envoyés au serveur, qui garde la meilleure lecture : une photo se lit
// parfois mieux agrandie et contrastée (OCR_MAIN), parfois avec le réglage d'origine (OCR_ALT).
const OCR_MAIN = { maxSide: 3000, hi: 245, gamma: 1.4 };
const OCR_ALT = { maxSide: 2400, hi: 235, gamma: 1 };
async function prepareForOcr(source, { maxSide, hi, gamma } = OCR_MAIN) {
  const url = source instanceof Blob ? URL.createObjectURL(source) : null;
  try {
    const img = url ? await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; }) : source;
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    const scale = Math.min(3, maxSide / Math.max(sw, sh));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h);
    const d = pixels.data;

    // Fond de la page (papier + ombres) : l'image très réduite puis ré-agrandie = une version très floue.
    const bgc = document.createElement('canvas');
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(w / 48)); small.height = Math.max(1, Math.round(h / 48));
    small.getContext('2d').drawImage(img, 0, 0, small.width, small.height);
    bgc.width = w; bgc.height = h;
    const bctx = bgc.getContext('2d');
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, w, h);
    const bg = bctx.getImageData(0, 0, w, h).data;

    // Encre = assombrissement par rapport au papier autour : une ombre ou un pli n'est plus pris pour du texte.
    const gray = (a, i) => 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, Math.round((gray(d, i) / Math.max(1, gray(bg, i))) * 255)));
      d[i] = v;
      hist[v] += 1;
    }
    // Contraste : le papier devient blanc, l'encre noire (bornes à 1 % des pixels les plus sombres) ;
    // la courbe (gamma > 1) fonce l'encre pâle sans noircir le papier.
    const n = d.length / 4;
    let lo = 0; let acc = 0;
    for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.round(Math.pow(Math.max(0, Math.min(1, (d[i] - lo) / range)), gamma) * 255);
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
    eraseTableLines(d, w, h);
    ctx.putImageData(pixels, 0, 0);
    return c.toDataURL('image/jpeg', 0.92);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

// ----- Factures PDF (pdf.js, servi par le serveur) -----
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return lib;
    }).catch((err) => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

// Texte du PDF ligne par ligne, colonnes séparées par 3 espaces (même forme que la lecture d'une photo).
async function pdfToText(doc, maxPages = 10) {
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n += 1) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(r.h, h) * 0.5);
      if (!row) { row = { y, h, items: [] }; rows.push(row); }
      row.items.push({ x, end: x + (it.width || 0), h, str: it.str.trim() });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let line = '';
      let end = null;
      for (const it of r.items) {
        if (end !== null) {
          const gap = it.x - end;
          line += gap > it.h * 1.2 ? '   ' : gap > it.h * 0.12 ? ' ' : '';
        }
        line += it.str;
        end = Math.max(end ?? 0, it.end);
      }
      out.push(line);
    }
    out.push('');
  }
  return out.join('\n');
}

// Dessine la 1re page du PDF (aperçu, ou lecture sur le PC pour un PDF scanné sans texte).
async function pdfPageCanvas(doc, maxSide) {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: maxSide / Math.max(base.width, base.height) });
  const c = document.createElement('canvas');
  c.width = Math.round(viewport.width);
  c.height = Math.round(viewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return c;
}

const fileToDataUrl = (file) => new Promise((ok, ko) => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = ko;
  r.readAsDataURL(file);
});

// Efface les traits du tableau : longues lignes sombres et FINES (horizontales et verticales).
// Collés aux chiffres, ils empêchent la lecture des cases. Le texte (traits courts) n'est pas touché.
function eraseTableLines(d, w, h) {
  const dark = (x, y) => d[(y * w + x) * 4] < 128;
  const minH = Math.round(w / 10);
  const minV = Math.round(h / 15);
  const thin = Math.max(3, Math.round(Math.max(w, h) / 400)); // épaisseur max d'un trait de tableau
  const erase = [];
  // Épaisseur du noir à travers (x, y), dans la direction perpendiculaire au trait.
  const thickness = (x, y, dx, dy) => {
    let t = 1;
    for (let k = 1; k <= thin + 1; k += 1) { const X = x + dx * k; const Y = y + dy * k; if (X < 0 || Y < 0 || X >= w || Y >= h || !dark(X, Y)) break; t += 1; }
    for (let k = 1; k <= thin + 1; k += 1) { const X = x - dx * k; const Y = y - dy * k; if (X < 0 || Y < 0 || X >= w || Y >= h || !dark(X, Y)) break; t += 1; }
    return t;
  };
  for (let y = 0; y < h; y += 1) {
    let start = -1;
    for (let x = 0; x <= w; x += 1) {
      if (x < w && dark(x, y)) { if (start < 0) start = x; } else if (start >= 0) {
        if (x - start >= minH) for (let k = start; k < x; k += 1) if (thickness(k, y, 0, 1) <= thin) erase.push(y * w + k);
        start = -1;
      }
    }
  }
  for (let x = 0; x < w; x += 1) {
    let start = -1;
    for (let y = 0; y <= h; y += 1) {
      if (y < h && dark(x, y)) { if (start < 0) start = y; } else if (start >= 0) {
        if (y - start >= minV) for (let k = start; k < y; k += 1) if (thickness(x, k, 1, 0) <= thin) erase.push(k * w + x);
        start = -1;
      }
    }
  }
  for (const p of erase) { d[p * 4] = 255; d[p * 4 + 1] = 255; d[p * 4 + 2] = 255; }
}

// data-read : le nom tel que lu sur la facture (renvoyé à l'enregistrement : le système apprend la correction).
function draftLineRow(l = {}) {
  return `<div class="draft-line" data-read="${esc(l.read_name || '')}">
    <input data-f="name" list="rawList" placeholder="Article" value="${esc(l.name || '')}" aria-label="Article">
    <input data-f="quantity" inputmode="decimal" placeholder="Qté" value="${l.quantity != null ? fmtQty(l.quantity) : ''}" aria-label="Quantité">
    <input data-f="unit" placeholder="Unité" value="${esc(l.unit || '')}" aria-label="Unité">
    <input data-f="unit_price" inputmode="decimal" placeholder="Prix unit." value="${l.unit_price_cents != null ? centsToInput(l.unit_price_cents).replace('.', ',') : ''}" aria-label="Prix unitaire (DH)">
    <input data-f="total" inputmode="decimal" placeholder="Total" value="${l.total_cents != null ? centsToInput(l.total_cents).replace('.', ',') : ''}" aria-label="Total de la ligne (DH)">
    <button type="button" class="btn-icon btn-ghost l-del" data-del-line title="Supprimer la ligne" aria-label="Supprimer la ligne">${icon('close')}</button>
  </div>`;
}

function openDraft({ image = null, status = '', lines = [{}] } = {}) {
  draft = { image, source: 'manuel', totalTouched: false };
  $('invoiceDraft').classList.remove('hidden');
  $('draftPhotoBox').classList.toggle('hidden', !image);
  if (image) $('draftPhoto').src = image;
  $('draftStatus').innerHTML = status;
  $('draftSupplier').value = '';
  $('draftDate').value = state.me.today;
  $('draftLines').innerHTML = `<div class="draft-line draft-head"><span>Article</span><span>Qté</span><span>Unité</span><span>Prix unit. (DH)</span><span>Total (DH)</span><span></span></div>`
    + lines.map(draftLineRow).join('');
  $('draftTotal').value = '';
  updateDraftTotal();
  $('invoiceDraft').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function readDraftLines() {
  return [...$('draftLines').querySelectorAll('.draft-line:not(.draft-head)')].map((row) => {
    const v = (f) => row.querySelector(`[data-f="${f}"]`).value;
    return {
      name: v('name').trim(),
      quantity: toNumber(v('quantity')),
      unit: v('unit').trim() || 'unité',
      unit_price_cents: v('unit_price').trim() === '' ? 0 : toCents(v('unit_price')),
      total_cents: v('total').trim() === '' ? 0 : toCents(v('total')),
      read_name: row.dataset.read || '',
    };
  }).filter((l) => l.name || l.quantity || l.total_cents);
}

function updateDraftTotal() {
  if (draft.totalTouched) return;
  const sum = readDraftLines().reduce((s, l) => s + (Number.isFinite(l.total_cents) ? l.total_cents : 0), 0);
  $('draftTotal').value = centsToInput(sum).replace('.', ',');
}

// Somme des lignes lues différente du total imprimé : une ligne est sans doute mal lue.
function gapWarning(r) {
  // Lignes hors taxes : on compare au total HT s'il est imprimé, sinon au total.
  const target = r.subtotal_cents || r.total_cents;
  if (!target || !r.lines.length) return '';
  const label = r.subtotal_cents ? 'total HT' : 'total';
  const sum = r.lines.reduce((s, l) => s + l.total_cents, 0);
  const gap = target - sum;
  if (Math.abs(gap) < 1) return `<br><span class="badge badge-ok">Total vérifié</span> La somme des lignes correspond au ${label} de la facture.`;
  return `<br><span class="badge badge-low">Écart de ${money(Math.abs(gap))}</span> La somme des lignes (${money(sum)}) ne correspond pas au ${label} de la facture (${money(target)}) : une ligne est mal lue, comparez avec la photo.`;
}

const READ_LABELS = { ia: 'par l’IA', pdf: 'depuis le texte du PDF', ocr: 'sur le PC' };

async function handleInvoiceFile(file) {
  if (!file) return;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return handleInvoicePdf(file);
  let image;
  let ocrImage;
  let ocrAlt;
  try {
    image = await resizeImage(file);
    ocrImage = await prepareForOcr(file);
    ocrAlt = await prepareForOcr(file, OCR_ALT);
  } catch {
    return toast('Photo illisible (format non pris en charge)', 'error');
  }
  return readInvoice({ image, ocr_image: ocrImage, ocr_image_alt: ocrAlt }, { image, isPdf: false });
}

// PDF : le texte est extrait tel quel (exact) ; un PDF scanné (sans texte) est lu comme une photo.
async function handleInvoicePdf(file) {
  if (file.size > 10 * 1024 * 1024) return toast('PDF trop lourd (10 Mo maximum)', 'error');
  openDraft({ status: '<span class="spinner"></span> Ouverture du PDF…', lines: [] });
  let body;
  let image;
  try {
    const pdf = await fileToDataUrl(file);
    const lib = await loadPdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const text = await pdfToText(doc);
    image = (await pdfPageCanvas(doc, 1600)).toDataURL('image/jpeg', 0.85);
    const hasText = text.replace(/\s/g, '').length >= 20;
    body = { image, pdf, pdf_text: text };
    if (!hasText) {
      body.ocr_image = await prepareForOcr(await pdfPageCanvas(doc, OCR_MAIN.maxSide));
      body.ocr_image_alt = await prepareForOcr(await pdfPageCanvas(doc, OCR_ALT.maxSide), OCR_ALT);
    }
    if (doc.numPages > 1 && !hasText) toast('PDF scanné : seule la 1re page est lue');
  } catch (err) {
    draft = null;
    $('invoiceDraft').classList.add('hidden');
    return toast(`PDF illisible (${err.message || 'format non pris en charge'})`, 'error');
  }
  return readInvoice(body, { image, isPdf: true });
}

async function readInvoice(body, { image, isPdf }) {
  openDraft({ image, status: '<span class="spinner"></span> Lecture de la facture en cours… (jusqu’à 1 minute)', lines: [] });
  draft.pdf = isPdf ? body.pdf : null;
  try {
    const r = await api('/api/factures/lire', { method: 'POST', body });
    const rawText = r.raw_text && r.raw_text.trim()
      ? `<details class="raw-text"><summary>Voir le texte lu ${r.method === 'pdf' ? 'dans le PDF' : 'sur la photo'}</summary><pre>${esc(r.raw_text.trim())}</pre></details>`
      : '';
    if (!r.lines.length) {
      draft.source = r.method;
      $('draftSupplier').value = r.supplier;
      if (r.invoice_date) $('draftDate').value = r.invoice_date;
      $('draftLines').insertAdjacentHTML('beforeend', draftLineRow());
      $('draftStatus').innerHTML = isPdf
        ? `<span class="badge badge-low">Aucun article reconnu</span> Le tableau de ce PDF n’a pas pu être découpé en lignes : saisissez-les en vous aidant du texte lu.${rawText}`
        : `<span class="badge badge-low">Aucun article reconnu</span> La photo est trop floue ou trop petite pour la lecture sur le PC. Reprenez-la de face, bien éclairée, la facture remplissant toute la photo — ou saisissez les lignes.${rawText}`;
      return;
    }
    draft.source = r.method;
    $('draftSupplier').value = r.supplier;
    if (r.invoice_date) $('draftDate').value = r.invoice_date;
    $('draftLines').insertAdjacentHTML('beforeend', (r.lines.length ? r.lines : [{}]).map(draftLineRow).join(''));
    if (r.total_cents) { $('draftTotal').value = centsToInput(r.total_cents).replace('.', ','); draft.totalTouched = true; }
    else updateDraftTotal();
    const unknown = r.lines.filter((l) => !l.known).length;
    $('draftStatus').innerHTML = `<span class="badge badge-ok">Facture lue ${READ_LABELS[r.method] || 'sur le PC'}</span> ${r.lines.length} ligne(s) trouvée(s). Vérifiez chaque ligne${r.method === 'ocr' ? ' (surtout les quantités et les unités)' : ''} avant d’enregistrer.${unknown ? ` ${unknown} nouvelle(s) matière(s) sera/seront créée(s).` : ''}${gapWarning(r)}${rawText}`;
  } catch (err) {
    $('draftLines').insertAdjacentHTML('beforeend', draftLineRow());
    $('draftStatus').innerHTML = `<span class="badge badge-out">Lecture automatique impossible</span> ${esc(err.message)} Saisissez les lignes à la main.`;
  }
}

$('invoiceCamera').addEventListener('change', (e) => { handleInvoiceFile(e.target.files[0]); e.target.value = ''; });
$('invoiceFile').addEventListener('change', (e) => { handleInvoiceFile(e.target.files[0]); e.target.value = ''; });
$('invoiceManual').addEventListener('click', () => openDraft({ status: 'Saisissez les lignes de la facture.' }));
$('draftAddLine').addEventListener('click', () => $('draftLines').insertAdjacentHTML('beforeend', draftLineRow()));
$('draftCancel').addEventListener('click', () => { draft = null; $('invoiceDraft').classList.add('hidden'); });

$('draftLines').addEventListener('click', (e) => {
  if (!e.target.closest('[data-del-line]')) return;
  e.target.closest('.draft-line').remove();
  updateDraftTotal();
});

// Quantité × prix unitaire -> total de la ligne.
$('draftLines').addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  const row = e.target.closest('.draft-line');
  if (f === 'quantity' || f === 'unit_price') {
    const q = toNumber(row.querySelector('[data-f="quantity"]').value);
    const p = toCents(row.querySelector('[data-f="unit_price"]').value);
    if (Number.isFinite(q) && Number.isFinite(p)) row.querySelector('[data-f="total"]').value = centsToInput(Math.round(q * p)).replace('.', ',');
  }
  if (f === 'name') {
    const known = rawMaterials.find((r) => r.name.toLowerCase() === e.target.value.trim().toLowerCase());
    const unit = row.querySelector('[data-f="unit"]');
    if (known && !unit.value) unit.value = known.unit;
  }
  updateDraftTotal();
});
$('draftTotal').addEventListener('input', () => { draft.totalTouched = true; });

$('draftSave').addEventListener('click', async () => {
  const lines = readDraftLines();
  if (!lines.length) return toast('Ajoutez au moins une ligne', 'error');
  const bad = lines.findIndex((l) => !l.name || !Number.isFinite(l.quantity) || l.quantity <= 0
    || !Number.isFinite(l.unit_price_cents) || !Number.isFinite(l.total_cents));
  if (bad >= 0) return toast(`Ligne ${bad + 1} incomplète : article, quantité et prix`, 'error');
  const total_cents = toCents($('draftTotal').value || '0');
  try {
    await api('/api/factures', {
      method: 'POST',
      body: {
        supplier: $('draftSupplier').value, invoice_date: $('draftDate').value, total_cents: Number.isFinite(total_cents) ? total_cents : 0,
        source: draft.source, image: draft.image, pdf: draft.pdf || undefined, lines,
      },
    });
    toast('Facture enregistrée, stock mis à jour', 'success');
    draft = null;
    $('invoiceDraft').classList.add('hidden');
    loadMatieres();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ----- Détail d'une facture -----

$('invoicesList').addEventListener('click', async (e) => {
  const tr = e.target.closest('[data-invoice]');
  if (!tr) return;
  const f = await api(`/api/factures/${tr.dataset.invoice}`).catch((err) => toast(err.message, 'error'));
  if (!f) return;
  openInvoiceId = f.id;
  $('invTitle').textContent = `${f.supplier || 'Fournisseur inconnu'} · ${f.invoice_date ? new Date(f.invoice_date + 'T12:00:00').toLocaleDateString('fr-FR') : ''}`;
  $('invBody').innerHTML = `
    ${f.photo ? `<a href="/api/factures/${f.id}/${f.pdf ? 'pdf' : 'photo'}" target="_blank" rel="noopener"><img class="inv-photo" src="/api/factures/${f.id}/photo" alt="${f.pdf ? 'Aperçu du PDF' : 'Photo de la facture'}"></a>` : ''}
    ${f.pdf ? `<p><a class="btn btn-sm" href="/api/factures/${f.id}/pdf" target="_blank" rel="noopener">Ouvrir le PDF</a></p>` : ''}
    <table><thead><tr><th>Article</th><th class="num">Quantité</th><th class="num">Prix unit.</th><th class="num">Total</th></tr></thead><tbody>
      ${f.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${fmtQty(l.quantity)} ${esc(l.unit)}</td><td class="num">${money(l.unit_price_cents)}</td><td class="num">${money(l.total_cents)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="3">Total facture</td><td class="num">${money(f.total_cents)}</td></tr></tfoot></table>
    <p class="muted" style="font-size:13px">Enregistrée le ${f.created_at.slice(0, 10).split('-').reverse().join('/')} à ${f.created_at.slice(11, 16)}${f.user_name ? ` par ${esc(f.user_name)}` : ''}${f.source === 'ia' ? ' · lue par l’IA' : f.source === 'ocr' ? ' · lue sur le PC' : f.source === 'pdf' ? ' · lue depuis le PDF' : ''}.</p>`;
  $('invoiceDialog').showModal();
});

$('invClose').addEventListener('click', () => $('invoiceDialog').close());
$('invOk').addEventListener('click', () => $('invoiceDialog').close());
$('invDelete').addEventListener('click', async () => {
  if (!confirm('Supprimer cette facture ? Ses quantités seront retirées du stock de matières premières.')) return;
  await run(() => api(`/api/factures/${openInvoiceId}`, { method: 'DELETE' }), 'Facture supprimée').catch(() => {});
  $('invoiceDialog').close();
  loadMatieres();
});

// ---------- Fond de caisse ----------

// Billets et pièces marocains, en centimes, pour aider au comptage.
const DENOMS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];
let fond = null;

const denomLabel = (c) => (c >= 2000 ? `Billet ${c / 100} DH` : c >= 100 ? `Pièce ${c / 100} DH` : 'Pièce 0,50 DH');
const timeOf = (dt) => (dt ? dt.slice(11, 16) : '');

// Sur téléphone, « Billet » / « Pièce » est masqué pour tenir sur 2 colonnes.
$('denoms').innerHTML = DENOMS.map((c) => `<label class="denom"><span><span class="d-kind">${c >= 2000 ? 'Billet' : 'Pièce'} </span>${c === 50 ? '0,50' : c / 100} DH</span>
  <input type="number" min="0" step="1" inputmode="numeric" placeholder="0" data-denom="${c}" aria-label="Nombre de ${denomLabel(c)}"></label>`).join('');

async function loadFond() {
  fond = await api(`/api/fond?date=${state.date}`);
  renderFond();
}

function renderFond() {
  const d = fond.day;
  $('fondOpenCard').classList.toggle('hidden', Boolean(d));
  $('fondContent').classList.toggle('hidden', !d);
  if (!d) return;
  const closed = Boolean(d.closed_at);

  $('fondKpis').innerHTML = [
    ['Fond initial', money(d.opening_cents)],
    ['+ Ventes du jour', money(fond.sales_cents)],
  ].map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('')
    + `<div class="kpi kpi-top"><div class="label">= Espèces attendues en caisse</div><div class="value">${money(fond.expected_cents)}</div></div>`;

  $('fondMeta').innerHTML = `Journée ouverte à ${timeOf(d.opened_at)}${d.opened_by_name ? ` par ${esc(d.opened_by_name)}` : ''}.`
    + (closed ? '' : ' <button class="btn-sm btn-ghost" id="editOpening">Modifier le fond initial</button>');


  $('closeCard').classList.toggle('hidden', closed);
  $('closedCard').classList.toggle('hidden', !closed);
  if (closed) {
    const diff = fond.diff_cents;
    const [badgeClass, badgeText] = diff === 0 ? ['ok', 'Caisse juste ✓'] : diff < 0 ? ['out', `Manque ${money(-diff)}`] : ['low', `Surplus ${money(diff)}`];
    $('closedInfo').innerHTML = `
      <p class="muted" style="margin-top:-6px">Clôturée à ${timeOf(d.closed_at)}${d.closed_by_name ? ` par ${esc(d.closed_by_name)}` : ''}.</p>
      <table><tbody>
        <tr><td>Espèces attendues</td><td class="num">${money(d.expected_cents)}</td></tr>
        <tr><td>Espèces comptées</td><td class="num">${money(d.counted_cents)}</td></tr>
        <tr><td><strong>Écart</strong></td><td class="num"><span class="badge badge-${badgeClass}">${badgeText}</span></td></tr>
        ${d.note ? `<tr><td>Remarque</td><td>${esc(d.note)}</td></tr>` : ''}
      </tbody></table>`;
  } else {
    renderDiff();
  }
}

// Écart en direct pendant le comptage.
function renderDiff() {
  const counted = toCents($('countedInput').value);
  const el = $('fondDiff');
  if (!Number.isFinite(counted) || !fond || !fond.day) { el.classList.add('hidden'); return; }
  const diff = counted - fond.expected_cents;
  el.classList.remove('hidden');
  el.className = `fond-diff ${diff === 0 ? 'ok' : diff < 0 ? 'out' : 'low'}`;
  el.textContent = diff === 0 ? 'Caisse juste ✓' : diff < 0 ? `Manque ${money(-diff)}` : `Surplus ${money(diff)}`;
}

$('denoms').addEventListener('input', () => {
  const total = [...document.querySelectorAll('[data-denom]')]
    .reduce((s, i) => s + (Math.max(0, Math.floor(Number(i.value) || 0)) * Number(i.dataset.denom)), 0);
  $('countedInput').value = centsToInput(total).replace('.', ',');
  renderDiff();
});
$('countedInput').addEventListener('input', renderDiff);

$('fondOpenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = toCents(e.target.amount.value);
  if (!Number.isFinite(amount) || amount < 0) return toast('Montant invalide', 'error');
  fond = await run(() => api(`/api/fond/${state.date}/ouverture`, { method: 'PUT', body: { amount_cents: amount } }), 'Journée ouverte').catch(() => fond);
  e.target.reset();
  renderFond();
});

$('fondMeta').addEventListener('click', async (e) => {
  if (!e.target.closest('#editOpening')) return;
  const value = prompt('Nouveau fond de caisse initial (DH) :', centsToInput(fond.day.opening_cents).replace('.', ','));
  if (value === null) return;
  const amount = toCents(value);
  if (!Number.isFinite(amount) || amount < 0) return toast('Montant invalide', 'error');
  fond = await run(() => api(`/api/fond/${state.date}/ouverture`, { method: 'PUT', body: { amount_cents: amount } }), 'Fond initial modifié').catch(() => fond);
  renderFond();
});

$('closeBtn').addEventListener('click', async () => {
  const counted = toCents($('countedInput').value);
  if (!Number.isFinite(counted) || counted < 0) return toast('Saisissez les espèces comptées', 'error');
  const diff = counted - fond.expected_cents;
  const msg = diff === 0 ? 'La caisse est juste.' : diff < 0 ? `Il manque ${money(-diff)}.` : `Il y a ${money(diff)} en trop.`;
  if (!confirm(`${msg}\nClôturer la journée ?`)) return;
  fond = await run(() => api(`/api/fond/${state.date}/cloture`, {
    method: 'POST', body: { counted_cents: counted, note: $('closeNote').value },
  }), 'Journée clôturée').catch(() => fond);
  $('countedInput').value = '';
  $('closeNote').value = '';
  document.querySelectorAll('[data-denom]').forEach((i) => (i.value = ''));
  renderFond();
});

$('reopenBtn').addEventListener('click', async () => {
  if (!confirm('Rouvrir la journée ? Il faudra la clôturer à nouveau.')) return;
  fond = await run(() => api(`/api/fond/${state.date}/reouverture`, { method: 'POST' }), 'Journée rouverte').catch(() => fond);
  renderFond();
});

const loaders = { recap: loadRecap, stock: loadStock, ventes: loadOrders, fond: loadFond, produits: loadCatalogue, matieres: loadMatieres, clients: loadClients, users: loadUsers };

function refresh() {
  return loaders[state.tab]().catch((err) => toast(err.message, 'error'));
}

// ----- Menu « Plus » (petits téléphones) : les onglets en trop y sont rangés -----
const extraTabs = [...document.querySelectorAll('#tabs .tab-extra')];
$('tabMenu').innerHTML = extraTabs.map((b) => `<button type="button" role="menuitem" data-tab="${b.dataset.tab}" class="${b.classList.contains('hidden') ? 'hidden' : ''}">${b.innerHTML}</button>`).join('');

function toggleTabMenu(open) {
  $('tabMenu').classList.toggle('hidden', !open);
  $('tabMore').setAttribute('aria-expanded', String(open));
}
$('tabMore').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleTabMenu($('tabMenu').classList.contains('hidden'));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#tabMenu')) toggleTabMenu(false); });
document.addEventListener('keydown', (e) => e.key === 'Escape' && toggleTabMenu(false));

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  // « Plus » prend le nom de l'onglet ouvert quand celui-ci est rangé dans le menu.
  const extra = extraTabs.find((b) => b.dataset.tab === tab);
  $('tabMore').classList.toggle('active', Boolean(extra));
  $('tabMore').querySelector('span').textContent = extra ? extra.textContent.trim() : 'Plus';
  toggleTabMenu(false);
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  $('dateBar').classList.toggle('hidden', !DATE_TABS.includes(tab));
  refresh();
}

function setDate(date) {
  state.date = date;
  $('dateInput').value = date;
  $('dateTitle').textContent = formatDate(date) + (date === state.me.today ? ' (aujourd’hui)' : '');
  refresh();
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});
$('dateInput').addEventListener('change', (e) => e.target.value && setDate(e.target.value));
$('todayBtn').addEventListener('click', () => setDate(state.me.today));
$('refreshBtn').addEventListener('click', refresh);
$('logoutBtn').addEventListener('click', logout);

// ---------- Alertes de la caisse (cloche en haut à droite) ----------

let alertsKnown = null; // « id:nombre » des alertes ouvertes déjà vues, pour annoncer les nouvelles

async function loadAlerts() {
  const { open, alerts } = await api('/api/alertes');
  $('notifCount').textContent = open;
  $('notifCount').classList.toggle('hidden', !open);
  $('notifBtn').classList.toggle('has-alerts', open > 0);
  const openList = alerts.filter((a) => !a.resolved_at);
  const key = new Set(openList.map((a) => `${a.id}:${a.times}`));
  if (alertsKnown) {
    const fresh = openList.filter((a) => !alertsKnown.has(`${a.id}:${a.times}`));
    if (fresh.length) toast(`🔔 ${fresh[0].message}${fresh[0].user_name ? ` — signalé par ${fresh[0].user_name}` : ''}`, 'error');
  }
  alertsKnown = key;
  const when = (a) => `${a.date === state.me.today ? '' : `${a.date.split('-').reverse().slice(0, 2).join('/')} `}${a.updated_at.slice(11, 16)}`;
  $('notifPanel').innerHTML = `<div class="notif-head"><strong>Alertes</strong></div>${alerts.length
    ? alerts.map((a) => `<div class="notif-item ${a.resolved_at ? 'done' : ''}">
        <div class="notif-text">
          <strong>${esc(a.message)}</strong>
          <span class="muted">Signalé${a.user_name ? ` par ${esc(a.user_name)}` : ''} à ${when(a)}${a.times > 1 ? ` (${a.times} fois)` : ''}</span>
          ${a.resolved_at ? `<span class="muted">Traité à ${a.resolved_at.slice(11, 16)}</span>` : ''}
        </div>
        ${a.resolved_at ? '' : `<div class="notif-actions">
          ${a.kind === 'emballages_parts' ? '<button class="btn-sm btn-primary" data-alert-stock>Ajouter des emballages</button>' : ''}
          <button class="btn-sm" data-alert-done="${a.id}">C’est noté</button>
        </div>`}
      </div>`).join('')
    : '<div class="empty">Aucune alerte.</div>'}`;
}

function toggleNotif(open) {
  $('notifPanel').classList.toggle('hidden', !open);
  $('notifBtn').setAttribute('aria-expanded', String(open));
}
$('notifBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('notifPanel').classList.contains('hidden');
  toggleNotif(open);
  if (open) loadAlerts().catch(() => {});
});
document.addEventListener('click', (e) => { if (!e.target.closest('.notif')) toggleNotif(false); });
$('notifPanel').addEventListener('click', async (e) => {
  const done = e.target.closest('[data-alert-done]');
  if (done) {
    await api(`/api/alertes/${done.dataset.alertDone}/traitee`, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
    loadAlerts().catch(() => {});
  }
  // « Ajouter des emballages » : ouvre l'onglet Stock sur la journée, champ des emballages prêt à remplir.
  if (e.target.closest('[data-alert-stock]')) {
    toggleNotif(false);
    if (state.date !== state.me.today) setDate(state.me.today);
    setTab('stock');
    setTimeout(() => {
      const input = document.querySelector('#packBlocks [data-kind="part"] [data-pack-qty]');
      if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
    }, 400);
  }
});

(async function init() {
  state.me = await requireRole('gerant');
  $('userName').textContent = state.me.name;
  state.date = state.me.today;
  $('dateInput').value = state.date;
  $('dateTitle').textContent = formatDate(state.date) + ' (aujourd’hui)';
  setTab('recap');
  // Le récap se met à jour tout seul pendant la journée.
  setInterval(() => state.tab === 'recap' && !document.hidden && refresh(), 30000);
  // Alertes de la caisse : vérifiées toutes les 20 secondes.
  loadAlerts().catch(() => {});
  setInterval(() => !document.hidden && loadAlerts().catch(() => {}), 20000);
})();
