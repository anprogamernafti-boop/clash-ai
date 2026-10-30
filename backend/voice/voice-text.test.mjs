import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../www/index.html', import.meta.url), 'utf8');
const humanErrorStart = html.indexOf('function causeHumaine(e)');
const humanErrorEnd = html.indexOf('\nfunction detailAdmin', humanErrorStart);
const humanErrorContext = {};
vm.runInNewContext(
  html.slice(humanErrorStart, humanErrorEnd) + '\nglobalThis.humanizeError = causeHumaine;',
  humanErrorContext
);

test('keeps proxy credential details out of user-facing transcription errors', () => {
  for (const code of ['gemini_proxy_key_invalid', 'gemini_proxy_access_denied']) {
    const message = humanErrorContext.humanizeError(new Error(code));
    assert.match(message, /préparation du texte vocal.*réessaie plus tard/i);
    assert.doesNotMatch(message, /Gemini|GEMINI_KEY|Worker|proxy/i);
  }
  assert.match(humanErrorContext.humanizeError(new Error('gemini_proxy_quota')), /service de transcription.*réessaie/i);
});

const proxyTextStart = html.indexOf('async function geminiViaProxyTexte');
const proxyTextEnd = html.indexOf('\nfunction diagnostiquerPunchlineCourte', proxyTextStart);
const proxyTextContext = {
  GEMINI_PROXY: 'https://proxy.example',
  DEVICE_ID: 'device-test',
  fetch: async () => ({ status: 403, json: async () => ({ ok: false, error: 'Jeton invalide' }) })
};
vm.runInNewContext(
  html.slice(proxyTextStart, proxyTextEnd) + '\nglobalThis.callTextProxy = geminiViaProxyTexte;',
  proxyTextContext
);

test('classifies an invalid token returned by the text-only Gemini proxy', async () => {
  await assert.rejects(proxyTextContext.callTextProxy('gemini-3.6-flash', 'test'), /gemini_proxy_key_invalid/);
});

test('keeps Mohsen’s landing-page clash fixed independently from fallback templates', () => {
  const original = 'Mohsen, lunette akber min wejhek len ma3adech yben fi ttaswira amma el pose 7adhret 9bal ma enti ta3ref elli famma taswira, llebsa azyen mennek wenti tetbassem b7al testanna chkoun ysawrek';
  assert.ok(html.includes(`punchline: '${original}'`));
  assert.match(html, /if \(t\) t\.textContent = EXEMPLE\.punchline;/);
});

const start = html.indexOf('const RE_ARABE =');
const end = html.indexOf('async function vocaliserPunchlineDerja', start);
const context = {};
vm.runInNewContext(
  html.slice(start, end) + '\nglobalThis.voiceText = { texteArabe, arabeEstVocalisePourTTS, diagnostiquerVocalisationPourTTS, corrigerFormesDerjaEtFrancaises, ponctuerSegmentFrancaisPourVoxCPM, vocaliserNombre95Derja, vocaliserReferencesDerja, corrigerLexiqueDerjaPourTTS, motsFrancaisManquants, texteParleCorrespond, segmenterPunchlinePourVocalisation, joindreVocalisationsSegments, normalizeVerdict };',
  context
);
const voiceText = context.voiceText;

const fallbackStart = html.indexOf('const DERJA_ARCH =');
const fallbackEnd = html.indexOf('/* ---- Parsing robuste du JSON renvoyé par un LLM ---- */', fallbackStart);
const fallbackContext = {};
vm.runInNewContext(
  html.slice(fallbackStart, fallbackEnd) + '\nglobalThis.fallbackText = { derjaFor, assurerPunchlineDeSecours };',
  fallbackContext
);

const qualityStart = html.indexOf('function diagnostiquerPunchlineCourte');
const qualityEnd = html.indexOf('\nasync function raccourcirPunchlineDerja', qualityStart);
const qualityContext = {};
vm.runInNewContext(
  html.slice(qualityStart, qualityEnd) + '\nglobalThis.qualityText = { diagnostiquerPunchlineCourte };',
  qualityContext
);

