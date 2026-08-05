// Integration tests for the streaming path (`stream: true`) and the sliding-window
// concurrency inside pipeChunksToStream.
//
// The interesting properties here are not "does it return audio" but:
//   * the response is a raw audio stream with the format's content type,
//   * output bytes are the concatenation of every chunk, in chunk order, even when the
//     upstream responds out of order (later chunks answered first),
//   * exactly `concurrency` synthesis requests are in flight at once (clamped to
//     LIMITS.MAX_CONCURRENCY), so the option actually does something,
//   * a transient upstream failure is retried and the stream stays byte-exact,
//   * a non-retryable failure breaks the stream instead of truncating it silently,
//   * concurrent chunks share a single token fetch (no thundering herd).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest, fakeAudio } from '../helpers/mock-upstream.mjs';

const ENV = { API_KEY: 'test-key' };
const KEY = { key: 'test-key' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build an input that smartChunkText splits into exactly `n` chunks at chunkSize 50, each
// carrying a unique "MARKnn" marker so a synthesis call can be tied back to its chunk index.
const CHUNK_SIZE = 50;
function markedInput(n) {
  return Array.from({ length: n }, (_, i) => `MARK${String(i).padStart(2, '0')} ${'x'.repeat(40)}.`).join(' ');
}
function markIndexOf(ssml) {
  const m = /MARK(\d+)/.exec(ssml);
  assert.ok(m, `ssml has no MARK marker: ${ssml.slice(0, 120)}`);
  return Number(m[1]);
}

// A per-chunk payload whose length AND byte value identify the chunk: chunk i is
// (i + 1) * 32 bytes of the value (i + 1). Concatenated output can therefore be verified
// for both completeness and ordering.
function payloadFor(index) {
  return new Uint8Array((index + 1) * 32).fill(index + 1);
}
function expectedBytes(n) {
  const parts = Array.from({ length: n }, (_, i) => payloadFor(i));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function bodyBytes(res) {
  return new Uint8Array(await res.arrayBuffer());
}

test('stream:true returns a raw audio stream with the mp3 content type and CORS', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'hello streaming world', stream: true, response_format: 'mp3' }, KEY),
      ENV,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    // No content-length: it is a stream, not a buffered blob.
    assert.equal(res.headers.get('content-length'), null);

    const bytes = await bodyBytes(res);
    assert.equal(bytes.length, fakeAudio(100).length); // 100ms * 48 = 4800 bytes
    assert.equal(mock.calls.synth, 1);
    assert.equal(mock.calls.token, 1);
    assert.match(mock.calls.synthSsml[0], /<voice name="zh-CN-XiaoxiaoNeural">/);
  } finally {
    mock.restore();
  }
});

test('streaming pcm asks upstream for raw pcm and labels the response audio/pcm', async () => {
  __test__.resetTokenCache();
  const formats = [];
  const mock = installMockFetch({
    synth: ({ format }) => {
      formats.push(format);
      return { body: fakeAudio(50) };
    },
  });
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'pcm stream', stream: true, response_format: 'pcm' }, KEY),
      ENV,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/pcm');
    const bytes = await bodyBytes(res);
    assert.equal(bytes.length, 2400); // 50ms * 48
    assert.deepEqual(formats, ['raw-24khz-16bit-mono-pcm']);
  } finally {
    mock.restore();
  }
});

