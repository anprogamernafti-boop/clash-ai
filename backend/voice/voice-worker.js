import { inspectPcmWav } from './voice-quality.mjs';

/* Clash AI — narration audio pour la version WEB.
 *
 * Pourquoi ce worker : dans un navigateur, l'application n'a aucun accès à une synthèse vocale
 * capturable (la Web Speech API ne peut pas être enregistrée) et il n'existe pas de greffon natif.
 * La vidéo web sortait donc muette. Ici, on synthétise la phrase CÔTÉ SERVEUR et on renvoie l'audio,
 * que la page décode puis mixe dans l'enregistrement.
 *
 * Politique de production : VoxCPM uniquement. Si le modèle ou son quota est indisponible,
 * la route renvoie une erreur explicite et l'application conserve le texte sans autre accent.
 * Les moteurs historiques ci-dessous restent dans le code pour comparaison locale uniquement;
 * ils ne sont joignables qu'avec VOICE_POLICY=allow_fallback, option non activée en production.
 *
 * Routes :
 *   POST /voix { text, ar, lang } -> { ok, audio (base64), mime, moteur, arabe }
 *   GET  /health
 *   GET  /diagnostic              -> désactivée sauf activation explicite côté opérateur
 */
const LONGUEUR_MAX = 600;
const DELAI_EDGE = 12000;    // Edge : WebSocket, peut être lent
const DELAI_HTTP = 9000;     // Google

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-device',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(o, status) {
  return new Response(JSON.stringify(o), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS)
  });
}

const estArabe = (s) => /[\u0600-\u06FF]/.test(String(s || ''));

function echapperXml(texte) {
  return String(texte).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;').replace(/'/g, '&apos;');
}