const rewriteStart = html.indexOf('async function raccourcirPunchlineDerja');
const rewriteEnd = html.indexOf('\n/* --- liste vivante des modèles disponibles', rewriteStart);

function makeRewriteContext(response) {
  const calls = [];
  const rewriteContext = {
    GEMINI_PROXY: 'https://proxy.example',
    PROXY_MODEL: 'gemini-3.6-flash',
    extractJSON: JSON.parse,
    corrigerFormesDerjaEtFrancaises: voiceText.corrigerFormesDerjaEtFrancaises,
    diagnostiquerPunchlineCourte: qualityContext.qualityText.diagnostiquerPunchlineCourte,
    geminiViaProxyTexte: async (...args) => { calls.push(args); return JSON.stringify(response); }
  };
  vm.runInNewContext(html.slice(rewriteStart, rewriteEnd) + '\nglobalThis.rewriteShortClash = raccourcirPunchlineDerja;', rewriteContext);
  return { rewriteContext, calls };
}

const retryStart = html.indexOf('async function retenterVocalisation()');
const retryEnd = html.indexOf('\nfunction phonetiqueDerja', retryStart);

function makeRetryContext() {
  const button = { disabled: false, textContent: '', isConnected: true };
  const status = { textContent: '' };
  const result = { traits: { punchline: 'ya 7yati', punchlineAr: null } };
  let attempts = 0;
  const retryContext = {
    result,
    GEMINI_PROXY: 'https://proxy.example',
    $: (id) => id === 'retryVoiceTextButton' ? button : status,
    vocaliserPunchlineDerja: async () => { attempts++; throw new Error('proxy temporairement indisponible'); },
    causeHumaine: (error) => error.message,
    render: () => { throw new Error('render should not run after failure'); }
  };
  vm.runInNewContext(html.slice(retryStart, retryEnd) + '\nglobalThis.retryVocalisation = retenterVocalisation;', retryContext);
  return { retryContext, button, status, result, get attempts() { return attempts; } };
}

test('keeps transcription retry available after a failure, then stops at the retry limit', async () => {
  const state = makeRetryContext();

  await state.retryContext.retryVocalisation();
  assert.equal(state.attempts, 1);
  assert.equal(state.button.disabled, false);
  assert.match(state.button.textContent, /Réessayer la transcription/);
  assert.match(state.status.textContent, /1 tentative restante/);

  await state.retryContext.retryVocalisation();
  assert.equal(state.attempts, 2);
  assert.equal(state.button.disabled, true);
  assert.match(state.button.textContent, /Limite atteinte/);
  assert.match(state.status.textContent, /Limite de tentatives atteinte/);

  await state.retryContext.retryVocalisation();
  assert.equal(state.attempts, 2);
});

test('corrects the specified Arabizi and French spellings for the voice', () => {
  assert.equal(
    voiceText.corrigerFormesDerjaEtFrancaises('kifen el photo d identity elli teshbeh shay mata3ek'),
    'kif el photo d’identité elli teshbeh shay mta3ek'
  );
});

test('uses the listener-approved Tunisian forms for passport photo and mayghorrekch', () => {
  const source = 'Ya 7amma t9oul photo passeport, ma tghourech bcha3rek!';
  const expected = 'Ya 7amma t9oul taswira mta3 passeport, mayghorrekch bcha3rek!';
  assert.equal(voiceText.corrigerFormesDerjaEtFrancaises(source), expected);

  const spoken = 'يَا حَمَّةْ تْقُولْ تَصْوِيرَةْ مْتَاعْ passeport، مَا يْغُرَّكْشْ بْشَعْرِكْ';
  const result = voiceText.normalizeVerdict({ archetype: 'test', punchline: source, punchline_ar: spoken });
  assert.equal(result.punchline, expected);
  assert.match(result.punchlineAr, /تَصْوِيرَةْ مْتَاعْ passeport/u);
  assert.match(result.punchlineAr, /مَا يْغُرَّكْشْ/u);
  assert.equal(voiceText.arabeEstVocalisePourTTS(result.punchlineAr), true);
  assert.equal(voiceText.texteParleCorrespond(result.punchline, result.punchlineAr), true);
});

