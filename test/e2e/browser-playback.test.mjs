// Browser e2e for the UI's playback path — driven by raw CDP, zero dependencies.
//
// Why this file matters: the worst bug this project ever had was streaming playback
// stopping after 1.67s (a partial MP3 Blob handed to <audio> decodes as a short but
// COMPLETE clip, so it fired `ended`). Until now that regression was only guarded by
// grepping the UI source for the removed `size > 10000` hack — a string check, never an
// actual playback. This test plays real audio in a real browser and asserts the whole
// duration gets scheduled.
//
// Skipped automatically when Chrome isn't available (e.g. a CI image without it), so it
// never turns into a red build on machines that can't run it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromeAvailable, launchChrome } from '../helpers/cdp.mjs';
import { startUiServer } from '../helpers/ui-server.mjs';

// Probing Chrome must itself be bounded. On a 2-core CI runner a browser that starts but
// never becomes controllable left this await hanging at module load, before any test
// registered — so the job showed no failure, no skip, just in_progress until the job-level
// timeout. Racing against a timer turns that into a clean skip with a reason.
const HAVE_CHROME = await Promise.race([
  chromeAvailable().catch(() => false),
  // unref() so the loser of the race cannot keep the process alive on its own.
  new Promise((r) => setTimeout(() => r(false), 30000).unref()),
]);
const SKIP = HAVE_CHROME ? false : 'Chrome unavailable or not launchable — browser e2e skipped';

const PCM_SECONDS = 3;   // well past the old 1.67s truncation point

let chrome = null;
let server = null;

before(async () => {
  if (!HAVE_CHROME) return;
  server = await startUiServer({ pcmSeconds: PCM_SECONDS, chunkMs: 200, chunkDelayMs: 10 });
  chrome = await launchChrome();
  await chrome.page.goto(server.url);
  await configureApp();
});

// generateSpeech() bails early unless baseUrl AND apiKey AND text are all non-empty
// (an empty string is falsy, so "same-origin" cannot be expressed as ''). It also
// concatenates baseUrl directly, so pass the real origin.
async function configureApp() {
  await chrome.page.evaluate(`(() => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    vm.config.baseUrl = ${JSON.stringify(server.url)};
    vm.config.apiKey = 'test-key';
    vm.form.inputText = 'browser playback regression check';
    return true;
  })()`);
}

after(async () => {
  if (chrome) await chrome.close();
  if (server) await server.close();
});

test('UI mounts and loads the voice list', { skip: SKIP }, async () => {
  const info = await chrome.page.evaluate(`(() => {
    const h1 = document.querySelector('h1');
    return {
      mustache: h1.textContent.includes('{{'),
      voices: document.querySelectorAll('.voice-item').length,
      hasToggle: !!document.querySelector('.theme-toggle'),
      hasCanvas: !!document.querySelector('.viz-canvas'),
    };
  })()`);
  assert.equal(info.mustache, false, 'Vue mounted (no raw mustaches)');
  assert.ok(info.voices > 0, 'voice list rendered');
  assert.ok(info.hasToggle && info.hasCanvas, 'theme toggle + visualiser present');
});

