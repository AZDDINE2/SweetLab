// Traduction arabe / darija -> français des factures de pâtisserie : unités et noms d'articles.
// Dictionnaire volontairement limité au métier (ingrédients, emballages, unités) ; un mot inconnu reste en arabe.

// Lettres arabes normalisées : sans voyelles ni tatweel, alef/ya/ta marbouta unifiés.
function norm(word) {
  return String(word)
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ‎‏]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ی/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ة/g, 'ه');
}

const UNITS = {
  'كلغ': 'kg', 'كلع': 'kg', 'كلم': 'kg', 'كغ': 'kg', 'كيلو': 'kg', 'كيلوغرام': 'kg', 'كلغرام': 'kg',
  'غرام': 'g', 'غ': 'g', 'لتر': 'L', 'ليتر': 'L', 'ميليلتر': 'ml',
  // وحدة dans une case = une seule pièce (à ne pas confondre avec الوحدة, le titre de la colonne).
  'وحده': 'pièce', 'حبه': 'pièce', 'قطعه': 'pièce',
  'باكيه': 'paquet', 'باكيت': 'paquet', 'اباكيه': 'paquet', 'رزمه': 'paquet', 'بكيه': 'paquet',
  'علبه': 'boîte', 'صندوق': 'carton', 'كرطونه': 'carton', 'كارطونه': 'carton', 'كرتونه': 'carton', 'كارطون': 'carton',
  'كيس': 'sachet', 'قنينه': 'bouteille', 'دزينه': 'douzaine', 'سطل': 'seau', 'بيدون': 'bidon', 'رول': 'rouleau', 'لفه': 'rouleau',
};

// Mot arabe (normalisé) -> français.
const WORDS = {
  // Ingrédients
  'حليب': 'lait', 'حليب مركز': 'lait concentré', 'مركز': 'concentré', 'مكثف': 'concentré', 'محلي': 'sucré',
  'سكر': 'sucre', 'سكر كلاصي': 'sucre glace', 'كلاصي': 'glace', 'بيض': 'œufs', 'بيضه': 'œuf',
  'دقيق': 'farine', 'طحين': 'farine', 'فارينه': 'farine', 'زبده': 'beurre', 'زبد': 'beurre', 'مارغارين': 'margarine',
  'شكلاط': 'chocolat', 'شوكولاطه': 'chocolat', 'شوكلاطه': 'chocolat', 'شكولاته': 'chocolat', 'كاكاو': 'cacao',
  'غبره': 'en poudre', 'مسحوق': 'en poudre', 'خميره': 'levure', 'كيميائيه': 'chimique', 'كيميائي': 'chimique',
  'فانيلا': 'vanille', 'فاني': 'vanille', 'كريمه': 'crème', 'كريم': 'crème', 'نشا': 'amidon', 'ملح': 'sel', 'ماء': 'eau',
  'عسل': 'miel', 'جوز': 'noix', 'لوز': 'amandes', 'كاوكاو': 'cacahuètes', 'زيت': 'huile', 'ليمون': 'citron',
  'برتقال': 'orange', 'فراوله': 'fraise', 'فريز': 'fraise', 'موز': 'banane', 'جوز الهند': 'noix de coco', 'كوكو': 'coco',
  'كليكوز': 'glucose', 'جلوكوز': 'glucose', 'غليكوز': 'glucose', 'نوتيلا': 'nutella', 'دروبس': 'drops',
  'كوفغتوغ': 'couverture', 'كوفرتور': 'couverture', 'كراميل': 'caramel', 'قرفه': 'cannelle', 'جبن': 'fromage',
  'فرماج': 'fromage', 'ماسكاربوني': 'mascarpone', 'جيلاتين': 'gélatine', 'فواكه': 'fruits', 'جافه': 'sec',
  'فاكيه': 'fruits secs', 'زبيب': 'raisins secs', 'تمر': 'dattes', 'فستق': 'pistaches', 'بندق': 'noisettes',
  'كورن فليكس': 'cornflakes', 'كورنفليكس': 'cornflakes', 'فوياتين': 'feuilletine', 'صوص': 'sauce',
  // Emballages et ustensiles
  'المنيوم': 'aluminium', 'ألمنيوم': 'aluminium', 'بلاستيك': 'en plastique', 'بلاستيكيه': 'en plastique',
  'ليكات': 'gants', 'ليكا': 'gants', 'ليكه': 'gant', 'قفازات': 'gants', 'كاس': 'gobelet', 'كيسان': 'gobelets',
  'معالق': 'cuillères', 'ملاعق': 'cuillères', 'معلقه': 'cuillère', 'طباسل': 'assiettes', 'طباسيل': 'assiettes',
  'طبسيل': 'assiette', 'صحون': 'assiettes', 'صحن': 'assiette', 'فرشيطات': 'fourchettes', 'شوكات': 'fourchettes',
  'بركيت': 'barquette', 'بركيتات': 'barquettes', 'ساشي': 'sachet', 'ساشيات': 'sachets', 'اكياس': 'sachets',
  'علب': 'boîtes', 'غطاء': 'couvercle', 'غطيان': 'couvercles', 'اغطيه': 'couvercles', 'ورق': 'papier',
  'مناديل': 'serviettes', 'منديل': 'serviette', 'فيلم': 'film', 'كرتون': 'carton', 'لصاق': 'étiquette',
  'قالب': 'moule', 'قوالب': 'moules', 'موسلين': 'mousseline', 'سيلوفان': 'cellophane', 'شريط': 'ruban',
  // Qualificatifs (forme de base : l'accord est fait à la traduction)
  'ممتاز': 'extra', 'اسود': 'noir', 'سوداء': 'noir', 'سودا': 'noir', 'ابيض': 'blanc', 'بيضاء': 'blanc',
  'احمر': 'rouge', 'حمراء': 'rouge', 'كبير': 'grand', 'كبيره': 'grand', 'كبار': 'grand', 'صغير': 'petit',
  'صغيره': 'petit', 'صغار': 'petit', 'متوسط': 'moyen', 'رقيق': 'fin', 'شفاف': 'transparent', 'ريش': 'riche',
  'مربع': 'carré', 'دائري': 'rond', 'طويل': 'long',
};