test('adds the user-approved French pause around photo d’identité for VoxCPM', () => {
  const source = "يَا حَمَّا وَاقِفْ كِيفْ photo d'identité وَ فَرْحَانْ عْلى اللَّاشَيْ!";
  const expected = "يَا حَمَّا وَاقِفْ كِيفْ، photo d'identité، وَ فَرْحَانْ عْلى اللَّاشَيْ!";
  assert.equal(voiceText.ponctuerSegmentFrancaisPourVoxCPM(source), expected);
  assert.equal(voiceText.ponctuerSegmentFrancaisPourVoxCPM(expected), expected);
  assert.equal(voiceText.ponctuerSegmentFrancaisPourVoxCPM('phrase tunisienne sans mot français'), 'phrase tunisienne sans mot français');
});

test('preserves French words confirmed in the latest VoxCPM pilot sample', () => {
  const spoken = "يَا ahmed إِلْوَقْفَةْ مْتَاعِكْ تْقُولْ photo d'identité مْتَاعْ passeport وْإِنْتِي فَرْحَانْ بْشَعْرِكْ.";
  const prepared = voiceText.ponctuerSegmentFrancaisPourVoxCPM(spoken);
  assert.ok(prepared.includes("photo d'identité"));
  assert.ok(prepared.includes('passeport'));
  assert.match(prepared, /، photo d'identité،/);
  assert.match(prepared, /مْتَاعْ، passeport، وْإِنْتِي/);
  assert.equal(voiceText.ponctuerSegmentFrancaisPourVoxCPM(prepared), prepared);
});

test('spells out Tunisian 95 instead of rejecting the whole spoken transcript', () => {
  const spoken = voiceText.vocaliserNombre95Derja('Windows 95', 'Windows 95');
  assert.equal(spoken, 'Windows خَمْسَةْ وَتِسْعِينْ');
  assert.ok(voiceText.arabeEstVocalisePourTTS(spoken));
  assert.equal(voiceText.texteParleCorrespond('Windows 95', spoken), true);
  assert.equal(voiceText.vocaliserNombre95Derja('Windows 98', 'Windows 98'), 'Windows 98');
  assert.equal(voiceText.texteArabe('Windows 98'), null);
});

test('normalizes Arabic-Indic 95 while leaving the displayed clash unchanged', () => {
  const result = voiceText.normalizeVerdict({
    archetype: 'test',
    punchline: 'Windows 95',
    punchline_ar: 'Windows ٩٥'
  });
  assert.equal(result.punchline, 'Windows 95');
  assert.equal(result.punchlineAr, 'Windows خَمْسَةْ وَتِسْعِينْ');
});

test('accepts vocalized Tunisian words with French words kept in French', () => {
  const source = 'kif el photo d identité elli teshbeh shay';
  const spoken = 'كِيفْ إِلْ photo d’identité اللِّي تِشْبِهْ شَيْ';
  const normalized = voiceText.texteArabe(spoken);
  assert.ok(normalized);
  assert.equal(voiceText.arabeEstVocalisePourTTS(normalized), true);
  assert.equal(voiceText.texteParleCorrespond(source, normalized), true);
});

test('accepts a mixed French/Derja sentence from a real Clash AI sample', () => {
  const source = "Ya 7amma el wa9fa mte3ek tgoul photo d'identité mte3 passeport w enti fer7an bcha3rek.";
  const spoken = "يَا حَمَّةْ إِلْوَقْفَةْ مْتَاعِكْ تْقُولْ photo d'identité مْتَاعْ passeport وْإِنْتِي فَرْحَانْ بْشَعْرِكْ";
  const normalized = voiceText.texteArabe(spoken);
  assert.ok(normalized);
  assert.equal(voiceText.arabeEstVocalisePourTTS(normalized), true);
  assert.equal(voiceText.texteParleCorrespond(source, normalized), true);
});

test('accepts the live mixed-script transcript for the short leader clash', () => {
  const source = 'El majhoul, t7eb t9oud el groupe ama chkoun yasma3lek?';
  const rawSpoken = 'إِلْمَجْهُولْ، تُحِبْ تْقُودْ إِلْ groupe أَمَّا شْكُونْ يَسْمَعْلِكْ؟';
  const spoken = voiceText.vocaliserReferencesDerja(rawSpoken);
  const normalized = voiceText.texteArabe(spoken);
  assert.ok(normalized);
  assert.match(normalized, /تْحِبّ/);
  assert.doesNotMatch(normalized, /تُحِبْ/);
  assert.equal(voiceText.arabeEstVocalisePourTTS(normalized), true);
  assert.equal(voiceText.texteParleCorrespond(source, normalized), true);
  assert.equal(voiceText.motsFrancaisManquants(source, normalized).length, 0);
});

test('uses the Tunisian pronunciation for t7eb instead of the standard-Arabic reading', () => {
  assert.equal(voiceText.vocaliserReferencesDerja('تُحِبْ'), 'تْحِبّ');
});

test('accepts known French words when they remain in Latin inside Derja speech', () => {
  const source = '7amma 3amel el wa9fa hedhi t9oul avatar ta3 jeu video fih bug!';
  const spoken = 'حَمَّةْ عَامِلْ إِلْوَقْفَةْ هَذِي تْقُولْ avatar تَاعْ jeu vidéo فِيهْ bug!';
  const normalized = voiceText.texteArabe(spoken);
  assert.ok(normalized);
  assert.equal(voiceText.arabeEstVocalisePourTTS(normalized), true);
  assert.equal(voiceText.texteParleCorrespond(source, normalized), true);
});

test('identifies the exact French words missing from a mixed-script transcription', () => {
  const source = '7amma 3amel el wa9fa hedhi t9oul avatar ta3 jeu video fih bug!';
  const transliterated = 'حَمَّةْ عَامِلْ إِلْوَقْفَةْ هَذِي تْقُولْ أَبَاتَارْ تَاعْ جُو ڤِيدْيُو فِيهْ بُوڤْ!';
  const correct = 'حَمَّةْ عَامِلْ إِلْوَقْفَةْ هَذِي تْقُولْ avatar تَاعْ jeu vidéo فِيهْ bug!';
  assert.deepEqual([...voiceText.motsFrancaisManquants(source, transliterated)], ['avatar', 'jeu', 'video', 'bug']);
  assert.deepEqual([...voiceText.motsFrancaisManquants(source, correct)], []);
});

test('keeps short clashes in one transcription segment', () => {
  const source = 'Ya 7amma kif el photo d’identité!';
  assert.deepEqual([...voiceText.segmenterPunchlinePourVocalisation(source)], [source]);
});

test('segments long Tunisian clashes at phrase boundaries without dropping or reordering words', () => {
  const source = '7amma, enti t7ebb t9oud el groupe ama 7atta el groupe mte3ek yesta3ref b enti. El visage hedha 9alb 7nin... wala 9alb barcha? Yefhem 3lih bech yefahem. El uniforme hedha y9ol el 7a9i9a e5ir kima el photo. W el 3alem yestanna el souri3a el jeya. W el verdict: hadhi machi photo, hedha dossier meftou7';
  const parts = voiceText.segmenterPunchlinePourVocalisation(source);
  const words = (value) => value.trim().split(/\s+/u);

  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => words(part).length <= 12));
  assert.deepEqual([...parts.flatMap(words)], words(source));
  assert.equal(
    voiceText.joindreVocalisationsSegments(['حَمَّةْ عِنْدِي', 'تْقُولْ photo د’identité']),
    'حَمَّةْ عِنْدِي، تْقُولْ photo د’identité'
  );
});

