// Integration: the auth gate (4 states) and the routing table, exercised through
// worker.fetch with the mock upstream installed. No network, no real Microsoft calls.
//
// Why the UI_HTML dance below: src/worker.js references a bare `UI_HTML` identifier that
// scripts/build.mjs injects as a top-level const in dist/worker.js. Importing the source
// directly leaves that identifier unresolved, so `GET /` throws ReferenceError unless the
// test provides it on globalThis (a bare identifier resolves through the global object).
// We inject the real ui/index.html so the served bytes match production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest, req, VOICES } from '../helpers/mock-upstream.mjs';

const UI = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');

before(() => {
  globalThis.UI_HTML = UI;
});
after(() => {
  delete globalThis.UI_HTML;
});

// Every test runs under a fresh mock + empty token/voices caches; `fn(mock)` gets the
// harness. Resetting the voice-list cache matters: without it, a test that already
// populated it would silently satisfy the next test's "did it hit upstream?" assertion.
async function withMock(opts, fn) {
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch(opts);
  try {
    return await fn(mock);
  } finally {
    mock.restore();
  }
}

const speechBody = { input: 'hello', voice: 'en-US-AvaNeural' };

async function errorBody(res) {
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  const json = await res.json();
  assert.equal(typeof json.error, 'object');
  // param 曾恒为 null，那时这条断言钉的是占位值而非契约。现在它会指出出错的字段
  // （见 error-disclosure.test.mjs），所以这里改为断言**形状**：要么是 null，要么是一个
  // 非空字符串。钉具体值属于那个文件的职责，这里只保证不会漏出 undefined 之类。
  assert.ok(
    json.error.param === null || (typeof json.error.param === "string" && json.error.param.length > 0),
    "error.param must be null or a non-empty string, got " + JSON.stringify(json.error.param)
  );
  assert.equal(json.error.type, 'api_error');
  return json.error;
}

// ---------------------------------------------------------------- auth: 4 states

test('auth state 1: no API_KEY and no ALLOW_ANONYMOUS -> 503 server_misconfigured', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(speechRequest(speechBody), {}, {});
    assert.equal(res.status, 503);
    const err = await errorBody(res);
    assert.equal(err.code, 'server_misconfigured');
    assert.match(err.message, /ALLOW_ANONYMOUS/);
    // Rejected before any upstream work.
    assert.equal(mock.calls.token, 0);
    assert.equal(mock.calls.synth, 0);
    // Degradation must leave a trace: an error log, not a silent 503.
    const errs = mock.logs.filter((l) => l.level === 'error');
    assert.equal(errs.length, 1);
    assert.match(errs[0].msg, /API_KEY 未绑定/);
    assert.equal(mock.logs.filter((l) => l.level === 'warn').length, 0);
  });
});

test('auth state 1b: empty-string API_KEY counts as unset -> 503', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(speechRequest(speechBody, { key: '' }), { API_KEY: '' }, {});
    assert.equal(res.status, 503);
    assert.equal((await errorBody(res)).code, 'server_misconfigured');
    assert.equal(mock.calls.synth, 0);
  });
});

test('auth state 1c: ALLOW_ANONYMOUS must be exactly "true" ("TRUE"/boolean -> 503)', async () => {
  await withMock({}, async () => {
    for (const value of ['TRUE', 'True', '1', 'yes', true]) {
      const res = await worker.fetch(speechRequest(speechBody), { ALLOW_ANONYMOUS: value }, {});
      assert.equal(res.status, 503, `ALLOW_ANONYMOUS=${String(value)} must not open the API`);
      assert.equal((await errorBody(res)).code, 'server_misconfigured');
    }
  });
});

test('auth state 2: ALLOW_ANONYMOUS=true lets an unauthenticated request through, with a warn log', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(speechRequest(speechBody), { ALLOW_ANONYMOUS: 'true' }, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.equal(buf.byteLength, 4800); // one chunk => fakeAudio(100) => 100ms * 48 bytes
    assert.equal(mock.calls.token, 1);
    assert.equal(mock.calls.synth, 1);
    // Anonymous mode is a security-relevant downgrade: it must be logged as warn.
    const warns = mock.logs.filter((l) => l.level === 'warn');
    assert.equal(warns.length, 1);
    assert.match(warns[0].msg, /匿名模式/);
    assert.match(warns[0].msg, /ALLOW_ANONYMOUS=true/);
    assert.equal(mock.logs.filter((l) => l.level === 'error').length, 0);
  });
});

