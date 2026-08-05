// Regression tests: one named test per bug that was actually shipped and fixed.
// Each name states the bug it guards, so a failure here says "the old bug is back".
//
// Static assertions read ui/index.html (and dist/worker.js when built) on purpose:
// several of the fixed bugs live in the browser half of the app, where the only
// dependency-free check is the shipped source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest, req } from '../helpers/mock-upstream.mjs';

const ROOT = new URL('../../', import.meta.url);
const UI_PATH = fileURLToPath(new URL('ui/index.html', ROOT));
const DIST_PATH = fileURLToPath(new URL('dist/worker.js', ROOT));
const UI = readFileSync(UI_PATH, 'utf8');

const ANON = { ALLOW_ANONYMOUS: 'true' };
const CLOSE_SCRIPT = '</scr' + 'ipt>'; // avoid a literal closing tag in this file's text

// ---------------------------------------------------------------------------
// BUG 1: streaming used to keep the container format (mp3/opus), so <audio>
// decoded the first chunk as a complete short file and fired 'ended' immediately.
// Fix: the UI rewrites response_format to 'pcm' for every streaming request.
// ---------------------------------------------------------------------------
test('BUG#1 streaming must force PCM: UI rewrites response_format to pcm before streaming', () => {
  assert.match(
    UI,
    /requestBody\.response_format\s*=\s*'pcm'/,
    'ui/index.html must assign requestBody.response_format = \'pcm\' for streaming'
  );
  // The rewrite has to be guarded by isStream, not by format alone.
  assert.match(
    UI,
    /if\s*\(\s*isStream\s*&&\s*requestBody\.response_format\s*!==\s*'pcm'\s*\)/,
    'the pcm rewrite must be conditioned on isStream'
  );
});

test('BUG#1b no byte-size threshold gates streaming playback (the old `size > 10000` hack is gone)', () => {
  assert.doesNotMatch(
    UI,
    /size\s*>\s*10000/,
    'ui/index.html must not gate playback on a magic 10000-byte buffer threshold'
  );
  assert.equal(UI.includes('10000'), false, 'no bare 10000 threshold anywhere in the UI');
});

// ---------------------------------------------------------------------------
// BUG 2: `if (env.API_KEY)` meant a missing binding silently made the API public.
// Fix: missing key is a 503 unless ALLOW_ANONYMOUS === 'true'.
// ---------------------------------------------------------------------------
test('BUG#2 auth must not silently bypass: missing API_KEY without ALLOW_ANONYMOUS is 503, not 200', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'hello', voice: 'en-US-AvaNeural' }),
      {}, // no API_KEY, no ALLOW_ANONYMOUS
      {}
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'server_misconfigured');
    assert.equal(body.error.type, 'api_error');
    assert.equal(mock.calls.token, 0, 'must not touch upstream at all');
    assert.equal(mock.calls.synth, 0, 'must not synthesize anything');
    assert.ok(
      mock.logs.some((l) => l.level === 'error' && l.msg.includes('ALLOW_ANONYMOUS')),
      'the refusal must be logged, not silent'
    );
  } finally {
    mock.restore();
  }
});

test('BUG#2b ALLOW_ANONYMOUS="true" is the only opt-out: "1"/"yes" still 503', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    for (const value of ['1', 'yes', 'TRUE', '']) {
      const res = await worker.fetch(
        speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
        { ALLOW_ANONYMOUS: value },
        {}
      );
      assert.equal(res.status, 503, `ALLOW_ANONYMOUS=${JSON.stringify(value)} must not open the API`);
      assert.equal((await res.json()).error.code, 'server_misconfigured');
    }
    assert.equal(mock.calls.synth, 0);
  } finally {
    mock.restore();
  }
});

test('BUG#2c a wrong Bearer key is 401 invalid_api_key and never reaches upstream', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }, { key: 'wrong' }),
      { API_KEY: 'right' },
      {}
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'invalid_api_key');
    assert.equal(mock.calls.token, 0);
    assert.equal(mock.calls.synth, 0);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// BUG 3: `voice` was interpolated raw into the SSML <voice name="..."> attribute,