test('uses one concise fallback line instead of stacking archetype, vibe, style, and fillers', () => {
  const traits = { archetype: 'le leader', vibe: 'chaleureux et proche', style: 'uniforme de travail' };
  const line = fallbackContext.fallbackText.assurerPunchlineDeSecours(traits, '7amma');

  assert.equal(line, '7amma, t7eb t9oud el groupe ama chkoun yasma3lek?');
  assert.ok(line.length <= 120);
  assert.equal((line.match(/[.!?؟]+/gu) || []).length, 1);
  assert.doesNotMatch(line, /souri3a el jeya|dossier meftou7|yesta3ref/iu);
});

test('detects the overlong fallback clash and known unusable filler phrases', () => {
  assert.equal(
    qualityContext.qualityText.diagnostiquerPunchlineCourte('7amma, enti t7ebb t9oud el groupe ama 7atta el groupe mte3ek yesta3ref b enti. '.repeat(3)),
    'plus de 135 caractères'
  );
  assert.equal(
    qualityContext.qualityText.diagnostiquerPunchlineCourte('W el 3alem yestanna el souri3a el jeya fi kol mara'),
    'remplissage non validé repéré'
  );
  assert.equal(qualityContext.qualityText.diagnostiquerPunchlineCourte('Ya 7amma, t7eb t9oud el groupe?'), 'moins de 9 mots');
  assert.equal(
    qualityContext.qualityText.diagnostiquerPunchlineCourte('Ya 7amma enti t7eb t9oud el groupe ama chkoun yasma3lek fi kol mara?'),
    'formule de leadership trop répétée'
  );
  assert.equal(
    qualityContext.qualityText.diagnostiquerPunchlineCourte('Tebtsimtek hebletni ama cha3rek mriguel barchafil fi taswira hethi'),
    'mot non validé « barchafil »'
  );
  assert.equal(
    qualityContext.qualityText.diagnostiquerPunchlineCourte('Wa9fetk mta3 taswira w hal décor mayghatti 3la wjuhkom zayfa?'),
    'mot non tunisien « zayfa »'
  );
  assert.equal(
    qualityContext.qualityText.diagnostiquerPunchlineCourte('El majhoul, t7eb t9oud el groupe ama chkoun yasma3lek?'),
    'formule de leadership trop répétée'
  );
  assert.equal(
    qualityContext.qualityText.diagnostiquerPunchlineCourte(
      'El taswira mta3 passeport w enti wa9ef kima el robot exact',
      ['3lech taswira mta3 passeport hethi wallat b tabssima?']
    ),
    'même détail ou angle que dans un clash récent'
  );
});

