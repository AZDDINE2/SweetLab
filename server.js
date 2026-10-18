const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { createWorker } = require('tesseract.js');
const { parseInvoiceText, enrichWithArabic } = require('./invoice-parse');
const { readTable } = require('./invoice-table');
const ocrMemory = require('./ocr-memory');
const { db, tx, hashPassword, verifyPassword, getSettings, setSetting, DATA_DIR } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_PORT = process.env.PUBLIC_PORT || 3001; // application Fidélité (clients + personnel)
const SESSION_DAYS = 30;

// Deux applications :
//  - app (port 3000)      : caisse et gérant, sans aucune fonction de fidélité ;
//  - loyaltyApp (port 3001) : tout ce qui concerne la fidélité (pages client publiques + page du personnel).
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' })); // les photos et PDF de factures sont envoyés en base64
app.locals.home = (user) => (user.role === 'gerant' ? '/gerant.html' : '/caisse.html');
// Les pages fidélité ne sont servies que par le port 3001.
const LOYALTY_FILES = new Set(['/carte.html', '/rejoindre.html']); // pages client : port 3001 uniquement
app.use((req, res, next) => (LOYALTY_FILES.has(req.path) ? res.status(404).end() : next()));
app.use(express.static(path.join(__dirname, 'public')));
// pdf.js : lecture des factures PDF dans le navigateur (texte et aperçu de la page).
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build')));

const authRouter = express.Router(); // connexion du personnel (port 3000)
const pub = express.Router();        // fidélité : pages et API publiques des clients

pub.get('/carte', (req, res) => res.sendFile(path.join(__dirname, 'public', 'carte.html')));
// Espace client : page d'accueil du port 3001 (le client saisit son prénom et son téléphone).
// /rejoindre reste valable pour les anciens QR codes.
pub.get(['/', '/rejoindre'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'rejoindre.html')));

// ---------- Utilitaires ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDateTime = (d = new Date()) =>
  `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

function dateParam(value) {
  if (value == null || value === '') return localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Date invalide');
  return value;
}

function intField(value, label, min = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${label} invalide`);
  return n;
}

function textField(value, label, max = 80) {
  const s = String(value ?? '').trim();
  if (!s) throw new HttpError(400, `${label} obligatoire`);
  if (s.length > max) throw new HttpError(400, `${label} trop long`);
  return s;
}

// Garde les chiffres uniquement : "06 12-34 56 78" -> "0612345678".
// Met un numéro au format marocain 0XXXXXXXXX, quelle que soit la façon de l'écrire :
// "0678707591", "06 78 70 75 91", "+212678707591", "+2120678707591", "00212678707591", "212678707591" -> "0678707591".
// Un numéro étranger (+33..., +34...) est gardé au format international "+XXXXXXXX".
function normalizePhone(value) {
  let s = String(value ?? '').trim().replace(/[\s.\-()/]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+212')) s = s.slice(4);
  else if (/^212\d{9,10}$/.test(s)) s = s.slice(3);
  if (/^[5-8]\d{8}$/.test(s)) s = `0${s}`;
  if (/^0[5-8]\d{8}$/.test(s)) return s;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  return null;
}

function phoneField(value) {
  const phone = normalizePhone(value);
  if (!phone) throw new HttpError(400, 'Numéro de téléphone invalide (ex. 06 12 34 56 78)');
  return phone;
}

// Limite simple en mémoire (par IP) pour les routes publiques.
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) throw new HttpError(429, 'Trop de tentatives, réessayez plus tard');
    list.push(now);
    hits.set(key, list);
    next();
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- Requêtes ----------

const STOCK_SELECT = `
  SELECT p.id, p.name, p.price_cents, p.mold_price_cents, p.is_flan, p.active, p.category_id,
         c.name AS category_name,
         COALESCE(ds.quantity, 0) AS quantity,
         COALESCE(ps.parts, 0) AS prep,
         COALESCE((SELECT SUM(oi.parts)
                     FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE o.date = $date AND o.status = 'valide' AND oi.product_id = p.id), 0) AS sold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN daily_stock ds ON ds.product_id = p.id AND ds.date = $date
    LEFT JOIN prep_stock ps ON ps.product_id = p.id`;

const q = {
  sessionUser: db.prepare(`SELECT u.id, u.username, u.name, u.role
                             FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND u.active = 1 AND s.created_at >= ?`),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),

  stockForDate: db.prepare(`${STOCK_SELECT} WHERE p.active = 1 ORDER BY c.id, p.name`),
  stockForProduct: db.prepare(`${STOCK_SELECT} WHERE p.id = $id`),
  upsertStock: db.prepare(`INSERT INTO daily_stock (date, product_id, quantity) VALUES (?, ?, ?)
                           ON CONFLICT (date, product_id) DO UPDATE SET quantity = excluded.quantity`),

  nextOrderNumber: db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM orders WHERE date = ?'),
  insertOrder: db.prepare(`INSERT INTO orders (date, number, created_at, cashier_id, total_cents, mode,
                                               packaging_count, packaging_cents, molds_count, molds_returned, mold_deposit_cents, note)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  insertItem: db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_cents,
                                                    format, parts, toppings, toppings_cents, line_total_cents, place)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  ordersForDate: db.prepare(`SELECT o.*, u.name AS cashier_name FROM orders o JOIN users u ON u.id = o.cashier_id
                              WHERE o.date = ? ORDER BY o.id DESC`),

  customerById: db.prepare('SELECT * FROM customers WHERE id = ?'),
  customerByPhone: db.prepare('SELECT * FROM customers WHERE phone = ?'),
  addStamps: db.prepare('UPDATE customers SET stamps = MAX(stamps + ?, 0), rewards_used = rewards_used + ? WHERE id = ?'),
  insertEvent: db.prepare('INSERT INTO loyalty_events (customer_id, order_id, type, stamps, created_at) VALUES (?, ?, ?, ?, ?)'),
  itemsForDate: db.prepare(`SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
                             WHERE o.date = ? ORDER BY oi.id`),
};

const withRemaining = (row) => ({ ...row, remaining: Math.max(row.quantity - row.sold, 0) });

// ---------- Authentification ----------

function sessionCutoff() {
  return localDateTime(new Date(Date.now() - SESSION_DAYS * 86400000));
}

function auth(...roles) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    const user = token && q.sessionUser.get(token, sessionCutoff());
    if (!user) throw new HttpError(401, 'Non connecté');
    if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Accès refusé');
    req.user = user;
    next();
  };
}

authRouter.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = q.userByUsername.get(username);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
  }
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, user.id, localDateTime());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 86400000 });
  res.json({ name: user.name, role: user.role, home: req.app.locals.home(user) });
});

authRouter.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) q.deleteSession.run(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

authRouter.get('/api/me', auth(), (req, res) => {
  res.json({ ...req.user, today: localDate(), home: req.app.locals.home(req.user) });
});

app.use(authRouter);

// ---------- Catégories ----------

app.get('/api/categories', auth(), (req, res) => {
  res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
                         FROM categories c ORDER BY c.id`).all());
});

app.post('/api/categories', auth('gerant'), (req, res) => {
  const name = textField(req.body.name, 'Nom');
  const { lastInsertRowid } = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
  res.status(201).json({ id: Number(lastInsertRowid), name });
});

app.put('/api/categories/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Catégorie', 1);
  const name = textField(req.body.name, 'Nom');
  const { changes } = db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
  if (!changes) throw new HttpError(404, 'Catégorie introuvable');
  res.json({ id, name });
});

app.delete('/api/categories/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Catégorie', 1);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(id);
  if (n > 0) throw new HttpError(400, 'Cette catégorie contient des produits : déplacez-les ou supprimez-les d’abord');
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Réglages de vente (emballage, moule, suppléments) ----------

const PARTS_PER_MOLD = 8; // 1 moule entier = 8 parts

// Deux emballages : un par part emportée, un par moule entier (sauf si le client rapporte son ancien moule).
function venteSettings() {
  const s = getSettings();
  return {
    parts_per_mold: PARTS_PER_MOLD,
    packaging_price_cents: Number(s.packaging_price_cents),  // emballage d'une part (à emporter)
    mold_packaging_cents: Number(s.mold_deposit_cents),      // emballage d'un moule entier
  };
}

// Emballages de la journée (parts et moules) : déclarés par le gérant, utilisés par les ventes.
function packagingFor(date) {
  const day = db.prepare('SELECT quantity, mold_quantity FROM packaging_days WHERE date = ?').get(date);
  const used = db.prepare(`SELECT COALESCE(SUM(packaging_count), 0) AS parts, COALESCE(SUM(molds_count - molds_returned), 0) AS molds
                             FROM orders WHERE date = ? AND status = 'valide'`).get(date);
  const block = (declared, u) => ({ declared, used: u, remaining: Math.max(declared - u, 0) });
  return { parts: block(day ? day.quantity : 0, used.parts), molds: block(day ? day.mold_quantity : 0, used.molds) };
}

const activeToppings = () => db.prepare('SELECT id, name, price_cents FROM toppings WHERE active = 1 ORDER BY id').all();

app.get('/api/vente/settings', auth(), (req, res) => {
  res.json({ ...venteSettings(), toppings: activeToppings(), packaging: packagingFor(localDate()) });
});

app.put('/api/vente/settings', auth('gerant'), (req, res) => {
  setSetting('packaging_price_cents', intField(req.body.packaging_price_cents, 'Prix de l’emballage part'));
  setSetting('mold_deposit_cents', intField(req.body.mold_packaging_cents, 'Prix de l’emballage moule'));
  res.json(venteSettings());
});

// ---------- Suppléments ----------

app.get('/api/toppings', auth('gerant'), (req, res) => {
  res.json(db.prepare('SELECT * FROM toppings ORDER BY active DESC, id').all());
});

app.post('/api/toppings', auth('gerant'), (req, res) => {
  const name = textField(req.body.name, 'Nom', 40);
  const price = intField(req.body.price_cents, 'Prix');
  const { lastInsertRowid } = db.prepare('INSERT INTO toppings (name, price_cents) VALUES (?, ?)').run(name, price);
  res.status(201).json({ id: Number(lastInsertRowid), name, price_cents: price, active: 1 });
});