async function ttsAzure(env, texte, voix) {
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) throw new Error('Azure Speech non configuré');
  const region = String(env.AZURE_SPEECH_REGION).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error('région Azure invalide');
  const ssml = `<speak version=\"1.0\" xml:lang=\"ar-TN\"><voice name=\"${voix}\">${echapperXml(texte)}</voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'ClashAI'
    },
    body: ssml
  });
  if (!r.ok) throw new Error('Azure Speech HTTP ' + r.status);
  const audio = new Uint8Array(await r.arrayBuffer());
  if (!estMp3(audio)) throw new Error('audio Azure invalide');
  return audio;
}

/* ------------------------------------------------------------------ outils base64/audio */

function enBase64(octets) {
  let bin = '';
  const TAILLE = 8192;                               // par morceaux : éviter de saturer la pile
  for (let i = 0; i < octets.length; i += TAILLE) {
    bin += String.fromCharCode.apply(null, octets.subarray(i, i + TAILLE));
  }
  return btoa(bin);
}

const estMp3 = (u8) => u8.length > 200 &&
  (u8[0] === 0xFF || (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33));

async function cleLimitationVoix(request) {
  const identifiant = String(request.headers.get('cf-connecting-ip') || request.headers.get('x-device') || 'inconnu').trim();
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifiant));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function autoriserCohorteVoxCPM(request, env) {
  const percent = pourcentageRollout(env);
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const identifiant = String(request.headers.get('cf-connecting-ip') || request.headers.get('x-device') || 'inconnu').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('voxcpm-rollout:' + identifiant));
  const value = new DataView(digest).getUint32(0, false) % 100;
  return value < percent;
}

async function ttsBaarcha(env, texte) {
  if (!env || !env.BAARCHA_API_KEY) throw new Error('Baarcha non configuré');
  const voix = String(env.BAARCHA_VOICE || 'dido').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(voix)) throw new Error('voix Baarcha invalide');
  const r = await fetch('https://baarcha.tn/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.BAARCHA_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'dido', input: texte, voice: voix, response_format: 'mp3' }),
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) {
    try { await r.body.cancel(); } catch (_) {}
    throw new Error('Baarcha Speech HTTP ' + r.status);
  }
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'audio/mpeg') {
    try { await r.body.cancel(); } catch (_) {}
    throw new Error('format Baarcha invalide');
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  if (!estMp3(audio)) throw new Error('audio Baarcha invalide');
  return audio;
}

function estWav(u8) {
  return u8.length > 44 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46
    && u8[8] === 0x57 && u8[9] === 0x41 && u8[10] === 0x56 && u8[11] === 0x45;
}

function verifierAudioVoxCPM(u8) {
  const controle = inspectPcmWav(u8);
  if (!controle.ok) throw erreurVoix('sortie audio rejetée par le contrôle qualité', 'invalid_audio');
  return controle;
}

async function cleCacheVoix(texteAr, env, origin) {
  const version = String(env.VOXCPM_CACHE_VERSION || 'voxcpm-tn-v1');
  const provider = String(env.HF_VOXCPM_SPACE_URL || env.VOXCPM_API_URL || 'voxcpm');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version + '\0' + provider + '\0' + texteAr));
  const suffix = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request(new URL('/__voice-cache/' + suffix, origin).toString());
}

function erreurVoix(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function categorieErreurZeroGPU(details) {
  const texte = String(details || '').toLowerCase();
  if (/quota|rate.?limit|daily limit|out of credits/.test(texte)) return 'quota';
  if (/out of memory|cuda.*memory|memory.*cuda|oom/.test(texte)) return 'gpu_memory';
  if (/queue.*(full|busy|saturat)|overload|capacity exhausted|no available gpu|no gpu available|gpu.*unavailable|unavailable.*gpu|could not allocate.*gpu/.test(texte)) return 'gpu_capacity';
  if (/timeout|timed out|deadline/.test(texte)) return 'timeout';
  if (/valueerror|gradioerror|texte doit|lettres arabes/.test(texte)) return 'input_or_validation';
  if (/typeerror|attributeerror|runtimeerror|exception/.test(texte)) return 'model_runtime';
  return 'space_internal';
}

function detailDiagnosticZeroGPU(details) {
  let texte = String(details || '').trim();
  try {
    const parsed = JSON.parse(texte);
    if (parsed && typeof parsed === 'object') {
      texte = String(parsed.error || parsed.message || parsed.type || 'erreur sans détail');
    } else if (typeof parsed === 'string') {
      texte = parsed;
    }
  } catch (_) {}
  return texte
    .replace(/hf_[A-Za-z0-9]{20,}/g, '[jeton masqué]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [masqué]')
    .replace(/https?:\/\/\S+/g, '[URL masquée]')
    .replace(/[\u0600-\u06ff]+/g, '[texte arabe masqué]')
    .replace(/[\r\n\t\x00-\x1f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 180);
}

function secondesAvantRenouvellementZeroGPU(details) {
  const match = String(details || '').match(/\bTry again in\s+(\d{1,2}):([0-5]\d):([0-5]\d)\b/i);
  if (!match) return null;
  const secondes = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return secondes > 0 && secondes <= 7 * 24 * 3600 ? secondes : null;
}

function messageDiagnosticZeroGPU(categorie) {
  const messages = {
    quota: 'Quota Hugging Face/ZeroGPU épuisé ou limité ; réessayer après son renouvellement.',
    gpu_memory: 'Le modèle VoxCPM a manqué de mémoire GPU.',
    gpu_capacity: 'GPU ZeroGPU indisponible ou file saturée.',
    timeout: 'La génération VoxCPM a dépassé le délai du Space.',
    input_or_validation: 'Le Space a rejeté le texte ou ses contrôles de génération.',
    model_runtime: 'Le modèle a rencontré une erreur d’exécution ; consulter les journaux du Space.',
    space_internal: 'Le Space a interrompu la génération ; consulter les journaux du Space.'
  };
  return messages[categorie] || messages.space_internal;
}

function voxcpmUniquement(env) {
  return !env || (env.VOICE_POLICY !== 'allow_fallback' && env.VOICE_POLICY !== 'voxcpm_canary');
}

function pourcentageRollout(env) {
  const valeur = Number(env && env.VOXCPM_ROLLOUT_PERCENT || 0);
  return Number.isFinite(valeur) ? Math.max(0, Math.min(100, valeur)) : 0;
}

function compterMotsVoix(texte, arabe) {
  const expression = arabe ? /[\p{Script=Arabic}\p{Script=Latin}\p{M}]+/gu : /[\p{L}\p{N}]+/gu;
  return (String(texte || '').normalize('NFC').match(expression) || []).length;
}

function paireVoixPlausible(texteLatin, texteArabe) {
  const latin = compterMotsVoix(texteLatin, false);
  const arabe = compterMotsVoix(texteArabe, true);
  if (!latin || !arabe) return false;
  const ecart = Math.abs(latin - arabe);
  return ecart <= Math.max(2, Math.ceil(Math.max(latin, arabe) * 0.45));
}

async function ttsVoxCPM(env, texteAr) {
  if (!env || !env.VOXCPM_API_URL || !env.VOXCPM_API_TOKEN) throw new Error('VoxCPM non configuré');
  const endpoint = new URL('/v1/audio/speech', env.VOXCPM_API_URL);
  if (endpoint.protocol !== 'https:') throw new Error('URL VoxCPM doit utiliser HTTPS');
  const r = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.VOXCPM_API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text: texteAr }),
    signal: AbortSignal.timeout(240000)
  });
  if (!r.ok) {
    try { await r.body.cancel(); } catch (_) {}
    throw new Error('VoxCPM HTTP ' + r.status);
  }
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'audio/wav' && type !== 'audio/x-wav') {
    try { await r.body.cancel(); } catch (_) {}
    throw new Error('format VoxCPM invalide');
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  if (!estWav(audio)) throw new Error('audio VoxCPM invalide');
  verifierAudioVoxCPM(audio);
  return audio;
}

async function ttsVoxCPMZeroGPU(env, texteAr, tentativeCapacite = 0) {
  if (!env || !env.HF_VOXCPM_SPACE_URL || !env.HF_VOXCPM_TOKEN) {
    throw new Error('VoxCPM ZeroGPU non configuré');
  }
  const base = new URL(env.HF_VOXCPM_SPACE_URL);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.hf.space')) {
    throw new Error('URL du Space Hugging Face invalide');
  }
  const headers = {
    Authorization: 'Bearer ' + env.HF_VOXCPM_TOKEN,
    'Content-Type': 'application/json'
  };
  const submitUrl = new URL('/gradio_api/call/synthesize', base);
  const submit = await fetch(submitUrl.toString(), {
    method: 'POST', headers,
    body: JSON.stringify({ data: [texteAr] }),
    signal: AbortSignal.timeout(30000)
  });
  if (!submit.ok) {
    const status = submit.status;
    try { await submit.body.cancel(); } catch (_) {}
    throw erreurVoix(status === 429 ? 'quota VoxCPM temporairement indisponible' : 'VoxCPM ZeroGPU indisponible', status === 429 ? 'quota_unavailable' : 'provider_unavailable');
  }
  const queued = await submit.json();
  if (!queued || typeof queued.event_id !== 'string' || !queued.event_id) {
    throw new Error('réponse de mise en file ZeroGPU invalide');
  }

  const resultUrl = new URL('/gradio_api/call/synthesize/' + encodeURIComponent(queued.event_id), base);
  const result = await fetch(resultUrl.toString(), {
    headers: { Authorization: headers.Authorization },
    signal: AbortSignal.timeout(300000)
  });
  if (!result.ok) {
    const status = result.status;
    try { await result.body.cancel(); } catch (_) {}
    throw erreurVoix(status === 429 ? 'quota VoxCPM temporairement indisponible' : 'résultat VoxCPM indisponible', status === 429 ? 'quota_unavailable' : 'provider_unavailable');
  }
  const stream = await result.text();
  let resultatFinal = '';
  let evenement = '';
  for (const ligne of stream.split(/\r?\n/)) {
    if (ligne.startsWith('event:')) evenement = ligne.slice(6).trim();
    else if (ligne.startsWith('data:') && evenement === 'complete') resultatFinal = ligne.slice(5).trim();
    else if (ligne.startsWith('data:') && evenement === 'error') {
      const details = ligne.slice(5);
      const categorie = categorieErreurZeroGPU(details);
      if (categorie === 'gpu_capacity' && tentativeCapacite === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return ttsVoxCPMZeroGPU(env, texteAr, 1);
      }
      const quota = categorie === 'quota';
      const erreur = erreurVoix(quota ? 'quota VoxCPM temporairement indisponible' : 'génération VoxCPM échouée', quota ? 'quota_unavailable' : 'generation_failed');
      erreur.diagnosticZeroGPU = categorie;
      erreur.diagnosticDetail = detailDiagnosticZeroGPU(details);
      if (quota) erreur.retryAfterSeconds = secondesAvantRenouvellementZeroGPU(details);
      throw erreur;
    }
  }
  if (!resultatFinal) throw new Error('génération ZeroGPU incomplète');

  let sortie;
  try { sortie = JSON.parse(resultatFinal); } catch (_) { throw new Error('sortie ZeroGPU illisible'); }
  const fichier = Array.isArray(sortie) ? sortie[0] : null;
  if (!fichier || typeof fichier.url !== 'string') throw new Error('fichier audio ZeroGPU absent');
  const fichierUrl = new URL(fichier.url, base);
  if (fichierUrl.origin !== base.origin || !/^\/(gradio_api\/)?file=/.test(fichierUrl.pathname)) {
    throw new Error('URL du fichier audio ZeroGPU invalide');
  }
  const audioResponse = await fetch(fichierUrl.toString(), {
    headers: { Authorization: headers.Authorization },
    signal: AbortSignal.timeout(30000)
  });
  if (!audioResponse.ok) {
    try { await audioResponse.body.cancel(); } catch (_) {}
    throw new Error('téléchargement audio ZeroGPU HTTP ' + audioResponse.status);
  }
  const type = String(audioResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'audio/wav' && type !== 'audio/x-wav' && type !== 'application/octet-stream') {
    try { await audioResponse.body.cancel(); } catch (_) {}
    throw new Error('format audio ZeroGPU invalide');
  }
  const audio = new Uint8Array(await audioResponse.arrayBuffer());
  if (!estWav(audio)) throw erreurVoix('sortie audio VoxCPM invalide', 'invalid_audio');
  verifierAudioVoxCPM(audio);
  return audio;
}

/* ------------------------------------------------------------------ 1) Edge : voix tunisiennes */

const JETON_EDGE = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';   // jeton public du client Edge
/* En Workers, un WebSocket sortant s'obtient via fetch avec le schéma https:// et Upgrade: websocket
   (le schéma wss:// est refusé : « Fetch API cannot load »). */
const URL_EDGE = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
/* Voix arabes d'Edge, la tunisienne d'abord. */
const VOIX_EDGE = ['ar-TN-ReemNeural', 'ar-TN-HediNeural', 'ar-EG-SalmaNeural', 'ar-SA-ZariyahNeural'];

/** Jeton Sec-MS-GEC exigé par Edge : SHA-256 de l'horodatage (fenêtre de 5 min) + jeton public. */
async function jetonGec() {
  let t = Date.now() / 1000 + 11644473600;             // secondes écoulées depuis 1601
  t -= t % 300;                                        // fenêtre de 5 minutes
  const donnees = new TextEncoder().encode(String(Math.floor(t * 1e7)) + JETON_EDGE);
  const h = await crypto.subtle.digest('SHA-256', donnees);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function ssmlEdge(texte, voix) {
  const esc = String(texte).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ar-TN'>`
    + `<voice name='${voix}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${esc}</prosody></voice></speak>`;
}

