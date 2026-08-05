# Contributing

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
