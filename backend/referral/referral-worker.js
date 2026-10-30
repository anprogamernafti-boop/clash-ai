/* Clash AI — backend de parrainage (Cloudflare Worker + KV)
 *
 * Rôle : être la source de vérité du parrainage, car le crédit du PARRAIN est inter-appareils
 * et ne peut pas être décidé par le téléphone du filleul. Le worker :
 *   POST /referral  { ref, deviceId, ownRef }  -> valide et compte une arrivée
 *   GET  /credits?code=REF                     -> liste les filleuls validés d'un parrain
 *
 * Anti-abus appliqué côté serveur (non contournable depuis l'app) :
 *   - auto-parrainage refusé (ref == ownRef) ;
 *   - un couple parrain:filleul ne compte qu'une fois (put conditionnel ifNone) ;
 *   - plafond de 5 validations comptées par parrain et par jour ;
 *   - identifiant d'appareil stocké HACHÉ (jamais en clair) ;
 *   - format des identifiants strictement validé.
 *
 * Déploiement (≈ 5 minutes) :
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler kv namespace create REF        -> recopier l'id dans wrangler.toml
 *   3. wrangler secret put SALT                -> une longue chaîne aléatoire
 *   4. wrangler deploy                         -> noter l'URL …workers.dev
 *   5. Dans index.html : const REF_API = 'https://…workers.dev';
 *
 * wrangler.toml :
 *   name = "clash-referral"
 *   main = "referral-worker.js"
 *   compatibility_date = "2026-09-01"
 *   [[kv_namespaces]]
 *   binding = "REF"
 *   id = "<id renvoyé par la commande 2>"
 */

const REF_RE = /^[A-Za-z0-9_-]{4,24}$/;
const MAX_PER_DAY = 5;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });

    const url = new URL(request.url);

    /* ---------------------------------------------------------- compter une arrivée */
    if (url.pathname === '/referral' && request.method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'corps illisible' }, 400); }

      const ref = String((body && body.ref) || '');
      const device = String((body && body.deviceId) || '');
      const own = String((body && body.ownRef) || '');

      if (!REF_RE.test(ref)) return json({ ok: false, error: 'code de parrainage invalide' }, 400);
      if (!REF_RE.test(device)) return json({ ok: false, error: 'appareil invalide' }, 400);
      if (own && own.toLowerCase() === ref.toLowerCase()) {
        return json({ ok: false, error: 'auto-parrainage refuse' }, 403);   /* parrain = filleul */
      }

      const deviceHash = await sha256((env.SALT || 'sans-sel') + ':' + device);
      const pairKey = 'pair:' + ref + ':' + deviceHash;

      /* Un couple parrain:filleul ne compte qu'une seule fois, quel que soit le nombre d'envois. */
      const deja = await env.REF.get(pairKey);
      if (deja) return json({ ok: true, counted: false, reason: 'deja compte' });

      const jour = new Date().toISOString().slice(0, 10);
      const dayKey = 'day:' + ref + ':' + jour;
      const n = parseInt((await env.REF.get(dayKey)) || '0', 10);
      if (n >= MAX_PER_DAY) return json({ ok: false, counted: false, error: 'plafond quotidien' }, 429);

      await env.REF.put(pairKey, JSON.stringify({ at: Date.now(), device: deviceHash }), {
        expirationTtl: 60 * 60 * 24 * 400          /* 400 jours : largement au-delà d'un parrainage */
      });
      await env.REF.put(dayKey, String(n + 1), { expirationTtl: 60 * 60 * 48 });

      return json({ ok: true, counted: true, credits: n + 1 });
    }

    /* ---------------------------------------------------------- filleuls d'un parrain */
    if (url.pathname === '/credits') {
      const ref = String(url.searchParams.get('code') || '');
      if (!REF_RE.test(ref)) return json({ ok: false, error: 'code de parrainage invalide' }, 400);

      const list = await env.REF.list({ prefix: 'pair:' + ref + ':' });
      const prefix = 'pair:' + ref + ':';
      const devices = list.keys.map((k) => k.name.slice(prefix.length));

      /* Le client crédite 1 essai par identifiant encore inconnu de son registre local :
         rejouer cet appel ne peut donc pas créditer deux fois. */
      return json({ ok: true, code: ref, count: devices.length, devices });
    }

    return json({ ok: false, error: 'route inconnue' }, 404);
  }
};

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
