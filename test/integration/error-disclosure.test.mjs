// Error responses must not forward internal detail to callers.
//
// Found by audit: getAudioChunk put the upstream response body into Error.message, and
// getVoice's catch put error.message straight into the HTTP response — so Microsoft's
// raw error text (which can carry subscription-key fragments, internal hostnames and
// request ids) was handed to any caller. Reproduced with a stubbed upstream returning
// "Subscription key sk-INTERNAL-abc123 rejected at /internal/host", which appeared
// verbatim in the 500 body.
//
// The contract: callers get our own wording + a machine-readable code; the full detail
// goes to the log only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest, req } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };
const SECRET = 'sk-INTERNAL-abc123 at /internal/host';

async function withMock(opts, fn) {
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch(opts);
  try { return await fn(mock); } finally { mock.restore(); }
}

test('upstream error body is NOT forwarded to the caller (non-streaming)', async () => {
  await withMock({ synth: () => ({ status: 500, body: SECRET }) }, async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 500);
    const raw = await res.text();
    assert.ok(!raw.includes('sk-INTERNAL'), 'no key fragment in response: ' + raw);
    assert.ok(!raw.includes('/internal/host'), 'no internal path in response: ' + raw);
    const json = JSON.parse(raw);
    // Still actionable: a stable machine code plus human wording.
    assert.equal(json.error.code, 'tts_generation_error');
    assert.ok(json.error.message.length > 0);

    // The detail must still be recoverable by an operator — it goes to the log.
    assert.ok(
      mock.logs.some((l) => l.msg.includes('sk-INTERNAL')),
      'full upstream text is logged for debugging'
    );
  });
});

test('upstream status is not echoed with its body in the error message', async () => {
  await withMock({ synth: () => ({ status: 503, body: 'internal detail ' + SECRET }) }, async () => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    const raw = await res.text();
    assert.ok(!raw.includes('internal detail'), 'upstream prose not leaked: ' + raw);
  });
});

test('an unexpected internal throw yields a generic 500, not the raw message', async () => {
  await withMock({}, async () => {
    // Break the voice-list fetch with a message that looks like an internal leak, and
    // hit an endpoint whose handler has no fallback of its own.
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/voices/list')) throw new Error('ENOENT /srv/secret/config.json');
      return real(input, init);
    };
    try {
      const res = await worker.fetch(req('/v1/models/public'), ANON, {});
      assert.equal(res.status, 500);
      const raw = await res.text();
      assert.ok(!raw.includes('/srv/secret'), 'internal path not leaked: ' + raw);
      assert.equal(JSON.parse(raw).error.code, 'fetch_error');
    } finally {
      globalThis.fetch = real;
    }
  });
});

test('validation errors still include the actual vs allowed values (deliberately)', async () => {
  // Not everything should be redacted: a caller's OWN bad input must be explained,
  // including the offending value and the limit. Only internal detail is withheld.
  await withMock({}, async () => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', speed: 99 }),
      ANON,
      {}
    );
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_speed');
    assert.match(json.error.message, /99/, 'tells the caller what they sent');
    assert.match(json.error.message, /0\.25|4/, 'tells the caller the allowed range');
  });
});

// ------------------------------------------------------------ error.param
// The response shape has always carried `param` (OpenAI uses it to name the offending
// field) but all 26 error sites hardcoded null. Two codes each serve two different causes —
// invalid_request_error covers "body is not JSON" and "input field missing", and
// invalid_cleaning_options covers "the container is the wrong type" and
// "custom_keywords is the wrong type" — so a caller branching on `code` alone cannot tell
// which field to fix. Renaming the codes would break existing callers (and the tests that
// pin them); populating `param` is purely additive.

test('error.param names the offending field', async () => {
  const cases = [
    [{ input: 'hi', voice: 'en-US-AvaNeural', speed: 99 }, 'invalid_speed', 'speed'],
    [{ input: 'hi', voice: '!!!' }, 'invalid_voice', 'voice'],
    [{ input: 'hi', voice: 'en-US-AvaNeural', pitch: 9 }, 'invalid_pitch', 'pitch'],
    [{ input: 'hi', voice: 'en-US-AvaNeural', stream: 'false' }, 'invalid_stream', 'stream'],
    [
      { input: 'hi', voice: 'en-US-AvaNeural', response_format: 'aac' },
      'invalid_response_format',
      'response_format',
    ],
  ];
  for (const [body, code, param] of cases) {
    await withMock({}, async () => {
      const res = await worker.fetch(speechRequest(body), ANON, {});
      const json = await res.json();
      assert.equal(json.error.code, code, JSON.stringify(body));
      assert.equal(json.error.param, param, code + ' must name its field');
    });
  }
});

