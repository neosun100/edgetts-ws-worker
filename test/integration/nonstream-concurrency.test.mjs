// Integration tests for the worker pool inside the NON-streaming path (`getVoice` →
// `synthesizeAllChunks`). This is the default path — most callers never set `stream`.
//
// It used to batch: `for (i += concurrency) { await Promise.all(batch) }`. That has a
// barrier at every batch boundary, so each batch costs the slowest chunk in it rather than
// the average. Upstream TTS latency has a long tail (most chunks ~100ms, some 500ms+), so
// one slow chunk idled the other slots until the batch drained. Measured through the real
// worker against a mock upstream where every 10th chunk takes 500ms and the rest 100ms:
//
//   chunks @ concurrency 10     batched      pool      work-conserving bound
//   12                            645ms      530ms     160ms
//   24                           1505ms      708ms     360ms
//   40                           2012ms      812ms     560ms
//
// The streaming path (pipeChunksToStream) was always a sliding window — it has to emit in
// order, which forced explicit index bookkeeping, and a pool falls out of that. The
// non-streaming path got its ordering free from Promise.all, so the batching looked
// correct and nothing was measuring the latency it gave away.
//
// Three properties are pinned below, because the first fix satisfied only two of them:
//   1. the pool keeps `concurrency` requests in flight with no batch barrier,
//   2. output stays byte-identical to the serial result at every concurrency level,
//   3. a non-retryable failure STOPS the pool.
//
// (3) is not a nicety. The old barrier was an accidental circuit breaker: a fatal error in
// batch 1 meant batch 2 never started, so a 45-chunk request cost 10 upstream calls. A pool
// without an explicit stop flag drains the whole array — measured 45/45 calls for a result
// that was already discarded, burning the 50-subrequest-per-invocation budget and hammering
// upstream for nothing. Fixing (1) while regressing (3) is not an improvement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest } from '../helpers/mock-upstream.mjs';