app.put('/api/toppings/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Supplément', 1);
  const { changes } = db.prepare('UPDATE toppings SET name = ?, price_cents = ?, active = ? WHERE id = ?')
    .run(textField(req.body.name, 'Nom', 40), intField(req.body.price_cents, 'Prix'), req.body.active ? 1 : 0, id);
  if (!changes) throw new HttpError(404, 'Supplément introuvable');
  res.json({ ok: true });
});

// ---------- Produits ----------

app.get('/api/products', auth(), (req, res) => {
  res.json(db.prepare(`SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id
                        ORDER BY p.active DESC, c.id, p.name`).all());
});

function productFields(body) {
  const mold = body.mold_price_cents;
  return {
    name: textField(body.name, 'Nom'),
    category_id: intField(body.category_id, 'Catégorie', 1),
    price_cents: intField(body.price_cents, 'Prix'),
    mold_price_cents: mold === null || mold === undefined || mold === '' ? null : intField(mold, 'Prix du moule'),
    is_flan: body.is_flan === undefined ? 1 : body.is_flan ? 1 : 0,
    active: body.active === undefined ? 1 : body.active ? 1 : 0,
  };
}

app.post('/api/products', auth('gerant'), (req, res) => {
  const p = productFields(req.body);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO products (name, category_id, price_cents, mold_price_cents, is_flan, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.name, p.category_id, p.price_cents, p.mold_price_cents, p.is_flan, p.active);
  res.status(201).json({ id: Number(lastInsertRowid), ...p });
});

app.put('/api/products/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Produit', 1);
  const p = productFields(req.body);
  const { changes } = db
    .prepare('UPDATE products SET name = ?, category_id = ?, price_cents = ?, mold_price_cents = ?, is_flan = ?, active = ? WHERE id = ?')
    .run(p.name, p.category_id, p.price_cents, p.mold_price_cents, p.is_flan, p.active, id);
  if (!changes) throw new HttpError(404, 'Produit introuvable');
  res.json({ id, ...p });
});

// Un produit déjà vendu est seulement désactivé, pour garder l'historique des ventes.
app.delete('/api/products/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Produit', 1);
  const result = tx(() => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?').get(id);
    if (n > 0) {
      db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
      return { deleted: false, deactivated: true };
    }
    for (const t of ['daily_stock', 'prep_stock', 'stock_moves']) db.prepare(`DELETE FROM ${t} WHERE product_id = ?`).run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    return { deleted: true };
  });
  res.json(result);
});

// ---------- Stock : préparation (cuisine) et vente (journée) ----------
// Tout est compté en parts (1 moule = 8 parts). Chaque mouvement est enregistré dans stock_moves.

const insertMove = db.prepare('INSERT INTO stock_moves (date, product_id, kind, parts, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)');
const setPrep = db.prepare(`INSERT INTO prep_stock (product_id, parts) VALUES (?, ?)
                            ON CONFLICT (product_id) DO UPDATE SET parts = excluded.parts`);

function stockPayload(date) {
  const moves = db.prepare(`SELECT m.kind, m.parts, m.created_at, p.name AS product_name, u.name AS user_name
                              FROM stock_moves m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
                             WHERE m.date = ? ORDER BY m.id DESC LIMIT 50`).all(date);
  // Stock de vente = ouverture (définie le matin) + mises en vente depuis la préparation.
  const transferred = new Map(db.prepare(`SELECT product_id, SUM(parts) AS parts FROM stock_moves
                                           WHERE date = ? AND kind = 'mise_en_vente' GROUP BY product_id`).all(date)
    .map((r) => [r.product_id, r.parts]));
  const products = q.stockForDate.all({ date }).map((row) => {
    const t = transferred.get(row.id) || 0;
    return { ...withRemaining(row), transferred: t, opening: Math.max(row.quantity - t, 0) };
  });
  return { date, products, packaging: packagingFor(date), moves, count: countFor(date) };
}

// Comptage de fin de journée déjà enregistré pour cette date (ou null).
function countFor(date) {
  const rows = db.prepare(`SELECT c.*, u.name AS user_name FROM stock_counts c LEFT JOIN users u ON u.id = c.user_id
                            WHERE c.date = ?`).all(date);
  const packs = db.prepare('SELECT * FROM packaging_counts WHERE date = ?').all(date);
  if (!rows.length && !packs.length) return null;
  const last = [...rows, ...packs].reduce((a, b) => (a.created_at > b.created_at ? a : b));
  return {
    created_at: last.created_at,
    user_name: rows.find((r) => r.user_name)?.user_name || null,
    products: Object.fromEntries(rows.map((r) => [r.product_id, { expected: r.expected_parts, counted: r.counted_parts }])),
    packaging: Object.fromEntries(packs.map((p) => [p.kind, { expected: p.expected, counted: p.counted }])),
  };
}

// Enregistre le comptage de fin de journée : parts restantes de chaque produit et emballages restants.
// « Attendu » = stock de vente − ventes (et emballages déclarés − utilisés) au moment du comptage.
app.post('/api/stock/comptage', auth('gerant'), (req, res) => {
  const date = dateParam(req.body.date);
  const items = Array.isArray(req.body.products) ? req.body.products : [];
  tx(() => {
    const now = localDateTime();
    const upsert = db.prepare(`INSERT INTO stock_counts (date, product_id, expected_parts, counted_parts, created_at, user_id)
                               VALUES (?, ?, ?, ?, ?, ?)
                               ON CONFLICT (date, product_id) DO UPDATE SET expected_parts = excluded.expected_parts,
                                 counted_parts = excluded.counted_parts, created_at = excluded.created_at, user_id = excluded.user_id`);
    for (const it of items) {
      const productId = intField(it.product_id, 'Produit', 1);
      const p = q.stockForProduct.get({ date, id: productId });
      if (!p) throw new HttpError(404, 'Produit introuvable');
      const counted = intField(it.parts, `Quantité comptée (${p.name})`);
      upsert.run(date, productId, Math.max(p.quantity - p.sold, 0), counted, now, req.user.id);
    }
    const pack = packagingFor(date);
    const packUpsert = db.prepare(`INSERT INTO packaging_counts (date, kind, expected, counted, created_at, user_id)
                                   VALUES (?, ?, ?, ?, ?, ?)
                                   ON CONFLICT (date, kind) DO UPDATE SET expected = excluded.expected, counted = excluded.counted,
                                     created_at = excluded.created_at, user_id = excluded.user_id`);
    for (const [kind, block] of [['part', pack.parts]]) {
      const v = req.body.packaging?.[kind];
      if (v === undefined || v === null || v === '') continue;
      packUpsert.run(date, kind, block.remaining, intField(v, kind === 'part' ? 'Emballages parts comptés' : 'Emballages moules comptés'), now, req.user.id);
    }
  });
  res.json(stockPayload(date));
});

// Ouverture de la journée : définit le stock de vente de départ (ex. 3 moules), sans toucher à la préparation.
// Les ajouts dans la journée se font ensuite uniquement par "Mettre en vente" depuis la préparation.
app.post('/api/stock/ouverture', auth('gerant'), (req, res) => {
  const date = dateParam(req.body.date);
  const productId = intField(req.body.product_id, 'Produit', 1);
  const opening = intField(req.body.parts, 'Quantité', 0);
  tx(() => {
    const p = q.stockForProduct.get({ date, id: productId });
    if (!p) throw new HttpError(404, 'Produit introuvable');
    if (p.is_flan && opening % PARTS_PER_MOLD) throw new HttpError(400, 'Le stock d’ouverture des produits en moule se compte en moules entiers');
    const { t } = db.prepare(`SELECT COALESCE(SUM(parts), 0) AS t FROM stock_moves
                               WHERE date = ? AND product_id = ? AND kind = 'mise_en_vente'`).get(date, productId);
    const newQty = opening + t;
    if (newQty < p.sold) throw new HttpError(400, `Impossible : ${formatParts(p.sold, p)} déjà vendu(s) aujourd’hui pour « ${p.name} »`);
    if (newQty === p.quantity) return;
    // Enregistré sous 'correction_vente' (types fixés par la base), affiché « Ouverture » chez le gérant.
    q.upsertStock.run(date, productId, newQty);
    insertMove.run(date, productId, 'correction_vente', newQty - p.quantity, localDateTime(), req.user.id);
  });
  res.json(stockPayload(date));
});

app.get('/api/stock', auth(), (req, res) => {
  // La caisse ne voit que la journée en cours.
  const date = req.user.role === 'gerant' ? dateParam(req.query.date) : localDate();
  res.json(stockPayload(date));
});

// Production : ajoute des parts au stock de préparation ("add"), ou corrige ce stock ("set").
app.post('/api/stock/preparation', auth('gerant'), (req, res) => {
  const date = dateParam(req.body.date);
  const productId = intField(req.body.product_id, 'Produit', 1);
  const mode = req.body.mode === 'set' ? 'set' : 'add';
  const parts = intField(req.body.parts, 'Quantité', mode === 'add' ? 1 : 0);
  tx(() => {
    const p = q.stockForProduct.get({ date, id: productId });
    if (!p) throw new HttpError(404, 'Produit introuvable');
    const next = mode === 'add' ? p.prep + parts : parts;
    setPrep.run(productId, next);
    insertMove.run(date, productId, mode === 'add' ? 'production' : 'correction_preparation', next - p.prep, localDateTime(), req.user.id);
  });
  res.json(stockPayload(date));
});

