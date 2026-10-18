// Mémoire de lecture des factures : le système apprend des corrections du gérant.
// À chaque facture enregistrée, on retient « ce qui avait été lu » -> « ce que le gérant a validé »
// (nom, unité, prix). À la lecture suivante, une ligne lue pareil (ou presque) est corrigée toute seule.

const { db } = require('./db');
const { distance, addVocabulary } = require('./arabic-fr');

db.exec(`
CREATE TABLE IF NOT EXISTS ocr_memory (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  read_key         TEXT NOT NULL,           -- nom tel que lu, normalisé
  name             TEXT NOT NULL,           -- nom validé par le gérant
  unit             TEXT NOT NULL,
  unit_price_cents INTEGER,                 -- dernier prix : distingue deux articles lus pareil
  hits             INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL,
  UNIQUE (read_key, name)
);
`);

// « b: “quete 780 » -> « b quete 780 » : minuscules, sans ponctuation ni espaces en trop.
function memKey(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[‎‏]/g, '')
    .replace(/[^\p{L}\d.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const similarity = (a, b) => (a === b ? 1 : 1 - distance(a, b) / Math.max(a.length, b.length, 1));

let cache = null;
const load = () => { cache = db.prepare('SELECT * FROM ocr_memory').all(); return cache; };

const samePrice = (a, b) => Boolean(a && b && Math.abs(a - b) <= a * 0.1);

// Mots utiles d'un nom (au moins 3 lettres, ou un nombre).
const tokens = (key) => key.split(' ').filter((t) => t.length >= 3 || /\d/.test(t));

// Tous les mots du nom le plus court se retrouvent (à une faute près) dans l'autre :
// « barquette 750 » ⊂ « barquette 750 plat 750 », « gants noirs » ≈ « gants noire extra 1 ».
function contained(a, b) {
  const [small, big] = tokens(a).length <= tokens(b).length ? [tokens(a), tokens(b)] : [tokens(b), tokens(a)];
  if (!small.length || !small.some((t) => /\p{L}{4,}/u.test(t))) return 0;
  const ok = small.every((t) => big.some((u) => similarity(t, u) >= 0.75));
  return ok ? small.length / big.length : 0;
}

// Correction apprise pour une ligne lue, ou null.
// 1. Une lecture déjà corrigée : identique ou très proche (≥ 85 %), ou assez proche (≥ 60 %) au même prix (± 10 %).
// 2. Sinon, un nom déjà validé (correction ou matière du stock) contenu dans la lecture, au même prix.
function recall(readName, unitPriceCents) {
  const rows = load(); // relue à chaque fois : un changement fait avec `npm run outils` compte tout de suite
  const key = memKey(readName);
  if (key.length < 2) return null;
  let best = null;
  for (const m of rows) {
    const sim = similarity(key, m.read_key);
    if (sim < 0.6) continue;
    const price = samePrice(m.unit_price_cents, unitPriceCents);
    if (sim < 0.85 && !price) continue;
    const score = sim + (price ? 0.2 : 0) + Math.min(m.hits, 10) * 0.005;
    if (!best || score > best.score) best = { score, name: m.name, unit: m.unit };
  }
  if (best) return { name: best.name, unit: best.unit };

  const validated = [
    ...rows.map((m) => ({ name: m.name, unit: m.unit, price: m.unit_price_cents })),
    ...db.prepare('SELECT name, unit, last_price_cents AS price FROM raw_materials').all(),
  ];
  for (const v of validated) {
    if (!samePrice(v.price, unitPriceCents)) continue;
    const score = contained(key, memKey(v.name));
    if (score && (!best || score > best.score)) best = { score, name: v.name, unit: v.unit };
  }
  return best && { name: best.name, unit: best.unit };
}

// Retient les lignes d'une facture enregistrée : { read_name, name, unit, unit_price_cents }.
function learn(lines, now) {
  const upsert = db.prepare(`INSERT INTO ocr_memory (read_key, name, unit, unit_price_cents, hits, updated_at)
                             VALUES (?, ?, ?, ?, 1, ?)
                             ON CONFLICT (read_key, name) DO UPDATE SET unit = excluded.unit,
                               unit_price_cents = excluded.unit_price_cents, hits = hits + 1, updated_at = excluded.updated_at`);
  let learned = 0;
  for (const l of lines) {
    const key = memKey(l.read_name);
    if (key.length < 2 || !l.name) continue;
    upsert.run(key, l.name, l.unit || 'unité', l.unit_price_cents || null, now);
    addVocabulary(l.name);
    learned += 1;
  }
  load();
  return learned;
}

// Une matière renommée dans le stock : la mémoire suit le nouveau nom.
function rename(oldName, newName) {
  db.prepare(`UPDATE OR IGNORE ocr_memory SET name = ? WHERE name = ? COLLATE NOCASE`).run(newName, oldName);
  addVocabulary(newName);
  load();
}

const count = () => db.prepare('SELECT COUNT(*) AS n FROM ocr_memory').get().n;
function clear() { db.prepare('DELETE FROM ocr_memory').run(); load(); }

// Au démarrage : les noms déjà validés enrichissent le vocabulaire de la correction d'orthographe.
for (const r of db.prepare('SELECT name FROM raw_materials UNION SELECT name FROM ocr_memory').all()) addVocabulary(r.name);

module.exports = { recall, learn, rename, count, clear, memKey };