test('shortens an overlong line using one text-only Gemini request and validates the result', async () => {
  const source = '7amma, enti t7ebb t9oud el groupe ama 7atta el groupe mte3ek yesta3ref b enti. '.repeat(3);
  const accepted = 'El groupe yetsanna fik ta3ti l ordre w enti mazelt tlam l equipe.';
  const state = makeRewriteContext({ punchline: accepted });
  const shortLine = await state.rewriteContext.rewriteShortClash(source);

  assert.equal(shortLine, accepted);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].length, 2);
  assert.match(state.calls[0][1], /Texte à reformuler/iu);
  assert.match(state.calls[0][1], /Vise 9 à 13 mots[\s\S]*135 caractères/iu);
  assert.match(state.calls[0][1], /Clashs récents à ne pas reprendre[\s\S]*évite « Ya \+ prénom » en ouverture/iu);
});

test('rejects a rewrite that is still too long instead of showing it', async () => {
  const state = makeRewriteContext({ punchline: 'Ya 7amma, enti t7ebb t9oud el groupe ama 7atta el groupe mte3ek yesta3ref b enti.' });
  await assert.rejects(state.rewriteContext.rewriteShortClash('a long original'), /reformulation qualité refusée/iu);
});

test('normalizes mata3 and refuses zayfa in the quality rewrite', async () => {
  const state = makeRewriteContext({
    punchline: 'Wa9fetk mata3 taswira w hal décor mayghatti 3la wjuhkom zayfa?'
  });

  await assert.rejects(
    state.rewriteContext.rewriteShortClash('clash à corriger'),
    /mot non tunisien « zayfa »/iu
  );
  assert.match(state.calls[0][1], /mta3[\s\S]*jamais « mata3 »[\s\S]*n’utilise pas « zayfa »/iu);
});