// Mise en vente : transfère du stock de préparation vers le stock de vente de la journée
// (1 moule mis en vente = −1 moule en préparation). C'est la seule façon de remplir le stock de vente,
// et le transfert ne se fait que dans ce sens.
app.post('/api/stock/mise-en-vente', auth('gerant'), (req, res) => {
  const date = dateParam(req.body.date);
  const productId = intField(req.body.product_id, 'Produit', 1);
  const parts = intField(req.body.parts, 'Quantité', 1);
  tx(() => {
    const p = q.stockForProduct.get({ date, id: productId });
    if (!p) throw new HttpError(404, 'Produit introuvable');
    if (p.is_flan && parts % PARTS_PER_MOLD) throw new HttpError(400, 'Les produits en moule se mettent en vente par moules entiers');
    if (parts > p.prep) throw new HttpError(400, `Stock de préparation insuffisant pour « ${p.name} » : ${formatParts(p.prep, p)}`);
    setPrep.run(productId, p.prep - parts);
    q.upsertStock.run(date, productId, p.quantity + parts);
    insertMove.run(date, productId, 'mise_en_vente', parts, localDateTime(), req.user.id);
  });
  res.json(stockPayload(date));
});

// Emballages mis à disposition pour la journée ("add" ajoute, "set" corrige le total).
// kind : 'part' (emballages de parts) ou 'moule' (emballages de moules).
app.post('/api/stock/emballages', auth('gerant'), (req, res) => {
  const date = dateParam(req.body.date);
  const kind = req.body.kind === 'moule' ? 'moule' : 'part';
  const mode = req.body.mode === 'set' ? 'set' : 'add';
  const quantity = intField(req.body.quantity, 'Nombre d’emballages', mode === 'add' ? 1 : 0);
  tx(() => {
    const block = packagingFor(date)[kind === 'moule' ? 'molds' : 'parts'];
    const next = mode === 'add' ? block.declared + quantity : quantity;
    if (next < block.used) throw new HttpError(400, `Impossible : ${block.used} emballage(s) déjà utilisé(s) aujourd’hui`);
    const column = kind === 'moule' ? 'mold_quantity' : 'quantity';
    db.prepare('INSERT INTO packaging_days (date, quantity, mold_quantity) VALUES (?, 0, 0) ON CONFLICT (date) DO NOTHING').run(date);
    db.prepare(`UPDATE packaging_days SET ${column} = ? WHERE date = ?`).run(next, date);
    if (kind === 'part' && next > block.used) resolveAlerts('emballages_parts', localDateTime());
  });
  res.json(stockPayload(date));
});

// ---------- Alertes pour le gérant ----------

const ALERT_KINDS = {
  emballages_parts: 'Emballages des parts terminés',
};

function resolveAlerts(kind, now) {
  db.prepare('UPDATE alerts SET resolved_at = ? WHERE kind = ? AND resolved_at IS NULL').run(now, kind);
}

// La caisse (ou le gérant) signale un problème. Une alerte encore ouverte du même type est « resignalée ».
app.post('/api/alertes', auth('caisse', 'gerant'), (req, res) => {
  const kind = String(req.body.kind || '');
  if (!ALERT_KINDS[kind]) throw new HttpError(400, 'Alerte inconnue');
  const now = localDateTime();
  const open = db.prepare('SELECT id FROM alerts WHERE kind = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(kind);
  if (open) {
    db.prepare('UPDATE alerts SET times = times + 1, updated_at = ?, user_id = ? WHERE id = ?').run(now, req.user.id, open.id);
  } else {
    db.prepare(`INSERT INTO alerts (date, kind, message, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(localDate(), kind, ALERT_KINDS[kind], now, now, req.user.id);
  }
  res.status(201).json({ ok: true });
});

// Alertes des 7 derniers jours : d'abord celles à traiter.
app.get('/api/alertes', auth('gerant'), (req, res) => {
  const since = localDate(new Date(Date.now() - 7 * 86400000));
  const alerts = db.prepare(`SELECT a.*, u.name AS user_name FROM alerts a LEFT JOIN users u ON u.id = a.user_id
                              WHERE a.date >= ? ORDER BY (a.resolved_at IS NULL) DESC, a.updated_at DESC LIMIT 30`).all(since);
  res.json({ open: alerts.filter((a) => !a.resolved_at).length, alerts });
});

app.post('/api/alertes/:id/traitee', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Alerte', 1);
  db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(localDateTime(), id);
  res.json({ ok: true });
});

// "29 parts" -> "3 moules + 5 parts" pour les produits en moule.
function formatParts(parts, p) {
  if (!p.is_flan) return `${parts}`;
  const m = Math.floor(parts / PARTS_PER_MOLD);
  const r = parts % PARTS_PER_MOLD;
  if (!m) return `${r} part${r > 1 ? 's' : ''}`;
  return `${m} moule${m > 1 ? 's' : ''}${r ? ` + ${r} part${r > 1 ? 's' : ''}` : ''}`;
}

// ---------- Commandes ----------
// items : [{ product_id, format: 'part'|'moule', quantity, toppings: [id...], place: 'sur_place'|'emporter' }]
// Chaque part (produit en moule) précise sur place ou à emporter ; un moule entier part toujours à emporter.
// molds_returned : moules rapportés par le client (pas d'emballage moule pour ceux-là).

app.post('/api/orders', auth('caisse', 'gerant'), (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw new HttpError(400, 'La commande est vide');
  const moldsReturned = intField(req.body.molds_returned ?? 0, 'Moules rapportés');
  const settings = venteSettings();
  const toppingById = new Map(activeToppings().map((t) => [t.id, t]));
  const date = localDate();

  const order = tx(() => {
    const lines = [];
    const partsByProduct = new Map();
    for (const it of items) {
      const pid = intField(it.product_id, 'Produit', 1);
      const qty = intField(it.quantity, 'Quantité', 1);
      const format = it.format === 'moule' ? 'moule' : 'part';
      const p = q.stockForProduct.get({ date, id: pid });
      if (!p || !p.active) throw new HttpError(400, 'Produit introuvable ou désactivé');
      if (format === 'moule' && p.mold_price_cents == null) throw new HttpError(400, `« ${p.name} » n’est pas vendu au moule`);
      const toppingIds = [...new Set((Array.isArray(it.toppings) ? it.toppings : []).map(Number))];
      if (toppingIds.length && !p.is_flan) throw new HttpError(400, `Pas de supplément possible sur « ${p.name} »`);
      const toppings = toppingIds.map((id) => {
        const t = toppingById.get(id);
        if (!t) throw new HttpError(400, 'Supplément introuvable');
        return t;
      });
      let place = null;
      if (format === 'moule') place = 'emporter';
      else if (['sur_place', 'emporter'].includes(it.place)) place = it.place;
      else if (p.is_flan) throw new HttpError(400, `Précisez sur place ou à emporter pour « ${p.name} »`);
      const parts = qty * (format === 'moule' ? PARTS_PER_MOLD : 1);
      partsByProduct.set(pid, (partsByProduct.get(pid) || 0) + parts);
      const unit = format === 'moule' ? p.mold_price_cents : p.price_cents;
      const toppingsCents = toppings.reduce((s, t) => s + t.price_cents, 0);
      lines.push({ p, qty, format, place, parts, unit, toppings, toppingsCents, lineTotal: qty * (unit + toppingsCents) });
    }
    for (const [pid, parts] of partsByProduct) {
      const p = q.stockForProduct.get({ date, id: pid });
      const remaining = Math.max(p.quantity - p.sold, 0);
      if (parts > remaining) throw new HttpError(409, `Stock insuffisant pour « ${p.name} » : il reste ${formatParts(remaining, p)}`);
    }

    const pack = packagingFor(date);

    // Emballage part : 1 par part emportée (produit en moule).
    const packagingCount = lines.filter((l) => l.p.is_flan && l.format === 'part' && l.place === 'emporter').reduce((s, l) => s + l.qty, 0);
    const places = new Set(lines.map((l) => l.place).filter(Boolean));
    const mode = places.size > 1 ? 'mixte' : places.has('emporter') ? 'emporter' : 'sur_place';
    const packagingCents = packagingCount * settings.packaging_price_cents;

    // Emballage moule : livré avec chaque moule entier (pas de stock à déclarer), facturé sauf si le client rapporte son ancien moule.
    const moldsCount = lines.filter((l) => l.format === 'moule').reduce((s, l) => s + l.qty, 0);
    const returned = Math.min(moldsReturned, moldsCount);
    const depositCents = (moldsCount - returned) * settings.mold_packaging_cents;

    const total = lines.reduce((s, l) => s + l.lineTotal, 0) + packagingCents + depositCents;
    const { n: number } = q.nextOrderNumber.get(date);
    const createdAt = localDateTime();
    // Note libre de la caisse (« sans sauce », « au nom de Sara »…), 200 caractères au plus.
    const note = String(req.body.note || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    const orderId = Number(q.insertOrder.run(date, number, createdAt, req.user.id, total, mode,
      packagingCount, packagingCents, moldsCount, returned, depositCents, note).lastInsertRowid);
    for (const l of lines) {
      q.insertItem.run(orderId, l.p.id, l.p.name, l.qty, l.unit, l.format, l.parts,
        l.toppings.length ? JSON.stringify(l.toppings.map((t) => t.name)) : null, l.toppingsCents, l.lineTotal, l.place);
    }
    return {
      id: orderId, number, date, created_at: createdAt, total_cents: total, mode, note,
      packaging_count: packagingCount, packaging_cents: packagingCents,
      molds_count: moldsCount, molds_returned: returned, mold_deposit_cents: depositCents,
    };
  });
  res.status(201).json(order);
});

app.get('/api/orders', auth(), (req, res) => {
  const isGerant = req.user.role === 'gerant';
  const date = isGerant ? dateParam(req.query.date) : localDate();
  let orders = q.ordersForDate.all(date);
  if (!isGerant) orders = orders.filter((o) => o.cashier_id === req.user.id);

  const itemsByOrder = new Map();
  for (const it of q.itemsForDate.all(date)) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push({ ...it, toppings: it.toppings ? JSON.parse(it.toppings) : [] });
  }
  res.json({ date, orders: orders.map((o) => ({ ...o, items: itemsByOrder.get(o.id) || [] })) });
});

// ---------- Ticket de caisse ----------

function ticketSettings() {
  const s = getSettings();
  return {
    phone: s.shop_phone || '',
    address: s.shop_address || '',
    instagram: s.shop_instagram || '',
    footer: s.ticket_footer || '',
    width: s.ticket_width === '58' ? 58 : 80,
    print_default: s.ticket_print_default === '1',
  };
}

app.get('/api/ticket/settings', auth(), (req, res) => res.json(ticketSettings()));

app.put('/api/ticket/settings', auth('gerant'), (req, res) => {
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  setSetting('shop_phone', text(req.body.phone, 30));
  setSetting('shop_address', text(req.body.address, 120));
  setSetting('shop_instagram', text(req.body.instagram, 60));
  setSetting('ticket_footer', text(req.body.footer, 120));
  setSetting('ticket_width', String(req.body.width) === '58' ? '58' : '80');
  setSetting('ticket_print_default', req.body.print_default ? '1' : '0');
  res.json(ticketSettings());
});

// Une commande complète pour imprimer son ticket. La caisse : seulement les commandes du jour.
app.get('/api/orders/:id/ticket', auth(), (req, res) => {
  const id = intField(req.params.id, 'Commande', 1);
  const order = db.prepare(`SELECT o.*, u.name AS cashier_name FROM orders o LEFT JOIN users u ON u.id = o.cashier_id WHERE o.id = ?`).get(id);
  if (!order || (req.user.role !== 'gerant' && order.date !== localDate())) throw new HttpError(404, 'Commande introuvable');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id)
    .map((it) => ({ ...it, toppings: it.toppings ? JSON.parse(it.toppings) : [] }));
  res.json({ ...order, items });
});

// ---------- Récapitulatif de la journée ----------

app.get('/api/summary', auth('gerant'), (req, res) => {
  const date = dateParam(req.query.date);
  const VALID = `o.date = ? AND o.status = 'valide'`;

  const totals = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue_cents,
                                    COALESCE(SUM(packaging_count), 0) AS packaging_count, COALESCE(SUM(packaging_cents), 0) AS packaging_cents,
                                    COALESCE(SUM(molds_returned), 0) AS molds_returned, COALESCE(SUM(mold_deposit_cents), 0) AS mold_deposit_cents,
                                    COALESCE(SUM(molds_count - molds_returned), 0) AS mold_packaging_count,
                                    COUNT(NULLIF(mode, 'sur_place')) AS takeaway_orders
                               FROM orders o WHERE ${VALID}`).get(date);
  const counts = db.prepare(`SELECT COALESCE(SUM(oi.quantity), 0) AS items,
                                    COALESCE(SUM(CASE WHEN oi.format = 'part' THEN oi.quantity END), 0) AS parts_sold,
                                    COALESCE(SUM(CASE WHEN oi.format = 'moule' THEN oi.quantity END), 0) AS molds_sold
                               FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${VALID}`).get(date);
  const { cancelled } = db.prepare(`SELECT COUNT(*) AS cancelled FROM orders WHERE date = ? AND status = 'annulee'`).get(date);

  const byProduct = db.prepare(`
    SELECT oi.product_id, oi.product_name AS name, SUM(oi.quantity) AS quantity,
           COALESCE(SUM(CASE WHEN oi.format = 'part' THEN oi.quantity END), 0) AS parts,
           COALESCE(SUM(CASE WHEN oi.format = 'moule' THEN oi.quantity END), 0) AS molds,
           SUM(oi.line_total_cents) AS revenue_cents
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE ${VALID} GROUP BY oi.product_id ORDER BY revenue_cents DESC, name`).all(date);

  const byCategory = db.prepare(`
    SELECT c.name, SUM(oi.quantity) AS quantity, SUM(oi.line_total_cents) AS revenue_cents
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id JOIN categories c ON c.id = p.category_id
     WHERE ${VALID} GROUP BY c.id ORDER BY revenue_cents DESC`).all(date);

  const byCashier = db.prepare(`
    SELECT u.name, COUNT(*) AS orders, SUM(o.total_cents) AS revenue_cents
      FROM orders o JOIN users u ON u.id = o.cashier_id
     WHERE ${VALID} GROUP BY u.id ORDER BY revenue_cents DESC`).all(date);

  const from = shiftDate(date, -6);
  const lastDaysRows = db.prepare(`
    SELECT date, COUNT(*) AS orders, SUM(total_cents) AS revenue_cents FROM orders
     WHERE status = 'valide' AND date BETWEEN ? AND ? GROUP BY date`).all(from, date);
  const lastDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = shiftDate(date, -i);
    const r = lastDaysRows.find((x) => x.date === d);
    lastDays.push({ date: d, orders: r ? r.orders : 0, revenue_cents: r ? r.revenue_cents : 0 });
  }

  res.json({
    date,
    totals: { ...totals, ...counts, cancelled, average_cents: totals.orders ? Math.round(totals.revenue_cents / totals.orders) : 0 },
    byProduct, byCategory, byCashier, lastDays,
    stock: q.stockForDate.all({ date }).map(withRemaining),
    packaging: packagingFor(date),
  });
});

// ---------- Fidélité : côté client (public, via QR) ----------

function publicLoyalty() {
  const s = getSettings();
  return { stamps_required: Number(s.stamps_required), reward_label: s.reward_label };
}

// Ce que le client voit : uniquement sa carte (prénom et visites).
function cardFor(customer) {
  const c = customerInfo(customer.id);
  return { name: c.name, stamps: c.stamps, visits: c.visits, visited_today: c.visited_today, ...publicLoyalty() };
}

pub.get('/api/public/join-info', rateLimit(60, 60000), (req, res) => {
  res.json(publicLoyalty());
});

// Session de saisie : démarre quand le client ouvre la page (après le scan du QR) et dure quelques minutes.
const JOIN_SESSION_MINUTES = 2; // chaque scan du QR ouvre une nouvelle session de 2 minutes
const joinSessions = new Map(); // id -> heure d'expiration (ms)

pub.post('/api/public/session', rateLimit(30, 60000), (req, res) => {
  const now = Date.now();
  for (const [id, exp] of joinSessions) if (exp < now) joinSessions.delete(id);
  const id = crypto.randomBytes(16).toString('hex');
  joinSessions.set(id, now + JOIN_SESSION_MINUTES * 60000);
  res.json({ session: id, expires_in: JOIN_SESSION_MINUTES * 60 });
});

// Compare les prénoms sans tenir compte des majuscules, accents et espaces ("azddine" = "AZDDINE" = " Azddine ").
const normalizeName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const sameName = (a, b) => normalizeName(a) === normalizeName(b);

// ----- Protection contre les essais répétés (comme une page de connexion) -----
// Après 5 erreurs de prénom pour un même numéro, ce numéro est bloqué LOCK_MINUTES.
// Par adresse IP le seuil est plus haut : les clients du même Wi-Fi partagent souvent la même IP.
const MAX_FAILS = { tel: 5, ip: 20 };
const LOCK_MINUTES = 15;
const failures = new Map(); // "tel:<numéro>" ou "ip:<adresse>" -> { count, until }

function lockedFor(key) {
  const f = failures.get(key);
  if (!f || !f.until) return 0;
  if (f.until < Date.now()) { failures.delete(key); return 0; }
  return Math.ceil((f.until - Date.now()) / 60000);
}

function addFailure(key) {
  const max = MAX_FAILS[key.split(':')[0]];
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= max) { f.until = Date.now() + LOCK_MINUTES * 60000; f.count = 0; }
  failures.set(key, f);
  return f.until ? 0 : max - f.count; // essais restants
}