/** Synthèse via le WebSocket « Read Aloud » d'Edge. Renvoie un Uint8Array MP3. */
async function ttsEdge(texte, voix, delaiMs) {
  const gec = await jetonGec();
  const identifiant = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = `${URL_EDGE}?TrustedClientToken=${JETON_EDGE}&ConnectionId=${identifiant}`
    + `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-130.0.2849.68`;

  /* Workers ne laisse pas choisir User-Agent : on n'envoie que les entêtes autorisés. */
  const reponse = await fetch(url, {
    headers: {
      Upgrade: 'websocket',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache'
    }
  });
  const ws = reponse.webSocket;
  if (!ws) throw new Error('websocket refuse (HTTP ' + reponse.status + ')');
  ws.accept();

  return await new Promise((resoudre, rejeter) => {
    const morceaux = [];
    let recu = '';
    const echouer = (m) => { try { ws.close(); } catch (_) {} rejeter(new Error(m)); };
    const minuteur = setTimeout(() => echouer('delai Edge depasse'), delaiMs);

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        recu += ev.data;
        if (recu.indexOf('Path:turn.end') !== -1) {
          clearTimeout(minuteur);
          const total = morceaux.reduce((n, m) => n + m.length, 0);
          const u8 = new Uint8Array(total);
          let p = 0;
          for (const m of morceaux) { u8.set(m, p); p += m.length; }
          try { ws.close(); } catch (_) {}
          if (!estMp3(u8)) return rejeter(new Error('audio Edge invalide (' + total + ' o)'));
          resoudre(u8);
        }
      } else {
        const buf = new Uint8Array(ev.data);
        /* Chaque trame binaire commence par « X-RequestId:…\r\nPath:audio\r\n » puis l'audio. */
        const marque = 'Path:audio\r\n';
        const texteTrame = new TextDecoder().decode(buf.subarray(0, 80));
        const i = texteTrame.indexOf(marque);
        if (i !== -1) morceaux.push(buf.subarray(i + marque.length));
      }
    });
    ws.addEventListener('error', () => { clearTimeout(minuteur); echouer('erreur websocket Edge'); });
    ws.addEventListener('close', () => { clearTimeout(minuteur); echouer('Edge a ferme avant la fin'); });

    const ts = new Date().toISOString();
    ws.send('X-Timestamp:' + ts + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
      + JSON.stringify({ context: { synthesis: { audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
    ws.send('X-RequestId:' + identifiant + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + ts
      + '\r\nPath:ssml\r\n\r\n' + ssmlEdge(texte, voix));
  });
}

/* ------------------------------------------------------------------ 2) Google Traduction (sans clé) */

const ENTETES_GOOGLE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://translate.google.com/'
};

/** Découpe en morceaux : l'API refuse au-delà d'environ 200 caractères. */
function morceaux(texte, taille) {
  const mots = String(texte).split(/\s+/).filter(Boolean);
  const out = [];
  let courant = '';
  for (const mot of mots) {
    if (courant && (courant.length + 1 + mot.length) > taille) { out.push(courant); courant = mot; }
    else courant = courant ? courant + ' ' + mot : mot;
  }
  if (courant) out.push(courant);
  return out.length ? out : [String(texte).slice(0, taille)];
}

/** Lit un texte avec la voix gratuite de Google Traduction. Renvoie un Uint8Array MP3. */
async function ttsGoogle(texte, langue, delaiMs) {
  const bouts = morceaux(texte, 180);
  const tampons = [];
  for (const bout of bouts) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl='
      + encodeURIComponent(langue) + '&q=' + encodeURIComponent(bout);
    const minuteur = new Promise((_, rej) => setTimeout(() => rej(new Error('delai Google depasse')), delaiMs));
    const r = await Promise.race([fetch(url, { headers: ENTETES_GOOGLE }), minuteur]);
    if (!r.ok) throw new Error('Google TTS HTTP ' + r.status);
    tampons.push(new Uint8Array(await r.arrayBuffer()));
  }
  const total = tampons.reduce((n, t) => n + t.length, 0);
  const u8 = new Uint8Array(total);
  let p = 0;
  for (const t of tampons) { u8.set(t, p); p += t.length; }
  if (!estMp3(u8)) throw new Error('audio Google invalide (' + total + ' o)');
  return u8;
}

