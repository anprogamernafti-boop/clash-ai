/* Clash AI — service des codes d'activation (Cloudflare Worker + KV)
 *
 * Pourquoi un serveur : un code d'activation doit être utilisable UNE SEULE FOIS. Une liste
 * d'empreintes embarquée dans l'application ne peut pas garantir cela (un même code y reste
 * valable à l'infini), et il faudrait recompiler l'APK pour chaque nouveau code. Ici, le serveur
 * est la source de vérité : on ajoute des codes à chaud, sans reconstruire l'application.
 *
 * Routes :
 *   POST /redeem  { code, deviceId }        -> consomme le code ; usage unique, lié à l'appareil
 *   POST /add     { plan, codes: [ ... ] }  -> (admin) enregistre des codes neufs
 *   POST /status  { code }                  -> (admin) état d'un code
 *   GET  /stats                             -> (admin) compteurs par plan
 *   GET  /health                            -> vivacité
 *
 * Le TEXTE des codes n'est jamais stocké : seule compte l'empreinte SHA-256 salée, comme clé KV.
 * Le texte clair n'existe que dans le journal local du vendeur (codes-activation.csv).
 *
 * Usage unique, concrètement :
 *   - premier appel  -> le code est marqué utilisé et rattaché à deviceId  -> { ok, plan, firstUse:true }
 *   - même appareil  -> renvoyé tel quel                                   -> { ok, plan, firstUse:false }
 *     (idempotent : un renvoi après coupure réseau ne fait pas perdre l'achat)
 *   - autre appareil -> refusé (409)                                       -> code partagé bloqué
 *
 * Déploiement :
 *   cd backend/activation
 *   npx wrangler kv namespace create REF      (ou réutiliser l'id du parrainage)
 *   npx wrangler secret put CODE_SALT         (longue chaîne aléatoire, secrète)
 *   npx wrangler secret put ADMIN_TOKEN       (longue chaîne aléatoire, secrète)
 *   npx wrangler deploy
 */

const PLANS = ['month', 'pack'];
const CODE_MIN = 6;
const CODE_MAX = 40;
const DEVICE_RE = /^[A-Za-z0-9_-]{4,64}$/;

/* ------------------------------------------------------------------ helpers (testables) */

/** Majuscules, sans espaces — même règle que index.html. */
export function normalizeCode(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase();
}

/** Forme resserrée : on retire la ponctuation, pour une saisie tolérante. */
export function looseCode(s) {
  return normalizeCode(s).replace(/[^A-Z0-9]/g, '');
}

export function isPlan(p) {
  return PLANS.indexOf(String(p || '')) !== -1;
}

export function validCode(code) {
  const c = looseCode(code);
  return c.length >= CODE_MIN && c.length <= CODE_MAX && /^[A-Z0-9]+$/.test(c);
}

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Clé KV d'un code : empreinte salée — le texte clair est irrécupérable depuis le stockage. */
export async function codeKey(env, code) {
  return 'c:' + (await sha256hex((env.CODE_SALT || 'sans-sel') + ':' + looseCode(code)));
}

