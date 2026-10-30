import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPcmWav } from './voice-quality.mjs';

function pcmWav(samples, sampleRate = 16000) {
  const dataSize = samples.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => [...value].forEach((char, index) => bytes[offset + index] = char.charCodeAt(0));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, dataSize, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

test('accepts clear, unclipped PCM narration', () => {
  const samples = Array.from({ length: 16000 }, (_, index) => Math.round(Math.sin(index * 0.12) * 9000));
  const result = inspectPcmWav(pcmWav(samples));
  assert.equal(result.ok, true);
  assert.equal(result.sampleRate, 16000);
});

test('rejects silent WAV instead of returning it as speech', () => {
  assert.deepEqual(inspectPcmWav(pcmWav(Array(16000).fill(0))), { ok: false, reason: 'silent_audio' });
});

test('rejects near-clipped narration', () => {
  assert.deepEqual(inspectPcmWav(pcmWav(Array(16000).fill(32767))), { ok: false, reason: 'clipped_audio' });
});

test('rejects truncated or invalid WAV data', () => {
  assert.equal(inspectPcmWav(pcmWav(Array(100).fill(5000))).reason, 'duration_out_of_range');
  assert.equal(inspectPcmWav(new Uint8Array(64)).reason, 'invalid_container');
});
