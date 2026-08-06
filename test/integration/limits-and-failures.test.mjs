// Request-size limits and upstream-failure paths.
// These are the branches that matter most in production (upstream 5xx, voice-list
// outage, token endpoint down) and were the main gap left in coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { readFileSync } from 'node:fs';
import { installMockFetch, speechRequest, req } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };

async function withMock(opts, fn) {
  __test__.resetTokenCache();
  // The voice list is cached in a module-level variable, so a warm cache from any
  // earlier test leaks in here and makes the two degradation tests below pass for
  // the wrong reason (they would see the real 322-voice list, not the fallback).
  // Reset it too, matching voices-cache.test.mjs and auth-routing.test.mjs.
  __test__.resetVoicesCache();
  const mock = installMockFetch(opts);
  try { return await fn(mock); } finally { mock.restore(); }
}

// ------------------------------------------------------------------ body size

test('oversized body is rejected with 413 before it is parsed', async () => {
  await withMock({}, async (mock) => {
    // input itself is legal; the bloat lives in another field, so MAX_INPUT_CHARS
    // alone would not catch it.
    const body = JSON.stringify({
      input: 'hi',
      voice: 'en-US-AvaNeural',
      cleaning_options: { custom_keywords: 'x'.repeat(300 * 1024) },
    });
    const declared = new TextEncoder().encode(body).byteLength;
    const request = new Request('https://tts.test/v1/audio/speech', {
      method: 'POST',
      // Node's Request does NOT set content-length for a string body, so without
      // this header the declared-length fast path could never fire and this test
      // silently exercised the actual-byte branch that the chunked test below owns.
      headers: { 'Content-Type': 'application/json', 'content-length': String(declared) },
      body,
    });
    // The fast path exists to reject before pulling the body into memory (a Worker
    // has a 128MB ceiling), and status alone cannot tell the two branches apart —
    // both answer 413. Reading the body is the only observable difference.
    let bodyWasRead = false;
    const realText = request.text.bind(request);
    request.text = () => { bodyWasRead = true; return realText(); };

    const res = await worker.fetch(request, ANON, {});
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error.code, 'payload_too_large');
    // Error carries both the actual and the limit, per the project's error contract.
    assert.match(json.error.message, /\d+ > \d+/);
    assert.match(
      json.error.message,
      new RegExp(String(declared)),
      'the number reported must come from Content-Length, proving the fast path ran'
    );
    assert.equal(bodyWasRead, false, 'oversized body must be rejected before it is read');
    assert.equal(mock.calls.synth, 0, 'never reaches upstream');
  });
});

test('a body of exactly MAX_BODY_BYTES still succeeds (boundary is inclusive)', async () => {
  await withMock({}, async (mock) => {
    // The previous version of this test sent 43 bytes — 0.016% of the limit — so the
    // boundary was untested and `>` could be flipped to `>=` with the suite still
    // green. Pad a field so the encoded body lands exactly on the limit.
    const limit = __test__.LIMITS.MAX_BODY_BYTES;
    const shell = JSON.stringify({ input: 'hello', voice: 'en-US-AvaNeural', pad: '' });
    const body = JSON.stringify({
      input: 'hello',
      voice: 'en-US-AvaNeural',
      pad: 'x'.repeat(limit - new TextEncoder().encode(shell).byteLength),
    });
    assert.equal(new TextEncoder().encode(body).byteLength, limit, 'fixture must sit on the limit');

    const res = await worker.fetch(
      new Request('https://tts.test/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'content-length': String(limit) },
        body,
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 200, 'a body exactly at the limit is allowed');
    assert.ok(mock.calls.synth >= 1);
  });
});

test('a body of MAX_BODY_BYTES + 1 is rejected with 413', async () => {
  await withMock({}, async (mock) => {
    const limit = __test__.LIMITS.MAX_BODY_BYTES;
    const shell = JSON.stringify({ input: 'hello', voice: 'en-US-AvaNeural', pad: '' });
    const body = JSON.stringify({
      input: 'hello',
      voice: 'en-US-AvaNeural',
      pad: 'x'.repeat(limit - new TextEncoder().encode(shell).byteLength + 1),
    });
    assert.equal(new TextEncoder().encode(body).byteLength, limit + 1);

    const res = await worker.fetch(
      new Request('https://tts.test/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'content-length': String(limit + 1) },
        body,
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 413, 'one byte over the limit is rejected');
    assert.equal((await res.json()).error.code, 'payload_too_large');
    assert.equal(mock.calls.synth, 0);
  });
});

test('413 is reported even when Content-Length is absent (chunked)', async () => {
  await withMock({}, async (mock) => {
    const huge = JSON.stringify({ input: 'hi', pad: 'y'.repeat(300 * 1024) });
    // A ReadableStream body means fetch does not set Content-Length, so the
    // declared-length fast path cannot fire — the actual-byte check must.
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(huge)); c.close(); },
    });
    const res = await worker.fetch(
      new Request('https://tts.test/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stream,
        duplex: 'half',
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'payload_too_large');
    assert.equal(mock.calls.synth, 0);
  });
});

