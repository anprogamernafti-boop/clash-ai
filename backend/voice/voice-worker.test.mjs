import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './voice-worker.js';

function request(body, extraHeaders = {}) {
  return new Request('https://voice.example/voix', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
}

async function ipInVoxCpmCohort(percent) {
  for (let index = 0; index < 10000; index++) {
    const ip = `198.51.100.${index}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('voxcpm-rollout:' + ip));
    if (new DataView(digest).getUint32(0, false) % 100 < percent) return ip;
  }
  throw new Error('could not find deterministic test IP in rollout cohort');
}

async function ipOutsideVoxCpmCohort(percent) {
  for (let index = 0; index < 10000; index++) {
    const ip = `198.51.100.${index}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('voxcpm-rollout:' + ip));
    if (new DataView(digest).getUint32(0, false) % 100 >= percent) return ip;
  }
  throw new Error('could not find deterministic test IP outside rollout cohort');
}

function testWav() {
  const samples = 16000;
  const dataSize = samples * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => [...value].forEach((char, index) => bytes[offset + index] = char.charCodeAt(0));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, dataSize, true);
  for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.round(Math.sin(index * 0.12) * 9000), true);
  return bytes;
}

test('rejects overlong text instead of silently truncating the spoken clash', async () => {
  const response = await worker.fetch(request({ text: 'x'.repeat(601), ar: 'ا'.repeat(601) }), {});
  const body = await response.json();
  assert.equal(response.status, 413);
  assert.equal(body.code, 'text_too_long');
  assert.match(body.error, /aucun texte n’a été tronqué/);
});

test('keeps missing vocalized Arabic fail-closed without selecting a fallback voice', async () => {
  const response = await worker.fetch(request({ text: 'clash derja', ar: '' }), {});
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.code, 'text_unavailable');
  assert.equal(body.retryable, false);
});

test('does not use another provider when VoxCPM is unavailable in strict mode', async () => {
  let fallbackCalls = 0;
  const response = await worker.fetch(request({ text: 'clash derja', ar: 'حْيْاتِي' }), {
    AI: { run: async () => { fallbackCalls++; return {}; } }
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'provider_unavailable');
  assert.equal(fallbackCalls, 0);
});

test('VoxCPM canary keeps playback suspended outside its rollout cohort', async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  const ip = await ipOutsideVoxCpmCohort(7);
  globalThis.fetch = async () => { providerCalls++; throw new Error('no provider should be called'); };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }, { 'cf-connecting-ip': ip }), {
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'test-token',
      VOICE_POLICY: 'voxcpm_canary',
      VOXCPM_ROLLOUT_PERCENT: '7'
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'pilot_not_enabled');
    assert.equal(body.retryable, false);
    assert.equal(body.rolloutPercent, 7);
    assert.match(body.error, /petit groupe/);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('VoxCPM canary cohort fails closed instead of falling back to another accent', async () => {
  const originalFetch = globalThis.fetch;
  const ip = await ipInVoxCpmCohort(1);
  const providers = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    providers.push(url.hostname);
    if (url.hostname.endsWith('.hf.space')) return new Response('quota exceeded', { status: 429 });
    throw new Error('fallback must not be called');
  };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }, { 'cf-connecting-ip': ip }), {
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'test-token',
      VOICE_POLICY: 'voxcpm_canary',
      VOXCPM_ROLLOUT_PERCENT: '1',
      VOICE_LIMITER: { limit: async () => ({ success: true }) },
      AI: { run: async () => { throw new Error('fallback must not be called'); } }
    });
    const body = await response.json();
    assert.equal(response.status, 429);
    assert.equal(body.code, 'quota_unavailable');
    assert.ok(providers.length > 0);
    assert.ok(providers.every((hostname) => hostname.endsWith('.hf.space')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a clearly misaligned Arabizi and Arabic text pair before synthesis', async () => {
  const response = await worker.fetch(request({ text: 'wa7ed 3amel 2 comments', ar: 'حْيَاتِي' }), {});
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.code, 'text_pair_mismatch');
});

