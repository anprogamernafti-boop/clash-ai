/* Clash AI — proxy Gemini (Cloudflare Worker)
 *
 * Rôle : permettre à l'utilisateur d'utiliser l'IA de vision SANS jamais créer de clé ni
 * ouvrir son compte Google. La clé Gemini vit ICI, côté serveur (secret GEMINI_KEY) —
 * jamais dans l'APK, jamais dans le navigateur. C'est le PROPRIÉTAIRE de l'application
 * qui crée UNE clé une seule fois ; les utilisateurs n'ont rien à faire.
 *
 * Déploiement : `deploy-gemini-proxy.ps1` depuis la racine du projet.
 *   - GEMINI_KEY reste un secret Cloudflare côté serveur.
 *   - REF et GEMINI_LIMITER sont décrits dans backend/gemini/wrangler.toml.
 *   - aucun APP_TOKEN partagé n'est nécessaire dans le navigateur ou l'APK.
 *
 * wrangler.toml :
 *   name = "clash-gemini-proxy"
 *   main = "gemini-proxy-worker.js"
 *   compatibility_date = "2026-09-01"
 *   [[kv_namespaces]]
 *   binding = "REF"
 *   id = "<id renvoyé par la commande 2>"
 *
 * Protections : limiteur Cloudflare par IP, quota KV par IP/appareil, plafond KV quotidien
 * indicatif, modèles explicitement autorisés, origines navigateur limitées, taille d'image
 * bornée et clé Google gardée côté serveur. Ces seuils KV/rate-limit ne sont pas une garantie
 * comptable absolue ; configurer aussi les budgets/quotas du projet Google.
 *
 * Les fonctions nommées (deviceQuotaKey, modelAllowed, imageTooBig, geminiTextFromResponse)
 * sont exportées uniquement pour être testées hors ligne par test8.js.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_IMAGE_B64 = 2 * 1024 * 1024;        /* ~1,5 Mo d'image : assez pour une photo compressée */
const CALLS_PER_DEVICE_PER_DAY = 30;
const GLOBAL_DAILY_CAP = 3000;
const GEMINI_MODELS = new Set([
  'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'
]);
const ALLOWED_ORIGINS = new Set([
  'https://clash-ai.pages.dev', 'https://localhost', 'http://localhost', 'capacitor://localhost'
]);