// ----- Session de la carte : cookie sécurisé, valable 2 minutes après la saisie du prénom + numéro -----
const CARD_SESSION_MINUTES = 2;
const cardSessions = new Map(); // id -> { customerId, expires }

function openCardSession(req, res, customerId, visitCounted) {
  const now = Date.now();
  for (const [id, s] of cardSessions) if (s.expires < now) cardSessions.delete(id);
  const id = crypto.randomBytes(32).toString('hex');
  cardSessions.set(id, { customerId, visitCounted, expires: now + CARD_SESSION_MINUTES * 60000 });
  res.cookie('sl_card', id, {
    httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: CARD_SESSION_MINUTES * 60000, path: '/',
  });
}

function cardSession(req) {
  const id = parseCookies(req.headers.cookie).sl_card;
  const s = id && cardSessions.get(id);
  if (!s || s.expires < Date.now()) { if (id) cardSessions.delete(id); return null; }
  return s;
}

// Le client scanne le QR et entre son prénom + numéro : c'est une visite.
//  - nouveau numéro : sa carte est créée et cette première visite est comptée ;
//  - client déjà inscrit (même prénom + même numéro) : sa visite est comptée et sa carte s'ouvre.
// Une seule visite par jour est comptée.
pub.post('/api/public/join', rateLimit(30, 3600000), (req, res) => {
  const session = String(req.body.session || '');
  const expires = joinSessions.get(session);
  if (!expires || expires < Date.now()) {
    joinSessions.delete(session);
    throw new HttpError(410, 'Temps écoulé : scannez à nouveau le QR code.');
  }
  const name = textField(req.body.name, 'Prénom', 40);
  const phone = phoneField(req.body.phone);

  const ipKey = `ip:${req.ip}`;
  const phoneKey = `tel:${phone}`;
  const wait = Math.max(lockedFor(ipKey), lockedFor(phoneKey));
  if (wait) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${wait} minute${wait > 1 ? 's' : ''}.`);

  const existingCustomer = q.customerByPhone.get(phone);
  if (existingCustomer && !sameName(existingCustomer.name, name)) {
    addFailure(ipKey);
    const left = addFailure(phoneKey);
    throw new HttpError(401, left > 0
      ? `Prénom ou numéro incorrect. Il vous reste ${left} essai${left > 1 ? 's' : ''}.`
      : `Trop de tentatives. Réessayez dans ${LOCK_MINUTES} minutes.`);
  }

  const result = tx(() => {
    let customer = q.customerByPhone.get(phone);
    const isNew = !customer;
    if (isNew) {
      const token = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO customers (name, phone, token, created_at) VALUES (?, ?, ?, ?)').run(name.trim(), phone, token, localDateTime());
      customer = q.customerByPhone.get(phone);
    }
    return { customerId: customer.id, existing: !isNew, visit_counted: recordVisit(customer.id) };
  });
  failures.delete(phoneKey);
  failures.delete(ipKey);
  joinSessions.delete(session);
  openCardSession(req, res, result.customerId, result.visit_counted);
  res.status(result.existing ? 200 : 201).json({ existing: result.existing, visit_counted: result.visit_counted });
});

// La carte du client connecté (session cookie).
pub.get('/api/public/my-card', rateLimit(120, 60000), (req, res) => {
  const s = cardSession(req);
  if (!s) throw new HttpError(401, 'Session expirée');
  const customer = q.customerById.get(s.customerId);
  if (!customer) throw new HttpError(401, 'Session expirée');
  // visit_counted : ce passage a ajouté un tampon (sinon, la visite du jour était déjà comptée).
  res.json({ ...cardFor(customer), visit_counted: s.visitCounted, session_expires_in: Math.round((s.expires - Date.now()) / 1000) });
});

pub.post('/api/public/logout-card', (req, res) => {
  const id = parseCookies(req.headers.cookie).sl_card;
  if (id) cardSessions.delete(id);
  res.clearCookie('sl_card', { path: '/' });
  res.json({ ok: true });
});

// ---------- Gestion de la fidélité : onglet Clients du gérant (port 3000 uniquement) ----------

// Fidélité par visites : chaque visite (événement "gain") ajoute 1 tampon sur la carte.
// `stamps` = visites en cours sur la carte ; `visits` = nombre total de visites depuis l'inscription.
const VISITS_SQL = `(SELECT COUNT(*) FROM loyalty_events e WHERE e.customer_id = c.id AND e.type = 'gain') AS visits`;
const LAST_VISIT_SQL = `(SELECT MAX(e.created_at) FROM loyalty_events e WHERE e.customer_id = c.id AND e.type = 'gain') AS last_visit`;
const customerInfoStmt = db.prepare(`SELECT c.id, c.name, c.phone, c.stamps, c.rewards_used, c.created_at, ${VISITS_SQL}, ${LAST_VISIT_SQL}
                                       FROM customers c WHERE c.id = ?`);

const withVisitedToday = (c) => ({ ...c, visited_today: Boolean(c.last_visit) && c.last_visit.slice(0, 10) === localDate() });

function customerInfo(id) {
  const c = customerInfoStmt.get(id);
  if (!c) throw new HttpError(404, 'Client introuvable');
  return withVisitedToday(c);
}

// Compte une visite (1 tampon) si elle n'a pas déjà été comptée aujourd'hui. Renvoie true si comptée.
function recordVisit(id) {
  if (customerInfo(id).visited_today) return false;
  q.addStamps.run(1, 0, id);
  q.insertEvent.run(id, null, 'gain', 1, localDateTime());
  return true;
}

// QR code en SVG (affiche du comptoir).
app.get('/api/qr.svg', auth('gerant'), async (req, res) => {
  const data = String(req.query.data || '');
  if (!data || data.length > 300) throw new HttpError(400, 'Données invalides');
  const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#45281d', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});

// Même QR code en image PNG haute résolution, à télécharger pour l'imprimer.
app.get('/api/qr.png', auth('gerant'), async (req, res) => {
  const data = String(req.query.data || '');
  if (!data || data.length > 300) throw new HttpError(400, 'Données invalides');
  const png = await QRCode.toBuffer(data, { width: 1000, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#45281d', light: '#ffffff' } });
  res.type('image/png').set('Content-Disposition', 'attachment; filename="qr-fidelite-sweetlab.png"').send(png);
});

app.get('/api/loyalty/settings', auth('gerant'), (req, res) => {
  res.json({ ...publicLoyalty(), public_url: getSettings().public_url, public_port: Number(PUBLIC_PORT) });
});

app.put('/api/loyalty/settings', auth('gerant'), (req, res) => {
  const required = intField(req.body.stamps_required, 'Nombre de visites', 1);
  if (required > 50) throw new HttpError(400, 'Nombre de visites : 50 maximum');
  const label = textField(req.body.reward_label, 'Récompense', 60);
  const url = String(req.body.public_url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new HttpError(400, 'Adresse invalide (ex. https://...)');
  setSetting('stamps_required', required);
  setSetting('reward_label', label);
  setSetting('public_url', url);
  res.json({ ok: true });
});

// Liste des clients (recherche par prénom ou téléphone) + indicateurs.
app.get('/api/fidelite/clients', auth('gerant'), (req, res) => {
  const raw = String(req.query.q || '').trim();
  const search = `%${raw}%`;
  const phoneSearch = `%${normalizePhone(raw) || raw.replace(/\D/g, '') || raw}%`;
  const customers = db.prepare(`
    SELECT c.id, c.name, c.phone, c.stamps, c.rewards_used, c.created_at, ${VISITS_SQL}, ${LAST_VISIT_SQL}
      FROM customers c
     WHERE c.name LIKE ? OR c.phone LIKE ?
     ORDER BY c.id DESC LIMIT 500`).all(search, phoneSearch).map(withVisitedToday);
  const totals = db.prepare(`SELECT COUNT(*) AS customers, COALESCE(SUM(rewards_used), 0) AS rewards_used,
                                    (SELECT COUNT(*) FROM loyalty_events WHERE type = 'gain' AND substr(created_at, 1, 10) = ?) AS visits_today
                               FROM customers`).get(localDate());
  res.json({ stamps_required: Number(getSettings().stamps_required), totals, customers });
});

// Compte la visite d'un client (s'il n'a pas scanné le QR). Une par jour.
app.post('/api/fidelite/clients/:id/visit', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Client', 1);
  tx(() => {
    const c = customerInfo(id);
    if (!recordVisit(id)) throw new HttpError(409, `La visite de ${c.name} est déjà comptée aujourd’hui`);
  });
  res.json(customerInfo(id));
});

// Offre la récompense : retire le nombre de visites requis.
app.post('/api/fidelite/clients/:id/redeem', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Client', 1);
  const required = Number(getSettings().stamps_required);
  tx(() => {
    const c = customerInfo(id);
    if (c.stamps < required) throw new HttpError(400, `${c.name} n’a que ${c.stamps} visite(s) sur ${required}`);
    q.addStamps.run(-required, 1, id);
    q.insertEvent.run(id, null, 'recompense', -required, localDateTime());
  });
  res.json(customerInfo(id));
});

// Correction manuelle de la carte (geste commercial, erreur...).
app.post('/api/fidelite/clients/:id/adjust', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Client', 1);
  const delta = Number(req.body.stamps);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) throw new HttpError(400, 'Correction invalide');
  tx(() => {
    customerInfo(id);
    q.addStamps.run(delta, 0, id);
    q.insertEvent.run(id, null, 'ajustement', delta, localDateTime());
  });
  res.json(customerInfo(id));
});

// Met les numéros déjà enregistrés au même format que les nouveaux (ex. "212678707591" -> "0678707591").
(function normalizeStoredPhones() {
  const update = db.prepare('UPDATE customers SET phone = ? WHERE id = ?');
  for (const c of db.prepare('SELECT id, phone FROM customers').all()) {
    const phone = normalizePhone(c.phone);
    if (phone && phone !== c.phone && !q.customerByPhone.get(phone)) update.run(phone, c.id);
  }
})();

// ---------- Matières premières (gérant) ----------

const FACTURES_DIR = path.join(DATA_DIR, 'factures');
fs.mkdirSync(FACTURES_DIR, { recursive: true });

function quantityField(value, label) {
  const n = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${label} invalide`);
  return Math.round(n * 1000) / 1000;
}