/* ------------------------------------------------------------------ 3) Workers AI (dernier recours) */

async function ttsAura(env, texte) {
  for (const modele of ['@cf/deepgram/aura-2-en', '@cf/deepgram/aura-1']) {
    try {
      const s = await env.AI.run(modele, { text: texte });
      if (typeof s === 'string' && s.length > 100) return { audio: s, moteur: modele.replace('@cf/', '') };
      if (s instanceof ReadableStream) {
        const buf = new Uint8Array(await new Response(s).arrayBuffer());
        if (buf.length > 100) return { audio: enBase64(buf), moteur: modele.replace('@cf/', '') };
      }
      if (s && s.audio) return { audio: String(s.audio), moteur: modele.replace('@cf/', '') };
    } catch (_) { /* on passe au suivant */ }
  }
  throw new Error('aucun modele Workers AI n\'a produit d\'audio');
}

/* ------------------------------------------------------------------ route */

/* Microsoft a révoqué le jeton public d'Edge : les 4 voix échouent instantanément en 403. Retenter
   à chaque clash coûterait plus d'une seconde pour rien. On mémorise donc l'échec une heure : la
   voix arabe arrive alors au rythme de Google (quelques dizaines de ms), et si Microsoft rouvre
   l'accès un jour, la voix tunisienne revient toute seule au bout d'une heure. */