test('param disambiguates the two codes that serve two causes each', async () => {
  // This is the whole point: same code, different param, so a caller can act on it.
  await withMock({}, async () => {
    const malformed = await worker.fetch(
      new Request('https://tts.test/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
      ANON,
      {}
    );
    const a = await malformed.json();
    assert.equal(a.error.code, 'invalid_request_error');
    assert.equal(a.error.param, 'body', 'a malformed body points at the body');
  });

  await withMock({}, async () => {
    const missing = await worker.fetch(speechRequest({ voice: 'en-US-AvaNeural' }), ANON, {});
    const b = await missing.json();
    assert.equal(b.error.code, 'invalid_request_error', 'same code as above');
    assert.equal(b.error.param, 'input', 'but param distinguishes the cause');
  });

  await withMock({}, async () => {
    const container = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', cleaning_options: 'x' }),
      ANON,
      {}
    );
    const c = await container.json();
    assert.equal(c.error.code, 'invalid_cleaning_options');
    assert.equal(c.error.param, 'cleaning_options');
  });

  await withMock({}, async () => {
    const field = await worker.fetch(
      speechRequest({
        input: 'hi',
        voice: 'en-US-AvaNeural',
        cleaning_options: { custom_keywords: 1 },
      }),
      ANON,
      {}
    );
    const d = await field.json();
    assert.equal(d.error.code, 'invalid_cleaning_options', 'same code');
    assert.equal(
      d.error.param,
      'cleaning_options.custom_keywords',
      'param points at the nested field, not just the container'
    );
  });
});

test('errors with no corresponding request field leave param null', async () => {
  // Inventing a param for an internal failure would be worse than admitting there is none.
  await withMock({}, async () => {
    const res = await worker.fetch(req('/nope'), ANON, {});
    const json = await res.json();
    assert.equal(json.error.code, 'not_found');
    assert.equal(json.error.param, null);
  });
});

