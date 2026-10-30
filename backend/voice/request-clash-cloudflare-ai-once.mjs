import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const html = await fs.readFile(path.join(root, 'www', 'index.html'), 'utf8');
const start = html.indexOf('function visionPrompt(name, lvl) {');
const end = html.indexOf('async function traitsWithKey(url) {', start);
if (start < 0 || end < 0) throw new Error('Clash AI visionPrompt() introuvable.');
const useGemini = process.env.CLASH_AI_PROVIDER === 'gemini';
const useQwen = process.env.CLASH_AI_PROVIDER === 'qwen';
const knownClashes = useGemini || useQwen ? [
  '3neynik lkbar hka t9oul 3lik masdoum mel khabar el 9dim.',
  'dha7ktek hedhi t9oul fama 7keya ama ma t7ebbech t9oul 3lech',
  'dha7ktek mta3 wa7ed fhem el 7ala w 9a3ed yestanna fi lferja',
  'dha7ktek hedhi mta3ek msajjla w t3awed fiha dima hka',
  'dha7ktek mta3 wa7ed fhem kol chay ama 7abb yeb9a sakt',
  'dha7ktek mta3 wa7ed fhem el denya w hareb minha',
  'ya sa7bi chbiha dha7ktek mta3 wa7ed fhem el denya w hareb minha',
  'ya sa7bi chbiha dha7ektek mta3 wa7ed fhem el denya w hareb minha',
  'dhahktek hedhi mta3 wa7ed sma3 khbar yefra7 w ma fhem mennou chay',
  'Ya Yassine el wa9fa mte3ek tgoul photo d\'identité mte3 passeport w enti fer7an bcha3rek.'
] : [];
const prompt = new Function('lireClashsRecents', `${html.slice(start, end)}; return visionPrompt;`)(() => knownClashes)('', 2)
  + (useQwen
    ? '\nPour cet essai texte, la photo démo représente un avatar dessiné au grand sourire fixe, aux grands yeux ronds, cheveux foncés, haut sombre sur fond bleu. Choisis un seul détail visible et écris une nouvelle taquinerie en derja tunisienne parlée, 9 à 13 mots, sans français ni anglais, ni mot inventé, ni arabe standard. Les exemples récents ci-dessus sont interdits à la copie et à la paraphrase. Retourne exactement le JSON demandé; la version arabe doit transcrire les mêmes mots dans le même ordre en derja tunisienne.'
    : useGemini
    ? '\nPour cette génération, focalise-toi uniquement sur les grands yeux ronds visibles. Ne parle pas du sourire, des vêtements, d’un jeu ou d’une photo. N’utilise pas « dha7ektek » ni « mta3 ». Écris une seule phrase neuve de 9 à 13 mots en derja tunisienne vraiment courante, sans français, anglais, mot inventé ni arabe standard. Choisis une construction simple et idiomatique; si tu doutes d’un mot, remplace la phrase entière par une tournure plus simple. Écris sa transcription en alphabet arabe tunisien, mêmes mots et même ordre.'
    : '\nRègle de contrôle : crée une réplique réellement nouvelle en derja tunisienne courante. Aucune expression inventée ni traduction littérale. Utilise seulement des mots courts et familiers, 9 à 13 mots. La version arabe doit transcrire les mêmes mots dans le même ordre; conserve en latin seulement les emprunts français indispensables.');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="640" viewBox="0 0 512 640"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3a6ea5"/><stop offset="1" stop-color="#12203a"/></linearGradient></defs><rect width="512" height="640" fill="url(#bg)"/><ellipse cx="256" cy="210" rx="96" ry="120" fill="#9c6b4a"/><ellipse cx="256" cy="130" rx="100" ry="66" fill="#1a1a1a"/><rect x="150" y="330" width="212" height="310" fill="#2b2b2b"/><circle cx="222" cy="200" r="15" fill="#e8e8e8"/><circle cx="290" cy="200" r="15" fill="#e8e8e8"/><circle cx="222" cy="200" r="6" fill="#111"/><circle cx="290" cy="200" r="6" fill="#111"/><path d="M 215 253 A 42 42 0 0 0 297 253" fill="none" stroke="#6b3a2a" stroke-width="7"/></svg>`;
