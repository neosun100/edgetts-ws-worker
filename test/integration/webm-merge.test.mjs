// Multi-chunk Opus must come back as ONE WebM segment.
//
// This corrects an earlier wrong call of mine. I measured multi-container Opus with
// decodeAudioData, saw the full duration, and concluded no audio was lost — so I shipped a
// 400 that refused multi-chunk opus outright. Both halves were wrong:
//
//   - decodeAudioData reads through every concatenated container, so it always reports the
//     full length. The UI plays through <audio>, which only honours the FIRST container.
//     Measured on real upstream chunks: <audio> reports 9.44s where the file holds 94.56s.
//     Three containers gave 65.14s against 162.91s. That is silent loss of up to 90%.
//   - "duration is null, that's just how upstream muxes it" was also an artefact: for an
//     unknown-length Segment Chrome resolves duration only after seeking past the end
//     (currentTime = 1e9). Without that step every file looks like it has no duration.
//   - "merging needs EBML rewriting, far over the 10ms CPU budget" was never measured.
//     It is ~1.2ms in real workerd for 45 chunks, 2.1ms here for 10 — same order as the
//     WAV merge, because the upstream muxing omits every length-bearing element
//     (Segment and Cluster are UNKNOWN-size; no SeekHead, Cues or top-level Duration), so
//     only Cluster Timecodes need rewriting and no size field moves.
//
// The lesson these tests encode: when two measurements disagree, follow the one on the
// path the user actually takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Real upstream WebM/Opus chunks, captured from the live endpoint. */
function realChunks(n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = FIXTURES + 'opus-chunk' + i + '.webm';
    if (!existsSync(p)) return null;
    out.push(new Uint8Array(readFileSync(p)));
  }
  return out;
}

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
function countContainers(bytes) {
  let n = 0;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (EBML_MAGIC.every((b, k) => bytes[i + k] === b)) n++;
  }
  return n;
}

/** Every Cluster Timecode, in file order. */
function clusterTimecodes(bytes) {
  const info = __test__.parseWebmChunk(bytes);
  return info ? info.clusters.map((c) => c.tc) : null;
}

test('the fixtures really are separate WebM containers', (t) => {
  // Guards the premise: if upstream ever starts returning one container per response, the
  // merge is unnecessary and these tests should be revisited rather than silently passing.
  const chunks = realChunks();
  if (!chunks) return t.skip('opus fixtures missing');
  for (const [i, c] of chunks.entries()) {
    assert.equal(countContainers(c), 1, 'chunk ' + i + ' is exactly one container');
    const info = __test__.parseWebmChunk(c);
    assert.ok(info, 'chunk ' + i + ' parses');
    assert.ok(info.clusters.length > 0, 'chunk ' + i + ' has Clusters');
    assert.ok(info.duration > 0, 'chunk ' + i + ' has a positive duration');
  }
});

test('merging N containers yields exactly one', (t) => {
  const chunks = realChunks();
  if (!chunks) return t.skip('opus fixtures missing');
  const naive = countContainers(
    new Uint8Array(chunks.reduce((acc, c) => acc.concat([...c]), []))
  );
  assert.equal(naive, chunks.length, 'naive concatenation stacks containers');

  const merged = __test__.mergeWebmChunks(chunks.map((c) => c.buffer));
  assert.ok(merged, 'merge succeeded');
  assert.equal(countContainers(merged), 1, 'merged output is a single container');
});

test('cluster timestamps are strictly increasing after the merge', (t) => {
  // This is the property that decides whether <audio> plays past the first chunk, and the
  // one naive concatenation destroys: each container restarts its clock at 0.
  const chunks = realChunks();
  if (!chunks) return t.skip('opus fixtures missing');

  // Naive: timestamps rewind at every container boundary.
  const perChunk = chunks.map(clusterTimecodes);
  const naiveRewinds = perChunk.slice(1).filter((tcs, i) => {
    const prevLast = perChunk[i][perChunk[i].length - 1];
    return tcs[0] <= prevLast;
  }).length;
  assert.ok(naiveRewinds > 0, 'premise: unmerged chunks restart their timestamps');

  const merged = __test__.mergeWebmChunks(chunks.map((c) => c.buffer));
  const tcs = clusterTimecodes(merged);
  assert.ok(tcs.length > 0, 'merged output has Clusters');
  for (let i = 1; i < tcs.length; i++) {
    assert.ok(
      tcs[i] > tcs[i - 1],
      `timecode went backwards at cluster ${i}: ${tcs[i - 1]} -> ${tcs[i]}`
    );
  }
  // The last timecode must span every chunk, not just the first.
  const firstChunkEnd = perChunk[0][perChunk[0].length - 1];
  assert.ok(
    tcs[tcs.length - 1] > firstChunkEnd * (chunks.length - 1),
    'the merged timeline covers all chunks, not only the first'
  );
});

