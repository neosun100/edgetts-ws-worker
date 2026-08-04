// Token lifecycle: the three self-healing branches around the MSTranslator token.
//
// Found by mutation testing: all three could be deleted with the whole suite still
// green, even though each has an externally visible effect. They are deliberate
// robustness features (the CHANGELOG and the source comments treat them as such),
// so they need tests that fail when they are removed.
//
//   1. a 401 mid-request forces a token refresh before retrying   (worker.js getAudioChunk)
//   2. a token is replaced TOKEN_REFRESH_BEFORE_EXPIRY early      (worker.js getEndpoint)
//   3. if the token endpoint is down, an expired cached token is  (worker.js fetchEndpoint)
//      reused rather than failing the request
//
// Each test asserts a *count* or a *log line*, not just the status code — status alone
// is 200 in both the working and the broken version of branches 1 and 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };

async function withMock(opts, fn) {
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch(opts);
  try { return await fn(mock); } finally { mock.restore(); }
}

test('a 401 from upstream forces a token refresh before the retry', async () => {
  // A cached token can expire between being handed out and being used. The retry must
  // not reuse it: getAudioChunk passes forceRefresh when the previous attempt was 401.
  // Without that, the second attempt reuses the same dead token and the fix is a no-op
  // (the mock happens to accept it, so the status stays 200 either way — only the token
  // fetch count reveals the difference).
  await withMock({ failSynthOnce: { status: 401 } }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200, 'the retry succeeds');
    assert.equal(mock.calls.synth, 2, 'exactly one retry after the 401');
    assert.equal(
      mock.calls.token,
      2,
      'the 401 must trigger a second token fetch — reusing the dead token is the bug'
    );
  });
});

test('a non-401 failure retries WITHOUT refetching the token', async () => {
  // The mirror image: forceRefresh is conditioned on 401 specifically. A 500 is a
  // server-side hiccup, not a token problem, so re-signing a token endpoint request
  // would be wasted upstream load. This pins the condition rather than the branch.
  await withMock({ failSynthOnce: { status: 500 } }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(mock.calls.synth, 2, 'retried once');
    assert.equal(mock.calls.token, 1, 'a 500 must not cause a token refresh');
  });
});

test('a token inside the refresh window is replaced before it expires', async () => {
  // TOKEN_REFRESH_BEFORE_EXPIRY (5 min) keeps requests from carrying a nearly-dead
  // token. With a 120s token, every request sits inside that window, so every request
  // must refetch. If the margin were 0, one token would be reused for all three.
  const margin = 5 * 60;
  await withMock({ tokenExp: 120 }, async (mock) => {
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(
        speechRequest({ input: 'hi ' + i, voice: 'en-US-AvaNeural' }),
        ANON,
        {}
      );
      assert.equal(res.status, 200);
    }
    assert.equal(
      mock.calls.token,
      3,
      'a token expiring within the refresh margin must not be reused'
    );
  });

  // Control: a token comfortably outside the window IS reused, which proves the test
  // above is measuring the margin and not just "always refetches".
  await withMock({ tokenExp: margin + 3600 }, async (mock) => {
    for (let i = 0; i < 3; i++) {
      await worker.fetch(
        speechRequest({ input: 'hi ' + i, voice: 'en-US-AvaNeural' }),
        ANON,
        {}
      );
    }
    assert.equal(mock.calls.token, 1, 'a long-lived token is fetched once and cached');
  });
});

test('an expired cached token is reused when the token endpoint is down', async () => {
  // The user-visible one: if dev.microsofttranslator.com blips, falling back to the
  // stale token means audio still plays. Deleting this branch turns a 200 into a 500.
  //
  // Per the project's degradation rule, the fallback must also leave a trace — the
  // caller cannot tell, so the log is the only place the degradation is visible.
  await withMock({ tokenExp: 120 }, async (mock) => {
    // 1. Warm the cache with a working token endpoint.
    const first = await worker.fetch(
      speechRequest({ input: 'warm', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(first.status, 200);
    const tokensAfterWarmup = mock.calls.token;
    assert.ok(tokensAfterWarmup >= 1, 'cache is warm');

    // 2. Break ONLY the token endpoint; synthesis stays healthy.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('dev.microsofttranslator.com/apps/endpoint')) {
        return new Response('token endpoint down', { status: 503 });
      }
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(
        speechRequest({ input: 'still works', voice: 'en-US-AvaNeural' }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, 'the stale token keeps synthesis working');
      assert.ok((await res.arrayBuffer()).byteLength > 0, 'real audio came back');
      assert.ok(
        mock.logs.some((l) => l.msg.includes('使用过期的缓存 Token')),
        'the degradation must be logged — a silent fallback is unattributable'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('with no cached token at all, a dead token endpoint is a clean 500', async () => {
  // The fallback only applies when there IS something cached. A cold start against a
  // dead token endpoint must fail loudly rather than pretend to succeed.
  await withMock({ failTokenTimes: Infinity }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'tts_generation_error');
    assert.equal(mock.calls.synth, 0, 'never attempted synthesis without a token');
  });
});
