# Contributing

> New here? Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first — it covers what this
> project is, why the decisions were made, and the traps that cost the most time.

Thanks for your interest in improving edgetts-ws-worker.

## Project layout

```
src/worker.js      Worker logic (edit this, not dist/)
ui/index.html      Web UI (edit this, not dist/)
scripts/build.mjs  Injects ui/ into src/ → dist/worker.js
test/              unit / integration / regression / e2e
legacy/            old NDJSON+WordBoundary variant (see ROADMAP)
```

`dist/worker.js` is generated — never edit it by hand and never commit it.

## Development

No dependencies to install. Everything runs on a recent Node (≥ 20).

```bash
npm test            # everything: test:fast then test:e2e
npm run test:fast   # unit + integration + regression (parallel)
npm run test:e2e    # browser + network e2e (serial — see below)
npm run test:unit   # one layer
npm run coverage    # with line coverage
npm run build       # produce dist/worker.js
npm run dev         # wrangler dev (needs wrangler)
```

E2E tests come in two kinds:

- **Browser tests** (`test/e2e/browser-playback.test.mjs`) drive a real Chrome over raw
  CDP against a local stub server. They need no credentials and run by default; they skip
  automatically if no Chrome binary is found (override with `CHROME_PATH`).
- **Network tests** hit the real deployment and are skipped unless `EDGETTS_E2E=1` is set
  (plus `EDGETTS_E2E_KEY` for the authenticated endpoints).

Note the zero-dependency rule: the browser tests use Node's built-in `WebSocket` and a
~100-line CDP client rather than Playwright, so `npm install` stays a no-op.

Both CI systems run the browser tests, deliberately duplicating them: GitHub Actions on
`ubuntu-latest` (which ships Chrome), and GitLab in a dedicated `test:browser` job on
`node:22-bookworm-slim` with chromium installed via apt. The duplication earned its place —
on 2026-08-06 GitHub Actions had a `major_outage` and could not even allocate a runner, so
for that day the UI had no CI coverage at all.

Because the browser tests **skip** rather than fail when no Chrome is found, a broken image
would leave that job reporting "21 ok" and green forever while guarding nothing. The GitLab
job therefore asserts on the `# skipped` and `# pass` counts after running. If you change the
image or the Chrome path, verify the guard still fails by pointing `CHROME_PATH` somewhere
non-existent — a guard that cannot fail is not a guard.

The e2e suite runs **serially and after** the fast tests, and this matters. It drives a real
Chrome plus several HTTP servers; running it alongside eight other test files caused
`page load timeout` failures from resource contention (measured: 27 failures in a fully
parallel run, 0 with `--test-concurrency=1`).

If you see intermittent `page load timeout` or "Failed to fetch" in the browser tests, check
for leaked Chrome processes first:

```bash
pgrep -f edgetts-cdp- | wc -l     # should be 0 between runs
pkill -f edgetts-cdp-             # only touches this suite's browsers
```

Killing a test script with `timeout` or Ctrl-C skips its `finally { chrome.close() }`, so
instances accumulate — 248 of them once, which is what made an earlier flake look like a
product bug. `launchChrome()` warns when it sees more than 20.

The browser tests are **hermetic**: the harness serves Vue from `test/.cache/` and rewrites
the UI's CDN `<script>` to a local route. That cache is populated on the first networked run
and gitignored. Before this, every browser test implicitly depended on the browser reaching
unpkg.com — when it could not, `page.goto` timed out or the page came up with no
`window.Vue` and zero voices, which reads as "the app is broken". Measured once: node-side
`curl` to unpkg returned 200 three times while headless Chrome could not fetch it at all.
That was the other half of the flake described above; leaked Chrome processes were the first
half. If you ever see `unpkg.com` in the served HTML during a test, the rewrite failed and
the harness throws rather than quietly restoring the dependency.

## Pull requests

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. One logical change per commit; [Conventional Commits](https://www.conventionalcommits.org/) messages.
3. Add or update tests for any behavior change — every fixed bug gets a regression test.
4. `npm test` and `npm run build` must pass. CI enforces this.
5. Don't hand-edit `dist/`.

## Testing conventions

- Node's built-in `node:test` + `node:assert/strict`, zero external deps.
- Handler tests use the mock harness in `test/helpers/mock-upstream.mjs` — don't hit the network.
- Call `__test__.resetTokenCache()` at the start of any test that exercises `worker.fetch`.
- Assertions are specific (status codes, error `code`, byte counts, call order) — not just truthy.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
