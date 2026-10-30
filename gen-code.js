/*! Clash AI — générateur de codes d'activation.
 *
 *  Par défaut, les codes sont ENREGISTRÉS SUR LE SERVEUR (activation-worker.js) : disponible
 *  immédiatement, utilisable UNE SEULE FOIS, et **aucun rebuild de l'application** n'est requis.
 *  Le journal local codes-activation.csv garde le texte clair (le serveur, lui, ne stocke qu'une
 *  empreinte salée) : c'est le seul endroit où récupérer un code perdu.
 *
 *  Usage :
 *    node gen-code.js                        -> 1 code Premium, enregistré sur le serveur
 *    node gen-code.js pack                   -> 1 code Pack
 *    node gen-code.js month 5                -> 5 codes Premium
 *    node gen-code.js pack 10                -> 10 codes Pack
 *    node gen-code.js --check CLASH-MOIS-…   -> état d'un code sur le serveur
 *    node gen-code.js --stats                -> codes restants/utilisés par plan
 *    node gen-code.js --code CLASH-MOIS-…    -> empreintes locales d'un code
 *    node gen-code.js month 5 --offline      -> mode historique : empreintes à coller dans
 *                                               index.html (codes réutilisables, rebuild requis)
 *
 *  Configuration :
 *    - URL du serveur : constante CODE_API de www/index.html ;
 *    - jeton admin    : variable CLASH_ADMIN_TOKEN, sinon fichier activation-admin-token.txt.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INDEX = path.join(ROOT, 'www', 'index.html');
const JOURNAL = path.join(ROOT, 'codes-activation.csv');
const TOKEN_FILE = path.join(ROOT, 'activation-admin-token.txt');

/* Alphabet sans caractères ambigus : ni I, ni L, ni O, ni 0, ni 1. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LABEL = { month: 'MOIS', pack: 'PACK' };
const PLAN_FR = { month: 'Premium · 1 mois', pack: 'Pack · 10 clashs' };

/* ------------------------------------------------------------------ empreintes (mode historique) */

function normalizeCode(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }
function looseCode(s) { return normalizeCode(s).replace(/[^A-Z0-9]/g, ''); }

function hashCodeWeak(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function sha256Hex(code) { return crypto.createHash('sha256').update(code, 'utf8').digest('hex'); }

/** Les deux empreintes d'un code, calculées sur sa forme resserrée. */
function empreintes(code) {
  const c = looseCode(code);
  return { normalized: c, sha256: sha256Hex(c), weak: 'w:' + hashCodeWeak(c) };
}

/* ------------------------------------------------------------------ génération */

function randomBlock(n) {
  const octets = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[octets[i] % ALPHABET.length];
  return s;
}

/** Code lisible : CLASH-MOIS-XXXX-XXXX (le serveur le reconnaît avec ou sans tirets). */
function makeCode(plan, len, groupe) {
  len = len || 8; groupe = groupe || 4;
  const label = LABEL[plan];
  if (!label) throw new Error('Plan inconnu : ' + plan);
  const corps = randomBlock(len);
  const blocs = [];
  for (let i = 0; i < corps.length; i += groupe) blocs.push(corps.slice(i, i + groupe));
  return 'CLASH-' + label + '-' + blocs.join('-');
}

/* ------------------------------------------------------------------ serveur */

function lireUrlServeur() {
  try {
    const html = fs.readFileSync(INDEX, 'utf8');
    const m = /const CODE_API = '([^']*)'/.exec(html);
    return (m && m[1]) ? m[1].replace(/\/+$/, '') : '';
  } catch (e) { return ''; }
}