// -------------------------------------------------------------- log diagnosability
test('a chunk failure is attributable to a specific chunk and format', async () => {
  // Without the chunk label, concurrent retries produced "分块合成第 2 次失败" twice, which
  // reads like a broken counter but is actually two different chunks each on their second
  // attempt. An operator cannot tell "one chunk keeps failing" (bad text) from "every chunk
  // is failing" (upstream throttling) — and those call for different responses.
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch({
    synth: ({ index }) =>
      index === 1 ? { status: 429, body: 'rate limited' } : { status: 200, body: Buffer.alloc(64) },
  });
  try {
    await worker.fetch(
      speechRequest({
        input: '这是一句测试文本。'.repeat(20),
        voice: 'zh-CN-XiaoxiaoNeural',
        response_format: 'wav',
        chunk_size: 100,
      }),
      ANON,
      {}
    );
    const logged = mock.logs.map((l) => l.msg).join('\n');
    assert.match(logged, /#\d+\/\d+/, 'logs identify which chunk of how many');
    assert.match(logged, /riff-24khz/, 'and the upstream output format');
    assert.match(logged, /429/, 'and the upstream status code');
    // The failing chunk is index 1, so its label must appear; a passing chunk must not be
    // reported as failing.
    assert.match(logged, /#2\/\d+/, 'the failing chunk is named');
  } finally {
    mock.restore();
  }
});

test('every degradation path leaves a trace in the log', async () => {
  // The project's own rule: a degraded result and a healthy one must not look identical in
  // the log. Checks the paths that silently substitute something for the real answer.
  const checks = [];

  // 1. stale voice cache when upstream is down
  await withMock({}, async (mock) => {
    await worker.fetch(req('/v1/models'), ANON, {});
    __test__.expireVoicesCache();
    const real = globalThis.fetch;
    globalThis.fetch = async (i, init) => {
      const u = typeof i === 'string' ? i : i.url;
      if (u.includes('/voices/list')) return new Response('down', { status: 502 });
      return real(i, init);
    };
    try {
      await worker.fetch(req('/v1/models'), ANON, {});
    } finally {
      globalThis.fetch = real;
    }
    checks.push(['stale voice cache', mock.logs.some((l) => l.msg.includes('过期缓存'))]);
  });

  // 2. built-in fallback list on a cold cache
  await withMock({}, async (mock) => {
    const real = globalThis.fetch;
    globalThis.fetch = async (i, init) => {
      const u = typeof i === 'string' ? i : i.url;
      if (u.includes('/voices/list')) return new Response('down', { status: 502 });
      return real(i, init);
    };
    try {
      await worker.fetch(req('/v1/models'), ANON, {});
    } finally {
      globalThis.fetch = real;
    }
    checks.push(['fallback voice list', mock.logs.some((l) => l.msg.includes('获取语音列表失败'))]);
  });

  // 3. a still-valid cached token reused because the token endpoint is down.
  //    (`tokenExp: 120` is 120 seconds of remaining life — inside the 5-minute refresh
  //    margin, so the refresh fires, but the token itself is NOT expired. This case used to
  //    be labelled "expired token", and that wording in two separate tests is what hid a
  //    real bug: the genuinely-expired case was never covered, and the fallback handed a dead
  //    token to upstream, which surfaced to callers as "voice does not exist". Both branches
  //    are now pinned in test/integration/token-lifecycle.test.mjs.)
  __test__.resetTokenCache();
  const tokenMock = installMockFetch({ tokenExp: 120 });
  try {
    await worker.fetch(speechRequest({ input: 'warm', voice: 'en-US-AvaNeural' }), ANON, {});
    const real = globalThis.fetch;
    globalThis.fetch = async (i, init) => {
      const u = typeof i === 'string' ? i : i.url;
      if (u.includes('dev.microsofttranslator.com')) return new Response('down', { status: 503 });
      return real(i, init);
    };
    try {
      await worker.fetch(speechRequest({ input: 'x', voice: 'en-US-AvaNeural' }), ANON, {});
    } finally {
      globalThis.fetch = real;
    }
    checks.push([
      'cached token fallback',
      tokenMock.logs.some((l) => l.msg.includes('缓存 Token 兜底')),
    ]);
  } finally {
    tokenMock.restore();
  }

  // 4 & 5. container merges declining and falling back to plain concatenation
  for (const [format, needle] of [['wav', 'WAV 合并'], ['opus', 'WebM 合并']]) {
    __test__.resetTokenCache();
    const mock = installMockFetch({ synth: () => ({ status: 200, body: Buffer.alloc(40, 5) }) });
    try {
      await worker.fetch(
        speechRequest({
          input: '这是一句用来触发多分块的中文文本。'.repeat(12),
          voice: 'zh-CN-XiaoxiaoNeural',
          response_format: format,
          chunk_size: 50,
        }),
        ANON,
        {}
      );
      checks.push([format + ' merge fallback', mock.logs.some((l) => l.msg.includes(needle))]);
    } finally {
      mock.restore();
    }
  }

  // 6. running without auth
  __test__.resetTokenCache();
  const anonMock = installMockFetch();
  try {
    await worker.fetch(speechRequest({ input: 'hi', voice: 'en-US-AvaNeural' }), ANON, {});
    checks.push(['anonymous mode', anonMock.logs.some((l) => l.msg.includes('匿名模式'))]);
  } finally {
    anonMock.restore();
  }

  // 7. DECLINING to degrade. The rule cuts both ways: choosing not to substitute is also a
  //    decision the operator needs to see, and it must be distinguishable from the successful
  //    fallback in (3). Without this line, "token endpoint down, nothing salvageable" and
  //    "token endpoint down, rode it out on cache" look the same in the log.
  __test__.resetTokenCache();
  const deadMock = installMockFetch({ tokenExp: -10 });
  try {
    await worker.fetch(speechRequest({ input: 'warm', voice: 'en-US-AvaNeural' }), ANON, {});
    const real = globalThis.fetch;
    globalThis.fetch = async (i, init) => {
      const u = typeof i === 'string' ? i : i.url;
      if (u.includes('dev.microsofttranslator.com')) return new Response('down', { status: 503 });
      return real(i, init);
    };
    try {
      await worker.fetch(speechRequest({ input: 'x', voice: 'en-US-AvaNeural' }), ANON, {});
    } finally {
      globalThis.fetch = real;
    }
    checks.push([
      'refusing an expired token',
      deadMock.logs.some((l) => l.msg.includes('缓存 Token 已过期')),
    ]);
  } finally {
    deadMock.restore();
  }

  const silent = checks.filter(([, logged]) => !logged).map(([name]) => name);
  assert.deepEqual(silent, [], 'these degradations happen silently: ' + silent.join(', '));
  assert.equal(checks.length, 7, 'all seven paths were exercised');
});