test('auth state 2b: anonymous warn is emitted once per request', async () => {
  await withMock({}, async (mock) => {
    const env = { ALLOW_ANONYMOUS: 'true' };
    await worker.fetch(speechRequest(speechBody), env, {});
    await worker.fetch(speechRequest(speechBody), env, {});
    assert.equal(mock.logs.filter((l) => l.level === 'warn' && /匿名模式/.test(l.msg)).length, 2);
  });
});

test('auth state 3: API_KEY set + matching Bearer -> 200 audio', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(
      speechRequest(speechBody, { key: 's3cret-key' }),
      { API_KEY: 's3cret-key' },
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal((new Uint8Array(await res.arrayBuffer())).byteLength, 4800);
    assert.equal(mock.calls.synth, 1);
    // Authenticated path must NOT log the anonymous warning.
    assert.equal(mock.logs.filter((l) => /匿名模式/.test(l.msg)).length, 0);
  });
});

test('auth state 4: API_KEY set + wrong/missing/malformed Bearer -> 401 invalid_api_key', async () => {
  await withMock({}, async (mock) => {
    const env = { API_KEY: 's3cret-key' };
    const cases = [
      ['wrong key', speechRequest(speechBody, { key: 'wrong-key' })],
      ['no Authorization header', speechRequest(speechBody)],
      ['empty Bearer', speechRequest(speechBody, { headers: { Authorization: 'Bearer ' } })],
      ['no Bearer prefix', speechRequest(speechBody, { headers: { Authorization: 's3cret-key' } })],
      ['lowercase bearer', speechRequest(speechBody, { headers: { Authorization: 'bearer s3cret-key' } })],
      ['Basic scheme', speechRequest(speechBody, { headers: { Authorization: 'Basic czNjcmV0' } })],
      ['prefix of key', speechRequest(speechBody, { key: 's3cret' })],
      ['key plus suffix', speechRequest(speechBody, { key: 's3cret-keyX' })],
    ];
    for (const [label, request] of cases) {
      const res = await worker.fetch(request, env, {});
      assert.equal(res.status, 401, label);
      const err = await errorBody(res);
      assert.equal(err.code, 'invalid_api_key', label);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', label);
    }
    // Not a single upstream call for any rejected request.
    assert.equal(mock.calls.token, 0);
    assert.equal(mock.calls.synth, 0);
  });
});

test('auth state 4b: API_KEY wins over ALLOW_ANONYMOUS=true (no free pass)', async () => {
  await withMock({}, async (mock) => {
    const env = { API_KEY: 's3cret-key', ALLOW_ANONYMOUS: 'true' };
    const res = await worker.fetch(speechRequest(speechBody), env, {});
    assert.equal(res.status, 401);
    assert.equal((await errorBody(res)).code, 'invalid_api_key');
    assert.equal(mock.calls.synth, 0);
    const ok = await worker.fetch(speechRequest(speechBody, { key: 's3cret-key' }), env, {});
    assert.equal(ok.status, 200);
  });
});

// ------------------------------------------------------------------ routing: UI

test('GET / serves the HTML UI without auth', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(req('/'), {}, {}); // env {} — would be 503 for API paths
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/html;charset=UTF-8');
    // Short TTL + revalidate so a deploy shows up within minutes instead of needing a
    // hard refresh (it used to be max-age=86400).
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300, must-revalidate');
    const html = await res.text();
    // ui/index.html opens with a newline before the doctype, so trim before matching.
    assert.ok(html.trimStart().startsWith('<!DOCTYPE'), 'body starts with <!DOCTYPE');
    assert.match(html, /<html lang="zh-Hans">/);
    assert.equal(html, UI, 'served bytes are exactly ui/index.html');
    assert.equal(mock.calls.token, 0);
  });
});

test('favicon is served before auth (no 401 in devtools) for .ico and .svg', async () => {
  await withMock({}, async (mock) => {
    for (const path of ['/favicon.ico', '/favicon.svg']) {
      // Even with an API_KEY bound, the browser's automatic favicon request must not 401.
      for (const env of [{}, { API_KEY: 's3cret-key' }]) {
        const res = await worker.fetch(req(path), env, {});
        assert.equal(res.status, 200, path + ' should bypass auth');
        assert.equal(res.headers.get('Content-Type'), 'image/svg+xml');
        const body = await res.text();
        assert.match(body, /^<svg /, 'serves an SVG');
      }
    }
    assert.equal(mock.calls.token, 0, 'favicon never touches upstream');
  });
});

