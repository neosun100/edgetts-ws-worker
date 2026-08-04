// Minimal Chrome DevTools Protocol client — zero dependencies.
//
// The project deliberately has no deps/devDeps (see package.json), so a browser test
// must not pull in Playwright/Puppeteer. Chrome is already on the machine and CDP runs
// over a WebSocket, which Node has built in — so a ~100-line client is enough to drive
// a real browser and evaluate JS in the page.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  // CHROME_PATH goes FIRST so it actually overrides, as CONTRIBUTING promises. It used to
  // sit last, which meant that on any machine with Chrome installed at a standard location
  // the variable was silently ignored — the opposite of an override.
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

async function findChrome() {
  const { access } = await import('node:fs/promises');
  for (const p of CHROME_CANDIDATES) {
    try { await access(p); return p; } catch { /* keep looking */ }
  }
  return null;
}

export async function chromeAvailable() {
  return (await findChrome()) !== null;
}

/**
 * Launch headless Chrome and return a CDP session bound to one page.
 * Audio autoplay is force-enabled — without it AudioContext stays suspended and any
 * playback assertion would silently measure nothing.
 */
export async function launchChrome({ port = 0, timeoutMs = 15000 } = {}) {
  const bin = await findChrome();
  if (!bin) throw new Error('no Chrome binary found');
  const userDataDir = await mkdtemp(join(tmpdir(), 'edgetts-cdp-'));
  const chosenPort = port || 9500 + Math.floor(Math.random() * 400);

  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${chosenPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    // Critical for audio tests: otherwise AudioContext never leaves "suspended".
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' });

  // Poll /json/version until the debugger is up.
  const deadline = Date.now() + timeoutMs;
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${chosenPort}/json/version`);
      if (res.ok) { wsUrl = (await res.json()).webSocketDebuggerUrl; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!wsUrl) {
    proc.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
    throw new Error('Chrome debugger did not come up in time');
  }

  const browser = await connect(wsUrl);
  // Create a page target and attach a flat session to it.
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  const page = {
    send: (method, params) => browser.send(method, params, sessionId),
    async goto(url) {
      await this.send('Page.enable');
      await this.send('Runtime.enable');
      await this.send('Page.navigate', { url });
      // Wait for the document to finish loading; polling readyState is simpler and more
      // robust here than juggling lifecycle events for a single-page app.
      const stop = Date.now() + 15000;
      while (Date.now() < stop) {
        const r = await this.evaluate('document.readyState');
        if (r === 'complete') return;
        await new Promise((s) => setTimeout(s, 100));
      }
      throw new Error('page load timeout: ' + url);
    },
    /** Evaluate an expression, awaiting promises, and return the JSON value. */
    async evaluate(expression) {
      const res = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error('page eval failed: ' + (d.exception?.description || d.text));
      }
      return res.result.value;
    },
  };

  return {
    page,
    async close() {
      try { browser.close(); } catch { /* already gone */ }
      proc.kill('SIGKILL');
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) bad(new Error(msg.error.message));
        else ok(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
    ws.addEventListener('close', () => {
      for (const { reject: bad } of pending.values()) bad(new Error('CDP closed'));
      pending.clear();
    });
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          const payload = { id, method, params };
          if (sessionId) payload.sessionId = sessionId;
          return new Promise((ok, bad) => {
            pending.set(id, { resolve: ok, reject: bad });
            ws.send(JSON.stringify(payload));
            setTimeout(() => {
              if (pending.has(id)) { pending.delete(id); bad(new Error(method + ' timed out')); }
            }, 20000);
          });
        },
        close() { ws.close(); },
      });
    });
  });
}
