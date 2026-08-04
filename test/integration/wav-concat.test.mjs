// Multi-chunk WAV must come back as ONE valid RIFF file.
//
// Found by audit: getVoice concatenated the per-chunk blobs with `new Blob([...])`,
// which is correct for mp3 (self-synchronising frames) and pcm (headerless) but wrong
// for WAV. N chunks produced N complete RIFF files back to back; a player reads the
// first header's data length and stops, silently discarding the rest. With the default
// chunk_size of 300 this triggers at roughly 300 characters of input, and the response
// is a 200 with a technically valid WAV — indistinguishable from a correct result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };

/** A minimal but valid 24kHz/16-bit/mono WAV with `payload` bytes of data. */
function makeWav(payloadBytes, { fill = 7, extraChunk = false } = {}) {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(24000, 12);
  fmt.writeUInt32LE(48000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  // Some encoders insert extra chunks (LIST/fact) before `data`, so the header is not
  // always 44 bytes — the parser must walk the chunk list rather than assume.
  let extra = Buffer.alloc(0);
  if (extraChunk) {
    extra = Buffer.alloc(8 + 4);
    extra.write('fact', 0);
    extra.writeUInt32LE(4, 4);
    extra.writeUInt32LE(payloadBytes / 2, 8);
  }

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0);
  dataHeader.writeUInt32LE(payloadBytes, 4);

  const body = Buffer.alloc(payloadBytes, fill);
  const rest = Buffer.concat([Buffer.from('WAVE'), fmt, extra, dataHeader, body]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(rest.length, 4);
  return Buffer.concat([riff, rest]);
}

function countRiff(buf) {
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf('RIFF', i)) !== -1) {
    n++;
    i += 4;
  }
  return n;
}

/** Input long enough to split into several chunks at chunk_size=50. */
const MULTI = Array.from(
  { length: 6 },
  (_, i) => 'This is sentence number ' + (i + 1) + ' and it is long enough.'
).join(' ');

async function synthWav(opts, body = {}) {
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  const mock = installMockFetch(opts);
  try {
    const res = await worker.fetch(
      speechRequest({
        input: MULTI,
        voice: 'en-US-AvaNeural',
        response_format: 'wav',
        chunk_size: 50,
        ...body,
      }),
      ANON,
      {}
    );
    return { res, buf: Buffer.from(await res.arrayBuffer()), mock };
  } finally {
    mock.restore();
  }
}

test('a multi-chunk WAV response contains exactly one RIFF header', async () => {
  const { res, buf, mock } = await synthWav({ synth: () => ({ status: 200, body: makeWav(100) }) });
  assert.equal(res.status, 200);
  assert.ok(mock.calls.synth > 1, 'the fixture really did split into chunks, got ' + mock.calls.synth);
  assert.equal(countRiff(buf), 1, 'concatenating whole RIFF files truncates playback');

  // The two length fields must describe the merged file, or players still stop early.
  const dataOffset = buf.indexOf('data');
  assert.equal(buf.readUInt32LE(4), buf.length - 8, 'RIFF size covers the whole file');
  assert.equal(
    buf.readUInt32LE(dataOffset + 4),
    mock.calls.synth * 100,
    'data size is the sum of every chunk payload'
  );
  assert.equal(buf.length, dataOffset + 8 + mock.calls.synth * 100, 'no bytes lost or duplicated');
});

test('every chunk payload survives the merge, in order', async () => {
  // Give each chunk a distinct fill byte so a dropped or reordered chunk is visible.
  let n = 0;
  const { buf, mock } = await synthWav({
    synth: () => ({ status: 200, body: makeWav(20, { fill: ++n }) }),
  });
  const dataStart = buf.indexOf('data') + 8;
  const payload = buf.subarray(dataStart);
  assert.equal(payload.length, mock.calls.synth * 20);
  for (let i = 0; i < mock.calls.synth; i++) {
    const slice = payload.subarray(i * 20, (i + 1) * 20);
    assert.ok(
      slice.every((b) => b === slice[0]),
      'chunk ' + i + ' payload is not contiguous'
    );
  }
  // Fill bytes are assigned in request order; the writes must be ordered the same way.
  const fills = Array.from({ length: mock.calls.synth }, (_, i) => payload[i * 20]);
  assert.deepEqual(fills, [...fills].sort((a, b) => a - b), 'chunks were written out of order');
});

test('a header longer than 44 bytes is handled (extra RIFF chunks are not assumed away)', async () => {
  const { buf } = await synthWav({
    synth: () => ({ status: 200, body: makeWav(64, { extraChunk: true }) }),
  });
  assert.equal(countRiff(buf), 1);
  // The `fact` chunk sits before `data`, so a hardcoded 44-byte header would have
  // treated it as audio and mangled the output.
  assert.ok(buf.includes('fact'), 'the first chunk header is preserved verbatim');
  const dataOffset = buf.indexOf('data');
  assert.ok(dataOffset > 44, 'this fixture genuinely has an over-44-byte header');
  assert.equal(buf.readUInt32LE(4), buf.length - 8);
});

