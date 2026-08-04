// Deep boundary tests for smartChunkText / getSsml / escapeXmlAttr.
// pure-helpers.test.mjs covers the happy paths; this file pushes the edges:
// exact-max boundaries, maxChunkLength=1, delimiter-only input, consecutive
// <break> tags, escape ordering and attribute-injection payloads.
// Run with: node --test test/unit/chunking-ssml.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../../src/worker.js';

const { smartChunkText, getSsml, escapeXmlAttr } = __test__;

const strip = (s) => s.replace(/\s+/g, '');
const prosodyBody = (ssml) => {
  const m = ssml.match(/<prosody[^>]*>([\s\S]*)<\/prosody>/);
  assert.ok(m, 'ssml must contain a <prosody> element');
  return m[1];
};

// ---------------------------------------------------------------- chunking

test('smartChunkText returns [] for every falsy / whitespace-only input', () => {
  assert.deepEqual(smartChunkText('', 100), []);
  assert.deepEqual(smartChunkText(null, 100), []);
  assert.deepEqual(smartChunkText(undefined, 100), []);
  assert.deepEqual(smartChunkText('   ', 10), [], 'spaces only -> nothing to synthesize');
  assert.deepEqual(smartChunkText('\n\n\n', 10), [], 'newlines are delimiters, so nothing remains');
  assert.deepEqual(smartChunkText('\r\n \t', 10), []);
});

test('smartChunkText keeps a single sentence intact when it fits', () => {
  assert.deepEqual(smartChunkText('Hi.', 1000), ['Hi.']);
  assert.deepEqual(smartChunkText('你好，世界。', 1000), ['你好，世界。']);
});

test('smartChunkText: text exactly maxChunkLength long stays one chunk', () => {
  const text = 'exactly ten'; // 11 chars incl. space
  assert.equal(text.length, 11);
  assert.deepEqual(smartChunkText(text, 11), [text], 'length === max must not split');
  assert.deepEqual(smartChunkText('0123456789.', 11), ['0123456789.'], 'trailing delimiter at exact max');
});

test('smartChunkText: one char over max splits into two chunks, no content lost', () => {
  const chunks = smartChunkText('a'.repeat(11), 10);
  assert.deepEqual(chunks, ['a'.repeat(10), 'a'], 'tail becomes its own chunk');
  assert.equal(chunks.join('').length, 11);
});

test('smartChunkText: exact multiple of max produces exactly N full chunks', () => {
  const chunks = smartChunkText('a'.repeat(30), 10);
  assert.equal(chunks.length, 3, 'no empty trailing chunk');
  for (const c of chunks) assert.equal(c.length, 10);
});

test('smartChunkText hard-splits an unpunctuated long run so nothing exceeds max', () => {
  const max = 100;
  const chunks = smartChunkText('a'.repeat(1000), max);
  assert.equal(chunks.length, 10);
  for (const c of chunks) assert.equal(c.length, max);
  assert.equal(chunks.join(''), 'a'.repeat(1000), 'content byte-identical');
});

test('smartChunkText with maxChunkLength=1 emits one non-space char per chunk', () => {
  const chunks = smartChunkText('a b', 1);
  assert.deepEqual(chunks, ['a', 'b'], 'the space chunk is trimmed away');
  const cn = smartChunkText('你好。', 1);
  assert.deepEqual(cn, ['你', '好', '。']);
  for (const c of cn) assert.equal(c.length, 1);
});

test('smartChunkText splits on ASCII punctuation and keeps the delimiter attached', () => {
  assert.deepEqual(smartChunkText('Hello world. Bye now.', 13), ['Hello world.', 'Bye now.']);
  const chunks = smartChunkText('Alpha, beta; gamma. Delta!', 10);
  for (const c of chunks) assert.ok(c.length <= 10, `chunk ${JSON.stringify(c)} over 10`);
  assert.equal(strip(chunks.join('')), strip('Alpha, beta; gamma. Delta!'));
});

test('smartChunkText splits on CJK punctuation （。？！，；：）', () => {
  const text = '第一句。第二句？第三句！第四，第五；第六：完';
  const chunks = smartChunkText(text, 8);
  // Chunks are packed greedily up to the limit, so a chunk may hold several sentences.
  assert.deepEqual(chunks, ['第一句。第二句？', '第三句！第四，', '第五；第六：完']);
  for (const c of chunks) assert.ok(c.length <= 8, `chunk ${JSON.stringify(c)} over 8`);
  assert.equal(strip(chunks.join('')), strip(text), 'no CJK character dropped');
});

