import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const html = await fs.readFile(path.join(root, 'www', 'index.html'), 'utf8');
const start = html.indexOf('function visionPrompt(name, lvl) {');
const end = html.indexOf('async function traitsWithKey(url) {', start);
if (start < 0 || end < 0) throw new Error('Updated Clash AI visionPrompt() not found.');
const makePrompt = new Function('lireClashsRecents', `${html.slice(start, end)}; return visionPrompt;`)(() => []);
const prompt = makePrompt('', 1) + `\nRègle prioritaire de langue : la réplique doit sonner comme une phrase qu’un Tunisien dirait spontanément à un ami, pas comme une phrase traduite. Repère de syntaxe naturelle (ne pas recopier) : « t7eb t9oud el groupe ama chkoun yasma3lek ? ». Emploie une construction idiomatique de derja ; les emprunts français courants sont permis uniquement s’ils sont vraiment naturels. N’emploie pas « personnage », « jeu vidéo », « ki mta3 », « fard wa9t » ni une comparaison mécanique. Le visage dessiné a un grand sourire fixe, de grands yeux et un haut sombre : choisis un seul de ces détails et fais une taquinerie courte et complice. N’insère « mta3ek » que si la grammaire de la phrase le demande, et écris-le exactement « mta3ek ». N’imite aucun clash existant et n’ajoute aucun détail absent de l’image.`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="640" viewBox="0 0 512 640"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3a6ea5"/><stop offset="1" stop-color="#12203a"/></linearGradient></defs><rect width="512" height="640" fill="url(#bg)"/><ellipse cx="256" cy="210" rx="96" ry="120" fill="#9c6b4a"/><ellipse cx="256" cy="130" rx="100" ry="66" fill="#1a1a1a"/><rect x="150" y="330" width="212" height="310" fill="#2b2b2b"/><circle cx="222" cy="200" r="15" fill="#e8e8e8"/><circle cx="290" cy="200" r="15" fill="#e8e8e8"/><circle cx="222" cy="200" r="6" fill="#111"/><circle cx="290" cy="200" r="6" fill="#111"/><path d="M 215 253 A 42 42 0 0 0 297 253" fill="none" stroke="#6b3a2a" stroke-width="7"/></svg>`;
const b64 = (await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer()).toString('base64');
const response = await fetch('https://clash-gemini-proxy.asser-dev.workers.dev/clash', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://clash-ai.pages.dev' },
  body: JSON.stringify({ model: 'gemini-3.6-flash', prompt, b64 })
});
const result = await response.json();
if (!response.ok || !result.ok || !result.text) throw new Error(`Clash AI proxy failed (HTTP ${response.status}): ${result.error || 'empty response'}`);
const text = String(result.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
let verdict;
try { verdict = JSON.parse(text); } catch { throw new Error('Clash AI returned non-JSON; no repair request sent.'); }
if (!verdict.punchline || !verdict.punchline_ar) throw new Error('Clash AI output lacks punchline or punchline_ar.');
const output = path.join(root, 'backend', 'voice', 'voxcpm-corpus-clash-ai-20261029-input');
await fs.mkdir(output, { recursive: true });
const pair = { version: 1, source: 'Clash AI production visionPrompt v2, drawn demo image', model: result.model || 'gemini-3.6-flash', generated_at: new Date().toISOString(), punchline: verdict.punchline, punchline_ar: verdict.punchline_ar };
const filename = 'clash-ai-voice-pilot-prompt-v4.json';
await fs.writeFile(path.join(output, filename), JSON.stringify(pair, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
process.stdout.write(JSON.stringify({ model: pair.model, punchline: pair.punchline, punchline_ar: pair.punchline_ar, http_status: response.status, output: filename }) + '\n');