test('streaming playback schedules the FULL duration (no 1.67s truncation)', { skip: SKIP }, async () => {
  // Instrument AudioBufferSourceNode.start so we can measure exactly how much audio the
  // app scheduled — this is the honest signal. Byte counts alone wouldn't prove playback.
  // The counter must cover exactly ONE playback. It measures a total against an upper
  // bound of PCM_SECONDS * 1.1, so any earlier streaming on this page (the
  // download-extension test also calls generateSpeech(true)) would carry over and read
  // as "duplicated" — 3.00s becomes 6.00s, reproduced directly. Patch start() once, then
  // zero the counter immediately before the run being measured.
  await chrome.page.evaluate(`(() => {
    const proto = AudioBufferSourceNode.prototype;
    if (!proto.__schedPatched) {
      proto.__schedPatched = true;
      const origStart = proto.start;
      proto.start = function (when, ...rest) {
        try {
          if (this.buffer && window.__sched) {
            window.__sched.totalSeconds += this.buffer.duration;
            window.__sched.calls++;
            window.__sched.lastEnd = Math.max(window.__sched.lastEnd, (when || 0) + this.buffer.duration);
          }
        } catch (e) { /* never break playback for instrumentation */ }
        return origStart.call(this, when, ...rest);
      };
    }
    return true;
  })()`);

  // Kick off streaming playback through the app's own code path, with a fresh counter.
  await chrome.page.evaluate(`(() => {
    window.__sched = { totalSeconds: 0, calls: 0, lastEnd: 0 };
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    window.__done = vm.generateSpeech(true).then(() => 'ok', (e) => 'err: ' + e.message);
    return true;
  })()`);

  const outcome = await chrome.page.evaluate('window.__done');
  assert.equal(outcome, 'ok', 'generateSpeech(stream) resolved without error');

  const sched = await chrome.page.evaluate('window.__sched');
  assert.ok(sched.calls > 0, 'at least one buffer was scheduled');
  // The whole point: total scheduled audio must cover the full clip, not ~1.67s.
  assert.ok(
    sched.totalSeconds > PCM_SECONDS * 0.9,
    `scheduled ${sched.totalSeconds.toFixed(2)}s of ${PCM_SECONDS}s — truncated!`
  );
  assert.ok(
    sched.totalSeconds < PCM_SECONDS * 1.1,
    `scheduled ${sched.totalSeconds.toFixed(2)}s, more than the source — duplicated?`
  );
});

test('streaming forces PCM even when another format is selected', { skip: SKIP }, async () => {
  await chrome.page.evaluate(`(() => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    vm.form.responseFormat = 'mp3';       // user picked a container format
    window.__done2 = vm.generateSpeech(true).then(() => 'ok', (e) => 'err: ' + e.message);
    return true;
  })()`);
  assert.equal(await chrome.page.evaluate('window.__done2'), 'ok');
  // The server records what the app actually asked for.
  assert.equal(
    server.stats.lastBody.response_format,
    'pcm',
    'streaming overrides the chosen format to pcm (container formats cannot stream)'
  );
  assert.equal(server.stats.lastBody.stream, true);
});

test('the visualiser reacts to real audio (hue/sat driven by the signal)', { skip: SKIP }, async () => {
  const viz = await chrome.page.evaluate(`(async () => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    const samples = [];
    const t0 = Date.now();
    const p = vm.generateSpeech(true);
    while (Date.now() - t0 < 1500) {
      await new Promise((r) => setTimeout(r, 100));
      const d = vm.vizDebug;
      if (d && d.rms > 0.005) samples.push({ hue: d.hue, sat: d.sat, rms: d.rms, bias: d.bias });
    }
    await p.catch(() => {});
    return {
      n: samples.length,
      hues: samples.map((s) => Math.round(s.hue)),
      sats: samples.map((s) => Math.round(s.sat)),
      biases: samples.map((s) => s.bias),
      maxRms: samples.length ? Math.max(...samples.map((s) => s.rms)) : 0,
    };
  })()`);

  assert.ok(viz.n > 0, 'visualiser saw audible frames');
  assert.ok(viz.maxRms > 0.01, 'analyser measured real signal, got rms ' + viz.maxRms);
  // The meaningful claim is that colour is DERIVED FROM the audio, so it must actually
  // move as the signal changes — a constant hue would mean the mapping is dead. Asserting
  // a hard-coded band would just re-encode implementation constants.
  // These must be SEPARATE assertions. As `hueSpread > 0 || satSpread > 0` this passed
  // even with both hue drivers (spectral centroid → hue, f0 → hue bias) replaced by a
  // constant, because a moving saturation alone satisfied the `||`. The user would see a
  // soundwave whose colour never tracks the voice, and the suite stayed green.
  const hueSpread = Math.max(...viz.hues) - Math.min(...viz.hues);
  const satSpread = Math.max(...viz.sats) - Math.min(...viz.sats);
  assert.ok(
    hueSpread > 0,
    `hue never changed across ${viz.n} frames (hue ${viz.hues.join(',')}) — the centroid→hue mapping is dead`
  );
  assert.ok(
    satSpread > 0,
    `saturation never changed across ${viz.n} frames (sat ${viz.sats.join(',')}) — the crest→saturation mapping is dead`
  );
  // The f0 → hue-bias pathway is independent of the centroid, so it needs its own
  // assertion: the fixture sweeps its fundamental, so the per-voice bias must move.
  const biasSpread = Math.max(...viz.biases) - Math.min(...viz.biases);
  assert.ok(
    biasSpread > 0,
    `hue bias never changed across ${viz.n} frames (${viz.biases.join(',')}) — the f0→hue mapping is dead`
  );
  for (const s of viz.sats) {
    assert.ok(s > 0 && s <= 100, 'saturation is a valid percentage, got ' + s);
  }
});

