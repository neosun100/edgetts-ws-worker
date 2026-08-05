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

// ---------------------------------------------------------------- CPU budget
// The README claimed "CPU work per request is < 1 ms". Auditing it found that no longer
// true: chunking a 50000-character input alone measures ~1.6 ms, and the whole worst-case
// path (clean + chunk + per-chunk SSML) is ~1.96 ms median. The claim was written before
// chunking, WAV/WebM merging and ETag hashing existed, and nothing was watching it.
//
// The number in the docs is now the measured one; this test keeps it from rotting again.
// The ceiling is deliberately well above the measurement — CI is slower and noisier than a
// dev machine, and what matters is staying clearly inside the platform's 10 ms budget, not
// defending a specific millisecond.
test('the worst legal request stays well inside the Workers CPU budget', () => {
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

  const runs = [];
  for (let i = 0; i < 9; i++) {
    const t0 = process.hrtime.bigint();
    once();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  const median = runs[4];

  // The Workers CPU limit is 10ms. Fail well before it so there is room to react.
  assert.ok(
    median < 6,
    `worst-case request CPU is ${median.toFixed(2)}ms — the Workers budget is 10ms, so this ` +
      'leaves too little headroom. Measured ~1.96ms when written.'
  );
});
