// Integration: the full request-body validation table of POST /v1/audio/speech.
//
// Auth is taken out of the picture with ALLOW_ANONYMOUS=true (see auth tests for that
// surface), so every assertion here is about body validation: which inputs are rejected,
// with which HTTP status *and* which machine-readable `error.code`, and — just as
// important — that a rejected request never reaches the upstream (token/synth stay at 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test__ } from '../../src/worker.js';
import { installMockFetch, speechRequest } from '../helpers/mock-upstream.mjs';

const ANON = { ALLOW_ANONYMOUS: 'true' };

// One synthesis call in the mock returns fakeAudio(100) = 100ms * 48 B/ms.
const CHUNK_BYTES = 4800;

// Every test needs the same install/reset/restore dance; funnel it through one helper so
// a forgotten restore() can't leak a patched globalThis.fetch into the next test.
async function withMock(fn, opts = {}) {
  __test__.resetTokenCache();
  const mock = installMockFetch(opts);
  try {
    return await fn(mock);
  } finally {
    mock.restore();
  }
}

// Assert a rejected request: status, error.code, OpenAI-ish error envelope, and that no
// upstream request was made (a validation failure must be decided locally).
async function expectReject(body, status, code, mock) {
  const res = await worker.fetch(speechRequest(body), ANON, {});
  assert.equal(res.status, status, `status for ${JSON.stringify(body).slice(0, 120)}`);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const json = await res.json();
  assert.equal(json.error.code, code, `error.code for ${JSON.stringify(body).slice(0, 120)}`);
  assert.equal(json.error.type, 'api_error');
  assert.equal(json.error.param, null);
  assert.equal(typeof json.error.message, 'string');
  assert.ok(json.error.message.length > 0, 'error.message is non-empty');
  if (mock) {
    assert.equal(mock.calls.synth, 0, 'no synthesis call on validation failure');
    assert.equal(mock.calls.token, 0, 'no token fetch on validation failure');
  }
  return json;
}

// ---------------------------------------------------------------- input presence / type

test('input: missing / empty / whitespace / wrong type -> 400 invalid_request_error', async () => {
  await withMock(async (mock) => {
    const bodies = [
      {},                          // absent
      { input: '' },               // empty string
      { input: '   \n\t  ' },      // whitespace only
      { input: 123 },              // number
      { input: true },             // boolean
      { input: null },             // null
      { input: ['hi'] },           // array
      { input: { text: 'hi' } },   // object
    ];
    for (const body of bodies) {
      await expectReject(body, 400, 'invalid_request_error', mock);
    }
  });
});

test('input: JSON null / array body -> 400 invalid_request_error (no crash)', async () => {
  await withMock(async (mock) => {
    for (const raw of ['null', '[]', '"just a string"', '42']) {
      const res = await worker.fetch(speechRequest(raw), ANON, {});
      assert.equal(res.status, 400, `raw body ${raw}`);
      const json = await res.json();
      assert.equal(json.error.code, 'invalid_request_error');
    }
    assert.equal(mock.calls.synth, 0);
  });
});

test('body: malformed JSON -> 400 invalid_request_error', async () => {
  await withMock(async (mock) => {
    for (const raw of ['{not json', '', '{"input": }', '{"input": "hi",}']) {
      const res = await worker.fetch(speechRequest(raw), ANON, {});
      assert.equal(res.status, 400, `raw body ${JSON.stringify(raw)}`);
      const json = await res.json();
      assert.equal(json.error.code, 'invalid_request_error');
      assert.match(json.error.message, /JSON/);
    }
    assert.equal(mock.calls.token, 0);
    assert.equal(mock.calls.synth, 0);
  });
});

// ---------------------------------------------------------------- input length bounds

test('input: 50001 chars -> 400 input_too_long with both numbers in the message', async () => {
  await withMock(async (mock) => {
    const tooLong = 'a'.repeat(__test__.LIMITS.MAX_INPUT_CHARS + 1);
    const json = await expectReject({ input: tooLong }, 400, 'input_too_long', mock);
    assert.match(json.error.message, /50001/);
    assert.match(json.error.message, /50000/);
  });
});

