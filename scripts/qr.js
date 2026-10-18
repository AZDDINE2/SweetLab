// Génère le QR code d'inscription à la fidélité pour une adresse publique.
// Usage : npm run qr -- https://xxxx-3001.euw.devtunnels.ms
const path = require('path');
const QRCode = require('qrcode');
const { setSetting } = require('../db');

const url = String(process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https?:\/\/[^\s]+$/.test(url)) {
  console.error('Donnez l’adresse publique, ex. : npm run qr -- https://xxxx-3001.euw.devtunnels.ms');
  process.exit(1);
}

setSetting('public_url', url); // les QR affichés par l'espace gérant utiliseront aussi cette adresse
const joinUrl = `${url}/`; // espace client du port 3001
const out = path.join(__dirname, '..', 'qr-fidelite.png');

QRCode.toFile(out, joinUrl, { width: 800, margin: 2, color: { dark: '#45281d', light: '#ffffff' } })
  .then(() => {
    console.log(`Lien d'inscription : ${joinUrl}`);
    console.log(`QR code enregistré : ${out}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