// ------------------------------------------------------- upstream synth failure

test('upstream 500 on every attempt surfaces as 500 tts_generation_error', async () => {
  await withMock({ synth: () => ({ status: 500, body: 'upstream boom' }) }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'tts_generation_error');
    // retried MAX_CHUNK_ATTEMPTS times rather than giving up on the first failure
    assert.ok(mock.calls.synth >= 2, 'retries a retryable status, got ' + mock.calls.synth);
  });
});

test('a 400 from upstream is not retried (caller error, retry cannot help)', async () => {
  await withMock({ synth: () => ({ status: 400, body: 'bad ssml' }) }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    // The subject of this test is the retry count. The status was 500 when it was written
    // and is now 400 — an upstream 4xx is the caller's error, not ours (see
    // validation.test.mjs "an upstream 4xx becomes a 400"). Assert the status too so the
    // two files cannot drift apart.
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'upstream_rejected_request');
    assert.equal(mock.calls.synth, 1, 'exactly one attempt for a non-retryable 4xx');
  });
});

test('a transient failure followed by success still returns audio', async () => {
  await withMock({ failSynthOnce: { status: 503 } }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.ok(buf.byteLength > 0, 'recovered and produced audio');
    assert.equal(mock.calls.synth, 2, 'one failure + one success');
  });
});

// --------------------------------------------------------- token endpoint down

test('token endpoint down -> 500, and it is retried', async () => {
  await withMock({ failTokenTimes: 99 }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 500);
    assert.ok(mock.calls.token >= 1, 'attempted to fetch a token');
    assert.equal(mock.calls.synth, 0, 'no synthesis without a token');
  });
});

test('token endpoint recovers after transient failures', async () => {
  await withMock({ failTokenTimes: 1 }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.ok(mock.calls.token >= 2, 'retried the token fetch');
  });
});

// ------------------------------------------------------------ voice list outage