// Formes normalisées des clés (une seule fois).
const UNIT_MAP = new Map(Object.entries(UNITS).map(([k, v]) => [norm(k), v]));
const WORD_MAP = new Map(Object.entries(WORDS).map(([k, v]) => [norm(k), v]));

const isArabic = (t) => /[؀-ۿﭐ-﷿ﹰ-﻿]/.test(t);

// Mot -> traduction, en essayant aussi sans l'article « ال » et sans « و » (et) collé.
function lookup(map, word) {
  const w = norm(word);
  for (const cand of [w, w.replace(/^ال/, ''), w.replace(/^و/, ''), w.replace(/^وال/, ''), w.replace(/^ا/, '')]) {
    if (cand && map.has(cand)) return map.get(cand);
  }
  return null;
}

// "4ك" -> "4kg", "300م" -> "300m", "750غ" -> "750g", "1ل" -> "1L"
function sizeToken(t) {
  const m = /^(\d+(?:[.,]\d+)?)\s*(ك|كغ|كلغ|غ|غر|م|ل|مل)$/.exec(norm(t));
  if (!m) return null;
  const unit = { 'ك': 'kg', 'كغ': 'kg', 'كلغ': 'kg', 'غ': 'g', 'غر': 'g', 'م': 'm', 'ل': 'L', 'مل': 'ml' }[m[2]];
  return `${m[1]}${unit}`;
}

// Unité trouvée dans un texte arabe (colonne « الوحدة »), ou null.
// fuzzy : tolère une lettre mal lue (« كلع » -> « كلغ ») — pour une case lue seule.
function findUnit(text, { fuzzy = false } = {}) {
  // « الوحدة » est le titre de la colonne, jamais une valeur.
  const tokens = String(text).split(/[\s|]+/).filter((t) => isArabic(t) && norm(t).replace(/[^؀-ۿ]/g, '') !== 'الوحده');
  for (const t of tokens) {
    const u = lookup(UNIT_MAP, t);
    if (u) return u;
  }
  if (!fuzzy) return null;
  for (const t of tokens) {
    const w = norm(t).replace(/^ال/, '').replace(/[^؀-ۿ]/g, '');
    if (w.length < 3) continue;
    for (const [k, v] of UNIT_MAP) {
      if (k.length >= 3 && Math.abs(k.length - w.length) <= 1 && distance(w, k) <= 1) return v;
    }
  }
  return null;
}

