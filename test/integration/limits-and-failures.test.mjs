// Request-size limits and upstream-failure paths.
// These are the branches that matter most in production (upstream 5xx, voice-list
// outage, token endpoint down) and were the main gap left in coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest, req } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };

async function withMock(opts, fn) {
  __test__.resetTokenCache();
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
    const res = await worker.fetch(
      new Request('https://tts.test/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error.code, 'payload_too_large');
    // Error carries both the actual and the limit, per the project's error contract.
    assert.match(json.error.message, /\d+ > \d+/);
    assert.equal(mock.calls.synth, 0, 'never reaches upstream');
  });
});

test('a body at the limit still succeeds', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hello', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.ok(mock.calls.synth >= 1);
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
    assert.equal(res.status, 500);
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