test('/v1/models falls back to a built-in list when upstream fails', async () => {
  await withMock({}, async (mock) => {
    // make only the voice-list call fail
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/voices/list')) return new Response('down', { status: 502 });
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(req('/v1/models'), ANON, {});
      // The endpoint degrades to a small hardcoded list rather than erroring out.
      assert.equal(res.status, 200);
      const models = await res.json();
      assert.ok(Array.isArray(models) && models.length > 0, 'returns fallback voices');
      assert.ok(models.every((m) => typeof m.id === 'string'));
      // `length > 0` alone cannot tell the fallback list from the real ~322-voice
      // list, so this test used to pass even when it received the real thing.
      // Two properties are unique to the degraded path (see voices-cache.test.mjs):
      assert.ok(models.length < 50, 'the fallback list is small, not the full catalogue');
      assert.equal(
        res.headers.get('Cache-Control'),
        'no-store',
        'a degraded result must not be cached for 6 hours like a real one'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('/v1/models/public reports 500 when upstream fails (no fallback there)', async () => {
  await withMock({}, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/voices/list')) return new Response('down', { status: 502 });
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(req('/v1/models/public'), ANON, {});
      assert.equal(res.status, 500);
      assert.equal((await res.json()).error.code, 'fetch_error');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ------------------------------------------------------- streaming failure path

test('streaming failure breaks the body rather than serving a short valid file', async () => {
  await withMock({ synth: () => ({ status: 500, body: 'boom' }) }, async () => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', stream: true }),
      ANON,
      {}
    );
    // Headers are already flushed for a stream, so the only honest signal is a
    // broken body — a truncated-but-valid audio file would be indistinguishable
    // from a complete one.
    assert.equal(res.status, 200);
    await assert.rejects(async () => { await res.arrayBuffer(); });
    // let the detached .catch() in streamVoice settle before the mock is restored
    await new Promise((r) => setTimeout(r, 25));
  });
});

// ------------------------------------------------------------------ chunk count
// The real ceiling is the number of chunks, not the number of characters: each chunk is
// one upstream subrequest and Cloudflare caps a single invocation at 50. MAX_INPUT_CHARS
// (50000) validated the wrong quantity — at the default chunk_size of 300 the documented
// maximum needs 167 subrequests, so it could never work.
//
// Measured on production 2026-08-04: with chunk_size=50, 50 chunks succeeded and 51
// returned 500; with default parameters, ~6000 characters already failed intermittently
// with a bare CF 503 (error code 1102) and 15000 characters failed every time.
//
// Streaming made this far worse than a plain error. Once the response headers are out,
// the runtime killing the isolate leaves the client with 200 plus a well-formed EOF —
// the truncated body ends in the same 0\r\n\r\n terminator as a complete one, so a
// caller genuinely cannot tell a 2-second clip from the 30-second one it asked for.
// Hence the check must run before anything is written.

test('too many chunks is refused with 413 before any response is streamed', async () => {
  await withMock({}, async (mock) => {
    const limit = __test__.LIMITS.MAX_CHUNKS;
    // 'ab。' is one chunk per ~17 units at chunk_size 50; use the default 300 and enough
    // text to exceed the limit comfortably.
    const input = 'ab。'.repeat(6000); // ~18000 chars -> ~60 chunks at chunk_size 300
    const res = await worker.fetch(
      speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: 300, stream: true }),
      ANON,
      {}
    );
    assert.equal(res.status, 413, 'must be an explicit error, not a truncated 200');
    const json = await res.json();
    assert.equal(json.error.code, 'too_many_chunks');
    // Per the project's error contract: actual, limit, and a way forward.
    assert.match(json.error.message, new RegExp(String(limit)), 'states the limit');
    assert.match(json.error.message, /chunk_size/, 'names the parameter to change');
    assert.equal(mock.calls.synth, 0, 'refused before a single subrequest was made');
  });
});

test('the chunk limit applies to non-streaming requests too', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'ab。'.repeat(6000), voice: 'en-US-AvaNeural', chunk_size: 300 }),
      ANON,
      {}
    );
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'too_many_chunks');
    assert.equal(mock.calls.synth, 0);
  });
});

test('a larger chunk_size is a real workaround for long text', async () => {
  // The error message tells callers to raise chunk_size, so that has to actually work —
  // otherwise the advice is misleading. 45000 chars at chunk_size 2000 is ~23 chunks.
  await withMock({}, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'ab。'.repeat(15000), voice: 'en-US-AvaNeural', chunk_size: 2000 }),
      ANON,
      {}
    );
    assert.equal(res.status, 200, 'long text succeeds when chunked coarsely');
    assert.ok(
      mock.calls.synth <= __test__.LIMITS.MAX_CHUNKS,
      'stays within the subrequest budget, got ' + mock.calls.synth
    );
  });
});

