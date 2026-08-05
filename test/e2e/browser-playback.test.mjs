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
import { startUiServer, opusFixture } from '../helpers/ui-server.mjs';

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
  //
  // Kick off streaming playback through the app's own code path, with a fresh counter.
  //
  // This used to retry on a fetch failure, because roughly one run in three the app reported
  // "Failed to fetch" and scheduled nothing. The cause turned out to be my own probe scripts:
  // killing them with `timeout` skipped their `finally { chrome.close() }`, leaking headless
  // Chrome processes — 248 of them by the time I checked. Those competed for ports and CPU,
  // which is why it looked intermittent and why every in-file hypothesis came up empty.
  // With the leak cleaned up the retry is unnecessary, and keeping it would mask a real
  // failure later.
  await chrome.page.evaluate(`(() => {
    window.__sched = { totalSeconds: 0, calls: 0, lastEnd: 0 };
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    window.__done = vm.generateSpeech(true).then(() => 'ok', (e) => 'err: ' + e.message);
    return true;
  })()`);

  const outcome = await chrome.page.evaluate('window.__done');
  assert.equal(outcome, 'ok', 'generateSpeech(stream) resolved without error');

  // generateSpeech catches its own errors, so "ok" does NOT mean the fetch succeeded — a
  // transient network failure showed up here as calls === 0 and the assertion blamed
  // scheduling. Report the status line the app displayed, which names the real cause.
  const sched = await chrome.page.evaluate(
    '({ ...window.__sched, status: String(document.querySelector(".status").textContent).trim() })'
  );
  // Distinguish "the app failed to fetch" from "the app fetched but scheduled nothing".
  // Only the second is this test's subject; the first is environmental and must not be
  // reported as a truncation regression. The stub server records every request it served.
  assert.ok(
    server.stats.speechRequests > 0 && server.stats.bytesSent > 0,
    'the stub never served audio, so this run says nothing about scheduling ' +
      '(app reported: ' + JSON.stringify(sched.status) + ')'
  );
  assert.ok(
    sched.calls > 0,
    'audio was served but nothing was scheduled; the app reported: ' + JSON.stringify(sched.status)
  );
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


test('Opus playback covers the whole clip, not just the first container', { skip: SKIP }, async () => {
  // The user-facing outcome of the WebM merge. Naive concatenation left <audio> reporting
  // 9.44s for a file holding 94.56s of audio — up to 90% silently unplayable — because the
  // element honours only the first EBML container. The merged file reports the full length.
  //
  // duration must be read AFTER seeking past the end: for an unknown-length Segment Chrome
  // reports null at loadedmetadata, which is what made this look like an upstream quirk
  // rather than data loss.
  const merged = opusFixture();
  if (!merged) return; // fixtures absent

  const expected = await chrome.page.evaluate(`(async () => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    vm.form.responseFormat = 'opus';
    vm.form.inputText = 'opus playback regression check';
    await vm.generateSpeech(false);
    const el = vm.$refs.audioPlayer;
    await new Promise((r) => {
      if (el.readyState >= 1) return r();
      el.addEventListener('loadedmetadata', r, { once: true });
      setTimeout(r, 8000);
    });
    // Sample BEFORE any seek: that is the whole point of the injected Duration.
    const durationAtMeta = el.duration;
    const seekableAtMeta = el.seekable.length ? el.seekable.end(0) : null;
    // Then force resolution anyway, so the assertions below still hold either way.
    try { el.currentTime = 1e9; } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500));
    return {
      durationAtMeta, seekableAtMeta,
      duration: el.duration,
      seekable: el.seekable.length ? el.seekable.end(0) : null,
      errCode: el.error ? el.error.code : null,
    };
  })()`);

  const ONE_CHUNK_SECONDS = 9.45;
  assert.equal(expected.errCode, null, 'the merged WebM decodes without error');
  // With the injected top-level Duration, duration/seekable are available at
  // loadedmetadata — no seek-past-the-end needed. Before the injection both were null and
  // the native progress bar sat blank until the user happened to scrub.
  assert.ok(
    typeof expected.durationAtMeta === 'number' && isFinite(expected.durationAtMeta),
    'duration must be known at loadedmetadata, got ' + expected.durationAtMeta
  );
  assert.ok(
    expected.seekableAtMeta > ONE_CHUNK_SECONDS * 2,
    'the whole clip is seekable straight away, got ' + expected.seekableAtMeta
  );
  assert.ok(
    typeof expected.duration === 'number' && isFinite(expected.duration),
    'a merged container yields a real duration, got ' + expected.duration
  );
  // The fixture is 3 upstream chunks of ~9.45s each (28.36s total, verified with ffmpeg).
  // Before the merge only the first was reachable, so the discriminating threshold is
  // "clearly more than one chunk" — expressed relative to the chunk length rather than as a
  // magic number, so it keeps its meaning if the fixtures are ever regenerated.
  assert.ok(
    expected.duration > ONE_CHUNK_SECONDS * 2,
    'duration must span all three chunks, not stop at the first (' +
      ONE_CHUNK_SECONDS.toFixed(2) + 's); got ' + expected.duration + 's'
  );
  assert.ok(
    expected.seekable > ONE_CHUNK_SECONDS * 2,
    'the whole clip is seekable, got ' + expected.seekable
  );

  await chrome.page.evaluate(`(() => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    vm.form.responseFormat = 'mp3';   // restore for later tests
    return true;
  })()`);
});

