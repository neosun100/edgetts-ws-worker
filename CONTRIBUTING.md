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
npm test            # all tests (unit + integration + regression)
npm run test:unit   # one layer
npm run coverage    # with line coverage
npm run build       # produce dist/worker.js
npm run dev         # wrangler dev (needs wrangler)
```

E2E tests hit the real upstream and are skipped unless `EDGETTS_E2E=1` is set.

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