test('does not reject a plausible short pair on word-count grounds', async () => {
  const response = await worker.fetch(request({ text: 'enti fi dar w ena bara', ar: 'إِنْتِي فِي الدَّارْ وْأَنَا لَبْرَة' }), {});
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'provider_unavailable');
});

test('allows common Tunisian clitic and compound merging across scripts', async () => {
  const response = await worker.fetch(request({
    text: 'w enti mchit lel dar w l9it ommi',
    ar: 'وَإِنْتِي مَشِيتْ لِلدَّارْ وْلْقِيتْ أُمِّي'
  }), {});
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'provider_unavailable');
});

test('allows moderate word-count differences caused by Tunisian clitic joining', async () => {
  const response = await worker.fetch(request({
    text: 'ena taw mchit lel dar w rja3t',
    ar: 'أَنَا تَوَّ مْشِيتْ لِلدَّارْ وْرْجَعْتْ'
  }), {});
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'provider_unavailable');
});

test('accepts a vocalization mixing Tunisian Arabic with correctly spelled French words', async () => {
  const response = await worker.fetch(request({
    text: 'kif el photo d identity elli teshbeh shay',
    ar: 'كِيفْ إِلْ photo d’identité اللِّي تِشْبِهْ شَيْ'
  }), {});
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'provider_unavailable');
});

test('rejects an empty voice request', async () => {
  const response = await worker.fetch(request({ text: '', ar: '' }), {});
  assert.equal(response.status, 400);
});

test('rejects GET voice requests so spoken text cannot leak through URL logging', async () => {
  const response = await worker.fetch(new Request('https://voice.example/voix?a=secret-derja'));
  const body = await response.json();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  assert.equal(body.code, 'method_not_allowed');
});

test('keeps third-party diagnostic synthesis private and disabled by default', async () => {
  let externalCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { externalCalls++; throw new Error('unexpected external request'); };
  try {
    const response = await worker.fetch(new Request('https://voice.example/diagnostic?a=private-text'), {
      VOICE_DIAGNOSTIC_ENABLED: 'true'
    });
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.code, 'diagnostic_disabled');
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health reports the closed pilot without claiming provider availability', async () => {
  const response = await worker.fetch(new Request('https://voice.example/health'), {
    HF_VOXCPM_TTS_ENABLED: 'true',
    HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
    HF_VOXCPM_TOKEN: 'test-token',
    VOXCPM_ROLLOUT_PERCENT: '0'
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.voxcpmPret, true);
  assert.equal(body.voxcpmEtat, 'pilot_closed');
  assert.equal(body.rolloutPercent, 0);
  assert.match(body.etatSignification, /aucun appel de synthèse/);
});

test('health identifies canary mode and reports the existing baseline engines', async () => {
  const response = await worker.fetch(new Request('https://voice.example/health'), {
    HF_VOXCPM_TTS_ENABLED: 'true',
    HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
    HF_VOXCPM_TOKEN: 'test-token',
    VOICE_POLICY: 'voxcpm_canary',
    VOXCPM_ROLLOUT_PERCENT: '1'
  });
  const body = await response.json();
  assert.equal(body.politiqueVoix, 'voxcpm_canary');
  assert.equal(body.rolloutPercent, 1);
  assert.ok(body.moteurs.includes('voxcpm:zerogpu'));
  assert.ok(body.moteurs.includes('google:ar'));
});

test('invalid rollout configuration safely resolves to zero percent', async () => {
  const response = await worker.fetch(new Request('https://voice.example/health'), {
    HF_VOXCPM_TTS_ENABLED: 'true',
    HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
    HF_VOXCPM_TOKEN: 'test-token',
    VOXCPM_ROLLOUT_PERCENT: 'not-a-number'
  });
  const body = await response.json();
  assert.equal(body.rolloutPercent, 0);
  assert.equal(body.voxcpmEtat, 'pilot_closed');
});

test('pilot endpoint fails closed when its operator secret is not configured', async () => {
  const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }), {
    VOICE_PILOT_AUTH_REQUIRED: 'true',
    HF_VOXCPM_TTS_ENABLED: 'true',
    HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
    HF_VOXCPM_TOKEN: 'hf-test-token',
    VOICE_POLICY: 'voxcpm_only',
    VOXCPM_ROLLOUT_PERCENT: '100'
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'pilot_auth_unconfigured');
});