test('a request just under the chunk limit still succeeds', async () => {
  // Guards the boundary in the permissive direction: MAX_CHUNKS must not be so tight
  // that ordinary long-ish input breaks.
  await withMock({}, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'ab。'.repeat(4000), voice: 'en-US-AvaNeural', chunk_size: 300 }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.ok(mock.calls.synth > 1, 'genuinely multi-chunk, got ' + mock.calls.synth);
    assert.ok(mock.calls.synth <= __test__.LIMITS.MAX_CHUNKS);
  });
});

test('MAX_CHUNKS leaves headroom under the Cloudflare subrequest ceiling', async () => {
  // Synthesis is not the only subrequest: the token endpoint and the voice list also
  // spend from the same budget of 50.
  const { MAX_CHUNKS } = __test__.LIMITS;
  assert.ok(MAX_CHUNKS < 50, 'must stay below the platform limit of 50');
  assert.ok(50 - MAX_CHUNKS >= 3, 'leaves room for token/voice-list requests');
});

test('a request that cannot possibly fit is refused without paying to chunk it', async () => {
  // ceil(chars / chunk_size) is a LOWER bound on the chunk count, because smartChunkText
  // never emits a chunk longer than chunk_size. When that bound already exceeds MAX_CHUNKS
  // the conclusion is certain, so there is no reason to walk all 50000 characters first.
  //
  // Why it matters: chunking 50000 characters at chunk_size=50 produces 1011 chunks and
  // measured 4.8ms on its own, with the whole request at 39.2ms end to end — four times
  // the Workers 10ms CPU budget spent on a request that was always going to be rejected.
  // That is a free CPU-drain path. Warm median after the fix: 0.65ms.
  await withMock({}, async (mock) => {
    const input = 'ab。'.repeat(16666); // ~50000 chars
    const res = await worker.fetch(
      speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: 50 }),
      ANON,
      {}
    );
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error.code, 'too_many_chunks');
    // The message reports the bound, and says so — the real count would cost the work
    // this short circuit exists to avoid.
    assert.match(json.error.message, /至少/, 'reports a lower bound, not a fabricated exact count');
    assert.match(json.error.message, /1000/, 'states the bound it computed');
    assert.equal(mock.calls.synth, 0);
  });
});

test('the lower-bound short circuit never rejects a request that would have fit', async () => {
  // A lower bound can only under-count, so it must not reject anything the real chunker
  // would have accepted. Check both sides of the boundary against the real chunker.
  const MAX = __test__.LIMITS.MAX_CHUNKS;
  for (const chars of [900, 13002, 13500]) {
    await withMock({}, async (mock) => {
      const input = 'ab。'.repeat(Math.ceil(chars / 3));
      const realChunks = __test__.smartChunkText(input, 300).length;
      const res = await worker.fetch(
        speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: 300 }),
        ANON,
        {}
      );
      if (realChunks <= MAX) {
        assert.equal(res.status, 200, `${input.length} chars -> ${realChunks} chunks should pass`);
        assert.equal(mock.calls.synth, realChunks, 'one upstream call per chunk');
      } else {
        assert.equal(res.status, 413, `${input.length} chars -> ${realChunks} chunks should fail`);
      }
    });
  }
});

test('the bound is a bound: it is never above the real chunk count', async () => {
  // The short circuit is only sound if ceil(len / size) <= actual chunks. Verify the
  // invariant directly across shapes rather than trusting the arithmetic.
  const shapes = [
    'ab。'.repeat(300),
    'a'.repeat(900),
    '第一句。第二句？第三句！'.repeat(50),
    ('x'.repeat(299) + '。').repeat(20),
    'a,'.repeat(450),
  ];
  for (const input of shapes) {
    for (const size of [50, 300, 2000]) {
      const bound = Math.ceil(input.length / size);
      const actual = __test__.smartChunkText(input, size).length;
      assert.ok(
        bound <= actual,
        `bound ${bound} exceeded actual ${actual} for ${input.length} chars @ ${size} — ` +
          'the short circuit would reject a valid request'
      );
    }
  }
});

