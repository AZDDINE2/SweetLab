// Ticket de caisse SweetLab : rendu et impression (imprimante à tickets 80 ou 58 mm, ou imprimante normale).
// Utilisé par la caisse (après une vente, réimpression) et par le gérant (onglet Ventes, réglages).

let ticketConfigCache = null;
async function ticketConfig(force = false) {
  if (!ticketConfigCache || force) ticketConfigCache = await api('/api/ticket/settings');
  return ticketConfigCache;
}

// « 0660380767 » -> « 06 60 38 07 67 »
const ticketPhone = (p) => (/^\d{10}$/.test(String(p).replace(/\s/g, '')) ? String(p).replace(/\s/g, '').replace(/(\d{2})(?=\d)/g, '$1 ') : String(p || ''));
const ticketMoney = (c) => (c / 100).toFixed(2).replace('.', ',');

// Le ticket en HTML (o : commande avec ses articles, cfg : réglages du ticket).
function ticketHtml(o, cfg) {
  const [d, t] = [o.created_at.slice(0, 10).split('-').reverse().join('/'), o.created_at.slice(11, 16)];
  const mode = { sur_place: 'Sur place', emporter: 'À emporter', mixte: 'Sur place + à emporter' }[o.mode] || '';
  const line = (left, right, cls = '') => `<div class="t-row ${cls}"><span>${left}</span><span>${right}</span></div>`;
  const items = (o.items || []).map((it) => {
    const details = [it.format === 'moule' ? 'Moule entier' : (it.place ? 'Part' : ''),
      it.format !== 'moule' && it.place ? (it.place === 'emporter' ? 'À emporter' : 'Sur place') : '',
      ...(it.toppings || [])].filter(Boolean).join(' · ');
    const total = it.line_total_cents ?? it.quantity * it.unit_price_cents;
    return line(`${it.quantity} × ${esc(it.product_name)}`, ticketMoney(total)) + (details ? `<div class="t-sub">${esc(details)}</div>` : '');
  }).join('');
  const extras = [
    o.packaging_count ? line(`Emballage${o.packaging_count > 1 ? 's' : ''} part ${o.packaging_count} × ${ticketMoney(o.packaging_cents / o.packaging_count)}`, ticketMoney(o.packaging_cents)) : '',
    o.mold_deposit_cents ? line(`Emballage${o.molds_count - o.molds_returned > 1 ? 's' : ''} moule ${o.molds_count - o.molds_returned} × ${ticketMoney(o.mold_deposit_cents / (o.molds_count - o.molds_returned))}`, ticketMoney(o.mold_deposit_cents)) : '',
    o.molds_returned ? `<div class="t-sub">Ancien moule rapporté : ${o.molds_returned}</div>` : '',
  ].join('');
  return `
    <div class="t-head">
      <img class="t-logo" src="/img/flask.svg" alt="">
      <div class="t-name">SWEET LAB</div>
      ${cfg.address ? `<div>${esc(cfg.address)}</div>` : ''}
      ${cfg.phone ? `<div>Tél : ${esc(ticketPhone(cfg.phone))}</div>` : ''}
      ${cfg.instagram ? `<div>Instagram : ${esc(cfg.instagram)}</div>` : ''}
    </div>
    <div class="t-sep"></div>
    ${line(`<strong>Ticket n° ${o.number}</strong>`, `${d} ${t}`)}
    ${o.cashier_name ? `<div>Caissier : ${esc(o.cashier_name)}</div>` : ''}
    ${mode ? `<div>${mode}</div>` : ''}
    ${o.status === 'annulee' ? '<div class="t-cancel">COMMANDE ANNULÉE</div>' : ''}
    <div class="t-sep"></div>
    ${items}
    ${extras ? `<div class="t-sep dotted"></div>${extras}` : ''}
    <div class="t-sep"></div>
    ${line('TOTAL', `${ticketMoney(o.total_cents)} DH`, 't-total')}
    ${o.note ? `<div class="t-sep"></div><div class="t-note">Note : ${esc(o.note)}</div>` : ''}
    <div class="t-sep"></div>
    ${cfg.footer ? `<div class="t-foot">${esc(cfg.footer)}</div>` : ''}`;
}

// Imprime le ticket d'une commande (id) ou d'une commande déjà chargée (objet).
async function printTicket(orderOrId) {
  const [cfg, o] = await Promise.all([
    ticketConfig(),
    typeof orderOrId === 'object' ? orderOrId : api(`/api/orders/${orderOrId}/ticket`),
  ]);
  let box = document.getElementById('ticketPrint');
  if (!box) { box = document.createElement('div'); box.id = 'ticketPrint'; document.body.append(box); }
  box.className = `ticket w${cfg.width}`;
  box.innerHTML = ticketHtml(o, cfg);
  await Promise.all([...box.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
  // Page au format du ticket (pas A4) : largeur du rouleau × hauteur réelle du ticket, mesurée hors écran.
  // (« auto » n'est pas accepté comme hauteur de page par les navigateurs : ils repasseraient en A4.)
  box.style.cssText = 'display:block;position:absolute;left:-10000px;top:0';
  const heightMm = Math.ceil(box.getBoundingClientRect().height / (96 / 25.4)) + 3;
  box.style.cssText = '';
  const page = document.createElement('style');
  page.textContent = `@page { size: ${cfg.width}mm ${heightMm}mm; margin: 0; }
    @media print { html, body { width: ${cfg.width}mm !important; } }`;
  document.head.append(page);
  document.body.classList.add('printing-ticket');
  const cleanup = () => { document.body.classList.remove('printing-ticket'); page.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 1000);
}
