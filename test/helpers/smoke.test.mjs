// Validates the mock harness itself against the real Worker handler.
// If this passes, the fanned-out integration/regression suites can rely on the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest } from './mock-upstream.mjs';

test('harness: anonymous synth returns audio via mock upstream', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'hello', voice: 'en-US-AvaNeural' }),
      { ALLOW_ANONYMOUS: 'true' },
      {}
    );
    assert.equal(res.status, 200);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.ok(buf.byteLength > 0, 'got audio bytes');
    assert.equal(mock.calls.token, 1, 'fetched token once');
    assert.ok(mock.calls.synth >= 1, 'called synthesis');
  } finally {
    mock.restore();
  }
});

test('harness: token is reused across requests (cached)', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const env = { ALLOW_ANONYMOUS: 'true' };
    await worker.fetch(speechRequest({ input: 'a', voice: 'en-US-AvaNeural' }), env, {});
    await worker.fetch(speechRequest({ input: 'b', voice: 'en-US-AvaNeural' }), env, {});
    assert.equal(mock.calls.token, 1, 'token fetched once and cached across 2 requests');
  } finally {
    mock.restore();
  }
});