test('a single-chunk WAV is passed through untouched', async () => {
  const original = makeWav(80);
  __test__.resetTokenCache();
  const mock = installMockFetch({ synth: () => ({ status: 200, body: original }) });
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'short', voice: 'en-US-AvaNeural', response_format: 'wav' }),
      ANON,
      {}
    );
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(mock.calls.synth, 1, 'fixture is a single chunk');
    assert.deepEqual(buf, original, 'no rewriting when there is nothing to merge');
  } finally {
    mock.restore();
  }
});

test('non-WAV chunks fall back to plain concatenation and say so in the log', async () => {
  // If upstream stops returning RIFF, guessing is worse than passing bytes through —
  // but the degradation must be visible in the log rather than silent.
  const { res, buf, mock } = await synthWav({
    synth: () => ({ status: 200, body: Buffer.alloc(50, 3) }),
  });
  assert.equal(res.status, 200);
  assert.equal(buf.length, mock.calls.synth * 50, 'bytes are passed through unchanged');
  assert.ok(
    mock.logs.some((l) => l.msg.includes('WAV 合并')),
    'the fallback is logged'
  );
});

test('a RIFF/WAVE chunk with no data section also falls back rather than throwing', async () => {
  // Distinct from the "not a WAV at all" case above: the magic numbers are correct, so
  // the parser walks the chunk list and finds no `data`. It must degrade visibly instead
  // of dereferencing a null offset.
  const headerOnly = Buffer.concat([
    Buffer.from('RIFF'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(12, 0); return b; })(),
    Buffer.from('WAVE'),
    Buffer.from('fmt '),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b; })(),
  ]);
  const { res, buf, mock } = await synthWav({ synth: () => ({ status: 200, body: headerOnly }) });
  assert.equal(res.status, 200, 'a malformed chunk must not become a 500');
  assert.equal(buf.length, mock.calls.synth * headerOnly.length, 'passed through unchanged');
  assert.ok(
    mock.logs.some((l) => l.msg.includes('找不到 data 块')),
    'the specific reason for the fallback is logged'
  );
});

test('mp3 and pcm are still concatenated as raw bytes', async () => {
  // The fix must be scoped to WAV: mp3 frames are self-synchronising and pcm has no
  // header, so rewriting them would be wrong.
  for (const format of ['mp3', 'pcm']) {
    const { buf, mock } = await synthWav(
      { synth: () => ({ status: 200, body: Buffer.alloc(30, 9) }) },
      { response_format: format }
    );
    assert.equal(
      buf.length,
      mock.calls.synth * 30,
      format + ' must be a straight byte concatenation'
    );
  }
});

// ----------------------------------------------------------------- opus / WebM
// Opus goes through the same concatenation path as WAV and is broken in the same way, but
// it took a wrong turn first: measuring with decodeAudioData suggested no audio was lost,
// so multi-chunk opus was refused with a 400. It is actually merged now — the detail, and
// the corrected measurements, live in test/integration/webm-merge.test.mjs. What remains
// here is the format-scoping: opus must not disturb mp3/pcm/wav.

const MULTI_CHUNK_TEXT = '这是一句用来触发多分块的中文文本。'.repeat(12); // 204 chars


test('single-chunk opus needs no merging and is returned as-is', async () => {
  // A single container is already correct; the merge path must not run at all.
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({
        input: MULTI_CHUNK_TEXT,
        voice: 'zh-CN-XiaoxiaoNeural',
        response_format: 'opus',
        chunk_size: 2000,
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/webm');
    assert.equal(mock.calls.synth, 1, 'exactly one container, so no concatenation');
  } finally {
    mock.restore();
  }
});

test('opus handling does not leak into the other formats', async () => {
  // mp3 frames are self-synchronising, pcm is headerless, and wav has its own merge —
  // none of them may be routed through the WebM path.
  for (const format of ['mp3', 'wav', 'pcm']) {
    __test__.resetTokenCache();
    const mock = installMockFetch();
    try {
      const res = await worker.fetch(
        speechRequest({
          input: MULTI_CHUNK_TEXT,
          voice: 'zh-CN-XiaoxiaoNeural',
          response_format: format,
          chunk_size: 50,
        }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, format + ' must still accept multi-chunk input');
      assert.ok(mock.calls.synth > 1, format + ' really was multi-chunk, got ' + mock.calls.synth);
    } finally {
      mock.restore();
    }
  }
});


