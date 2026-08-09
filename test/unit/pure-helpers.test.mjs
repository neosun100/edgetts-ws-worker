// Unit tests for the pure helpers in src/worker.js.
// Run with: npm test   (node --test, no external deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { __test__ } from '../../src/worker.js';

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

test('timingSafeEqual does not short-circuit on the first differing byte', () => {
  // Found by mutation testing: replacing the whole function body with `return a === b`
  // left the entire suite green, because the test above only checks the RESULT — and
  // `===` gets every one of those cases right. The reason this function exists is the
  // constant-time property, and nothing was pinning it.
  //
  // Timing cannot be asserted directly (measurement noise dwarfs the signal on a shared
  // machine). What CAN be asserted is the structural cause: the comparison must read every
  // byte regardless of where the mismatch is. Counting reads via a Proxy makes that
  // observable — a short-circuiting implementation reads 1 byte for an early mismatch and
  // N for a late one, while a constant-time one reads N either way.
  const KEY = 'k'.repeat(32);

  function countReads(a, b) {
    let reads = 0;
    const enc = new TextEncoder();
    const realEncode = TextEncoder.prototype.encode;
    // Wrap the Uint8Array the function indexes into, so every element access is counted.
    TextEncoder.prototype.encode = function (s) {
      const bytes = realEncode.call(this, s);
      return new Proxy(bytes, {
        get(target, prop) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
          return Reflect.get(target, prop);
        },
      });
    };
    try {
      timingSafeEqual(a, b);
    } finally {
      TextEncoder.prototype.encode = realEncode;
    }
    void enc;
    return reads;
  }

  // Differ at byte 0 versus at the last byte: a constant-time compare reads the same
  // number of bytes in both cases.
  const early = countReads(KEY, 'X' + KEY.slice(1));
  const late = countReads(KEY, KEY.slice(0, -1) + 'X');
  assert.ok(early > 0, 'the Proxy actually observed byte reads, got ' + early);
  assert.equal(
    early,
    late,
    `byte reads must not depend on where the mismatch is (early=${early}, late=${late}) — ` +
      'an early exit here is a timing side channel on the API key'
  );

  // And an equal key reads the same amount again, so a match is not distinguishable either.
  assert.equal(countReads(KEY, KEY), early, 'a matching key reads the same number of bytes');

  // Scope note: this kills the dangerous shapes — an early `break`/`return` inside the loop,
  // or dropping the comparison entirely. It does NOT kill replacing the final
  // `return diff === 0` with `return a === b`, and that is correct: the fixed-length loop
  // still runs, so that variant is also constant-time, and UTF-8 encoding is injective so
  // byte equality and string equality always agree. It is an equivalent mutant, not a gap.
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

test('only upstream-supported formats are offered', () => {
  // aac and flac return 400 from the cognitiveservices endpoint, so they must not be
  // in the map — otherwise they pass validation and fail opaquely upstream.
  const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
  assert.ok(!/<option value="aac"/.test(html), 'UI must not offer aac');
  assert.ok(!/<option value="flac"/.test(html), 'UI must not offer flac');
});

test('UI does not offer PCM as a selectable output format', () => {
  // PCM is a streaming-internal format: a bare PCM stream has no RIFF header and cannot
  // be played by <audio> in standard mode. It must not be user-selectable; streaming
  // opts into it automatically.
  const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
  assert.ok(!/<option value="pcm"/.test(html), 'UI must not offer pcm as a format');
  // But the server must still accept it (streaming path sends response_format=pcm).
  const worker = readFileSync(new URL('../../src/worker.js', import.meta.url), 'utf8');
  assert.ok(/"pcm":\s*"raw-24khz-16bit-mono-pcm"/.test(worker), 'server still maps pcm');
});

test('LIMITS are internally consistent', () => {
  assert.ok(LIMITS.MIN_SPEED < LIMITS.MAX_SPEED);
  assert.ok(LIMITS.MIN_PITCH < LIMITS.MAX_PITCH);
  assert.ok(LIMITS.MIN_CONCURRENCY < LIMITS.MAX_CONCURRENCY);
  assert.ok(LIMITS.MIN_CHUNK_SIZE < LIMITS.MAX_CHUNK_SIZE);
});

test('the documented "trusted environments only" claims are all still true', () => {
  // README/README_CN now state, as the resolution of ROADMAP P1-3, that the UI keeps the API
  // key in localStorage and that three specific mitigations bound the risk. A security note
  // that quietly stops being true is worse than no note: a reader would keep making the same
  // deployment decision on stale grounds. Each claim is checked against the source here.
  const ui = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');

  // 1. "the UI's own injection surface is nil — 0 each of v-html, innerHTML =, eval"
  const surfaces = {
    'v-html': (ui.match(/v-html/g) || []).length,
    'innerHTML =': (ui.match(/innerHTML\s*=/g) || []).length,
    'eval(': (ui.match(/[^.\w]eval\(/g) || []).length,
  };
  for (const [name, count] of Object.entries(surfaces)) {
    assert.equal(
      count,
      0,
      `the READMEs claim 0 occurrences of ${name}, found ${count}. Either remove the usage or ` +
        'correct the security note — the key in localStorage is readable by any same-origin script.'
    );
  }

  // 2. "pinned to an exact version with an SRI hash". A floating major (vue@3) would silently
  //    adopt any newly published build, and unpkg only caches that redirect for 60s.
  const script = /<script\s+src="(https:\/\/unpkg\.com\/vue@[^"]+)"([^>]*)>/.exec(ui);
  assert.ok(script, 'the Vue script tag must be findable to be checked');
  const [, src, attrs] = script;
  assert.match(src, /vue@\d+\.\d+\.\d+\//, 'Vue must be pinned to an exact patch version, got ' + src);
  assert.match(attrs, /integrity="sha384-[A-Za-z0-9+/=]{40,}"/, 'the Vue tag must carry an SRI hash');
  // Without crossorigin the browser cannot verify the hash at all, so SRI silently does nothing.
  assert.match(attrs, /crossorigin="anonymous"/, 'SRI requires crossorigin to be enforced');

  // 3. "values read back from localStorage are type-checked field by field rather than spread
  //    over the defaults". Both stores must be guarded — tts_config was missed the first time
  //    round, and it is the one holding the key.
  assert.ok(
    !/\.\.\.this\.config,\s*\.\.\.JSON\.parse/.test(ui),
    'tts_config must not be shallow-spread from localStorage: a non-string apiKey overwrites ' +
      "the '' default and generateSpeech()'s .trim() throws as an uncaught rejection"
  );
  assert.ok(
    !/\.\.\.this\.form,\s*\.\.\.JSON\.parse/.test(ui),
    'tts_form must not be shallow-spread from localStorage (see mergeSavedForm)'
  );
});

test('both READMEs carry the trusted-environment boundary, not just a vague warning', () => {
  // The point of P1-3's resolution is that a deployer can act on it. That needs the mechanism
  // (localStorage, plain text, same-origin readable) and the recommendation — a bare
  // "be careful" would leave them exactly where they started.
  for (const file of ['README.md', 'README_CN.md']) {
    const text = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    assert.match(text, /localStorage/, file + ': must name where the key is kept');
    assert.ok(
      /trusted environments|受信任环境/.test(text),
      file + ': must state the trusted-environment boundary'
    );
    assert.ok(
      /plain text|明文/.test(text),
      file + ': must be explicit that the key is not encrypted'
    );
    // The rejected alternative is part of the decision: it stops the question being reopened
    // from scratch, and tells a reader who DOES need it what to build.
    assert.ok(
      /backend session|后端会话/.test(text),
      file + ': must record that a backend session was considered and why it was not adopted'
    );
  }
});

test('package.json, CHANGELOG and the newest git tag agree on the version', () => {
  // Found while surveying the project: package.json sat at 2.20.0 while CHANGELOG and the
  // shipped tag were 2.22.0. It was set once at the start of the project and never touched
  // again, and nothing noticed — the version is not read at runtime, so drift is invisible.
  //
  // It matters for release hygiene: the tag is what deploys, the CHANGELOG is what a reader
  // trusts, and package.json is what tooling reports. Three sources of truth that disagree
  // means at least two of them are lying.
  //
  // git is not consulted here. Tests must pass on a shallow clone (GitLab CI runs
  // GIT_DEPTH: 1) and from a tarball with no .git at all, so the tag cannot be a dependency.
  // package.json vs CHANGELOG is the part that is always checkable, and the release script
  // is what ties the tag to them.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json version is semver');

  // The first [x.y.z] heading in the CHANGELOG is the most recent release.
  const newest = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  assert.ok(newest, 'CHANGELOG must have a versioned heading');
  assert.equal(
    pkg.version,
    newest[1],
    `package.json says ${pkg.version} but the newest CHANGELOG entry is ${newest[1]}. ` +
      'Bump package.json in the same commit as the CHANGELOG entry, or a release reports ' +
      'a version nobody else agrees with.'
  );
});

test('the ROADMAP snapshot numbers still match the code', () => {
  // 快照上一次写于 2026-08-06，两天后就全面过期：src 从 1430 涨到 1708 行、测试从 313
  // 涨到 357 项、提交从 89 到 99。**没有任何东西在看着它**，而这个项目已经因为
  // 「文档数字悄悄失真」踩过三次（README 的「90000 字符可达」、「CPU < 1ms」、
  // 「chunk_size=300 约 13500 字符」）。
  //
  // 只钉**代码里查得到**的量：行数与测试项数。覆盖率、提交数、缺陷计数需要跑工具或查
  // git，那些在浅克隆/无 .git 的 tarball 里不可得（与版本一致性测试同一考量）。
  // 容差 ±10%：快照是「量级参考」而不是精确账本，太紧会让每次改动都要更新文档。
  const roadmap = readFileSync(new URL('../../ROADMAP.md', import.meta.url), 'utf8');
  const workerLines = readFileSync(new URL('../../src/worker.js', import.meta.url), 'utf8').split('\n').length;
  const uiLines = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8').split('\n').length;

  const snapshot = roadmap.split(/\n## /).find((s) => s.startsWith('项目现状快照'));
  assert.ok(snapshot, 'ROADMAP 必须有「项目现状快照」一节');

  // 用字面正则，别用 new RegExp 拼字符串 —— 第一版就是那样写的，转义在 heredoc 里翻倍，
  // 匹配不到任何东西，于是测试报「快照里必须写明行数」而快照其实写了。
  const m = /`src\/worker\.js` \*\*(\d+)\*\* 行 \+ `ui\/index\.html` \*\*(\d+)\*\*/.exec(snapshot);
  const pair = m ? [Number(m[1]), Number(m[2])] : null;
  assert.ok(pair, '快照里必须写明两个文件的行数，形如 `src/worker.js` **N** 行 + `ui/index.html` **M** 行');
  const [claimedWorker, claimedUi] = pair;

  const near = (a, b) => Math.abs(a - b) / b < 0.1;
  assert.ok(
    near(claimedWorker, workerLines),
    `快照说 src/worker.js 有 ${claimedWorker} 行，实际 ${workerLines} 行（偏差超过 10%）。` +
      '快照过期本身就是本项目踩过三次的老问题，请更新它。'
  );
  assert.ok(
    near(claimedUi, uiLines),
    `快照说 ui/index.html 有 ${claimedUi} 行，实际 ${uiLines} 行（偏差超过 10%）`
  );
});

test('the handoff doc exists, is linked, and its code map matches reality', () => {
  // docs/HANDOFF.md 是给接手者（含其他 Agent）的唯一入口，里面的错事实代价最高：
  // 读它的人会拿它当权威，而不会去核对。本项目已经三次交付过悄悄失真的文档数字
  // （README 的「90000 字符可达」、「CPU < 1ms」、「chunk_size 300 约 13500 字符」），
  // 所以这份也必须有东西盯着。
  //
  // 只钉两类可从代码推出的东西：代码地图里的行数，以及它被哪些文档引用（否则没人找得到）。
  // 覆盖率、提交数、测试项数需要跑工具或查 git，在浅克隆与无 .git 的 tarball 里不可得
  // —— 与版本一致性、快照那两个测试同一考量。
  const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
  const handoff = read('docs/HANDOFF.md');

  // 1. 必须回答「这是什么项目 / 现状 / 还剩什么 / 有哪些坑」这四件事。
  for (const heading of ['这是什么项目', '现在是什么状态', '刻意', '坑']) {
    assert.ok(handoff.includes(heading), `HANDOFF 必须有「${heading}」相关章节`);
  }

  // 2. 代码地图的行数必须与实际相符（容差 ±10%，它是量级参考不是账本）。
  //    行数用「换行符个数」计，与 wc -l 一致 —— split('\n').length 会多算末尾空串，
  //    我第一版校验脚本就是那样写的，四个文件全部差 1，看着像文档写错了。
  const lineCount = (rel) => read(rel).split('\n').length - 1;
  for (const [rel, label] of [['src/worker.js', 'src/worker.js'], ['ui/index.html', 'ui/index.html']]) {
    const actual = lineCount(rel);
    const row = handoff.split('\n').find((l) => l.includes('`' + label + '`') && /\|\s*\d{3,}\s*\|/.test(l));
    assert.ok(row, `HANDOFF 的代码地图里必须有 ${label} 及其行数`);
    const claimed = Number(/\|\s*(\d{3,})\s*\|/.exec(row)[1]);
    assert.ok(
      Math.abs(claimed - actual) / actual < 0.1,
      `HANDOFF 说 ${label} 有 ${claimed} 行，实际 ${actual} 行（偏差超 10%）——请更新代码地图`
    );
  }

  // 3. 必须从主要入口可达，否则等于不存在。
  for (const rel of ['README.md', 'README_CN.md', 'ROADMAP.md', 'CONTRIBUTING.md']) {
    assert.ok(
      read(rel).includes('HANDOFF.md'),
      `${rel} 必须链到 docs/HANDOFF.md —— 一份没人找得到的交接文档等于没写`
    );
  }
});

// ---------------------------------------------------------------------------
// 以下三条补的是上面三个测试**都没盯住**的字段。
//
// 2026-08-09 核对时，被盯住的字段（1708 / 2463 行）全部准确，而没被盯住的全部漂移了：
// 线上版本差 7 个版本、`npm test` 项数差 119、提交数差 3、测试行数差 41。
//
// 成因值得记：`9142` / 提交 `101` / 版本 `2.30.0` 这三个数字**在写下的那一刻都是对的**
// —— 是写它们的那个 commit 自己把它们推进了一格（新增测试 → 行数变；提交 +1；版本 +0.0.1）。
// **一份声明自身状态的文档，写完就过时了**，人工更新追不上这种自指。
//
// 判据沿用既有三个文档测试的约束：只钉**不跑工具、不依赖网络**就能得到的量。
// 覆盖率与缺陷计数因此仍不在守卫内 —— 那两个改用「去重」处理（只在一处写，别处指向它）。
// ---------------------------------------------------------------------------

const docsRoot = (rel) => new URL('../../' + rel, import.meta.url);
const readDoc = (rel) => readFileSync(docsRoot(rel), 'utf8');

test('the handoff doc header states the current package version', () => {
  // 直接抓本次踩到的那类错：HANDOFF 表头写 2.30.0 而 package.json 已是 2.30.1。
  // 接手者会拿表头当权威去判断「线上是否落后」，写错的代价是一次多余的部署。
  const pkg = JSON.parse(readDoc('package.json'));
  const handoff = readDoc('docs/HANDOFF.md');

  // 表头形如：> 最后更新：... · 对应版本 `2.30.2` · 线上 `v2.29.1`
  const m = /对应版本\s*`(\d+\.\d+\.\d+)`/.exec(handoff);
  assert.ok(m, 'HANDOFF 表头必须写明「对应版本 `x.y.z`」');
  assert.equal(
    m[1],
    pkg.version,
    `HANDOFF 表头说对应版本 ${m[1]}，而 package.json 是 ${pkg.version}。` +
      '同一个 commit 里一起改 —— 否则接手者会据此误判线上是否落后（本项目已踩过）。'
  );

  // §2 的代码块里还有一份 `package.json  x.y.z`，同样得跟上（重复的副本必须一起校验，
  // 否则去重不彻底就等于留了一个不会变红的错事实）。
  const block = /package\.json\s+(\d+\.\d+\.\d+)/.exec(handoff);
  assert.ok(block, 'HANDOFF §2 的代码块必须写明 package.json 的版本');
  assert.equal(
    block[1],
    pkg.version,
    `HANDOFF §2 代码块说 package.json 是 ${block[1]}，实际 ${pkg.version}`
  );
});

test('the docs agree with the real test-suite line count', () => {
  // 测试行数是「测试:源码 ≈ 2.2:1」这个论断的分子，写错会让读者高估或低估测试投入。
  // 用换行符个数计，与 wc -l 一致（split('\n').length 会多算末尾空串 —— 踩过）。
  // 含 helpers/：文档记的「23 个文件」正是 test/ 下全部 .mjs（四个用例目录只有 19 个），
  // 所以行数也必须同口径 —— 口径不一致的校验会把对的文档判成错的。
  const dirs = ['unit', 'integration', 'regression', 'e2e', 'helpers'];
  let actual = 0;
  let files = 0;
  for (const dir of dirs) {
    for (const f of readdirSync(docsRoot('test/' + dir)).filter((n) => n.endsWith('.mjs'))) {
      actual += readDoc(`test/${dir}/${f}`).split('\n').length - 1;
      files++;
    }
  }
  // 自检：荒谬的数字先怀疑探针本身，别怀疑文档（本项目的方法论第一条）。
  assert.ok(files > 10 && actual > 1000, `测试统计异常（${files} 文件 / ${actual} 行）—— 先查探针`);

  for (const [rel, label, rowKey] of [
    ['ROADMAP.md', 'ROADMAP 快照', '测试代码'],
    ['docs/HANDOFF.md', 'HANDOFF 代码地图', '个文件'],
  ]) {
    // 必须先定位到**那一行**再取数字：整篇搜 /(\d{4,})\s*行/ 会先撞上
    // 「`src/worker.js` **1708** 行」，于是拿源码行数去比测试行数、报出一个看着像
    // 文档写错的假失败。我第一版就是这么写的。
    const row = readDoc(rel).split('\n').find((l) => l.includes(rowKey) && /\d{4,}/.test(l));
    assert.ok(row, `${label} 必须有含测试代码行数的那一行（关键词「${rowKey}」）`);
    const claimed = Number(/(\d{4,})/.exec(row)[1]);
    assert.ok(
      Math.abs(claimed - actual) / actual < 0.1,
      `${label} 说测试代码 ${claimed} 行，实际 ${actual} 行（偏差超 10%）——请更新`
    );
  }
});

test('the docs agree with the real commit count', (t) => {
  // 提交数要查 git，而**浅克隆的 `rev-list --count` 给的是错数**（只有抓下来的那部分），
  // 无 .git 的 tarball 更是完全拿不到。那种情况下硬断言会让 CI 无故变红，
  // 所以显式 skip 并说明原因 —— 一个会误报的守卫比没有守卫更糟。
  // 既有三个文档测试刻意不查 git tag，正是同一考量。
  if (!existsSync(docsRoot('.git'))) {
    return t.skip('无 .git（tarball 或导出的源码包），提交数不可得');
  }
  let actual;
  let shallow;
  try {
    shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: docsRoot('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    actual = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: docsRoot('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    return t.skip('git 不可用或当前不是仓库，提交数不可得');
  }
  if (shallow === 'true') return t.skip('浅克隆的提交数是错的，跳过');
  assert.ok(Number.isFinite(actual) && actual > 0, `提交数统计异常（得到 ${actual}）`);

  // 容差 ±5：文档必然落后于「记录它的那个 commit 之后的几次提交」，这是自指造成的
  // 结构性滞后，不是失真。但差到 5 以上（本次 ROADMAP 差 3、HANDOFF 差 2 都还在容差内，
  // 而 `npm test` 项数差 119）就说明没人在更新了。
  for (const [rel, label] of [['ROADMAP.md', 'ROADMAP 快照'], ['docs/HANDOFF.md', 'HANDOFF 现状表']]) {
    const doc = readDoc(rel);
    const m = /\|\s*提交数?\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/.exec(doc);
    assert.ok(m, `${label} 必须有「提交数」一行`);
    assert.ok(
      Math.abs(Number(m[1]) - actual) <= 5,
      `${label} 说提交数 ${m[1]}，实际 ${actual}（差超过 5）——请更新`
    );
  }
});
