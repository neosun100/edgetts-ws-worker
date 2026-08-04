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

const HAVE_CHROME = await chromeAvailable();
const SKIP = HAVE_CHROME ? false : 'no Chrome binary available for browser e2e';

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
  await chrome.page.evaluate(`(() => {
    window.__sched = { totalSeconds: 0, calls: 0, lastEnd: 0 };
    const proto = AudioBufferSourceNode.prototype;
    const origStart = proto.start;
    proto.start = function (when, ...rest) {
      try {
        if (this.buffer) {
          window.__sched.totalSeconds += this.buffer.duration;
          window.__sched.calls++;
          window.__sched.lastEnd = Math.max(window.__sched.lastEnd, (when || 0) + this.buffer.duration);
        }
      } catch (e) { /* never break playback for instrumentation */ }
      return origStart.call(this, when, ...rest);
    };
    return true;
  })()`);

  // Kick off streaming playback through the app's own code path.
  await chrome.page.evaluate(`(() => {
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
  // Headless Chrome follows prefers-color-scheme and may already be dark, in which case
  // "toggle until dark" would never fire and never write storage. Toggle to light first,
  // then back to dark, so an actual toggle+persist round trip is exercised either way.
  const before = await chrome.page.evaluate(`(() => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy;
    const read = () => document.documentElement.getAttribute('data-theme');
    if (read() === 'dark') vm.toggleTheme();          // -> light
    const light = { theme: read(), stored: localStorage.getItem('tts_theme') };
    vm.toggleTheme();                                  // -> dark
    return { light, theme: read(), stored: localStorage.getItem('tts_theme') };
  })()`);
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
