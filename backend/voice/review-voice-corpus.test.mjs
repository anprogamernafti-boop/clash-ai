import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('./review-voice-corpus.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];

test('blind listening page JavaScript parses', () => {
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('keeps transcript hidden until the listener rates the accent', () => {
  assert.match(html, /<section id="textStage" hidden>/);
  const revealStart = script.indexOf('function revealText()');
  const revealEnd = script.indexOf('\n    function saveReview()', revealStart);
  assert.ok(revealStart >= 0 && revealEnd > revealStart);
  const reveal = script.slice(revealStart, revealEnd);
  assert.ok(reveal.indexOf("checkedValue('accent')") < reveal.indexOf("textStage').hidden = false"));
});

test('review page does not send selected audio, transcripts, or ratings over the network', () => {
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/);
  assert.match(script, /crypto\.subtle\.digest\('SHA-256'/);
});

test('exports the exact rating schema expected by the corpus evaluator', () => {
  const fields = ['phrase_id', 'sample_file', 'model_version', 'listener_id', 'listener_tunisian_derja_fluent', 'accent_natural_1_to_5', 'understood', 'words_correct', 'complete', 'pace_ok', 'problem_note'];
  assert.ok(fields.every((field) => script.includes(`'${field}'`)));
});

test('collects optional word-level feedback without sending it anywhere', () => {
  assert.match(html, /id="problemNote" type="text" maxlength="200"/);
  assert.match(script, /problem_note: document\.getElementById\('problemNote'\)/);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/);
});
