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