test('object URLs are released between playbacks (no Blob leak)', { skip: SKIP }, async () => {
  // Found by audit: only downloadUrl was revoked. audioSrc got a fresh Object URL on
  // every standard playback and was never released (it was merely reassigned to ''),
  // so each run pinned a whole audio Blob until the page unloaded — a single-page app
  // basically never unloads. Measured 4 leaked URLs over 4 playbacks before the fix.
  const r = await chrome.page.evaluate(`(async () => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    let created = 0, revoked = 0;
    const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = function (b) { created++; return oc.call(URL, b); };
    URL.revokeObjectURL = function (u) { revoked++; return orv.call(URL, u); };
    for (let i = 0; i < 4; i++) {
      await vm.generateSpeech(false).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
    }
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    return { created, revoked, stillHeld: vm.audioSrc ? 1 : 0 };
  })()`);

  assert.ok(r.created >= 4, 'each playback created an object URL, got ' + r.created);
  // Exactly one may remain: the URL backing the audio that is still loaded.
  const leaked = r.created - r.revoked;
  assert.ok(
    leaked <= 1,
    `leaked ${leaked} object URLs across 4 playbacks (created ${r.created}, revoked ${r.revoked})`
  );
});

test('dark theme applies and its surfaces are genuinely dark', { skip: SKIP }, async () => {
  // The starting theme is NOT fixed: headless Chrome follows prefers-color-scheme, which
  // is dark on this macOS setup and light on the GitHub Linux runner. An earlier version
  // assumed it started dark, so on Linux the "toggle to light" branch never ran, nothing
  // was persisted, and the assertion saw localStorage null. Drive to light explicitly
  // (toggling only if needed), then to dark, so both transitions happen either way.
  const before = await chrome.page.evaluate(`(() => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    const read = () => document.documentElement.getAttribute('data-theme');
    // Reach a known state, then make a real toggle from it.
    if (read() !== 'dark') vm.toggleTheme();          // -> dark (whatever we started from)
    const dark0 = read();
    vm.toggleTheme();                                  // -> light, and persists
    const light = { theme: read(), stored: localStorage.getItem('tts_theme') };
    vm.toggleTheme();                                  // -> dark, and persists
    return { dark0, light, theme: read(), stored: localStorage.getItem('tts_theme') };
  })()`);
  assert.equal(before.dark0, 'dark', 'reached a known dark starting point');
  assert.equal(before.light.theme, 'light', 'toggled to light');
  assert.equal(before.light.stored, 'light', 'light persisted');
  assert.equal(before.theme, 'dark', 'toggled back to dark');
  assert.equal(before.stored, 'dark', 'dark persisted to localStorage');

  await chrome.page.goto(server.url);
  await configureApp();
  const after_ = await chrome.page.evaluate(`(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
  }))()`);
  assert.equal(after_.theme, 'dark', 'dark theme restored from localStorage after reload');
  // Guards the bug where dark mode still painted light surfaces.
  const rgb = after_.htmlBg.match(/\d+/g).map(Number);
  assert.ok(rgb[0] < 60 && rgb[1] < 60 && rgb[2] < 80, 'page base is genuinely dark: ' + after_.htmlBg);
});

