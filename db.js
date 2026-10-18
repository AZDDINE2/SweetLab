const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// En ligne (Railway), les données vont sur le disque permanent (volume) ; sinon dans ./data.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'sweetlab.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('gerant', 'caisse')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active      INTEGER NOT NULL DEFAULT 1
);

-- Quantité mise en vente par le gérant pour une journée donnée.
-- Le restant = quantity - ventes validées de la journée (calculé, jamais stocké).
CREATE TABLE IF NOT EXISTS daily_stock (
  date       TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (date, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  cashier_id   INTEGER NOT NULL REFERENCES users(id),
  total_cents  INTEGER NOT NULL,
  paid_cents   INTEGER,
  status       TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'annulee')),
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  product_name     TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

-- Fidélité
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL UNIQUE,
  token        TEXT NOT NULL UNIQUE,  -- secret contenu dans le QR de la carte
  stamps       INTEGER NOT NULL DEFAULT 0,
  rewards_used INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loyalty_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_id    INTEGER REFERENCES orders(id),
  type        TEXT NOT NULL CHECK (type IN ('gain', 'recompense', 'annulation', 'ajustement')),
  stamps      INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_customer ON loyalty_events(customer_id);

-- Fond de caisse : une ligne par journée (ouverture + clôture)
CREATE TABLE IF NOT EXISTS cash_days (
  date          TEXT PRIMARY KEY,
  opening_cents INTEGER NOT NULL CHECK (opening_cents >= 0),
  opened_at     TEXT NOT NULL,
  opened_by     INTEGER REFERENCES users(id),
  counted_cents INTEGER,            -- espèces comptées à la clôture
  expected_cents INTEGER,           -- espèces attendues au moment de la clôture
  closed_at     TEXT,
  closed_by     INTEGER REFERENCES users(id),
  note          TEXT
);

`);

// Ajoute une colonne aux bases déjà créées par une version précédente.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
}

addColumn('orders', 'customer_id', 'INTEGER REFERENCES customers(id)');
addColumn('orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'stamps_earned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'reward_stamps', 'INTEGER NOT NULL DEFAULT 0');
// Seules les catégories "fidélité" rapportent des tampons (les boissons non, par défaut).
if (addColumn('categories', 'loyalty', 'INTEGER NOT NULL DEFAULT 1')) {
  db.prepare(`UPDATE categories SET loyalty = 0 WHERE name LIKE 'Boisson%'`).run();
}

// ---------- Vente : parts / moules, suppléments, sur place / à emporter ----------
// Un "flan" se vend à la part ou au moule entier (1 moule = 8 parts). Le stock est compté en parts.
// is_flan = suppléments possibles + emballage à emporter compté.
addColumn('products', 'mold_price_cents', 'INTEGER'); // prix du moule entier (NULL = pas vendu au moule)
if (addColumn('products', 'is_flan', 'INTEGER NOT NULL DEFAULT 1')) {
  db.prepare(`UPDATE products SET is_flan = 0 WHERE category_id IN (SELECT id FROM categories WHERE name LIKE 'Boisson%')`).run();
}

addColumn('order_items', 'format', `TEXT NOT NULL DEFAULT 'part'`);      // 'part' ou 'moule'
if (addColumn('order_items', 'parts', 'INTEGER')) {                       // parts retirées du stock
  db.prepare('UPDATE order_items SET parts = quantity WHERE parts IS NULL').run();
}
addColumn('order_items', 'toppings', 'TEXT');                             // suppléments (noms, JSON)
addColumn('order_items', 'toppings_cents', 'INTEGER NOT NULL DEFAULT 0'); // prix des suppléments, par unité
if (addColumn('order_items', 'line_total_cents', 'INTEGER')) {
  db.prepare('UPDATE order_items SET line_total_cents = quantity * unit_price_cents WHERE line_total_cents IS NULL').run();
}

addColumn('orders', 'mode', `TEXT NOT NULL DEFAULT 'sur_place'`);        // 'sur_place', 'emporter' ou 'mixte'
addColumn('order_items', 'place', 'TEXT');                                // 'sur_place' ou 'emporter' (moule : toujours emporter)
addColumn('orders', 'packaging_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'packaging_cents', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'molds_count', 'INTEGER NOT NULL DEFAULT 0');         // moules entiers vendus
addColumn('orders', 'molds_returned', 'INTEGER NOT NULL DEFAULT 0');      // moules rapportés par le client
addColumn('orders', 'mold_deposit_cents', 'INTEGER NOT NULL DEFAULT 0');  // consigne encaissée
addColumn('orders', 'note', 'TEXT');                                       // note libre saisie à la caisse

db.exec(`
CREATE TABLE IF NOT EXISTS toppings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active      INTEGER NOT NULL DEFAULT 1
);