test('input: exactly 50000 chars is accepted (boundary is inclusive)', async () => {
  await withMock(async (mock) => {
    const atLimit = 'a'.repeat(__test__.LIMITS.MAX_INPUT_CHARS);
    const res = await worker.fetch(
      speechRequest({ input: atLimit, voice: 'en-US-AvaNeural', chunk_size: 2000 }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    // 50000 unpunctuated chars / 2000 per chunk = 25 chunks, one synth call each.
    assert.equal(mock.calls.synth, 25);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.equal(buf.byteLength, 25 * CHUNK_BYTES);
  });
});

test('input: non-empty but empty after cleaning -> 400 input_empty_after_cleaning', async () => {
  await withMock(async (mock) => {
    // remove_urls is on by default, so a URL-only input cleans down to "".
    await expectReject({ input: 'https://example.com/a/b?c=1' }, 400, 'input_empty_after_cleaning', mock);
  });
});

// ---------------------------------------------------------------- response_format

test('response_format: aac / flac / ogg / unknown -> 400 invalid_response_format', async () => {
  await withMock(async (mock) => {
    for (const fmt of ['aac', 'flac', 'ogg', 'AAC', 'mp3 ', 'webm', 'toString']) {
      const json = await expectReject(
        { input: 'hello', voice: 'en-US-AvaNeural', response_format: fmt },
        400,
        'invalid_response_format',
        mock
      );
      // The message must enumerate the four supported formats.
      assert.match(json.error.message, /mp3 \| pcm \| opus \| wav/);
    }
  });
});

test('response_format: non-string values -> 400 invalid_response_format', async () => {
  await withMock(async (mock) => {
    // Note the omission of ['mp3'] — see the coercion test below.
    for (const fmt of [null, 123, true, ['mp3', 'wav'], [], { f: 'mp3' }]) {
      await expectReject(
        { input: 'hello', voice: 'en-US-AvaNeural', response_format: fmt },
        400,
        'invalid_response_format',
        mock
      );
    }
  });
});

test('response_format: ["mp3"] is coerced to the "mp3" key by Object.hasOwn (documented laxness)', async () => {
  // Object.hasOwn(map, ['mp3']) does ToPropertyKey(['mp3']) === "mp3", so a single-element
  // array slips past the format allowlist. Pinning it because it is benign today — the
  // same coercion makes FORMAT_MAP/CONTENT_TYPE_MAP lookups resolve to correct mp3 values —
  // but a future refactor that stops coercing would change the status from 200 to 400.
  await withMock(async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hello', voice: 'en-US-AvaNeural', response_format: ['mp3'] }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(mock.calls.synth, 1);
  });
});

test('response_format: mp3 / opus / pcm / wav all pass with the right Content-Type', async () => {
  const expected = {
    mp3: ['audio/mpeg', 'audio-24khz-48kbitrate-mono-mp3'],
    opus: ['audio/webm', 'webm-24khz-16bit-mono-opus'],
    pcm: ['audio/pcm', 'raw-24khz-16bit-mono-pcm'],
    wav: ['audio/wav', 'riff-24khz-16bit-mono-pcm'],
  };
  for (const [fmt, [contentType, upstreamFormat]] of Object.entries(expected)) {
    // The X-Microsoft-OutputFormat header is only observable on the outgoing synthesis
    // request, so capture it from the mock's synth hook.
    let seenFormat = null;
    await withMock(
      async (mock) => {
        const res = await worker.fetch(
          speechRequest({ input: 'hello world', voice: 'en-US-AvaNeural', response_format: fmt }),
          ANON,
          {}
        );
        assert.equal(res.status, 200, `format ${fmt}`);
        assert.equal(res.headers.get('content-type'), contentType, `Content-Type for ${fmt}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        assert.equal(buf.byteLength, CHUNK_BYTES, `bytes for ${fmt}`);
        assert.equal(mock.calls.token, 1);
        assert.equal(mock.calls.synth, 1);
        assert.equal(seenFormat, upstreamFormat, `X-Microsoft-OutputFormat for ${fmt}`);
      },
      { synth: ({ format }) => { seenFormat = format; return { status: 200 }; } }
    );
  }
});

test('response_format: default (omitted) is mp3', async () => {
  await withMock(async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hello world', voice: 'en-US-AvaNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(mock.calls.synth, 1);
  });
});

// ---------------------------------------------------------------- voice

test('voice: SSML/XML injection strings -> 400 invalid_voice', async () => {
  await withMock(async (mock) => {
    const injections = [
      'zh-CN-XiaoxiaoNeural" /><voice name="x',
      'zh-CN-XiaoxiaoNeural"><audio src="http://evil/x.mp3"/><voice name="y',
      "zh-CN-XiaoxiaoNeural' /><break time='9999ms'/>",
      'zh-CN-Xiaoxiao<Neural',
      'zh-CN-Xiaoxiao&Neural',
      'zh-CN-Xiaoxiao Neural',   // space
      'zh_CN_XiaoxiaoNeural',    // underscores
      'zh-CN-XiaoxiaoNeural\n',  // trailing newline (anchors must be strict)
      '../../etc/passwd',
      '',
      'x',                       // too short for the 2-3 letter language head
      'zh',                      // no segments
      'zh-CN-' + 'a'.repeat(41), // segment longer than 40 chars
    ];
    for (const voice of injections) {
      await expectReject({ input: 'hello', voice }, 400, 'invalid_voice', mock);
    }
  });
});

test('voice: non-string and prototype-key values -> 400 invalid_voice', async () => {
  await withMock(async (mock) => {
    // "toString"/"constructor"/"__proto__" resolve to inherited members of the alias map;
    // the typeof guard must catch them instead of interpolating a function into the SSML.
    for (const voice of [123, null, ['en-US-AvaNeural'], 'toString', 'constructor', '__proto__']) {
      await expectReject({ input: 'hello', voice }, 400, 'invalid_voice', mock);
    }
  });
});

test('voice: real Microsoft names (incl. 4-segment regional) pass and reach the SSML', async () => {
  for (const voice of [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-liaoning-XiaobeiNeural',
    'en-US-AvaMultilingualNeural',
    'wuu-CN-XiaotongNeural', // 3-letter language code
  ]) {
    await withMock(async (mock) => {
      const res = await worker.fetch(speechRequest({ input: 'hello', voice }), ANON, {});
      assert.equal(res.status, 200, `voice ${voice}`);
      assert.equal(mock.calls.synth, 1);
      assert.equal(mock.calls.synthSsml.length, 1);
      assert.ok(
        mock.calls.synthSsml[0].includes(`<voice name="${voice}">`),
        `SSML carries voice ${voice}`
      );
    });
  }
});

test('voice: OpenAI aliases resolve to the mapped Microsoft voice in the SSML', async () => {
  const aliases = {
    shimmer: 'zh-CN-XiaoxiaoNeural',
    alloy: 'zh-CN-YunyangNeural',
    fable: 'zh-CN-YunjianNeural',
    onyx: 'zh-CN-XiaoyiNeural',
    nova: 'zh-CN-YunxiNeural',
    echo: 'zh-CN-liaoning-XiaobeiNeural',
  };
  for (const [alias, real] of Object.entries(aliases)) {
    await withMock(async (mock) => {
      const res = await worker.fetch(speechRequest({ input: '你好', voice: alias }), ANON, {});
      assert.equal(res.status, 200, `alias ${alias}`);
      assert.equal(mock.calls.synth, 1);
      const ssml = mock.calls.synthSsml[0];
      assert.ok(ssml.includes(`<voice name="${real}">`), `${alias} -> ${real} in SSML`);
      assert.ok(!ssml.includes(`name="${alias}"`), `raw alias ${alias} not sent upstream`);
    });
  }
});

test('voice: omitted defaults to the shimmer alias -> zh-CN-XiaoxiaoNeural', async () => {
  await withMock(async (mock) => {
    const res = await worker.fetch(speechRequest({ input: '你好' }), ANON, {});
    assert.equal(res.status, 200);
    assert.equal(mock.calls.synth, 1);
    assert.ok(mock.calls.synthSsml[0].includes('<voice name="zh-CN-XiaoxiaoNeural">'));
  });
});

test('voice: unknown-but-well-formed name is passed through (server does not gatekeep the catalog)', async () => {
  await withMock(async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hello', voice: 'xx-YY-NotARealNeural' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.ok(mock.calls.synthSsml[0].includes('<voice name="xx-YY-NotARealNeural">'));
  });
});

test('model: an explicit valid voice wins over a tts-1-<alias> model', async () => {
  // An explicitly requested real voice must not be silently replaced by a model-derived
  // alias. en-US-AvaNeural + model tts-1-shimmer must synthesize en-US-AvaNeural.
  await withMock(async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', model: 'tts-1-shimmer' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.ok(
      mock.calls.synthSsml[0].includes('<voice name="en-US-AvaNeural">'),
      'explicit voice wins over the model alias'
    );
  });
});

test('model: alias in `model` is reachable when no explicit voice is given', async () => {
  // With voice omitted, a model alias should select its mapped voice. tts-1-alloy → Yunyang.
  await withMock(async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: '', model: 'tts-1-alloy' }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.ok(
      mock.calls.synthSsml[0].includes('<voice name="zh-CN-YunyangNeural">'),
      'model alias tts-1-alloy resolves to Yunyang'
    );
  });
});

test('model: non-string does not crash and falls back to the default voice', async () => {
  // A non-string model must not throw (no leaked "model.replace is not a function" 500).
  // It is simply ignored; voice resolution falls back to the default alias "shimmer".
  await withMock(async (mock) => {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', model: 123 }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
    assert.ok(mock.calls.synthSsml[0].includes('<voice name="zh-CN-XiaoxiaoNeural">'));
  });
});

// ---------------------------------------------------------------- style

test('style: illegal values -> 400 invalid_style', async () => {
  await withMock(async (mock) => {
    const bad = [
      'Cheerful',                  // uppercase
      'cheerful"/>',               // attribute break-out
      'cheerful sad',              // space
      'cheerful_sad',              // underscore
      '1cheerful',                 // must start with a letter
      '',                          // empty
      '-cheerful',                 // leading hyphen
      'a'.repeat(32),              // 32 chars > 1+30 allowed
      'cheerful\n',                // trailing newline
      '中文',
    ];
    for (const style of bad) {
      await expectReject({ input: 'hello', voice: 'en-US-AvaNeural', style }, 400, 'invalid_style', mock);
    }
  });
});

test('style: non-string values -> 400 invalid_style', async () => {
  await withMock(async (mock) => {
    for (const style of [1, null, ['sad'], { s: 'sad' }, true]) {
      await expectReject({ input: 'hello', voice: 'en-US-AvaNeural', style }, 400, 'invalid_style', mock);
    }
  });
});

test('style: legal values pass and land in mstts:express-as', async () => {
  for (const style of ['general', 'cheerful', 'newscast-casual', 'a', 'a'.repeat(31)]) {
    await withMock(async (mock) => {
      const res = await worker.fetch(
        speechRequest({ input: 'hello', voice: 'en-US-AvaNeural', style }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, `style ${style}`);
      assert.ok(
        mock.calls.synthSsml[0].includes(`<mstts:express-as style="${style}">`),
        `SSML carries style ${style}`
      );
    });
  }
});

// ---------------------------------------------------------------- speed

test('speed: out of range / non-numeric -> 400 invalid_speed', async () => {
  await withMock(async (mock) => {
    for (const speed of [0, 0.24, -1, 4.01, 5, 100, 'abc', NaN, null, {}, [1, 2], Infinity, -Infinity]) {
      await expectReject({ input: 'hello', voice: 'en-US-AvaNeural', speed }, 400, 'invalid_speed', mock);
    }
  });
});

test('speed: boundaries 0.25 and 4 pass and map onto prosody rate', async () => {
  const cases = [
    [0.25, '-75'],
    [1, '0'],
    [4, '300'],
    ['2', '100'], // numeric string is coerced, not rejected
  ];
  for (const [speed, rate] of cases) {
    await withMock(async (mock) => {
      const res = await worker.fetch(
        speechRequest({ input: 'hello', voice: 'en-US-AvaNeural', speed }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, `speed ${speed}`);
      assert.ok(
        mock.calls.synthSsml[0].includes(`rate="${rate}%"`),
        `speed ${speed} -> rate ${rate}% (got ${mock.calls.synthSsml[0].match(/rate="[^"]*"/)?.[0]})`
      );
    });
  }
});

// ---------------------------------------------------------------- pitch

test('pitch: out of range / non-numeric -> 400 invalid_pitch', async () => {
  await withMock(async (mock) => {
    for (const pitch of [0, 0.49, -1, 1.51, 2, 'abc', NaN, null, {}, Infinity]) {
      await expectReject({ input: 'hello', voice: 'en-US-AvaNeural', pitch }, 400, 'invalid_pitch', mock);
    }
  });
});

test('pitch: boundaries 0.5 and 1.5 pass and map onto prosody pitch', async () => {
  const cases = [
    [0.5, '-50'],
    [1, '0'],
    [1.5, '50'],
  ];
  for (const [pitch, expected] of cases) {
    await withMock(async (mock) => {
      const res = await worker.fetch(
        speechRequest({ input: 'hello', voice: 'en-US-AvaNeural', pitch }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, `pitch ${pitch}`);
      assert.ok(
        mock.calls.synthSsml[0].includes(`pitch="${expected}%"`),
        `pitch ${pitch} -> ${expected}%`
      );
    });
  }
});

// ---------------------------------------------------------------- precedence

test('validation order: input checks run before voice/style/speed/pitch/format checks', async () => {
  await withMock(async (mock) => {
    // Everything is wrong at once; `input` must win because it is checked first.
    await expectReject(
      { voice: 'bad voice', style: 'BAD', speed: 99, pitch: 99, response_format: 'aac' },
      400,
      'invalid_request_error',
      mock
    );
    // With a valid input, voice is reported before style/speed/pitch/format.
    await expectReject(
      { input: 'hi', voice: 'bad voice', style: 'BAD', speed: 99, pitch: 99, response_format: 'aac' },
      400,
      'invalid_voice',
      mock
    );
    // Then style.
    await expectReject(
      { input: 'hi', voice: 'en-US-AvaNeural', style: 'BAD', speed: 99, pitch: 99, response_format: 'aac' },
      400,
      'invalid_style',
      mock
    );
    // Then speed, then pitch, then format.
    await expectReject(
      { input: 'hi', voice: 'en-US-AvaNeural', speed: 99, pitch: 99, response_format: 'aac' },
      400,
      'invalid_speed',
      mock
    );
    await expectReject(
      { input: 'hi', voice: 'en-US-AvaNeural', pitch: 99, response_format: 'aac' },
      400,
      'invalid_pitch',
      mock
    );
    await expectReject(
      { input: 'hi', voice: 'en-US-AvaNeural', response_format: 'aac' },
      400,
      'invalid_response_format',
      mock
    );
  });
});

test('validation failures still carry permissive CORS headers', async () => {
  await withMock(async () => {
    const res = await worker.fetch(speechRequest({ input: '' }), ANON, {});
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  });
});

test('GET /v1/audio/speech -> 405 method_not_allowed (validation is POST-only)', async () => {
  await withMock(async (mock) => {
    const res = await worker.fetch(
      new Request('https://tts.test/v1/audio/speech', { method: 'GET' }),
      ANON,
      {}
    );
    assert.equal(res.status, 405);
    const json = await res.json();
    assert.equal(json.error.code, 'method_not_allowed');
    assert.equal(mock.calls.synth, 0);
  });
});

// cleaning_options.custom_keywords is split with String.prototype.split, so a non-string
// threw TypeError, escaped to the outermost catch, and the caller got a 500
// internal_server_error for what is plainly a bad request.
test('a non-string custom_keywords is a 400, not a 500', async () => {
  for (const bad of [123, ['a'], { a: 1 }, true]) {
    __test__.resetTokenCache();
    const mock = installMockFetch();
    try {
      const res = await worker.fetch(
        speechRequest({
          input: 'hi',
          voice: 'en-US-AvaNeural',
          cleaning_options: { custom_keywords: bad },
        }),
        ANON,
        {}
      );
      assert.equal(res.status, 400, JSON.stringify(bad) + ' must be a caller error');
      const json = await res.json();
      assert.equal(json.error.code, 'invalid_cleaning_options');
      // Name the offending type, so the caller does not have to guess.
      assert.match(json.error.message, new RegExp(typeof bad));
      assert.equal(mock.calls.synth, 0, 'rejected before reaching upstream');
    } finally {
      mock.restore();
    }
  }
});

test('a string custom_keywords still works, and omitting it is fine', async () => {
  for (const value of ['广告,推广', '']) {
    __test__.resetTokenCache();
    const mock = installMockFetch();
    try {
      const res = await worker.fetch(
        speechRequest({
          input: '这是广告内容',
          voice: 'en-US-AvaNeural',
          cleaning_options: { custom_keywords: value },
        }),
        ANON,
        {}
      );
      assert.equal(res.status, 200, JSON.stringify(value) + ' is valid');
    } finally {
      mock.restore();
    }
  }
  // Omitted entirely.
  __test__.resetTokenCache();
  const mock = installMockFetch();
  try {
    const res = await worker.fetch(
      speechRequest({ input: 'hi', voice: 'en-US-AvaNeural', cleaning_options: {} }),
      ANON,
      {}
    );
    assert.equal(res.status, 200);
  } finally {
    mock.restore();
  }
});
