/*! Clash AI — client Google Play Billing v1.0.3
 *  Pont entre l'interface web et le module natif « ClashBilling » (BillingManager + BillingPlugin).
 *  Chargé dans <head> AVANT le script principal, puis initialisé par
 *  ClashBilling.init({ ... }) avec les fonctions d'état de l'application.
 *  Aucune dépendance externe : ni framework, ni bundler, ni paquet npm.
 *
 *  Règle d'or appliquée ici : le droit est d'abord ENREGISTRÉ localement, et seulement
 *  ensuite l'achat est finalisé (acquitté / consommé). Un achat non finalisé est
 *  automatiquement remboursé par Google au bout de 3 jours : on ne finalise donc jamais
 *  un achat dont on n'a pas su garder la trace.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ constantes */

  /* Ces identifiants doivent exister À L'IDENTIQUE dans Play Console.
     Une seule lettre d'écart et la requête renvoie une liste vide. */
  var PRODUCTS = { month: 'clash_premium_month', pack: 'clash_pack_10' };

  var PLAN_OF = {};
  for (var k in PRODUCTS) {
    if (Object.prototype.hasOwnProperty.call(PRODUCTS, k)) PLAN_OF[PRODUCTS[k]] = k;
  }

  /* Prix de référence (DT) — le prix RÉELLEMENT facturé est fixé dans Play Console, pays par pays,
     sur le produit « clash_premium_month » (à configurer à 10 DT). Ces valeurs servent seulement à
     signaler que la fiche Play et l'application affichent bien le même montant. */
  var EXPECTED_DT = { month: 10, pack: 3 };

  var LEDGER_KEY = 'clash_ledger';   /* registre des orderId déjà crédités (anti double-crédit) */
  var LEDGER_MAX = 50;               /* on ne conserve que les 50 derniers achats */

  var STATE_PURCHASED = 1;           /* Purchase.PurchaseState.PURCHASED */
  var STATE_PENDING = 2;             /* Purchase.PurchaseState.PENDING   */

  /* Codes numériques renvoyés par la couche native (ex. « ACHAT_4 », « FLOW_5 », « QUERY_3 »,
     « SETUP_-1 »). Ils sont traduits au lieu d'être affichés bruts à l'utilisateur. */
  var RESPONSE_CODES = {
    '0': 'succès',
    '1': 'achat annulé par l\'utilisateur',
    '2': 'service temporairement indisponible',
    '3': 'facturation indisponible sur cet appareil ou ce compte',
    '4': 'produit déjà possédé',
    '5': 'paramètres développeur incorrects (produit ou applicationId non reconnu par Play Console)',
    '6': 'erreur interne de facturation',
    '7': 'produit indisponible : pas encore activé dans Play Console',
    '8': 'fonctionnalité non prise en charge par cette version de Google Play',
    '12': 'erreur réseau',
    '-1': 'service Google Play déconnecté',
    '-2': 'fonctionnalité non prise en charge',
    '-3': 'délai dépassé'
  };

  var deps = null;                   /* dépendances injectées par init() */
  var busy = false;                  /* un seul achat à la fois */
  var products = [];                 /* catalogue renvoyé par Play */
  var found = {};                    /* { month: {price,title,offerToken}, pack: {...} } */
  var lastError = null;
  var connected = false;

  /* ------------------------------------------------------------------ utilitaires */

  function say(kind, html) { if (deps && deps.notice) deps.notice(kind, html); }
  function changed() { if (deps && deps.onChange) deps.onChange(); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function readJSON(key) {
    try {
      var raw = root.localStorage ? root.localStorage.getItem(key) : null;
      return JSON.parse(raw || '{}') || {};
    } catch (e) { return {}; }
  }
  function writeJSON(key, obj) {
    try { if (root.localStorage) root.localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  /** Le natif renvoie ses listes en chaîne JSON : on l'accepte, tout comme un vrai tableau. */
  /**
   * Lit un prix localisé et renvoie un nombre de dinars, ou null si illisible.
   * Le dinar a trois décimales : « 10,000 DT » vaut 10 DT et non dix mille. Pour nos prix
   * (< 100 DT), une partie fractionnaire de 3 chiffres est donc traitée comme des millimes.
   */
  function parsePriceDT(txt) {
    if (!txt) return null;
    var m = String(txt).replace(/\s|\u00a0/g, '').match(/(\d+(?:[.,]\d{1,3})?)/);
    if (!m) return null;
    var brut = m[1];
    if (brut.indexOf('.') === -1 && brut.indexOf(',') === -1) return parseFloat(brut);
    var parts = brut.split(/[.,]/);
    if (parts.length === 2 && parts[1].length === 3 && parseInt(parts[0], 10) <= 100) {
      return parseFloat(parts[0] + '.' + parts[1]);
    }
    return parseFloat(parts.join(''));
  }

  function parseList(v) {
    if (!v) return null;
    if (typeof v === 'string') {
      try { var a = JSON.parse(v); return Object.prototype.toString.call(a) === '[object Array]' ? a : null; }
      catch (e) { return null; }
    }
    return Object.prototype.toString.call(v) === '[object Array]' ? v : null;
  }
  function achatsDe(res) { return parseList(res && res.purchasesJson) || parseList(res && res.purchases) || []; }
  function produitsDe(res) { return parseList(res && res.productsJson) || parseList(res && res.products) || []; }

  /* ------------------------------------------------------------------ registre */

  function loadLedger() {
    var l = readJSON(LEDGER_KEY);
    if (!l.orders || typeof l.orders !== 'object') l.orders = {};
    return l;
  }
  function saveLedger(l) { writeJSON(LEDGER_KEY, l); }

  /** true si cet orderId a déjà donné lieu à un crédit sur cet appareil. */
  function alreadyGranted(orderId) {
    if (!orderId) return false;
    return !!loadLedger().orders[orderId];
  }

  /** Enregistre l'orderId, en ne gardant que les LEDGER_MAX plus récents. */
  function markGranted(orderId, plan, at) {
    if (!orderId) return;
    var l = loadLedger();
    l.orders[orderId] = { plan: plan, at: (typeof at === 'number' && !isNaN(at)) ? at : Date.now() };
    var ids = Object.keys(l.orders);
    if (ids.length > LEDGER_MAX) {
      ids.sort(function (a, b) { return (l.orders[a].at || 0) - (l.orders[b].at || 0); });
      ids.slice(0, ids.length - LEDGER_MAX).forEach(function (id) { delete l.orders[id]; });
    }
    saveLedger(l);
  }

  /* ------------------------------------------------------------------ droits (purs, testables) */

  /**
   * Accorde un abonnement jusqu'à `until`. Ne RACCOURCIT JAMAIS un abonnement en cours :
   * une restauration ne peut donc pas amputer la date d'expiration déjà enregistrée.
   */
  function grantPremiumUntil(rawStock, until, now, planId) {
    var o = {};
    try { o = JSON.parse(rawStock || '{}') || {}; } catch (e) { o = {}; }
    var t = now || Date.now();
    var current = (o.premium && o.premium.until) || 0;
    o.premium = {
      plan: planId || 'month',
      until: Math.max(current, until || 0),
      since: (o.premium && o.premium.since) || t,
      src: 'google'
    };
    o.day = o.day || new Date(t).toISOString().slice(0, 10);
    o.used = +o.used || 0;
    o.total = +o.total || 0;
    o.credits = Math.max(0, +o.credits || 0);
    return JSON.stringify(o);
  }

  /** Ajoute des crédits de clash (produit consommable). */
  function grantCredits(rawStock, n, now) {
    var o = {};
    try { o = JSON.parse(rawStock || '{}') || {}; } catch (e) { o = {}; }
    var t = now || Date.now();
    o.day = o.day || new Date(t).toISOString().slice(0, 10);
    o.used = +o.used || 0;
    o.total = +o.total || 0;
    o.credits = Math.max(0, (+o.credits || 0) + (+n || 0));
    return JSON.stringify(o);
  }

  /* ------------------------------------------------------------------ pont natif */

  function nativeBridge() {
    try {
      if (root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.ClashBilling) {
        return root.Capacitor.Plugins.ClashBilling;
      }
    } catch (e) {}
    return null;
  }

  /** Disponible seulement dans l'app Android, quand le plugin natif est enregistré. */
  function available() { return !!nativeBridge(); }

  /* ------------------------------------------------------------------ catalogue */

  function load() {
    var b = nativeBridge();
    if (!b) { lastError = 'PONT_ABSENT'; return Promise.resolve({ ok: false, products: [] }); }
    return b.getProducts().then(function (res) {
      connected = true;
      lastError = null;
      products = produitsDe(res);
      found = {};
      products.forEach(function (p) {
        var plan = PLAN_OF[p.productId];
        if (!plan) return;
        var prix = parsePriceDT(p.price);
        found[plan] = {
          price: p.price || '',
          title: p.title || '',
          offerToken: !!p.hasOfferToken,
          priceDT: prix,
          expectedDT: EXPECTED_DT[plan],
          /* true = la fiche Play n'affiche pas le montant attendu : à corriger dans Play Console */
          mismatch: (prix !== null && EXPECTED_DT[plan] != null && prix !== EXPECTED_DT[plan])
        };
      });
      changed();
      return { ok: true, products: products, found: found,
               premiumPurchasable: !!(res && res.premiumPurchasable), packPurchasable: !!(res && res.packPurchasable) };
    })['catch'](function (e) {
      lastError = (e && e.code) || 'CATALOGUE';
      connected = false;
      return { ok: false, error: humanError(e), products: [] };
    });
  }

  /* ------------------------------------------------------------------ achat */

  function buy(planId) {
    var productId = PRODUCTS[planId];
    if (!productId) { say('err', '❌ Offre inconnue : ' + esc(planId)); return Promise.resolve({ ok: false }); }

    var b = nativeBridge();
    if (!b) {
      say('err', '❌ Le module de facturation natif n\'est pas disponible dans ce paquet.');
      return Promise.resolve({ ok: false });
    }
    if (busy) { say('info', '⏳ Un achat est déjà en cours…'); return Promise.resolve({ ok: false }); }

    busy = true;
    say('info', '🛒 Ouverture de la fenêtre d\'achat <b>Google Play</b>…');

    return b.purchase({ productId: productId }).then(function (res) {
      var achats = achatsDe(res);
      if (!achats.length) { say('warn', '⚠️ Google n\'a renvoyé aucun achat.'); return { ok: false }; }
      return regler(achats, b, productId);
    })['catch'](function (e) {
      var code = (e && e.code) || '';
      var txt = code + ' ' + ((e && e.message) || '');
      if (/ANNULE_PAR_UTILISATEUR|USER_CANCELED/.test(txt)) {
        say('warn', '↩️ Achat annulé.');
      } else if (/ITEM_ALREADY_OWNED/.test(txt) || /FLOW_4\b|ACHAT_4\b/.test(txt)) {
        say('warn', 'ℹ️ ' + humanError(e) + ' Utilise « Restaurer mes achats Google Play ».');
      } else {
        say('err', '❌ ' + humanError(e) + (code ? ' <span style="opacity:.7">[' + esc(code) + ']</span>' : ''));
      }
      return { ok: false, error: humanError(e) };
    }).then(function (r) { busy = false; return r; }, function (e) { busy = false; throw e; });
  }

  /**
   * Enregistre chaque achat reçu, puis le finalise.
   * Séparé de buy() pour rester testable sans pont natif.
   */
  function regler(achats, b, productIdDemande) {
    var droits = achats.map(function (p) { return apply(p, Date.now()); });

    var credites = droits.filter(function (d) { return d.granted; });
    var enAttente = droits.filter(function (d) { return d.pending; });

    if (!credites.length) {
      if (enAttente.length) {
        say('info', '⏳ Paiement <b>en attente</b> de validation par Google. Ton accès s\'activera à la confirmation (voir « Restaurer mes achats »).');
        return Promise.resolve({ ok: false, pending: true });
      }
      say('warn', '⚠️ Achat reçu mais non comptabilisé : ' + esc((droits[0] && droits[0].reason) || 'raison inconnue') + '.');
      return Promise.resolve({ ok: false });
    }

    var plan = credites[0].plan;

    /* Le droit est enregistré : on peut finaliser sans risque de perdre l'achat. */
    var finalisations = credites.map(function (d) {
      var token = d.token;
      if (!b || !token) return Promise.resolve({ ok: false, reason: 'jeton absent' });
      return b.finishPurchase({ productId: d.productId || productIdDemande, purchaseToken: token })
        .then(function (r) { return { ok: true, mode: (r && r.mode) || '' }; })
        ['catch'](function (e) { return { ok: false, reason: humanError(e) }; });
    });

    return Promise.all(finalisations).then(function (res) {
      var toutOk = res.every(function (r) { return r.ok; });
      if (toutOk) {
        say('ok', '✅ Achat confirmé — <b>' + esc(plan === 'month' ? 'Premium 1 mois' : 'Pack 10 clashs') +
                  '</b> activé. ' + (plan === 'month' ? 'Bon clash illimité 👑' : 'Bon clash 🔥'));
      } else {
        say('warn', '✅ Ton accès est activé, mais la finalisation côté Google a échoué (' +
                    esc(res[0].reason || 'erreur') + '). Sans cela, Google rembourserait l\'achat au bout de 3 jours.');
      }
      changed();
      return { ok: true, plan: plan, finished: toutOk };
    });
  }

  /* ------------------------------------------------------------------ restauration */

  function restore(silent) {
    var b = nativeBridge();
    if (!b) { if (!silent) say('err', '❌ Restauration impossible : module absent.'); return Promise.resolve({ ok: false }); }
    if (busy) return Promise.resolve({ ok: false });

    busy = true;
    if (!silent) say('info', '🔎 Recherche de tes achats Google Play…');

    return b.restore().then(function (res) {
      var achats = achatsDe(res);
      var nouveaux = [];
      achats.forEach(function (p) {
        var r = apply(p, Date.now());
        if (r.granted) nouveaux.push(r);
      });
      /* Les achats déjà consommés ne sont pas renvoyés par Google : restaurer ne peut pas
         recréditer deux fois un pack. Un abonnement actif, lui, est bien renvoyé. */
      if (!silent) {
        if (nouveaux.length) {
          var plans = nouveaux.map(function (n) { return n.plan === 'month' ? 'Premium' : 'Pack 10 clashs'; });
          say('ok', '✅ Droits retrouvés : <b>' + esc(plans.join(', ')) + '</b>.');
        } else {
          say('info', 'ℹ️ Aucun droit actif à restaurer sur ce compte Google.');
        }
      }
      changed();
      return { ok: true, count: nouveaux.length, scanned: achats.length };
    })['catch'](function (e) {
      if (!silent) say('err', '❌ ' + humanError(e));
      return { ok: false, error: humanError(e) };
    }).then(function (r) { busy = false; return r; }, function (e) { busy = false; throw e; });
  }

  /* ------------------------------------------------------------------ application d'un achat (pure) */

  /**
   * Transforme un achat Google en droit local. Idempotent : rejouer le même achat
   * (même orderId) ne crédite pas deux fois.
   * @returns {{granted:boolean, plan?:string, reason?:string, pending?:boolean}}
   */
  function apply(p, now) {
    if (!p) return { granted: false, reason: 'achat vide' };
    if (!deps) return { granted: false, reason: 'module non initialisé' };

    var productId = p.productId || (p.products && p.products[0]) || '';
    var plan = PLAN_OF[productId];
    if (!plan) return { granted: false, reason: 'produit hors catalogue : ' + productId, productId: productId };

    if (typeof p.state === 'number' && p.state !== STATE_PURCHASED) {
      return { granted: false, pending: p.state === STATE_PENDING, productId: productId, plan: plan,
               reason: p.state === STATE_PENDING ? 'achat en attente' : 'état ' + p.state };
    }
    if (p.orderId && alreadyGranted(p.orderId)) {
      return { granted: false, productId: productId, plan: plan, reason: 'achat déjà comptabilisé' };
    }

    var t = now || Date.now();
    var stock = deps.loadStock();

    if (plan === 'month') {
      var jours = (+deps.days || 30);
      var jusqua = (p.purchaseTime || t) + jours * 86400000;
      deps.saveStock(grantPremiumUntil(stock, jusqua, t, plan));
    } else {
      deps.saveStock(grantCredits(stock, (+deps.packCredits || 10), t));
    }

    markGranted(p.orderId, plan, t);
    if (deps.onGranted) deps.onGranted(plan, p);

    return { granted: true, plan: plan, productId: productId, orderId: p.orderId || '', token: p.purchaseToken || '' };
  }

  /* ------------------------------------------------------------------ messages d'erreur */

  function humanError(e) {
    var code = (e && e.code) || '';
    var m = (e && e.message) || '';
    var texte = code + ' ' + m;

    if (/ANNULE_PAR_UTILISATEUR|USER_CANCELED/.test(texte)) return 'Achat annulé.';
    if (/ITEM_ALREADY_OWNED/.test(texte) || /FLOW_4\b|ACHAT_4\b/.test(texte)) {
      return 'Tu possèdes déjà ce produit — utilise « Restaurer mes achats Google Play ».';
    }
    if (/PRODUIT_INTROUVABLE/.test(texte)) {
      return 'Produit introuvable : vérifie l\'identifiant exact et l\'activation dans Play Console.';
    }
    if (/OFFRE_ABSENTE/.test(texte)) return 'Abonnement sans offre (base plan) configurée dans Play Console.';
    if (/ITEM_UNAVAILABLE/.test(texte) || /QUERY_7\b|ACHAT_7\b/.test(texte)) {
      return 'Produit indisponible : il n\'est pas encore activé dans Play Console.';
    }
    if (/BILLING_UNAVAILABLE/.test(texte) || /SETUP_3\b|QUERY_3\b/.test(texte)) {
      return 'Google Play indisponible sur cet appareil ou ce compte (facturation désactivée, compte non autorisé).';
    }
    if (/DEVELOPER_ERROR/.test(texte) || /FLOW_5\b|QUERY_5\b|ACHAT_5\b/.test(texte)) {
      return 'Erreur de configuration : l\'applicationId ou le produit ne correspond pas à ce qui est déclaré dans Play Console.';
    }
    if (/SERVICE_DISCONNECTED|DECONNECTE/.test(texte) || /SETUP_-1\b/.test(texte)) {
      return 'Service Google Play déconnecté. Réessaie dans un instant.';
    }
    if (/NETWORK_ERROR/.test(texte) || /_12\b/.test(texte)) return 'Problème réseau. Vérifie ta connexion et réessaie.';
    if (/CONNEXION_EN_COURS/.test(texte)) return 'Une connexion à Google Play est déjà en cours.';
    if (/ACTIVITE_ABSENTE/.test(texte)) return 'Aucune activité Android attachée.';
    if (/JETON_MANQUANT/.test(texte)) return 'Jeton d\'achat absent : impossible de finaliser cet achat.';
    if (/PRODUIT_MANQUANT/.test(texte)) return 'Aucun identifiant de produit fourni.';

    /* Codes numériques seuls : « ACHAT_6 », « CONSUME_6 », « SETUP_-1 »… */
    var num = /(-?\d+)\s*$/.exec(code);
    if (num && RESPONSE_CODES[num[1]]) {
      return 'Google Play : ' + RESPONSE_CODES[num[1]] + ' (code ' + num[1] + ')';
    }
    if (!m && !code) return 'Erreur de facturation inconnue.';
    return esc(m || code);
  }

  /* ------------------------------------------------------------------ init / état */

  function init(options) {
    deps = options || {};
    return api;
  }

  function state() {
    return { available: available(), connected: connected, busy: busy,
             products: products, found: found, lastError: lastError, ids: PRODUCTS };
  }

  var api = {
    version: '1.0.3',
    ids: PRODUCTS,
    init: init,
    state: state,
    available: available,
    load: load,
    buy: buy,
    restore: restore,
    /* testables sans pont natif */
    apply: apply,
    grantPremiumUntil: grantPremiumUntil,
    grantCredits: grantCredits,
    alreadyGranted: alreadyGranted,
    markGranted: markGranted,
    loadLedger: loadLedger,
    humanError: humanError,
    parseList: parseList,
    achatsDe: achatsDe,
    produitsDe: produitsDe,
    parsePriceDT: parsePriceDT, EXPECTED_DT: EXPECTED_DT,
    /* crochets de test : simulent le pont natif */
    _setDeps: function (d) { deps = d; },
    _regler: function (achats, b, pid) { return regler(achats, b, pid); }
  };

  root.ClashBilling = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
