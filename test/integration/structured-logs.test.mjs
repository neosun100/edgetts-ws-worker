// One structured JSON line per request (ROADMAP P1-6).
//
// The gap this closes: of 18 log points in src/worker.js, 17 were error/warn only, and the
// single normal-path log recorded token lifetime. A successful 200 emitted NOTHING, so 5xx
// rate, p99 latency and retry rate had no denominator, and "which voices are actually used"
// was unanswerable. Several bugs fixed this week — the batch barrier wasting 2.5x latency,
// the Deploy workflow broken for three days, the UI value reading as the neighbouring
// column's label — all survived because nobody was looking.
//
// The properties pinned here, in rough order of how badly getting them wrong would hurt:
//
//   1. EVERY response emits exactly one line, success included. That is the whole point.
//   2. The line is parseable JSON with a stable shape (it will be machine-aggregated).
//   3. Per-request fields never cross between CONCURRENT requests. Workers interleaves
//      requests in one isolate at every await; a module-scoped "current request" object
//      silently attributes fields to the wrong request. Verified before writing the code:
//      three concurrent requests through a module-scoped variable all logged as the last
//      one to start. This is the failure mode that would be invisible in production.
//   4. Console level tracks severity (5xx -> error, 4xx -> warn), so "5xx rate" can be
//      pre-filtered without parsing JSON.
//   5. No secrets and no user content. Never the API key, never the input text — not even
//      hashed, because the text is the user's content.
//   6. Request dimensions are omitted rather than nulled when unknown. A 400's `voice` is
//      meaningless; emitting null would pollute aggregation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest, fakeAudio } from '../helpers/mock-upstream.mjs';

