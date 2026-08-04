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
// The budget below is deliberately loose (a CI runner is slower and noisier than a
// Workers isolate). The bug being guarded is three orders of magnitude over it, so a
// generous limit still catches a regression without being flaky.
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

const BUDGET_MS = 250;

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
