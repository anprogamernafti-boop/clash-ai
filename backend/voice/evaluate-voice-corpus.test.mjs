import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRows, parseTsv } from './evaluate-voice-corpus.mjs';

const header = 'phrase_id\tsample_file\tmodel_version\tlistener_id\tlistener_tunisian_derja_fluent\taccent_natural_1_to_5\tunderstood\twords_correct\tcomplete\tpace_ok';

function makeRows(failures = 0) {
  const rows = [];
  for (let phrase = 0; phrase < 100; phrase++) {
    for (let listener = 0; listener < 3; listener++) {
      const failed = listener === 0 && phrase < failures;
      rows.push({
        phrase_id: `phrase-${phrase + 1}`,
        sample_file: `audio-${phrase + 1}.wav`,
        model_version: 'voxcpm-tn-canary-v1',
        listener_id: `listener-${listener + 1}`,
        listener_tunisian_derja_fluent: 'yes',
        problem_note: '',
        accent_natural_1_to_5: failed ? '3' : '5',
        understood: 'yes',
        words_correct: 'yes',
        complete: 'yes',
        pace_ok: 'yes'
      });
    }
  }
  return rows;
}

test('accepts 99 percent only on a complete 100-phrase, three-listener corpus', () => {
  const report = evaluateRows(makeRows(3));
  assert.equal(report.ok, true);
  assert.equal(report.phraseCount, 100);
  assert.equal(report.evaluationCount, 300);
  assert.equal(report.acceptanceRate, 0.99);
  assert.equal(report.modelVersion, 'voxcpm-tn-canary-v1');
});

test('rejects a corpus below the 99 percent listening threshold', () => {
  const report = evaluateRows(makeRows(4));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes('inférieur à 99 %')));
});

test('does not count ratings from listeners who do not attest Tunisian Derja fluency', () => {
  const rows = makeRows();
  rows[0].listener_tunisian_derja_fluent = 'no';
  const report = evaluateRows(rows);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes('attester maîtriser la Derja tunisienne')));
});

test('surfaces recurring word-level feedback without changing the listening score', () => {
  const rows = makeRows();
  rows[0].problem_note = 'shay → chay';
  rows[1].problem_note = 'SHAY → CHAY';
  const report = evaluateRows(rows);
  assert.equal(report.ok, true);
  assert.equal(report.acceptanceRate, 1);
  assert.deepEqual(report.mostReportedIssues, [{ note: 'shay → chay', count: 2 }]);
});

test('rejects missing reviewers, duplicate reviews, and invalid answers', () => {
  const rows = makeRows();
  rows[1] = { ...rows[0] };
  rows[2].words_correct = 'maybe';
  const report = evaluateRows(rows);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes('dupliquée')));
  assert.ok(report.errors.some((error) => error.includes('yes/no invalides')));
});

test('does not let one audio file count as several distinct phrases', () => {
  const rows = makeRows();
  rows.filter((row) => row.phrase_id === 'phrase-2').forEach((row) => { row.sample_file = 'audio-1.wav'; });
  const report = evaluateRows(rows);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes('plusieurs phrases')));
});

test('rejects identical audio content renamed as distinct phrases', () => {
  const rows = makeRows();
  const hashes = new Map(rows.map((row) => [row.sample_file, `unique-${row.phrase_id}`]));
  hashes.set('audio-2.wav', hashes.get('audio-1.wav'));
  const report = evaluateRows(rows, [], hashes);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes('contenu audio identique')));
});

test('rejects mixed model versions in the same listening result', () => {
  const rows = makeRows();
  rows[0].model_version = 'voxcpm-next';
  const report = evaluateRows(rows);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes('mélange plusieurs versions')));
});

test('parses a tab-separated rating file and reports absent columns', () => {
  const parsed = parseTsv(`${header}\nphrase-1\taudio.wav\tvoxcpm-v1\tlistener-1\tyes\t5\tyes\tyes\tyes\tyes`);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].phrase_id, 'phrase-1');
  assert.ok(parseTsv('phrase_id\tlistener_id').errors.some((error) => error.includes('Colonne manquante')));
});