test('GET /index.html serves the same HTML UI', async () => {
  await withMock({}, async () => {
    for (const path of ['/index.html', '/']) {
      const res = await worker.fetch(req(path), { API_KEY: 's3cret-key' }, {});
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('Content-Type'), 'text/html;charset=UTF-8', path);
      assert.ok((await res.text()).includes('<!DOCTYPE'), path);
    }
  });
});

// --------------------------------------------------------------- routing: models

test('GET /v1/models/public needs no auth (checked before the auth gate)', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(req('/v1/models/public'), {}, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const models = await res.json();
    assert.equal(models.length, VOICES.length);
    assert.equal(models.length, 322);
    assert.equal(mock.calls.voices, 1);
    const first = models[0];
    assert.equal(first.id, VOICES[0].ShortName);
    assert.equal(first.object, 'model');
    assert.equal(first.owned_by, 'microsoft');
    assert.equal(first.language, VOICES[0].Locale);
    assert.equal(first.gender, VOICES[0].Gender);
    // No auth was consulted, so no misconfiguration error was logged.
    assert.equal(mock.logs.filter((l) => l.level === 'error').length, 0);
  });
});

test('GET /v1/models/public is also reachable while API_KEY is set and no Bearer is sent', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(req('/v1/models/public'), { API_KEY: 's3cret-key' }, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).length, 322);
    assert.equal(mock.calls.voices, 1);
  });
});

test('GET /v1/models returns the mapped voice list (anonymous mode)', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(req('/v1/models'), { ALLOW_ANONYMOUS: 'true' }, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const models = await res.json();
    assert.equal(models.length, 322);
    assert.equal(mock.calls.voices, 1);
    assert.ok(models.some((m) => m.id === 'zh-CN-XiaoxiaoNeural'));
  });
});

test('GET /v1/models with a valid Bearer returns the list; without one it is 401', async () => {
  await withMock({}, async (mock) => {
    const env = { API_KEY: 's3cret-key' };
    const ok = await worker.fetch(
      req('/v1/models', { headers: { Authorization: 'Bearer s3cret-key' } }),
      env,
      {}
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).length, 322);
    assert.equal(mock.calls.voices, 1);

    // /v1/models sits *after* the auth gate (unlike /v1/models/public).
    const denied = await worker.fetch(req('/v1/models'), env, {});
    assert.equal(denied.status, 401);
    assert.equal((await errorBody(denied)).code, 'invalid_api_key');
    assert.equal(mock.calls.voices, 1, 'no extra upstream call for the denied request');

    const misconfigured = await worker.fetch(req('/v1/models'), {}, {});
    assert.equal(misconfigured.status, 503);
    assert.equal((await errorBody(misconfigured)).code, 'server_misconfigured');
    assert.equal(mock.calls.voices, 1);
  });
});

test('GET /v1/models?neural / ?multilingual filter by id substring', async () => {
  // Upstream sends FriendlyName, NOT LocalName — verified against the live endpoint:
  // 322/322 voices have no LocalName field. This fixture used to invent one, which is
  // why the production bug (every description read "undefined - Female") went unnoticed.
  const voices = [
    {
      ShortName: 'zh-CN-XiaoxiaoNeural',
      Locale: 'zh-CN',
      Gender: 'Female',
      FriendlyName: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)',
    },
    {
      ShortName: 'en-US-AvaMultilingualNeural',
      Locale: 'en-US',
      Gender: 'Female',
      FriendlyName: 'Microsoft AvaMultilingual Online (Natural) - English (United States)',
    },
    {
      ShortName: 'en-US-LegacyStandard',
      Locale: 'en-US',
      Gender: 'Male',
      FriendlyName: 'Microsoft Legacy Online (Natural) - English (United States)',
    },
  ];
  await withMock({ voices }, async (mock) => {
    const env = { ALLOW_ANONYMOUS: 'true' };
    const ids = async (path) => (await (await worker.fetch(req(path), env, {})).json()).map((m) => m.id);

    assert.deepEqual(await ids('/v1/models'), voices.map((v) => v.ShortName));
    assert.deepEqual(await ids('/v1/models?neural=true'), [
      'zh-CN-XiaoxiaoNeural',
      'en-US-AvaMultilingualNeural',
    ]);
    assert.deepEqual(await ids('/v1/models?neural=1'), [
      'zh-CN-XiaoxiaoNeural',
      'en-US-AvaMultilingualNeural',
    ]);
    assert.deepEqual(await ids('/v1/models?multilingual=true'), ['en-US-AvaMultilingualNeural']);
    assert.deepEqual(await ids('/v1/models?neural=true&multilingual=1'), [
      'en-US-AvaMultilingualNeural',
    ]);
    // Anything other than "true"/"1" is not a filter.
    assert.deepEqual(await ids('/v1/models?neural=false'), voices.map((v) => v.ShortName));
    assert.deepEqual(await ids('/v1/models?neural='), voices.map((v) => v.ShortName));
    // The voice list is cached in-process, so those 7 requests share ONE upstream
    // fetch. Filtering happens on the cached list, per request.
    assert.equal(mock.calls.voices, 1, '7 requests share a single cached upstream fetch');

    // description is "<voice name> - <Gender>", with the name extracted from FriendlyName
    // (the "Microsoft … Online (Natural) - <locale>" wrapper is dropped: locale and
    // gender are already separate fields).
    const models = await (await worker.fetch(req('/v1/models'), env, {})).json();
    assert.equal(models[0].description, 'Xiaoxiao - Female');
    assert.equal(models[2].description, 'Legacy - Male');
  });
});