const ENV = { API_KEY: 'test-key' };
const KEY = { key: 'test-key' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** All structured request lines the worker emitted, parsed. */
function reqLines(mock) {
  return mock.logs
    .filter((l) => typeof l.msg === 'string' && l.msg.startsWith('{"ev":"req"'))
    .map((l) => ({ level: l.level, ...JSON.parse(l.msg) }));
}

async function run(body, opts = {}, { key = KEY, env = ENV } = {}) {
  __test__.resetTokenCache();
  const mock = installMockFetch(opts);
  try {
    const res = await worker.fetch(speechRequest(body, key), env, {});
    try {
      await res.arrayBuffer();
    } catch {
      /* a deliberately broken stream still has to have been logged */
    }
    await sleep(60);
    return { res, lines: reqLines(mock), mock };
  } finally {
    mock.restore();
  }
}

test('a successful request emits exactly one structured line', async () => {
  // The whole reason this feature exists: before it, this case logged nothing at all.
  const { res, lines } = await run({ input: '你好世界', voice: 'zh-CN-XiaoxiaoNeural' });
  assert.equal(res.status, 200);
  assert.equal(lines.length, 1, 'exactly one line per request, got ' + lines.length);

  const l = lines[0];
  assert.equal(l.level, 'log', 'a 2xx is logged at log level');
  assert.equal(l.ev, 'req');
  assert.equal(l.route, '/v1/audio/speech');
  assert.equal(l.status, 200);
  assert.equal(typeof l.ms, 'number', 'duration is a number, so p99 is computable');
  assert.ok(l.ms >= 0, 'duration is not negative');
  assert.equal(l.upstream, 1, 'one chunk means one upstream call');
  assert.equal(l.retries, 0);
  assert.equal(l.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(l.format, 'mp3');
  assert.equal(l.chunks, 1);
  assert.equal(l.stream, false);
  assert.equal(l.chars, 4, 'character count, not the text itself');
});

test('the line never contains the API key or the input text', async () => {
  // The single most important negative property. `chars` is a length, deliberately, so that
  // input size is aggregatable without retaining any user content.
  const SECRET = 'test-key';
  const TEXT = '这段文本绝不能出现在日志里';
  const { lines } = await run({ input: TEXT, voice: 'zh-CN-XiaoxiaoNeural' });
  const raw = JSON.stringify(lines);
  assert.ok(!raw.includes(SECRET), 'the API key must never be logged');
  assert.ok(!raw.includes(TEXT), 'the input text must never be logged');
  assert.ok(!raw.includes(TEXT.slice(0, 6)), 'not even a prefix of the input');
  assert.equal(lines[0].chars, TEXT.length, 'only the length is kept');
});

test('concurrent requests never mix up each other fields', async () => {
  // Pinning the design decision. A module-scoped "current request" object passes every
  // single-request test above and is still wrong: Workers runs concurrent requests in one
  // isolate and interleaves them at each await. Measured against that shape before writing
  // this code — three concurrent requests all logged the voice of whichever started last.
  //
  // Inverted latency (the first request is slowest) maximises the interleaving.
  __test__.resetTokenCache();
  const VOICES = ['zh-CN-XiaoxiaoNeural', 'en-US-AvaNeural', 'zh-CN-YunxiNeural'];
  const DELAY = { 'zh-CN-XiaoxiaoNeural': 120, 'en-US-AvaNeural': 20, 'zh-CN-YunxiNeural': 60 };
  const mock = installMockFetch({
    synth: async ({ ssml }) => {
      const v = VOICES.find((x) => ssml.includes(x));
      await sleep(DELAY[v]);
      return { body: fakeAudio(30) };
    },
  });
  try {
    const responses = await Promise.all(
      VOICES.map((v) => worker.fetch(speechRequest({ input: '并发测试文本。', voice: v }, KEY), ENV, {}))
    );
    for (const r of responses) {
      assert.equal(r.status, 200);
      await r.arrayBuffer();
    }
    await sleep(80);

    const lines = reqLines(mock);
    assert.equal(lines.length, 3, 'one line per request, got ' + lines.length);
    assert.deepEqual(
      lines.map((l) => l.voice).sort(),
      [...VOICES].sort(),
      'each line must carry ITS OWN voice — equal values here mean the log context leaked ' +
        'between concurrent requests, which is invisible in production'
    );
    // Durations must also be per-request: the 20ms request cannot report the 120ms one's time.
    const byVoice = Object.fromEntries(lines.map((l) => [l.voice, l.ms]));
    assert.ok(
      byVoice['en-US-AvaNeural'] < byVoice['zh-CN-XiaoxiaoNeural'],
      `the fast request (${byVoice['en-US-AvaNeural']}ms) must report less time than the slow ` +
        `one (${byVoice['zh-CN-XiaoxiaoNeural']}ms) — otherwise timing is being shared too`
    );
  } finally {
    mock.restore();
  }
});

test('a validation failure is logged with its code, at warn level, without request dimensions', async () => {
  const { res, lines } = await run({ input: 'hi', voice: 'not a valid voice!!' });
  assert.equal(res.status, 400);
  assert.equal(lines.length, 1);

  const l = lines[0];
  assert.equal(l.level, 'warn', '4xx is warn, so 5xx can be filtered separately');
  assert.equal(l.status, 400);
  assert.equal(l.code, 'invalid_voice', 'the machine-readable code is what makes errors groupable');
  assert.equal(l.upstream, 0, 'a rejected request must not have touched upstream');
  // Omitted, not nulled: the request never got far enough for these to mean anything.
  assert.ok(!('voice' in l), 'an invalid-voice 400 must not report a voice dimension');
  assert.ok(!('chunks' in l), 'chunking never happened, so there is no chunk count');
});

test('retries and upstream calls are counted, which is what makes a retry RATE possible', async () => {
  // Before this, a retry left a warn line and a success left nothing — so the numerator
  // existed and the denominator did not.
  const { res, lines } = await run(
    { input: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
    { failSynthOnce: { status: 500 } }
  );
  assert.equal(res.status, 200, 'the retry succeeded');
  assert.equal(lines[0].retries, 1, 'the retry is counted');
  assert.equal(
    lines[0].upstream,
    2,
    'both attempts count: each one spends a subrequest from the 50-per-invocation budget, ' +
      'so what matters is calls MADE, not calls that succeeded'
  );
});

test('a multi-chunk request reports its chunk count and one upstream call per chunk', async () => {
  const { res, lines } = await run({
    input: '这是一句用来触发多分块的中文文本。'.repeat(12),
    voice: 'zh-CN-XiaoxiaoNeural',
    chunk_size: 50,
  });
  assert.equal(res.status, 200);
  const l = lines[0];
  assert.ok(l.chunks > 1, 'the fixture really is multi-chunk, got ' + l.chunks);
  assert.equal(l.upstream, l.chunks, 'one upstream call per chunk when nothing is retried');
  assert.equal(l.conc, 10, 'the effective concurrency is recorded, not the requested one');
});

test('an upstream 5xx surfaces as a 500 line at error level', async () => {
  const { res, lines } = await run(
    { input: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
    { synth: () => ({ status: 503, body: 'upstream down' }) }
  );
  assert.equal(res.status, 500);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'error', '5xx must be error level so it is filterable');
  assert.equal(lines[0].status, 500);
  assert.equal(lines[0].code, 'tts_generation_error');
  assert.ok(lines[0].retries > 0, 'a 5xx is retryable, so retries were spent');
});

test('a container merge declining to run is recorded as a degradation on the request line', async () => {
  // The project rule is that a degraded result must not look identical to a healthy one.
  // Those merges already logged a warn, but a standalone warn cannot be joined to the
  // request it belongs to — so "how often does the WAV merge decline" was not answerable.
  const { res, lines } = await run({
    input: '这是一句用来触发多分块的中文文本。'.repeat(12),
    voice: 'zh-CN-XiaoxiaoNeural',
    response_format: 'wav',
    chunk_size: 50,
  });
  assert.equal(res.status, 200, 'declining to merge still returns audio');
  assert.equal(
    lines[0].degraded,
    'wav_merge_declined_no_riff',
    'the fallback to naive concatenation must be visible on the request line'
  );
});

test('a healthy request has no degraded field at all', async () => {
  // The other half of the rule: if `degraded` were always present, it would carry no signal.
  const { lines } = await run({ input: '你好', voice: 'zh-CN-XiaoxiaoNeural' });
  assert.ok(!('degraded' in lines[0]), 'a healthy request must not claim degradation');
});

test('every line is valid JSON on a single line, so a log pipeline can parse it', async () => {
  // Workers' log view is line-oriented. A multi-line payload would be split across records
  // and become unparseable, which is a silent failure of the whole feature.
  const cases = [
    [{ input: '你好', voice: 'zh-CN-XiaoxiaoNeural' }, {}],
    [{ input: 'hi', voice: 'bad voice!!' }, {}],
    [{ input: '你好', voice: 'zh-CN-XiaoxiaoNeural' }, { synth: () => ({ status: 503, body: 'x' }) }],
  ];
  for (const [body, opts] of cases) {
    __test__.resetTokenCache();
    const mock = installMockFetch(opts);
    try {
      const res = await worker.fetch(speechRequest(body, KEY), ENV, {});
      try {
        await res.arrayBuffer();
      } catch { /* ignore */ }
      await sleep(60);
      const raw = mock.logs.filter((l) => String(l.msg).startsWith('{"ev":"req"')).map((l) => l.msg);
      assert.equal(raw.length, 1, 'one line for ' + JSON.stringify(body).slice(0, 40));
      assert.ok(!raw[0].includes('\n'), 'the payload must be a single line');
      const parsed = JSON.parse(raw[0]); // throws if not valid JSON
      assert.equal(parsed.ev, 'req', 'every line is tagged so it can be filtered from prose logs');
      assert.equal(typeof parsed.status, 'number');
    } finally {
      mock.restore();
    }
  }
});

test('an unauthenticated request is rejected before any logging context exists', async () => {
  // Auth runs before the log context is created, on purpose: an unauthenticated caller
  // should not be able to make the worker emit request-shaped telemetry at all (it would
  // be a free amplification channel into the log pipeline). The 401 is still visible —
  // errorResponse's own path — but not as an `ev:"req"` line.
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(speechRequest({ input: 'hi' }, { key: 'wrong-key' }), ENV, {});
    await res.arrayBuffer();
    assert.equal(res.status, 401);
    assert.equal(reqLines(mock).length, 0, 'a 401 must not emit a request telemetry line');
  } finally {
    mock.restore();
  }
});

test('/v1/models is logged too, so cache effectiveness is observable', async () => {
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      new Request('https://tts.test/v1/models', { headers: { Authorization: 'Bearer test-key' } }),
      ENV,
      {}
    );
    await res.arrayBuffer();
    await sleep(40);
    const lines = reqLines(mock);
    assert.equal(lines.length, 1, 'the models route is logged as well');
    assert.equal(lines[0].route, '/v1/models');
    assert.equal(lines[0].status, 200);
    // No voice/format/chunks here — those are speech-only dimensions.
    assert.ok(!('chunks' in lines[0]), 'models has no chunk count');
  } finally {
    mock.restore();
  }
});