const rawByName = db.prepare('SELECT * FROM raw_materials WHERE name = ? COLLATE NOCASE');
const insertRawMove = db.prepare(`INSERT INTO raw_moves (raw_material_id, kind, quantity, invoice_id, created_at, user_id)
                                  VALUES (?, ?, ?, ?, ?, ?)`);

app.get('/api/matieres', auth('gerant'), (req, res) => {
  res.json(db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM invoice_lines l WHERE l.raw_material_id = r.id) AS invoice_lines
                         FROM raw_materials r ORDER BY r.name COLLATE NOCASE`).all());
});

app.post('/api/matieres', auth('gerant'), (req, res) => {
  const name = textField(req.body.name, 'Nom', 60);
  const unit = textField(req.body.unit || 'unité', 'Unité', 20);
  const quantity = quantityField(req.body.quantity ?? 0, 'Quantité');
  const id = tx(() => {
    if (rawByName.get(name)) throw new HttpError(409, 'Cette matière première existe déjà');
    const newId = Number(db.prepare('INSERT INTO raw_materials (name, unit, quantity, updated_at) VALUES (?, ?, ?, ?)')
      .run(name, unit, quantity, localDateTime()).lastInsertRowid);
    if (quantity) insertRawMove.run(newId, 'correction', quantity, null, localDateTime(), req.user.id);
    return newId;
  });
  res.status(201).json(db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(id));
});

app.put('/api/matieres/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Matière', 1);
  const before = db.prepare('SELECT name FROM raw_materials WHERE id = ?').get(id);
  const newName = textField(req.body.name, 'Nom', 60);
  const { changes } = db.prepare('UPDATE raw_materials SET name = ?, unit = ? WHERE id = ?')
    .run(newName, textField(req.body.unit || 'unité', 'Unité', 20), id);
  if (!changes) throw new HttpError(404, 'Matière première introuvable');
  if (before && before.name !== newName) ocrMemory.rename(before.name, newName);
  res.json({ ok: true });
});

// Supprime une matière première (ou toutes) du stock. Les factures restent, avec le nom de leurs lignes.
function deleteRawMaterials(ids) {
  const unlink = db.prepare('UPDATE invoice_lines SET raw_material_id = NULL WHERE raw_material_id = ?');
  const moves = db.prepare('DELETE FROM raw_moves WHERE raw_material_id = ?');
  const del = db.prepare('DELETE FROM raw_materials WHERE id = ?');
  for (const id of ids) { unlink.run(id); moves.run(id); del.run(id); }
}

app.delete('/api/matieres/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Matière', 1);
  tx(() => {
    if (!db.prepare('SELECT id FROM raw_materials WHERE id = ?').get(id)) throw new HttpError(404, 'Matière première introuvable');
    deleteRawMaterials([id]);
  });
  res.json({ ok: true });
});

app.delete('/api/matieres', auth('gerant'), (req, res) => {
  const deleted = tx(() => {
    const ids = db.prepare('SELECT id FROM raw_materials').all().map((r) => r.id);
    deleteRawMaterials(ids);
    return ids.length;
  });
  res.json({ deleted });
});

// Utilisation (retire une quantité) ou correction (fixe la quantité en stock).
app.post('/api/matieres/:id/mouvement', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Matière', 1);
  const kind = req.body.kind === 'correction' ? 'correction' : 'utilisation';
  const quantity = quantityField(req.body.quantity, 'Quantité');
  tx(() => {
    const r = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Matière première introuvable');
    const next = kind === 'correction' ? quantity : r.quantity - quantity;
    if (next < 0) throw new HttpError(400, `Stock insuffisant : il reste ${r.quantity} ${r.unit}`);
    db.prepare('UPDATE raw_materials SET quantity = ?, updated_at = ? WHERE id = ?').run(next, localDateTime(), id);
    insertRawMove.run(id, kind, next - r.quantity, null, localDateTime(), req.user.id);
  });
  res.json(db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(id));
});

// ---------- Lecture automatique des factures (Claude) ----------

function anthropicClient() {
  const key = getSettings().anthropic_api_key;
  if (key) return new Anthropic({ apiKey: key });
  if (process.env.ANTHROPIC_API_KEY) return new Anthropic();
  return null;
}

// La clé API et la mémoire d'apprentissage se gèrent seulement par le développeur, sur le PC :
// `npm run outils` (scripts/outils.js). Elles ne sont pas exposées à l'interface du gérant.

function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'Photo invalide (JPEG, PNG, WebP ou GIF)');
  return { mediaType: m[1], data: m[2], ext: m[1].split('/')[1].replace('jpeg', 'jpg') };
}

// Facture PDF envoyée en base64 (10 Mo maximum).
function parsePdf(dataUrl) {
  const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'PDF invalide');
  if (m[1].length > 14 * 1024 * 1024) throw new HttpError(413, 'PDF trop lourd (10 Mo maximum)');
  return { mediaType: 'application/pdf', data: m[1] };
}

// Format JSON exact attendu de Claude (sortie structurée).
const INVOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'invoice_date', 'total', 'lines'],
  properties: {
    supplier: { type: 'string' },
    invoice_date: { type: 'string' },
    total: { type: 'number' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'quantity', 'unit', 'unit_price', 'total'],
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          unit_price: { type: 'number' },
          total: { type: 'number' },
        },
      },
    },
  },
};

// ----- Lecture par l'IA Claude (si une clé API est configurée) -----
async function readWithClaude(client, img, pdf = null) {
  const known = db.prepare('SELECT name, unit FROM raw_materials ORDER BY name').all();
  let response;
  try {
    response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: INVOICE_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          pdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.data } }
            : { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
          {
            type: 'text',
            text: `Voici ${pdf ? 'le PDF' : 'la photo'} d'une facture d'achat d'une pâtisserie au Maroc (matières premières : lait, œufs, sucre, chocolat, emballages...).
La facture peut être en français, en arabe ou en darija : traduis tout en français.
Extrais :
- supplier : le nom du fournisseur ("" si illisible) ;
- invoice_date : la date au format AAAA-MM-JJ ("" si absente) ;
- total : le montant total TTC en dirhams (0 si absent) ;
- lines : une entrée par article acheté, avec name (nom court en français, traduit de l'arabe si besoin : كليكوز -> glucose, معالق -> cuillères), quantity (nombre), unit en français (kg, g, L, ml, pièce, paquet, boîte, sachet, carton... ; كلغ = kg, وحدة = pièce (une seule pièce), باكية = paquet ; الوحدة est seulement le titre de la colonne des unités), unit_price (prix unitaire en dirhams) et total (montant de la ligne en dirhams).
Si un prix unitaire manque, calcule-le à partir du total de la ligne et de la quantité. N'invente pas d'articles absents de la facture.
${known.length ? `Matières premières déjà connues (réutilise exactement ces noms et unités quand l'article correspond) : ${known.map((k) => `${k.name} (${k.unit})`).join(', ')}.` : ''}`,
          },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(400, 'Clé API Anthropic refusée : vérifiez-la dans les réglages.');
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'Service de lecture saturé, réessayez dans une minute.');
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(503, 'Pas de connexion au service de lecture (Internet ?).');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `Lecture impossible (erreur ${err.status}).`);
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'La facture n’a pas pu être lue. Saisissez les lignes à la main.');
  const text = response.content.find((b) => b.type === 'text');
  try {
    return JSON.parse(text ? text.text : '');
  } catch {
    throw new HttpError(502, 'Réponse illisible, réessayez ou saisissez à la main.');
  }
}

// ----- Lecture gratuite sur le PC (OCR Tesseract), sans clé ni service extérieur -----
// Les données de langue (français + anglais) sont téléchargées une seule fois, puis gardées dans data/ocr.
const OCR_DIR = path.join(DATA_DIR, 'ocr');
fs.mkdirSync(OCR_DIR, { recursive: true }); // sans ce dossier, les données de langue seraient retéléchargées à chaque fois
let ocrWorker = null;
function getOcrWorker() {
  if (!ocrWorker) {
    ocrWorker = createWorker('fra+eng', 1, { cachePath: OCR_DIR })
      .then(async (w) => {
        // PSM 4 : texte en colonnes ; on garde les espaces pour séparer les colonnes du tableau.
        await w.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });
        return w;
      })
      .catch((err) => { ocrWorker = null; throw err; });
  }
  return ocrWorker;
}

// 2e lecteur, en arabe : unités et noms des factures arabes (traduits en français ensuite).
let arabicWorker = null;
function getArabicWorker() {
  if (!arabicWorker) {
    arabicWorker = createWorker('ara+fra', 1, { cachePath: OCR_DIR })
      .then(async (w) => {
        await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        return w;
      })
      .catch((err) => { arabicWorker = null; throw err; });
  }
  return arabicWorker;
}

// Plusieurs façons de lire la page ; on garde celle qui trouve le plus d'articles.
// PSM 4 : colonnes ; 6 : bloc de texte ; 11 : texte dispersé (photo de travers, tableau mal aligné).
async function readWithOcr(img) {
  let worker;
  try {
    worker = await getOcrWorker();
  } catch {
    throw new HttpError(503, 'La lecture gratuite doit télécharger ses données une première fois : vérifiez la connexion Internet du PC et réessayez.');
  }
  const buffer = Buffer.from(img.data, 'base64');
  let best = null;
  for (const psm of ['4', '6', '11']) {
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(buffer, {}, { blocks: true }); // avec la position des mots
    const text = data.text || '';
    const parsed = parseInvoiceText(text, { ocr: true });
    const linesSum = parsed.lines.reduce((s, l) => s + (l.total || 0), 0);
    const near = (v) => v && Math.abs(linesSum - v) <= Math.max(1, v * 0.01);
    const totalMatches = near(parsed.total) || near(parsed.subtotal);
    // À nombre de lignes égal, on préfère la lecture dont la somme se rapproche le plus du total.
    const gap = parsed.total ? Math.min(1, Math.abs(linesSum - parsed.total) / parsed.total) : 1;
    const score = parsed.lines.length * 10 + (totalMatches ? 15 : 0) + (parsed.total ? 2 : 0) + (parsed.invoice_date ? 1 : 0) - gap * 5;
    if (!best || score > best.score) best = { ...parsed, raw_text: text, score, page: data };
    // Lecture cohérente (somme des lignes ≈ total de la facture) : inutile d'essayer les autres méthodes.
    if (parsed.lines.length && totalMatches) break;
  }
  await worker.setParameters({ tessedit_pageseg_mode: '4' });
  if (!best.raw_text || best.raw_text.trim().length < 10) {
    throw new HttpError(422, 'Aucun texte lisible sur la photo : reprenez-la plus nette, bien éclairée, de face et en entier.');
  }
  // Lecture en arabe (unités et noms des factures arabes ; le lecteur français y voit du charabia).
  let araPage = null;
  let ara = null;
  try {
    ara = await getArabicWorker();
    await ara.setParameters({ tessedit_pageseg_mode: '6' });
    // blocks : lignes et mots avec leur position sur la photo.
    const { data } = await ara.recognize(buffer, {}, { blocks: true });
    if ((data.text.match(/[؀-ۿ]/g) || []).length >= 20) araPage = data;
  } catch (err) {
    console.warn('Lecture en arabe impossible :', err.message);
  }

  // Lecture du tableau colonne par colonne (en-têtes العدد | الوحدة | نوع البضاعة | الثمن | الواجب, ou Désignation | Qté…).
  // Une case vide ou une ligne qui ne tombe pas juste est relue seule (PSM 7 : une ligne de texte).
  let frMode = '';
  const read = async (kind, rectangle) => {
    if (kind === 'ara') {
      if (!ara) return '';
      await ara.setParameters({ tessedit_pageseg_mode: '7' });
      return (await ara.recognize(buffer, { rectangle })).data.text;
    }
    if (frMode !== kind) {
      await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: kind === 'num' ? '0123456789.,' : '' });
      frMode = kind;
    }
    return (await worker.recognize(buffer, { rectangle })).data.text;
  };
  let table = null;
  try {
    table = await readTable({ frPage: best.page, araPage, read });
  } catch (err) {
    console.warn('Lecture du tableau impossible :', err.message);
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '4', tessedit_char_whitelist: '' });
    if (ara) await ara.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
  }

  // On garde la lecture du tableau si elle trouve autant de lignes et tombe au moins aussi près du total.
  const target = best.subtotal || best.total || table?.total || 0;
  const gap = (lines) => (target ? Math.abs(lines.reduce((s, l) => s + l.total, 0) - target) / target : 0);
  if (table && table.lines.length >= 2 && table.lines.length >= best.lines.length * 0.75 && gap(table.lines) <= gap(best.lines) + 0.005) {
    best.lines = table.lines.map(({ sure, ...l }) => l);
    if (!best.total && table.total) best.total = table.total;
    best.method_detail = 'tableau';
  } else if (araPage && best.lines.length) {
    // Sinon : lecture ligne par ligne, complétée par l'arabe (unités et noms traduits).
    try {
      await ara.setParameters({ tessedit_pageseg_mode: '7' });
      await enrichWithArabic(best.lines, araPage, async (rectangle) => (await ara.recognize(buffer, { rectangle })).data.text, best.page);
    } catch (err) {
      console.warn('Lecture en arabe impossible :', err.message);
    } finally {
      await ara.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
    }
  }
  return best;
}

// Qualité d'une lecture : lignes justes (quantité × prix = montant) et somme des lignes = total de la facture.
function readingScore(r) {
  const sure = r.lines.filter((l) => Math.abs(l.quantity * l.unit_price - l.total) <= 0.011).length;
  const target = r.subtotal || r.total;
  const sum = r.lines.reduce((s, l) => s + l.total, 0);
  const gap = target ? Math.abs(sum - target) / target : 1;
  return { sure, gap, perfect: r.lines.length > 0 && sure === r.lines.length && gap < 0.001, value: sure * 10 + (gap < 0.001 ? 50 : 0) - Math.min(gap, 1) * 100 + r.lines.length };
}

// La photo est préparée de deux façons par le navigateur : la 2e n'est lue que si la 1re n'est pas parfaite,
// et on garde la meilleure des deux.
async function readBestOcr(img, alt) {
  const first = await readWithOcr(img);
  const s1 = readingScore(first);
  if (!alt || s1.perfect) return fixSmallGap(first);
  let second;
  try {
    second = await readWithOcr(alt);
  } catch {
    return fixSmallGap(first);
  }
  return fixSmallGap(readingScore(second).value > s1.value ? second : first);
}

// Petit écart entre la somme des lignes et le total (« 36,40 » lu au lieu de « 36,00 ») : si une seule ligne
// l'explique — son montant corrigé devient rond alors qu'il ne l'était pas — on la corrige.
function fixSmallGap(r) {
  const target = r.subtotal || r.total;
  if (!target || !r.lines.length) return r;
  const delta = Math.round((r.lines.reduce((s, l) => s + l.total, 0) - target) * 100) / 100;
  if (Math.abs(delta) < 0.01 || Math.abs(delta) > target * 0.05) return r;
  const round = (v) => Math.abs(v - Math.round(v)) < 0.001;
  const cands = r.lines.filter((l) => l.total - delta > 0 && round(l.total - delta) && !round(l.total));
  if (cands.length === 1) {
    const l = cands[0];
    l.total = Math.round((l.total - delta) * 100) / 100;
    l.unit_price = Math.round((l.total / (l.quantity || 1)) * 100) / 100;
  }
  return r;
}

// Lit une facture (photo ou PDF) et renvoie un brouillon (fournisseur, date, lignes) que le gérant vérifie avant d'enregistrer.
// Avec une clé API : lecture par Claude. Sans clé : texte du PDF s'il en contient, sinon lecture gratuite sur le PC.
app.post('/api/factures/lire', auth('gerant'), async (req, res) => {
  // Pour un PDF, "image" est l'aperçu de la 1re page rendu par le navigateur.
  const img = parseImage(req.body.image);
  const pdf = req.body.pdf ? parsePdf(req.body.pdf) : null;
  // Version préparée pour la lecture gratuite (agrandie, noir et blanc, contrasté), envoyée par le navigateur.
  const ocrImg = req.body.ocr_image ? parseImage(req.body.ocr_image) : img;
  const ocrAlt = req.body.ocr_image_alt ? parseImage(req.body.ocr_image_alt) : null; // 2e préparation de la photo
  // Texte extrait du PDF par le navigateur (lignes du tableau, colonnes séparées par des espaces).
  const pdfText = typeof req.body.pdf_text === 'string' ? req.body.pdf_text.slice(0, 200000) : '';
  const client = anthropicClient();
  let method;
  let data;
  if (client) {
    method = 'ia';
    data = await readWithClaude(client, img, pdf);
  } else if (pdf && pdfText.replace(/\s/g, '').length >= 20) {
    method = 'pdf';
    data = { ...parseInvoiceText(pdfText), raw_text: pdfText };
  } else {
    method = 'ocr';
    data = await readBestOcr(ocrImg, ocrAlt);
  }

  const cents = (v) => Math.max(0, Math.round(Number(v || 0) * 100));
  res.json({
    method,
    raw_text: data.raw_text || '',
    supplier: data.supplier || '',
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(data.invoice_date) ? data.invoice_date : '',
    total_cents: cents(data.total),
    subtotal_cents: cents(data.subtotal), // total HT, pour vérifier la somme des lignes (lecture gratuite)
    lines: (data.lines || []).map((l) => {
      // read_name : le nom tel que lu ; renvoyé à l'enregistrement pour que la mémoire apprenne la correction.
      const readName = String(l.name || '').trim();
      const memo = ocrMemory.recall(readName, cents(l.unit_price));
      const name = memo ? memo.name : readName;
      const match = rawByName.get(name);
      return {
        name: match ? match.name : name,
        quantity: Math.max(0, Math.round((Number(l.quantity) || 0) * 1000) / 1000),
        unit: match ? match.unit : (memo ? memo.unit : String(l.unit || 'unité').trim() || 'unité'),
        unit_price_cents: cents(l.unit_price),
        total_cents: cents(l.total),
        known: Boolean(match),
        read_name: readName,
        learned: Boolean(memo && (memo.name !== readName || memo.unit !== (String(l.unit || '').trim() || 'unité'))), // corrigée par l'apprentissage
      };
    }),
  });
});

// ---------- Factures ----------

app.get('/api/factures', auth('gerant'), (req, res) => {
  res.json(db.prepare(`SELECT i.*, u.name AS user_name,
                              (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS lines_count
                         FROM invoices i LEFT JOIN users u ON u.id = i.user_id
                        ORDER BY COALESCE(i.invoice_date, substr(i.created_at, 1, 10)) DESC, i.id DESC LIMIT 300`).all());
});

app.get('/api/factures/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Facture', 1);
  const invoice = db.prepare('SELECT i.*, u.name AS user_name FROM invoices i LEFT JOIN users u ON u.id = i.user_id WHERE i.id = ?').get(id);
  if (!invoice) throw new HttpError(404, 'Facture introuvable');
  res.json({ ...invoice, lines: db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(id) });
});

app.get('/api/factures/:id/pdf', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Facture', 1);
  const invoice = db.prepare('SELECT pdf FROM invoices WHERE id = ?').get(id);
  if (!invoice || !invoice.pdf) throw new HttpError(404, 'Pas de PDF pour cette facture');
  res.sendFile(path.join(FACTURES_DIR, path.basename(invoice.pdf)));
});

app.get('/api/factures/:id/photo', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Facture', 1);
  const invoice = db.prepare('SELECT photo FROM invoices WHERE id = ?').get(id);
  if (!invoice || !invoice.photo) throw new HttpError(404, 'Pas de photo pour cette facture');
  res.sendFile(path.join(FACTURES_DIR, path.basename(invoice.photo)));
});

// Enregistre une facture : chaque ligne s'ajoute au stock de matières premières, avec son prix.
app.post('/api/factures', auth('gerant'), (req, res) => {
  const supplier = String(req.body.supplier || '').trim().slice(0, 80) || null;
  const invoiceDate = req.body.invoice_date ? dateParam(req.body.invoice_date) : localDate();
  const source = ['ia', 'ocr', 'pdf'].includes(req.body.source) ? req.body.source : 'manuel';
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).map((l, i) => ({
    name: textField(l.name, `Article (ligne ${i + 1})`, 60),
    quantity: quantityField(l.quantity, `Quantité (ligne ${i + 1})`),
    unit: textField(l.unit || 'unité', `Unité (ligne ${i + 1})`, 20),
    unit_price_cents: intField(l.unit_price_cents ?? 0, `Prix unitaire (ligne ${i + 1})`),
    total_cents: intField(l.total_cents ?? 0, `Total (ligne ${i + 1})`),
    read_name: String(l.read_name || '').slice(0, 120), // nom tel que lu sur la facture
  }));
  if (!lines.length) throw new HttpError(400, 'Ajoutez au moins une ligne à la facture');
  if (lines.some((l) => l.quantity <= 0)) throw new HttpError(400, 'Chaque ligne doit avoir une quantité supérieure à 0');
  const total = req.body.total_cents ? intField(req.body.total_cents, 'Total') : lines.reduce((s, l) => s + l.total_cents, 0);
  const img = req.body.image ? parseImage(req.body.image) : null;
  const pdf = req.body.pdf ? parsePdf(req.body.pdf) : null;

  const id = tx(() => {
    const now = localDateTime();
    const invoiceId = Number(db.prepare(`INSERT INTO invoices (supplier, invoice_date, total_cents, source, created_at, user_id)
                                         VALUES (?, ?, ?, ?, ?, ?)`).run(supplier, invoiceDate, total, source, now, req.user.id).lastInsertRowid);
    for (const l of lines) {
      let raw = rawByName.get(l.name);
      if (!raw) {
        const rawId = Number(db.prepare('INSERT INTO raw_materials (name, unit, quantity, updated_at) VALUES (?, ?, 0, ?)')
          .run(l.name, l.unit, now).lastInsertRowid);
        raw = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(rawId);
      }
      db.prepare('UPDATE raw_materials SET quantity = quantity + ?, last_price_cents = ?, updated_at = ? WHERE id = ?')
        .run(l.quantity, l.unit_price_cents || raw.last_price_cents, now, raw.id);
      db.prepare(`INSERT INTO invoice_lines (invoice_id, raw_material_id, name, quantity, unit, unit_price_cents, total_cents)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(invoiceId, raw.id, raw.name, l.quantity, l.unit, l.unit_price_cents, l.total_cents);
      insertRawMove.run(raw.id, 'facture', l.quantity, invoiceId, now, req.user.id);
    }
    if (img) {
      const file = `facture-${invoiceId}.${img.ext}`;
      fs.writeFileSync(path.join(FACTURES_DIR, file), Buffer.from(img.data, 'base64'));
      db.prepare('UPDATE invoices SET photo = ? WHERE id = ?').run(file, invoiceId);
    }
    if (pdf) {
      const file = `facture-${invoiceId}.pdf`;
      fs.writeFileSync(path.join(FACTURES_DIR, file), Buffer.from(pdf.data, 'base64'));
      db.prepare('UPDATE invoices SET pdf = ? WHERE id = ?').run(file, invoiceId);
    }
    return invoiceId;
  });
  // Apprentissage : « lu » -> « validé » pour chaque ligne venue de la lecture automatique.
  if (source !== 'manuel') ocrMemory.learn(lines.filter((l) => l.read_name), localDateTime());
  res.status(201).json({ id });
});

