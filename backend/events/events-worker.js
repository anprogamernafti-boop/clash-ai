/* Clash AI — compteurs anonymes du parcours (Cloudflare Worker + KV)
 *
 * POURQUOI CE WORKER
 * Sans lui, tout l'analytique de l'application vit dans le `localStorage` de chaque téléphone :
 * on ne sait donc rien. Si 100 personnes voient un verdict et que 5 seulement enregistrent une
 * vidéo, on ne peut pas distinguer un problème d'IA d'un problème de bouton — on choisit ses
 * priorités au hasard. Ce worker ne fait qu'une chose : COMPTER les étapes franchies.
 *
 * CE QUI N'EST PAS ENVOYÉ (garanti par construction, pas par promesse) :
 *   - aucune photo, aucun prénom, aucune punchline, aucun score ;
 *   - aucun identifiant d'appareil, aucun cookie, aucune adresse IP conservée ;
 *   - pas même un identifiant de session : seuls des NOMBRES par étape sont additionnés.
 * C'est le tourniquet à l'entrée d'un magasin : il compte les passages, il ne dit pas qui.
 *
 * LA CONTRAINTE QUI DICTE LA FORME
 * Le plan gratuit de Cloudflare KV accepte ~1 000 écritures par jour. Incrémenter un compteur par
 * étape et par événement épuiserait ce quota en quelques centaines de visiteurs. On écrit donc :
 *   - UN SEUL objet JSON par jour  (clé `ev:<AAAA-MM-JJ>`), une écriture par SESSION ;
 *   - le total n'est pas stocké : `/stats` additionne les journées (une lecture par jour).
 *
 * Routes :
 *   GET  /e?j=<jour>&e=arrivee:3,verdict:2   -> additionne les compteurs du jour  { ok:true }
 *   POST /e?...                              -> identique (navigator.sendBeacon ne fait que POST)
 *   GET  /stats                              -> (admin) le parcours, jour par jour et cumulé
 *   GET  /health                             -> vivacité
 *
 * Déploiement :
 *   cd backend/events
 *   npx wrangler kv namespace create REF      (ou réutiliser l'id du parrainage)
 *   npx wrangler secret put ADMIN_TOKEN       (longue chaîne aléatoire, secrète)
 *   npx wrangler deploy
 *
 * ⚠️ Ne jamais bloquer l'application à cause de l'analytique : toute erreur ici est avalée côté
 * client. Un compteur qui manque ne doit jamais casser un clash.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

/* Liste blanche des étapes : un client ne peut donc pas créer de clés arbitraires dans le KV
   (sans cela, n'importe qui pourrait remplir le stockage avec des noms inventés). Les noms sont
   EXACTEMENT ceux que `bumpStat()` utilise déjà dans l'application — le câblage tient donc en une
   ligne, et rien ne peut dériver d'un côté sans que l'autre ne compte plus. */
export const ETAPES = [
  'arrivee',          /* la page s'est ouverte */
  'photo',            /* une photo a été choisie */
  'clashs',           /* un verdict a été produit */
  'videos',           /* une vidéo a été enregistrée */
  'partages_video',   /* la vidéo est partie dans une application */
  'shares',           /* l'image du verdict est partie */
  'ecoutes',          /* le clash a été écouté */
  'clics_paiement',   /* l'écran de paiement a été ouvert */
  'deblocages',       /* un accès a été débloqué (code ou achat) */
  'contact_whatsapp', /* une commande a été envoyée sur WhatsApp */
  'contact_email',    /* une demande est partie par e-mail */
  'ventes',           /* une vente a été enregistrée */
  'arrivals',         /* une visite est arrivée avec un lien de parrainage */
  'partages_ref',     /* le lien de parrainage a été partagé */
  'partage_entrant',  /* l'app a été ouverte par « Partager → Clash AI » */
  'legende_copiee',   /* une légende prête à poster a été copiée */
  'defi_cree',        /* un défi a été posé (appel à riposter) */
  'defi_retire',      /* le défi a été retiré avant enregistrement */
  'defi_recu',        /* l'app a été ouverte par un lien de défi */
  'signalement',      /* un défi reçu a été signalé */
  'landing_vue',      /* l'écran d'entrée a été affiché (premier lancement) */
  'landing_clic',     /* on a touché le bouton de l'écran d'entrée */
  /* ⚠️ `partages_video` et `shares` comptent la TENTATIVE (incrémentés avant l'essai) : sans
     ces quatre-ci, on ne saurait pas si le partage a marché. Or c'est LA question de l'app :
     si 100 personnes appuient sur « Partager » et que rien ne part, `partages_video` afficherait
     100 et on croirait la boucle virale fonctionnelle. */
  'partage_video_ok',     /* le partage vidéo a été lancé avec succès */
  'partage_video_echec',  /* le partage vidéo a échoué ou a été refusé */
  'partage_image_ok',     /* le partage de l'image du verdict a réussi */
  'partage_image_echec'   /* le partage de l'image a échoué */
];

