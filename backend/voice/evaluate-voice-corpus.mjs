import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_PHRASES = 100;
export const MIN_LISTENERS_PER_PHRASE = 3;
export const MIN_ACCEPTANCE_RATE = 0.99;

const REQUIRED_FIELDS = [
  'phrase_id',
  'sample_file',
  'model_version',
  'listener_id',
  'listener_tunisian_derja_fluent',
  'accent_natural_1_to_5',
  'understood',
  'words_correct',
  'complete',
  'pace_ok'
];
const BINARY_FIELDS = ['understood', 'words_correct', 'complete', 'pace_ok'];

export function parseTsv(contents) {
  const lines = String(contents || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { rows: [], errors: ['Le fichier d’évaluation est vide.'] };

  const headers = lines[0].split('\t').map((header) => header.trim());
  const missing = REQUIRED_FIELDS.filter((field) => !headers.includes(field));
  const errors = missing.map((field) => `Colonne manquante : ${field}.`);
  const rows = [];

  for (let index = 1; index < lines.length; index++) {
    const values = lines[index].split('\t');
    if (values.length !== headers.length) {
      errors.push(`Ligne ${index + 1} : nombre de colonnes incorrect.`);
      continue;
    }
    rows.push(Object.fromEntries(headers.map((header, column) => [header, values[column].trim()])));
  }
  return { rows, errors };
}

export function evaluateRows(rows, parseErrors = [], sampleHashes = null) {
  const errors = [...parseErrors];
  const phraseReviewers = new Map();
  const phraseSamples = new Map();
  const samplePhrases = new Map();
  const hashPhrases = new Map();
  const modelVersions = new Set();
  const seenReviews = new Set();
  const problemNotes = new Map();
  let accepted = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const phraseId = String(row.phrase_id || '').trim();
    const sampleFile = String(row.sample_file || '').trim();
    const modelVersion = String(row.model_version || '').trim();
    const listenerId = String(row.listener_id || '').trim();
    const fluentDerja = String(row.listener_tunisian_derja_fluent || '').toLowerCase();
    const score = Number(row.accent_natural_1_to_5);
    if (!phraseId || !sampleFile || !modelVersion || !listenerId) {
      errors.push(`Ligne ${rowNumber} : phrase_id, sample_file, model_version et listener_id sont obligatoires.`);
      return;
    }
    if (fluentDerja !== 'yes') {
      errors.push(`Ligne ${rowNumber} : l’évaluateur doit attester maîtriser la Derja tunisienne.`);
      return;
    }
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      errors.push(`Ligne ${rowNumber} : le score d’accent doit être un entier de 1 à 5.`);
      return;
    }
    const invalidBinary = BINARY_FIELDS.filter((field) => !['yes', 'no'].includes(String(row[field] || '').toLowerCase()));
    if (invalidBinary.length) {
      errors.push(`Ligne ${rowNumber} : réponses yes/no invalides ou absentes (${invalidBinary.join(', ')}).`);
      return;
    }
    if (phraseSamples.has(phraseId) && phraseSamples.get(phraseId) !== sampleFile) {
      errors.push(`Ligne ${rowNumber} : une phrase doit conserver le même fichier audio.`);
      return;
    }
    if (samplePhrases.has(sampleFile) && samplePhrases.get(sampleFile) !== phraseId) {
      errors.push(`Ligne ${rowNumber} : le même fichier audio ne peut pas compter comme plusieurs phrases.`);
      return;
    }
    if (sampleHashes && !sampleHashes.has(sampleFile)) {
      errors.push(`Ligne ${rowNumber} : empreinte audio absente pour ${sampleFile}.`);
      return;
    }
    const sampleHash = sampleHashes && sampleHashes.get(sampleFile);
    if (sampleHash && hashPhrases.has(sampleHash) && hashPhrases.get(sampleHash) !== phraseId) {
      errors.push(`Ligne ${rowNumber} : le contenu audio identique ne peut pas compter comme plusieurs phrases.`);
      return;
    }

    const reviewKey = `${phraseId}\0${listenerId}`;
    if (seenReviews.has(reviewKey)) {
      errors.push(`Ligne ${rowNumber} : évaluation dupliquée pour ${phraseId} et ${listenerId}.`);
      return;
    }
    seenReviews.add(reviewKey);
    phraseSamples.set(phraseId, sampleFile);
    samplePhrases.set(sampleFile, phraseId);
    if (sampleHash) hashPhrases.set(sampleHash, phraseId);
    modelVersions.add(modelVersion);
    const passed = score >= 4 && BINARY_FIELDS.every((field) => String(row[field]).toLowerCase() === 'yes');
    const problemNote = String(row.problem_note || '').trim().replace(/\s+/g, ' ');
    if (problemNote) {
      const noteKey = problemNote.toLocaleLowerCase('fr');
      const existing = problemNotes.get(noteKey);
      problemNotes.set(noteKey, { note: existing?.note || problemNote, count: (existing?.count || 0) + 1 });
    }
    if (!phraseReviewers.has(phraseId)) phraseReviewers.set(phraseId, []);
    phraseReviewers.get(phraseId).push({ listenerId, passed });
    if (passed) accepted++;
  });

  const phraseCount = phraseReviewers.size;
  const evaluationCount = [...phraseReviewers.values()].reduce((sum, reviews) => sum + reviews.length, 0);
  const acceptanceRate = evaluationCount ? accepted / evaluationCount : 0;
  const tooFewReviews = [...phraseReviewers.entries()]
    .filter(([, reviews]) => reviews.length < MIN_LISTENERS_PER_PHRASE)
    .map(([phraseId]) => phraseId);
  const phrasesWithoutMajority = [...phraseReviewers.entries()]
    .filter(([, reviews]) => reviews.filter((review) => review.passed).length <= reviews.length / 2)
    .map(([phraseId]) => phraseId);

  if (phraseCount < MIN_PHRASES) errors.push(`Au moins ${MIN_PHRASES} phrases distinctes sont requises (${phraseCount} reçues).`);
  if (modelVersions.size > 1) errors.push('Le corpus mélange plusieurs versions de modèle ; évalue une seule version à la fois.');
  if (new Set([...phraseReviewers.values()].flatMap((reviews) => reviews.map((review) => review.listenerId))).size < MIN_LISTENERS_PER_PHRASE) {
    errors.push(`Au moins ${MIN_LISTENERS_PER_PHRASE} évaluateurs indépendants sont requis.`);
  }
  if (tooFewReviews.length) errors.push(`${tooFewReviews.length} phrase(s) ont moins de ${MIN_LISTENERS_PER_PHRASE} évaluations.`);
  if (acceptanceRate < MIN_ACCEPTANCE_RATE) errors.push(`Taux d’acceptation inférieur à 99 % (${(acceptanceRate * 100).toFixed(2)} %).`);
  if (phrasesWithoutMajority.length) errors.push(`${phrasesWithoutMajority.length} phrase(s) n’obtiennent pas une majorité d’évaluations positives.`);

  return {
    ok: errors.length === 0,
    phraseCount,
    evaluationCount,
    accepted,
    acceptanceRate,
    modelVersion: modelVersions.size === 1 ? [...modelVersions][0] : null,
    minimumPhrases: MIN_PHRASES,
    minimumListenersPerPhrase: MIN_LISTENERS_PER_PHRASE,
    minimumAcceptanceRate: MIN_ACCEPTANCE_RATE,
    mostReportedIssues: [...problemNotes.values()].sort((a, b) => b.count - a.count || a.note.localeCompare(b.note, 'fr')).slice(0, 10),
    phrasesWithoutMajority,
    errors
  };
}

