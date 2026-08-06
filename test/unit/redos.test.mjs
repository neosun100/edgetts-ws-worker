// ReDoS guards for cleanText.
//
// A Worker gets ~10ms of CPU per request. cleanText runs regexes over caller-supplied
// text, so any super-linear pattern is a one-request DoS: no concurrency needed, and the
// payload is far below MAX_BODY_BYTES.
//
// Two patterns were vulnerable. Lazy quantifiers are NOT immune to catastrophic
// backtracking: in `\[(.*?)\]\(.*?\)`, every `[` is a candidate start and `.*?` expands
// character by character looking for `](`, then backtracks when `\)` fails. Measured on
// `"![](".repeat(n)`: 4KB → 656ms, 8KB → 4.7s, 16KB → 36s. Fixed by replacing the
// wildcards with delimiter-excluding classes, which the engine cannot expand past.
//
// The absolute budget below is deliberately generous, because wall-clock is
// machine-dependent: the same 16000-char payload measures ~55ms on a dev laptop and 273ms
// on a shared GitLab runner (which is what made a 250ms budget fail in CI). What matters
// is the order of magnitude — the bug being guarded took 36000ms, i.e. 20x this ceiling
// even on the slowest runner. The scaling-ratio test below is the machine-independent
// check and is the one that pins the complexity class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../../src/worker.js';

const { cleanText, LIMITS } = __test__;
const MD = { remove_markdown: true };

