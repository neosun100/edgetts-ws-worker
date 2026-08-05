// Serves the built UI with a stubbed API, for browser tests. Zero dependencies.
//
// The point is to exercise the REAL playback code path (Web Audio scheduling for PCM,
// <audio> for containers) without depending on Microsoft or on network conditions —
// so the "streaming must not truncate" regression can be asserted deterministically.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync as readFileSyncSync } from 'node:fs';
import { __test__ } from '../../src/worker.js';
const { mergeWebmChunks } = __test__;
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

/**
 * Real upstream WebM/Opus chunks merged with the Worker's own mergeWebmChunks, cached.
 * Returns null when the fixtures are absent so callers can skip rather than fail.
 */
let opusCache;
export function opusFixture() {
  if (opusCache !== undefined) return opusCache;
  try {
    const dir = join(root, "test/fixtures");
    const parts = [];
    for (let i = 0; i < 3; i++) {
      parts.push(new Uint8Array(readFileSyncSync(join(dir, "opus-chunk" + i + ".webm"))).buffer);
    }
    opusCache = Buffer.from(mergeWebmChunks(parts));
  } catch {
    opusCache = null;
  }
  return opusCache;
}

/**
 * 本地供给 Vue，而不是让浏览器去 unpkg 拉。
 *
 * 这是本套件长期间歇性失败的根因:UI 用 <script src="https://unpkg.com/..."> 加载 Vue，
 * 于是每个浏览器测试都隐含依赖外部 CDN。CDN 一慢或不通，page.goto 就在
 * readyState=complete 上超时（报 "page load timeout"），或者页面起来了但 window.Vue
 * 不存在、DOM 里一个 .voice-item 都没有 —— 症状看起来像被测代码坏了。实测同一时刻
 * node 侧 curl unpkg 三次都是 200，而 headless Chrome 侧时通时不通。
 *
 * 首次运行时下载到 test/.cache/（已 gitignore，不进仓库），之后离线也能跑。拿不到且无缓存
 * 时返回 null，调用方据此跳过浏览器测试并说明原因 —— 比让它们以超时的形式失败清楚得多。
 */
const VUE_CACHE = join(root, 'test/.cache/vue.global.js');
const VUE_URL = 'https://unpkg.com/vue@3.5.40/dist/vue.global.js';
let vueBytes;

export async function ensureVue() {
  if (vueBytes !== undefined) return vueBytes;
  try {
    vueBytes = await readFile(VUE_CACHE);
    return vueBytes;
  } catch { /* 没缓存，去下载 */ }
  try {
    const res = await fetch(VUE_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(VUE_CACHE), { recursive: true });
    await writeFile(VUE_CACHE, buf);
    vueBytes = buf;
  } catch (e) {
    console.warn('[ui-server] 无法获取 Vue（' + e.message + '）：浏览器测试将跳过。' +
                 '联网后重跑一次即可缓存到 test/.cache/。');
    vueBytes = null;
  }
  return vueBytes;
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
 *  - failSpeech: when set, /v1/audio/speech answers with this status instead of audio —
 *    for asserting that the UI cleans up after a failure
 *  - emptyStream: answer a streaming request with 200 and zero bytes, the way a request
 *    killed at the edge looks to the client — a clean chunked EOF with nothing to
 *    reconcile against, which is why the UI could not tell it from success
 *  - failSpeechPlainText: with failSpeech, answer with a text/plain body (like the bare
 *    503 Cloudflare itself returns) instead of the JSON error shape
 */
export async function startUiServer(opts = {}) {
  const {
    pcmSeconds = 3, chunkMs = 200, chunkDelayMs = 15,
    failSpeech = 0, failSpeechPlainText = false, emptyStream = false,
  } = opts;
  const vue = await ensureVue();
  let html = await extractUiHtml();
  // 把 unpkg 换成本地路径，并去掉 integrity —— 摘要是给线上那份 CDN 响应算的，
  // 本地这份字节相同但走的是不同 URL，保留 crossorigin/integrity 只会带来无谓的失败面。
  // 标签是多行的（src / integrity / crossorigin / referrerpolicy 各占一行），
  // 所以必须用 [\s\S] 跨行匹配 —— [^>]* 在这里匹配不到。
  // 只匹配「带 src 且指向 unpkg 的」那个标签。此前从任意 <script 起匹配，会先撞上
  // 页面里别的 script，把中间大段内容一起吞掉。标签本身是多行的，所以用 [\s\S]。
  html = html.replace(
    /<script\s+src="https:\/\/unpkg\.com[\s\S]*?<\/script>/,
    '<script src="/vendor/vue.global.js"></script>'
  );
  if (html.includes('unpkg.com')) {
    throw new Error('ui-server: 未能把 Vue 的 CDN 引用替换成本地路径，浏览器测试会依赖外网');
  }
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

      if (failSpeech) {
        // text/plain mirrors what Cloudflare returns when it kills the request itself
        // ("error code: 1102"); the UI must not try to JSON.parse that.
        const plain = failSpeechPlainText;
        res.writeHead(failSpeech, {
          'Content-Type': plain ? 'text/plain' : 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          plain
            ? 'error code: 1102'
            : JSON.stringify({ error: { message: 'stub failure', code: 'tts_generation_error' } })
        );
        return;
      }

      const body = stats.lastBody || {};
      const pcm = makePcm(pcmSeconds);
      const isStream = body.stream === true;
      const fmt = body.response_format || 'mp3';

      if (isStream && emptyStream) {
        res.writeHead(200, { 'Content-Type': 'audio/pcm', 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
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
      } else if (fmt === 'opus') {
        // Real upstream WebM/Opus, merged the way the Worker does it. A synthesised WAV
        // cannot exercise this path: the bug being guarded is that <audio> stops at the
        // first EBML container, which only shows up with genuine WebM bytes.
        const webm = opusFixture();
        if (!webm) {
          res.writeHead(503, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          return res.end('opus fixtures missing');
        }
        stats.bytesSent += webm.length;
        res.writeHead(200, {
          'Content-Type': 'audio/webm',
          'Content-Length': webm.length,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(webm);
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

    if (url.pathname === '/vendor/vue.global.js') {
      if (!vue) { res.writeHead(503); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Content-Length': vue.length });
      return res.end(vue);
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
    async close() {
      // server.close() only stops accepting NEW connections; it then waits for existing
      // ones to end. Chrome holds keep-alive sockets open, so closing a per-test server
      // blocked for 6+ seconds (measured) and one e2e test took 58s. closeAllConnections
      // drops them, which is what we want: the test is finished with this server.
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
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
