/*! Clash AI — parrainage v1.0.2
 *  Règles implémentées :
 *    1) 5 essais gratuits À VIE par appareil (gérés dans index.html, pas ici).
 *    2) Un ami qui installe ET ouvre l'application via ton lien te donne +1 essai.
 *    3) Le filleul reçoit aussi +1 essai, une seule fois par appareil, quel que soit le lien.
 *    4) Anti-abus : auto-parrainage refusé, un couple parrain/filleul ne compte qu'une fois,
 *       l'application doit rester ouverte quelques secondes, plafond quotidien par parrain.
 *
 *  Le crédit du PARRAIN est inter-device : il exige le petit backend fourni (referral-worker.js).
 *  Sans backend (mode local), seul le filleul reçoit son essai — le module le dit clairement
 *  au lieu de faire semblant.
 *
 *  Aucune dépendance externe. Testable sans réseau : voir test7.js.
 */
(function (root) {
  'use strict';

  var REF_RE = /^[A-Za-z0-9_-]{4,24}$/;
  var CREDITED_KEY = 'clash_ref_credited';   /* filleuls déjà crédités sur CET appareil */

  var deps = null;
  var cfg = { api: '', minOpenMs: 3000, maxPerDay: 5, myCode: '', deviceId: '' };
  var arrivalRef = null, arrivalAt = 0;

  /* ------------------------------------------------------------------ outils */

  function codeOf(url) {
    var m = String(url || '').match(/[?&]ref=([A-Za-z0-9_-]{1,24})/);
    return m ? m[1] : null;
  }

  /** Convertit une option numérique en respectant 0 comme valeur valide. */
  function num(v, defaut) {
    var n = parseFloat(v);
    return (typeof v === 'number' || (typeof v === 'string' && v !== '')) && !isNaN(n) ? n : defaut;
  }

  function configured() { return !!cfg.api; }

  function note(kind, html) { if (deps && deps.notice) deps.notice(kind, html); }

  function statsOf() {
    try { return (deps && deps.loadStats) ? (deps.loadStats() || {}) : {}; } catch (e) { return {}; }
  }
  function saveStats(o) { try { if (deps && deps.saveStats) deps.saveStats(o); } catch (e) {} }

  function grant(n) { if (deps && typeof deps.grantTrial === 'function') deps.grantTrial(n); }

  /* ------------------------------------------------------------------ règles pures */

  /**
   * Décide si une arrivée via un lien de parrainage compte.
   * Fonction pure : c'est elle qui porte l'anti-abus, et elle est testée ligne à ligne.
   * @param {{ref?:string, myCode?:string, deviceId?:string, double?:boolean,
   *          openMs?:number, dayCount?:number, minOpenMs?:number, maxPerDay?:number}} o
   */
  function shouldCount(o) {
    o = o || {};
    var minOpen = (o.minOpenMs == null ? cfg.minOpenMs : +o.minOpenMs);
    var maxDay = (o.maxPerDay == null ? cfg.maxPerDay : +o.maxPerDay);

    if (!o.ref) return { ok: false, reason: 'Aucun code de parrainage dans le lien.' };
    if (!REF_RE.test(String(o.ref))) return { ok: false, reason: 'Code de parrainage invalide.' };
    if (o.myCode && String(o.myCode).toLowerCase() === String(o.ref).toLowerCase()) {
      return { ok: false, reason: 'Auto-parrainage refusé : c\'est ton propre lien.' };
    }
    if (!o.deviceId) return { ok: false, reason: 'Appareil non identifié.' };
    if (o.double) return { ok: false, reason: 'Ce parrainage a déjà été compté sur cet appareil.' };
    /* « typeof ... !== number » et non « !o.openMs » : 0 est falsy en JS, et une arrivée
       traitée dans la même milliseconde que l'ouverture ne doit pas être rejetée. */
    if (typeof o.openMs !== 'number' || isNaN(o.openMs) || o.openMs < minOpen) {
      return { ok: false, reason: 'Ouverture trop courte : il faut vraiment ouvrir l\'application.' };
    }
    if ((+o.dayCount || 0) >= maxDay) {
      return { ok: false, reason: 'Plafond quotidien atteint pour ce parrain.' };
    }
    return { ok: true, reason: 'Arrivée validée.' };
  }

  /** Filleuls déjà validés qui n'ont pas encore été crédités sur cet appareil (idempotent). */
  function newComers(devices, already) {
    var seen = {};
    (already || []).forEach(function (d) { seen[d] = true; });
    return (devices || []).filter(function (d) { return !!d && !seen[d]; });
  }

  /* ------------------------------------------------------------------ cycle de vie */

  function init(options) {
    deps = options || {};
    cfg.api = String(deps.api || '').replace(/\/+$/, '');
    /* Comparaison explicite : 0 est une valeur légitime (aucun délai minimum) et ne doit
       pas être remplacé par la valeur par défaut, contrairement à ce que ferait « || ». */
    cfg.minOpenMs = num(deps.minOpenMs, 3000);
    cfg.maxPerDay = num(deps.maxPerDay, 5);
    cfg.myCode = deps.myCode || '';
    cfg.deviceId = deps.deviceId || '';
    /* on note l'heure d'ouverture tout de suite : c'est la preuve que l'app a bien été ouverte */
    try { arrivalRef = codeOf((root.location && root.location.href) || ''); } catch (e) { arrivalRef = null; }
    arrivalAt = nowMs();
    return api;
  }

  function nowMs() { return new Date().getTime(); }

  function pending() { return arrivalRef; }
  function openMs() { return arrivalAt ? (nowMs() - arrivalAt) : 0; }

  /** Traite l'arrivée du filleul : valide, crédite le filleul, prévient le backend pour le parrain. */
  function arrive() {
    var ref = arrivalRef;
    if (!ref) return Promise.resolve({ ok: false, reason: 'aucun lien de parrainage' });

    var stats = statsOf();
    var pairKey = ref + ':' + cfg.deviceId;
    var deja = !!(stats.refs_seen && stats.refs_seen[pairKey]);

    var verdict = shouldCount({
      ref: ref, myCode: cfg.myCode, deviceId: cfg.deviceId,
      double: deja, openMs: openMs()
    });

    if (!verdict.ok) {
      note('warn', 'ℹ️ Parrainage non compté : ' + verdict.reason);
      return Promise.resolve({ ok: false, reason: verdict.reason });
    }

    /* Le couple parrain/filleul est marqué AVANT toute récompense : un rechargement
       de la page ne peut donc pas le comptabiliser deux fois. */
    stats.refs_seen = stats.refs_seen || {};
    stats.refs_seen[pairKey] = nowMs();

    /* Bonus du filleul : une seule fois par appareil, même s'il arrive par plusieurs liens. */
    var bonus = stats.ref_bonus_taken ? 0 : 1;
    if (bonus) stats.ref_bonus_taken = true;
    saveStats(stats);
    if (bonus) grant(bonus);

    if (!configured()) {
      note('ok', '🎁 Bienvenue ! <b>+' + bonus + ' essai gratuit</b> grâce au lien de ton ami.' +
                 (bonus ? '' : ' (Tu avais déjà reçu ce bonus d\'arrivée.)') +
                 '<br><span style="opacity:.8">Le crédit du parrain s\'active une fois le backend de parrainage déployé (voir README).</span>');
      return Promise.resolve({ ok: true, counted: false, local: true, inviteeBonus: bonus });
    }

    var url = cfg.api + '/referral';
    return root.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: ref, deviceId: cfg.deviceId, ownRef: cfg.myCode })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.counted) {
        note('ok', '🎁 +' + bonus + ' essai pour toi, et <b>+1 crédité à ton ami</b>.');
      } else if (j && j.error === 'plafond quotidien') {
        note('warn', 'ℹ️ Ton ami a atteint son plafond de validations pour aujourd\'hui.');
      } else if (j && (j.reason === 'déjà compté' || j.counted === false)) {
        note('info', 'ℹ️ Ce parrainage avait déjà été compté.');
      } else {
        note('info', 'ℹ️ Arrivée enregistrée côté ton appareil ; le crédit du parrain sera confirmé par le serveur.');
      }
      return { ok: true, counted: !!(j && j.counted), inviteeBonus: bonus };
    })['catch'](function () {
      note('warn', '⚠️ Réseau indisponible : ton essai est acquis, le crédit du parrain sera repris au prochain lancement.');
      return { ok: true, counted: false, offline: true, inviteeBonus: bonus };
    });
  }

  /** Côté parrain : lit les filleuls validés et crédite ceux qui ne l'ont pas encore été. */
  function claimCredits() {
    if (!configured()) return Promise.resolve({ ok: false, configured: false, granted: 0 });
    var url = cfg.api + '/credits?code=' + encodeURIComponent(cfg.myCode);
    return root.fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.devices) return { ok: false, granted: 0 };
      var stats = statsOf();
      var deja = stats.ref_credited || [];
      var nouveaux = newComers(j.devices, deja);
      if (!nouveaux.length) return { ok: true, granted: 0, total: deja.length };
      grant(nouveaux.length);
      stats.ref_credited = deja.concat(nouveaux);
      saveStats(stats);
      return { ok: true, granted: nouveaux.length, total: stats.ref_credited.length };
    })['catch'](function () { return { ok: false, granted: 0, offline: true }; });
  }

  var api = {
    version: '1.0.2',
    init: init,
    codeOf: codeOf,
    configured: configured,
    shouldCount: shouldCount,
    newComers: newComers,
    pending: pending,
    openMs: openMs,
    arrive: arrive,
    claimCredits: claimCredits,
    /* crochets de test */
    _setDeps: function (d) { deps = d; },
    _cfg: function () { return cfg; },
    _ref: function () { return arrivalRef; }
  };

  root.ClashReferral = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