test('smartChunkText handles mixed CJK/latin without losing content or overflowing', () => {
  const text = '你好，世界。这是没有标点的很长一段abcdefghijklmnopqrstuvwxyz Hello, world! Bye; done.';
  for (const max of [1, 2, 3, 5, 8, 13, 20, 50, 300]) {
    const chunks = smartChunkText(text, max);
    assert.ok(chunks.length > 0, `max=${max} produced no chunks`);
    for (const c of chunks) {
      assert.ok(c.length <= max, `max=${max}: chunk of ${c.length} exceeds limit`);
      assert.ok(c.trim().length > 0, `max=${max}: emitted a blank chunk`);
    }
    assert.equal(strip(chunks.join('')), strip(text), `max=${max}: content lost`);
  }
});

test('smartChunkText splits a delimiter-only run longer than max instead of overflowing', () => {
  // A pathological "。。。..." run is itself a single split segment; it still must be cut.
  const text = '。'.repeat(7);
  const chunks = smartChunkText(text, 3);
  assert.deepEqual(chunks, ['。。。', '。。。', '。']);
  for (const c of chunks) assert.ok(c.length <= 3);
});

test('smartChunkText keeps the tail of an oversized segment open to merge with what follows', () => {
  // When a long unpunctuated run is hard-split, the final under-length slice is left in
  // currentChunk rather than pushed, so the next segment joins it. Otherwise the tail
  // becomes a chunk of its own and the text splits right before the punctuation, adding
  // an upstream request and an audible pause exactly where a sentence continues.
  //
  // Existing tests could not see this: the round-numbered fixtures produced no tail, and
  // the ones that did only asserted "content preserved" + "under the limit", which both
  // splittings satisfy — only the chunk boundaries differ. So pin the boundaries.
  assert.deepEqual(
    smartChunkText('a'.repeat(25) + '。bbb', 10),
    ['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa。bbb'],
    'the 5-char tail must absorb 。bbb instead of standing alone'
  );
  // An exact multiple leaves no tail, so the following segment starts a fresh chunk —
  // the control case that proves the assertion above is about the tail, not about
  // segments merging unconditionally.
  assert.deepEqual(
    smartChunkText('a'.repeat(20) + '。bbb', 10),
    ['aaaaaaaaaa', 'aaaaaaaaaa', '。bbb'],
    'no tail means no merge'
  );
});

test('smartChunkText never emits an empty or whitespace-only chunk', () => {
  const text = 'a,,,   ,,,b.   .   c\n\n\nd';
  for (const max of [1, 2, 4, 7, 11]) {
    for (const c of smartChunkText(text, max)) {
      assert.notEqual(c.length, 0);
      assert.equal(c, c.trim(), 'chunks are trimmed');
    }
  }
});

// ------------------------------------------------------------ escapeXmlAttr

test('escapeXmlAttr escapes all five XML attribute metacharacters', () => {
  assert.equal(escapeXmlAttr('&'), '&amp;');
  assert.equal(escapeXmlAttr('<'), '&lt;');
  assert.equal(escapeXmlAttr('>'), '&gt;');
  assert.equal(escapeXmlAttr('"'), '&quot;');
  assert.equal(escapeXmlAttr("'"), '&apos;');
  // & must be escaped first, otherwise the ampersands of later entities get mangled.
  assert.equal(escapeXmlAttr('&lt;'), '&amp;lt;', 'no double-escaping of a literal entity');
});

test('escapeXmlAttr stringifies non-string input instead of throwing', () => {
  assert.equal(escapeXmlAttr(0), '0');
  assert.equal(escapeXmlAttr(-5), '-5');
  assert.equal(escapeXmlAttr(null), 'null');
  assert.equal(escapeXmlAttr(undefined), 'undefined');
  assert.equal(escapeXmlAttr(''), '');
});

// -------------------------------------------------------------------- ssml

test('getSsml emits exactly one voice/express-as/prosody nesting with the given params', () => {
  const ssml = getSsml('hi', 'zh-CN-XiaoxiaoNeural', '25', '-10', 'cheerful');
  assert.equal((ssml.match(/<voice /g) || []).length, 1);
  assert.equal((ssml.match(/<mstts:express-as /g) || []).length, 1);
  assert.equal((ssml.match(/<prosody /g) || []).length, 1);
  assert.ok(ssml.includes('<voice name="zh-CN-XiaoxiaoNeural">'));
  assert.ok(ssml.includes('<mstts:express-as style="cheerful">'));
  assert.ok(ssml.includes('<prosody rate="25%" pitch="-10%">'), 'rate/pitch get a % suffix');
  assert.equal(prosodyBody(ssml), 'hi');
});

