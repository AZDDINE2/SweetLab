// Transforme le texte lu sur la photo d'une facture (lecture gratuite, Tesseract) en brouillon :
// fournisseur, date, total et lignes (article, quantité, prix unitaire, montant).
// Gère les factures françaises (Article | Qté | P.U | Montant) et arabes, lues de droite à gauche
// (Montant | Prix | Article | Unité | Quantité), ainsi que les virgules perdues à la lecture.

const { findUnit, translateName, isArabic, fixSpelling, stripOcrJunk } = require('./arabic-fr');

// "1 250,00" / "1.250,00" / "7,50" / "120.00" / "24" -> nombre
function parseAmount(raw) {
  let t = String(raw).replace(/\s|DH|MAD|dhs?/gi, '');
  if (/,\d{1,3}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{1,2}$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(/[.,]/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const AMOUNT = String.raw`(?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d{1,3})?`;
const NUMBER_CELL = new RegExp(String.raw`^${AMOUNT}(?:\s*(?:DH|MAD|dhs?))?$`, 'i');
const LEADING_NUMBER = new RegExp(String.raw`^(${AMOUNT})[^\p{L}\d\s]*\s+(?=.*\p{L})`, 'u');
const TRAILING_NUMBER = new RegExp(String.raw`(?<=\p{L}.*)\s+(${AMOUNT})$`, 'u');
// Mots d'en-tête ou de pied de facture (mots entiers : « nutella » ne doit pas être pris pour « tél »).
const NOT_AN_ARTICLE = /\btotal|\bt\.?v\.?a\b|\bttc\b|\bh\.?t\b|\bremise|net\s*[àa]\s*payer|\breste\b|\bacompte|\bdate\b|\bt[ée]l\b|\bfax\b|\bfacture|\bbon de\b|\bice\b|\brc\b|\bpatente|\bi\.?f\b|\bcnss|d[ée]signation|\bqt[ée]|\bquantit|\bp\.?\s?u\b|\bprix\b|\bmontant|\bpage\b|\bmerci|\bsignature|\badresse|\bclient/i;

const latinCount = (s) => (s.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
// Lettres latines ou arabes (le texte d'un PDF contient le vrai arabe, contrairement à la lecture d'une photo).
const letterCount = (s) => (s.match(/[a-zA-ZÀ-ÿ؀-ۿ]/g) || []).length;
const hasWord = (s) => /[a-zA-ZÀ-ÿ]{3,}|[؀-ۿ]{2,}/.test(s);
// Enlève la ponctuation parasite au début et à la fin d'une case ("110.00)" -> "110.00", "| 12 |" -> "12").
const cleanEnds = (c) => c.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
const close = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.01);

// Découpe une ligne en cases : colonnes séparées par 2 espaces ou plus ; un nombre collé au début
// d'un nom (un seul espace) devient sa propre case, de même en fin de ligne.
// Unités écrites en français dans une colonne (« Kg », « Pcs », « Ctn »…) ou collées à la quantité (« 12 kg »).
const FR_UNITS = [
  [/^(?:kgs?|kilos?|kilogrammes?)$/i, 'kg'], [/^(?:g|grs?|grammes?)$/i, 'g'], [/^(?:l|lt|ltr|litres?)$/i, 'L'],
  [/^ml$/i, 'ml'], [/^cl$/i, 'cl'], [/^(?:u|un|unit[ée]s?|units?|pcs?|pces?|pi[eè]ces?)$/i, 'pièce'],
  [/^(?:pqts?|paquets?)$/i, 'paquet'], [/^(?:btes?|bo[iî]tes?)$/i, 'boîte'], [/^(?:ctns?|crts?|cartons?)$/i, 'carton'],
  [/^sacs?$/i, 'sac'], [/^sachets?$/i, 'sachet'], [/^(?:btls?|bouteilles?)$/i, 'bouteille'], [/^plateaux?$/i, 'plateau'],
  [/^(?:dz|douzaines?)$/i, 'douzaine'], [/^(?:rlx|rouleaux?)$/i, 'rouleau'], [/^lots?$/i, 'lot'], [/^pots?$/i, 'pot'],
  [/^fardeaux?$/i, 'fardeau'], [/^seaux?$/i, 'seau'], [/^bidons?$/i, 'bidon'],
];
function frenchUnit(text) {
  const t = String(text).trim().replace(/\.$/, '');
  for (const [re, unit] of FR_UNITS) if (re.test(t)) return unit;
  return null;
}
const UNIT_WORD = String.raw`(?:kgs?|kilos?|grs?|g|l|lt|ltr|litres?|ml|cl|u|pcs?|pces?|pi[eè]ces?|pqts?|paquets?|btes?|bo[iî]tes?|ctns?|cartons?|sacs?|sachets?|btls?|bouteilles?|plateaux?|dz|douzaines?|rlx|rouleaux?|lots?|pots?)`;
const NUMBER_WITH_UNIT = new RegExp(String.raw`^(${AMOUNT})\s*(${UNIT_WORD})\.?$`, 'i');

function rowCells(line) {
  const out = [];
  const raws = line.split(/\s{2,}/);
  raws.forEach((raw, ri) => {
    // "120 00" : virgule lue comme une espace.
    let c = cleanEnds(raw.trim()).replace(/^(\d+) (\d{2})$/, '$1,$2');
    if (!c) return;
    // « 12 kg » / « 1,5kg » : la quantité, puis l'unité dans sa propre case.
    const withUnit = c.match(NUMBER_WITH_UNIT);
    if (withUnit) { out.push({ v: withUnit[1], isQty: true }, { text: withUnit[2] }); return; }
    const head = [];
    const tail = [];
    if (!NUMBER_CELL.test(c)) {
      for (let m = c.match(LEADING_NUMBER); m; m = c.match(LEADING_NUMBER)) { head.push(m[1]); c = cleanEnds(c.slice(m[0].length)); }
      // Nombres en fin de nom : seulement sur la dernière case (ligne écrite avec un seul espace).
      if (ri === raws.length - 1) {
        for (let m = c.match(TRAILING_NUMBER); m; m = c.match(TRAILING_NUMBER)) { tail.unshift(m[1]); c = cleanEnds(c.slice(0, m.index)); }
      }
    }
    out.push(...head.map((v) => ({ v })), ...(c ? [{ text: c }] : []), ...tail.map((v) => ({ v })));
  });
  return out.map((cell) => {
    if (cell.v !== undefined || NUMBER_CELL.test(cell.text)) {
      const raw = (cell.v ?? cell.text).trim();
      return {
        isQty: Boolean(cell.isQty),                              // suivi d'une unité : c'est la quantité
        priceFmt: /[.,]\d{2}$/.test(raw),                       // 2 décimales : format d'un prix
        num: parseAmount(raw),
        noSep: /^\d{3,}$/.test(raw.replace(/\s|DH|MAD/gi, '')), // "4500" : peut-être "45,00" mal lu
        hasDec: /[.,]\d{1,3}$/.test(raw),                       // écrit avec des décimales : un prix
      };
    }
    return cell;
  }).filter((c) => c.text !== undefined || Number.isFinite(c.num));
}

// Nettoie le nom lu : enlève les mots parasites en fin de nom (souvent du texte arabe mal lu).
function cleanName(text) {
  let tokens = text.split(/\s+/);
  // Nom bilingue (« glucoze 4kg كليكوز 4ك ») : on garde la partie en français, plus fiable à relire.
  const arabic = (t) => /[؀-ۿ]/.test(t);
  if (tokens.some((t) => !arabic(t) && latinCount(t) >= 3)) tokens = tokens.filter((t) => !arabic(t));
  const good = (t) => (/[aeiouyàâéèêëîïôûù]/i.test(t) && latinCount(t) >= 3) // mot
    || /[؀-ۿ]{2,}/.test(t)                                           // mot arabe
    || /^\d+(?:[.,]\d+)?(?:kg|g|l|ml|cl|m|cm)?$/i.test(t)                    // taille : 4kg, 700g, 1.5
    || /^[a-z]{1,3}\d+$/i.test(t);                                          // référence : T55, N3
  while (tokens.length > 1 && !good(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

// Cherche quantité × prix unitaire = montant parmi les nombres de la ligne (avec ou sans virgule perdue).
function findTriple(nums) {
  const cands = [];
  nums.forEach((n, idx) => {
    cands.push({ ...n, idx, val: n.num, fixed: false });
    if (n.noSep && n.num >= 100) cands.push({ ...n, idx, val: n.num / 100, fixed: true });
  });
  // Quantité : le nombre suivi d'une unité (« 1,5kg ») ; la colonne à droite du nom sur une facture arabe ;
  // sinon le nombre écrit sans décimales, puis sans les 2 décimales d'un prix (« 1,5 » plutôt que « 120,00 »),
  // puis le nombre entier ; prix : l'autre facteur.
  const qFirst = (x, y) => (x.isQty !== y.isQty ? Boolean(x.isQty)
    : x.side !== y.side ? x.side === 'after'
    : x.hasDec !== y.hasDec ? !x.hasDec
    : x.priceFmt !== y.priceFmt ? !x.priceFmt
      : Number.isInteger(x.val) !== Number.isInteger(y.val) ? Number.isInteger(x.val)
        : x.idx < y.idx);
  let best = null;
  for (const t of cands) {
    for (const a of cands) {
      for (const b of cands) {
        if (a.idx === b.idx || a.idx === t.idx || b.idx === t.idx || t.val <= 0) continue;
        if (!close(a.val * b.val, t.val)) continue;
        const [q, p] = qFirst(a, b) ? [a, b] : [b, a];
        const fixes = [q, p, t].filter((x) => x.fixed).length;
        const score = t.val - fixes * 1e-6; // le plus grand montant ; à égalité, le moins de corrections
        if (!best || score > best.score) {
          best = { score, qty: q.val, unit_price: p.val, total: t.val, noComma: t.noSep && !t.fixed };
        }
      }
    }
  }
  return best;
}

// Quantité déduite du montant et du prix (virgule du prix éventuellement perdue) quand elle tombe juste.
function qtyFrom(t, p) {
  for (const pv of [p.num, ...(p.noSep ? [p.num / 100] : [])]) {
    const q = pv ? t / pv : 0;
    if (q >= 1 && Math.abs(q - Math.round(q)) < 0.01) return { q: Math.round(q), p: pv };
  }
  return null;
}

// Nom en français : la partie française du fournisseur si elle existe, sinon la traduction de l'arabe.
function frenchName(cellText) {
  const latin = cleanName(cellText);
  const arabicPart = cellText.split(/\s+/).filter((t) => isArabic(t)).join(' ');
  if (!arabicPart) return latin;
  const hasLatin = /[a-zA-ZÀ-ÿ]{3,}/.test(latin);
  if (hasLatin) return latin;
  const tr = translateName(arabicPart);
  return tr.text || latin;
}

function parseRow(line) {
  const cells = rowCells(line);
  // Le nom : la case qui contient le plus de lettres latines (avec un vrai mot d'au moins 3 lettres).
  let ni = -1;
  cells.forEach((c, i) => {
    if (c.text && !frenchUnit(c.text) && hasWord(c.text) && (ni < 0 || letterCount(c.text) > letterCount(cells[ni].text))) ni = i;
  });
  if (ni < 0) return null;
  const name = frenchName(cells[ni].text);
  if (!name || NOT_AN_ARTICLE.test(name)) return null;
  // Unité : colonne en français (« Kg », « Pcs »…) ou en arabe (« كلغ » -> kg, « باكية » -> paquet…).
  const others = cells.filter((c, i) => i !== ni && c.text);
  const unit = others.map((c) => frenchUnit(c.text)).find(Boolean)
    // Cases hors du nom : lecture tolérante (lettres inversées dans certains PDF : « وحةد » = « وحدة »).
    || findUnit(others.map((c) => c.text).join(' '), { fuzzy: true }) || findUnit(cells[ni].text);
  const row = parseRowNumbers(cells, ni, name);
  return row && { ...row, unit: unit || 'unité' };
}

function parseRowNumbers(cells, ni, name) {

  const before = cells.slice(0, ni);
  const after = cells.slice(ni + 1);
  const bNums = before.filter((c) => c.text === undefined).map((c) => ({ ...c, side: 'before' }));
  const aNums = after.filter((c) => c.text === undefined).map((c) => ({ ...c, side: 'after' }));
  if (!bNums.length && !aNums.length) return null;

  const triple = findTriple([...bNums, ...aNums]);
  if (triple) return { name, quantity: triple.qty, unit_price: triple.unit_price, total: triple.total, noComma: triple.noComma };

  // Pas de combinaison cohérente : on se fie à la position des colonnes.
  const amounts = bNums.filter((n) => n.num > 0);
  if (amounts.length) {
    // Montants à gauche du nom (facture arabe) : [montant, prix], et la quantité tout à droite.
    const qty = aNums.length ? aNums[aNums.length - 1].num : null;
    if (amounts.length >= 2) {
      const [tn, pn] = amounts.slice(-2);
      const t = tn.num;
      const fromPrice = qtyFrom(t, pn);
      if (fromPrice) return { name, quantity: fromPrice.q, unit_price: fromPrice.p, total: t, noComma: tn.noSep };
      return { name, quantity: qty || 1, unit_price: qty ? t / qty : pn.num, total: t, noComma: tn.noSep };
    }
    const single = amounts[0].num;
    // Une case illisible avant le seul montant lu : c'était le montant de la ligne, celui-ci est le prix.
    const firstNum = before.findIndex((c) => c.text === undefined && c.num > 0);
    const garbageBefore = before.slice(0, firstNum).some((c) => c.text !== undefined);
    if (qty && garbageBefore) return { name, quantity: qty, unit_price: single, total: single * qty };
    return { name, quantity: qty || 1, unit_price: qty ? single / qty : single, total: single, noComma: amounts[0].noSep, weak: !qty && !amounts[0].priceFmt };
  }

  // Facture française : nom puis [quantité, prix, montant].
  const v = aNums.map((n) => n.num);
  if (v.length >= 3) {
    const t = v[v.length - 1];
    const fromPrice = qtyFrom(t, aNums[aNums.length - 2]);
    if (fromPrice) return { name, quantity: fromPrice.q, unit_price: fromPrice.p, total: t };
    const q = v[v.length - 3] || 1;
    return { name, quantity: q, unit_price: t / q, total: t, noComma: aNums[aNums.length - 1].noSep };
  }
  if (v.length === 2) {
    const [a, b] = v;
    const ratio = a ? b / a : 0;
    if (a && Math.abs(ratio - Math.round(ratio)) < 0.02 && Math.round(ratio) >= 1) return { name, quantity: Math.round(ratio), unit_price: a, total: b };
    if (Number.isInteger(a) && a > 0 && a < 1000) return { name, quantity: a, unit_price: b / a, total: b, noComma: aNums[1].noSep };
    return { name, quantity: 1, unit_price: b, total: b, noComma: aNums[1].noSep };
  }
  return { name, quantity: 1, unit_price: v[0], total: v[0], noComma: aNums[0].noSep, weak: !aNums[0].priceFmt };
}

// Si la somme des lignes ne tombe pas sur le total de la facture, on essaie de remettre la virgule
// ("13500" -> "135,00") sur les montants lus sans virgule, jusqu'à retrouver le total exact.
function fixLinesWithTotal(items, target) {
  const near = (v) => Math.abs(v - target) <= Math.max(0.05, target * 0.002);
  const sum = items.reduce((acc, l) => acc + l.total, 0);
  const suspects = items.filter((l) => l.noComma);
  if (!target || near(sum) || !suspects.length || suspects.length > 12) return;
  for (let mask = 1; mask < (1 << suspects.length); mask += 1) {
    const cut = suspects.reduce((acc, l, i) => acc + (mask & (1 << i) ? l.total * 0.99 : 0), 0);
    if (!near(sum - cut)) continue;
    suspects.forEach((l, i) => {
      if (!(mask & (1 << i))) return;
      l.total /= 100;
      if (l.unit_price > l.total) l.unit_price /= 100;
    });
    return;
  }
}

// ocr : texte lu sur une photo (noms plus bruités) ; sinon texte exact d'un PDF.
function parseInvoiceText(text, { ocr = false } = {}) {
  text = String(text);
  // Certains PDF stockent l'arabe dans l'ordre d'affichage (lettres à l'envers) : on le repère à l'article
  // « ال » qui se retrouve en fin de mot (« لا »), et on remet chaque passage arabe à l'endroit.
  // L'inversion se fait avant NFKC, pour que la ligature « لا » (un seul caractère) reste entière.
  const words = text.normalize('NFKC').match(/[؀-ۿ]{3,}/g) || [];
  const reversed = words.filter((w) => w.endsWith('لا')).length > words.filter((w) => w.startsWith('ال')).length;
  if (reversed) {
    const ar = '\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF'; // arabe + formes de présentation
    text = text.replace(new RegExp(`[${ar}]+(?:\\s+[${ar}]+)*`, 'g'), (run) => [...run].reverse().join(''));
  }
  // NFKC : lettres arabes de présentation (texte des PDF) -> lettres normales.
  text = text.normalize('NFKC').replace(/ی/g, 'ي').replace(/ک/g, 'ك'); // ی -> ي, ک -> ك
  const lines = text.split('\n')
    .map((l) => l.replace(/[|[\]]/g, ' ').trim())
    // Ligne arabe d'un PDF : « 1 261,00 » est stocké à l'envers (« 261,00 1 ») ; on le remet dans l'ordre.
    .map((l) => (/[؀-ۿ]/.test(l) ? l.replace(/(^|\s)(\d{3}[.,]\d{2}) (\d{1,3})(?=\s|$)/g, '$1$3 $2') : l))
    .filter(Boolean);

  // Fournisseur : une des premières lignes, faite surtout de lettres, d'un seul bloc, avec un vrai mot.
  const supplier = lines.slice(0, 6).find((l) => /[a-zA-ZÀ-ÿ]{4,}/.test(l) && !/\s{3,}/.test(l)
    && latinCount(l) / l.replace(/\s/g, '').length >= 0.6
    && !/facture|date|t[ée]l|^n°|bon de|livraison/i.test(l)) || '';

  let invoiceDate = '';
  const dm = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (dm) {
    const y = dm[3].length === 2 ? `20${dm[3]}` : dm[3];
    const mo = Number(dm[2]); const d = Number(dm[1]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) invoiceDate = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const lastNumber = (l) => {
    const m = l.match(new RegExp(AMOUNT, 'g'));
    return m ? parseAmount(m[m.length - 1]) : NaN;
  };
  let total = 0;
  const totalLine = lines.find((l) => /total\s*ttc|net\s*[àa]\s*payer|total\s*[àa]\s*payer|montant\s*ttc/i.test(l))
    || [...lines].reverse().find((l) => /total/i.test(l));
  if (totalLine) total = lastNumber(totalLine) || 0;
  const htLine = lines.find((l) => /total\s*h\.?\s*t\b|montant\s*h\.?\s*t\b/i.test(l));
  const subtotal = htLine ? lastNumber(htLine) || 0 : 0;

  let items = [];
  for (const l of lines) {
    if (l === totalLine || l === htLine || /total|t\.?v\.?a\b|net\s*[àa]\s*payer/i.test(l) || !hasWord(l)) continue;
    const row = parseRow(l);
    if (row && Number.isFinite(row.total) && row.total > 0) {
      items.push({ ...row, single: row.quantity === 1 && row.unit_price === row.total });
    }
  }
  // Texte de l'en-tête pris pour un article : lignes à un seul montant avant la première vraie ligne du tableau.
  const firstReal = items.findIndex((l) => !l.single);
  if (firstReal > 0) items = items.slice(firstReal);
  // Suite d'un nom sur 2 lignes (« ريش اسود 1.5 ») prise pour un article : un seul nombre, pas écrit comme un prix.
  if (items.filter((l) => !l.weak).length >= 3) items = items.filter((l) => !l.weak);

  // Ligne du total écrite en arabe (« المبلغ الإجمالي ») : un seul montant, à la fin, au moins 80 % du reste.
  const last = items[items.length - 1];
  if (last && items.length > 2 && last.single) {
    const others = items.slice(0, -1).reduce((acc, l) => acc + l.total, 0);
    if (last.total >= others * 0.8) {
      items.pop();
      if (!total) total = last.total;
    }
  }
  // Total introuvable : un montant du texte égal à la somme des lignes.
  if (!total && items.length) {
    const sum = items.reduce((acc, l) => acc + l.total, 0);
    const amounts = (text.match(new RegExp(AMOUNT, 'g')) || []).map(parseAmount);
    total = amounts.find((a) => a > 0 && close(a, sum)) || 0;
  }

  fixLinesWithTotal(items, subtotal || total);
  const lines_ = items.map((l) => ({
    name: ocr ? stripOcrJunk(fixSpelling(l.name)) : fixSpelling(l.name), // « levuer » -> « levure »
    quantity: Math.round(l.quantity * 1000) / 1000,
    unit: l.unit,
    unit_price: Math.round(l.unit_price * 100) / 100,
    total: Math.round(l.total * 100) / 100,
  }));
  return { supplier, invoice_date: invoiceDate, total, subtotal, lines: lines_ };
}

// Photo d'une facture arabe : une 2e lecture en arabe donne l'unité et le nom de chaque ligne,
// traduits en français. Les lignes sont retrouvées par leur montant (lu par la 1re lecture).
// page : résultat de Tesseract (lignes et mots avec leur position sur la photo).
// readCell(rect) : relit une petite zone de la photo (une case du tableau) et renvoie son texte.
// frPage : la 1re lecture (française) avec les positions, pour situer chaque ligne par son montant.
async function enrichWithArabic(items, page, readCell = null, frPage = null) {
  const clean = (s) => String(s).normalize('NFKC').replace(/[‎‏]/g, '');
  const lines = (page.lines || []).map((l) => {
    const raw = clean(l.text);
    return { raw, flat: raw.replace(/\s/g, ''), bbox: l.bbox, words: l.words || [] };
  });
  const has = (l, v) => {
    const t = Number(v).toFixed(2);
    return l.flat.includes(t) || l.flat.includes(t.replace('.', ','));
  };

  // 1. Ligne de chaque article : contient le montant (et si possible le prix), parmi les 6 lignes suivantes,
  //    pour ne pas sauter loin en avant quand un montant a été mal lu.
  let from = 0;
  const rowOf = items.map((item) => {
    let idx = -1;
    let bestScore = 0;
    for (let i = from; i < Math.min(lines.length, from + 6); i += 1) {
      const score = (has(lines[i], item.total) ? 2 : 0) + (has(lines[i], item.unit_price) ? 1 : 0);
      if (score >= 2 && score > bestScore) { bestScore = score; idx = i; }
    }
    if (idx >= 0) from = idx + 1;
    return idx;
  });

  // 2. Nom traduit de l'arabe.
  items.forEach((item, k) => {
    if (rowOf[k] < 0) return;
    const tokens = lines[rowOf[k]].raw.split(/[\s|]+/).map((x) => x.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')).filter((x) => x && isArabic(x));
    const tr = translateName(tokens.join(' '));
    // Traduction complète, ou au moins la moitié des mots dont un nom (« grand » seul ne suffit pas).
    if (tr.complete && tr.nouns) item.name = tr.text;
    else if (tr.nouns && tr.known / tr.arabicWords >= 0.5) item.name = tr.knownText;
  });

  // 3. Colonne des unités : là où sont les mots d'unité reconnus (au moins 2), alignés verticalement.
  const unitWords = (page.words || []).filter((w) => w.bbox && findUnit(clean(w.text)) && !/الوحد/.test(clean(w.text)));
  let col = null;
  if (unitWords.length >= 2) {
    const centers = unitWords.map((w) => (w.bbox.x0 + w.bbox.x1) / 2).sort((a, b) => a - b);
    const median = centers[Math.floor(centers.length / 2)];
    const inCol = unitWords.filter((w) => Math.abs((w.bbox.x0 + w.bbox.x1) / 2 - median) <= 60);
    const x0 = Math.min(...inCol.map((w) => w.bbox.x0));
    const x1 = Math.max(...inCol.map((w) => w.bbox.x1));
    const pad = Math.round((x1 - x0) * 0.25) + 8;
    col = { x0: Math.max(0, x0 - pad), x1: x1 + pad };
  }

  // Hauteur de chaque article sur la photo : position de son montant dans la 1re lecture (une case = un nombre,
  // position fiable) ; sinon sa ligne dans la lecture arabe ; sinon déduite de ses voisines.
  const frWords = (frPage?.words || []).filter((w) => w.bbox);
  // Candidats : chaque mot qui contient le montant d'un article. On garde la plus longue suite d'articles
  // dont les montants se suivent de haut en bas (un montant mal lu ne décale pas les lignes suivantes).
  const cands = [];
  items.forEach((item, k) => {
    // Le montant de la ligne, ou à défaut son prix unitaire (même hauteur sur la photo).
    const keys = [item.total, item.unit_price].flatMap((v) => { const t = Number(v).toFixed(2); return [t, t.replace('.', ',')]; });
    for (const w of frWords) {
      if (keys.some((key) => w.text.replace(/\s/g, '').includes(key))) cands.push({ k, y: (w.bbox.y0 + w.bbox.y1) / 2, bbox: w.bbox });
    }
  });
  cands.sort((a, b) => a.k - b.k || b.y - a.y);
  const chain = cands.map(() => ({ len: 1, prev: -1 }));
  cands.forEach((c, i) => {
    for (let j = 0; j < i; j += 1) {
      if (cands[j].k < c.k && cands[j].y < c.y && chain[j].len + 1 > chain[i].len) chain[i] = { len: chain[j].len + 1, prev: j };
    }
  });
  const ys = items.map(() => null);
  let end = chain.reduce((best, c, i) => (best < 0 || c.len > chain[best].len ? i : best), -1);
  for (; end >= 0; end = chain[end].prev) ys[cands[end].k] = { y0: cands[end].bbox.y0, y1: cands[end].bbox.y1 };
  if (!frWords.length) {
    rowOf.forEach((i, k) => { if (i >= 0 && lines[i].bbox) ys[k] = { y0: lines[i].bbox.y0, y1: lines[i].bbox.y1 }; });
  }
  ys.forEach((y, k) => {
    if (y) return;
    // Deux lignes connues autour (ou, pour la première/dernière ligne, les deux plus proches du même côté).
    const known = ys.map((v, i) => (v && !v.guessed ? i : -1)).filter((i) => i >= 0);
    let p = known.filter((i) => i < k).pop();
    let n = known.find((i) => i > k);
    if (p === undefined) [p, n] = [known[0], known[1]];
    else if (n === undefined) [p, n] = [known[known.length - 2], known[known.length - 1]];
    if (p === undefined || n === undefined) return;
    const step = (ys[n].y0 - ys[p].y0) / (n - p);
    const h = ys[p].y1 - ys[p].y0;
    ys[k] = { y0: Math.round(ys[p].y0 + step * (k - p)), y1: Math.round(ys[p].y0 + step * (k - p) + h), guessed: true };
  });

  // 4. Unité de chaque article : mot de la colonne à sa hauteur, sinon relecture de la case seule.
  // Mots d'unité de la colonne, avec leur hauteur.
  const colUnits = col ? (page.words || [])
    .filter((w) => w.bbox && (w.bbox.x0 + w.bbox.x1) / 2 >= col.x0 && (w.bbox.x0 + w.bbox.x1) / 2 <= col.x1)
    .map((w) => ({ unit: findUnit(clean(w.text), { fuzzy: true }), c: (w.bbox.y0 + w.bbox.y1) / 2 }))
    .filter((w) => w.unit) : [];
  for (let k = 0; k < items.length; k += 1) {
    const item = items[k];
    let unit = null;
    if (col && ys[k]) {
      const h = ys[k].y1 - ys[k].y0;
      const center = (ys[k].y0 + ys[k].y1) / 2;
      // Le mot d'unité le plus proche de la ligne (à moins d'une hauteur de ligne).
      const near = colUnits.map((w) => ({ ...w, d: Math.abs(w.c - center) })).filter((w) => w.d <= Math.max(h, 20)).sort((a, b) => a.d - b.d)[0];
      unit = near ? near.unit : null;
      if (!unit && readCell) {
        const pad = Math.round(h * 0.4) + 4;
        const text = await readCell({ left: col.x0, top: Math.max(0, ys[k].y0 - pad), width: col.x1 - col.x0, height: h + pad * 2 });
        unit = findUnit(clean(text), { fuzzy: true });
      }
    } else if (rowOf[k] >= 0) {
      unit = findUnit(lines[rowOf[k]].raw); // pas de colonne repérée : un mot d'unité sur la ligne
    }
    if (unit) item.unit = unit;
  }
  return items;
}

module.exports = { parseInvoiceText, parseAmount, enrichWithArabic };
