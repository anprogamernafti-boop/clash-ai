export function inspectPcmWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const fail = (reason) => ({ ok: false, reason });
  if (bytes.length < 46 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    return fail('invalid_container');
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const length = readU32(bytes, offset + 4);
    const start = offset + 8;
    if (length > bytes.length - start) return fail('truncated_chunk');
    if (id === 'fmt ' && length >= 16) {
      format = {
        encoding: readU16(bytes, start),
        channels: readU16(bytes, start + 2),
        sampleRate: readU32(bytes, start + 4),
        bits: readU16(bytes, start + 14)
      };
    } else if (id === 'data') {
      dataOffset = start;
      dataLength = length;
    }
    offset = start + length + (length & 1);
  }

  if (!format || dataOffset < 0 || format.encoding !== 1 || format.bits !== 16
      || format.channels < 1 || format.channels > 2 || format.sampleRate < 8000 || format.sampleRate > 96000) {
    return fail('unsupported_wav');
  }
  const frameBytes = format.channels * 2;
  const frames = Math.floor(dataLength / frameBytes);
  const duration = frames / format.sampleRate;
  if (!frames || duration < 0.3 || duration > 90) return fail('duration_out_of_range');

  let peak = 0;
  let sumSquares = 0;
  let silent = 0;
  let clipped = 0;
  const samples = frames * format.channels;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples; i++) {
    const value = view.getInt16(dataOffset + i * 2, true) / 32768;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sumSquares += value * value;
    if (magnitude < 0.0005) silent++;
    if (magnitude >= 0.999) clipped++;
  }
  const rms = Math.sqrt(sumSquares / samples);
  const silenceRatio = silent / samples;
  const clippingRatio = clipped / samples;
  if (rms < 0.003 || peak < 0.02 || silenceRatio > 0.985) return fail('silent_audio');
  if (clippingRatio > 0.005) return fail('clipped_audio');
  return { ok: true, duration, peak, rms, silenceRatio, clippingRatio, sampleRate: format.sampleRate };
}

function readAscii(bytes, offset, length) {
  let result = '';
  for (let i = 0; i < length; i++) result += String.fromCharCode(bytes[offset + i]);
  return result;
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