test('multi-chunk stream emits every chunk exactly once, in chunk order, despite reversed upstream latency', async () => {
  __test__.resetTokenCache();
  const N = 8;
  const completionOrder = [];
  const mock = installMockFetch({
    // Later chunks answer first (chunk 7 fastest, chunk 0 slowest) so arrival order is the
    // reverse of write order. Any ordering bug shows up as a byte-level mismatch.
    synth: async ({ ssml }) => {
      const i = markIndexOf(ssml);
      await sleep((N - i) * 12);
      completionOrder.push(i);
      return { body: payloadFor(i) };
    },
  });
  try {
    const res = await worker.fetch(
      speechRequest({ input: markedInput(N), stream: true, chunk_size: CHUNK_SIZE, concurrency: N }, KEY),
      ENV,
      {}
    );
    assert.equal(res.status, 200);
    const bytes = await bodyBytes(res);
    const expected = expectedBytes(N);

    assert.equal(mock.calls.synth, N, 'one synthesis call per chunk');
    assert.equal(bytes.length, expected.length, 'total bytes = sum of chunk sizes');
    assert.deepEqual(bytes, expected, 'bytes are chunk payloads concatenated in chunk order');

    // Prove the test actually exercised out-of-order completion.
    assert.deepEqual(
      completionOrder,
      Array.from({ length: N }, (_, i) => N - 1 - i),
      'upstream completed in reverse order'
    );

    // Boundary check spelled out: chunk k occupies its own contiguous run of value k+1.
    let off = 0;
    for (let i = 0; i < N; i++) {
      const len = (i + 1) * 32;
      const slice = bytes.subarray(off, off + len);
      assert.equal(slice.length, len, `chunk ${i} length`);
      assert.ok(slice.every((b) => b === i + 1), `chunk ${i} region must be all ${i + 1}`);
      off += len;
    }
    assert.equal(off, bytes.length, 'no trailing bytes');
  } finally {
    mock.restore();
  }
});

// Runs a streaming request while tracking how many synthesis requests overlap.
async function runWithInFlightTracking({ chunks, concurrency, perCallMs = 25 }) {
  const state = { inFlight: 0, max: 0 };
  const mock = installMockFetch({
    synth: async ({ ssml }) => {
      state.inFlight++;
      state.max = Math.max(state.max, state.inFlight);
      await sleep(perCallMs);
      state.inFlight--;
      return { body: payloadFor(markIndexOf(ssml)) };
    },
  });
  try {
    const res = await worker.fetch(
      speechRequest(
        { input: markedInput(chunks), stream: true, chunk_size: CHUNK_SIZE, concurrency },
        KEY
      ),
      ENV,
      {}
    );
    const bytes = await bodyBytes(res);
    return { bytes, maxInFlight: state.max, calls: mock.calls, res };
  } finally {
    mock.restore();
  }
}

test('sliding window keeps exactly `concurrency` synthesis requests in flight', async () => {
  __test__.resetTokenCache();
  const { bytes, maxInFlight, calls } = await runWithInFlightTracking({ chunks: 9, concurrency: 3 });
  assert.equal(maxInFlight, 3, 'window size must equal the requested concurrency');
  assert.equal(calls.synth, 9);
  assert.deepEqual(bytes, expectedBytes(9), 'output still strictly ordered');
});

test('concurrency above MAX_CONCURRENCY is clamped to 20 in-flight requests', async () => {
  __test__.resetTokenCache();
  assert.equal(__test__.LIMITS.MAX_CONCURRENCY, 20);
  const { maxInFlight, calls, bytes } = await runWithInFlightTracking({
    chunks: 25,
    concurrency: 1000,
    perCallMs: 15,
  });
  assert.equal(maxInFlight, 20, 'clamped to LIMITS.MAX_CONCURRENCY');
  assert.equal(calls.synth, 25);
  assert.equal(bytes.length, expectedBytes(25).length);
});

test('concurrency:1 serializes synthesis and dispatches chunks in order', async () => {
  __test__.resetTokenCache();
  const { maxInFlight, calls, bytes } = await runWithInFlightTracking({
    chunks: 5,
    concurrency: 1,
    perCallMs: 5,
  });
  assert.equal(maxInFlight, 1, 'no overlap at concurrency 1');
  assert.equal(calls.synth, 5);
  assert.deepEqual(
    calls.synthSsml.map(markIndexOf),
    [0, 1, 2, 3, 4],
    'serial dispatch follows chunk order'
  );
  assert.deepEqual(calls.synthOrder, [0, 1, 2, 3, 4]);
  assert.deepEqual(bytes, expectedBytes(5));
});