// Supprime une facture et retire ses quantités du stock de matières premières.
app.delete('/api/factures/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Facture', 1);
  const files = tx(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw new HttpError(404, 'Facture introuvable');
    const now = localDateTime();
    for (const l of db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(id)) {
      if (!l.raw_material_id) continue;
      db.prepare('UPDATE raw_materials SET quantity = MAX(quantity - ?, 0), updated_at = ? WHERE id = ?').run(l.quantity, now, l.raw_material_id);
      insertRawMove.run(l.raw_material_id, 'annulation_facture', -l.quantity, null, now, req.user.id);
    }
    db.prepare('UPDATE raw_moves SET invoice_id = NULL WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    return [invoice.photo, invoice.pdf].filter(Boolean);
  });
  for (const file of files) fs.rm(path.join(FACTURES_DIR, path.basename(file)), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------- Fond de caisse (gérant) ----------
// Espèces attendues = fond initial + ventes validées du jour.
// (Toutes les ventes sont considérées payées en espèces.)

function cashSummary(date) {
  const day = db.prepare(`SELECT d.*, uo.name AS opened_by_name, uc.name AS closed_by_name
                            FROM cash_days d
                            LEFT JOIN users uo ON uo.id = d.opened_by
                            LEFT JOIN users uc ON uc.id = d.closed_by
                           WHERE d.date = ?`).get(date) || null;
  const { sales } = db.prepare(`SELECT COALESCE(SUM(total_cents), 0) AS sales FROM orders WHERE date = ? AND status = 'valide'`).get(date);
  const expected = day ? day.opening_cents + sales : null;
  return {
    date, day,
    sales_cents: sales, expected_cents: expected,
    diff_cents: day && day.counted_cents != null ? day.counted_cents - day.expected_cents : null,
  };
}

function openDayOrThrow(date) {
  const day = db.prepare('SELECT * FROM cash_days WHERE date = ?').get(date);
  if (!day) throw new HttpError(400, 'Ouvrez d’abord la journée avec le fond de caisse');
  if (day.closed_at) throw new HttpError(400, 'La journée est clôturée : rouvrez-la pour la modifier');
  return day;
}

app.get('/api/fond', auth('gerant'), (req, res) => {
  res.json(cashSummary(dateParam(req.query.date)));
});

// Ouverture de la journée (ou correction du fond initial tant que la journée n'est pas clôturée).
app.put('/api/fond/:date/ouverture', auth('gerant'), (req, res) => {
  const date = dateParam(req.params.date);
  const amount = intField(req.body.amount_cents, 'Fond de caisse');
  tx(() => {
    const day = db.prepare('SELECT * FROM cash_days WHERE date = ?').get(date);
    if (day && day.closed_at) throw new HttpError(400, 'La journée est clôturée : rouvrez-la pour la modifier');
    if (day) db.prepare('UPDATE cash_days SET opening_cents = ? WHERE date = ?').run(amount, date);
    else db.prepare('INSERT INTO cash_days (date, opening_cents, opened_at, opened_by) VALUES (?, ?, ?, ?)')
      .run(date, amount, localDateTime(), req.user.id);
  });
  res.json(cashSummary(date));
});

// Clôture : on enregistre les espèces comptées et les espèces attendues à ce moment-là.
app.post('/api/fond/:date/cloture', auth('gerant'), (req, res) => {
  const date = dateParam(req.params.date);
  const counted = intField(req.body.counted_cents, 'Espèces comptées');
  const note = String(req.body.note || '').trim().slice(0, 200) || null;
  tx(() => {
    openDayOrThrow(date);
    const expected = cashSummary(date).expected_cents;
    db.prepare('UPDATE cash_days SET counted_cents = ?, expected_cents = ?, closed_at = ?, closed_by = ?, note = ? WHERE date = ?')
      .run(counted, expected, localDateTime(), req.user.id, note, date);
  });
  res.json(cashSummary(date));
});

app.post('/api/fond/:date/reouverture', auth('gerant'), (req, res) => {
  const date = dateParam(req.params.date);
  const { changes } = db.prepare(`UPDATE cash_days SET counted_cents = NULL, expected_cents = NULL, closed_at = NULL, closed_by = NULL
                                   WHERE date = ? AND closed_at IS NOT NULL`).run(date);
  if (!changes) throw new HttpError(400, 'Cette journée n’est pas clôturée');
  res.json(cashSummary(date));
});

// ---------- Utilisateurs ----------

app.get('/api/users', auth('gerant'), (req, res) => {
  res.json(db.prepare('SELECT id, username, name, role, active FROM users ORDER BY role DESC, name').all());
});

app.post('/api/users', auth('gerant'), (req, res) => {
  const username = textField(req.body.username, 'Identifiant', 40).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(username)) throw new HttpError(400, 'Identifiant : lettres, chiffres, . _ - uniquement');
  const name = textField(req.body.name, 'Nom');
  const role = req.body.role === 'gerant' ? 'gerant' : 'caisse';
  const password = String(req.body.password || '');
  if (password.length < 6) throw new HttpError(400, 'Mot de passe : 6 caractères minimum');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(username, name, role, hashPassword(password));
  res.status(201).json({ id: Number(lastInsertRowid), username, name, role, active: 1 });
});