-- Stock de préparation (cuisine), en parts : la production y entre, la mise en vente en sort.
CREATE TABLE IF NOT EXISTS prep_stock (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  parts      INTEGER NOT NULL DEFAULT 0
);

-- Historique des mouvements de stock (production, mise en vente, corrections).
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind       TEXT NOT NULL CHECK (kind IN ('production', 'mise_en_vente', 'correction_preparation', 'correction_vente')),
  parts      INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  user_id    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_stock_moves_date ON stock_moves(date);

-- Emballages mis à disposition par le gérant, par journée.
CREATE TABLE IF NOT EXISTS packaging_days (
  date     TEXT PRIMARY KEY,
  quantity INTEGER NOT NULL CHECK (quantity >= 0)
);

-- ---------- Matières premières et factures ----------
CREATE TABLE IF NOT EXISTS raw_materials (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  unit             TEXT NOT NULL DEFAULT 'unité',
  quantity         REAL NOT NULL DEFAULT 0,
  last_price_cents INTEGER,             -- dernier prix unitaire payé
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier     TEXT,
  invoice_date TEXT,
  total_cents  INTEGER NOT NULL DEFAULT 0,
  photo        TEXT,                    -- fichier dans data/factures/
  source       TEXT NOT NULL DEFAULT 'manuel', -- 'ia' ou 'manuel'
  created_at   TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id),
  raw_material_id  INTEGER REFERENCES raw_materials(id),
  name             TEXT NOT NULL,
  quantity         REAL NOT NULL,
  unit             TEXT NOT NULL DEFAULT 'unité',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

