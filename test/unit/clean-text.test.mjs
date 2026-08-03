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

test('remove_emoji leaves text-presentation symbols alone (documents current scope)', () => {
  // \p{Emoji_Presentation} excludes text-default symbols such as U+2764 and U+2600,
  // and does not consume the VS16 selector, so these survive verbatim.
  assert.equal(cleanText('❤ ☀ ❤️', { remove_emoji: true }), '❤ ☀ ❤️');
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
