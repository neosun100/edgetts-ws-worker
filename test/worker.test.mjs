// Unit tests for the pure helpers in src/worker.js.
// Run with: npm test   (node --test, no external deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../src/worker.js';

const { LIMITS, VOICE_RE, STYLE_RE, clamp, timingSafeEqual, escapeXmlAttr, getSsml, smartChunkText, cleanText } = __test__;

test('VOICE_RE accepts real Microsoft voice names', () => {
  // Sampled from the live /voices/list response; the longest segment there is 27 chars
  // and names have 3-4 dash-separated segments.
  for (const v of [
    'zh-CN-XiaoxiaoNeural',
    'en-US-AvaMultilingualNeural',
    'de-DE-SeraphinaMultilingualNeural',
    'zh-CN-liaoning-XiaobeiNeural',
    'zh-CN-shaanxi-XiaoniNeural',
    'fil-PH-BlessicaNeural',
    'cy-GB-NiaNeural',
  ]) {
    assert.ok(VOICE_RE.test(v), `should accept ${v}`);
  }
});

test('VOICE_RE rejects SSML injection payloads', () => {
  const payloads = [
    `x"><prosody rate="-100%">INJECTED</prosody></voice><voice name="zh-CN-XiaoxiaoNeural`,
    `zh-CN-XiaoxiaoNeural"><audio src="http://evil/`,
    'zh-CN-Xiaoxiao Neural',
    '<script>',
    '',
  ];
  for (const p of payloads) {
    assert.ok(!VOICE_RE.test(p), `should reject ${JSON.stringify(p)}`);
  }
});

test('STYLE_RE rejects attribute-breaking styles', () => {
  assert.ok(STYLE_RE.test('general'));
  assert.ok(STYLE_RE.test('newscast-casual'));
  assert.ok(!STYLE_RE.test('general" onload="x'));
  assert.ok(!STYLE_RE.test('General'));
});

test('escapeXmlAttr neutralizes quotes and angle brackets', () => {
  assert.equal(escapeXmlAttr(`a"b'c<d>e&f`), 'a&quot;b&apos;c&lt;d&gt;e&amp;f');
});

test('getSsml escapes a hostile voice name instead of emitting raw markup', () => {
  const evil = `x"><prosody rate="-100%">INJECTED</prosody></voice><voice name="y`;
  const ssml = getSsml('hello', evil, '0', '0', 'general');
  assert.ok(!ssml.includes('>INJECTED<'), 'injected element must not appear as markup');
  assert.equal((ssml.match(/<voice /g) || []).length, 1, 'exactly one <voice> element');
});

test('getSsml preserves <break> tags but escapes other markup in text', () => {
  const ssml = getSsml('one <break time="500ms"/> two <b>bold</b>', 'zh-CN-XiaoxiaoNeural', '0', '0', 'general');
  assert.ok(ssml.includes('<break time="500ms"/>'), 'break tag survives');
  assert.ok(ssml.includes('&lt;b&gt;bold&lt;/b&gt;'), 'other tags are escaped');
});

test('getSsml is not fooled by literal placeholder text', () => {
  // A caller who writes the placeholder pattern by hand must not be able to forge a tag.
  const ssml = getSsml('__BREAK_0__ plain', 'zh-CN-XiaoxiaoNeural', '0', '0', 'general');
  assert.ok(!ssml.includes('<break'), 'no break tag should be synthesized');
});

test('clamp bounds values and falls back on garbage', () => {
  assert.equal(clamp(50, 1, 20, 10), 20);
  assert.equal(clamp(0, 1, 20, 10), 1);
  assert.equal(clamp('abc', 1, 20, 10), 10);
  assert.equal(clamp(undefined, 1, 20, 10), 10);
  assert.equal(clamp(7.9, 1, 20, 10), 7);
});

test('timingSafeEqual compares correctly', () => {
  assert.ok(timingSafeEqual('secret-key', 'secret-key'));
  assert.ok(!timingSafeEqual('secret-key', 'secret-keY'));
  assert.ok(!timingSafeEqual('', 'secret-key'));
  assert.ok(!timingSafeEqual('short', 'much-longer-key'));
  assert.ok(!timingSafeEqual(undefined, 'k'));
});

test('smartChunkText never emits a chunk over the limit', () => {
  const max = 100;
  const cases = [
    'a'.repeat(1000),                                  // no break points at all
    ('word '.repeat(400)).trim(),                      // spaces but no punctuation
    'Short. Sentences. Everywhere. '.repeat(40),
    '中文没有空格但是有标点。'.repeat(50),
  ];
  for (const text of cases) {
    const chunks = smartChunkText(text, max);
    assert.ok(chunks.length > 0, 'produces chunks');
    for (const c of chunks) {
      assert.ok(c.length <= max, `chunk of ${c.length} exceeds max ${max}`);
    }
  }
});

test('smartChunkText preserves all non-whitespace content', () => {
  const text = 'Alpha, beta; gamma. Delta! Epsilon? Zeta: eta.';
  const chunks = smartChunkText(text, 12);
  const strip = (s) => s.replace(/\s+/g, '');
  assert.equal(strip(chunks.join('')), strip(text));
});

test('smartChunkText handles empty input', () => {
  assert.deepEqual(smartChunkText('', 100), []);
  assert.deepEqual(smartChunkText(null, 100), []);
});

test('cleanText removes markdown, urls and emoji when asked', () => {
  const out = cleanText('See [docs](https://x.com) **bold** 🎉 https://y.com', {
    remove_markdown: true,
    remove_urls: true,
    remove_emoji: true,
    remove_line_breaks: true,
  });
  assert.ok(!out.includes('https://'), 'urls stripped');
  assert.ok(!out.includes('**'), 'markdown stripped');
  assert.ok(out.includes('docs'), 'link text kept');
});

test('cleanText leaves text intact when all options are off', () => {
  const input = '**keep** https://x.com 🎉';
  assert.equal(cleanText(input, {}), input);
});

test('LIMITS are internally consistent', () => {
  assert.ok(LIMITS.MIN_SPEED < LIMITS.MAX_SPEED);
  assert.ok(LIMITS.MIN_PITCH < LIMITS.MAX_PITCH);
  assert.ok(LIMITS.MIN_CONCURRENCY < LIMITS.MAX_CONCURRENCY);
  assert.ok(LIMITS.MIN_CHUNK_SIZE < LIMITS.MAX_CHUNK_SIZE);
});
