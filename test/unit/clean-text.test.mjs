// Unit tests for __test__.cleanText in src/worker.js.
// cleanText is a pure function, so no fetch mock / token cache reset is needed here.
// Run with: node --test test/unit/clean-text.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../../src/worker.js';

const { cleanText } = __test__;

// Mirrors the defaults built in handleSpeechRequest (finalCleaningOptions).
const DEFAULTS = {
  remove_markdown: true,
  remove_emoji: true,
  remove_urls: true,
  remove_line_breaks: true,
  remove_citation_numbers: true,
  custom_keywords: '',
};

// ---------------------------------------------------------------- remove_urls

test('remove_urls strips http and https URLs including query strings', () => {
  assert.equal(
    cleanText('visit https://a.com/x?y=1&z=2 now', { remove_urls: true }),
    'visit  now',
  );
  assert.equal(
    cleanText('plain http://insecure.example/path here', { remove_urls: true }),
    'plain  here',
  );
});

test('remove_urls=false leaves the URL untouched', () => {
  assert.equal(
    cleanText('visit https://a.com now', { remove_urls: false }),
    'visit https://a.com now',
  );
});

// ------------------------------------------------------------ remove_markdown

test('remove_markdown deletes images but keeps surrounding text', () => {
  assert.equal(
    cleanText('pre ![alt text](http://i/x.png) post', { remove_markdown: true }),
    'pre  post',
  );
});

test('remove_markdown unwraps links to their label', () => {
  assert.equal(
    cleanText('see [docs](https://x.com/a) end', { remove_markdown: true }),
    'see docs end',
  );
  // An image immediately followed by a link: image goes, link keeps its label.
  assert.equal(cleanText('![a](u) [b](v)', { remove_markdown: true }), 'b');
});

test('remove_markdown strips bold (** and __) and italic (* and _) markers', () => {
  assert.equal(cleanText('**b** and __u__', { remove_markdown: true }), 'b and u');
  assert.equal(cleanText('*i* and _u_', { remove_markdown: true }), 'i and u');
  // Nested emphasis around a link collapses to the bare label.
  assert.equal(cleanText('**[link](u)**', { remove_markdown: true }), 'link');
});

test('remove_markdown strips inline code and fenced backticks', () => {
  assert.equal(
    cleanText('use `npm i` and ```block``` here', { remove_markdown: true }),
    'use npm i and block here',
  );
});

test('remove_markdown strips ATX heading markers (# through ######) only when followed by whitespace', () => {
  assert.equal(cleanText('# H1\n### H3\ntext', { remove_markdown: true }), 'H1\nH3\ntext');
  assert.equal(cleanText('###### h6 x', { remove_markdown: true }), 'h6 x');
  // "#tag" has no space after the hash, so it is a hashtag, not a heading.
  assert.equal(cleanText('#tag and # spaced', { remove_markdown: true }), '#tag and spaced');
});

test('remove_markdown=false keeps every markdown marker', () => {
  const input = '# H\n![a](u) [b](v) **bold** _em_ `code`';
  assert.equal(cleanText(input, { remove_markdown: false }), input);
});

// ----------------------------------------------------------- custom_keywords

test('custom_keywords removes each comma-separated keyword and trims the entries', () => {
  assert.equal(
    cleanText('Buy sponsor now, subscribe please', { custom_keywords: 'sponsor,  subscribe ' }),
    'Buy  now,  please',
  );
});

test('custom_keywords escapes regex metacharacters so keywords match literally', () => {
  // "foo.bar" and "c++" contain metacharacters; they must be matched as literals.
  assert.equal(
    cleanText('Buy foo.bar and c++ now', { custom_keywords: 'foo.bar, c++' }),
    'Buy  and  now',
  );
  // The unescaped "." would have matched "fooXbar"; escaped, it must not.
  assert.equal(cleanText('x fooXbar y', { custom_keywords: 'foo.bar' }), 'x fooXbar y');
  // $ / [ ] are escaped too.
  assert.equal(cleanText('price $9 and a$b', { custom_keywords: '$9' }), 'price  and a$b');
  assert.equal(cleanText('tag [x] left', { custom_keywords: '[x]' }), 'tag  left');
});

test('custom_keywords cannot inject regex alternation', () => {
  // "a|b" must be treated as the literal 3-char string, not "a OR b".
  assert.equal(cleanText('aaa bbb', { custom_keywords: 'a|b' }), 'aaa bbb');
  assert.equal(cleanText('x a|b y', { custom_keywords: 'a|b' }), 'x  y');
});

test('custom_keywords with only separators/blanks is a no-op (no empty regex)', () => {
  assert.equal(cleanText('abc', { custom_keywords: ' , ,  ' }), 'abc');
  assert.equal(cleanText('abc', { custom_keywords: '' }), 'abc');
});

// ------------------------------------------------------------- remove_emoji

test('remove_emoji strips Emoji_Presentation code points', () => {
  assert.equal(cleanText('hi 🎉 there ✅ ok', { remove_emoji: true }), 'hi  there  ok');
});