test('a failed streaming request stops the visualiser RAF loop', { skip: SKIP }, async () => {
  // The visualiser's RAF loop was only cancelled from `source.onended`. When streaming
  // fails before a single AudioBufferSourceNode is scheduled (upstream 500, network
  // drop), that callback never fires and the loop kept re-arming itself at ~120fps,
  // burning CPU and battery until the tab was closed. Measured on the buggy build: the
  // vizRAF handle climbed from 3 to 101 within 800ms of the failure.
  //
  // Needs its own server whose /v1/audio/speech fails, so it does not disturb the
  // shared one used by the tests above.
  const failing = await startUiServer({ failSpeech: 500 });
  const page = chrome.page;
  try {
    await page.goto(failing.url);
    const out = await page.evaluate(`(async () => {
      const vm = document.querySelector('#app').__vue_app__._instance.proxy;
      vm.config.baseUrl = ${JSON.stringify(failing.url)};
      vm.config.apiKey = 'test-key';
      vm.form.inputText = 'this request is going to fail';
      // generateSpeech catches internally, so it resolves rather than rejecting.
      await vm.generateSpeech(true);
      const handleAtFailure = vm.vizRAF;
      const activeAtFailure = vm.vizActive;
      await new Promise((r) => setTimeout(r, 800));
      return {
        handleAtFailure,
        activeAtFailure,
        handleLater: vm.vizRAF,
        activeLater: vm.vizActive,
        isLoading: vm.isLoading,
        isStreaming: vm.isStreaming,
      };
    })()`);

    // A null handle and vizActive false both mean the loop is not re-arming. Comparing
    // the handle before/after the wait is the direct evidence: a live loop hands out a
    // new id every frame.
    assert.equal(out.handleLater, null, 'vizRAF must be cleared, got ' + out.handleLater);
    assert.equal(out.activeLater, false, 'vizActive must be false after a failure');
    assert.equal(
      out.handleAtFailure,
      out.handleLater,
      'the RAF handle changed during the wait — the loop is still spinning'
    );
    // The failure must also leave the UI usable rather than stuck in a loading state.
    assert.equal(out.isLoading, false, 'loading flag cleared');
    assert.equal(out.isStreaming, false, 'streaming flag cleared');
  } finally {
    await failing.close();
    // Restore the shared fixture for any test that runs after this one.
    await page.goto(server.url);
    await configureApp();
  }
});

test('the download filename extension matches the actual audio format', { skip: SKIP }, async () => {
  // Every download was named .mp3 regardless of format, so a WAV or Opus file arrived
  // with an extension that contradicts its container and desktop players refused it.
  // Streaming is a second case: the server sends raw PCM, and the UI converts it with
  // pcmToWav, so the correct extension is wav — not the format the user picked.
  const out = await chrome.page.evaluate(`(async () => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    const captured = [];
    // downloadAudio() creates an <a>, sets download, and clicks it. Intercept the click
    // so the browser does not actually try to save anything.
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { captured.push(this.download); };
    try {
      const results = {};
      for (const fmt of ['wav', 'opus', 'mp3']) {
        vm.form.responseFormat = fmt;
        await vm.generateSpeech(false);       // standard playback keeps the chosen format
        captured.length = 0;
        vm.downloadAudio();
        results['standard_' + fmt] = captured[0] || null;
      }
      // Streaming: forced to pcm on the wire, downloaded as wav.
      vm.form.responseFormat = 'mp3';
      await vm.generateSpeech(true);
      captured.length = 0;
      vm.downloadAudio();
      results.streaming = captured[0] || null;
      return results;
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  })()`);

  assert.ok(out.standard_wav?.endsWith('.wav'), 'wav download must be .wav, got ' + out.standard_wav);
  assert.ok(out.standard_opus?.endsWith('.opus'), 'opus download must be .opus, got ' + out.standard_opus);
  assert.ok(out.standard_mp3?.endsWith('.mp3'), 'mp3 download must be .mp3, got ' + out.standard_mp3);
  assert.ok(
    out.streaming?.endsWith('.wav'),
    'a streamed download is pcmToWav output, so it must be .wav, got ' + out.streaming
  );
});

