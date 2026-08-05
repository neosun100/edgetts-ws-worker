// Token lifecycle: the three self-healing branches around the MSTranslator token.
//
// Found by mutation testing: all three could be deleted with the whole suite still
// green, even though each has an externally visible effect. They are deliberate
// robustness features (the CHANGELOG and the source comments treat them as such),
// so they need tests that fail when they are removed.
//
//   1. a 401 mid-request forces a token refresh before retrying   (worker.js getAudioChunk)
//   2. a token is replaced TOKEN_REFRESH_BEFORE_EXPIRY early      (worker.js getEndpoint)
//   3. if the token endpoint is down, a still-VALID cached token  (worker.js fetchEndpoint)
//      is reused rather than failing the request — and an expired
//      one is NOT, because handing upstream a dead token turns
//      our own outage into a 400 blaming the caller's voice
//
// Each test asserts a *count* or a *log line*, not just the status code — status alone
// is 200 in both the working and the broken version of branches 1 and 2.
//
// Branch 3 said "an expired cached token is reused" here and in the test name, while the
// fixture (`tokenExp: 120`) is a token with two minutes of life left. Two tests inherited
// that wording, so the genuinely-expired case looked covered and was not. Wording in a test
// name is load-bearing: it is what tells the next reader which cases still need writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a still-valid cached token is reused when the token endpoint is down', async () => {
  // The user-visible one: if dev.microsofttranslator.com blips, falling back to the
  // cached token means audio still plays. Deleting this branch turns a 200 into a 500.
  //
  // NOTE ON THIS TEST'S NAME. It used to say "an expired cached token is reused", but the
  // fixture is `tokenExp: 120` — a token with 120 seconds of life left. That is NOT expired;
  // it is merely inside TOKEN_REFRESH_BEFORE_EXPIRY (5 min), which is what makes the refresh
  // fire at all. The token handed to upstream is still perfectly good.
  //
  // That mislabelling is why a real bug survived here: the suite looked like it covered the
  // expired case, so nobody wrote the case where the cached token is genuinely dead. It is
  // the test below this one, and the behaviour it asserts is the opposite of this one's.
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
        mock.logs.some((l) => l.msg.includes('缓存 Token 兜底')),
        'the degradation must be logged — a silent fallback is unattributable'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('an EXPIRED cached token is not used as a fallback, and the error names the real cause', async () => {
  // The bug the mislabelled test above was hiding. `tokenInfo.token` being non-null was the
  // only condition on the fallback, so a genuinely dead token was handed to upstream too.
  //
  // The consequence was not just a wasted call — it was a completely misattributed error,
  // via a causal chain nobody would guess from the response:
  //
  //   token endpoint down + cached token expired
  //     -> fetchEndpoint returns the dead token
  //     -> upstream answers 401
  //     -> 401 is on getAudioChunk's retryable list
  //     -> forceRefresh -> endpoint still down -> the SAME dead token
  //     -> MAX_CHUNK_ATTEMPTS exhausted -> throws with status 401
  //     -> getVoice maps any upstream 4xx to a caller error
  //     -> the caller is told "voice does not exist, use an id from GET /v1/models"
  //
  // Reproduced before the fix: 400 with that voice message. The caller is sent to change
  // their voice when the truth is that OUR token fetch is failing. This asserts both halves:
  // the status is a 5xx (ours, not theirs) and the message does not blame the voice.
  await withMock({ tokenExp: -10 }, async (mock) => {
    // 1. Warm the cache. The token endpoint works, but hands out an already-dead token —
    //    exactly what a clock skew or a long stall produces in production.
    const warm = await worker.fetch(
      speechRequest({ input: 'warm', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    // The mock's synthesis endpoint does not check the token, so warming still returns audio.
    assert.equal(warm.status, 200, 'premise: the cache is now holding an expired token');
    assert.ok(mock.calls.token >= 1, 'premise: a token was cached');

    // 2. Now the token endpoint goes down too, so no fresh token can be had.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('dev.microsofttranslator.com/apps/endpoint')) {
        return new Response('token endpoint down', { status: 503 });
      }
      // Upstream rejects the dead token, which is what production would do.
      if (url.includes('.tts.speech.microsoft.com/cognitiveservices/v1')) {
        return new Response('unauthorized', { status: 401 });
      }
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(
        speechRequest({ input: 'now what', voice: 'en-US-AvaNeural' }),
        ANON,
        {}
      );
      assert.equal(
        res.status,
        500,
        'our own dependency failed, so this is a 5xx — a 4xx tells the caller to fix their request'
      );
      const body = await res.json();
      assert.equal(body.error.code, 'tts_generation_error');
      assert.ok(
        !/voice|音色|models/i.test(body.error.message),
        'the message must not blame the voice for a token failure, got: ' + body.error.message
      );
      // Per the degradation rule: declining to degrade is itself an event worth a log line,
      // and it must read differently from the successful-fallback case above.
      assert.ok(
        mock.logs.some((l) => l.msg.includes('缓存 Token 已过期')),
        'refusing to use a dead token must be logged, distinctly from the valid-token fallback'
      );
      assert.ok(
        !mock.logs.some((l) => l.msg.includes('剩余')),
        'the valid-token fallback message must NOT appear — nothing was salvaged here'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('a dead token breaks the stream rather than ending it cleanly at zero bytes', async () => {
  // The streaming path cannot send a status after the headers are out, so its only honest
  // way to report a failure is to break the stream. Verified against the same expired-token
  // scenario: a clean EOF here would be a 200 with a well-formed empty body, which a caller
  // cannot distinguish from "the text produced no audio" — the silent-truncation class of bug
  // this project has already fixed twice (multi-chunk WAV, multi-chunk Opus).
  await withMock({ tokenExp: -10 }, async () => {
    await worker.fetch(speechRequest({ input: 'warm', voice: 'en-US-AvaNeural' }), ANON, {});

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('dev.microsofttranslator.com/apps/endpoint')) {
        return new Response('token endpoint down', { status: 503 });
      }
      if (url.includes('.tts.speech.microsoft.com/cognitiveservices/v1')) {
        return new Response('unauthorized', { status: 401 });
      }
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(
        speechRequest({ input: 'now what', voice: 'en-US-AvaNeural', stream: true, response_format: 'pcm' }),
        ANON,
        {}
      );
      // Headers were already committed before the failure was known, so 200 is expected.
      assert.equal(res.status, 200, 'a stream cannot retract its status code');
      await assert.rejects(
        () => res.arrayBuffer(),
        'the body must error out; a clean zero-byte EOF would look like a successful empty result'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('both READMEs state the token-failure attribution they now implement', () => {
  // The README's error table is a contract callers write code against, and this project has
  // already shipped two doc claims that quietly stopped being true. The claim added here —
  // "a token failure is a 5xx, not a 4xx blaming the voice" — is exactly the kind that rots
  // invisibly, because nothing about it breaks a build.
  for (const file of ['README.md', 'README_CN.md']) {
    const text = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    const para = text
      .split(/\n\s*\n/)
      .find((p) => /token/i.test(p) && /tts_generation_error/.test(p));
    assert.ok(
      para,
      file + ': no paragraph documents that a token failure maps to tts_generation_error'
    );
    assert.ok(
      /500/.test(para),
      file + ': the token-failure paragraph must name the 500 status, got:\n' + para.trim().slice(0, 200)
    );
    assert.ok(
      /upstream_rejected_request/.test(text),
      file + ': the contrasting 400 code must be documented too, or a reader cannot tell ' +
        'which failures are theirs to fix'
    );
  }
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