test('concurrent streaming is dramatically faster than serial for the same input', async () => {
  const N = 10;
  const DELAY = 40;

  async function timeRun(concurrency) {
    __test__.resetTokenCache();
    const mock = installMockFetch({ synthDelayMs: DELAY });
    try {
      const t0 = Date.now();
      const res = await worker.fetch(
        speechRequest(
          { input: markedInput(N), stream: true, chunk_size: CHUNK_SIZE, concurrency },
          KEY
        ),
        ENV,
        {}
      );
      const bytes = await bodyBytes(res);
      return { ms: Date.now() - t0, bytes, calls: mock.calls };
    } finally {
      mock.restore();
    }
  }

  const serial = await timeRun(1);
  const parallel = await timeRun(N);

  assert.equal(serial.calls.synth, N);
  assert.equal(parallel.calls.synth, N);
  assert.equal(serial.bytes.length, N * fakeAudio(100).length);
  assert.equal(parallel.bytes.length, serial.bytes.length, 'same bytes either way');

  // Serial must pay the per-call delay N times; parallel pays it roughly once.
  assert.ok(serial.ms >= DELAY * N * 0.8, `serial run too fast to be serial: ${serial.ms}ms`);
  assert.ok(
    parallel.ms < serial.ms / 2,
    `parallel (${parallel.ms}ms) should be well under half of serial (${serial.ms}ms)`
  );
});

test('a transient 500 from upstream is retried and the stream stays byte-exact', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch({ failSynthOnce: { status: 500 } });
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'retry me please', stream: true }, KEY),
      ENV,
      {}
    );
    assert.equal(res.status, 200);
    const bytes = await bodyBytes(res);
    assert.equal(bytes.length, fakeAudio(100).length, 'full chunk audio after retry');
    assert.equal(mock.calls.synth, 2, 'one failed attempt + one successful retry');
    const warned = mock.logs.filter((l) => l.level === 'warn' && l.msg.includes('重试中'));
    assert.equal(warned.length, 1, 'retry is logged, not silent');
    // 日志现在带分块序号（#1/1）：并发重试时「第 2 次失败」出现两次曾看起来像计数 bug，
    // 实际是两个不同分块各自的第二次尝试，运维分不清「某块反复失败」和「所有块都在失败」。
    assert.match(warned[0].msg, /分块#\d+\/\d+合成第 1 次失败（500）/);
  } finally {
    mock.restore();
  }
});

test('a non-retryable 400 breaks the stream instead of truncating it silently', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch({ synth: () => ({ status: 400, body: 'bad request' }) });
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'doomed chunk', stream: true }, KEY),
      ENV,
      {}
    );
    // Headers were already flushed, so the failure can only surface as a broken body.
    assert.equal(res.status, 200);
    await assert.rejects(() => res.arrayBuffer());
    assert.equal(mock.calls.synth, 1, '4xx other than 401/408/429 must not be retried');
    // streamVoice's detached .catch() logs on a later microtask/turn; drain it before the
    // harness restores console, otherwise it writes to the real stdout that node --test uses.
    await sleep(20);
    const errors = mock.logs.filter((l) => l.level === 'error' && l.msg.includes('流式 TTS 失败'));
    assert.ok(errors.length >= 1, 'failure is logged, not swallowed');
    assert.ok(
      mock.logs.every((l) => !l.msg.includes('Edge TTS API 错误: 400 ') || l.level === 'error'),
      'the upstream 400 is reported at error level'
    );
  } finally {
    mock.restore();
  }
});

test('concurrent chunks needing a token share one token fetch (no thundering herd)', async () => {
  __test__.resetTokenCache();
  const N = 10;
  // 60s expiry is inside TOKEN_REFRESH_BEFORE_EXPIRY (5min), so the token is considered
  // stale the moment it lands: every chunk hits the refresh path.
  const mock = installMockFetch({
    tokenExp: 60,
    synth: async ({ ssml }) => {
      await sleep(15);
      return { body: payloadFor(markIndexOf(ssml)) };
    },
  });
  try {
    const res = await worker.fetch(
      speechRequest({ input: markedInput(N), stream: true, chunk_size: CHUNK_SIZE, concurrency: N }, KEY),
      ENV,
      {}
    );
    const bytes = await bodyBytes(res);
    assert.deepEqual(bytes, expectedBytes(N));
    assert.equal(mock.calls.synth, N);
    // All N chunks start in the same window, so the in-flight refresh is shared: without
    // coalescing this would be N token fetches.
    assert.equal(mock.calls.token, 1, `expected 1 coalesced token fetch, got ${mock.calls.token}`);
  } finally {
    mock.restore();
  }
});

