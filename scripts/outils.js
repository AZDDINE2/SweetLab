// Outils du développeur (pas visibles par le gérant) : clé API de lecture des factures et mémoire d'apprentissage.
//
//   npm run outils                     état : clé API, nombre de corrections apprises
//   npm run outils -- cle sk-ant-...   enregistre la clé API Anthropic (lecture des factures par l'IA)
//   npm run outils -- cle-retirer      retire la clé (retour à la lecture gratuite sur le PC)
//   npm run outils -- memoire          liste les corrections apprises
//   npm run outils -- oublier          efface toutes les corrections apprises
//   npm run outils -- oublier "nom"    efface les corrections qui mènent à ce nom

process.removeAllListeners('warning'); // pas d'avertissement « SQLite expérimental » dans la sortie
const { db, getSettings, setSetting } = require('../db');
const ocrMemory = require('../ocr-memory');

const [cmd = 'etat', arg] = process.argv.slice(2);

function etat() {
  const key = getSettings().anthropic_api_key;
  console.log('Clé API Anthropic :', key ? `enregistrée (…${key.slice(-4)})` : process.env.ANTHROPIC_API_KEY ? 'variable ANTHROPIC_API_KEY' : 'aucune (lecture gratuite sur le PC)');
  console.log('Corrections apprises :', ocrMemory.count());
}

switch (cmd) {
  case 'etat':
    etat();
    break;
  case 'cle': {
    const key = String(arg || '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
      console.error('Clé invalide : elle commence par sk-ant- (console.anthropic.com).');
      process.exit(1);
    }
    setSetting('anthropic_api_key', key);
    console.log('Clé enregistrée. Les prochaines factures seront lues par l’IA.');
    etat();
    break;
  }
  case 'cle-retirer':
    setSetting('anthropic_api_key', '');
    console.log('Clé retirée. Les factures sont lues gratuitement sur le PC.');
    break;
  case 'memoire': {
    const rows = db.prepare('SELECT read_key, name, unit, unit_price_cents, hits FROM ocr_memory ORDER BY name').all();
    if (!rows.length) console.log('Aucune correction apprise.');
    for (const r of rows) {
      const price = r.unit_price_cents != null ? ` · ${(r.unit_price_cents / 100).toFixed(2)} DH` : '';
      console.log(`« ${r.read_key} »  ->  ${r.name} (${r.unit}${price}) · vue ${r.hits} fois`);
    }
    break;
  }
  case 'oublier':
    if (arg) {
      const { changes } = db.prepare('DELETE FROM ocr_memory WHERE name = ? COLLATE NOCASE').run(arg);
      console.log(`${changes} correction(s) oubliée(s) pour « ${arg} ».`);
    } else {
      ocrMemory.clear();
      console.log('Toutes les corrections apprises sont oubliées.');
    }
    break;
  default:
    console.log('Commandes : etat | cle sk-ant-... | cle-retirer | memoire | oublier ["nom"]');
    process.exit(1);
}