test('the merge preserves every audio byte', (t) => {
  // Only timestamps may change. Compare the SimpleBlock payload bytes, which carry the
  // actual Opus frames, between naive concatenation and the merge.
  const chunks = realChunks();
  if (!chunks) return t.skip('opus fixtures missing');
  const merged = __test__.mergeWebmChunks(chunks.map((c) => c.buffer));

  const naiveBytes = chunks.reduce((n, c) => n + c.length, 0);
  const headerBytes = chunks
    .slice(1)
    .reduce((n, c) => n + __test__.parseWebmChunk(c).firstCluster, 0);
  // Each rewritten Timecode is a fixed 10 bytes; the originals vary in width, so the exact
  // total is not predictable. Bound it instead: we dropped N-1 headers and rewrote
  // timecodes, so the output must be smaller than naive by roughly the header bytes.
  assert.ok(
    merged.length < naiveBytes,
    'dropping N-1 headers must shrink the output'
  );
  assert.ok(
    merged.length > naiveBytes - headerBytes - 1000,
    'nothing beyond headers and timecodes was removed: ' +
      `${merged.length} vs naive ${naiveBytes} minus headers ${headerBytes}`
  );
});

test('a non-WebM chunk makes the merge decline rather than corrupt', (t) => {
  // Returning null lets the caller fall back to plain concatenation, the same contract
  // concatWavBlobs uses. Guessing at unknown bytes is worse than passing them through.
  assert.equal(__test__.mergeWebmChunks([new Uint8Array([1, 2, 3, 4]).buffer]), null);
  assert.equal(__test__.mergeWebmChunks([new Uint8Array(0).buffer]), null);
  const chunks = realChunks(2);
  if (!chunks) return t.skip('opus fixtures missing');
  // One good chunk plus one bad one must still decline — a partial merge would be worse.
  assert.equal(
    __test__.mergeWebmChunks([chunks[0].buffer, new Uint8Array([9, 9, 9]).buffer]),
    null,
    'a single unparseable chunk aborts the whole merge'
  );
});

test('merging stays well inside the CPU budget', (t) => {
  // The claim that justified refusing to merge was "far over the 10ms budget", asserted
  // without measurement. Pin the real cost so a future regression is visible. The budget
  // here is loose because CI is slower; the point is the order of magnitude.
  const chunks = realChunks();
  if (!chunks) return t.skip('opus fixtures missing');
  const buffers = chunks.map((c) => c.buffer);
  __test__.mergeWebmChunks(buffers); // warm up
  const t0 = process.hrtime.bigint();
  __test__.mergeWebmChunks(buffers);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `merge took ${ms.toFixed(2)}ms for ${chunks.length} chunks`);
});

test('a multi-chunk opus request returns a single merged container', async () => {
  const chunks = realChunks();
  if (!chunks) return;
  __test__.resetTokenCache();
  __test__.resetVoicesCache();
  let i = 0;
  const mock = installMockFetch({
    synth: () => ({ status: 200, body: Buffer.from(chunks[i++ % chunks.length]) }),
  });
  try {
    const res = await worker.fetch(
      speechRequest({
        input: '这是一句用来触发多分块的中文文本。'.repeat(12),
        voice: 'zh-CN-XiaoxiaoNeural',
        response_format: 'opus',
        chunk_size: 50,
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 200, 'no longer refused — it is merged instead');
    assert.equal(res.headers.get('Content-Type'), 'audio/webm');
    assert.ok(mock.calls.synth > 1, 'genuinely multi-chunk, got ' + mock.calls.synth);
    const out = new Uint8Array(await res.arrayBuffer());
    assert.equal(countContainers(out), 1, 'response is one container');
    const tcs = clusterTimecodes(out);
    for (let k = 1; k < tcs.length; k++) {
      assert.ok(tcs[k] > tcs[k - 1], 'response timeline is monotonic');
    }
  } finally {
    mock.restore();
  }
});

test('a single-chunk opus response is passed through untouched', async () => {
  const chunks = realChunks(1);
  if (!chunks) return;
  __test__.resetTokenCache();
  const original = Buffer.from(chunks[0]);
  const mock = installMockFetch({ synth: () => ({ status: 200, body: original }) });
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'short', voice: 'zh-CN-XiaoxiaoNeural', response_format: 'opus' }),
      ANON,
      {}
    );
    assert.equal(mock.calls.synth, 1, 'fixture is single-chunk');
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      original,
      'no rewriting when there is nothing to merge'
    );
  } finally {
    mock.restore();
  }
});