export const MAX_PAR_ETAPE = 300;   /* plafond par envoi : un client ne peut pas gonfler un chiffre */

/** Jour au format AAAA-MM-JJ (UTC). */
export function jourDe(d) {
  return new Date(d || Date.now()).toISOString().slice(0, 10);
}

export function jourValide(j) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(j || ''));
}

/** Décompose « arrivee:3,verdict:2 » en objet, en ignorant tout ce qui n'est pas autorisé.
 *  Renvoie {} si rien n'est exploitable — on préfère ne rien compter que compter n'importe quoi. */
export function lireCompteurs(brut, etapes) {
  const autorisees = etapes || ETAPES;
  const out = {};
  String(brut || '').split(',').forEach(function (morceau) {
    const p = morceau.split(':');
    if (p.length !== 2) return;
    const nom = p[0].trim();
    const n = parseInt(p[1], 10);
    if (autorisees.indexOf(nom) === -1) return;
    if (!isFinite(n) || n <= 0) return;
    out[nom] = Math.min(MAX_PAR_ETAPE, n);
  });
  return out;
}

/** Additionne deux jeux de compteurs (sans muter l'entrée). */
export function additionner(base, ajout) {
  const out = {};
  Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
  Object.keys(ajout || {}).forEach(function (k) { out[k] = (out[k] || 0) + ajout[k]; });
  return out;
}

export async function statsParJour(kv, prefixe) {
  const liste = await kv.list({ prefix: (prefixe || 'ev:') + '', limit: 1000 });
  const jours = [];
  for (const cle of liste.keys) {
    const j = cle.name.slice((prefixe || 'ev:').length);
    if (!jourValide(j)) continue;
    let v = {};
    try { v = JSON.parse((await kv.get(cle.name)) || '{}') || {}; } catch (e) { v = {}; }
    /* Une journée vide (clé supprimée mais encore visible dans `list`, qui est à cohérence
       différée) ne doit pas apparaître dans le rapport. */
    if (!Object.keys(v).length) continue;
    jours.push({ jour: j, compteurs: v });
  }
  jours.sort(function (a, b) { return a.jour < b.jour ? -1 : 1; });
  const cumul = jours.reduce(function (acc, x) { return additionner(acc, x.compteurs); }, {});
  return { jours: jours, cumul: cumul };
}

/* ------------------------------------------------------------------ HTTP */