-- Mouvements des matières premières (facture, utilisation, correction).
CREATE TABLE IF NOT EXISTS raw_moves (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_material_id INTEGER NOT NULL REFERENCES raw_materials(id),
  kind            TEXT NOT NULL CHECK (kind IN ('facture', 'utilisation', 'correction', 'annulation_facture')),
  quantity        REAL NOT NULL,
  invoice_id      INTEGER REFERENCES invoices(id),
  created_at      TEXT NOT NULL,
  user_id         INTEGER REFERENCES users(id)
);
`);

// Deux sortes d'emballages déclarés chaque jour : pour les parts (quantity) et pour les moules entiers (mold_quantity).
addColumn('packaging_days', 'mold_quantity', 'INTEGER NOT NULL DEFAULT 0');
addColumn('invoices', 'pdf', 'TEXT'); // facture importée en PDF : fichier dans data/factures/

// Comptage de fin de journée : ce qui reste vraiment dans le stock de vente (en parts) et en emballages,
// comparé à ce qui devrait rester (« attendu ») au moment du comptage.
db.exec(`
CREATE TABLE IF NOT EXISTS stock_counts (
  date           TEXT NOT NULL,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  expected_parts INTEGER NOT NULL,
  counted_parts  INTEGER NOT NULL CHECK (counted_parts >= 0),
  created_at     TEXT NOT NULL,
  user_id        INTEGER REFERENCES users(id),
  PRIMARY KEY (date, product_id)
);
-- Alertes envoyées au gérant (ex. la caisse signale que les emballages des parts sont terminés).
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  times       INTEGER NOT NULL DEFAULT 1,   -- signalée plusieurs fois avant d'être traitée
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  resolved_at TEXT                          -- traitée par le gérant (ou emballages ajoutés)
);
CREATE TABLE IF NOT EXISTS packaging_counts (
  date       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('part', 'moule')),
  expected   INTEGER NOT NULL,
  counted    INTEGER NOT NULL CHECK (counted >= 0),
  created_at TEXT NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  PRIMARY KEY (date, kind)
);
`);

// Suppléments proposés au départ (modifiables par le gérant).
if (db.prepare('SELECT COUNT(*) AS n FROM toppings').get().n === 0) {
  const insertTopping = db.prepare('INSERT INTO toppings (name, price_cents) VALUES (?, ?)');
  for (const [name, price] of [['Sauce blanche', 300], ['Sauce Nutella', 500], ['Sauce rouge', 300], ['Feuilletine', 200],
    ['Cornflakes', 200], ['Pépites de chocolat', 200], ['Fruits secs', 200]]) insertTopping.run(name, price);
}

const DEFAULT_SETTINGS = {
  stamps_required: '10',
  reward_label: '1 quesillo offert',
  join_key: () => crypto.randomBytes(12).toString('hex'),
  public_url: '',
  packaging_price_cents: '200',  // prix d'un emballage à emporter
  mold_deposit_cents: '2000',    // prix de l'emballage d'un moule entier (sauf si le client rapporte son ancien moule)
  anthropic_api_key: '',         // clé pour la lecture automatique des factures
  // Ticket de caisse
  shop_phone: '0660380767',
  shop_address: '',
  shop_instagram: '@sweetlab_212',
  ticket_footer: 'Merci de votre visite !',
  ticket_width: '80',            // largeur du papier en mm : 80 ou 58
  ticket_print_default: '0',     // « Imprimer le ticket » coché par défaut à la caisse
};
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, typeof value === 'function' ? value() : value);
}
// L'ancien prix par défaut du moule (50 DH) devient le prix de l'emballage moule : 20 DH.
db.prepare(`UPDATE settings SET value = '2000' WHERE key = 'mold_deposit_cents' AND value = '5000'`).run();

function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Données de départ : comptes par défaut et un catalogue d'exemple que le gérant pourra modifier.
function seed() {
  const { n: userCount } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (userCount === 0) {
    const insertUser = db.prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)');
    insertUser.run('gerant', 'Gérant', 'gerant', hashPassword('gerant123'));
    insertUser.run('caisse', 'Caisse 1', 'caisse', hashPassword('caisse123'));
    console.log('Comptes créés : gerant / gerant123  et  caisse / caisse123  (à changer !)');
  }

  const { n: catCount } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (catCount === 0) {
    const insertCat = db.prepare('INSERT INTO categories (name, loyalty) VALUES (?, ?)');
    const insertProduct = db.prepare('INSERT INTO products (name, category_id, price_cents, is_flan) VALUES (?, ?, ?, ?)');
    const catalogue = [
      ['Quesillo - Part', [['Quesillo classique', 2000], ['Quesillo coco', 2500], ['Quesillo café', 2500], ['Quesillo chocolat', 2500]]],
      ['Quesillo - Entier', [['Quesillo entier classique', 15000], ['Quesillo entier coco', 18000]]],
      ['Boissons', [['Café', 1000], ['Eau', 500]]],
    ];
    tx(() => {
      catalogue.forEach(([catName, products]) => {
        const catId = Number(insertCat.run(catName, catName === 'Boissons' ? 0 : 1).lastInsertRowid);
        for (const [name, price] of products) insertProduct.run(name, catId, price, catName === 'Boissons' ? 0 : 1);
      });
    });
  }
}
seed();

module.exports = { db, tx, hashPassword, verifyPassword, getSettings, setSetting, DATA_DIR };
