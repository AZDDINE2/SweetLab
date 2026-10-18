# SweetLab — Caisse & gestion de stock

Système de caisse pour la vente de quesillos (flan vénézuélien), avec deux rôles :

- **Gérant** : récap de la journée (nombre de ventes, chiffre d'affaires, panier moyen, ventes par produit / catégorie / heure / caissier, 7 derniers jours), gestion du stock du jour, liste des ventes avec annulation, produits, catégories et utilisateurs. Il a aussi accès à la caisse.
- **Caisse** : saisie des commandes clients ; chaque vente diminue le stock disponible de la journée. Calcul de la monnaie à rendre.

## Démarrer

Prérequis : Node.js 22.13 ou plus récent (SQLite est inclus dans Node, rien d'autre à installer).

```bash
npm install
npm start
```

Ouvrir http://localhost:3000

`npm start` arrête automatiquement un ancien serveur SweetLab encore ouvert (script `scripts/free-ports.js`). Un port utilisé par un autre programme n'est jamais coupé.

Deux adresses sont lancées :

| Port | Pour qui | Contenu |
|------|----------|---------|
| `3000` | Caisse et gérant | Ventes, stock, récap, produits, équipe, et **gestion de la fidélité** (onglet *Clients*). À garder privé. |
| `3001` | Clients uniquement | Page de fidélité : prénom + numéro, puis la carte. Aucune connexion du personnel. C'est **ce port** qu'on transfère en public. |

Comptes créés au premier lancement (**à changer** dans l'onglet Utilisateurs) :

| Rôle   | Identifiant | Mot de passe |
|--------|-------------|--------------|
| Gérant | `gerant`    | `gerant123`  |
| Caisse | `caisse`    | `caisse123`  |

Pour utiliser la caisse depuis une tablette ou un autre PC du même réseau : `http://<adresse-IP-du-PC>:3000`.

## Mise en ligne (Railway, depuis GitHub)

SweetLab peut tourner en ligne, sans le PC du magasin. Railway lance le serveur à partir du dépôt GitHub et le met à jour à chaque `git push`.

1. Sur [railway.com](https://railway.com) : **New Project → Deploy from GitHub repo →** choisir `SweetLab`. Le fichier `railway.json` donne la commande de démarrage ; Node 22.13+ est demandé par `package.json`.
2. Dans le service : **+ New → Volume** (ou clic droit → *Attach volume*), point de montage **`/data`**. Railway fournit alors `RAILWAY_VOLUME_MOUNT_PATH` : la base de données, les factures et les données de lecture y sont gardées (rien n'est perdu aux redémarrages et mises à jour).
3. **Settings → Networking → Generate Domain** : une adresse du type `https://sweetlab-production.up.railway.app`.
4. Ouvrir l'adresse, se connecter (`gerant` / `gerant123`) et **changer tout de suite les mots de passe** des deux comptes (onglet *Équipe*).

En ligne, il n'y a qu'une adresse :

| Adresse | Pour qui |
|---|---|
| `https://…up.railway.app/` | Caisse et gérant (connexion) |
| `https://…up.railway.app/fidelite` | Clients : carte de fidélité (adresse à mettre dans le QR code) |

Sur le PC du magasin (`npm start`), rien ne change : caisse/gérant sur le port 3000, fidélité sur le port 3001.
Le mode « une seule adresse » s'active tout seul sur Railway (ou avec la variable `SINGLE_PORT=1`).

## Fonctionnement du stock

- Le stock est **par journée** : chaque matin, le gérant indique combien de pièces de chaque produit sont mises en vente (onglet *Stock du jour*).
- « Ajouter » augmente la quantité (nouvelle fournée), « Corriger » remplace la quantité totale.
- Le restant = mis en vente − vendus. Une commande annulée remet automatiquement les produits en stock.
- Une vente est refusée si le stock restant est insuffisant (vérifié côté serveur, même avec plusieurs caisses).

## Vente : parts, moules, suppléments, sur place / à emporter

- Un **produit en moule** (case « En moule » : quesillos, et tout gâteau préparé en moules de 8 parts) se vend à la **part** ou au **moule entier (8 parts)**. Le stock est compté en parts et affiché en « moules + parts ».
- **Note de commande** : à l’encaissement, le caissier peut écrire une note (« sans sauce », « au nom de Sara », « à récupérer à 18h »…) ; elle s’affiche avec la commande dans *Ventes*.
- En caisse, toucher un produit en moule ouvre le choix **Part / Moule**, **Sur place / À emporter** (obligatoire pour chaque part), les **suppléments** (sauces, feuilletine…) et la quantité. Un **moule entier est toujours à emporter**. Une même commande peut mélanger des parts sur place et à emporter (affichée « Sur place + à emporter » dans *Ventes*).
- On prépare des **moules** : **1 moule = 8 parts**. Chaque moule se vend entier ou à la part (les parts vendues sont retirées du moule).
- **Deux emballages** :
  - **emballage part (2 DH)** : 1 par part, seulement **à emporter** ;
  - **emballage moule (20 DH)** : livré automatiquement avec chaque moule entier (pas de stock à déclarer), facturé sauf si le client rapporte son ancien moule (compteur « moules rapportés »).
- Les deux stocks d'emballages et leurs prix se gèrent dans l'onglet *Stock*.
- Réglages dans *Produits* : prix de la part et du moule, case « En moule », suppléments. Sans cette case (boissons…), le produit se compte à l’unité et s’ajoute en caisse d’un seul toucher.

## Stock (gérant, onglet *Stock*)

- Deux stocks séparés :
  - **Stock de préparation** (cuisine) : **+ Production** ajoute des moules ; **Corriger** ajuste après un comptage ou une perte.
  - **Stock de vente** (du jour) : le matin, **Définir** fixe le **stock d'ouverture** (ex. 3 moules) sans toucher à la préparation. Ensuite, il se remplit **uniquement** par **Mettre en vente**, qui retire de la préparation (1 moule mis en vente = −1 moule en préparation), par moules entiers pour les produits en moule. Le transfert inverse (vente → préparation) est impossible. Les ventes de la caisse le diminuent.
- Chaque mouvement est enregistré (*Mouvements du jour*).
- **Comptage de fin de journée** : à la fermeture, le gérant saisit ce qui reste vraiment dans le stock de vente (moules + parts, ou unités) et les emballages restants. L’écart avec ce qui devrait rester (stock de vente − ventes) s’affiche en direct (« Juste », « Manque 1 part », « En plus… ») ; le comptage enregistré résume ce qui reste et les écarts.
- **Emballages du jour** : le gérant déclare combien d'emballages **parts** il met à disposition ; les ventes à emporter les décomptent. L'emballage moule part avec chaque moule, sans stock à déclarer.
- **Emballages terminés** : la caisse n'est jamais bloquée. Le caissier appuie sur **Emballages terminés** (bouton en haut, rouge quand le stock déclaré est épuisé, ou « Prévenir le gérant » à l'encaissement) : le gérant reçoit une **alerte** (cloche avec compteur + message). Elle se ferme avec « C'est noté », ou toute seule quand le gérant ajoute des emballages. Les **prix** des deux emballages se règlent au même endroit.

## Ticket de caisse

- À l’encaissement, la case **Imprimer le ticket** (retenue sur chaque appareil) imprime le ticket dès la validation. Le badge des ventes en haut de la caisse ouvre **Mes ventes du jour** pour réimprimer un ticket ; le gérant peut aussi réimprimer depuis *Ventes* (icône imprimante).
- Le ticket : logo, SweetLab, téléphone (0660380767), adresse, Instagram, n° et heure, caissier, sur place / à emporter, articles avec options et suppléments, emballages, total, note, message de fin.
- Réglages dans *Équipe → Ticket de caisse* : téléphone, adresse, Instagram, message, largeur du papier (**80 mm** ou **58 mm**), case cochée par défaut, aperçu en direct et impression d’un exemple.
- Imprimante à tickets : la choisir dans la fenêtre d’impression du navigateur (marges : aucune). Astuce : lancer Chrome/Edge avec l’option `--kiosk-printing` imprime directement sur l’imprimante par défaut, sans fenêtre.

## Matières premières et factures (gérant, onglet *Matières*)

- **Facture en PDF** (*Importer une photo ou un PDF*) : le texte du PDF est lu **tel quel**, sans erreur de lecture (factures françaises et bons arabes). Un PDF scanné (sans texte) est lu comme une photo (1re page). Le PDF est gardé avec la facture (*Ouvrir le PDF* dans le détail). pdf.js (`pdfjs-dist`) est servi sous `/vendor/pdfjs`.
- **Prendre en photo** ou **Importer une photo** d'une facture : elle est lue automatiquement (fournisseur, date, total, lignes avec quantités et prix). Le gérant vérifie puis enregistre : chaque ligne s'ajoute au stock de matières premières avec son prix.
- **Deux modes de lecture**, choisis automatiquement :
  - **IA Claude** si une **clé API Anthropic** est enregistrée par le développeur (`npm run outils -- cle sk-ant-...`, voir plus bas) : la plus précise (factures manuscrites, photos moyennes) ;
  - sinon **lecture gratuite sur le PC** (Tesseract, sans Internet) : bien pour les factures imprimées, à vérifier davantage. Ses données de langue sont dans `data/ocr`.
    - La photo est préparée dans le navigateur (éclairage égalisé, ombres retirées, noir et blanc, traits du tableau effacés).
    - Factures françaises (Article | Qté | P.U | Montant) et bons arabes (Montant | Prix | Article | Unité | Quantité) ; chaque ligne est retrouvée par quantité × prix = montant (code dans `invoice-parse.js`).
    - Si la somme des lignes ne tombe pas sur le total imprimé, un **écart** est signalé : une ligne est mal lue.
    - **Apprentissage** (`ocr-memory.js`) : à chaque facture enregistrée, le système retient « nom lu » → « nom, unité et prix validés par le gérant ». À la lecture suivante, une ligne lue pareil (ou presque, ou qui contient un nom déjà validé au même prix) est corrigée toute seule, sans rien afficher au gérant. Les mots des noms validés enrichissent aussi la correction d'orthographe.
    - **Deux préparations de la photo** (agrandie 3000 px et contrastée, ou réglage d'origine 2400 px) : la 2e n'est lue que si la 1re n'est pas parfaite, et le serveur garde celle où le plus de lignes tombent juste (quantité × prix = montant) et dont la somme est la plus proche du total. Un petit écart expliqué par une seule ligne (« 36,40 » au lieu de « 36,00 ») est corrigé automatiquement.
    - **Lecture colonne par colonne** (`invoice-table.js`) : les en-têtes du tableau sont repérés (العدد | الوحدة | نوع البضاعة | الثمن | الواجب, ou Désignation | Qté | Unité | P.U | Montant), puis chaque mot est rangé dans sa case (colonne × ligne). Une case vide, ou une ligne où quantité × prix ≠ montant, est relue seule. Cette lecture est gardée quand elle est au moins aussi juste que la lecture ligne par ligne.
    - **Arabe → français** (`arabic-fr.js`) : sur une facture arabe, une 2e lecture en arabe donne l'**unité** (كلغ → kg, وحدة → pièce, باكية → paquet…) et le **nom traduit** avec un dictionnaire de la pâtisserie (كليكوز 4ك → glucose 4kg, معالق صغار → petites cuillères, ليكات سوداء → gants noirs…). Un mot inconnu n'est pas inventé : on garde alors le nom lu en français. Pour ajouter un mot, compléter `WORDS` ou `UNITS` dans `arabic-fr.js`.
    - Les fautes de frappe courantes sont corrigées (« levuer » → « levure », « plastuque » → « plastique »).
- Liste des factures avec le détail de chacune (lignes, prix, photo). Supprimer une facture retire ses quantités du stock.
- *Utiliser* / *Corriger* pour mettre à jour le stock de matières premières ; **✕** supprime une matière, **Tout supprimer** vide le stock (les factures sont gardées).
- **Unités** lues sur la facture : colonne en français (Kg, L, Pcs, Ctn, Bte, Plateau…), quantité avec unité (« 12 kg ») ou colonne en arabe (كلغ → kg, وحدة → pièce = une seule pièce, باكية → paquet ; الوحدة n'est que le titre de la colonne). Sinon « unité », à corriger.

## Fond de caisse (gérant, onglet *Fond*)

- **Ouverture** : le gérant saisit le fond de caisse du matin.
- **Espèces attendues** = fond initial + ventes du jour (toutes les ventes sont considérées payées en espèces).
- **Clôture** : comptage par billets et pièces (ou total direct), écart affiché (juste / manque / surplus). Une journée clôturée peut être rouverte pour corriger.

## Fidélité

- **Règle** : 1 visite = 1 tampon, **une fois par jour**. 10 visites = 1 quesillo offert (réglable).
- **Client (port 3001)** : il scanne le QR code du comptoir, entre son prénom et son numéro. Chaque scan ouvre une nouvelle session de 2 minutes. Nouveau numéro : sa carte est créée. Numéro connu : sa carte s'ouvre. Dans les deux cas, sa visite du jour est comptée. Les majuscules et le format du numéro ne comptent pas (`0678707591` = `+212678707591`).
- **Sécurité** : 5 erreurs de prénom sur un numéro le bloquent 15 minutes. La carte s'affiche pendant 2 minutes maximum (bouton *Quitter*), puis la session se ferme.
- **Gérant (port 3000, onglet Clients)** : liste et recherche des clients, *+ Visite*, *Offrir la récompense*, corrections ±1, réglages, affiche QR (*Imprimer l'affiche* ou *Télécharger le QR code* en PNG). Les clients s'inscrivent eux-mêmes via le QR code.
- **QR code en image** : `npm run qr -- https://votre-adresse-3001` crée `qr-fidelite.png`.

## Structure

```
server.js              Deux applications Express : caisse/gérant (3000) et fidélité client (3001)
db.js                  Schéma SQLite + données de départ
scripts/qr.js          Génère le QR code de la fidélité (npm run qr)
scripts/free-ports.js  Arrête un ancien serveur SweetLab avant npm start
data/                  Base de données (sweetlab.db) — à sauvegarder régulièrement
public/                index.html (connexion), gerant.html, caisse.html (3000)
                       rejoindre.html, carte.html (3001)
```

Identité visuelle : logo dans `public/img/logo.jpg` (connexion, pages fidélité) et fiole `public/img/flask.svg` (barre du haut, icône d'onglet) ; couleurs du logo dans les variables `--brand-*` de `public/css/app.css` ; police des titres Fredoka dans `public/fonts` (marche sans Internet).

Les montants sont stockés en centimes ; la devise affichée (`DH`) se change dans `public/js/common.js`.

## Outils du développeur

La clé API et la mémoire d'apprentissage ne sont **pas visibles par le gérant** ; elles se gèrent sur le PC :

```bash
npm run outils                     # état : clé API, nombre de corrections apprises
npm run outils -- cle sk-ant-...   # enregistre la clé API Anthropic (lecture des factures par l'IA)
npm run outils -- cle-retirer      # retire la clé (lecture gratuite sur le PC)
npm run outils -- memoire          # liste les corrections apprises (« lu » -> nom validé)
npm run outils -- oublier "nom"    # efface les corrections qui mènent à ce nom
npm run outils -- oublier          # efface TOUTES les corrections apprises
```

Les changements comptent tout de suite, sans redémarrer le serveur.