function json(o, status) {
  return new Response(JSON.stringify(o), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, CORS)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/health') return json({ ok: true, service: 'clash-events' });

    /* --- comptage ------------------------------------------------------- */
    /* On lit les paramètres dans l'URL pour GET **et** POST : `navigator.sendBeacon` n'émet que
       des POST, et c'est pourtant lui qui part le plus fiable quand la page se ferme. */
    if (route === '/e') {
      const jour = url.searchParams.get('j');
      if (!jourValide(jour)) return json({ ok: false, error: 'jour invalide' }, 400);
      const compteurs = lireCompteurs(url.searchParams.get('e'), ETAPES);
      const cles = Object.keys(compteurs);
      if (!cles.length) return json({ ok: true, compte: 0, note: 'rien à compter' });
      if (!env || !env.REF) return json({ ok: false, error: 'stockage indisponible' }, 503);

      const cle = 'ev:' + jour;
      try {
        /* Lecture puis écriture : UNE écriture par session. Deux envois simultanés peuvent se
           chevaucher sur la même journée et perdre quelques unités — c'est un compteur de
           tendance, pas une comptabilité : on l'assume plutôt que d'écrire à chaque événement. */
        let actuel = {};
        try { actuel = JSON.parse((await env.REF.get(cle)) || '{}') || {}; } catch (e) { actuel = {}; }
        await env.REF.put(cle, JSON.stringify(additionner(actuel, compteurs)));
        return json({ ok: true, compte: cles.length });
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e).slice(0, 120) }, 500);
      }
    }

    /* --- chiffre PUBLIC : preuve sociale HONNÊTE ------------------------
       L'application affichait « 125k tests » : un chiffre invérifiable (mauvais pour la
       crédibilité, et risque de rejet côté magasin d'applications). On renvoie ici un VRAI
       total, volontairement réduit à UN SEUL nombre agrégé : aucun détail par jour, aucune
       donnée identifiante. C'est ce que l'écran d'accueil affiche.
       Mis en cache 5 minutes : inutile de relire le stockage à chaque visite. */
    if (route === '/public') {
      if (!env || !env.REF) return json({ ok: false, error: 'stockage indisponible' }, 503);
      const s = await statsParJour(env.REF, 'ev:');
      const c = s.cumul;
      return new Response(JSON.stringify({ ok: true, clashs: c.clashs || 0, arrivees: c.arrivee || 0 }), {
        status: 200,
        headers: Object.assign({}, CORS, {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=300'
        })
      });
    }

    /* --- consultation (admin) ------------------------------------------- */
    if (route === '/stats') {
      const jeton = request.headers.get('x-admin-token') || url.searchParams.get('token') || '';
      if (!env || !env.ADMIN_TOKEN) return json({ ok: false, error: 'jeton non configuré' }, 503);
      if (jeton !== env.ADMIN_TOKEN) return json({ ok: false, error: 'jeton refusé' }, 401);
      const s = await statsParJour(env.REF, 'ev:');
      const taux = function (a, b) { return (b > 0 ? Math.round((a / b) * 1000) / 10 : null); };
      /* ⚠️ `videos / clashs` n'est PAS un taux de conversion : un MÊME clash peut produire
         plusieurs vidéos (on change d'habillage ou de durée, on réenregistre). Le rapport
         affichait « 171,4 % », ce qui n'a aucun sens pour un taux et donne envie de se méfier
         de tout le tableau. On l'exprime donc pour ce qu'il est : une moyenne. Les vrais taux de
         conversion, par construction ≤ 100 %, restent dans `entonnoir`. */
      const par = function (a, b) { return (b > 0 ? Math.round((a / b) * 100) / 100 : null); };
      const c = s.cumul;
      return json({
        ok: true,
        cumul: c,
        jours: s.jours,
        /* Le seul chiffre qui intéresse vraiment : où le parcours perd ses gens. */
        entonnoir: {
          arrivee_vers_photo: taux(c.photo, c.arrivee),
          photo_vers_clash: taux(c.clashs, c.photo),
          clash_vers_ecoute: taux(c.ecoutes, c.clashs),
          video_vers_partage: taux(c.partages_video, c.videos)
        },
        /* Rapports, PAS des taux : ils peuvent dépasser 1 sans que rien ne cloche. */
        moyennes: {
          videos_par_clash: par(c.videos, c.clashs)
        }
      });
    }

    return json({ ok: false, error: 'route inconnue' }, 404);
  }
};
