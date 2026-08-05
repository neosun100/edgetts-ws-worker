// Minimal Chrome DevTools Protocol client — zero dependencies.
//
// The project deliberately has no deps/devDeps (see package.json), so a browser test
// must not pull in Playwright/Puppeteer. Chrome is already on the machine and CDP runs
// over a WebSocket, which Node has built in — so a ~100-line client is enough to drive
// a real browser and evaluate JS in the page.
import { spawn, execFileSync } from 'node:child_process';
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

/**
 * True only when Chrome is present AND can actually be driven.
 *
 * Checking for the binary alone is not enough: on a CI runner the file exists but Chrome
 * may refuse to start (root + setuid sandbox, missing shared libraries). That combination
 * is the worst case — tests neither skip nor fail fast, they each wait out the launch
 * timeout, and the job appears to hang. So prove it by launching once, cheaply.
 */
export async function chromeAvailable() {
  if ((await findChrome()) === null) return false;
  try {
    const session = await launchChrome({ timeoutMs: 8000 });
    await session.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch headless Chrome and return a CDP session bound to one page.
 * Audio autoplay is force-enabled — without it AudioContext stays suspended and any
 * playback assertion would silently measure nothing.
 */
export async function launchChrome({ port = 0, timeoutMs = 15000 } = {}) {
  const bin = await findChrome();
  if (!bin) throw new Error('no Chrome binary found');
  // 泄漏的实例会抢端口和 CPU,让 page.goto 超时、fetch 失败,而且症状是「偶发」的 ——
  // 我为此追了五轮才发现是自己的探针脚本被 `timeout` 掐掉、finally 里的 close() 没跑,
  // 累积了 248 个 headless Chrome。这里只是把它变成一条显式警告,不自动杀进程:
  // 误杀用户自己的浏览器比留个警告糟得多。
  warnIfLeaked();
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
    // CI runners execute as root in a container, where Chrome's setuid sandbox refuses to
    // start. Without this the browser never comes up, chromeAvailable() still reported
    // true (the binary exists), and every test burned the full 15s launch timeout instead
    // of skipping — the GitHub job hung for minutes. Harmless locally.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // Critical for audio tests: otherwise AudioContext never leaves "suspended".
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' });

  // If Chrome dies immediately (bad flags, missing shared libs, sandbox refusal), stop
  // polling right away instead of waiting out the full timeout for every single test.
  let exited = false;
  proc.once('exit', () => { exited = true; });

  // Poll /json/version until the debugger is up.
  const deadline = Date.now() + timeoutMs;
  let wsUrl = null;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`http://127.0.0.1:${chosenPort}/json/version`);
      if (res.ok) { wsUrl = (await res.json()).webSocketDebuggerUrl; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!wsUrl) {
    proc.kill('SIGKILL');
    // Same ENOTEMPTY race as in close() — a failed launch must not turn into a different,
    // more confusing error while cleaning up after itself.
    try { await rm(userDataDir, { recursive: true, force: true }); } catch { /* /tmp will reap it */ }
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
      // Wait for the process to actually die before deleting its profile. Chrome keeps
      // writing to the profile directory as it tears down, so on Linux rm raced it and
      // threw ENOTEMPTY (seen on the GitHub runner:
      // "rmdir '/tmp/edgetts-cdp-*/Default/Storage/ext/.../def'"). That rejection came
      // from an after() hook, which orphaned the node children and left the job hanging
      // until its timeout. macOS does not reproduce it — deleting open files is allowed.
      await new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
        proc.once('exit', resolve);
        setTimeout(resolve, 3000).unref();   // never block teardown on this
      });
      // Cleanup of a temp dir must never fail a test: retry once, then give up quietly.
      // The OS reaps /tmp anyway, so a leftover directory is not worth a red build.
      try {
        await rm(userDataDir, { recursive: true, force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 300).unref());
        try { await rm(userDataDir, { recursive: true, force: true }); } catch { /* leave it to /tmp */ }
      }
    },
  };
}

/**
 * 数一下有多少个本套件启动过、却没被回收的 headless Chrome。只看 --user-data-dir 里带
 * edgetts-cdp- 前缀的进程,所以不会把用户平时开的浏览器算进来。
 */
let leakWarned = false;
function warnIfLeaked() {
  if (leakWarned) return;
  leakWarned = true;   // 每个进程只提醒一次,别把测试输出刷满
  try {
    const out = execFileSync("/bin/sh", ["-c", "pgrep -f edgetts-cdp- | wc -l"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const n = Number(out.trim());
    if (n > 20) {
      console.warn(
        "[cdp] 检测到 " + n + " 个残留的测试用 Chrome 进程。它们会抢端口与 CPU，" +
        "使 page.goto 超时、fetch 偶发失败。清理：pkill -f \"edgetts-cdp-\""
      );
    }
  } catch { /* pgrep 不可用（非 Unix）时静默跳过 */ }
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