test('the slow path still rejects when the bound passes but real chunking exceeds the limit', async () => {
  // The lower bound is not tight. Segments slightly longer than chunk_size/2 pack one per
  // chunk (two would overflow), so the real count can be nearly double the bound: 6946
  // characters at chunk_size=300 gives a bound of 24 but 46 actual chunks. The short
  // circuit lets this through, and the post-chunking check has to catch it — otherwise the
  // request goes upstream with 46 subrequests and hits the platform ceiling mid-flight,
  // which for a streaming request means a silently truncated 200.
  await withMock({}, async (mock) => {
    const segment = 'x'.repeat(150) + '。'; // 151 chars: two never fit in a 300 chunk
    const input = segment.repeat(46);
    const bound = Math.ceil(input.length / 300);
    const actual = __test__.smartChunkText(input, 300).length;
    assert.ok(bound <= __test__.LIMITS.MAX_CHUNKS, 'premise: the bound does NOT trip');
    assert.ok(actual > __test__.LIMITS.MAX_CHUNKS, 'premise: the real count DOES exceed');

    const res = await worker.fetch(
      speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: 300 }),
      ANON,
      {}
    );
    assert.equal(res.status, 413, 'must be refused by the post-chunking check');
    const json = await res.json();
    assert.equal(json.error.code, 'too_many_chunks');
    // This path knows the exact count, so it must report it rather than a bound.
    assert.match(json.error.message, new RegExp(String(actual)), 'reports the exact count');
    assert.doesNotMatch(json.error.message, /至少/, 'no "at least" when the count is known');
    assert.equal(mock.calls.synth, 0, 'nothing reached upstream');
  });
});

test('a request just inside the limit on the slow path still succeeds', async () => {
  // The mirror case, so the slow-path check cannot be made overly strict.
  await withMock({}, async (mock) => {
    const segment = 'x'.repeat(150) + '。';
    const input = segment.repeat(40); // 40 chunks, under MAX_CHUNKS
    const actual = __test__.smartChunkText(input, 300).length;
    assert.ok(actual <= __test__.LIMITS.MAX_CHUNKS, 'premise: fits');
    const res = await worker.fetch(
      speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: 300 }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(mock.calls.synth, actual, 'one upstream call per chunk');
  });
});

test('the character limit and the chunk limit are in series, and docs must say which binds', async () => {
  // Documentation defect found by auditing README numbers against the code: it claimed
  // chunk_size 2000 handles "~90000 characters" (45 x 2000), but MAX_INPUT_CHARS is checked
  // BEFORE chunking, so 50001 is rejected with input_too_long. A caller planning for 90000
  // hits a wall at 50001 with an error code that has nothing to do with chunk_size —
  // completely the wrong debugging direction.
  const { MAX_INPUT_CHARS, MAX_CHUNKS, MAX_CHUNK_SIZE } = __test__.LIMITS;

  // The chunk budget is the larger of the two here; that is exactly why the interaction is
  // easy to get wrong when documenting it.
  assert.ok(
    MAX_CHUNKS * MAX_CHUNK_SIZE > MAX_INPUT_CHARS,
    'premise: the chunk budget exceeds the character cap, so the character cap binds'
  );

  await withMock({}, async (mock) => {
    // Exactly at the character cap, with a chunk_size that keeps it well inside MAX_CHUNKS.
    const atCap = 'a'.repeat(MAX_INPUT_CHARS);
    const ok = await worker.fetch(
      speechRequest({ input: atCap, voice: 'en-US-AvaNeural', chunk_size: MAX_CHUNK_SIZE }),
      ANON,
      {}
    );
    assert.equal(ok.status, 200, MAX_INPUT_CHARS + ' characters must be accepted');
    assert.ok(mock.calls.synth > 1, 'and it really was chunked');
  });

  await withMock({}, async (mock) => {
    // One character over: rejected by the character cap, NOT by the chunk cap.
    const overCap = 'a'.repeat(MAX_INPUT_CHARS + 1);
    const res = await worker.fetch(
      speechRequest({ input: overCap, voice: 'en-US-AvaNeural', chunk_size: MAX_CHUNK_SIZE }),
      ANON,
      {}
    );
    assert.equal(res.status, 400);
    assert.equal(
      (await res.json()).error.code,
      'input_too_long',
      'the character cap must be what rejects it, so the error names the right cause'
    );
    assert.equal(mock.calls.synth, 0);
  });
});