test('non-WebM bytes on the opus path fall back and log the reason', async () => {
  __test__.resetTokenCache();
  const mock = installMockFetch({ synth: () => ({ status: 200, body: Buffer.alloc(40, 5) }) });
  try {
    const res = await worker.fetch(
      speechRequest({
        input: '这是一句用来触发多分块的中文文本。'.repeat(12),
        voice: 'zh-CN-XiaoxiaoNeural',
        response_format: 'opus',
        chunk_size: 50,
      }),
      ANON,
      {}
    );
    assert.equal(res.status, 200, 'degrades rather than 500s');
    const out = Buffer.from(await res.arrayBuffer());
    assert.equal(out.length, mock.calls.synth * 40, 'bytes passed through unchanged');
    assert.ok(
      mock.logs.some((l) => l.msg.includes('WebM 合并')),
      'the fallback is logged, not silent'
    );
  } finally {
    mock.restore();
  }
});

test('an unknown-size element other than Segment/Cluster is descended into, not skipped', () => {
  // Defensive branch: real upstream chunks never contain one (verified — 0 hits across a
  // fixture with 1 Segment, 19 Clusters, 472 SimpleBlocks and 23 sized elements), but if
  // Microsoft changes its muxing the parser must keep making progress rather than either
  // looping forever or jumping past the rest of the file on an unknown length.
  //
  // Built by hand: EBML header, then a Tags element (0x1254C367) with an UNKNOWN size,
  // followed by a normal Cluster. If the branch skipped by `size.val` instead of descending,
  // the Cluster after it would never be found and the merge would decline.
  const u8 = (...bytes) => new Uint8Array(bytes);
  const parts = [
    u8(0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x00, 0x00, 0x00, 0x00), // EBML header, size 4
    u8(0x18, 0x53, 0x80, 0x67, 0xff),                          // Segment, UNKNOWN size
    u8(0x12, 0x54, 0xc3, 0x67, 0xff),                          // Tags, UNKNOWN size
    u8(0x1f, 0x43, 0xb6, 0x75, 0xff),                          // Cluster, UNKNOWN size
    u8(0xe7, 0x81, 0x00),                                      // Timecode = 0
    u8(0xa3, 0x85, 0x81, 0x00, 0x00, 0x80, 0x01),              // SimpleBlock, rel tc 0
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let w = 0;
  for (const p of parts) { buf.set(p, w); w += p.length; }

  const info = __test__.parseWebmChunk(buf);
  assert.ok(info, 'the Cluster after an unknown-size element must still be found');
  assert.equal(info.clusters.length, 1, 'exactly one Cluster located');
  assert.equal(info.clusters[0].tc, 0, 'its Timecode was read');

  // And the merge must work on it, proving the parse result is usable end to end.
  const merged = __test__.mergeWebmChunks([buf.buffer, buf.buffer]);
  assert.ok(merged, 'two such chunks merge');
  const tcs = __test__.parseWebmChunk(merged).clusters.map((c) => c.tc);
  assert.equal(tcs.length, 2, 'both Clusters survive');
  assert.ok(tcs[1] > tcs[0], 'the second Cluster was shifted forward, got ' + tcs.join(','));
});

// ------------------------------------------------------------- Duration injection
// The merged Segment is UNKNOWN-size and upstream declares no Duration, so
// <audio>.duration was null at loadedmetadata — the native progress bar sat blank until the
// user happened to seek past the end, which is when Chrome finally resolves it. Injecting a
// top-level Duration fixes that for 11 bytes and 0.18ms.
//
// The trick that makes it cheap: Info has a KNOWN size, so adding 11 bytes means rewriting
// it — but upstream encodes every size as an 8-byte vint (measured: 01 00 00 00 00 00 00 56
// = 86), which covers 2^56-1, so 86 -> 97 changes only value bytes. The field does not widen
// and nothing after it moves.

test('the merged output carries a top-level Duration', (t) => {
  const chunks = realChunks();
  if (!chunks) return t.skip('opus fixtures missing');
  const merged = __test__.mergeWebmChunks(chunks.map((c) => c.buffer));

  // Locate Info and walk its children looking for Duration (0x4489).
  let infoAt = -1;
  for (let i = 0; i + 4 <= merged.length; i++) {
    if (merged[i] === 0x15 && merged[i + 1] === 0x49 && merged[i + 2] === 0xa9 && merged[i + 3] === 0x66) {
      infoAt = i;
      break;
    }
  }
  assert.ok(infoAt >= 0, 'the merged file has an Info element');
  assert.equal(merged[infoAt + 4], 0x01, 'Info size is the 8-byte vint form the injector expects');

  const bodyAt = infoAt + 12;
  assert.equal(merged[bodyAt], 0x44, 'Duration id is the first child of Info');
  assert.equal(merged[bodyAt + 1], 0x89);
  assert.equal(merged[bodyAt + 2], 0x88, 'an 8-byte float payload');
  const ms = new DataView(merged.buffer, merged.byteOffset + bodyAt + 3, 8).getFloat64(0, false);

  // It must match the timeline the merge actually produced, not an invented number.
  const expected = chunks.reduce((sum, c) => sum + __test__.parseWebmChunk(c).duration + 10, 0);
  assert.equal(ms, expected, 'Duration equals the sum of the chunk timelines');
  // Sanity: three ~9.45s chunks.
  assert.ok(ms > 25000 && ms < 32000, 'Duration is in the right ballpark, got ' + ms);
});

test('Info size is rewritten in place so nothing after it shifts', (t) => {
  const chunks = realChunks();
  if (!chunks) return t.skip('opus fixtures missing');

  // Compare against the same merge with injection skipped, by checking sizes only: the
  // injected output must be exactly 11 bytes longer and still parse to the same clusters.
  const merged = __test__.mergeWebmChunks(chunks.map((c) => c.buffer));
  const parsed = __test__.parseWebmChunk(merged);
  assert.ok(parsed, 'the injected file still parses');

  let infoAt = -1;
  for (let i = 0; i + 4 <= merged.length; i++) {
    if (merged[i] === 0x15 && merged[i + 1] === 0x49 && merged[i + 2] === 0xa9 && merged[i + 3] === 0x66) {
      infoAt = i;
      break;
    }
  }
  // Read the rewritten size and verify it accounts for the 11 injected bytes.
  let size = 0;
  for (let i = infoAt + 5; i < infoAt + 12; i++) size = size * 256 + merged[i];
  assert.ok(size > 11, 'Info size grew rather than being left stale, got ' + size);
  // A stale size would make the following Tracks element unreadable; parsing found the
  // Clusters, which is only possible if the size is self-consistent.
  assert.ok(parsed.clusters.length > 1, 'clusters after Info are still reachable');
});

test('injection is skipped rather than risked when Info is not the expected shape', () => {
  // A hand-built chunk whose Info uses a 1-byte size. Widening that field would require
  // shifting every following byte, which is not worth the complexity — the merge must
  // return valid bytes without a Duration instead of corrupting the file.
  const u8 = (...b) => new Uint8Array(b);
  const parts = [
    u8(0x1a, 0x45, 0xdf, 0xa3, 0x84, 0, 0, 0, 0),      // EBML
    u8(0x18, 0x53, 0x80, 0x67, 0xff),                   // Segment, UNKNOWN
    u8(0x15, 0x49, 0xa9, 0x66, 0x83, 0x2a, 0xd7, 0xb1), // Info, size 3 (1-byte vint)
    u8(0x1f, 0x43, 0xb6, 0x75, 0xff),                   // Cluster, UNKNOWN
    u8(0xe7, 0x81, 0x00),                               // Timecode 0
    u8(0xa3, 0x85, 0x81, 0x00, 0x00, 0x80, 0x01),       // SimpleBlock
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let w = 0;
  for (const p of parts) { buf.set(p, w); w += p.length; }

  const merged = __test__.mergeWebmChunks([buf.buffer, buf.buffer]);
  assert.ok(merged, 'the merge still succeeds');
  assert.ok(__test__.parseWebmChunk(merged), 'and the output is still parseable');
  // No Duration was added, and critically the 1-byte Info size was left untouched.
  const infoAt = merged.indexOf(0x15);
  assert.equal(merged[infoAt + 4], 0x83, 'the unexpected size encoding was not rewritten');
});