app.put('/api/users/:id', auth('gerant'), (req, res) => {
  const id = intField(req.params.id, 'Utilisateur', 1);
  const name = textField(req.body.name, 'Nom');
  const active = req.body.active ? 1 : 0;
  if (id === req.user.id && !active) throw new HttpError(400, 'Vous ne pouvez pas désactiver votre propre compte');
  tx(() => {
    const { changes } = db.prepare('UPDATE users SET name = ?, active = ? WHERE id = ?').run(name, active, id);
    if (!changes) throw new HttpError(404, 'Utilisateur introuvable');
    if (req.body.password) {
      if (String(req.body.password).length < 6) throw new HttpError(400, 'Mot de passe : 6 caractères minimum');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.password)), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(id, req.user.id);
    }
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  });
  res.json({ ok: true });
});

// ---------- Erreurs ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide' });
  if (/UNIQUE constraint/.test(err.message)) return res.status(409).json({ error: 'Ce nom existe déjà' });
  if (/FOREIGN KEY constraint/.test(err.message)) return res.status(400).json({ error: 'Référence invalide' });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
}
app.use(errorHandler);

// Démarre une application ; si le port est déjà pris (ancien serveur encore ouvert), on arrête tout
// avec un message clair, plutôt que de laisser tourner une moitié du logiciel.
function start(application, port, lines) {
  application.listen(port, (err) => {
    if (err) {
      console.error(`\nERREUR : le port ${port} est déjà utilisé par un autre programme.`);
      console.error('Fermez ce programme, ou lancez SweetLab sur d’autres ports : PORT=4000 PUBLIC_PORT=4001 npm start\n');
      process.exit(1);
    }
    lines.forEach((l) => console.log(l));
  });
}

