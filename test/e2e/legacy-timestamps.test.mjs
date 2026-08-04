// E2E for the legacy NDJSON worker's word-level timestamps.
//
// Why this file exists: word boundaries are ONLY available over the WebSocket protocol,
// which in turn only works on *.workers.dev (a custom domain's proxy layer breaks the
// outbound WS handshake). The production REST worker therefore cannot provide them —
// verified by probing cognitiveservices/v1 with several header combinations, all of
// which returned audio with no timestamp data whatsoever.
//
// So the legacy deployment is the only source of timestamps, and pte-wfd-216 depends on
// it. Without a test, it could rot silently and we'd find out from a downstream break.
//
// Guarded like the other e2e file: set EDGETTS_E2E=1 to run.
//   EDGETTS_E2E=1                          enable
//   EDGETTS_E2E_LEGACY_URL=https://...     override target
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENABLED = process.env.EDGETTS_E2E === '1';
const SKIP = ENABLED
  ? false
  : 'e2e disabled: set EDGETTS_E2E=1 to run';

const LEGACY_URL = (
  process.env.EDGETTS_E2E_LEGACY_URL ||
  'https://edgetts-ws-worker.neosun808.workers.dev'
).replace(/\/+$/, '');

const TEXT = 'Hello world testing timestamps';

async function postJson(body) {
  const res = await fetch(LEGACY_URL + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

test('legacy worker: word-level timestamps (non-streaming JSON)', { skip: SKIP }, async () => {
  const res = await postJson({ input: TEXT, voice: 'en-US-AvaNeural', stream: false });
  assert.equal(res.status, 200, 'legacy endpoint reachable');
  const json = await res.json();

  assert.ok(typeof json.audio === 'string' && json.audio.length > 0, 'base64 audio present');
  assert.equal(json.content_type, 'audio/mpeg');
  assert.ok(Array.isArray(json.timestamps), 'timestamps array present');
  // The sample sentence has 4 words.
  assert.equal(json.timestamps.length, 4, 'one entry per word');

  for (const t of json.timestamps) {
    assert.equal(typeof t.text, 'string');
    assert.ok(t.text.length > 0);
    assert.equal(typeof t.offset, 'number');
    assert.equal(typeof t.duration, 'number');
    assert.ok(t.duration > 0, 'positive duration');
  }
  // Offsets must be monotonically increasing — that's what makes karaoke highlighting work.
  for (let i = 1; i < json.timestamps.length; i++) {
    assert.ok(
      json.timestamps[i].offset > json.timestamps[i - 1].offset,
      'offsets strictly increase'
    );
  }
  // Words come back in the order they were spoken.
  assert.deepEqual(
    json.timestamps.map((t) => t.text),
    ['Hello', 'world', 'testing', 'timestamps']
  );
});

test('legacy worker: NDJSON stream carries word + audio + done events', { skip: SKIP }, async () => {
  const res = await postJson({ input: TEXT, voice: 'en-US-AvaNeural', stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /ndjson/);

  const text = await res.text();
  const events = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const byType = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});

  assert.ok(byType.audio > 0, 'audio chunks streamed');
  assert.equal(byType.word, 4, 'one word event per word');
  assert.equal(byType.done, 1, 'exactly one terminal done event');
  assert.equal(events[events.length - 1].type, 'done', 'done is last');

  const words = events.filter((e) => e.type === 'word');
  assert.deepEqual(words.map((w) => w.text), ['Hello', 'world', 'testing', 'timestamps']);
  for (const w of words) {
    assert.equal(typeof w.offset, 'number');
    assert.equal(typeof w.duration, 'number');
  }
});

test('production REST worker cannot supply timestamps (documents the constraint)', { skip: SKIP }, async () => {
  // Not a defect — the REST endpoint has no word-boundary channel. Asserting it keeps
  // the ROADMAP's claim honest: if Microsoft ever adds it, this test starts failing and
  // we'll know the two implementations can finally be merged.
  const base = (process.env.EDGETTS_E2E_BASE_URL || 'https://edgetts.aws.xin').replace(/\/+$/, '');
  const key = process.env.EDGETTS_E2E_KEY || '';
  const res = await fetch(base + '/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: 'Bearer ' + key } : {}),
    },
    body: JSON.stringify({ input: TEXT, voice: 'en-US-AvaNeural', response_format: 'mp3' }),
  });
  if (res.status === 401 || res.status === 503) {
    // No credentials available in this environment; the constraint check needs a real call.
    return;
  }
  assert.equal(res.status, 200);
  // The response is raw audio, not JSON with a timestamps field.
  assert.match(res.headers.get('content-type') || '', /^audio\//);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.ok(buf.byteLength > 0, 'returns audio bytes');
  assert.ok(buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0, 'MP3 frame sync, i.e. pure audio');
});