const b64 = (await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer()).toString('base64');
const modelRoute = useGemini
  ? '/clash'
  : useQwen ? '/clash-cloudflare-qwen'
    : process.env.CLOUDFLARE_PILOT_MODEL === 'llama4' ? '/clash-cloudflare-llama4' : '/clash-cloudflare';
const model = useGemini ? 'gemini-3.6-flash' : '';
const response = await fetch('https://clash-gemini-proxy.asser-dev.workers.dev' + modelRoute, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://clash-ai.pages.dev' },
  body: JSON.stringify({ ...(model ? { model } : {}), prompt, ...(!useQwen ? { b64 } : {}) })
});
const result = await response.json().catch(() => ({}));
if (!response.ok || !result.ok || !result.text) {
  throw new Error(`${useGemini ? 'Gemini' : 'Workers AI'} a échoué (HTTP ${response.status}) : ${result.error || 'réponse vide'}${result.detail ? ` — ${result.detail}` : ''}`);
}
const clean = String(result.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
let verdict;
try { verdict = JSON.parse(clean); } catch { throw new Error(`${useGemini ? 'Gemini' : useQwen ? 'Qwen' : 'Gemma'} n’a pas renvoyé un JSON exploitable : ${clean.slice(0, 500)}`); }
if (!verdict.punchline || !verdict.punchline_ar) throw new Error('Réponse Gemma incomplète : punchline ou arabe absent.');
const punchline = String(verdict.punchline).trim();
const arabicPunchline = String(verdict.punchline_ar).trim();
const wordCount = punchline.split(/\s+/).filter(Boolean).length;
if (/[\u0600-\u06FF]/.test(punchline)) throw new Error('Réplique latin invalide : elle contient déjà de l’arabe. Aucun export créé.');
if (!/[\u0600-\u06FF]/.test(arabicPunchline)) throw new Error('Transcription arabe absente ou en Arabizi. Aucun export créé.');
if (wordCount < 8 || wordCount > 15) throw new Error(`Réplique hors longueur cible (${wordCount} mots). Aucun export créé.`);

const output = path.join(root, 'backend', 'voice', useGemini ? 'voxcpm-corpus-gemini-retest-drafts' : useQwen ? 'voxcpm-corpus-qwen-drafts' : 'voxcpm-corpus-cloudflare-ai-drafts');
await fs.mkdir(output, { recursive: true });
const pair = {
  version: 1,
  source: `Clash AI production visionPrompt v2, illustration démo; ${useGemini ? 'Gemini proxy' : `Cloudflare Workers AI ${result.model || 'model inconnu'}`}`,
  model: result.model || (useGemini ? model : useQwen ? '@cf/qwen/qwen3-30b-a3b-fp8' : '@cf/google/gemma-4-26b-a4b-it'),
  generated_at: new Date().toISOString(),
  punchline,
  punchline_ar: arabicPunchline
};
const normalizePunchline = value => String(value || '')
  .normalize('NFKC').toLocaleLowerCase('fr')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const candidateKey = normalizePunchline(pair.punchline);
for (const folder of [
  path.join(root, 'backend', 'voice', 'voxcpm-corpus-next-clash-ai-input'),
  output
]) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const previous = await fs.readFile(path.join(folder, entry.name), 'utf8').then(JSON.parse).catch(() => null);
    if (previous && normalizePunchline(previous.punchline) === candidateKey) {
      throw new Error(`Réplique déjà présente; aucun export pilote créé : ${entry.name}`);
    }
  }
}
const filename = `clash-ai-voice-pilot-cloudflare-${Date.now()}.json`;
await fs.writeFile(path.join(output, filename), JSON.stringify(pair, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
process.stdout.write(JSON.stringify({ ...pair, output: filename, http_status: response.status }, null, 2) + '\n');