test('README never presents the chunk-budget product as a reachable capability', () => {
  // Guards the doc itself: the previous wording said chunk_size 2000 handles "~90000
  // characters" (45 x 2000), a figure MAX_INPUT_CHARS makes unreachable.
  //
  // A first version of this test only asked whether MAX_INPUT_CHARS appeared *somewhere* in
  // the file — and it passed against the reverted wording, because 50000 also appears in an
  // unrelated paragraph. Checking file-wide presence proves nothing. The property that
  // matters is local: wherever the chunk-budget product appears, the binding cap must appear
  // in the same paragraph, so a reader cannot take the big number as the limit.
  const { MAX_INPUT_CHARS, MAX_CHUNKS, MAX_CHUNK_SIZE } = __test__.LIMITS;
  const chunkBudget = String(MAX_CHUNKS * MAX_CHUNK_SIZE);
  const realCap = String(MAX_INPUT_CHARS);

  for (const file of ['README.md', 'README_CN.md']) {
    const text = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    // Paragraphs are blank-line separated in both files.
    for (const para of text.split(/\n\s*\n/)) {
      if (!para.includes(chunkBudget)) continue;
      assert.ok(
        para.includes(realCap),
        file +
          ': a paragraph mentions the chunk budget ' + chunkBudget +
          ' without the binding cap ' + realCap + ' beside it:\n' + para.trim().slice(0, 200)
      );
    }
  }
});

