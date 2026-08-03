#!/usr/bin/env bash
# One-shot GitHub setup: release notes, milestones, repo topics.
# Run when api.github.com is reachable (it was down during the 2.1.0 push, which only
# succeeded because git push routes through the gh.aws.xin proxy — the REST API does not).
#   source ~/.env && bash scripts/github-release.sh
set -euo pipefail

REPO="neosun100/edgetts-ws-worker"

echo "==> repo metadata"
gh repo edit "$REPO" \
  --description "OpenAI-compatible Edge TTS on Cloudflare Workers — true streaming PCM, 322 voices, built-in web UI, zero infra" \
  --homepage "https://edgetts.aws.xin" \
  --add-topic text-to-speech --add-topic tts --add-topic cloudflare-workers \
  --add-topic edge-tts --add-topic openai-compatible --add-topic serverless \
  --add-topic streaming --add-topic vue

echo "==> release v2.1.0"
gh release create v2.1.0 --repo "$REPO" --title "v2.1.0 — Test-hardened + 6 real bug fixes" --notes '## v2.1.0

A layered test suite (161 cases, zero external deps, 95% line coverage of `src/worker.js`)
was added and immediately surfaced **six real source defects**, all fixed and deployed.

### Fixed
- **voice hijacked by `model`** — `{voice:"en-US-AvaNeural", model:"tts-1-nova"}` synthesized Chinese. Explicit voice now wins.
- **non-string `model` → 500** leaking an internal error. Now ignored safely.
- **CORS preflight `Access-Control-Allow-Headers: null`** — could block cross-origin `Authorization` POSTs.
- **`cleanText` ate markdown link parens** — `[docs](url)` → `[docs](`. Markdown now runs before URL stripping.
- **`cleanText` mangled snake_case** — `my_func_name` → `myfuncname`. Now word-boundary aware.
- **`getSsml` leaked its internal nonce** on a `<break>` with `$&`. Now uses a function replacement.

### Added
- Layered tests (unit / integration / regression / e2e) with a mock-upstream harness.
- GitHub Actions CI (test + build + coverage) and tag-triggered deploy.
- Community health files, animated SVG architecture diagram, full README rewrite.

See [CHANGELOG.md](CHANGELOG.md) and [ROADMAP.md](ROADMAP.md).'

echo "==> milestones (from ROADMAP)"
create_ms () { # title, description
  gh api "repos/$REPO/milestones" -f title="$1" -f state=open -f description="$2" >/dev/null 2>&1 \
    && echo "   + $1" || echo "   = $1 (exists?)"
}
create_ms "P1 · Word-level timestamps" "Merge WordBoundary timestamp support (from legacy/worker-ndjson.js) into the main worker or a /timestamps endpoint."
create_ms "P1 · Observability" "Structured JSON logs, key metrics (5xx rate, upstream 401 rate, p99), alerting."
create_ms "P1 · Request body size guard" "Enforce a Content-Length cap in addition to the 50000-char input limit."
create_ms "P2 · TypeScript / ts-check" "Add // @ts-check + JSDoc types without changing the build."
create_ms "P2 · Voice list caching" "Cache /v1/models via the Cache API to avoid hitting upstream per request."
create_ms "P2 · Frontend e2e" "Playwright test asserting streaming playback never truncates."

echo "==> done"