const DUREE_ECART = 3600e3;
let edgeEcartJusqua = 0;
const edgeEcart = () => Date.now() < edgeEcartJusqua;

async function fabriquerVoix(env, texteLat, texteAr, textePhonetique) {
  const journal = [];
  const note = (moteur, r) => journal.push(moteur + ' -> ' + r);
  const strictVoxCPM = voxcpmUniquement(env);

  if (env && env.HF_VOXCPM_TTS_ENABLED === 'true' && estArabe(texteAr)) {
    try {
      const u8 = await ttsVoxCPMZeroGPU(env, texteAr);
      note('voxcpm:zerogpu', u8.length + ' o');
      return { audio: enBase64(u8), mime: 'audio/wav', moteur: 'voxcpm:zerogpu', voix: 'voxcpm-tn',
        arabe: true, texteLu: texteAr, tunisienne: true, journal: journal };
    } catch (e) {
      note('voxcpm:zerogpu', 'echec: ' + String(e && e.code ? e.code : 'generation_failed'));
      if (strictVoxCPM) throw e;
    }
  } else if (strictVoxCPM) {
    throw erreurVoix('VoxCPM ne peut pas lire ce texte ; aucune voix de remplacement ne sera utilisée.', 'text_unavailable');
  }

  if (strictVoxCPM) throw erreurVoix('VoxCPM est temporairement indisponible. Réessaie plus tard.', 'provider_unavailable');

  if (env && env.VOXCPM_TTS_ENABLED === 'true' && estArabe(texteAr)) {
    try {
      const u8 = await ttsVoxCPM(env, texteAr);
      note('voxcpm:tn', u8.length + ' o');
      return { audio: enBase64(u8), mime: 'audio/wav', moteur: 'voxcpm:tn', voix: 'voxcpm-tn',
        arabe: true, texteLu: texteAr, tunisienne: true, journal: journal };
    } catch (e) { note('voxcpm:tn', 'echec: ' + String(e && e.message ? e.message : e).slice(0, 60)); }
  }

  if (env && env.BAARCHA_TTS_ENABLED === 'true' && env.BAARCHA_API_KEY && (texteLat || texteAr)) {
    try {
      const u8 = await ttsBaarcha(env, texteLat || texteAr);
      note('baarcha:dido', u8.length + ' o');
      return { audio: enBase64(u8), mime: 'audio/mpeg', moteur: 'baarcha:dido',
        voix: env.BAARCHA_VOICE || 'dido', arabe: false, texteLu: texteLat || texteAr, tunisienne: true, journal: journal };
    } catch (e) { note('baarcha:dido', 'echec: ' + String(e && e.message ? e.message : e).slice(0, 60)); }
  }

  /* 1. Voix neurale tunisienne Azure (clé gardée dans les secrets du Worker). */
  if (estArabe(texteAr) && env && env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION) {
    for (const voix of ['ar-TN-ReemNeural', 'ar-TN-HediNeural']) {
      try {
        const u8 = await ttsAzure(env, texteAr, voix);
        note('azure:' + voix, u8.length + ' o');
        return { audio: enBase64(u8), mime: 'audio/mpeg', moteur: 'azure:' + voix,
          voix: voix, arabe: true, texteLu: texteAr, tunisienne: true, journal: journal };
      } catch (e) { note('azure:' + voix, 'echec: ' + String(e && e.message ? e.message : e).slice(0, 60)); }
    }
  } else if (estArabe(texteAr)) {
    note('azure:ar-TN', 'non configuré');
  }

  /* 2. Ancienne voix Edge, conservée comme repli temporaire. */
  if (estArabe(texteAr) && !edgeEcart()) {
    try {
      const u8 = await ttsEdge(texteAr, VOIX_EDGE[0], DELAI_EDGE);
      note(VOIX_EDGE[0], u8.length + ' o');
      edgeEcartJusqua = 0;
      return { audio: enBase64(u8), mime: 'audio/mpeg', moteur: 'edge:' + VOIX_EDGE[0],
        voix: VOIX_EDGE[0], arabe: true, texteLu: texteAr, tunisienne: true, journal: journal };
    } catch (e) {
      edgeEcartJusqua = Date.now() + DUREE_ECART;
      note(VOIX_EDGE[0], 'echec: ' + String(e && e.message ? e.message : e).slice(0, 60));
    }
  } else if (estArabe(texteAr)) {
    note('edge', 'ecarte (echec recent)');
  }

  /* 3. Arabe de Google, toujours sur le texte arabe : rapide, gratuit, prononciation correcte. */
  if (estArabe(texteAr)) {
    try {
      const u8 = await ttsGoogle(texteAr, 'ar', DELAI_HTTP);
      note('google:ar', u8.length + ' o');
      return { audio: enBase64(u8), mime: 'audio/mpeg', moteur: 'google:ar', voix: 'ar', arabe: true,
        texteLu: texteAr, tunisienne: false, journal: journal };
    } catch (e) { note('google:ar', 'echec: ' + String(e && e.message ? e.message : e).slice(0, 60)); }
  }

  /* 4. Translittération lue par une voix française : les phonèmes de la derja passent mieux
        en français qu'en anglais. */
  const texteRepliLatin = textePhonetique || texteLat;
  if (texteRepliLatin) {
    try {
      const u8 = await ttsGoogle(texteRepliLatin, 'fr', DELAI_HTTP);
      note('google:fr', u8.length + ' o');
      return { audio: enBase64(u8), mime: 'audio/mpeg', moteur: 'google:fr', voix: 'fr', arabe: false,
        texteLu: texteRepliLatin, tunisienne: false, journal: journal };
    } catch (e) { note('google:fr', 'echec: ' + String(e && e.message ? e.message : e).slice(0, 60)); }
  }

  /* 5. Dernier recours : Workers AI (voix anglaise). */
  if (env && env.AI) {
    try {
      const texteIA = texteRepliLatin || texteAr;
      const r = await ttsAura(env, texteIA);
      note(r.moteur, 'ok');
      return { audio: r.audio, mime: 'audio/mpeg', moteur: r.moteur, voix: 'en', arabe: false,
        texteLu: texteIA, tunisienne: false, journal: journal };
    } catch (e) { note('workers-ai', 'echec: ' + String(e && e.message ? e.message : e).slice(0, 60)); }
  }

  const e = new Error('aucun moteur de voix disponible');
  e.journal = journal;
  throw e;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const didoActif = env.BAARCHA_TTS_ENABLED === 'true' && !!env.BAARCHA_API_KEY;
      const voxcpmActif = env.VOXCPM_TTS_ENABLED === 'true' && !!env.VOXCPM_API_URL && !!env.VOXCPM_API_TOKEN;
      const hfVoxCpmActif = env.HF_VOXCPM_TTS_ENABLED === 'true' && !!env.HF_VOXCPM_SPACE_URL && !!env.HF_VOXCPM_TOKEN;
      const rolloutPercent = pourcentageRollout(env);
      const voxcpmEtat = env.HF_VOXCPM_TTS_ENABLED !== 'true' ? 'disabled'
        : !hfVoxCpmActif ? 'misconfigured'
          : rolloutPercent === 0 ? 'pilot_closed' : 'configured_not_probed';
      return json({ ok: true, service: 'clash-voice', ia: !!env.AI, dido: didoActif,
        didoLimite: didoActif && !!env.VOICE_LIMITER,
        politiqueVoix: env.VOICE_POLICY || 'voxcpm_only', voxcpmPret: !!hfVoxCpmActif,
        voxcpmEtat: voxcpmEtat,
        etatSignification: 'État de configuration uniquement ; aucun appel de synthèse ni test de disponibilité du fournisseur n’est effectué.',
        versionVoix: String(env.VOXCPM_CACHE_VERSION || 'voxcpm-tn-v1'),
        rolloutPercent: rolloutPercent,
        moteurs: voxcpmUniquement(env) ? (hfVoxCpmActif ? ['voxcpm:zerogpu'] : [])
          : [ ...(hfVoxCpmActif ? ['voxcpm:zerogpu'] : []), ...(voxcpmActif ? ['voxcpm:tn'] : []), ...(didoActif ? ['baarcha:dido'] : []), 'azure:ar-TN', 'edge:ar-TN', 'google:ar', 'google:fr', 'workers-ai:en' ] });
    }

    /* Diagnostic : dit quel moteur répond, sans renvoyer l'audio. */
    if (url.pathname === '/diagnostic') {
      const diagnosticToken = String(env.VOICE_DIAGNOSTIC_TOKEN || '');
      if (env.VOICE_DIAGNOSTIC_ENABLED !== 'true' || !diagnosticToken
          || request.headers.get('authorization') !== 'Bearer ' + diagnosticToken) {
        return json({ ok: false, code: 'diagnostic_disabled', error: 'Diagnostic vocal désactivé.' }, 404);
      }
      const phraseAr = 'يا سامي إنتي كي الحوت في ظلام';
      const phraseLat = 'Ya Sami enti ki el hout fi tzlam';
      const out = { edge: {}, google: {} };
      for (const voix of VOIX_EDGE) {
        const t0 = Date.now();
        try { const u8 = await ttsEdge(phraseAr, voix, DELAI_EDGE);
          out.edge[voix] = { ok: true, octets: u8.length, ms: Date.now() - t0 }; }
        catch (e) { out.edge[voix] = { ok: false, erreur: String(e && e.message ? e.message : e).slice(0, 120), ms: Date.now() - t0 }; }
      }
      for (const [nom, txt, lg] of [['ar', phraseAr, 'ar'], ['fr', phraseLat, 'fr']]) {
        const t0 = Date.now();
        try { const u8 = await ttsGoogle(txt, lg, DELAI_HTTP);
          out.google[nom] = { ok: true, octets: u8.length, ms: Date.now() - t0 }; }
        catch (e) { out.google[nom] = { ok: false, erreur: String(e && e.message ? e.message : e).slice(0, 120), ms: Date.now() - t0 }; }
      }
      return json({ ok: true, diagnostic: out }, 200);
    }

    if (url.pathname === '/voix' && request.method !== 'POST') {
      const response = json({ ok: false, code: 'method_not_allowed', error: 'La synthèse accepte uniquement POST ; le texte ne doit pas être envoyé dans une URL.' }, 405);
      response.headers.set('allow', 'POST, OPTIONS');
      return response;
    }

    if (url.pathname === '/voix' && request.method === 'POST') {
      if (env.VOICE_PILOT_AUTH_REQUIRED === 'true') {
        const pilotToken = String(env.VOICE_PILOT_TOKEN || '');
        if (!pilotToken) {
          return json({ ok: false, code: 'pilot_auth_unconfigured', error: 'Le verrou opérateur du pilote n’est pas configuré.', retryable: false }, 503);
        }
        if (request.headers.get('authorization') !== 'Bearer ' + pilotToken) {
          return json({ ok: false, code: 'pilot_auth_required', error: 'Accès réservé au test opérateur.', retryable: false }, 403);
        }
      }
      let corps = null;
      try { corps = await request.json(); } catch (e) { return json({ ok: false, error: 'corps illisible' }, 400); }

      const texteLat = String((corps && corps.text) || '').normalize('NFC').replace(/\s+/g, ' ').trim();
      const texteAr = String((corps && corps.ar) || '').normalize('NFC').replace(/\s+/g, ' ').trim();
      const textePhonetique = texteLat;
      if (texteLat.length < 2 && texteAr.length < 2) return json({ ok: false, error: 'texte trop court' }, 400);
      if (texteLat.length > LONGUEUR_MAX || texteAr.length > LONGUEUR_MAX) {
        return json({ ok: false, code: 'text_too_long', error: 'Le clash dépasse la longueur prise en charge. Raccourcis-le ; aucun texte n’a été tronqué.', retryable: false }, 413);
      }
      if (texteLat && estArabe(texteAr) && !paireVoixPlausible(texteLat, texteAr)) {
        return json({ ok: false, code: 'text_pair_mismatch', error: 'Les textes affiché et vocalisé semblent trop différents ; la synthèse est suspendue pour éviter une lecture incorrecte.', retryable: false }, 422);
      }

      const didoActif = env.BAARCHA_TTS_ENABLED === 'true' && env.BAARCHA_API_KEY;
      const voxcpmActif = env.VOXCPM_TTS_ENABLED === 'true' && env.VOXCPM_API_URL && env.VOXCPM_API_TOKEN;
      const hfVoxCpmActif = env.HF_VOXCPM_TTS_ENABLED === 'true' && env.HF_VOXCPM_SPACE_URL && env.HF_VOXCPM_TOKEN;
      const canariVoxCPM = env.VOICE_POLICY === 'voxcpm_canary';
      const participantCanari = canariVoxCPM && await autoriserCohorteVoxCPM(request, env);
      if (canariVoxCPM && !participantCanari) {
        return json({ ok: false, code: 'pilot_not_enabled', error: 'La voix VoxCPM n’est pas encore activée pour cette demande ; le test est limité à un petit groupe.', retryable: false, rolloutPercent: pourcentageRollout(env) }, 503);
      }
      const envSynthese = canariVoxCPM ? { ...env, VOICE_POLICY: 'voxcpm_only' } : env;
      const hfVoxCpmDisponible = envSynthese.HF_VOXCPM_TTS_ENABLED === 'true'
        && envSynthese.HF_VOXCPM_SPACE_URL && envSynthese.HF_VOXCPM_TOKEN;
      const strictVoxCPM = voxcpmUniquement(envSynthese);
      if (strictVoxCPM && (!hfVoxCpmActif || !estArabe(texteAr))) {
        const code = !estArabe(texteAr) ? 'text_unavailable' : 'provider_unavailable';
        const message = code === 'text_unavailable'
          ? 'Version vocalisée du texte indisponible. Le clash reste lisible, sans voix de remplacement.'
          : 'VoxCPM est temporairement indisponible. Le clash reste lisible ; réessaie plus tard.';
        return json({ ok: false, code, error: message, retryable: code === 'provider_unavailable' }, code === 'text_unavailable' ? 422 : 503);
      }
      if (!canariVoxCPM && strictVoxCPM && !(await autoriserCohorteVoxCPM(request, env))) {
        return json({ ok: false, code: 'pilot_not_enabled', error: 'La voix VoxCPM est encore en pilote fermé. Le texte du clash reste disponible.', retryable: false, rolloutPercent: pourcentageRollout(env) }, 503);
      }

      let cache = null;
      let cacheKey = null;
      if (hfVoxCpmDisponible && estArabe(texteAr) && typeof caches !== 'undefined' && caches.default) {
        try {
          cache = caches.default;
          cacheKey = await cleCacheVoix(texteAr, env, url.origin);
          const cached = await cache.match(cacheKey);
          if (cached) {
            console.log(JSON.stringify({ event: 'voice', provider: 'voxcpm:zerogpu', result: 'cache_hit' }));
            return json(await cached.json());
          }
        } catch (_) { cache = null; cacheKey = null; }
      }

      if ((didoActif || voxcpmActif || hfVoxCpmDisponible) && !(strictVoxCPM && !hfVoxCpmDisponible)) {
        if (!env.VOICE_LIMITER || typeof env.VOICE_LIMITER.limit !== 'function') {
          return json({ ok: false, code: 'provider_unavailable', error: 'Limiteur vocal indisponible.', retryable: true }, 503);
        }
        const limite = await env.VOICE_LIMITER.limit({ key: await cleLimitationVoix(request) });
        if (!limite.success) return json({ ok: false, code: 'rate_limited', error: 'Trop de demandes rapprochées. Réessaie dans une minute.', retryable: true }, 429);
      }

      const startedAt = Date.now();
      try {
        const v = await fabriquerVoix(envSynthese, texteLat, texteAr, textePhonetique);
        const payload = {
          ok: true,
          audio: v.audio,
          mime: v.mime || 'audio/mpeg',
          moteur: v.moteur,
          voix: v.voix,
          arabe: !!v.arabe,
          texteLu: String(v.texteLu || '').slice(0, LONGUEUR_MAX),
          tunisienne: !!v.tunisienne,
          version: String(env.VOXCPM_CACHE_VERSION || 'voxcpm-tn-v1'),
          lang: String((corps && corps.lang) || 'fr').slice(0, 2),
          journal: v.journal,
          octets: Math.round(String(v.audio).length * 3 / 4)
        };
        if (cache && cacheKey && v.moteur === 'voxcpm:zerogpu' && String(v.audio).length <= 4_000_000) {
          try {
            await cache.put(cacheKey, new Response(JSON.stringify(payload), {
              headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' }
            }));
          } catch (_) {}
        }
        console.log(JSON.stringify({ event: 'voice', provider: String(v.moteur || 'unknown'), result: 'success', bytes: payload.octets, durationMs: Date.now() - startedAt }));
        return json(payload);
      } catch (e) {
        const code = String(e && e.code || 'generation_failed');
        const status = code === 'quota_unavailable' ? 429 : code === 'provider_unavailable' ? 503
          : code === 'text_unavailable' ? 422 : 502;
        console.log(JSON.stringify({ event: 'voice', provider: 'voxcpm:zerogpu', result: code, durationMs: Date.now() - startedAt }));
        const diagnostic = env.VOICE_PILOT_AUTH_REQUIRED === 'true' && e && e.diagnosticZeroGPU
          ? messageDiagnosticZeroGPU(e.diagnosticZeroGPU) : String(e && e.message ? e.message : 'Synthèse indisponible').slice(0, 160);
        const body = { ok: false, code, error: diagnostic,
          retryable: status === 429 || status === 503 || status === 502 };
        if (Number.isFinite(e && e.retryAfterSeconds) && e.retryAfterSeconds > 0) {
          body.retryAfterSeconds = e.retryAfterSeconds;
        }
        if (env.VOICE_PILOT_AUTH_REQUIRED === 'true' && e && e.diagnosticZeroGPU) {
          body.diagnostic = { category: e.diagnosticZeroGPU, detail: e.diagnosticDetail || '' };
        }
        return json(body, status);
      }
    }

    return json({ ok: false, error: 'route inconnue' }, 404);
  }
};