test('rewrites the repeated group-leader catchphrase instead of allowing it again', async () => {
  const repeated = 'El majhoul, t7eb t9oud el groupe ama chkoun yasma3lek?';
  const alternative = 'Wa9fetk mta3 taswira w hal décor mayghatti 3la wejhek zayen?';
  const state = makeRewriteContext({ punchline: alternative });

  const result = await state.rewriteContext.rewriteShortClash(repeated);

  assert.equal(result, alternative);
  assert.match(state.calls[0][1], /N’utilise pas la formule déjà répétée/iu);
});

test('uses a Tunisian spoken equivalent for mabsoot without changing the displayed clash', () => {
  const result = voiceText.normalizeVerdict({
    archetype: 'test',
    punchline: "Ya 7amma wa9ef kif photo d’identité w mabsoot 3al el-la'shi!",
    punchline_ar: "يَا حَمَّا وَاقِفْ كِيفْ photo d’identité وَ مَبْسُوطْ عْلى اللَّاشَيْ!"
  });

  assert.equal(result.punchline, "Ya 7amma wa9ef kif photo d’identité w mabsoot 3al el-la'shi!");
  assert.match(result.punchlineAr, /فَرْحَانْ/);
  assert.doesNotMatch(result.punchlineAr, /مَبْسُوطْ/);
});

test('contracts wa9fa mte3ek into the clearer spoken form only in the matching phrase', () => {
  const source = 'Ya ahmed el wa9fa mte3ek tgoul photo d’identité.';
  const plain = 'يَا ahmed إِلْوَقْفَةْ مْتَاعِكْ تْقُولْ photo d’identité.';
  const corrected = voiceText.corrigerLexiqueDerjaPourTTS(source, plain);

  assert.equal(corrected, 'يَا ahmed وَقْفْتِكْ تْقُولْ photo d’identité.');
  assert.equal(
    voiceText.corrigerLexiqueDerjaPourTTS('Ya ahmed mte3ek w chnowa?', plain),
    plain
  );
});

test('suspends audio for historical Clash AI outputs that transliterated French words', () => {
  const historicalSamples = [
    {
      punchline: '7amma wa9ef kifen el photo d identity elli ma teshbeh l shay!',
      punchline_ar: 'حَمَّا وَاڨِفْ كِيفِنْ أِلْ فُوتُو دِ إِيدَانْتِيتِي أِلِّي مَا تِشْبِهْ لِ شَيْ'
    },
    {
      punchline: '7amma 3amel el wa9fa hedhi t9oul avatar ta3 jeu video fih bug!',
      punchline_ar: 'حَمَّة عَامِلْ الِوَقْفَة هَذِي تْقُولْ أَبَاتَارْ تَعْ جُو ڤِيدْيُو فِيهْ بُوڤْ!'
    },
    {
      punchline: 'Yezzi melli 3amel fiha pose photomaton VIP, t3alm tbessem men gher ma t abbet hka!',
      punchline_ar: 'يَزِّي مِلِّي عَامِلْ فِيهَا بَوْزْ فُوتُومَاتُون في أي بِي، تْعَلَّمْ تْبَسَّمْ مِنْ غِيرْ مَا تْثَبِّتْ هْكَا!'
    }
  ];

  for (const sample of historicalSamples) {
    const result = voiceText.normalizeVerdict(sample);
    assert.ok(result.punchline);
    assert.equal(result.punchlineAr, null, sample.punchline);
  }
});