// so a crafted name could inject arbitrary SSML (extra <voice>/<audio> elements).
// Fix: allowlist regex rejects it with 400 before any upstream call, and getSsml
// escapes attributes on its own so a future caller can't reintroduce it.
// ---------------------------------------------------------------------------
test('BUG#3 SSML injection via voice: rejected 400 invalid_voice with zero upstream calls', async () => {
  const payloads = [
    'zh-CN-XiaoxiaoNeural"><audio src="http://evil/x.mp3"/><voice name="zh-CN-XiaoxiaoNeural',
    'x"><prosody rate="-100%">INJECTED</prosody></voice><voice name="zh-CN-XiaoxiaoNeural',
    'zh-CN-XiaoxiaoNeural\'/><break time="10s"/>',
    '<voice name="zh-CN-XiaoxiaoNeural">',
  ];
  for (const voice of payloads) {
    __test__.resetTokenCache();
    const mock = installMockFetch();
    try {
      const res = await worker.fetch(speechRequest({ input: 'hi', voice }), ANON, {});
      assert.equal(res.status, 400, `payload must be rejected: ${voice}`);
      assert.equal((await res.json()).error.code, 'invalid_voice');
      assert.equal(mock.calls.synth, 0, 'injection payload must never reach upstream');
      assert.equal(mock.calls.token, 0);
      // Defence in depth: if a future refactor did let it through, the SSML must
      // still carry an escaped attribute rather than a live tag.
      for (const ssml of mock.calls.synthSsml) {
        assert.doesNotMatch(ssml, /<audio\b/i);
        assert.equal(ssml.split('<voice ').length - 1, 1, 'exactly one <voice> element');
      }
    } finally {
      mock.restore();
    }
  }
});

test('BUG#3b getSsml escapes voice/style attributes even when called directly', () => {
  const ssml = __test__.getSsml('hi', 'a"><audio src="x"/>', '0', '0', 'ge"neral');
  assert.ok(ssml.includes('&quot;&gt;&lt;audio src=&quot;x&quot;/&gt;'), 'voice attr escaped');
  assert.ok(ssml.includes('style="ge&quot;neral"'), 'style attr escaped');
  assert.equal(ssml.split('<voice ').length - 1, 1);
  assert.doesNotMatch(ssml, /<audio\b/i);
});