function lireJetonAdmin() {
  if (process.env.CLASH_ADMIN_TOKEN) return process.env.CLASH_ADMIN_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

async function postServeur(chemin, corps, besoinAdmin) {
  const base = lireUrlServeur();
  if (!base) throw new Error('CODE_API vide dans www/index.html : aucun serveur configuré.');
  const entetes = { 'content-type': 'application/json' };
  if (besoinAdmin) {
    const t = lireJetonAdmin();
    if (!t) throw new Error('Jeton admin absent : définis CLASH_ADMIN_TOKEN ou crée ' + TOKEN_FILE);
    entetes['x-admin-token'] = t;
  }
  const r = await fetch(base + chemin, { method: 'POST', headers: entetes, body: JSON.stringify(corps) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('serveur ' + r.status + ' : ' + (j.error || 'réponse invalide'));
  return j;
}

/* ------------------------------------------------------------------ journal */

function ajouterAuJournal(lignes) {
  const entete = 'date;plan;code;sha256;weak;mode\n';
  const existe = fs.existsSync(JOURNAL);
  const corps = lignes.map((l) => [
    new Date().toISOString().slice(0, 19).replace('T', ' '),
    l.plan, l.code, l.sha256, l.weak, l.mode
  ].join(';')).join('\n') + '\n';
  fs.appendFileSync(JOURNAL, (existe ? '' : entete) + corps, 'utf8');
  return JOURNAL;
}

/* ------------------------------------------------------------------ affichage */

function afficher(codes, opts) {
  console.log('');
  codes.forEach((c) => console.log('    ' + c.code + '   (' + PLAN_FR[c.plan] + ')'));
  console.log('');
  if (opts.mode === 'serveur') {
    console.log('  ✅ Enregistrés sur le serveur : envoyez-les tels quels, SANS reconstruire l\'app.');
    console.log('     Chaque code ne fonctionnera qu\'une seule fois.');
  } else {
    console.log('  ⚠️  Mode hors ligne : colle ces lignes dans www/index.html puis recompile.');
    console.log('');
    console.log('  CODE_HASHES :');
    codes.forEach((c) => console.log("    '" + c.sha256 + "': '" + c.plan + "',"));
    console.log('  CODE_HASHES_WEAK :');
    codes.forEach((c) => console.log("    '" + c.weak + "': '" + c.plan + "',"));
  }
  console.log('');
}

/* ------------------------------------------------------------------ programme */

async function main(argv) {
  const args = argv.slice(2);

  if (args[0] === '--help' || args[0] === '-h') {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*!?/, ''));
    return 0;
  }

  if (args[0] === '--stats') {
    const base = lireUrlServeur();
    if (!base) { console.error('  CODE_API vide : aucun serveur configuré.'); return 1; }
    const t = lireJetonAdmin();
    if (!t) { console.error('  Jeton admin absent.'); return 1; }
    const r = await fetch(base + '/stats', { headers: { 'x-admin-token': t } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { console.error('  serveur ' + r.status + ' : ' + (j.error || '')); return 1; }
    console.log('');
    for (const plan of ['month', 'pack']) {
      const s = j.stats[plan] || { total: 0, used: 0 };
      console.log('  ' + PLAN_FR[plan].padEnd(20) + ' gagnés/utilisés : ' + s.used + ' / ' + s.total
        + '   (restants : ' + (s.total - s.used) + ')');
    }
    console.log('');
    return 0;
  }

  if (args[0] === '--check') {
    const code = args[1];
    if (!code) { console.error('  Usage : node gen-code.js --check <CODE>'); return 1; }
    const j = await postServeur('/status', { code }, true);
    if (!j.exists) { console.log('  INCONNU du serveur : ' + code); return 1; }
    console.log('  ' + j.code + ' — plan : ' + j.plan + ' — ' + (j.used ? 'DÉJÀ UTILISÉ' : 'disponible'));
    return 0;
  }

  if (args[0] === '--code') {
    const code = args[1];
    if (!code) { console.error('  Usage : node gen-code.js --code <CODE>'); return 1; }
    const e = empreintes(code);
    console.log('');
    console.log('  Code            : ' + code);
    console.log('  Forme resserrée : ' + e.normalized);
    console.log('  sha256          : ' + e.sha256);
    console.log('  weak            : ' + e.weak);
    console.log('');
    return 0;
  }

  const horsLigne = args.indexOf('--offline') !== -1;
  const positionnels = args.filter((a) => a.indexOf('--') !== 0);
  const plan = positionnels[0] || 'month';
  const nombre = Math.max(1, Math.min(500, parseInt(positionnels[1], 10) || 1));

  if (!LABEL[plan]) {
    console.error('  Plan inconnu : « ' + plan + ' ». Utilise « month » ou « pack ».');
    return 1;
  }

  const base = lireUrlServeur();
  if (!horsLigne && !base) {
    console.error('  Aucun serveur configuré (CODE_API vide) : utilise --offline.');
    return 1;
  }

  /* Unicité locale : on évite de reproduire un code déjà présent dans le journal. */
  const dejaVus = new Set();
  try {
    const l = fs.readFileSync(JOURNAL, 'utf8').trim().split(/\r?\n/).slice(1);
    l.filter(Boolean).forEach((x) => dejaVus.add(looseCode(x.split(';')[2])));
  } catch (e) {}

  const codes = [];
  let garde = 0;
  while (codes.length < nombre) {
    if (++garde > nombre * 100) throw new Error('Impossible de générer un code unique.');
    const code = makeCode(plan);
    const c = looseCode(code);
    if (dejaVus.has(c)) continue;
    dejaVus.add(c);
    codes.push({ code: code, plan: plan, sha256: empreintes(code).sha256, weak: empreintes(code).weak });
  }

  let mode = 'hors ligne';
  if (!horsLigne) {
    const j = await postServeur('/add', { plan: plan, codes: codes.map((c) => c.code) }, true);
    if (j.added !== codes.length) throw new Error('serveur : ' + j.added + '/' + codes.length + ' enregistrés.');
    mode = 'serveur';
  }
  codes.forEach((c) => { c.mode = mode; });

  afficher(codes, { mode: horsLigne ? 'hors ligne' : 'serveur' });
  const j = ajouterAuJournal(codes);
  console.log('  Journal (texte clair) : ' + j);
  console.log('  ⚠️  Sauvegarde ce fichier : les codes n\'existent nulle part ailleurs en clair.');
  console.log('');
  return 0;
}

module.exports = { normalizeCode, looseCode, hashCodeWeak, sha256Hex, empreintes, makeCode,
                   lireUrlServeur, lireJetonAdmin };

if (require.main === module) {
  /* On pose le code de sortie au lieu d'appeler process.exit() : sur Windows, tuer le processus
     alors que les sockets de fetch sont encore ouverts déclenche une assertion libuv. */
  main(process.argv)
    .then((c) => { process.exitCode = c; })
    .catch((e) => { console.error('  ERREUR : ' + e.message); process.exitCode = 1; });
}
