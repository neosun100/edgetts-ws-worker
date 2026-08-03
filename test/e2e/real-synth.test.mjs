// End-to-end test against a REAL deployed Worker + the REAL Microsoft upstream.
// No mocks here: this is the only suite that touches the network.
//
// Guarded by EDGETTS_E2E=1 (无凭证/未显式开启则整组 skip, 0 fail). Configuration:
//   EDGETTS_E2E=1                     enable this file
//   EDGETTS_E2E_BASE_URL=https://...  target deployment (default https://edgetts.aws.xin)
//   EDGETTS_E2E_KEY=<api key>         optional Bearer token; omitted => anonymous request
// Never hardcode a key here — it only ever comes from the environment.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const ENABLED = process.env.EDGETTS_E2E === '1';
const SKIP = ENABLED
  ? false
  : 'e2e disabled: set EDGETTS_E2E=1 (and optionally EDGETTS_E2E_KEY) to run';

const BASE_URL = (process.env.EDGETTS_E2E_BASE_URL || 'https://edgetts.aws.xin').replace(
  /\/+$/,
  ''
);
const API_KEY = process.env.EDGETTS_E2E_KEY || '';

// One fixed sentence for every format, so byte counts are comparable across formats.
const SENTENCE =
  'The quick brown fox jumps over the lazy dog. This sentence is synthesized end to end.';
const VOICE = 'en-US-AvaNeural';

// 24 kHz, 16-bit, mono => 48000 bytes per second of audio.
const BYTES_PER_SECOND = 48000;
const NET_TIMEOUT_MS = 60_000;