test('BUG#3c a style outside the allowlist is 400 invalid_style, not escaped-and-sent', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', style: 'cheer"><audio src="x"/>' }),
      ANON,
      {}
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_style');
    assert.equal(mock.calls.synth, 0);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// BUG 4: pipeChunksToStream awaited each chunk sequentially, so `concurrency`
// did nothing. Fix: sliding-window prefetch that still writes strictly in order.
// (Timing/window-size behaviour is covered by the streaming suite; here we only
// pin the ordering invariant that the rewrite could have broken.)
// ---------------------------------------------------------------------------
test('BUG#4 concurrency was a no-op: prefetched chunks are still written in strict order', async () => {
  __test__.resetTokenCache();
  // Distinct payload per chunk, finishing in reverse order: chunk 0 is slowest.
  // A naive "write as they resolve" implementation would emit 5,4,3,2,1.
  const total = 5;
  const mock = installMockFetch({
    synth: async ({ index }) => {
      await new Promise((r) => setTimeout(r, (total - index) * 25));
      return new Response(new Uint8Array(4).fill(index + 1), { status: 200 });
    },
  });
  try {
    const input = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'].map((s) => s.repeat(20)).join('。') + '。';
    const res = await worker.fetch(
      speechRequest({
        input,
        voice: 'en-US-AvaNeural',
        stream: true,
        response_format: 'pcm',
        chunk_size: 61,
        concurrency: 5,
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/pcm');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes.byteLength, total * 4, 'all 5 chunks written, none dropped');
    assert.deepEqual(
      Array.from(bytes),
      [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5],
      'output order must follow chunk order, not completion order'
    );
    assert.equal(mock.calls.synth, total);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// BUG 5: aac/flac were advertised but every bitrate variant gets a bare 400 from
// the cognitiveservices endpoint, surfacing as an opaque 500 tts_generation_error.
// Fix: reject unknown formats locally with 400 invalid_response_format.
// ---------------------------------------------------------------------------
test('BUG#5 aac/flac are rejected locally as 400 invalid_response_format (not an opaque upstream 500)', async () => {
  for (const fmt of ['aac', 'flac', 'ogg', 'mp4', 'MP3', 'pcm16']) {
    __test__.resetTokenCache();
    const mock = installMockFetch();
    try {
      const res = await worker.fetch(
        speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', response_format: fmt }),
        ANON,
        {}
      );
      assert.equal(res.status, 400, `${fmt} must be a 400`);
      const body = await res.json();
      assert.equal(body.error.code, 'invalid_response_format');
      assert.match(body.error.message, /mp3 \| pcm \| opus \| wav/);
      assert.equal(mock.calls.synth, 0, `${fmt} must not reach upstream`);
    } finally {
      mock.restore();
    }
  }
});

test('BUG#5b the four supported formats still work end to end', async () => {
  const expected = {
    mp3: ['audio/mpeg', 'audio-24khz-48kbitrate-mono-mp3'],
    pcm: ['audio/pcm', 'raw-24khz-16bit-mono-pcm'],
    opus: ['audio/webm', 'webm-24khz-16bit-mono-opus'],
    wav: ['audio/wav', 'riff-24khz-16bit-mono-pcm'],
  };
  for (const [fmt, [contentType, upstreamFormat]] of Object.entries(expected)) {
    __test__.resetTokenCache();
    const seen = [];
    const mock = installMockFetch({ synth: ({ format }) => void seen.push(format) || { status: 200 } });
    try {
      const res = await worker.fetch(
        speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', response_format: fmt }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, `${fmt} must succeed`);
      assert.equal(res.headers.get('Content-Type'), contentType);
      assert.deepEqual(seen, [upstreamFormat], `${fmt} maps to the right X-Microsoft-OutputFormat`);
      assert.equal(mock.calls.synth, 1);
    } finally {
      mock.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// BUG 6: raw PCM was offered in the format dropdown, so the standard (non-stream)
// path handed a headerless PCM blob to <audio>, which cannot play it.
// Fix: pcm stays a valid *server* format (used internally for streaming) but the
// UI dropdown only offers container formats.
// ---------------------------------------------------------------------------
test('BUG#6 headerless PCM is unplayable in <audio>: UI dropdown offers no pcm option', () => {
  assert.equal(UI.includes('<option value="pcm"'), false, 'no pcm entry in the format dropdown');
  const options = [...UI.matchAll(/<option value="([a-z0-9]+)">/g)].map((m) => m[1]);
  assert.deepEqual(options, ['mp3', 'opus', 'wav'], 'dropdown offers exactly mp3/opus/wav');
  // pcm must remain a legal server-side format — it is what streaming uses.
  assert.match(UI, /pcm:\s*'audio\/pcm'/, 'UI still knows the pcm MIME type for streaming');
});

test('BUG#6b pcm remains a valid API format even though the UI hides it', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', response_format: 'pcm' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/pcm');
    assert.equal((await res.arrayBuffer()).byteLength, 4800, '100ms of fake 24k/16bit audio');
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// BUG 7: the UI was inlined into a JS template literal; an over-eager
// `</script>` -> `<\/script>` escape leaked into the served HTML, so the browser
// saw a literal backslash and the Vue app never booted. dist/worker.js is served
// as a JS module, so no such escaping is needed.
// ---------------------------------------------------------------------------
test('BUG#7 script-tag over-escaping: ui/index.html keeps real closing tags, no backslash escapes', () => {
  assert.ok(UI.includes(CLOSE_SCRIPT), 'the UI source has real closing script tags');
  assert.equal(UI.includes('<\\/script>'), false, 'no `<\\/script>` in the UI source');
  assert.doesNotMatch(UI, /<\\\//, 'no backslash-escaped closing tags at all');
});

// This used to be named "the served HTML closes its script tags correctly (source
// path)" and wrapped every assertion in a try/catch where BOTH branches ended in a
// pass. It always took the catch — UI_HTML is only injected at build time, so importing
// from src/ can never serve HTML — meaning the three assertions in the try block never
// ran even once, and one of them (`typeof html === 'string'`) could not fail anyway.
// Renamed to the property it actually establishes; the escaping regression itself is
// covered by BUG#7 (source text) and BUG#7c (built output).
test('BUG#7b unbuilt src/worker.js fails loudly on UI_HTML instead of serving a broken page', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    await assert.rejects(
      () => worker.fetch(req('/'), ANON, {}),
      /UI_HTML/,
      'serving the UI without a build step must throw, not return half a page'
    );
  } finally {
    mock.restore();
  }
});

test('BUG#7c dist/worker.js (if built) serves HTML with real closing script tags', async (t) => {
  if (!existsSync(DIST_PATH)) {
    t.skip('dist/worker.js not built — run npm run build');
    return;
  }
  const dist = readFileSync(DIST_PATH, 'utf8');
  assert.equal(dist.includes('<\\/script>'), false, 'build must not escape closing script tags');

  const built = await import(new URL('dist/worker.js', ROOT).href);
  const res = await built.default.fetch(req('/'), ANON, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^text\/html/);
  const html = await res.text();
  assert.ok(html.includes(CLOSE_SCRIPT), 'served HTML has real closing script tags');
  assert.equal(html.includes('<\\/script>'), false, 'served HTML has no `<\\/script>`');
  // Every <script ...> is closed.
  const opens = (html.match(/<script[\s>]/g) || []).length;
  const closes = html.split(CLOSE_SCRIPT).length - 1;
  assert.ok(opens > 0, 'the page actually has scripts');
  assert.equal(opens, closes, 'balanced script tags');
});

// ---------------------------------------------------------------------------
// BUG 8: a segment longer than chunk_size with no punctuation was dropped (or
// sent oversized) because the splitter only broke on punctuation.
// Fix: hard-split oversized segments; nothing is lost.
// ---------------------------------------------------------------------------
test('BUG#8 oversized unpunctuated segment must not lose content', () => {
  const { smartChunkText } = __test__;

  const long = 'x'.repeat(1000);
  const chunks = smartChunkText(long, 300);
  assert.deepEqual(chunks.map((c) => c.length), [300, 300, 300, 100]);
  assert.equal(chunks.join(''), long, 'no bytes lost when hard-splitting');
  assert.ok(chunks.every((c) => c.length <= 300), 'no chunk exceeds the limit');

  // Oversized head followed by a normal tail: the tail must survive too.
  const mixed = 'a'.repeat(700) + '。' + 'b'.repeat(120);
  const mixedChunks = smartChunkText(mixed, 300);
  assert.equal(mixedChunks.join(''), mixed, 'oversized head + punctuated tail preserved');
  assert.ok(mixedChunks.every((c) => c.length <= 300));
  assert.ok(mixedChunks.at(-1).endsWith('b'.repeat(120)), 'tail is still present');

  // Every oversized chunk reaches the upstream in one piece and in order.
  assert.deepEqual(smartChunkText('', 300), [], 'empty text yields no chunks');
});

test('BUG#8b oversized input is chunked and every chunk is synthesized in order', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const input = 'x'.repeat(1000); // no punctuation at all
    const res = await worker.fetch(
      speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: 300 }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(mock.calls.synth, 4, '1000 chars / 300 -> 4 chunks');
    const sent = mock.calls.synthSsml.map(
      (s) => s.match(/<prosody[^>]*>([\s\S]*?)<\/prosody>/)[1].length
    );
    assert.deepEqual(sent, [300, 300, 300, 100]);
    assert.equal(sent.reduce((a, b) => a + b, 0), input.length, 'no characters dropped');
    assert.equal((await res.arrayBuffer()).byteLength, 4 * 4800);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// BUG 9: OpenAI voice aliases were only resolved when `voice` was absent, so
// `voice: "shimmer"` fell through to VOICE_RE and 400'd (or was sent raw).
// Fix: resolve the alias whenever one is given, and via the tts-1-<alias> model.
// ---------------------------------------------------------------------------
test('BUG#9 OpenAI alias mapping: an explicit alias voice resolves to a real MS voice', async () => {
  const expected = {
    shimmer: 'zh-CN-XiaoxiaoNeural',
    alloy: 'zh-CN-YunyangNeural',
    fable: 'zh-CN-YunjianNeural',
    onyx: 'zh-CN-XiaoyiNeural',
    nova: 'zh-CN-YunxiNeural',
    echo: 'zh-CN-liaoning-XiaobeiNeural',
  };
  for (const [alias, real] of Object.entries(expected)) {
    __test__.resetTokenCache();
    const mock = installMockFetch();
    try {
      const res = await worker.fetch(speechRequest({ input: 'hi', voice: alias }), ANON, {});
      assert.equal(res.status, 200, `alias ${alias} must be accepted`);
      assert.equal(mock.calls.synth, 1);
      assert.match(mock.calls.synthSsml[0], new RegExp(`<voice name="${real}">`));
      assert.equal(mock.calls.synthSsml[0].includes(alias), false, 'alias must not be sent raw');
    } finally {
      mock.restore();
    }
  }
});

test('BUG#9b default voice (no voice field) still maps through the shimmer alias', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(speechRequest({ input: 'hi' }), ANON, {});
    assert.equal(res.status, 200);
    assert.match(mock.calls.synthSsml[0], /<voice name="zh-CN-XiaoxiaoNeural">/);
  } finally {
    mock.restore();
  }
});

test('BUG#9c model "tts-1-<alias>" is only a fallback: an explicit voice wins', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    // `voice` defaults to "shimmer", so the default alias resolves and the model
    // alias never gets a chance — the documented precedence.
    const res = await worker.fetch(speechRequest({ input: 'hi', model: 'tts-1-nova' }), ANON, {});
    assert.equal(res.status, 200);
    assert.match(mock.calls.synthSsml[0], /<voice name="zh-CN-XiaoxiaoNeural">/);
    assert.equal(mock.calls.synth, 1);

    // An explicit alias voice also wins over the model alias.
    mock.calls.synthSsml.length = 0;
    const res2 = await worker.fetch(
      speechRequest({ input: 'hi', model: 'tts-1-nova', voice: 'echo' }),
      ANON,
      {}
    );
    assert.equal(res2.status, 200);
    assert.match(mock.calls.synthSsml[0], /<voice name="zh-CN-liaoning-XiaobeiNeural">/);
    // NOTE: with an explicit *real* Microsoft voice plus model "tts-1-<alias>",
    // the model alias currently takes precedence and hijacks the request. That is
    // reported as a suspected source bug rather than pinned here, so the fix does
    // not have to fight this test.
  } finally {
    mock.restore();
  }
});

test('BUG#9d an unknown alias-looking voice is a clear 400 invalid_voice', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(speechRequest({ input: 'hi', voice: 'sparkle' }), ANON, {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_voice');
    assert.equal(mock.calls.synth, 0);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// BUG 10: the sliding-window prefetch attached its rejection handler too late.
// `schedule()` stored a bare promise and the `finally` block only ran
// `pending.catch(...)` AFTER the main loop had exited — but a chunk queued later
// in the window can reject while the loop is still awaiting an earlier, slower
// chunk. unhandledRejection is decided at that moment, not retroactively, so the
// Workers runtime logged a runtime exception for an error the code handles
// correctly. Reproduced with chunk 0 delayed and a later chunk failing.
// Fix: attach .catch() inside schedule(), at creation time.
// ---------------------------------------------------------------------------
test('BUG#10 a mid-window chunk failure must not raise unhandledRejection', async () => {
  __test__.resetTokenCache();

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onUnhandled);

  // Chunk 0 is slow, chunk 2 fails fast: while the writer is blocked on 0, the
  // rejection of 2 sits in the map with no handler in the buggy version.
  //
  // The failure status matters. A 500 is retried (150ms + 300ms backoff), so it
  // would only reject at ~450ms — after the main loop had already reached chunk 2
  // and attached a handler, hiding the bug. 400 is a caller error that
  // getAudioChunk refuses to retry, so it rejects on the first attempt, while the
  // loop is still awaiting chunk 0. That ordering is the whole point of the test.
  const mock = installMockFetch({
    synth: async ({ index }) => {
      if (index === 0) await new Promise((r) => setTimeout(r, 300));
      if (index === 2) return { status: 400, body: 'upstream rejected the ssml' };
      return { status: 200, body: Buffer.alloc(64) };
    },
  });

  try {
    // Six chunks with concurrency 4, so indices 0-3 are in flight together.
    // chunk_size must be >= LIMITS.MIN_CHUNK_SIZE (50) or it is clamped up and the
    // sentences merge — an earlier version of this test asked for 24, got 50, and
    // produced only 2 chunks, so the failing index was never even requested.
    const sentence = 'This sentence is deliberately long enough to fill a chunk.';
    const res = await worker.fetch(
      speechRequest({
        input: Array.from({ length: 6 }, () => sentence).join(' '),
        voice: 'en-US-AvaNeural',
        stream: true,
        concurrency: 4,
        chunk_size: 50,
      }),
      ANON,
      {}
    );

    // The stream is expected to break — that is the correct, already-tested behavior.
    try {
      await res.arrayBuffer();
    } catch {
      /* broken stream is the intended signal to the client */
    }

    // Let every abandoned prefetch settle and the microtask queue drain, which is
    // when V8 decides whether a rejection was unhandled.
    await new Promise((r) => setTimeout(r, 500));

    assert.deepEqual(
      unhandled,
      [],
      'abandoned prefetches must carry a handler from the moment they are created'
    );
  } finally {
    process.off('unhandledRejection', onUnhandled);
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// BUG 11: the shipped UI loaded Vue from `unpkg.com/vue@3` — a floating major
// version with no integrity check and only 60s of CDN caching, so the page
// silently adopted whatever Vue was published (measured: resolving to 3.5.40).
// That script can read the API key the UI stores in localStorage, so a poisoned
// CDN response would leak it.
//
// Separately, this made the browser e2e suite depend on an external CDN: when
// unpkg was slow or unreachable from the browser, page.goto timed out
// ("page load timeout") or the page came up with no window.Vue and zero
// .voice-item — symptoms that look like the app is broken. The harness now
// serves Vue from a local cache instead.
// ---------------------------------------------------------------------------
test('BUG#11 the shipped Vue is version-pinned with an integrity hash', () => {
  const tag = UI.match(/<script[^>]*unpkg\.com[^>]*>/);
  assert.ok(tag, 'the UI still loads Vue from a CDN (update this test if that changes)');
  const attrs = tag[0];
  // A floating `vue@3` is what allowed silent version drift.
  assert.doesNotMatch(attrs, /vue@3\/|vue@3"/, 'the version must be exact, not floating');
  assert.match(attrs, /vue@\d+\.\d+\.\d+\//, 'an exact semver is pinned');
  // SRI needs both attributes to actually be enforced.
  assert.match(attrs, /integrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/, 'a real SRI digest');
  assert.match(attrs, /crossorigin="anonymous"/, 'crossorigin is required for SRI to apply');
});

test('BUG#11b the browser harness serves Vue locally, not from the CDN', async () => {
  // Pins the hermetic property: if someone reverts the harness to letting the browser
  // fetch unpkg, the suite goes back to failing whenever that CDN hiccups.
  const { startUiServer } = await import('../helpers/ui-server.mjs');
  const server = await startUiServer({ pcmSeconds: 1 });
  try {
    const res = await fetch(server.url + '/');
    const html = await res.text();
    assert.doesNotMatch(html, /unpkg\.com/, 'the served HTML must not reference the CDN');
    assert.match(html, /src="\/vendor\/vue\.global\.js"/, 'it points at the local route');

    // And that route must actually serve JavaScript, not a 404 the page would ignore.
    const vue = await fetch(server.url + '/vendor/vue.global.js');
    assert.equal(vue.status, 200, 'the local Vue route responds');
    assert.match(vue.headers.get('content-type') || '', /javascript/);
    const body = await vue.text();
    assert.ok(body.length > 100000, 'it is the real Vue bundle, got ' + body.length + ' bytes');
    assert.match(body, /createApp/, 'and it exposes the API the UI uses');
  } finally {
    await server.close();
  }
});