test('diagnoses the exact Arabic word with incomplete vocalization', () => {
  const incomplete = "يَا حَمَّةْ إِلْوَقْفَةْ مْتَاعِكْ تْقولْ photo d'identité مْتَاعْ passeport وْإِنْتِي فَرْحَانْ بْشَعْرِكْ";
  const diagnostic = voiceText.diagnostiquerVocalisationPourTTS(incomplete);
  assert.equal(diagnostic.raison, 'consonnes arabes sans voyelle courte ou sukūn');
  assert.equal(diagnostic.mot, 'تْقولْ');
});

test('keeps the user-approved French and Derja spellings in the displayed clash', () => {
  const result = voiceText.normalizeVerdict({
    archetype: 'test',
    punchline: 'kifen el photo d identity elli teshbeh shay!',
    punchline_ar: 'كِيفْ إِلْ photo d’identité اللِّي تِشْبِهْ شَيْ'
  });
  assert.equal(result.punchline, 'kif el photo d’identité elli teshbeh shay!');
  assert.equal(result.punchlineAr.normalize('NFC'), 'كِيفْ إِلْ photo d’identité اللِّي تِشْبِهْ شَيْ'.normalize('NFC'));
});

test('rejects French words transliterated into Arabic or Tunisian Arabizi left in Latin', () => {
  const source = 'kif el photo d identité elli teshbeh shay';
  const frenchTransliterated = 'كِيفْ إِلْ فُوتُو دِ إِيدَانْتِيتِي اللِّي تِشْبِهْ شَيْ';
  const arabiziLeftInLatin = 'كِيفْ el photo d’identité elli تِشْبِهْ shay';
  const kifWithExtraN = 'كِيفِنْ إِلْ photo d’identité اللِّي تِشْبِهْ شَيْ';
  const shayAsTea = 'كِيفْ إِلْ photo d’identité اللِّي تِشْبِهْ شَاي';
  assert.equal(voiceText.texteParleCorrespond(source, frenchTransliterated), false);
  assert.equal(voiceText.texteParleCorrespond(source, arabiziLeftInLatin), false);
  assert.equal(voiceText.texteParleCorrespond(source, kifWithExtraN), false);
  assert.equal(voiceText.texteParleCorrespond(source, shayAsTea), false);
});

test('uses the listener-approved chay pronunciation only in the exact Tunisian idiom', () => {
  const source = '7amma wa9ef kif el photo d’identité elli ma teshbeh l chay!';
  const generated = 'حَمَّا وَاقِفْ كِيفْ الْ photo d’identité إِلِّي مَا تِشْبِهْ لِشَيْ!';
  const corrected = voiceText.corrigerLexiqueDerjaPourTTS(source, generated);
  assert.match(corrected, /شَايْ/u);
  assert.equal(voiceText.texteParleCorrespond(source, corrected), true);
  assert.equal(voiceText.texteParleCorrespond('elli teshbeh shay', 'اللِّي تِشْبِهْ شَايْ'), false);
});