test('getSsml escapes &, < and > in the text body without double-escaping', () => {
  assert.equal(prosodyBody(getSsml('a & b', 'v', '0', '0', 'general')), 'a &amp; b');
  assert.equal(prosodyBody(getSsml('1 < 2 > 0', 'v', '0', '0', 'general')), '1 &lt; 2 &gt; 0');
  assert.equal(
    prosodyBody(getSsml('&amp; already', 'v', '0', '0', 'general')),
    '&amp;amp; already',
    'a literal entity in the input is escaped again, not passed through',
  );
  // Quotes inside the text body are harmless and must be left alone (only attrs need it).
  assert.equal(prosodyBody(getSsml('say "hi"', 'v', '0', '0', 'general')), 'say "hi"');
});

test('getSsml neutralizes an SSML injection payload embedded in the text', () => {
  const ssml = getSsml(
    '</prosody></voice><voice name="evil"><audio src="http://evil/x.mp3"/>',
    'zh-CN-XiaoxiaoNeural', '0', '0', 'general',
  );
  assert.equal((ssml.match(/<voice /g) || []).length, 1, 'no second <voice> element');
  assert.ok(!ssml.includes('<audio'), 'no raw <audio> element');
  assert.equal((ssml.match(/<\/prosody>/g) || []).length, 1, 'exactly one closing prosody');
  assert.equal(
    prosodyBody(ssml),
    '&lt;/prosody&gt;&lt;/voice&gt;&lt;voice name="evil"&gt;&lt;audio src="http://evil/x.mp3"/&gt;',
  );
});