test('a plain-text error body surfaces the real cause, not a JSON parse error', { skip: SKIP }, async () => {
  // Cloudflare's own failures (resource limits) come back as text/plain "error code: 1102",
  // not the Worker's JSON error shape. The UI called response.json() unconditionally, so
  // the user saw "Unexpected token e in JSON..." and the actual reason was hidden.
  const failing = await startUiServer({ failSpeech: 503, failSpeechPlainText: true });
  const page = chrome.page;
  try {
    await page.goto(failing.url);
    for (const stream of [false, true]) {
      const message = await page.evaluate(`(async () => {
        const vm = document.querySelector('#app').__vue_app__._instance.proxy;
        vm.config.baseUrl = ${JSON.stringify(failing.url)};
        vm.config.apiKey = 'test-key';
        vm.form.inputText = 'hello';
        await vm.generateSpeech(${stream});
        return vm.status && vm.status.message;
      })()`);
      assert.ok(message, 'stream=' + stream + ': an error was reported');
      assert.match(
        message,
        /1102/,
        'stream=' + stream + ': the upstream text must reach the user, got ' + message
      );
      assert.doesNotMatch(
        message,
        /JSON|Unexpected token/i,
        'stream=' + stream + ': a parse error must not replace the real cause, got ' + message
      );
      assert.match(message, /503/, 'stream=' + stream + ': the status code is kept too');
    }
  } finally {
    await failing.close();
    await page.goto(server.url);
    await configureApp();
  }
});

test('a JSON error body still yields the server message', { skip: SKIP }, async () => {
  // The tolerant path must not lose the good case: when the Worker does return its JSON
  // error shape, the human-readable message is what the user should see.
  const failing = await startUiServer({ failSpeech: 500 });
  const page = chrome.page;
  try {
    await page.goto(failing.url);
    const message = await page.evaluate(`(async () => {
      const vm = document.querySelector('#app').__vue_app__._instance.proxy;
      vm.config.baseUrl = ${JSON.stringify(failing.url)};
      vm.config.apiKey = 'test-key';
      vm.form.inputText = 'hello';
      await vm.generateSpeech(false);
      return vm.status && vm.status.message;
    })()`);
    assert.match(message, /stub failure/, 'the JSON error.message is used, got ' + message);
  } finally {
    await failing.close();
    await page.goto(server.url);
    await configureApp();
  }
});

test('the UI can still use Opus with text longer than the default chunk size', { skip: SKIP }, async () => {
  // Server-side, multi-chunk opus is refused (WebM concatenation restarts Cluster
  // timestamps). The UI sends no chunk_size, so it would inherit the server default of
  // 300 and every opus request over ~300 characters would fail — a regression introduced
  // by the guard itself. getRequestBody() therefore asks for the maximum chunk size when
  // opus is selected. This asserts the request the UI actually puts on the wire.
  const out = await chrome.page.evaluate(`(async () => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    vm.form.responseFormat = 'opus';
    vm.form.inputText = '这是一句用来触发多分块的中文文本。'.repeat(12); // 204 chars
    const opus = vm.getRequestBody();
    vm.form.responseFormat = 'mp3';
    const mp3 = vm.getRequestBody();
    return { opusChunk: opus.chunk_size, opusFormat: opus.response_format, mp3Chunk: mp3.chunk_size };
  })()`);
  assert.equal(out.opusFormat, 'opus');
  assert.equal(out.opusChunk, 2000, 'opus must request the maximum chunk size');
  assert.equal(out.mp3Chunk, undefined, 'other formats keep the server default');

  // And end to end: a long opus request must come back as audio, not a 400.
  const played = await chrome.page.evaluate(`(async () => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    vm.form.responseFormat = 'opus';
    vm.form.inputText = '这是一句用来触发多分块的中文文本。'.repeat(12);
    await vm.generateSpeech(false);
    return { status: String(vm.status && vm.status.message), sent: null };
  })()`);
  assert.doesNotMatch(
    played.status,
    /opus_requires_single_chunk|400/,
    'a UI user must not hit the single-chunk restriction, got ' + played.status
  );
  assert.equal(server.stats.lastBody.chunk_size, 2000, 'the server saw chunk_size=2000');

  await chrome.page.evaluate(`(() => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    vm.form.responseFormat = 'mp3';   // restore for later tests
    return true;
  })()`);
});
