// Lecture d'une facture photographiée « case par case » : on repère les en-têtes des colonnes
// (العدد | الوحدة | نوع البضاعة | الثمن | الواجب, ou Désignation | Qté | Unité | P.U | Montant),
// les lignes du tableau, puis chaque case est relue seule avec le bon lecteur :
// chiffres pour les quantités et les prix, arabe pour l'unité, arabe + français pour le nom.

const { findUnit, translateName, isArabic, norm, fixSpelling, stripOcrJunk, distance, hasKnownWord } = require('./arabic-fr');

// "1 250,00" / "1.250,00" / "7,50" / "120.00" / "24" -> nombre
function parseAmount(raw) {
  // Chiffres arabes-indiens (« ١٢ ») -> 12.
  let t = String(raw).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[^\d.,]/g, '')
    .replace(/^[.,]+|[.,]+$/g, ''); // « 8.50, » -> « 8.50 »
  if (!t) return NaN;
  if (/,\d{1,3}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{1,3}$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(/[.,]/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const HEADERS = [
  ['qty', ['العدد', 'الكمية', 'عدد', 'كمية'], /^(?:qt[ée]s?|qte|quantit[ée]s?|nbre|nombre)$/i],
  ['unit', ['الوحدة', 'وحدة'], /^(?:unit[ée]s?)$/i],
  ['name', ['البضاعة', 'نوع', 'السلعة', 'المادة', 'البيان', 'المنتوج'], /^(?:d[ée]signations?|articles?|libell[ée]s?|produits?|description)$/i],
  ['price', ['الثمن', 'ثمن', 'السعر', 'الفردي'], /^(?:p\.?u\.?|prix|unitaire)$/i],
  ['total', ['الواجب', 'المبلغ', 'المجموع', 'الإجمالي'], /^(?:montants?|total|mt)$/i],
].map(([kind, ar, fr]) => [kind, ar.map(norm), fr]);

// Type de colonne d'un mot d'en-tête (tolère une lettre mal lue : « النمن » -> « الثمن »).
function headerKind(text) {
  const t = String(text).trim();
  if (isArabic(t)) {
    const w = norm(t).replace(/[^؀-ۿ]/g, '');
    for (const [kind, words] of HEADERS) {
      if (words.some((k) => w === k || (w.length >= 4 && Math.abs(w.length - k.length) <= 1 && distance(w, k) <= 1))) return kind;
    }
    return null;
  }
  const l = t.replace(/[^\p{L}.]/gu, '');
  for (const [kind, , re] of HEADERS) if (re.test(l)) return kind;
  return null;
}

const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Ligne d'en-tête : le groupe de mots à la même hauteur qui contient le plus de types de colonnes (au moins 3).
function findHeader(pages) {
  let best = null;
  for (const page of pages) {
    const hits = (page?.words || []).filter((w) => w.bbox).map((w) => ({ kind: headerKind(w.text), bbox: w.bbox })).filter((h) => h.kind);
    for (const h of hits) {
      const tol = (h.bbox.y1 - h.bbox.y0) * 0.8 + 4;
      const row = hits.filter((o) => Math.abs(cy(o.bbox) - cy(h.bbox)) <= tol);
      const kinds = new Set(row.map((o) => o.kind));
      if (kinds.size >= 3 && (!best || kinds.size > best.kinds.size)) best = { kinds, row };
    }
  }
  if (!best) return null;
  const cols = {};
  for (const h of best.row) {
    const c = cols[h.kind];
    cols[h.kind] = c ? { x0: Math.min(c.x0, h.bbox.x0), x1: Math.max(c.x1, h.bbox.x1) } : { x0: h.bbox.x0, x1: h.bbox.x1 };
  }
  return { y0: Math.min(...best.row.map((h) => h.bbox.y0)), y1: Math.max(...best.row.map((h) => h.bbox.y1)), cols };
}

const isNumberWord = (t) => /\d/.test(t) && String(t).replace(/[^\d]/g, '').length >= String(t).replace(/[\s|()[\]]/g, '').length * 0.6;

// Lignes du tableau : les nombres alignés sous les en-têtes des montants (ou des prix).
function findRows(header, words) {
  const anchors = ['total', 'price'].filter((k) => header.cols[k]).map((k) => header.cols[k]);
  if (!anchors.length) return [];
  const nums = words.filter((w) => w.bbox && cy(w.bbox) > header.y1 && isNumberWord(w.text)
    && anchors.some((a) => Math.abs(cx(w.bbox) - cx(a)) <= Math.max(a.x1 - a.x0, 60) * 1.5));
  if (!nums.length) return [];
  const h = median(nums.map((w) => w.bbox.y1 - w.bbox.y0));
  // Un « mot » anormalement haut chevauche deux lignes (trait du tableau, tache) : ignoré.
  const sorted = nums.filter((w) => w.bbox.y1 - w.bbox.y0 <= h * 1.6).sort((a, b) => cy(a.bbox) - cy(b.bbox));
  const rows = [];
  for (const w of sorted) {
    const last = rows[rows.length - 1];
    if (last && cy(w.bbox) - last.c <= h * 0.7) {
      last.y0 = Math.min(last.y0, w.bbox.y0); last.y1 = Math.max(last.y1, w.bbox.y1);
    } else rows.push({ y0: w.bbox.y0, y1: w.bbox.y1, c: cy(w.bbox) });
  }
  // Fin du tableau : un grand espace vide (pied de facture, signature…).
  const gaps = rows.slice(1).map((r, i) => r.c - rows[i].c);
  const step = median(gaps);
  const end = gaps.findIndex((g) => rows.length > 2 && g > step * 2.5);
  return end >= 0 ? rows.slice(0, end + 1) : rows;
}

// Colonnes : séparées par les bandes verticales vides entre les mots du tableau.
function findColumns(header, rows, words) {
  const top = header.y0;
  const bottom = rows[rows.length - 1].y1;
  const zone = words.filter((w) => w.bbox && cy(w.bbox) >= top && cy(w.bbox) <= bottom && String(w.text).replace(/[|\s]/g, ''));
  const width = Math.max(...zone.map((w) => w.bbox.x1), ...Object.values(header.cols).map((c) => c.x1)) + 1;
  const cover = new Uint16Array(width);
  for (const w of zone) for (let x = Math.max(0, w.bbox.x0); x < Math.min(width, w.bbox.x1); x += 1) cover[x] += 1;
  const noise = Math.max(1, Math.round(rows.length * 0.15));
  const allSegs = [];
  let start = -1;
  for (let x = 0; x <= width; x += 1) {
    const busy = x < width && cover[x] > noise;
    if (busy && start < 0) start = x;
    if (!busy && start >= 0) { allSegs.push({ x0: start, x1: x }); start = -1; }
  }
  // Seules les bandes qui contiennent des données (sous l'en-tête) sont des colonnes.
  const data = zone.filter((w) => cy(w.bbox) > header.y1);
  const segs = allSegs.filter((s) => data.filter((w) => cx(w.bbox) >= s.x0 && cx(w.bbox) <= s.x1).length >= Math.max(2, rows.length * 0.3));
  // Chaque en-tête prend la bande de données la plus proche (un en-tête centré au-dessus de données alignées
  // à droite peut déborder de sa colonne) ; deux en-têtes dans une même bande se la partagent.
  const kinds = Object.keys(header.cols).sort((a, b) => cx(header.cols[a]) - cx(header.cols[b]));
  const cols = {};
  const gapTo = (s, c) => (c < s.x0 ? s.x0 - c : c > s.x1 ? c - s.x1 : 0);
  const taken = new Map();
  for (const kind of [...kinds].sort((a, b) => (header.cols[a].x1 - header.cols[a].x0) - (header.cols[b].x1 - header.cols[b].x0))) {
    const c = cx(header.cols[kind]);
    const free = segs.filter((s) => gapTo(s, c) === 0 || !taken.has(s));
    const seg = free.sort((a, b) => gapTo(a, c) - gapTo(b, c))[0];
    if (seg && gapTo(seg, c) <= Math.max(80, (header.cols[kind].x1 - header.cols[kind].x0) * 1.5)) {
      taken.set(seg, kind);
      cols[kind] = { ...seg };
    } else cols[kind] = { x0: header.cols[kind].x0, x1: header.cols[kind].x1 };
  }
  for (let i = 1; i < kinds.length; i += 1) {
    const a = cols[kinds[i - 1]];
    const b = cols[kinds[i]];
    if (a.x1 > b.x0) { const mid = Math.round((cx(header.cols[kinds[i - 1]]) + cx(header.cols[kinds[i]])) / 2); a.x1 = mid; b.x0 = mid; }
  }
  // Colonne de quantité sans en-tête lisible : la bande de chiffres restante, du côté opposé aux montants.
  if (!cols.qty && cols.name) {
    const used = Object.values(cols);
    const free = segs.filter((s) => !used.some((u) => s.x0 < u.x1 && s.x1 > u.x0))
      .filter((s) => zone.filter((w) => cx(w.bbox) >= s.x0 && cx(w.bbox) <= s.x1 && isNumberWord(w.text)).length >= rows.length * 0.5);
    const amountsLeft = cols.total && cx(cols.total) < cx(cols.name);
    const side = free.filter((s) => (amountsLeft ? s.x0 > cols.name.x1 : s.x1 < (cols.price || cols.total || { x0: Infinity }).x0 && s.x0 > cols.name.x1));
    if (side.length) cols.qty = amountsLeft ? side[side.length - 1] : side[0];
  }
  return cols;
}

const close = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.01);

// Quantité × prix = montant : on corrige une virgule perdue ou une case illisible.
// bad : cases lues avec des caractères suspects (« 1/0.00 ») — recalculées à partir des deux autres.
function reconcile(q, p, t, bad = {}, unit = null) {
  // Quantité à virgule possible seulement pour un poids ou un volume (1,5 kg) ; sinon un nombre entier.
  const decimalOk = !unit || ['kg', 'g', 'L', 'ml', 'cl'].includes(unit);
  const ok = (x) => Number.isFinite(x) && x > 0;
  if (ok(q) && ok(p) && ok(t)) {
    for (const tt of [t, t / 100]) for (const pp of [p, p / 100]) if (close(q * pp, tt)) return { q, p: pp, t: tt, sure: true };
    if (bad.t && !bad.q && !bad.p) return { q, p, t: q * p, sure: false };
    if (bad.p && !bad.q && !bad.t) return { q, p: t / q, t, sure: false };
    const q2 = t / p;
    if (Math.abs(q2 - Math.round(q2)) < 0.01 && Math.round(q2) >= 1) return { q: Math.round(q2), p, t, sure: false };
    if (decimalOk && Math.round(q2 * 1000) === q2 * 1000 && q2 >= 0.1) return { q: Math.round(q2 * 1000) / 1000, p, t, sure: false };
    return { q, p: t / q, t, sure: false };
  }
  if (ok(q) && ok(p)) return { q, p, t: q * p, sure: false };
  if (ok(q) && ok(t)) return { q, p: t / q, t, sure: false };
  if (ok(p) && ok(t)) {
    // Quantité déduite : seulement si elle est plausible (entière ou à 2 décimales au plus, comme 1,5) ;
    // sinon le prix est mal lu : 1 article au prix du montant.
    const q2 = t / p;
    if (Math.abs(q2 - Math.round(q2)) < 0.01 && Math.round(q2) >= 1) return { q: Math.round(q2), p, t, sure: false };
    if (decimalOk && q2 >= 0.1 && Math.abs(q2 * 100 - Math.round(q2 * 100)) < 0.01) return { q: Math.round(q2 * 100) / 100, p, t, sure: false };
    return { q: 1, p: t, t, sure: false };
  }
  if (ok(t)) return { q: 1, p: t, t, sure: false };
  return null;
}

const clean = (s) => String(s || '').normalize('NFKC').replace(/[‎‏]/g, '').trim();

// Nom en français : traduction de l'arabe si elle est complète, sinon la partie française lue.
function cellName(araText, frText) {
  const arabicTokens = clean(araText).split(/\s+/).map((x) => x.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')).filter((x) => x && isArabic(x));
  const tr = arabicTokens.length ? translateName(arabicTokens.join(' ')) : null;
  const latin = clean(frText).split(/\s+/).filter((x) => !isArabic(x) && /[\p{L}\d]/u.test(x)).join(' ')
    .replace(/^[^\p{L}\d]+|[^\p{L}\d)]+$/gu, '');
  const french = latin && /[a-zA-ZÀ-ÿ]{3,}/.test(latin) ? stripOcrJunk(fixSpelling(latin)) : '';
  if (tr && tr.complete && tr.nouns) return tr.text;
  // Partie française illisible (aucun mot connu) : la traduction partielle de l'arabe est plus sûre.
  if (french && (hasKnownWord(french) || !(tr && tr.nouns))) return french;
  if (tr && tr.nouns) return tr.knownText;
  if (french) return french;
  return tr ? tr.text : latin;
}

// Mots de la page dont le centre tombe dans une case (colonne × ligne), de gauche à droite.
function cellWords(page, col, row) {
  if (!page) return [];
  const h = row.y1 - row.y0;
  return (page.words || []).filter((w) => w.bbox && cx(w.bbox) >= col.x0 && cx(w.bbox) <= col.x1
    && cy(w.bbox) >= row.y0 - h * 0.5 && cy(w.bbox) <= row.y1 + h * 0.5)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);
}