test('getSsml escapes a hostile style and rate/pitch instead of breaking out of the attribute', () => {
  const ssml = getSsml('hi', 'v', '0" onload="x', '0', 'general" x="y');
  assert.ok(ssml.includes('style="general&quot; x=&quot;y"'), 'style quotes escaped');
  assert.ok(ssml.includes('rate="0&quot; onload=&quot;x%"'), 'rate quotes escaped');
  assert.ok(!/onload="/.test(ssml), 'no injected attribute survives as markup');
});

test('getSsml preserves several consecutive <break> tags verbatim and in order', () => {
  const text = 'a <break time="500ms"/><break time="1s"/> b <break/> c <break time=\'2s\'/> d <BREAK TIME="3s"/>';
  const body = prosodyBody(getSsml(text, 'zh-CN-XiaoxiaoNeural', '0', '0', 'general'));
  assert.equal(body, text, 'every break variant survives unchanged, order preserved');
  assert.equal((body.match(/<break|<BREAK/gi) || []).length, 5, 'all five break tags kept');
  assert.ok(!body.includes('__BREAK_'), 'no placeholder leaks into the output');
});

test('getSsml keeps duplicate identical <break> tags (placeholders are per-occurrence)', () => {
  const body = prosodyBody(getSsml('a <break time="1s"/> b <break time="1s"/> c', 'v', '0', '0', 'general'));
  assert.equal(body, 'a <break time="1s"/> b <break time="1s"/> c');
  assert.equal((body.match(/<break /g) || []).length, 2);
});

test('getSsml escapes break-like tags that are not real breaks', () => {
  const body = prosodyBody(getSsml('<breakx/> <break-time/> <breaking>', 'v', '0', '0', 'general'));
  assert.ok(!body.includes('<break'), `nothing break-ish stayed raw: ${body}`);
  assert.equal(body, '&lt;breakx/&gt; &lt;break-time/&gt; &lt;breaking&gt;');
});

test('getSsml is not fooled by literal __BREAK_* placeholder text in the input', () => {
  // The nonce makes the placeholder unguessable; a hand-written one must stay inert text.
  const body = prosodyBody(getSsml('__BREAK_0__ and __BREAK_deadbeef_1__ plain', 'v', '0', '0', 'general'));
  assert.ok(!body.includes('<break'), 'no break tag synthesized from literal text');
  assert.equal(body, '__BREAK_0__ and __BREAK_deadbeef_1__ plain', 'literal text passes through unchanged');
});

test('getSsml uses a fresh nonce per call (two calls cannot share a placeholder)', () => {
  const a = getSsml('x <break/> y', 'v', '0', '0', 'general');
  const b = getSsml('x <break/> y', 'v', '0', '0', 'general');
  assert.equal(prosodyBody(a), 'x <break/> y');
  assert.equal(prosodyBody(b), prosodyBody(a), 'output is deterministic even though the nonce is not');
});

test('getSsml handles empty text and text that is only a break tag', () => {
  assert.equal(prosodyBody(getSsml('', 'v', '0', '0', 'general')), '');
  assert.equal(prosodyBody(getSsml('<break time="500ms"/>', 'v', '0', '0', 'general')), '<break time="500ms"/>');
});

test('getSsml keeps a <break> whose attribute contains a $ replacement pattern', () => {
  // Restoration uses a function replacement, so `$&`/`$'` in a break attribute are
  // inserted literally instead of expanding to the internal placeholder.
  const body = prosodyBody(getSsml('x <break time="$&"/> y', 'v', '0', '0', 'general'));
  assert.ok(!body.includes('__BREAK_'), `placeholder leaked: ${body}`);
  assert.equal(body, 'x <break time="$&"/> y');
});

// --------------------------------------------------------------- SSML tag atomicity
// The UI's "insert pause" button emits `<break time="500ms"/>`, and getSsml passes such
// tags through unescaped so they act as real SSML. But the chunk delimiters include `,`
// and `:`, which appear INSIDE the tag, so a tag near a chunk boundary was split in two.
// Each half then landed in a different chunk, got escaped as `&lt;break…`, and was read
// aloud as literal text instead of producing a pause.

const tagsIn = (s) => s.match(/<[^>]+>/g) || [];

test('an SSML tag is never split across chunks', () => {
  const cases = [
    ['前面一段文字。<break time="500ms"/>后面一段文字。', 20],
    ['<break time="2s"/>正文开始了这里', 10],
    ['a。<break time="1s"/>b。<break time="2s"/>c。', 8],
    ['正文。<break time="1s"/>更多正文。', 300],
  ];
  for (const [input, max] of cases) {
    const chunks = smartChunkText(input, max);
    for (const tag of tagsIn(input)) {
      assert.ok(
        chunks.some((c) => c.includes(tag)),
        `max=${max}: ${tag} was split across ${JSON.stringify(chunks)}`
      );
    }
    assert.equal(
      chunks.join('').replace(/\s/g, ''),
      input.replace(/\s/g, ''),
      `max=${max}: content changed`
    );
  }
});

test('a tag longer than chunk_size is kept whole rather than cut', () => {
  // Overshooting chunk_size slightly is fine upstream; a broken tag never is.
  const tag = '<break time="500ms"/>';
  const chunks = smartChunkText(tag, 5);
  assert.deepEqual(chunks, [tag], 'the tag must survive even when it exceeds the limit');
});

test('tag handling does not change chunking of tag-free text', () => {
  // Regression guard for the atomicity change: plain text must chunk exactly as before.
  assert.deepEqual(smartChunkText('第一句。第二句？第三句！', 8), ['第一句。第二句？', '第三句！']);
  assert.deepEqual(smartChunkText('a'.repeat(25) + '。bbb', 10), [
    'aaaaaaaaaa',
    'aaaaaaaaaa',
    'aaaaa。bbb',
  ]);
});

test('tag atomicity covers every position a tag can occupy', () => {
  // Exercises each branch of the atom scanner: leading tag (no preceding text), trailing
  // tag (no following text), tag-only input, adjacent tags with nothing between, and a
  // paired open/close tag.
  const cases = [
    ['<break time="1s"/>abc', 50, ['<break time="1s"/>abc']],
    ['abc<break time="1s"/>', 50, ['abc<break time="1s"/>']],
    ['<break time="1s"/>', 50, ['<break time="1s"/>']],
    ['<break time="1s"/><break time="2s"/>', 50, ['<break time="1s"/><break time="2s"/>']],
    ['<emphasis>词</emphasis>', 50, ['<emphasis>词</emphasis>']],
    // The tag does not fit in the current chunk, so it starts a new one whole.
    ['abcdefgh<break time="1s"/>', 10, ['abcdefgh', '<break time="1s"/>']],
  ];
  for (const [input, max, expected] of cases) {
    assert.deepEqual(smartChunkText(input, max), expected, JSON.stringify(input));
  }
});