// Accord des adjectifs : [masculin, féminin, masculin pluriel, féminin pluriel].
const ADJ_FORMS = {
  noir: ['noir', 'noire', 'noirs', 'noires'], blanc: ['blanc', 'blanche', 'blancs', 'blanches'],
  rouge: ['rouge', 'rouge', 'rouges', 'rouges'], grand: ['grand', 'grande', 'grands', 'grandes'],
  petit: ['petit', 'petite', 'petits', 'petites'], moyen: ['moyen', 'moyenne', 'moyens', 'moyennes'],
  fin: ['fin', 'fine', 'fins', 'fines'], transparent: ['transparent', 'transparente', 'transparents', 'transparentes'],
  carré: ['carré', 'carrée', 'carrés', 'carrées'], rond: ['rond', 'ronde', 'ronds', 'rondes'],
  long: ['long', 'longue', 'longs', 'longues'], riche: ['riche', 'riche', 'riches', 'riches'],
  extra: ['extra', 'extra', 'extra', 'extra'], sucré: ['sucré', 'sucrée', 'sucrés', 'sucrées'],
  concentré: ['concentré', 'concentrée', 'concentrés', 'concentrées'], chimique: ['chimique', 'chimique', 'chimiques', 'chimiques'],
  sec: ['sec', 'sèche', 'secs', 'sèches'],
};
// Placés avant le nom en français (« petites cuillères », « grand sachet »).
const BEFORE_NOUN = new Set(['petit', 'grand']);
const FEMININE = new Set(['cuillère', 'cuillères', 'assiette', 'assiettes', 'barquette', 'barquettes', 'boîte', 'boîtes',
  'crème', 'farine', 'levure', 'couverture', 'fourchette', 'fourchettes', 'serviette', 'serviettes', 'étiquette',
  'glace', 'vanille', 'huile', 'amandes', 'noix', 'fraise', 'banane', 'orange', 'cannelle', 'gélatine', 'margarine',
  'dattes', 'pistaches', 'noisettes', 'cacahuètes', 'mousseline', 'cellophane', 'sauce', 'poudre']);
const plural = (noun) => /[sx]$/.test(noun) && noun !== 'gobelet';

// Traduit un nom arabe mot à mot. complete = tous les mots arabes sont connus.
// Deux mots qui forment une expression (« حليب مركز ») sont essayés ensemble d'abord.
function translateName(text) {
  // Nombre collé à un mot (« 49ممتاز ») : séparé ; « 4ك » (taille) reste entier.
  const tokens = String(text).replace(/(\d)([؀-ۿ]{2,})/g, '$1 $2').split(/\s+/).filter(Boolean);
  const out = []; // { fr, kind: 'noun' | 'adj' | 'other' }
  let arabicWords = 0;
  let known = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const size = sizeToken(t);
    if (size) { out.push({ fr: size, kind: 'other' }); continue; }
    if (!isArabic(t)) { out.push({ fr: t, kind: 'other' }); continue; }
    if (lookup(UNIT_MAP, t) && !lookup(WORD_MAP, t)) continue; // unité (colonne « الوحدة ») : pas dans le nom
    arabicWords += 1;
    const pair = i + 1 < tokens.length && isArabic(tokens[i + 1]) ? lookup(WORD_MAP, `${t} ${tokens[i + 1]}`) : null;
    if (pair) { out.push({ fr: pair, kind: 'noun' }); arabicWords += 1; known += 2; i += 1; continue; }
    const fr = lookup(WORD_MAP, t);
    if (fr) { out.push({ fr, kind: ADJ_FORMS[fr] ? 'adj' : 'noun' }); known += 1; } else out.push({ fr: t, kind: 'other' });
  }
  // Accord de chaque adjectif avec le nom qui le précède ; petit/grand passent devant ce nom.
  let lastNoun = -1;
  for (let i = 0; i < out.length; i += 1) {
    const w = out[i];
    if (w.kind === 'noun') { lastNoun = i; continue; }
    if (w.kind !== 'adj' || lastNoun < 0) continue;
    const noun = out[lastNoun].fr.split(' ')[0];
    const forms = ADJ_FORMS[w.fr];
    w.fr = forms[(plural(noun) ? 2 : 0) + (FEMININE.has(noun) ? 1 : 0)];
    if (BEFORE_NOUN.has(forms[0])) {
      out.splice(i, 1);
      out.splice(lastNoun, 0, w);
      lastNoun += 1;
    }
  }
  const join = (words) => words.map((w) => w.fr).join(' ').replace(/\s+/g, ' ').trim();
  return {
    text: join(out),
    // Seulement les mots traduits (et les tailles) : pour une traduction partielle.
    knownText: join(out.filter((w) => !(w.kind === 'other' && isArabic(w.fr)))),
    complete: arabicWords > 0 && known === arabicWords,
    arabicWords,
    known,
    nouns: out.filter((w) => w.kind === 'noun').length,
  };
}