test('remove_emoji strips symbols that VS16 turns into emoji', () => {
  // This test used to assert the opposite, under the name "documents current scope" — it
  // recorded what the code did rather than what it owed the caller. `❤️` surviving a
  // `remove_emoji: true` request is not a scope decision, it is a bug: the caller asked for
  // no emoji and gets one read aloud. Measured before the fix: "我❤️你" came back unchanged,
  // as did "天气☀️晴".
  //
  // \p{Emoji_Presentation} only covers symbols that are graphical BY DEFAULT. U+2764 and
  // U+2600 are text-default and become emoji only when followed by VS16 (U+FE0F), so a
  // second pass keyed on that selector is required.
  assert.equal(cleanText('我❤️你', { remove_emoji: true }), '我你');
  assert.equal(cleanText('天气☀️晴', { remove_emoji: true }), '天气晴');
  assert.equal(cleanText('星星⭐️亮', { remove_emoji: true }), '星星亮');
  // No orphaned U+FE0F may be left behind — an invisible selector with no base character.
  assert.equal(cleanText('a❤️b', { remove_emoji: true }).length, 2);
});

test('remove_emoji leaves bare text-presentation symbols and non-emoji marks intact', () => {
  // The other half of the contract, and the reason the fix is NOT simply
  // \p{Extended_Pictographic}: © and ™ are Extended_Pictographic but plain text. Stripping
  // them would turn "©2026" into "2026", trading one silent corruption for another.
  // Without VS16 these are text symbols and must be spoken.
  assert.equal(cleanText('❤ ☀', { remove_emoji: true }), '❤ ☀');
  assert.equal(cleanText('©2026 公司', { remove_emoji: true }), '©2026 公司');
  assert.equal(cleanText('产品™ 上市', { remove_emoji: true }), '产品™ 上市');
  assert.equal(cleanText('价格 €99', { remove_emoji: true }), '价格 €99');
  assert.equal(cleanText('方向→右 评分★★★ 第①条 温度 25℃', { remove_emoji: true }),
    '方向→右 评分★★★ 第①条 温度 25℃');
});

test('remove_emoji=false keeps emoji', () => {
  assert.equal(cleanText('party 🎉', { remove_emoji: false }), 'party 🎉');
});

// -------------------------------------------------- remove_citation_numbers

test('remove_citation_numbers strips 1-2 digit refs before punctuation or end of string', () => {
  assert.equal(
    cleanText('As stated 12. And also 3, end 4', { remove_citation_numbers: true }),
    'As stated. And also, end',
  );
  // Chinese punctuation is covered as well.
  assert.equal(
    cleanText('第一 1。第二 2，第三 12：', { remove_citation_numbers: true }),
    '第一。第二，第三：',
  );
  // Trailing citation with nothing after it.
  assert.equal(cleanText('see also 42', { remove_citation_numbers: true }), 'see also');
});

test('remove_citation_numbers leaves 3+ digit numbers (years, quantities) intact', () => {
  assert.equal(
    cleanText('in 2024. plus 123.', { remove_citation_numbers: true }),
    'in 2024. plus 123.',
  );
});

test('remove_citation_numbers=false keeps the reference digits', () => {
  assert.equal(cleanText('stated 12. ok', { remove_citation_numbers: false }), 'stated 12. ok');
});

// ----------------------------------------------------- remove_line_breaks

test('remove_line_breaks collapses every whitespace run to a single space', () => {
  assert.equal(cleanText('a\n\nb\tc   d', { remove_line_breaks: true }), 'a b c d');
  assert.equal(cleanText('line1\r\nline2', { remove_line_breaks: true }), 'line1 line2');
});

test('remove_line_breaks=false preserves newlines and runs of spaces', () => {
  assert.equal(cleanText('a\nb  c', { remove_line_breaks: false }), 'a\nb  c');
});

// --------------------------------------------------------- all off / trim

test('all options off returns the input verbatim', () => {
  const input = '**keep** https://x.com 🎉 # h 12. word';
  assert.equal(cleanText(input, {}), input);
});

test('trailing and leading whitespace is always trimmed, even with all options off', () => {
  assert.equal(cleanText('   spaced   ', {}), 'spaced');
  assert.equal(cleanText('\n\ttext\n', {}), 'text');
  // A string of pure whitespace becomes empty -> handleSpeechRequest's
  // input_empty_after_cleaning branch.
  assert.equal(cleanText('   \n  ', {}), '');
  assert.equal(cleanText('', DEFAULTS), '');
});

test('a text that is entirely removable becomes the empty string', () => {
  assert.equal(cleanText('https://only-a-url.example/x', DEFAULTS), '');
  assert.equal(cleanText('🎉🎉', DEFAULTS), '');
});

// --------------------------------------------------------- ordering / combos