test('keeps the vision prompt consistent about French/Derja mixed-script speech', () => {
  const start = html.indexOf('const RECENT_CLASHES_KEY');
  const end = html.indexOf('\nasync function traitsWithKey', start);
  assert.ok(start >= 0 && end > start, 'visionPrompt function should be present');
  const context = {};
  vm.runInNewContext(html.slice(start, end) + '\nglobalThis.makeVisionPrompt = visionPrompt;', context);
  const prompt = context.makeVisionPrompt('test', 2);

  assert.match(prompt, /écriture mixte/iu);
  assert.match(prompt, /Ne traduis et ne translittère jamais un mot français/iu);
  assert.match(prompt, /photo d'identité[\s\S]*photo d'identité/iu);
  assert.match(prompt, /wa9fa mte3ek tgoul[\s\S]*وَقْفْتِكْ تْقُولْ/iu);
  assert.match(prompt, /RÈGLE PRIORITAIRE PASSEPORT[\s\S]*prévaut sur l’exemple non ponctué/iu);
  assert.match(prompt, /Ne généralise pas cette contraction aux autres emplois de[^\n]*wa9fa/iu);
  assert.match(prompt, /Derja tunisienne naturelle uniquement, jamais égyptienne ni arabe standard/iu);
  assert.match(prompt, /taswira mta3 passeport[\s\S]*mayghorrekch[\s\S]*matghourech/iu);
  assert.match(prompt, /passeport[\s\S]*courte pause[\s\S]*مْتَاعْ، passeport، وْإِنْتِي/iu);
  assert.match(prompt, /bssawer[\s\S]*inexistante\/non naturelle en Tunisie[\s\S]*taswira/iu);
  assert.match(prompt, /vise 9 à 13 mots, sans dépasser 15 mots ni 135 caractères/iu);
  assert.match(prompt, /Varie naturellement d’un clash à l’autre[\s\S]*évite les débuts et formules déjà répétitifs/iu);
  assert.match(prompt, /t7eb t9oud el groupe[\s\S]*chkoun yasma3lek/iu);
  assert.match(prompt, /Pour cette génération, adopte cette forme : (?:ouvre directement|construis la réplique|fais un constat|adresse-toi)/iu);
  assert.match(prompt, /n'invente aucun mot, pseudo-verbe ou expression/iu);
  assert.match(prompt, /mta3[\s\S]*jamais « mata3 »[\s\S]*n'utilise pas « zayfa »/iu);
  assert.match(prompt, /3ayez\/3ayza[\s\S]*keda[\s\S]*delwa2ti/iu);
  assert.doesNotMatch(prompt, /alphabet arabe uniquement|phonétique en DERJA TUNISIENNE pour la synthèse|Vocalise aussi ces mots étrangers/iu);
  const chayRuleStart = html.indexOf('const regleChay =');
  const chayRuleEnd = html.indexOf('\n', chayRuleStart);
  assert.match(html.slice(chayRuleStart, chayRuleEnd), /Exception phonétique validée à l’écoute[\s\S]*ma teshbeh l chay[\s\S]*شَايْ[\s\S]*Dans les autres contextes[\s\S]*شَيْ/iu);
});

test('passes only the three latest session clashes to Gemini as anti-repetition context', () => {
  const start = html.indexOf('const RECENT_CLASHES_KEY');
  const end = html.indexOf('\nasync function traitsWithKey', start);
  const stored = new Map([['clash_recent_punchlines_v1', JSON.stringify([
    'ancien 1', 'ancien 2', 'réplique récente A', 'réplique récente B'
  ])]]);
  const context = {
    sessionStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value)
    },
    Math
  };
  vm.runInNewContext(html.slice(start, end) + '\nglobalThis.makeVisionPrompt = visionPrompt; globalThis.remember = memoriserClashRecent;', context);
  const prompt = context.makeVisionPrompt('test', 2);

  assert.match(prompt, /réplique récente A[\s\S]*réplique récente B/iu);
  assert.doesNotMatch(prompt, /ancien 1/u);
  context.remember('nouvelle réplique test');
  assert.deepEqual(JSON.parse(stored.get('clash_recent_punchlines_v1')), [
    'réplique récente A', 'réplique récente B', 'nouvelle réplique test'
  ]);
});