test('pilot endpoint denies requests without the operator bearer token before GPU work', async () => {
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls++; throw new Error('GPU must not be called'); };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }), {
      VOICE_PILOT_AUTH_REQUIRED: 'true',
      VOICE_PILOT_TOKEN: 'pilot-secret',
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'hf-test-token',
      VOICE_POLICY: 'voxcpm_only',
      VOXCPM_ROLLOUT_PERCENT: '100',
      VOICE_LIMITER: { limit: async () => ({ success: true }) }
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.code, 'pilot_auth_required');
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('synthesizes through the authenticated Gradio queue and validates the returned WAV', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const audio = testWav();
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname === '/gradio_api/call/synthesize') {
      return Response.json({ event_id: 'event-test-1' });
    }
    if (url.pathname === '/gradio_api/call/synthesize/event-test-1') {
      return new Response('event: complete\ndata: [{"url":"/gradio_api/file=voice.wav"}]\n\n');
    }
    if (url.pathname === '/gradio_api/file=voice.wav') {
      return new Response(audio, { headers: { 'content-type': 'audio/wav' } });
    }
    throw new Error('unexpected URL ' + url);
  };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }), {
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'secret-test-token',
      VOICE_POLICY: 'voxcpm_only',
      VOXCPM_ROLLOUT_PERCENT: '100',
      VOICE_LIMITER: { limit: async () => ({ success: true }) }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.moteur, 'voxcpm:zerogpu');
    assert.equal(body.mime, 'audio/wav');
    assert.equal(body.texteLu, 'يَا حْيَاتِي');
    assert.ok(body.octets > 32000);
    assert.equal(JSON.stringify(body).includes('secret-test-token'), false);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer secret-test-token'));
    assert.equal(calls[0].options.body, JSON.stringify({ data: ['يَا حْيَاتِي'] }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps Hugging Face quota responses to a retryable quota error without fallback', async () => {
  const originalFetch = globalThis.fetch;
  let fallbackCalls = 0;
  globalThis.fetch = async () => new Response('quota exceeded', { status: 429 });
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }), {
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'secret-test-token',
      VOICE_POLICY: 'voxcpm_only',
      VOXCPM_ROLLOUT_PERCENT: '100',
      VOICE_LIMITER: { limit: async () => ({ success: true }) },
      AI: { run: async () => { fallbackCalls++; return {}; } }
    });
    const body = await response.json();
    assert.equal(response.status, 429);
    assert.equal(body.code, 'quota_unavailable');
    assert.equal(body.retryable, true);
    assert.equal(fallbackCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns a safe retry countdown when ZeroGPU includes a renewal time', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/gradio_api/call/synthesize') return Response.json({ event_id: 'event-quota-clock' });
    if (url.pathname === '/gradio_api/call/synthesize/event-quota-clock') {
      return new Response('event: error\ndata: "You have exceeded your free ZeroGPU quota. Try again in 1:40:05. Subscribe at https://private.example/path"\n\n');
    }
    throw new Error('unexpected URL ' + url);
  };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }), {
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'hf-test-token',
      VOICE_POLICY: 'voxcpm_only',
      VOXCPM_ROLLOUT_PERCENT: '100',
      VOICE_LIMITER: { limit: async () => ({ success: true }) }
    });
    const body = await response.json();
    assert.equal(response.status, 429);
    assert.equal(body.code, 'quota_unavailable');
    assert.equal(body.retryAfterSeconds, 6005);
    assert.equal(JSON.stringify(body).includes('private.example'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps generic ZeroGPU errors distinct from confirmed GPU-capacity failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/gradio_api/call/synthesize') return Response.json({ event_id: 'event-error' });
    if (url.pathname === '/gradio_api/call/synthesize/event-error') {
      return new Response('event: error\ndata: "ZeroGPU task failed: private runtime detail"\n\n');
    }
    throw new Error('unexpected URL ' + url);
  };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }, {
      authorization: 'Bearer pilot-secret'
    }), {
      VOICE_PILOT_AUTH_REQUIRED: 'true',
      VOICE_PILOT_TOKEN: 'pilot-secret',
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'hf-test-token',
      VOICE_POLICY: 'voxcpm_only',
      VOXCPM_ROLLOUT_PERCENT: '100',
      VOICE_LIMITER: { limit: async () => ({ success: true }) }
    });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, 'generation_failed');
    assert.match(body.error, /consulter les journaux du Space/);
    assert.doesNotMatch(body.error, /private runtime detail|GPU indisponible/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns sanitized upstream detail only from the authenticated pilot', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/gradio_api/call/synthesize') return Response.json({ event_id: 'event-detail' });
    if (url.pathname === '/gradio_api/call/synthesize/event-detail') {
      return new Response('event: error\ndata: "RuntimeError: ZeroGPU failed for يَا حْيَاتِي; hf_abcdefghijklmnopqrstuvwxyz123456"\n\n');
    }
    throw new Error('unexpected URL ' + url);
  };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }, {
      authorization: 'Bearer pilot-secret'
    }), {
      VOICE_PILOT_AUTH_REQUIRED: 'true',
      VOICE_PILOT_TOKEN: 'pilot-secret',
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'hf-test-token',
      VOICE_POLICY: 'voxcpm_only',
      VOXCPM_ROLLOUT_PERCENT: '100',
      VOICE_LIMITER: { limit: async () => ({ success: true }) }
    });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.deepEqual(body.diagnostic, {
      category: 'model_runtime',
      detail: 'RuntimeError: ZeroGPU failed for [texte arabe masqué] [texte arabe masqué]; [jeton masqué]'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries a confirmed transient ZeroGPU capacity error once without fallback', async () => {
  const originalFetch = globalThis.fetch;
  let submissions = 0;
  const audio = testWav();
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/gradio_api/call/synthesize') {
      submissions++;
      return Response.json({ event_id: `event-retry-${submissions}` });
    }
    if (url.pathname === '/gradio_api/call/synthesize/event-retry-1') {
      return new Response('event: error\ndata: "GPU unavailable: no available GPU"\n\n');
    }
    if (url.pathname === '/gradio_api/call/synthesize/event-retry-2') {
      return new Response('event: complete\ndata: [{"url":"/gradio_api/file=voice.wav"}]\n\n');
    }
    if (url.pathname === '/gradio_api/file=voice.wav') {
      return new Response(audio, { headers: { 'content-type': 'audio/wav' } });
    }
    throw new Error('unexpected URL ' + url);
  };
  try {
    const response = await worker.fetch(request({ text: 'ya 7yati', ar: 'يَا حْيَاتِي' }), {
      HF_VOXCPM_TTS_ENABLED: 'true',
      HF_VOXCPM_SPACE_URL: 'https://sample.hf.space',
      HF_VOXCPM_TOKEN: 'hf-test-token',
      VOICE_POLICY: 'voxcpm_only',
      VOXCPM_ROLLOUT_PERCENT: '100',
      VOICE_LIMITER: { limit: async () => ({ success: true }) }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.moteur, 'voxcpm:zerogpu');
    assert.equal(submissions, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