async function main(filePath) {
  if (!filePath) {
    console.error('Usage : node backend/voice/evaluate-voice-corpus.mjs <évaluations.tsv>');
    process.exitCode = 2;
    return;
  }
  const manifestPath = resolve(filePath);
  const contents = await readFile(manifestPath, 'utf8');
  const parsed = parseTsv(contents);
  const baseDirectory = dirname(manifestPath);
  const sampleFiles = new Set(parsed.rows.map((row) => String(row.sample_file || '').trim()).filter(Boolean));
  const sampleHashes = new Map();
  for (const sampleFile of sampleFiles) {
    if (isAbsolute(sampleFile)) throw new Error(`Le chemin audio doit être relatif au TSV : ${sampleFile}`);
    const audioPath = resolve(baseDirectory, sampleFile);
    const pathFromManifest = relative(baseDirectory, audioPath);
    if (!pathFromManifest || pathFromManifest === '..' || pathFromManifest.startsWith(`..${sep}`) || isAbsolute(pathFromManifest)) {
      throw new Error(`Le chemin audio doit rester dans le dossier du TSV : ${sampleFile}`);
    }
    const audioBytes = await readFile(audioPath);
    sampleHashes.set(sampleFile, createHash('sha256').update(audioBytes).digest('hex'));
  }
  const report = evaluateRows(parsed.rows, parsed.errors, sampleHashes);
  console.log(`Phrases distinctes : ${report.phraseCount}/${MIN_PHRASES}`);
  console.log(`Évaluations positives : ${report.accepted}/${report.evaluationCount} (${(report.acceptanceRate * 100).toFixed(2)} %)`);
  if (report.mostReportedIssues.length) {
    console.log('Problèmes de prononciation les plus signalés :');
    report.mostReportedIssues.forEach(({ note, count }) => console.log(`- ${count}× ${note}`));
  }
  if (report.errors.length) {
    report.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log('Seuil d’écoute atteint pour ce corpus de test. Cela ne garantit pas la qualité de toutes les générations futures.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    console.error(`Lecture du corpus impossible : ${error.message}`);
    process.exitCode = 1;
  });
}