test('a streamed request is logged when the STREAM ends, not when headers go out', async () => {
  // A real accuracy defect found by probing: streamVoice returns as soon as the headers are
  // committed, so the funnel's emitLog ran before synthesis had even started. Measured
  // `ms: 6, upstream: 0` for a request that actually made 4 upstream calls over ~190ms.
  //
  // That is worse than no telemetry: it would silently understate p99 AND upstream volume for
  // every streamed request, and the numbers would look perfectly plausible.
  __test__.resetTokenCache();
  const PER_CHUNK_MS = 60;
  const mock = installMockFetch({
    synth: async () => {
      await sleep(PER_CHUNK_MS);
      return { body: fakeAudio(40) };
    },
  });
  try {
    const res = await worker.fetch(
      speechRequest(
        { input: 'ab。'.repeat(60), voice: 'zh-CN-XiaoxiaoNeural', stream: true, response_format: 'pcm', chunk_size: 50 },
        KEY
      ),
      ENV,
      {}
    );
    assert.equal(res.status, 200);
    const bytes = (await res.arrayBuffer()).byteLength;
    assert.ok(bytes > 0, 'the stream delivered audio');
    await sleep(150);

    const lines = reqLines(mock);
    assert.equal(lines.length, 1, 'exactly one line — not one at headers AND one at stream end');
    const l = lines[0];
    assert.equal(l.phase, 'stream_end', 'the line is emitted at stream completion');
    assert.equal(l.stream, true);
    assert.equal(
      l.upstream,
      l.chunks,
      `upstream (${l.upstream}) must equal chunks (${l.chunks}); 0 here means the line was ` +
        'emitted before synthesis ran'
    );
    // The whole point: duration must cover synthesis, not just header commit.
    assert.ok(
      l.ms >= PER_CHUNK_MS,
      `ms=${l.ms} is below the ${PER_CHUNK_MS}ms a single chunk takes — the duration is being ` +
        'measured to header commit, so streamed p99 would be understated'
    );
  } finally {
    mock.restore();
  }
});