start(app, PORT, [`SweetLab caisse + gérant : http://localhost:${PORT}`]);

// ---------- Application Fidélité (port 3001) ----------
// Uniquement les pages des CLIENTS : saisie du prénom + numéro (via le QR code) et carte de fidélité.
// Aucune connexion du personnel ici : toute la gestion se fait dans l'onglet Clients du gérant (port 3000).

const loyaltyApp = express();
loyaltyApp.set('trust proxy', true);
loyaltyApp.use(express.json());
const sendPublic = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
loyaltyApp.get('/css/app.css', sendPublic('css/app.css'));
loyaltyApp.get('/js/common.js', sendPublic('js/common.js'));
// Logo et police du logo pour les pages client.
loyaltyApp.get('/img/logo.jpg', sendPublic('img/logo.jpg'));
loyaltyApp.get('/img/flask.svg', sendPublic('img/flask.svg'));
loyaltyApp.get('/fonts/fredoka-latin-600-normal.woff2', sendPublic('fonts/fredoka-latin-600-normal.woff2'));
loyaltyApp.get('/fonts/fredoka-latin-700-normal.woff2', sendPublic('fonts/fredoka-latin-700-normal.woff2'));
loyaltyApp.use(pub);
loyaltyApp.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));
loyaltyApp.use((req, res) => res.status(404).type('html').send(NOT_FOUND_PAGE));
loyaltyApp.use(errorHandler);

const NOT_FOUND_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SweetLab</title><link rel="stylesheet" href="/css/app.css"></head><body class="client-page"><main class="client">
<div class="client-brand">SweetLab</div><div class="card client-hero"><h1>Carte de fidélité</h1>
<p class="muted">Scannez le QR code affiché au comptoir pour créer ou ouvrir votre carte.</p></div>
<div class="shop-links" data-shop-links></div></main><script src="/js/common.js"></script></body></html>`;

start(loyaltyApp, PUBLIC_PORT, [
  `SweetLab fidélité client : http://localhost:${PUBLIC_PORT}  (port à transférer en public)`,
]);