// ----- Fautes de frappe des fournisseurs (« levuer », « plastuque ») -----
const VOCAB = new Set([
  ...Object.values(WORDS).flatMap((v) => v.split(' ')),
  ...Object.values(ADJ_FORMS).flat(),
  'lait', 'sucre', 'levure', 'chimique', 'aluminium', 'plastique', 'cuillère', 'cuillères', 'assiette', 'assiettes',
  'barquette', 'barquettes', 'sachet', 'sachets', 'gants', 'couverture', 'chocolat', 'poudre', 'cacao', 'glucose',
  'nutella', 'vanille', 'farine', 'beurre', 'crème', 'gobelet', 'gobelets', 'serviettes', 'fourchettes', 'boîte',
  'couvercle', 'couvercles', 'papier', 'emballage', 'emballages', 'feuilletine', 'cornflakes', 'caramel', 'fromage',
  'semoule', 'entier', 'entière', 'plateau', 'fondant', 'liquide', 'écrémé', 'fraîche', 'amande', 'pistache', 'noisette',
  'chantilly', 'biscuit', 'biscuits', 'praliné', 'glaçage', 'colorant', 'arôme', 'gaufrette', 'sirop', 'confiture',
  'condensé', 'pâtissière', 'mascarpone', 'coulis', 'fruits', 'agar', 'pectine', 'citron', 'orange', 'fraise',
].filter((w) => w.length >= 5));

// Distance d'édition avec inversion de deux lettres voisines (Damerau).
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Corrige un mot mal orthographié vers le vocabulaire de la pâtisserie (mots d'au moins 5 lettres).
function fixSpelling(name) {
  return String(name).split(' ').map((word) => {
    // Ponctuation collée par la lecture (« “quette ») : ignorée pour la comparaison.
    const w = /\d/.test(word) ? word.toLowerCase() : word.toLowerCase().replace(/[^a-zà-ÿ]/g, '');
    if (w === 'gant') return 'gants';
    if (w.length < 5 || !/^[a-zà-ÿ]+$/.test(w)) return word;
    // Mot corrigé : sans la ponctuation parasite, mais avec ses parenthèses (« (plateau »).
    const keepParens = (fixed) => `${word.startsWith('(') ? '(' : ''}${fixed}${word.endsWith(')') ? ')' : ''}`;
    if (VOCAB.has(w)) return w === word.toLowerCase() ? word : keepParens(w);
    const max = w.length >= 7 ? 2 : 1;
    let best = null;
    for (const v of VOCAB) {
      if (Math.abs(v.length - w.length) > 1) continue; // « semoule » ne doit pas devenir « moule »
      const dist = distance(w, v);
      if (dist <= max && (!best || dist < best.dist)) best = { v, dist };
    }
    if (best) return keepParens(best.v);
    // Début du mot perdu sur la photo (« rquette » -> « barquette ») : seulement si un seul mot connu finit ainsi.
    const ends = [...VOCAB].filter((v) => v.length > w.length && v.endsWith(w));
    return w.length >= 5 && ends.length === 1 ? keepParens(ends[0]) : word;
  }).join(' ');
}

// « les gant noire » -> « gants noire » : article en tête retiré, « gant » au pluriel comme dans le dictionnaire.
const ARTICLES = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de']);

// Lecture d'une photo : enlève les restes illisibles en fin de nom (« assiette plastique div Julsh »),
// jusqu'au dernier mot connu ou à une taille (« 750 », « 1kg », « T55 »). Le nom garde au moins un mot connu.
const ALL_WORDS = new Set([...VOCAB, ...Object.values(WORDS).flatMap((v) => v.split(' ')), 'lait', 'sel', 'eau', 'miel', 'noir', 'film', 'sucre', 'gant', 'gants']);
function stripOcrJunk(name) {
  const tokens = String(name).split(' ').filter(Boolean);
  const keep = (t) => ALL_WORDS.has(t.toLowerCase()) || (/\d/.test(t) && /^[\p{L}\d.,/()]+$/u.test(t));
  if (!tokens.some((t) => ALL_WORDS.has(t.toLowerCase()))) return name;
  while (tokens.length > 1 && !keep(tokens[tokens.length - 1])) tokens.pop();
  // Début du nom : restes illisibles (« b: “ ») et article (« les »), jusqu'au premier vrai mot.
  while (tokens.length > 1 && (ARTICLES.has(tokens[0].toLowerCase())
    || (!keep(tokens[0]) && tokens[0].length <= 3 && /[^\p{L}\d]|^\p{L}$/u.test(tokens[0])))) tokens.shift();
  return tokens.join(' ');
}

// Mots des noms validés par le gérant (matières, corrections) : ajoutés au vocabulaire de la correction.
function addVocabulary(text) {
  for (const w of String(text || '').toLowerCase().split(/[^a-zà-ÿ]+/)) {
    if (w.length >= 5) VOCAB.add(w);
    if (w.length >= 3) ALL_WORDS.add(w);
  }
}

// Le texte contient-il au moins un mot connu du métier (« noire », « sachet »…) ?
const hasKnownWord = (text) => String(text).split(/\s+/).some((t) => ALL_WORDS.has(t.toLowerCase()));

module.exports = { findUnit, translateName, isArabic, norm, sizeToken, fixSpelling, stripOcrJunk, distance, hasKnownWord, addVocabulary };
