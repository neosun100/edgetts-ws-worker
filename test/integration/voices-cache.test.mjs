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