test('a fresh cached token is reused across streaming requests', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch({ tokenExp: 3600 });
  try {
    for (let n = 0; n < 2; n++) {
      const res = await worker.fetch(
        speechRequest({ input: `round ${n}`, stream: true }, KEY),
        ENV,
        {}
      );
      const bytes = await bodyBytes(res);
      assert.equal(bytes.length, fakeAudio(100).length);
    }
    assert.equal(mock.calls.synth, 2);
    assert.equal(mock.calls.token, 1, 'second request reuses the cached token');
  } finally {
    mock.restore();
  }
});

// ------------------------------------------------- streaming + container formats
// The WAV merge only covered getVoice. streamVoice writes chunks straight through, so a
// streamed multi-chunk WAV was still N concatenated RIFF files. Measured on production:
// 901 characters (4 chunks) returned 191.67s of audio behind a first header declaring
// 61.46s — a player stops at 32%, behind a 200 and a well-formed WAV. Opus was 4 stacked
// EBML containers for the same input.
//
// Streaming cannot be fixed the way getVoice was: the headers are already out and the
// bytes are written as they arrive, so there is no way to backfill a RIFF data length or
// fuse Segments. Refusing before the headers go out is the only honest option, and it is
// what README already implies — container formats cannot be decoded incrementally.

const CONTAINER_STREAM_TEXT = '这是一句用来触发多分块的中文文本。'.repeat(53); // 901 chars

async function statusFor(body) {
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ voice: 'zh-CN-XiaoxiaoNeural', ...body }),
      { ALLOW_ANONYMOUS: 'true' },
      {}
    );
    let code = '';
    if (res.status !== 200) {
      code = (await res.json()).error.code;
    } else {
      // Drain before restoring the mock, or the still-running stream hits the real network.
      try { await res.arrayBuffer(); } catch { /* broken stream is fine here */ }
    }
    return { status: res.status, code, synth: mock.calls.synth };
  } finally {
    mock.restore();
  }
}

test('streamed multi-chunk wav/opus is refused before any byte is written', async () => {
  for (const format of ['wav', 'opus']) {
    const r = await statusFor({ input: CONTAINER_STREAM_TEXT, response_format: format, stream: true });
    assert.equal(r.status, 400, format + ' must not stream as stacked containers');
    assert.equal(r.code, 'stream_format_not_chunkable');
    assert.equal(r.synth, 0, format + ': refused before spending an upstream request');
  }
});

test('the streaming refusal names pcm as the format to use', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({
        input: CONTAINER_STREAM_TEXT,
        voice: 'zh-CN-XiaoxiaoNeural',
        response_format: 'wav',
        stream: true,
      }),
      { ALLOW_ANONYMOUS: 'true' },
      {}
    );
    const msg = (await res.json()).error.message;
    assert.match(msg, /pcm/, 'points at the format that actually streams');
    assert.match(msg, /stream/, 'mentions dropping stream as the alternative');
    assert.match(msg, /4/, 'states how many chunks it would have been');
  } finally {
    mock.restore();
  }
});

test('pcm and mp3 still stream multi-chunk', async () => {
  // pcm has no header and mp3 frames are self-synchronising, so concatenation is correct
  // for both — the guard must not touch them.
  for (const format of ['pcm', 'mp3']) {
    const r = await statusFor({ input: CONTAINER_STREAM_TEXT, response_format: format, stream: true });
    assert.equal(r.status, 200, format + ' must still stream');
    assert.ok(r.synth > 1, format + ' really was multi-chunk, got ' + r.synth);
  }
});

test('single-chunk wav/opus still stream (one container is already valid)', async () => {
  for (const format of ['wav', 'opus']) {
    const r = await statusFor({ input: '短句。', response_format: format, stream: true });
    assert.equal(r.status, 200, format + ' single-chunk streaming is fine');
    assert.equal(r.synth, 1, 'exactly one container');
  }
});

test('non-streaming wav/opus are unaffected and still merged', async () => {
  for (const format of ['wav', 'opus']) {
    const r = await statusFor({ input: CONTAINER_STREAM_TEXT, response_format: format });
    assert.equal(r.status, 200, format + ' non-streaming must still work');
    assert.ok(r.synth > 1, format + ' was multi-chunk and merged, got ' + r.synth);
  }
});