/** Comparaison à durée constante (évite de laisser fuiter le jeton par le temps de réponse). */
export function memeJeton(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function estAdmin(request, env) {
  return !!env.ADMIN_TOKEN && memeJeton(request.headers.get('x-admin-token'), env.ADMIN_TOKEN);
}

/* ------------------------------------------------------------------ worker */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-admin-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (o, status) =>
      new Response(JSON.stringify(o), { status: status || 200, headers: { ...cors, 'content-type': 'application/json' } });

    const url = new URL(request.url);

    if (url.pathname === '/health') return json({ ok: true, service: 'clash-activation' });

    /* ---------------------------------------------------------- consommer un code */
    if (url.pathname === '/redeem' && request.method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'corps illisible' }, 400); }

      const code = (body && body.code) || '';
      const device = String((body && body.deviceId) || '');
      if (!validCode(code)) return json({ ok: false, error: 'code mal formé' }, 400);
      if (!DEVICE_RE.test(device)) return json({ ok: false, error: 'appareil invalide' }, 400);

      const key = await codeKey(env, code);
      const brut = await env.REF.get(key);
      if (!brut) return json({ ok: false, error: 'code inconnu' }, 404);

      let rec = {};
      try { rec = JSON.parse(brut) || {}; } catch (e) { rec = {}; }

      if (rec.used) {
        /* Le même appareil peut réessayer sans rien perdre (achat idempotent) ; un AUTRE
           appareil se voit refuser : c'est cela, l'usage unique. */
        if (rec.device && rec.device === device) {
          return json({ ok: true, plan: rec.plan, firstUse: false, alreadyYours: true });
        }
        return json({ ok: false, error: 'code déjà utilisé' }, 409);
      }

      rec.used = true;
      rec.device = device;
      rec.usedAt = Date.now();
      await env.REF.put(key, JSON.stringify(rec));
      return json({ ok: true, plan: rec.plan, firstUse: true });
    }

    /* ---------------------------------------------------------- routes d'administration */
    if (url.pathname === '/add' && request.method === 'POST') {
      if (!estAdmin(request, env)) return json({ ok: false, error: 'jeton admin invalide' }, 403);
      let body = null;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'corps illisible' }, 400); }

      const plan = String((body && body.plan) || '');
      if (!isPlan(plan)) return json({ ok: false, error: 'plan invalide (month|pack)' }, 400);

      let liste = (body && body.codes) || [];
      if (typeof liste === 'string') liste = [liste];
      if (!Array.isArray(liste) || !liste.length) return json({ ok: false, error: 'aucun code fourni' }, 400);
      if (liste.length > 500) return json({ ok: false, error: '500 codes maximum par appel' }, 400);

      const ajoutes = [], ignores = [];
      for (const brut of liste) {
        const c = String(brut || '');
        if (!validCode(c)) { ignores.push({ code: c, reason: 'mal formé' }); continue; }
        const key = await codeKey(env, c);
        if (await env.REF.get(key)) { ignores.push({ code: c, reason: 'déjà enregistré' }); continue; }
        await env.REF.put(key, JSON.stringify({ plan: plan, used: false, addedAt: Date.now() }));
        ajoutes.push(c);
      }
      return json({ ok: true, plan: plan, added: ajoutes.length, skipped: ignores });
    }

    if (url.pathname === '/status' && request.method === 'POST') {
      if (!estAdmin(request, env)) return json({ ok: false, error: 'jeton admin invalide' }, 403);
      let body = null;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'corps illisible' }, 400); }
      const code = (body && body.code) || '';
      if (!validCode(code)) return json({ ok: false, error: 'code mal formé' }, 400);
      const brut = await env.REF.get(await codeKey(env, code));
      if (!brut) return json({ ok: true, code: looseCode(code), exists: false });
      let rec = {}; try { rec = JSON.parse(brut) || {}; } catch (e) { rec = {}; }
      return json({ ok: true, code: looseCode(code), exists: true, plan: rec.plan,
                    used: !!rec.used, usedAt: rec.usedAt || null, device: rec.device || null });
    }

    if (url.pathname === '/stats' && request.method === 'GET') {
      if (!estAdmin(request, env)) return json({ ok: false, error: 'jeton admin invalide' }, 403);
      const compte = { month: { total: 0, used: 0 }, pack: { total: 0, used: 0 } };
      let curseur = null;
      do {
        const p = { prefix: 'c:' };
        if (curseur) p.cursor = curseur;
        const page = await env.REF.list(p);
        for (const k of page.keys) {
          const rec = await env.REF.get(k.name);
          if (!rec) continue;
          let o = {}; try { o = JSON.parse(rec) || {}; } catch (e) { continue; }
          if (!compte[o.plan]) continue;
          compte[o.plan].total++;
          if (o.used) compte[o.plan].used++;
        }
        curseur = page.list_complete ? null : page.cursor;
      } while (curseur);
      return json({ ok: true, stats: compte });
    }

    return json({ ok: false, error: 'route inconnue' }, 404);
  }
};