test('GET /v1/models?neural=true keeps all 322 snapshot voices; multilingual narrows to 12', async () => {
  await withMock({}, async () => {
    const env = { ALLOW_ANONYMOUS: 'true' };
    const neural = await (await worker.fetch(req('/v1/models?neural=true'), env, {})).json();
    assert.equal(neural.length, 322);
    const multi = await (await worker.fetch(req('/v1/models?multilingual=true'), env, {})).json();
    assert.equal(multi.length, 12);
    assert.ok(multi.every((m) => m.id.includes('Multilingual')));
  });
});

// ------------------------------------------------------------- routing: OPTIONS

test('OPTIONS -> 204 with open CORS headers, no auth and no body', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(req('/v1/audio/speech', { method: 'OPTIONS' }), {}, {});
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
    assert.equal(res.headers.get('Access-Control-Max-Age'), '86400');
    // A preflight without Access-Control-Request-Headers must still advertise the
    // default allowed headers (Content-Type/Authorization), not the literal "null".
    assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization');
    assert.equal(await res.text(), '');
    assert.equal(mock.calls.token, 0);
  });
});

test('OPTIONS echoes Access-Control-Request-Headers, and precedes routing', async () => {
  await withMock({}, async () => {
    const res = await worker.fetch(
      req('/v1/audio/speech', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Headers': 'x-custom, content-type' },
      }),
      { API_KEY: 's3cret-key' },
      {}
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'x-custom, content-type');

    // Preflight on an unknown path is still 204 (handled before the route table).
    const unknown = await worker.fetch(req('/nope', { method: 'OPTIONS' }), {}, {});
    assert.equal(unknown.status, 204);
    assert.equal(unknown.headers.get('Access-Control-Allow-Origin'), '*');
  });
});

// ------------------------------------------------------------- routing: unknown

test('unknown path -> 404 not_found (after passing the auth gate)', async () => {
  await withMock({}, async (mock) => {
    for (const env of [{ ALLOW_ANONYMOUS: 'true' }, { API_KEY: 'k' }]) {
      const request = env.API_KEY
        ? req('/v1/nope', { headers: { Authorization: 'Bearer k' } })
        : req('/v1/nope');
      const res = await worker.fetch(request, env, {});
      assert.equal(res.status, 404);
      const err = await errorBody(res);
      assert.equal(err.code, 'not_found');
      assert.equal(err.message, '未找到');
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    }
    assert.equal(mock.calls.token, 0);
    assert.equal(mock.calls.voices, 0);
  });
});

test('unknown path is gated by auth first: 401 / 503 win over 404', async () => {
  await withMock({}, async () => {
    const denied = await worker.fetch(req('/totally/unknown'), { API_KEY: 'k' }, {});
    assert.equal(denied.status, 401);
    assert.equal((await errorBody(denied)).code, 'invalid_api_key');

    const misconfigured = await worker.fetch(req('/totally/unknown'), {}, {});
    assert.equal(misconfigured.status, 503);
    assert.equal((await errorBody(misconfigured)).code, 'server_misconfigured');
  });
});

test('GET /v1/audio/speech -> 405 method_not_allowed (routing reached, method rejected)', async () => {
  await withMock({}, async (mock) => {
    const res = await worker.fetch(req('/v1/audio/speech'), { ALLOW_ANONYMOUS: 'true' }, {});
    assert.equal(res.status, 405);
    assert.equal((await errorBody(res)).code, 'method_not_allowed');
    assert.equal(mock.calls.synth, 0);
  });
});