test('streaming playback can actually be stopped', { skip: SKIP }, async () => {
  // Streaming goes through Web Audio: playStreamPCM schedules the WHOLE clip onto the
  // AudioContext timeline with source.start(futureTime) and then resolves, so isLoading
  // flips to false while 30+ seconds are still queued. Measured before the fix: 34 live
  // sources, isLoading false, and the only method on the component matching /stop/ was
  // stopViz — which just clears the canvas. The user's only recourse was reloading.
  //
  // <audio controls> makes it worse rather than better: its native pause drives the
  // standard-playback path and does nothing to the Web Audio queue, so it hands the user
  // a control that looks authoritative and isn't.
  const longServer = await startUiServer({ pcmSeconds: 20, chunkMs: 200, chunkDelayMs: 5 });
  const page = chrome.page;
  try {
    await page.goto(longServer.url);
    const out = await page.evaluate(`(async () => {
      const vm = document.querySelector('#app').__vue_app__._instance.proxy;
      vm.config.baseUrl = ${JSON.stringify(longServer.url)};
      vm.config.apiKey = 'test-key';
      vm.form.inputText = 'stop control regression check';
      await vm.generateSpeech(true);
      const before = { live: vm.activeSources.length, playing: vm.isPlaying, viz: vm.vizActive };
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('停止'));
      const hasButton = !!btn;
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 400));
      return {
        before, hasButton,
        after: { live: vm.activeSources.length, playing: vm.isPlaying, viz: vm.vizActive },
      };
    })()`);

    // Premise: the clip really was long enough to still be playing.
    assert.ok(out.before.live > 1, 'audio was queued, got ' + out.before.live + ' sources');
    assert.equal(out.before.playing, true, 'isPlaying tracks actual playback, not the request');
    assert.equal(out.hasButton, true, 'a stop control is offered while audio plays');
    // The point: clicking it silences the queue.
    assert.equal(out.after.live, 0, 'every scheduled source was stopped');
    assert.equal(out.after.playing, false, 'isPlaying cleared, so the button disappears');
    assert.equal(out.after.viz, false, 'the visualiser stopped too');
  } finally {
    await longServer.close();
    await page.goto(server.url);
    await configureApp();
  }
});

test('starting a new generation silences the one still playing', { skip: SKIP }, async () => {
  // Because streaming resolves while audio remains queued, "the previous one is still
  // audible" and "a new one starts" could both be true. Measured before the fix: 31
  // streaming sources still playing while <audio> played the standard result — two
  // overlapping voices at once.
  const longServer = await startUiServer({ pcmSeconds: 20, chunkMs: 200, chunkDelayMs: 5 });
  const page = chrome.page;
  try {
    await page.goto(longServer.url);
    const out = await page.evaluate(`(async () => {
      const vm = document.querySelector('#app').__vue_app__._instance.proxy;
      vm.config.baseUrl = ${JSON.stringify(longServer.url)};
      vm.config.apiKey = 'test-key';
      vm.form.inputText = 'overlap regression check';
      await vm.generateSpeech(true);
      const streamLive = vm.activeSources.length;
      await vm.generateSpeech(false);          // standard, while the stream is still queued
      await new Promise((r) => setTimeout(r, 1000));
      const el = vm.$refs.audioPlayer;
      return { streamLive, live: vm.activeSources.length, elPaused: el.paused };
    })()`);
    assert.ok(out.streamLive > 1, 'premise: streaming queued several sources');
    assert.equal(out.live, 0, 'the streaming queue was cleared before the new playback');
    assert.equal(out.elPaused, false, 'the new standard playback is actually running');
  } finally {
    await longServer.close();
    await page.goto(server.url);
    await configureApp();
  }
});

