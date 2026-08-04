// Serves the built UI with a stubbed API, for browser tests. Zero dependencies.
//
// The point is to exercise the REAL playback code path (Web Audio scheduling for PCM,
// <audio> for containers) without depending on Microsoft or on network conditions —
// so the "streaming must not truncate" regression can be asserted deterministically.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Extract the UI HTML back out of the built worker bundle. */
export async function extractUiHtml() {
  const dist = await readFile(join(root, 'dist/worker.js'), 'utf8');
  const m = dist.match(/const UI_HTML = `([\s\S]*?)`;\n/);
  if (!m) throw new Error('UI_HTML not found in dist/worker.js — run npm run build');
  // Reverse the build-time escaping (see scripts/build.mjs).
  return m[1].replace(/\\`/g, '`').replace(/\\\$\{/g, '${').replace(/\\\\/g, '\\');
}

/**
 * 24kHz 16-bit mono PCM, `seconds` long, that behaves like speech rather than a tone.
 *
 * A constant sine is NOT good enough: the visualiser derives hue from the spectral
 * centroid, so a fixed spectrum legitimately produces a fixed colour and a
 * "colour must change" assertion would fail against correct code. Real speech sweeps
 * its centroid (low vowels → high fricatives), so the fixture sweeps too, and also
 * carries a syllable envelope so onset/RMS logic has something to react to.
 */
export function makePcm(seconds, { amp = 0.3, sampleRate = 24000 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(n * 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // syllable envelope ~3.5Hz, so distinct bursts appear
    const env = Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 3.5), 2);
    // sweep the fundamental across the vocal range so the centroid (and hue) moves
    const f0 = 180 + 320 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.6));
    phase += (f0 / sampleRate) * Math.PI * 2;
    // a couple of harmonics + a noise component that grows with the sweep, which is
    // what pushes the spectral centroid up and down like fricatives vs vowels
    const noiseMix = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.9));
    const tone = Math.sin(phase) * 0.6 + Math.sin(phase * 2) * 0.3 + Math.sin(phase * 3) * 0.15;
    const s = (tone * (1 - noiseMix) + (Math.random() * 2 - 1) * noiseMix) * amp * env;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return buf;
}

const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', object: 'model', created: 0, owned_by: 'microsoft', language: 'zh-CN', gender: 'Female', description: '晓晓 - Female' },
  { id: 'en-US-AvaNeural', object: 'model', created: 0, owned_by: 'microsoft', language: 'en-US', gender: 'Female', description: 'Ava - Female' },
  { id: 'en-US-AvaMultilingualNeural', object: 'model', created: 0, owned_by: 'microsoft', language: 'en-US', gender: 'Female', description: 'Ava - Female' },
  { id: 'en-US-GuyNeural', object: 'model', created: 0, owned_by: 'microsoft', language: 'en-US', gender: 'Male', description: 'Guy - Male' },
];

/**
 * @param {object} opts
 *  - pcmSeconds: duration of audio the stubbed /v1/audio/speech returns
 *  - chunkMs: how much audio per streamed chunk (exercises incremental playback)
 *  - chunkDelayMs: delay between chunks, to simulate a slow upstream
 */
export async function startUiServer(opts = {}) {
  const { pcmSeconds = 3, chunkMs = 200, chunkDelayMs = 15 } = opts;
  const html = await extractUiHtml();
  const stats = { speechRequests: 0, lastBody: null, bytesSent: 0 };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/v1/models' || url.pathname === '/v1/models/public') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(VOICES));
      return;
    }

    if (url.pathname === '/v1/audio/speech' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      stats.speechRequests++;
      try { stats.lastBody = JSON.parse(Buffer.concat(chunks).toString()); } catch { stats.lastBody = null; }

      const body = stats.lastBody || {};
      const pcm = makePcm(pcmSeconds);
      const isStream = body.stream === true;
      const fmt = body.response_format || 'mp3';

      if (isStream) {
        // Stream raw PCM in small pieces, like the real worker does.
        res.writeHead(200, { 'Content-Type': 'audio/pcm', 'Access-Control-Allow-Origin': '*' });
        const bytesPerChunk = Math.max(2, Math.round((chunkMs / 1000) * 24000) * 2);
        for (let off = 0; off < pcm.length; off += bytesPerChunk) {
          res.write(pcm.subarray(off, Math.min(pcm.length, off + bytesPerChunk)));
          stats.bytesSent += Math.min(bytesPerChunk, pcm.length - off);
          if (chunkDelayMs) await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
        res.end();
      } else {
        // Non-streaming: hand back a WAV so <audio> can actually decode it.
        const wav = pcmToWav(pcm);
        stats.bytesSent += wav.length;
        res.writeHead(200, {
          'Content-Type': fmt === 'wav' ? 'audio/wav' : 'audio/wav',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(wav);
      }
      return;
    }

    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    async close() { await new Promise((r) => server.close(r)); },
  };
}

function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
