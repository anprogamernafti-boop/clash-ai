import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../www/index.html', import.meta.url), 'utf8');
const modeStart = html.indexOf('function utiliserModeVocalPilote(');
const modeEnd = html.indexOf('\nconst VOICE_PILOT_MODE', modeStart);
const modeContext = { URLSearchParams };
vm.runInNewContext(html.slice(modeStart, modeEnd) + '\nglobalThis.modePilote = utiliserModeVocalPilote;', modeContext);

test('keeps production traffic on the public endpoint by default', () => {
  assert.equal(modeContext.modePilote({ hostname: 'clash-ai.pages.dev', protocol: 'https:', search: '' }), false);
});

test('routes only the explicit operator query flag to the protected pilot endpoint', () => {
  assert.equal(modeContext.modePilote({ hostname: 'clash-ai.pages.dev', protocol: 'https:', search: '?voicePilot=1' }), true);
  assert.equal(modeContext.modePilote({ hostname: 'clash-ai.pages.dev', protocol: 'https:', search: '?voicePilot=true' }), false);
  assert.match(html, /const api = VOICE_PILOT_MODE \? VOICE_PILOT_API : VOICE_API;/);
});

test('keeps local pilot access and collects its operator token in a password field', () => {
  assert.equal(modeContext.modePilote({ hostname: 'localhost', protocol: 'http:', search: '' }), true);
  assert.equal(modeContext.modePilote({ hostname: '127.0.0.1', protocol: 'http:', search: '' }), true);
  const tokenStart = html.indexOf('function obtenirJetonVoixPilote()');
  const tokenEnd = html.indexOf('\nfunction demanderAudioVoix', tokenStart);
  const tokenSource = html.slice(tokenStart, tokenEnd);
  assert.match(tokenSource, /champ\.type = 'password'/);
  assert.match(tokenSource, /dialogue\.showModal\(\)/);
  assert.doesNotMatch(tokenSource, /window\.prompt|localStorage|sessionStorage/);
  assert.match(html, /headers\.authorization = 'Bearer ' \+ await obtenirJetonVoixPilote\(\);/);
});

test('keeps all inline application scripts syntactically valid', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes, source]) => source.trim() && !/application\/(?:ld\+)?json/i.test(attributes));
  assert.ok(scripts.length > 0);
  for (const [, , source] of scripts) assert.doesNotThrow(() => new vm.Script(source));
});
