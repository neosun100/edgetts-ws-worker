// Voice-list caching contract.
// The list is near-static (322 voices for days on end) but used to be fetched from
// Microsoft on every request (measured 52KB / up to 483ms). These tests pin the two
// layers of caching and, importantly, the degradation behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, req } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };

async function withMock(opts, fn) {
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch(opts);
  try { return await fn(mock); } finally { mock.restore(); }
}

test('repeated /v1/models requests hit upstream only once', async () => {
  await withMock({}, async (mock) => {
    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(req('/v1/models'), ANON, {});
      assert.equal(res.status, 200);
      assert.equal((await res.json()).length, 322, 'full list on every call');
    }
    assert.equal(mock.calls.voices, 1, '5 requests, 1 upstream fetch');
  });
});

test('/v1/models and /v1/models/public share the same cache', async () => {
  await withMock({}, async (mock) => {
    await worker.fetch(req('/v1/models'), ANON, {});
    await worker.fetch(req('/v1/models/public'), ANON, {});
    await worker.fetch(req('/v1/models'), ANON, {});
    assert.equal(mock.calls.voices, 1, 'both endpoints reuse one fetch');
  });
});

test('concurrent cold-start requests are coalesced into one upstream fetch', async () => {
  await withMock({}, async (mock) => {
    // Without in-flight coalescing, N simultaneous requests on a cold cache would
    // each fire their own upstream call.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => worker.fetch(req('/v1/models'), ANON, {}))
    );
    for (const res of results) assert.equal(res.status, 200);
    assert.equal(mock.calls.voices, 1, '8 concurrent requests, 1 upstream fetch');
  });
});

test('cached responses advertise Cache-Control so browsers/edge can cache too', async () => {
  await withMock({}, async () => {
    for (const path of ['/v1/models', '/v1/models/public']) {
      const res = await worker.fetch(req(path), ANON, {});
      const cc = res.headers.get('Cache-Control');
      assert.match(cc, /public/, path + ' is publicly cacheable');
      assert.match(cc, new RegExp('max-age=' + __test__.MODELS_CACHE_SECONDS), path);
    }
  });
});

test('filters operate on the cached list and do not poison it', async () => {
  await withMock({}, async (mock) => {
    const all = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    const ml = await (await worker.fetch(req('/v1/models?multilingual=true'), ANON, {})).json();
    const again = await (await worker.fetch(req('/v1/models'), ANON, {})).json();

    assert.equal(all.length, 322);
    assert.equal(ml.length, 12, 'multilingual subset');
    assert.equal(again.length, 322, 'unfiltered request still sees the full list');
    assert.equal(mock.calls.voices, 1);
  });
});