test('markdown links reduce to their label even with URL removal on (DEFAULTS)', () => {
  // Markdown runs before URL stripping, so a "[label](url)" always becomes "label" —
  // it must never leave bracket/paren noise like "[docs](" for the TTS to read aloud.
  assert.equal(cleanText('[docs](https://x.com/a)', DEFAULTS), 'docs');
  assert.equal(
    cleanText('[docs](https://x.com/a)', { ...DEFAULTS, remove_urls: false }),
    'docs',
  );
});

test('custom_keywords runs after URL removal, so keywords inside a URL are already gone', () => {
  assert.equal(
    cleanText('https://foo.com bar', { remove_urls: true, custom_keywords: 'foo' }),
    'bar',
  );
});

test('emphasis stripping leaves snake_case identifiers intact', () => {
  // The single-underscore italic rule is word-boundary aware, so it must not eat the
  // underscores inside an identifier like my_func_name.
  assert.equal(cleanText('call my_func_name now', { remove_markdown: true }), 'call my_func_name now');
  // Genuine underscore emphasis is still unwrapped.
  assert.equal(cleanText('a _word_ here', { remove_markdown: true }), 'a word here');
});

test('all cleaners together on one realistic mixed-content string', () => {
  const input = '# 标题 ✨\n\n看 [文档](https://ex.com/d) **重点** `code` 参考 1。广告词 end';
  assert.equal(
    cleanText(input, { ...DEFAULTS, custom_keywords: '广告词' }),
    '标题 看 文档 重点 code 参考。 end',
  );
});

test('remove_citation_numbers does not eat the integer part of a decimal', () => {
  // A data-corruption bug, and the UI has this option ON BY DEFAULT (form.cleaning
  // .removeCitation = true), so it affected every web UI request containing a decimal.
  //
  // The old lookahead treated the ASCII period as a sentence terminator without qualification,
  // so it could not tell a full stop from a decimal point: in " 3.14159" the " 3" is followed
  // by ".", got read as "citation number + full stop", and was deleted. Measured 7/7 sentences
  // with decimals corrupted:
  //   圆周率 3.14159 -> 圆周率.14159      温度 36.5 度 -> 温度.5 度
  //   价格 12.50 元  -> 价格.50 元        涨了 8.5%    -> 涨了.5%
  // The response was 200 with well-formed audio and the wrong number read aloud — the caller
  // has no way to notice. Same silent-failure class as the WAV/Opus truncations.
  const opt = { remove_citation_numbers: true };
  for (const text of [
    '圆周率 3.14159',
    '价格 12.50 元',
    'CPU 用了 1.96ms',
    '涨了 8.5%',
    '版本 2.0 发布',
    '温度 36.5 度',
    '共 99.9%',
    'about 3.5 hours',
  ]) {
    assert.equal(cleanText(text, opt), text, `decimal must survive: ${text}`);
  }
});

test('remove_citation_numbers does not eat a thousands separator', () => {
  // Same shape with a comma: "1,234" is a separator, not "citation 1 followed by a comma".
  const opt = { remove_citation_numbers: true };
  assert.equal(cleanText('总计 1,234 元', opt), '总计 1,234 元');
  assert.equal(cleanText('约 12,500 人', opt), '约 12,500 人');
});

test('remove_citation_numbers still strips real citation numbers', () => {
  // The other half: the fix must not disable the feature. A full-width 。 is unambiguous
  // (Chinese does not use it as a decimal point), and a digit followed by punctuation that
  // is NOT a digit continuation is still a citation.
  const opt = { remove_citation_numbers: true };
  assert.equal(cleanText('如前所述 1。后续内容', opt), '如前所述。后续内容');
  assert.equal(cleanText('见文献 12，此外', opt), '见文献，此外');
  assert.equal(cleanText('参考 3；另见', opt), '参考；另见');
  assert.equal(cleanText('结论 7:', opt), '结论:');
  assert.equal(cleanText('末尾编号 5', opt), '末尾编号');
  // A period at the very end of a sentence is a full stop, not a decimal point.
  assert.equal(cleanText('As stated 12. And also 3, end 4', opt), 'As stated. And also, end');
});

test('an empty custom_keywords entry does not shadow the real keywords', () => {
  // `"a,,b"` yields an empty entry. Unfiltered it builds /a||b/, whose empty branch matches
  // FIRST at every position, so the later alternatives never get a turn and stop being
  // removed. Measured: "banana".replace(/a||b/g, "") gives "bnn" — the b survives — where the
  // correct /a|b/g gives "nn".
  //
  // Because the replacement is the empty string the damage is invisible by eye; it only shows
  // up when comparing against the expected output. The existing test above covers
  // "separators only" (a no-op); this one covers "some real keywords plus an empty one",
  // which is what a trailing comma in the UI produces.
  assert.equal(cleanText('banana', { custom_keywords: 'a,,b' }), 'nn');
  assert.equal(cleanText('banana', { custom_keywords: 'a,b' }), 'nn', 'control: same without the gap');
  // A trailing comma is the realistic way a caller hits this.
  assert.equal(cleanText('abc', { custom_keywords: 'a,' }), 'bc');
  assert.equal(cleanText('keep sponsor out', { custom_keywords: 'sponsor, ,' }), 'keep  out');
});