test('a stream that breaks mid-flight is distinguishable from one that completed', async () => {
  // Once the headers are out the HTTP status is stuck at 200, so the log is the ONLY place a
  // mid-stream failure can be seen. If it looked identical to a success, the 5xx-equivalent
  // rate for streaming would read as zero no matter how often streams broke.
  __test__.resetTokenCache();
  let n = 0;
  const mock = installMockFetch({
    synth: async () => {
      n++;
      if (n === 3) return { status: 400, body: 'nope' }; // non-retryable, kills the stream
      await sleep(20);
      return { body: fakeAudio(40) };
    },
  });
  try {
    const res = await worker.fetch(
      speechRequest(
        { input: 'ab。'.repeat(60), voice: 'zh-CN-XiaoxiaoNeural', stream: true, response_format: 'pcm', chunk_size: 50 },
        KEY
      ),
      ENV,
      {}
    );
    assert.equal(res.status, 200, 'the status was already committed before the failure');
    await assert.rejects(() => res.arrayBuffer(), 'the body errors out rather than ending cleanly');
    await sleep(200);

    const lines = reqLines(mock);
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0].phase,
      'stream_broken',
      'a broken stream must be marked; sharing "stream_end" with successes would make the ' +
        'streaming failure rate unmeasurable'
    );
    assert.equal(lines[0].err, 400, 'the upstream status that killed it is recorded');
  } finally {
    mock.restore();
  }
});

test('both READMEs document every field the log actually emits', async () => {
  // A schema doc is a contract for whoever builds the dashboard. If a field appears in the
  // log but not the docs, nobody knows to chart it; if it appears in the docs but not the log,
  // their query silently returns nothing. Both directions are checked against a real line.
  const { lines } = await run({
    input: '这是一句用来触发多分块的中文文本。'.repeat(12),
    voice: 'zh-CN-XiaoxiaoNeural',
    chunk_size: 50,
  });
  const emitted = Object.keys(lines[0]).filter((k) => k !== 'level'); // `level` is ours, not the payload

  for (const file of ['README.md', 'README_CN.md']) {
    const text = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    // The section is an h3 under Configuration; split on any heading level.
    const section = text.split(/\n#{2,3} /).find((s) => /^(observability|可观测性)/i.test(s.split('\n')[0].trim()));
    assert.ok(section, file + ': needs an observability section');
    for (const field of emitted) {
      assert.ok(
        section.includes('`' + field + '`'),
        `${file}: the log emits \`${field}\` but the field table does not document it — ` +
          'an undocumented field is one nobody will chart'
      );
    }
    // The two negative guarantees are the ones a reader most needs to be able to rely on.
    assert.ok(/API key/i.test(section), file + ': must state the API key is never logged');
    assert.ok(
      /input text|input 文本/.test(section),
      file + ': must state the input text is never logged'
    );
  }
});