test('the too_many_chunks message suggests a chunk_size that actually works', async () => {
  // Found by mapping the chunks dimension (docs/research/chunk-distribution-20260806.md).
  //
  // The old message said "当前 chunk_size 下最多约 N 字符" computed as MAX_CHUNKS * chunk_size.
  // That is a product BOUND, only reachable if every chunk is filled to capacity — and
  // punctuation ends chunks early, so real capacity is always lower. It produced a
  // self-contradiction: a 50000-character request at chunk_size 1124 was rejected while the
  // very same response claimed "up to about 50580 characters" works. This is the same
  // unreachable-product error fixed in the README at v2.20.0; the error STRING kept it.
  //
  // Now the message binary-searches an actually-feasible chunk_size. Estimating was tried and
  // abandoned: multiplying ceil(len/45) by 1.05 / 1.15 / 1.25 / 1.4 / 1.6 was checked against
  // 88 (length x shape) combinations and NO factor passed them all, because fill ratio is a
  // quantisation effect rather than a constant — measured 65% for 82-char sentences and 100%
  // for unpunctuated text at the same chunk_size.
  const { MAX_CHUNKS, MAX_CHUNK_SIZE } = __test__.LIMITS;

  // Shapes with deliberately different fill ratios, at SEVERAL lengths.
  //
  // The length matters as much as the shape, and a mutation run proved it: with only
  // 50000-character inputs, swapping the binary search back for the failed `* 1.05` factor
  // still passed. That factor breaks at ~5000 characters, where a 44-char sentence period is a
  // large fraction of the chunk — so the short cases are exactly the ones that discriminate.
  const gen = {
    'english prose': (n) => 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(n / 44)).slice(0, n),
    '82-char sentences': (n) => ('a'.repeat(80) + '. ').repeat(Math.ceil(n / 82)).slice(0, n),
    'very short sentences': (n) => 'Short. '.repeat(Math.ceil(n / 7)).slice(0, n),
    'dense CJK punctuation': (n) => 'ab。'.repeat(Math.ceil(n / 3)).slice(0, n),
  };
  const shapes = {};
  for (const [name, f] of Object.entries(gen)) {
    for (const len of [5000, 20000, 50000]) shapes[`${name} @${len}`] = f(len);
  }

  for (const [label, input] of Object.entries(shapes)) {
    // 1. A chunk_size that is far too small must be refused.
    let suggested;
    await withMock({}, async (mock) => {
      const res = await worker.fetch(
        speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: 50 }),
        ANON,
        {}
      );
      assert.equal(res.status, 413, label + ': the minimum chunk_size must be refused for this input');
      const body = await res.json();
      assert.equal(body.error.code, 'too_many_chunks');
      assert.equal(body.error.param, 'chunk_size', label + ': names the field to change');
      assert.equal(mock.calls.synth, 0, label + ': a refusal must not call upstream');

      const m = /调到约 (\d+) 以上/.exec(body.error.message);
      assert.ok(m, label + ': the message must contain a concrete chunk_size to use, got: ' + body.error.message);
      suggested = Number(m[1]);
      assert.ok(
        suggested <= MAX_CHUNK_SIZE,
        label + `: suggesting ${suggested} exceeds the ${MAX_CHUNK_SIZE} maximum, which is unusable`
      );
      // The old bug in one assertion: the message must not promise a capacity above the
      // hard character cap, because MAX_INPUT_CHARS is checked before chunking.
      const promised = body.error.message.match(/最多约 (\d+) 字符/);
      assert.equal(promised, null, label + ': must not state an unreachable "up to N characters"');
    });

    // 2. THE POINT: following the suggestion must actually succeed. Without this the fix would
    //    just be a different misleading number — my first attempt (a 1.05 factor) failed here
    //    on English prose at 5000 characters, suggesting 125 where 56 chunks resulted.
    await withMock({}, async (mock) => {
      const res = await worker.fetch(
        speechRequest({ input, voice: 'en-US-AvaNeural', chunk_size: suggested }),
        ANON,
        {}
      );
      assert.equal(
        res.status,
        200,
        label + `: the suggested chunk_size ${suggested} must work, got ${res.status}`
      );
      assert.ok(
        mock.calls.synth <= MAX_CHUNKS,
        label + `: ${mock.calls.synth} chunks exceeds MAX_CHUNKS`
      );
    });
  }
});

test('chunk count decreases monotonically as chunk_size grows', async () => {
  // The suggestion above binary-searches, and rounds the result up to a multiple of 25. Both
  // steps are only valid if chunk count never INCREASES with a larger chunk_size. Verified
  // across 4 shapes x every chunk_size from 50 to 2000 (7800 points) with zero violations;
  // this test samples that so the property cannot silently regress if smartChunkText changes.
  const { smartChunkText, LIMITS } = __test__;
  const shapes = [
    'ab。'.repeat(7000).slice(0, 20000),
    'The quick brown fox jumps over the lazy dog. '.repeat(500).slice(0, 20000),
    ('a'.repeat(80) + '. ').repeat(300).slice(0, 20000),
  ];
  for (const text of shapes) {
    let prev = Infinity;
    for (let cs = LIMITS.MIN_CHUNK_SIZE; cs <= LIMITS.MAX_CHUNK_SIZE; cs += 37) {
      const n = smartChunkText(text, cs).length;
      assert.ok(
        n <= prev,
        `chunk count rose from ${prev} to ${n} when chunk_size reached ${cs} — the binary ` +
          'search in the too_many_chunks suggestion assumes monotonicity and would be unsound'
      );
      prev = n;
    }
  }
});