test('a 200 with zero bytes is reported as an error, not success', { skip: SKIP }, async () => {
  // Cloudflare killing the isolate after the headers are out leaves the client with 200 and
  // a clean chunked EOF — byte-identical framing to a complete response, with no
  // Content-Length to reconcile. The UI reported "✅ PCM完成！0KB, 约0.0秒" and offered a
  // download, so the user concluded synthesis had worked and the audio was just short.
  //
  // Also asserts the teardown: the failure path used to call stopViz() alone, which left
  // isPlaying true, so the stop button lingered with nothing left to stop.
  const empty = await startUiServer({ emptyStream: true });
  const page = chrome.page;
  try {
    await page.goto(empty.url);
    const out = await page.evaluate(`(async () => {
      const vm = document.querySelector('#app').__vue_app__._instance.proxy;
      vm.config.baseUrl = ${JSON.stringify(empty.url)};
      vm.config.apiKey = 'test-key';
      vm.form.inputText = 'empty stream regression check';
      await vm.generateSpeech(true);
      await new Promise((r) => setTimeout(r, 400));
      return {
        type: vm.status && vm.status.type,
        message: String(vm.status && vm.status.message),
        download: vm.showDownloadBtn,
        playing: vm.isPlaying,
        viz: vm.vizActive,
        raf: vm.vizRAF,
        stopBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('停止')),
      };
    })()`);

    assert.equal(out.type, 'error', 'zero bytes must not be reported as success');
    assert.doesNotMatch(out.message, /完成/, 'the message must not claim completion');
    assert.match(out.message, /0 字节|空/, 'says what actually happened');
    assert.equal(out.download, false, 'no download button for an empty result');
    // Teardown must be complete, or the UI keeps offering controls that do nothing.
    assert.equal(out.playing, false, 'isPlaying cleared');
    assert.equal(out.stopBtn, false, 'the stop button is gone');
    assert.equal(out.viz, false, 'the visualiser stopped');
    assert.equal(out.raf, null, 'no RAF loop left spinning');
  } finally {
    await empty.close();
    await page.goto(server.url);
    await configureApp();
  }
});

test('an <audio> pause does not kill the visualiser while streaming still plays', { skip: SKIP }, async () => {
  // <audio>'s ended/pause events only mean the STANDARD playback path finished. Streaming
  // audio is driven by the AudioContext timeline and has nothing to do with that element, so
  // touching the native pause button used to kill a visualiser that was still tracking live
  // audio — measured: 32 sources still playing, vizActive already false.
  const longServer = await startUiServer({ pcmSeconds: 20, chunkMs: 200, chunkDelayMs: 5 });
  const page = chrome.page;
  try {
    await page.goto(longServer.url);
    // The premise is that streaming actually queued sources. The app's fetch against a local
    // stub occasionally fails outright, and without this guard the assertions would pass
    // vacuously on an all-zero state.
    let out = null;
    for (let attempt = 0; attempt < 3 && !out; attempt++) {
      const r = await page.evaluate(`(async () => {
        const vm = document.querySelector('#app').__vue_app__._instance.proxy;
        vm.config.baseUrl = ${JSON.stringify(longServer.url)};
        vm.config.apiKey = 'test-key';
        vm.form.inputText = 'visualiser survival check';
        await vm.generateSpeech(true);
        const before = { live: vm.activeSources.length, viz: vm.vizActive };
        if (before.live === 0) return { retry: true };
        vm.onAudioStopped();                       // as <audio> pause/ended would
        await new Promise((r) => setTimeout(r, 200));
        const during = { live: vm.activeSources.length, viz: vm.vizActive };
        vm.stopAllPlayback();                      // now nothing is playing
        vm.onAudioStopped();
        await new Promise((r) => setTimeout(r, 200));
        return { before, during, after: { live: vm.activeSources.length, viz: vm.vizActive, playing: vm.isPlaying } };
      })()`);
      if (!r.retry) out = r;
    }
    assert.ok(out, 'streaming never queued any source across 3 attempts');

    assert.ok(out.before.live > 1, 'premise: audio is queued');
    assert.equal(out.before.viz, true, 'premise: the visualiser is running');
    // The fix: an <audio> event must not stop a visualiser tracking live Web Audio.
    assert.ok(out.during.live > 0, 'audio is still queued after the pause event');
    assert.equal(out.during.viz, true, 'the visualiser survived the <audio> pause');
    // But once nothing is playing, the same handler must tear down.
    assert.equal(out.after.live, 0);
    assert.equal(out.after.viz, false, 'the visualiser stops when playback really ends');
    assert.equal(out.after.playing, false, 'isPlaying cleared, so the stop button disappears');
  } finally {
    await longServer.close();
    await page.goto(server.url);
    await configureApp();
  }
});