// frPage / araPage : lectures de la page entière (avec les positions des mots).
// read(kind, rect) : relit une case seule quand elle est vide — 'num' (chiffres), 'fr' ou 'ara'.
async function readTable({ frPage, araPage, read }) {
  const pages = [araPage, frPage].filter(Boolean);
  const header = findHeader(pages);
  if (!header || !(header.cols.total || header.cols.price) || !header.cols.name) return null;
  const words = pages.flatMap((p) => p.words || []);
  const numPage = frPage || araPage;
  let rows = findRows(header, numPage.words || []);
  // Fin du tableau : la ligne « Total / TVA / المبلغ الإجمالي… » et tout ce qui suit.
  const footer = pages.flatMap((p) => p.lines || []).filter((l) => l.bbox && /total|t\.?v\.?a|ttc|net\s*[àa]\s*payer|المبلغ|الإجمالي|المجموع/i.test(clean(l.text)) && cy(l.bbox) > header.y1);
  if (footer.length) {
    const firstFooter = Math.min(...footer.map((l) => l.bbox.y0));
    rows = rows.filter((r) => r.c < firstFooter);
  }
  if (rows.length < 2) return null;
  const cols = findColumns(header, rows, words);
  const arabic = (araPage?.words || []).some((w) => isArabic(w.text) && headerKind(w.text));

  const rect = (col, row) => {
    const h = row.y1 - row.y0;
    const pad = Math.round(h * 0.35) + 3;
    return { left: Math.max(0, col.x0 - 4), top: Math.max(0, row.y0 - pad), width: col.x1 - col.x0 + 8, height: h + pad * 2 };
  };
  const text = (ws) => ws.map((w) => clean(w.text)).join(' ');
  const cells = [];
  for (const row of rows) {
    const c = {};
    for (const kind of ['qty', 'price', 'total']) {
      if (!cols[kind]) continue;
      // Les nombres viennent de la lecture française (chiffres mieux séparés) ; case vide : relue seule.
      let ws = cellWords(numPage, cols[kind], row).filter((w) => /[\d٠-٩]/.test(w.text));
      if (!ws.length && araPage) ws = cellWords(araPage, cols[kind], row).filter((w) => /[\d٠-٩]/.test(w.text));
      // Quantité « 1 » lue comme la lettre I ou l.
      if (!ws.length && kind === 'qty') ws = cellWords(numPage, cols[kind], row).filter((w) => /^[Il]$/.test(clean(w.text))).map((w) => ({ ...w, text: '1' }));
      c[kind] = ws.length ? parseAmount(text(ws)) : NaN;
      c.bad = c.bad || {};
      c.bad[kind === 'qty' ? 'q' : kind === 'price' ? 'p' : 't'] = ws.length > 0 && /[^\d٠-٩.,\s]/.test(text(ws).replace(/^[|()[\]]+|[|()[\]]+$/g, ''));
      if (!Number.isFinite(c[kind]) && read) c[kind] = parseAmount(await read('num', rect(cols[kind], row)));
    }
    // Ligne qui ne tombe pas juste : ses cases de nombres sont relues seules, on garde la combinaison
    // (lecture de la page ou relecture) où quantité × prix = montant.
    const first = reconcile(c.qty, c.price, c.total, c.bad);
    if (read && first && !first.sure && cols.qty && cols.price && cols.total) {
      const again = {};
      for (const kind of ['qty', 'price', 'total']) again[kind] = parseAmount(await read('num', rect(cols[kind], row)));
      // Combinaisons essayées en gardant d'abord le plus de valeurs lues sur la page ; sans correction
      // de virgule (elle trouverait des combinaisons justes mais fausses, comme 20 × 0,086 = 1,72).
      const combos = [];
      for (const q of [[c.qty, 0], [again.qty, 1]]) {
        for (const p of [[c.price, 0], [again.price, 1]]) {
          for (const t of [[c.total, 0], [again.total, 1]]) combos.push({ q: q[0], p: p[0], t: t[0], reread: q[1] + p[1] + t[1] });
        }
      }
      const okNum = (x) => Number.isFinite(x) && x > 0;
      const hit = combos.sort((a, b) => a.reread - b.reread)
        .find((x) => okNum(x.q) && okNum(x.p) && okNum(x.t) && close(x.q * x.p, x.t));
      if (hit) { c.qty = hit.q; c.price = hit.p; c.total = hit.t; c.bad = {}; }
    }
    if (cols.name) {
      c.frName = text(cellWords(frPage, cols.name, row));
      // L'arabe se lit de droite à gauche : mots pris de la droite vers la gauche.
      c.araName = arabic ? text(cellWords(araPage, cols.name, row).reverse()) : '';
    }
    if (cols.unit) {
      const ws = cellWords(arabic ? araPage : frPage, cols.unit, row);
      c.unit = findUnit(text(ws), { fuzzy: true }) || frenchUnitWord(text(ws));
      if (!c.unit && read) {
        const t = await read(arabic ? 'ara' : 'fr', rect(cols.unit, row));
        c.unit = findUnit(clean(t), { fuzzy: true }) || frenchUnitWord(t);
      }
    }
    cells.push(c);
  }

  let invoiceTotal = 0;
  const lines = [];
  cells.forEach((c, i) => {
    const hasQty = Number.isFinite(c.qty) && c.qty > 0;
    const hasPrice = Number.isFinite(c.price) && c.price > 0;
    // Ligne sans quantité ni prix, avec un montant : le total de la facture (« المبلغ الإجمالي »).
    if (!hasQty && !hasPrice) {
      if (Number.isFinite(c.total) && i >= rows.length - 2) invoiceTotal = c.total;
      return;
    }
    const v = reconcile(c.qty, c.price, c.total, c.bad, c.unit);
    if (!v) return;
    const name = cellName(c.araName, c.frName);
    if (!name) return;
    lines.push({ name, quantity: v.q, unit: c.unit || 'unité', unit_price: Math.round(v.p * 100) / 100, total: Math.round(v.t * 100) / 100, sure: v.sure });
  });
  return { lines, total: invoiceTotal, columns: Object.keys(cols) };
}

// Unité écrite en français dans sa case (« Kg », « Pcs »…).
function frenchUnitWord(text) {
  const t = clean(text).toLowerCase().replace(/[^a-zàâéèêîïôû]/g, '');
  const map = { kg: 'kg', kgs: 'kg', kilo: 'kg', g: 'g', gr: 'g', l: 'L', lt: 'L', litre: 'L', ml: 'ml', cl: 'cl', u: 'pièce', pc: 'pièce', pcs: 'pièce', pce: 'pièce', pces: 'pièce', piece: 'pièce', pièce: 'pièce', unite: 'pièce', unité: 'pièce', pqt: 'paquet', paquet: 'paquet', bte: 'boîte', boite: 'boîte', boîte: 'boîte', ctn: 'carton', carton: 'carton', sac: 'sac', sachet: 'sachet', plateau: 'plateau', dz: 'douzaine', pot: 'pot', btl: 'bouteille', bouteille: 'bouteille' };
  return map[t] || null;
}

module.exports = { readTable, headerKind, findHeader, findRows, findColumns, cellWords };