async function synth(response_format, { stream = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const res = await fetch(`${BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: SENTENCE,
      voice: VOICE,
      response_format,
      stream,
      speed: 1,
      pitch: 1,
    }),
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    cors: res.headers.get('access-control-allow-origin'),
    bytes,
  };
}

const ascii = (buf, offset, len) =>
  String.fromCharCode(...buf.subarray(offset, offset + len));

// ID3v2 tags are legal in front of the first MPEG frame; skip one if present so the
// frame-sync assertion targets the actual first frame header.
function firstMpegFrameOffset(buf) {
  if (buf.byteLength > 10 && ascii(buf, 0, 3) === 'ID3') {
    const size =
      (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]; // 4 x 7-bit syncsafe
    return 10 + size;
  }
  return 0;
}

// Walk RIFF chunks to the "data" chunk; returns { offset, declaredSize }.
function wavDataChunk(buf) {
  let pos = 12; // past "RIFF" <size> "WAVE"
  while (pos + 8 <= buf.byteLength) {
    const id = ascii(buf, pos, 4);
    const size =
      buf[pos + 4] | (buf[pos + 5] << 8) | (buf[pos + 6] << 16) | (buf[pos + 7] << 24);
    if (id === 'data') return { offset: pos + 8, declaredSize: size >>> 0 };
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('no data chunk in RIFF payload');
}

// `skip` is set per-test (not on the suite) so a credential-less run reports every case
// as explicitly skipped instead of silently registering zero tests.
describe('e2e: real synthesis against a deployed Worker', { timeout: 300_000 }, () => {
  /** @type {Record<string, {status:number, contentType:string, cors:string|null, bytes:Uint8Array}>} */
  const got = {};

  before(async () => {
    if (!ENABLED) return; // never touch the network in the default (skipped) run
    // Sequential on purpose: one real upstream call per format, keeps the failure obvious.
    got.mp3 = await synth('mp3');
    got.opus = await synth('opus');
    got.wav = await synth('wav');
    got.pcm = await synth('pcm');
    got.pcmStream = await synth('pcm', { stream: true });
  });

  it('mp3: 200 audio/mpeg with an MPEG frame sync (0xFF 0xEx/0xFx)', { skip: SKIP }, () => {
    const { status, contentType, cors, bytes } = got.mp3;
    assert.equal(status, 200);
    assert.match(contentType, /^audio\/mpeg/);
    assert.equal(cors, '*');
    assert.ok(bytes.byteLength > 1000, `mp3 too small: ${bytes.byteLength} bytes`);
    const off = firstMpegFrameOffset(bytes);
    assert.equal(bytes[off], 0xff, `byte[${off}] should be 0xFF, got 0x${bytes[off].toString(16)}`);
    // The frame sync is 11 bits: 0xFF then the top 3 bits of byte 1 (so 0xEx or 0xFx —
    // the 4th bit belongs to the MPEG version field, not to the sync word).
    const b1 = bytes[off + 1];
    assert.equal(
      b1 & 0xe0,
      0xe0,
      `byte[${off + 1}] top 3 bits must complete the frame sync, got 0x${b1.toString(16)}`
    );
    // audio-24khz-48kbitrate-mono-mp3 => MPEG-2 (version bits 0b10), Layer III (0b01).
    assert.equal((b1 >> 3) & 0b11, 0b10, 'MPEG version field should be MPEG-2');
    assert.equal((b1 >> 1) & 0b11, 0b01, 'Layer field should be Layer III');
  });

  it('wav: 200 audio/wav starting with RIFF....WAVE', { skip: SKIP }, () => {
    const { status, contentType, bytes } = got.wav;
    assert.equal(status, 200);
    assert.match(contentType, /^audio\/wav/);
    assert.equal(ascii(bytes, 0, 4), 'RIFF');
    assert.equal(ascii(bytes, 8, 4), 'WAVE');
    // 24 kHz, mono, 16-bit is declared in the fmt chunk right after "WAVE".
    assert.equal(ascii(bytes, 12, 4), 'fmt ');
    const channels = bytes[22] | (bytes[23] << 8);
    const sampleRate = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16) | (bytes[27] << 24);
    const bitsPerSample = bytes[34] | (bytes[35] << 8);
    assert.equal(channels, 1);
    assert.equal(sampleRate, 24000);
    assert.equal(bitsPerSample, 16);
  });

  it('opus: 200 audio/webm starting with the EBML magic', { skip: SKIP }, () => {
    const { status, contentType, bytes } = got.opus;
    assert.equal(status, 200);
    assert.match(contentType, /^audio\/webm/);
    assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(bytes.byteLength > 1000, `opus too small: ${bytes.byteLength} bytes`);
  });

  it('pcm: byte count matches duration * 48000 (24 kHz 16-bit mono)', { skip: SKIP }, () => {
    const { status, contentType, bytes } = got.pcm;
    assert.equal(status, 200);
    assert.match(contentType, /^audio\/pcm/);
    assert.equal(bytes.byteLength % 2, 0, 'PCM16 payload must be an even number of bytes');
    const seconds = bytes.byteLength / BYTES_PER_SECOND;
    // The sentence is ~5s of speech; anything outside 1–20s means the frame layout
    // (sample rate / width / channels) is not what we assume.
    assert.ok(seconds > 1 && seconds < 20, `implied duration ${seconds.toFixed(2)}s out of range`);

    // Cross-check against the wav payload: same PCM samples, plus a RIFF header.
    const { offset, declaredSize } = wavDataChunk(got.wav.bytes);
    const wavPcmBytes = got.wav.bytes.byteLength - offset;
    // Upstream declares 0xFFFFFFFF for streamed RIFF; only compare when it is sane.
    if (declaredSize !== 0xffffffff && declaredSize > 0) {
      assert.equal(declaredSize, wavPcmBytes, 'RIFF data chunk size matches payload tail');
    }
    const drift = Math.abs(wavPcmBytes - bytes.byteLength) / bytes.byteLength;
    assert.ok(
      drift < 0.05,
      `wav PCM payload ${wavPcmBytes} vs raw pcm ${bytes.byteLength} differ by ${(drift * 100).toFixed(1)}%`
    );
  });

  it('streaming pcm returns the same byte count as non-streaming pcm', { skip: SKIP }, () => {
    assert.equal(got.pcmStream.status, 200);
    assert.match(got.pcmStream.contentType, /^audio\/pcm/);
    assert.equal(
      got.pcmStream.bytes.byteLength,
      got.pcm.bytes.byteLength,
      `stream=${got.pcmStream.bytes.byteLength} vs buffered=${got.pcm.bytes.byteLength}`
    );
    assert.equal(got.pcmStream.bytes.byteLength % 2, 0);
  });

  it('rejects an unsupported format (aac) with 400 invalid_response_format', { skip: SKIP }, async () => {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
    const res = await fetch(`${BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: 'hi', voice: VOICE, response_format: 'aac' }),
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'invalid_response_format');
  });
});