/* Même échelle que le client : si l'API refuse un champ, on dégrade. */
const GEN_CFG_LADDER = [
  { temperature: 1.0, maxOutputTokens: 2048, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  { temperature: 1.0, maxOutputTokens: 2048, responseMimeType: 'application/json' },
  { temperature: 1.0, maxOutputTokens: 2048 }
];

/* ------------------------------------------------------------------ helpers testables */

/** Clé KV du quota quotidien d'un appareil (préfixe distinct du parrainage « pair: »). */
export function deviceQuotaKey(jour, device) {
  return 'q:' + jour + ':' + device;
}

export async function quotaIdentity(ip, device) {
  const data = new TextEncoder().encode(String(ip || '').trim() + '\u0000' + String(device || 'inconnu').slice(0, 128));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function originAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^https:\/\/[a-z0-9-]+\.clash-ai\.pages\.dev$/i.test(origin);
}

/** Liste blanche explicite des modèles utilisés par le client. */
export function modelAllowed(m) {
  return GEMINI_MODELS.has(String(m || ''));
}

/** Image trop grande (en caractères base64) ? */
export function imageTooBig(b64) {
  return String(b64 || '').length > MAX_IMAGE_B64;
}

/** Extrait le texte d'une réponse Gemini, sans dépendre de sa forme exacte. */
export function geminiTextFromResponse(j) {
  const cand = ((j || {}).candidates || [])[0] || {};
  const parts = ((cand.content || {}).parts) || [];
  return {
    text: parts.map(function (p) { return p.text || ''; }).join(''),
    finishReason: cand.finishReason || null
  };
}

/* ------------------------------------------------------------------ worker */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const cors = {
      'Access-Control-Allow-Headers': 'content-type, x-app-token, x-device',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Vary': 'Origin'
    };
    if (origin && originAllowed(origin)) cors['Access-Control-Allow-Origin'] = origin;
    const json = (o, status) =>
      new Response(JSON.stringify(o), { status: status || 200, headers: { ...cors, 'content-type': 'application/json' } });

    if (!originAllowed(origin)) return json({ ok: false, error: 'origine non autorisée' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (request.method !== 'POST' || !['/clash', '/vocaliser', '/clash-cloudflare', '/clash-cloudflare-llama4', '/clash-cloudflare-qwen'].includes(url.pathname)) {
      return json({ ok: false, error: 'route inconnue' }, 404);
    }
    const texteSeul = url.pathname === '/vocaliser';
    const viaCloudflare = url.pathname === '/clash-cloudflare' || url.pathname === '/clash-cloudflare-llama4' || url.pathname === '/clash-cloudflare-qwen';
    const qwenTextOnly = url.pathname === '/clash-cloudflare-qwen';
    const cloudflareModel = qwenTextOnly
      ? '@cf/qwen/qwen3-30b-a3b-fp8'
      : url.pathname === '/clash-cloudflare-llama4'
        ? '@cf/meta/llama-4-scout-17b-16e-instruct'
        : '@cf/google/gemma-4-26b-a4b-it';

    const ip = String(request.headers.get('cf-connecting-ip') || '').trim();
    if (!ip) return json({ ok: false, error: 'identifiant réseau indisponible' }, 503);
    if (!env.GEMINI_LIMITER || typeof env.GEMINI_LIMITER.limit !== 'function') {
      return json({ ok: false, error: 'limiteur de requêtes indisponible' }, 503);
    }
    const limiteRequetes = await env.GEMINI_LIMITER.limit({ key: ip });
    if (!limiteRequetes.success) return json({ ok: false, error: 'trop de demandes rapprochées' }, 429);

    const jour = new Date().toISOString().slice(0, 10);
    const device = String(request.headers.get('x-device') || 'inconnu').slice(0, 128);
    const quotaSubject = await quotaIdentity(ip, device);

    /* KV est éventuellement cohérent : ce plafond journalier est une barrière indicative, pas une comptabilité atomique. */
    const gk = 'gcap:' + jour;
    const g = parseInt((await env.REF.get(gk)) || '0', 10);
    if (g >= GLOBAL_DAILY_CAP) {
      return json({ ok: false, error: 'quota global atteint pour aujourd\'hui' }, 429);
    }

    /* Quota quotidien lié à l'IP Cloudflare et à l'identifiant local; l'IP brute n'est pas enregistrée dans KV. */
    const qk = deviceQuotaKey(jour, quotaSubject);
    const n = parseInt((await env.REF.get(qk)) || '0', 10);
    if (n >= CALLS_PER_DEVICE_PER_DAY) {
      return json({ ok: false, error: 'quota journalier atteint pour cet appareil' }, 429);
    }

    /* 4) validation stricte de la demande */
    let body = null;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'corps illisible' }, 400); }
    const model = viaCloudflare ? cloudflareModel : String((body && body.model) || '');
    const prompt = String((body && body.prompt) || '');
    const b64 = String((body && body.b64) || '');
    if (!prompt) return json({ ok: false, error: 'prompt manquant' }, 400);
    if (!viaCloudflare && !modelAllowed(model)) return json({ ok: false, error: 'modèle non autorisé' }, 400);
    if (texteSeul && b64) return json({ ok: false, error: 'la route de vocalisation n’accepte pas d’image' }, 400);
    if ((!texteSeul || viaCloudflare) && !qwenTextOnly && !b64) return json({ ok: false, error: 'image manquante' }, 400);
    if ((!texteSeul || viaCloudflare) && !qwenTextOnly && imageTooBig(b64)) return json({ ok: false, error: 'image trop grande' }, 413);
    if (texteSeul && prompt.length > 6000) return json({ ok: false, error: 'texte trop long' }, 413);

    /* Route de comparaison isolée : un seul modèle fixe, même quotas et mêmes limites que Gemini. */
    if (viaCloudflare) {
      if (!env.AI || typeof env.AI.run !== 'function') {
        return json({ ok: false, error: 'Workers AI indisponible sur ce Worker' }, 503);
      }
      try {
        const input = qwenTextOnly
          ? { prompt, max_tokens: 1200, temperature: 0.9 }
          : {
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }
                ]
              }],
              chat_template_kwargs: { enable_thinking: false },
              max_tokens: 1200,
              temperature: 0.9
            };
        const result = await env.AI.run(model, input);
        const textValue = result && (
          result.response || result.result?.response || result.text || result.generated_text ||
          result.choices?.[0]?.message?.content || result.output?.[0]?.content?.[0]?.text
        );
        const text = typeof textValue === 'string' ? textValue.trim() : '';
        if (!text) return json({ ok: false, error: 'Workers AI n’a renvoyé aucun texte exploitable', detail: Object.keys(result || {}).join(',') }, 502);
        await env.REF.put(qk, String(n + 1), { expirationTtl: 60 * 60 * 48 });
        await env.REF.put(gk, String(g + 1), { expirationTtl: 60 * 60 * 48 });
        return json({ ok: true, text, finishReason: null, model }, 200);
      } catch (e) {
        return json({ ok: false, error: 'échec Workers AI', detail: String(e && e.message || e).slice(0, 300) }, 502);
      }
    }

    /* 5) relai vers Gemini — la clé n'apparaît QUE dans cet appel serveur -> Google */
    for (let i = 0; i < GEN_CFG_LADDER.length; i++) {
      const up = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ parts: texteSeul ? [{ text: prompt }] : [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
          generationConfig: GEN_CFG_LADDER[i]
        })
      });
      const j = await up.json().catch(function () { return {}; });
      if (!up.ok) {
        const em = (j && j.error && j.error.message) || ('HTTP ' + up.status);
        if (up.status === 400 && /thinking|response_?mime|responseSchema|response_schema/i.test(em)
            && i < GEN_CFG_LADDER.length - 1) continue;   /* on dégrade la configuration */
        return json({ ok: false, error: em }, up.status);
      }
      const t = geminiTextFromResponse(j);
      await env.REF.put(qk, String(n + 1), { expirationTtl: 60 * 60 * 48 });
      await env.REF.put(gk, String(g + 1), { expirationTtl: 60 * 60 * 48 });
      return json({ ok: true, text: t.text, finishReason: t.finishReason, model: model });
    }
    return json({ ok: false, error: 'configuration refusée par l\'API' }, 400);
  }
};