test('upstream failure after a successful fetch serves the stale cache, with a warning', async () => {
  await withMock({}, async (mock) => {
    // 1. warm the cache with a good fetch
    assert.equal((await (await worker.fetch(req('/v1/models'), ANON, {})).json()).length, 322);
    assert.equal(mock.calls.voices, 1);

    // 2. force the TTL to look expired without clearing the cached data, then break
    //    upstream — this is the real "stale-while-upstream-down" path.
    __test__.expireVoicesCache();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/voices/list')) return new Response('down', { status: 502 });
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(req('/v1/models'), ANON, {});
      assert.equal(res.status, 200);
      const models = await res.json();
      assert.equal(models.length, 322, 'served the full stale list, not the 2-voice fallback');
      // Degradation must leave a trace — silently serving stale data is undebuggable.
      assert.ok(
        mock.logs.some((l) => l.level === 'warn' && l.msg.includes('过期缓存')),
        'logged a warning that the data is stale'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('cold cache + upstream down -> /v1/models degrades to the built-in fallback, uncached', async () => {
  await withMock({}, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/voices/list')) return new Response('down', { status: 502 });
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(req('/v1/models'), ANON, {});
      assert.equal(res.status, 200);
      const models = await res.json();
      assert.ok(models.length > 0 && models.length < 322, 'small fallback list');
      // A degraded result must not be cached for hours as if it were the real list.
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('TTL is a sane duration and matches the advertised max-age', async () => {
  assert.ok(__test__.VOICES_TTL_MS >= 60 * 60 * 1000, 'at least an hour');
  assert.equal(
    __test__.MODELS_CACHE_SECONDS,
    __test__.VOICES_TTL_MS / 1000,
    'header max-age matches the in-process TTL'
  );
});

// --------------------------------------------------------- query-param filtering
// README documented ?neural and ?multilingual on both model endpoints, but the filter
// only existed on /v1/models — /v1/models/public silently ignored the parameters, and
// that is the endpoint the built-in voice picker uses. Filtering now lives in one shared
// helper so the two endpoints cannot drift apart again.

const bothEndpoints = ['/v1/models', '/v1/models/public'];

test('?multilingual=true filters on BOTH model endpoints', async () => {
  await withMock({}, async () => {
    for (const path of bothEndpoints) {
      const all = await (await worker.fetch(req(path), ANON, {})).json();
      const filtered = await (await worker.fetch(req(path + '?multilingual=true'), ANON, {})).json();
      assert.ok(all.length > filtered.length, path + ': the filter must actually remove voices');
      assert.ok(filtered.length > 0, path + ': multilingual voices exist');
      assert.ok(
        filtered.every((m) => m.id.includes('Multilingual')),
        path + ': every returned voice is multilingual'
      );
    }
  });
});

test('the two endpoints return identical results for the same filter', async () => {
  await withMock({}, async () => {
    const [a, b] = await Promise.all(
      bothEndpoints.map(async (p) =>
        (await (await worker.fetch(req(p + '?multilingual=true'), ANON, {})).json()).map((m) => m.id)
      )
    );
    assert.deepEqual(a, b, 'public and authenticated listings must not drift apart');
  });
});

test('only true/1 enable a filter; anything else is ignored', async () => {
  await withMock({}, async () => {
    const count = async (q) =>
      (await (await worker.fetch(req('/v1/models/public' + q), ANON, {})).json()).length;
    const total = await count('');
    assert.equal(await count('?multilingual=1'), await count('?multilingual=true'), '1 == true');
    assert.equal(await count('?multilingual=false'), total, 'false does not filter');
    assert.equal(await count('?multilingual=yes'), total, 'an unrecognised value does not filter');
    assert.equal(await count('?multilingual='), total, 'an empty value does not filter');
  });
});

test('?neural is a documented no-op: every upstream voice is Neural', async () => {
  // Kept for backward compatibility with existing callers rather than removed, but it
  // cannot filter anything. Pinning this stops someone "fixing" the docs the wrong way.
  await withMock({}, async () => {
    const all = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    const neural = await (await worker.fetch(req('/v1/models?neural=true'), ANON, {})).json();
    assert.equal(neural.length, all.length, '?neural cannot narrow the list');
    assert.equal(
      all.filter((m) => !m.id.includes('Neural')).length,
      0,
      'the premise: no non-Neural voice exists upstream'
    );
  });
});

// ------------------------------------------------------------------- description
// Every one of the 322 descriptions read literally "undefined - Female" in production:
// the code used voice.LocalName, but the upstream list has no such field (verified
// against the live endpoint on 2026-08-04 — 322/322 missing). The real field is
// FriendlyName, e.g. "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)".
//
// No test caught it because the fixture was built from the same wrong assumption: it
// carried a LocalName key whose values were all empty, so the output was "null - Female"
// rather than "undefined - Female" and nothing asserted on it. The fixture is now a
// field-faithful snapshot of the real upstream response.

test('no voice description contains undefined or null', async () => {
  await withMock({}, async () => {
    const models = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    assert.equal(models.length, 322, 'the fixture is the full upstream list');
    const broken = models.filter(
      (m) => !m.description || /undefined|null/.test(m.description)
    );
    assert.deepEqual(
      broken.slice(0, 3),
      [],
      broken.length + ' of ' + models.length + ' descriptions are broken'
    );
  });
});

test('a description is the voice name plus gender, not the whole FriendlyName', async () => {
  await withMock({}, async () => {
    const models = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    const xiaoxiao = models.find((m) => m.id === 'zh-CN-XiaoxiaoNeural');
    assert.ok(xiaoxiao, 'the fixture contains a known voice');
    assert.equal(xiaoxiao.description, 'Xiaoxiao - Female');
    // Locale and gender are already separate fields, so repeating them adds nothing.
    for (const m of models) {
      assert.ok(!m.description.includes('Microsoft '), m.id + ': raw FriendlyName leaked');
      assert.ok(!m.description.includes('(Natural)'), m.id + ': raw FriendlyName leaked');
    }
  });
});

test('every model carries the fields the UI relies on', async () => {
  await withMock({}, async () => {
    const models = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    for (const m of models) {
      assert.match(m.id, /^[a-z]{2,3}(-[A-Za-z0-9]+)+$/, 'id is a usable ShortName: ' + m.id);
      assert.match(m.language, /^[a-z]{2,3}-/, m.id + ': language looks like a locale');
      assert.ok(['Male', 'Female'].includes(m.gender), m.id + ': gender is set');
      assert.equal(m.object, 'model');
      assert.equal(m.owned_by, 'microsoft');
    }
  });
});

test('voiceDisplayName degrades safely when upstream changes shape', () => {
  // Fallbacks, so a future upstream rename produces a usable label rather than the
  // literal "undefined" this bug shipped. Tested directly: reaching these through the
  // HTTP surface would need a malformed voice list.
  const f = __test__.voiceDisplayName;
  assert.equal(f({ FriendlyName: 'Microsoft Xiaoxiao Online (Natural) - Chinese' }), 'Xiaoxiao');
  // Unrecognised format: keep the whole string rather than guessing.
  assert.equal(f({ FriendlyName: 'Totally New Format' }), 'Totally New Format');
  // Field missing or not a string: fall back to the ShortName, which always exists.
  assert.equal(f({ ShortName: 'zh-CN-XiaoxiaoNeural' }), 'zh-CN-XiaoxiaoNeural');
  assert.equal(f({ FriendlyName: '', ShortName: 'a-B-CNeural' }), 'a-B-CNeural');
  assert.equal(f({ FriendlyName: 42, ShortName: 'a-B-CNeural' }), 'a-B-CNeural');
  // Nothing usable at all: an empty label, never the string "undefined".
  assert.equal(f({}), '');
});

// ------------------------------------------------- degradation under concurrency
// The stale-cache fallback only protected the request that happened to trigger the
// refresh. Followers took an early `return voicesInFlight`, so the rejection surfaced
// outside the try/catch that implements the fallback and they skipped it entirely.
// Measured: with the cache expired and upstream down, 1 of 5 concurrent requests got the
// full 322-voice list and the other 4 got the 2-voice emergency list — the built-in
// voice picker would randomly show 2 voices.

test('every concurrent request gets the stale cache when upstream is down', async () => {
  await withMock({}, async (mock) => {
    // Warm the cache, then expire it so the next call attempts a refresh.
    const warm = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    assert.equal(warm.length, 322);
    __test__.expireVoicesCache();

    // Count here rather than via mock.calls.voices: these requests are answered by the
    // interceptor and never reach the mock, so the mock's counter would stay at 1.
    let attempts = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/voices/list')) {
        attempts++;
        return new Response('down', { status: 502 });
      }
      return realFetch(input, init);
    };
    try {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => worker.fetch(req('/v1/models'), ANON, {}))
      );
      const lengths = await Promise.all(
        responses.map(async (r) => (await r.json()).length)
      );
      assert.deepEqual(
        lengths,
        [322, 322, 322, 322, 322],
        'all callers must see the same stale list, not a mix of 322 and the fallback'
      );
      // Coalescing must survive the fix: one upstream attempt for the whole burst.
      assert.equal(attempts, 1, '5 concurrent requests share a single upstream attempt');
      assert.ok(
        mock.logs.some((l) => l.msg.includes('返回过期缓存')),
        'the degradation is logged'
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('with no cache at all, concurrent requests all degrade the same way', async () => {
  // The mirror case: nothing cached, upstream down. /v1/models has a built-in fallback
  // list; the important part is that every caller gets the SAME answer.
  await withMock({}, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/voices/list')) return new Response('down', { status: 502 });
      return realFetch(input, init);
    };
    try {
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => worker.fetch(req('/v1/models'), ANON, {}))
      );
      const results = await Promise.all(
        responses.map(async (r) => ({ status: r.status, n: (await r.json()).length }))
      );
      const first = JSON.stringify(results[0]);
      for (const r of results) {
        assert.equal(JSON.stringify(r), first, 'concurrent callers must not diverge');
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ------------------------------------------------------------------ ETag / 304
// The list was served with Cache-Control: public, max-age=21600 but no validator, and
// `created` used Date.now() — so all 322 entries changed on every response, the body was
// never byte-identical, and nothing downstream could reuse it. Measured on production:
// cf-cache-status absent on three consecutive requests, and created went
// 1785897556724 -> 1785897519071. Brotli was already applied by Cloudflare.

test('created is stable across responses', async () => {
  // A per-response timestamp defeats every caching layer. OpenAI's semantics for `created`
  // are "when the model was created", not "when this response was built".
  await withMock({}, async () => {
    const a = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    const b = await (await worker.fetch(req('/v1/models'), ANON, {})).json();
    assert.equal(a[0].created, b[0].created, 'created must not change between responses');
    assert.ok(Number.isInteger(a[0].created), 'created is an integer');
    // OpenAI uses seconds; a millisecond value here would be ~1000x too large.
    assert.ok(a[0].created < 1e11, 'created is in seconds, not milliseconds');
  });
});

test('both model endpoints serve an ETag and honour If-None-Match', async () => {
  for (const path of ['/v1/models', '/v1/models/public']) {
    await withMock({}, async () => {
      const first = await worker.fetch(req(path), ANON, {});
      const etag = first.headers.get('ETag');
      assert.ok(etag, path + ' must serve an ETag');
      assert.match(etag, /^W\//, 'a weak validator is the honest form here');

      const second = await worker.fetch(
        new Request('https://tts.test' + path, { headers: { 'if-none-match': etag } }),
        ANON,
        {}
      );
      assert.equal(second.status, 304, path + ' must answer 304 on a match');
      assert.equal((await second.text()).length, 0, 'a 304 carries no body');
      assert.equal(second.headers.get('ETag'), etag, 'the 304 repeats the validator');
    });
  }
});

test('a different filter yields a different ETag, and does not falsely match', async () => {
  // The ETag is computed AFTER filtering on purpose. Sharing one validator across
  // ?multilingual=true and the unfiltered list would let a conditional request receive a
  // 304 and reuse the wrong content — a correctness bug, not just a cache miss.
  await withMock({}, async () => {
    const all = await worker.fetch(req('/v1/models/public'), ANON, {});
    const filtered = await worker.fetch(req('/v1/models/public?multilingual=true'), ANON, {});
    const allTag = all.headers.get('ETag');
    const filteredTag = filtered.headers.get('ETag');
    assert.notEqual(allTag, filteredTag, 'different representations need different ETags');

    // Presenting the unfiltered validator against the filtered resource must NOT match.
    const cross = await worker.fetch(
      new Request('https://tts.test/v1/models/public?multilingual=true', {
        headers: { 'if-none-match': allTag },
      }),
      ANON,
      {}
    );
    assert.equal(cross.status, 200, 'must not serve 304 for a different representation');
    const body = await cross.json();
    assert.ok(body.every((m) => m.id.includes('Multilingual')), 'and the body is the filtered one');
  });
});

test('a stale or malformed If-None-Match is ignored, not trusted', async () => {
  await withMock({}, async () => {
    for (const header of ['W/"1-deadbeef"', 'garbage', '', '*']) {
      const res = await worker.fetch(
        new Request('https://tts.test/v1/models', { headers: { 'if-none-match': header } }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, JSON.stringify(header) + ' must not produce a 304');
    }
  });
});

test('the ETag changes when the list changes', async () => {
  // Otherwise a client could cache a stale list forever. Two different voice lists must
  // produce two different validators.
  const small = [
    { ShortName: 'en-US-AvaNeural', Locale: 'en-US', Gender: 'Female', FriendlyName: 'Microsoft Ava Online (Natural) - English' },
  ];
  const bigger = [
    ...small,
    { ShortName: 'en-US-GuyNeural', Locale: 'en-US', Gender: 'Male', FriendlyName: 'Microsoft Guy Online (Natural) - English' },
  ];
  let tagA;
  await withMock({ voices: small }, async () => {
    tagA = (await worker.fetch(req('/v1/models'), ANON, {})).headers.get('ETag');
  });
  await withMock({ voices: bigger }, async () => {
    const tagB = (await worker.fetch(req('/v1/models'), ANON, {})).headers.get('ETag');
    assert.notEqual(tagA, tagB, 'a changed list must invalidate the old validator');
  });
});

test('a 304 is only served to GET/HEAD, since writes are already rejected', async () => {
  // Regression guard for ordering: the method check has to run before the conditional
  // check, or a PUT with If-None-Match would get a 304 instead of a 405.
  await withMock({}, async () => {
    const etag = (await worker.fetch(req('/v1/models'), ANON, {})).headers.get('ETag');
    const res = await worker.fetch(
      new Request('https://tts.test/v1/models', {
        method: 'PUT',
        headers: { 'if-none-match': etag },
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 405, 'method rejection takes precedence over revalidation');
    assert.equal(res.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  });
});
