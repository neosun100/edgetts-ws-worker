// Mock harness for the three Microsoft upstreams the Worker talks to via global fetch:
//   1. token endpoint   dev.microsofttranslator.com/apps/endpoint  -> { r, t }
//   2. synthesis        {region}.tts.speech.microsoft.com/cognitiveservices/v1 -> audio bytes
//   3. voice list       speech.platform.bing.com/.../voices/list  -> [ {ShortName,...} ]
//
// Install it around a test with installMockFetch(); every test that exercises the fetch
// handler uses this instead of hitting the network, so the suite is deterministic and
// offline. The mock records calls so tests can assert on concurrency, retries, etc.
import { readFileSync } from 'node:fs';

const VOICES = JSON.parse(
  readFileSync(new URL('./voices-snapshot.json', import.meta.url), 'utf8')
);

// Minimal base64url — enough for the Worker's atob(jwt).JSON.parse path.
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '');
}

// A JWT whose payload carries an `exp` the Worker reads. `expInSeconds` from now.
export function makeToken(expInSeconds = 600) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = b64url({ exp: nowSec + expInSeconds, region: 'testus' });
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${payload}.sig`;
}

// Deterministic fake PCM: 24kHz 16-bit mono, `ms` milliseconds -> ms*48 bytes.
export function fakeAudio(ms = 100) {
  return new Uint8Array(Math.round(ms * 48)); // 24000 samples/s * 2 bytes / 1000
}

/**
 * @param {object} opts
 *  - tokenExp: seconds until token expiry (default 600)
 *  - failTokenTimes: fail the token endpoint N times before succeeding
 *  - synth: (req, {ssml, format}) => Response | {status, body} | throws  — override per test
 *  - synthDelayMs: artificial delay per synthesis call (to test concurrency ordering)
 *  - failSynthOnce: {status} — fail the first synthesis call, then succeed (retry test)
 *  - voices: override the voice list array
 */
export function installMockFetch(opts = {}) {
  const {
    tokenExp = 600,
    failTokenTimes = 0,
    synth,
    synthDelayMs = 0,
    failSynthOnce,
    voices = VOICES,
    region = 'testus',
  } = opts;

  const calls = { token: 0, synth: 0, voices: 0, synthOrder: [], synthSsml: [] };
  let tokenFailsLeft = failTokenTimes;
  let synthFailPending = failSynthOnce ? { ...failSynthOnce } : null;
  const original = globalThis.fetch;

  // The Worker logs progress via console.*. Under `node --test`, results are multiplexed
  // over stdout, and the Worker writing to stdout mid-test can corrupt that channel
  // ("Unable to deserialize cloned data"). Capture logs instead of printing them; tests
  // can inspect `logs` when they need to assert on a warning (e.g. anonymous-mode notice).
  const logs = [];
  const savedConsole = { log: console.log, warn: console.warn, error: console.error };
  const capture = (level) => (...args) => logs.push({ level, msg: args.join(' ') });
  console.log = capture('log');
  console.warn = capture('warn');
  console.error = capture('error');

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    // 1. Token endpoint
    if (url.includes('dev.microsofttranslator.com/apps/endpoint')) {
      calls.token++;
      if (tokenFailsLeft > 0) {
        tokenFailsLeft--;
        return new Response('token down', { status: 503 });
      }
      return new Response(JSON.stringify({ r: region, t: makeToken(tokenExp) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Synthesis endpoint
    if (url.includes('.tts.speech.microsoft.com/cognitiveservices/v1')) {
      const idx = calls.synth++;
      const ssml = init.body ? String(init.body) : '';
      calls.synthSsml.push(ssml);
      const format = init.headers?.['X-Microsoft-OutputFormat'] || '';
      if (synthDelayMs) await new Promise((r) => setTimeout(r, synthDelayMs));
      calls.synthOrder.push(idx);

      if (synthFailPending) {
        const { status } = synthFailPending;
        synthFailPending = null;
        return new Response('transient', { status });
      }
      if (typeof synth === 'function') {
        const out = await synth({ url, init, ssml, format, index: idx });
        if (out instanceof Response) return out;
        if (out && typeof out === 'object') {
          return new Response(out.body ?? fakeAudio(), { status: out.status ?? 200 });
        }
      }
      // Default: 100ms of fake audio.
      return new Response(fakeAudio(100), {
        status: 200,
        headers: { 'Content-Type': format.includes('mp3') ? 'audio/mpeg' : 'audio/pcm' },
      });
    }

    // 3. Voice list
    if (url.includes('/voices/list')) {
      calls.voices++;
      return new Response(JSON.stringify(voices), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`mock-upstream: unexpected fetch to ${url}`);
  };

  return {
    calls,
    logs,
    restore() {
      globalThis.fetch = original;
      console.log = savedConsole.log;
      console.warn = savedConsole.warn;
      console.error = savedConsole.error;
    },
  };
}

// Convenience: build a Request for the Worker's fetch handler.
export function speechRequest(body, { key, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (key) h['Authorization'] = `Bearer ${key}`;
  return new Request('https://tts.test/v1/audio/speech', {
    method: 'POST',
    headers: h,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function req(path, init = {}) {
  return new Request(`https://tts.test${path}`, init);
}

export { VOICES };