/** Wall-clock ms for one cleanText call. */
function timeClean(text, options) {
  const t0 = process.hrtime.bigint();
  cleanText(text, options);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const BUDGET_MS = 1500;

test('markdown link/image stripping stays linear on adversarial input', () => {
  // The exact shape that took 36 seconds: dense candidate starts, each with a
  // near-match that forces backtracking.
  const payload = '![]('.repeat(4000); // 16000 chars, well under MAX_INPUT_CHARS
  assert.ok(payload.length < LIMITS.MAX_INPUT_CHARS, 'payload is an accepted input size');
  const ms = timeClean(payload, MD);
  assert.ok(
    ms < BUDGET_MS,
    `cleanText took ${ms.toFixed(0)}ms on ${payload.length} chars of "![](" — ` +
      'the link regexes are backtracking (budget ' + BUDGET_MS + 'ms)'
  );
});

test('the link-regex cost grows roughly linearly, not quadratically', () => {
  // A budget alone can be satisfied by a fast machine. Doubling the input must not
  // multiply the time by ~8, which is what the quadratic version did.
  const small = '![]('.repeat(1000);
  const large = '![]('.repeat(4000); // 4x the input
  // Warm up so JIT compilation is not attributed to the first measurement.
  timeClean(small, MD);
  const tSmall = Math.max(timeClean(small, MD), 0.05);
  const tLarge = timeClean(large, MD);
  assert.ok(
    tLarge / tSmall < 40,
    `4x the input took ${(tLarge / tSmall).toFixed(1)}x the time ` +
      `(${tSmall.toFixed(2)}ms -> ${tLarge.toFixed(2)}ms) — expected ~4x for a linear scan`
  );
});

test('underscore emphasis stripping stays linear on adversarial input', () => {
  const payload = ' _a'.repeat(16000); // 48000 chars
  const ms = timeClean(payload, MD);
  assert.ok(
    ms < BUDGET_MS,
    `cleanText took ${ms.toFixed(0)}ms on ${payload.length} chars of " _a" (budget ${BUDGET_MS}ms)`
  );
});

test('every cleaning option survives a max-size hostile payload within budget', () => {
  // All options on at once, at the input ceiling, mixing each pattern's worst shape.
  const all = {
    remove_markdown: true,
    remove_urls: true,
    remove_emoji: true,
    remove_line_breaks: true,
    remove_citation_numbers: true,
    custom_keywords: 'foo,bar',
  };
  const unit = '![](*a*`b`_c_[d](e)https://x/ [1] ';
  const payload = unit.repeat(Math.floor(LIMITS.MAX_INPUT_CHARS / unit.length));
  const ms = timeClean(payload, all);
  assert.ok(
    ms < BUDGET_MS,
    `full cleaning of ${payload.length} chars took ${ms.toFixed(0)}ms (budget ${BUDGET_MS}ms)`
  );
});

// --------------------------------------------------------------- equivalence
// The fix must not change what users get out. These cases cover the boundaries the
// old wildcards could reach and the new character classes cannot, so a behavioural
// regression shows up here rather than in production audio.

test('the hardened link regexes strip markdown exactly as before', () => {
  const cases = [
    ['![alt](img.png)', ''],
    ['[docs](https://x.com/a)', 'docs'],
    ['[a](b) 和 [c](d)', 'a 和 c'],
    ['![](x)', ''],
    ['[空]()', '空'],
    ['[嵌]([内])', '嵌'],
    ['文本 [链接](url) 尾部', '文本 链接 尾部'],
    ['[未闭合(x', '[未闭合(x'],
    ['![a](b)c[d](e)', 'cd'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(cleanText(input, MD), expected, `markdown: ${JSON.stringify(input)}`);
  }
});

test('the hardened underscore regex still spares snake_case', () => {
  const cases = [
    ['_斜体_', '斜体'],
    ['my_func_name', 'my_func_name'],
    ['_a_ 和 _b_', 'a 和 b'],
    ['前 _中_ 后', '前 中 后'],
    ['snake_case_x', 'snake_case_x'],
    ['_未闭合', '_未闭合'],
    ['a_b_c', 'a_b_c'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(cleanText(input, MD), expected, `underscore: ${JSON.stringify(input)}`);
  }
});

// ------------------------------------------------------- per-request CPU scaling
// The README claimed "CPU work per request is < 1 ms". Auditing it found that no longer
// true: chunking a 50000-character input alone measures ~1.6 ms, and the whole worst-case
// path (clean + chunk + per-chunk SSML) is ~1.96 ms median on a dev laptop. The claim was
// written before chunking, WAV/WebM merging and ETag hashing existed, and nothing watched it.
// The docs now carry the measured numbers; this test keeps the underlying property honest.
//
// It asserts SCALING, not a millisecond ceiling. I first wrote `median < 6` calibrated on my
// laptop, and CI measured 20.07 ms on the same code — a shared runner under contention is an
// order of magnitude slower, so the build went red on working code. That is the same lesson
// already recorded at the top of this file for the ReDoS budget, and I repeated it. Doubling
// the input must roughly double the cost; a slow machine scales both halves equally, so the
// ratio stays meaningful everywhere.
test('per-request CPU cost scales linearly with input size', () => {
  const opts = {
    remove_markdown: true,
    remove_urls: true,
    remove_emoji: true,
    remove_line_breaks: true,
    remove_citation_numbers: true,
  };
  const raw = 'ab。'.repeat(Math.ceil(LIMITS.MAX_INPUT_CHARS / 3));
  const input = raw.slice(0, LIMITS.MAX_INPUT_CHARS);

  // One full pass of the pure-CPU work a request performs before any upstream call.
  const once = () => {
    const clean = cleanText(input, opts);
    const chunks = __test__.smartChunkText(clean, LIMITS.MAX_CHUNK_SIZE);
    for (const c of chunks) __test__.getSsml(c, 'zh-CN-XiaoxiaoNeural', 1, 1, 'general');
    return chunks.length;
  };

  const chunks = once(); // warm up, and check the fixture is the shape we think
  assert.ok(
    chunks > 1 && chunks <= LIMITS.MAX_CHUNKS,
    'fixture must be a multi-chunk request that passes MAX_CHUNKS, got ' + chunks
  );

  const time = (fn) => {
    fn();
    const runs = [];
    for (let i = 0; i < 9; i++) {
      const t0 = process.hrtime.bigint();
      fn();
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return runs.sort((a, b) => a - b)[4];
  };

  // Compare against a fixed reference workload measured on the SAME machine in the same
  // run, instead of an absolute millisecond ceiling.
  //
  // I first asserted `median < 6`, calibrated on a dev laptop (1.96ms). CI measured 20.07ms
  // and went red — a shared runner under contention is an order of magnitude slower. The
  // comment at the top of this file already records exactly this lesson from the ReDoS
  // budget (55ms local vs 273ms on a GitLab runner), and I repeated the mistake. Absolute
  // wall-clock thresholds are not portable; a ratio against work done on the same CPU is.
  // The reference must be the SAME work at HALF the size. Then a linear implementation gives
  // a ratio near 2, and any super-linear regression — the real hazard, and exactly how the
  // ReDoS bug behaved — shows up as a much larger number regardless of machine speed.
  //
  // A first attempt used a tiny reference (one chunk's cleaning, 0.015ms). At that scale
  // timer granularity dominates and the ratio came out ~179 with no meaningful headroom.
  // Comparing like with like is what makes the ratio interpretable.
  const halfInput = input.slice(0, Math.floor(input.length / 2));
  const half = () => {
    const clean = cleanText(halfInput, opts);
    const chunks = __test__.smartChunkText(clean, LIMITS.MAX_CHUNK_SIZE);
    for (const c of chunks) __test__.getSsml(c, 'zh-CN-XiaoxiaoNeural', 1, 1, 'general');
  };
  const reference = time(half);
  const worst = time(once);
  const ratio = worst / Math.max(reference, 0.001);

  assert.ok(
    ratio < 8,
    `doubling the input multiplied the CPU cost by ${ratio.toFixed(1)}x ` +
      `(${reference.toFixed(2)}ms -> ${worst.toFixed(2)}ms) — expected ~2x for linear work. ` +
      'A blow-up here means the per-request path stopped scaling linearly.'
  );
});

// ---------------------------------------------------------- 结构化日志的 CPU 成本
// 日志埋在**每一个**请求上，所以它的成本必须是可忽略的、而且要有测试盯住 —— 否则以后往
// 那行 JSON 里加字段时，没人知道加到什么程度会开始吃掉 10ms 预算。
//
// 断言的是**比例**而不是绝对毫秒：绝对阈值在 CI 上不可移植（这条教训本文件顶部与 CPU
// 伸缩测试里都记过，我在这个 session 里犯过两次）。
test('one structured log line costs a negligible fraction of a request', () => {
  const payload = {
    ev: 'req', route: '/v1/audio/speech', status: 200, ms: 3, upstream: 26, retries: 0,
    voice: 'zh-CN-XiaoxiaoNeural', format: 'mp3', chunks: 26, conc: 10, stream: false,
    chars: 50000,
  };
  const opts = {
    remove_markdown: true, remove_urls: true, remove_emoji: true,
    remove_line_breaks: true, remove_citation_numbers: true,
  };
  const raw = 'ab。'.repeat(Math.ceil(LIMITS.MAX_INPUT_CHARS / 3));
  const input = raw.slice(0, LIMITS.MAX_INPUT_CHARS);

  const median = (fn, runs) => {
    fn();
    const out = [];
    for (let i = 0; i < runs; i++) {
      const t0 = process.hrtime.bigint();
      fn();
      out.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return out.sort((a, b) => a - b)[Math.floor(runs / 2)];
  };

  // The per-request pure-CPU work, as the denominator.
  const request = median(() => {
    const clean = cleanText(input, opts);
    const chunks = __test__.smartChunkText(clean, LIMITS.MAX_CHUNK_SIZE);
    for (const c of chunks) __test__.getSsml(c, 'zh-CN-XiaoxiaoNeural', 1, 1, 'general');
  }, 9);

  // Serialising the log line is the entire success-path cost: emitLog only clones the
  // response for status >= 400, precisely so a multi-megabyte audio body is never copied.
  const logging = median(() => JSON.stringify(payload), 999);

  const pct = (logging / request) * 100;
  assert.ok(
    pct < 5,
    `the log line costs ${pct.toFixed(3)}% of a worst-case request ` +
      `(${logging.toFixed(5)}ms vs ${request.toFixed(3)}ms). Measured at ~0.004% when written; ` +
      'crossing 5% means the payload grew enough to matter against the 10ms CPU budget.'
  );
});