const ENV = { API_KEY: 'test-key' };
const KEY = { key: 'test-key' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same marker scheme as streaming.test.mjs: chunk i carries "MARKnn" and answers with
// (i + 1) * 32 bytes of value (i + 1), so the concatenation proves completeness AND order.
const CHUNK_SIZE = 50;
const markedInput = (n) =>
  Array.from({ length: n }, (_, i) => `MARK${String(i).padStart(2, '0')} ${'x'.repeat(40)}.`).join(' ');
function markIndexOf(ssml) {
  const m = /MARK(\d+)/.exec(ssml);
  assert.ok(m, `ssml has no MARK marker: ${ssml.slice(0, 120)}`);
  return Number(m[1]);
}
const payloadFor = (i) => new Uint8Array((i + 1) * 32).fill(i + 1);
function expectedBytes(n) {
  const parts = Array.from({ length: n }, (_, i) => payloadFor(i));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Non-streaming request with per-chunk latency and in-flight tracking. */
async function run({
  chunks,
  concurrency,
  delayFor = () => 10,
  failIndex = -1,
  failStatus = 400,
  watchIndex = -1,
}) {
  // dispatchedWhenWatchedFinished: how many chunks had been sent upstream at the instant
  // chunk `watchIndex` completed. This is the measurement that separates a barrier from a
  // pool, and it is a count, not a duration — so it means the same thing on any machine.
  const state = { inFlight: 0, max: 0, started: [], dispatchedWhenWatchedFinished: -1 };
  const mock = installMockFetch({
    synth: async ({ ssml }) => {
      const i = markIndexOf(ssml);
      state.started.push(i);
      state.inFlight++;
      state.max = Math.max(state.max, state.inFlight);
      try {
        if (i === failIndex) return { status: failStatus, body: 'nope' };
        await sleep(delayFor(i));
        if (i === watchIndex) state.dispatchedWhenWatchedFinished = state.started.length;
        return { body: payloadFor(i) };
      } finally {
        state.inFlight--;
      }
    },
  });
  try {
    const res = await worker.fetch(
      speechRequest({ input: markedInput(chunks), chunk_size: CHUNK_SIZE, concurrency }, KEY),
      ENV,
      {}
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    // A fatal failure leaves sibling workers mid-flight; let them settle so the call count
    // reflects everything the pool actually dispatched, not a snapshot taken too early.
    await sleep(120);
    return {
      res,
      bytes: buf,
      maxInFlight: state.max,
      synthCalls: mock.calls.synth,
      started: state.started,
      dispatchedWhenWatchedFinished: state.dispatchedWhenWatchedFinished,
    };
  } finally {
    mock.restore();
  }
}

test('the non-streaming pool keeps `concurrency` requests in flight', async () => {
  __test__.resetTokenCache();
  const { res, maxInFlight, synthCalls, bytes } = await run({ chunks: 9, concurrency: 3, delayFor: () => 25 });
  assert.equal(res.status, 200);
  assert.equal(maxInFlight, 3, 'in-flight count must equal the requested concurrency');
  assert.equal(synthCalls, 9, 'every chunk synthesised exactly once — no duplicates, none skipped');
  assert.deepEqual(bytes, expectedBytes(9), 'output is every chunk, in chunk order');
});

test('a slow chunk does not stall the other slots (no batch barrier)', async () => {
  // The regression this file exists for. Chunk 0 is slow; chunks 1..N are fast.
  //
  // Batched: chunks 0-3 form batch one, so chunk 4 cannot start until chunk 0 finishes.
  // Pooled: the three fast chunks finish and their slots immediately take 4, 5, 6.
  //
  // Asserting on DISPATCH ORDER rather than wall-clock keeps this machine-independent —
  // the lesson from the CPU-budget test in test/unit/redos.test.mjs, where an absolute
  // millisecond threshold calibrated on a laptop went red on a slower CI runner.
  __test__.resetTokenCache();
  const CHUNKS = 16;
  const WIDTH = 4;
  const { res, started, bytes, dispatchedWhenWatchedFinished } = await run({
    chunks: CHUNKS,
    concurrency: WIDTH,
    // Chunk 0 is slow; every other chunk is fast. Under a barrier, chunk 0 holds its whole
    // batch, so only the first `WIDTH` chunks can ever be in flight during its 400ms.
    delayFor: (i) => (i === 0 ? 400 : 4),
    watchIndex: 0,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(bytes, expectedBytes(CHUNKS), 'output still complete and ordered');
  assert.deepEqual(started.slice(0, WIDTH), [0, 1, 2, 3], 'the initial window is the first 4 chunks');

  // THE assertion. Batching pins the count at exactly WIDTH: chunks 4+ belong to the next
  // batch and cannot start until chunk 0 — the slowest in batch one — returns. The pool
  // recycles the three fast slots repeatedly while chunk 0 runs, so by the time it finishes
  // nearly everything has been dispatched.
  //
  // Verified to fail against the batched implementation (it reports exactly 4).
  assert.ok(
    dispatchedWhenWatchedFinished > WIDTH,
    `only ${dispatchedWhenWatchedFinished} chunks had been dispatched when the slow chunk ` +
      `finished — with a pool the ${WIDTH - 1} fast slots should have recycled many times ` +
      'while it ran. Equal to the window size means a batch barrier is back: the whole ' +
      'batch is waiting on its slowest member instead of refilling as slots free.'
  );
  assert.equal(started.length, CHUNKS, 'all chunks dispatched');
});

test('output is byte-identical at every concurrency level', async () => {
  // A scheduler change must not alter the audio. Latency is deliberately INVERTED here —
  // later chunks answer first — so any reliance on completion order shows up immediately.
  const results = [];
  for (const concurrency of [1, 2, 5, 20]) {
    __test__.resetTokenCache();
    const { res, bytes } = await run({
      chunks: 10,
      concurrency,
      delayFor: (i) => (10 - i) * 6,
    });
    assert.equal(res.status, 200, `concurrency ${concurrency} succeeded`);
    results.push([concurrency, bytes]);
  }
  const serial = results[0][1];
  assert.deepEqual(serial, expectedBytes(10), 'the serial result is the reference and is correct');
  for (const [concurrency, bytes] of results.slice(1)) {
    assert.deepEqual(bytes, serial, `concurrency ${concurrency} is byte-identical to serial`);
  }
});

test('a non-retryable failure stops the pool instead of draining every chunk', async () => {
  // The circuit breaker. Chunk 0 fails with a non-retryable 400 while the rest are slow,
  // so a pool without a stop flag has ample time to dispatch all 30.
  __test__.resetTokenCache();
  const { res, synthCalls } = await run({
    chunks: 30,
    concurrency: 5,
    failIndex: 0,
    delayFor: () => 40,
  });
  assert.equal(res.status, 400, 'upstream 4xx is reported as a caller error');

  // The bound: the initial window may already be in flight when chunk 0 fails, and each of
  // those workers finishes its current chunk before seeing the flag. Anything beyond that
  // is wasted budget. Batched behaviour was 5 (one batch); allow one extra round for the
  // in-flight window, but nothing like the 30 an unguarded pool dispatches.
  assert.ok(
    synthCalls <= 10,
    `pool dispatched ${synthCalls} upstream calls for a request that failed at chunk 0 — ` +
      'it must stop, not drain all 30. Each wasted call burns one of the 50 subrequests ' +
      'Cloudflare allows per invocation, for a result that is already discarded.'
  );
});

test('concurrency above MAX_CONCURRENCY is clamped in the non-streaming path too', async () => {
  __test__.resetTokenCache();
  const { res, maxInFlight, synthCalls } = await run({
    chunks: 25,
    concurrency: 1000,
    delayFor: () => 15,
  });
  assert.equal(res.status, 200);
  assert.equal(maxInFlight, __test__.LIMITS.MAX_CONCURRENCY, 'clamped to LIMITS.MAX_CONCURRENCY');
  assert.equal(synthCalls, 25);
});

test('concurrency:1 serializes the non-streaming path', async () => {
  __test__.resetTokenCache();
  const { res, maxInFlight, started, bytes } = await run({ chunks: 5, concurrency: 1 });
  assert.equal(res.status, 200);
  assert.equal(maxInFlight, 1, 'no overlap at concurrency 1');
  assert.deepEqual(started, [0, 1, 2, 3, 4], 'strictly sequential dispatch');
  assert.deepEqual(bytes, expectedBytes(5));
});

test('both READMEs describe the pool, not the batching it replaced', () => {
  // Docs rot silently. This project already shipped a stale "CPU work per request is < 1 ms"
  // claim that survived three features which invalidated it, because no test read the prose.
  // The concurrency section now carries a measured table, so pin the parts that are derived
  // from code constants — those are the ones that go wrong when a limit changes.
  const { MIN_CONCURRENCY, MAX_CONCURRENCY } = __test__.LIMITS;
  for (const file of ['README.md', 'README_CN.md']) {
    const text = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    // The Chinese README uses full-width parentheses, so match either form.
    const para = text.split(/\n\s*\n/).find((p) => /`concurrency`\s*[（(]/.test(p));
    assert.ok(para, file + ': no paragraph documents the `concurrency` range');
    assert.ok(
      para.includes(`${MIN_CONCURRENCY}–${MAX_CONCURRENCY}`),
      file + `: the documented range must be ${MIN_CONCURRENCY}–${MAX_CONCURRENCY} ` +
        '(from LIMITS), got:\n' + para.trim().slice(0, 160)
    );
    assert.ok(
      /work-conserving|工作池/.test(text),
      file + ': the scheduler is a work-conserving pool; the docs must say so, because ' +
        '"sliding window" alone previously described only the streaming path'
    );
  }
});

test('a single-chunk request still works and makes one upstream call', async () => {
  // The pool width is min(concurrency, chunks); the degenerate case must not spin up
  // idle workers or, worse, loop forever on an empty range.
  __test__.resetTokenCache();
  const { res, maxInFlight, synthCalls } = await run({ chunks: 1, concurrency: 10 });
  assert.equal(res.status, 200);
  assert.equal(synthCalls, 1);
  assert.equal(maxInFlight, 1);
});
