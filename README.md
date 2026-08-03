<p align="center">
  <img src="docs/logo.svg" width="128" height="128" alt="edgetts-ws-worker logo"/>
</p>

<h1 align="center">edgetts-ws-worker</h1>

[![CI](https://github.com/neosun100/edgetts-ws-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/neosun100/edgetts-ws-worker/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI_compatible-412991?logo=openai&logoColor=white)](#api)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[中文文档 / Chinese](README_CN.md)** · **[Roadmap](ROADMAP.md)** · **[Changelog](CHANGELOG.md)**

A single Cloudflare Worker that turns Microsoft Edge / Azure TTS into a fast,
**OpenAI-compatible** text-to-speech API — with true streaming playback, 322 voices,
a built-in web UI, and zero infrastructure to run. Serverless, global, free-tier friendly.

> **Live:** [edgetts.aws.xin](https://edgetts.aws.xin) · try the web UI or `POST /v1/audio/speech`.

![Architecture](docs/architecture.svg)

## Why

- 🎙️ **322 voices, 40+ languages** — every Microsoft neural voice, including multilingual ones.
- ⚡ **True streaming** — streams raw PCM so playback starts on the first chunk and never
  cuts off mid-sentence (container formats like MP3 can't be played incrementally — see
  [the streaming note](#streaming)).
- 🧩 **OpenAI-compatible** — `POST /v1/audio/speech`, drop-in for the OpenAI TTS shape.
- 🚀 **Concurrent synthesis** — long text is sentence-chunked and synthesized with a
  sliding-window concurrency, then streamed back in order (4×+ faster on long input).
- 🌍 **Global edge** — runs on Cloudflare's 300+ locations; CPU work per request is < 1 ms.
- 🖥️ **Built-in web UI** — a Vue single-page app served by the Worker itself.
- 🔓 **Open by design** — permissive CORS, no rate limit; gated only by an API key.

## Web UI

Open `/` in a browser. All 322 voices are filterable by language, region, gender, and a
“multilingual only” toggle — or search by name / ShortName. Each voice shows its full
`ShortName` with a one-click copy button, so it drops straight into an API call. Playback
draws a live colorful spectrum, and a **light / dark** theme toggle (top-right) is
remembered across visits.

![Web UI — light theme with live spectrum](docs/screenshots/ui-voice-picker.png)

<p align="center"><em>Dark theme</em></p>

![Web UI — dark theme](docs/screenshots/ui-dark.png)

## Quick start

### Use the hosted instance

```bash
curl -X POST https://edgetts.aws.xin/v1/audio/speech \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"input":"Hello from the edge!","voice":"en-US-AvaNeural"}' \
  --output speech.mp3
```

### Deploy your own

```bash
git clone https://github.com/neosun100/edgetts-ws-worker
cd edgetts-ws-worker
npm run build                    # bundles ui/ + src/ → dist/worker.js
npx wrangler secret put API_KEY  # set your key (or set ALLOW_ANONYMOUS=true to run open)
npx wrangler deploy
```

No dependencies to install — the build and tests use only Node's built-ins.

## API

### `POST /v1/audio/speech`

```jsonc
{
  "input": "The text to speak.",   // required, ≤ 50000 chars
  "voice": "en-US-AvaNeural",       // or an OpenAI alias: alloy/echo/fable/onyx/nova/shimmer
  "speed": 1.0,                      // 0.25–4.0
  "pitch": 1.0,                      // 0.5–1.5
  "style": "general",               // expression style
  "response_format": "mp3",         // mp3 | opus | wav  (pcm is used internally for streaming)
  "stream": false,                   // true → raw audio stream
  "cleaning_options": { }            // strip markdown/emoji/urls/etc. before synthesis
}
```

Returns the audio bytes with the matching `Content-Type` (`audio/mpeg`, `audio/webm`,
`audio/wav`). On error, a JSON body `{ "error": { message, code, type } }` with a precise
`code` (e.g. `invalid_voice`, `invalid_response_format`, `input_too_long`).

<a name="streaming"></a>
#### Streaming

Set `stream: true`. The server streams **raw PCM** regardless of `response_format`, because
container formats (MP3/Opus/WAV) can't be decoded incrementally — a partial MP3 blob plays
as a short *complete* clip and stops. The bundled web UI plays streamed PCM through the Web
Audio API on a continuous timeline, so audio starts immediately and never truncates. For
non-streaming requests you get a normal MP3/Opus/WAV file.

### `GET /v1/models` · `GET /v1/models/public`

Lists the available voices (322) in an OpenAI-models-like shape. Query filters:
`?neural=true`, `?multilingual=true`.

### `GET /`

Serves the built-in web UI.

## Formats

| `response_format` | Content-Type | Streaming | Notes |
|---|---|---|---|
| `mp3` | audio/mpeg | non-stream | default, best compatibility |
| `opus` | audio/webm | non-stream | high compression |
| `wav` | audio/wav | non-stream | lossless, large |
| `pcm` | audio/pcm | **stream** | used automatically for streaming; not a UI option |

> AAC and FLAC are **not** supported — the upstream endpoint rejects them with a 400.

## Configuration

| Var | Type | Purpose |
|---|---|---|
| `API_KEY` | secret | Bearer token required for `/v1/audio/speech`. **Without it the Worker returns 503** rather than serving unauthenticated traffic. |
| `ALLOW_ANONYMOUS` | var | Set to `"true"` to intentionally run open (no key). |

## Development

```bash
npm test              # unit + integration + regression (Node's built-in runner, zero deps)
npm run test:unit     # one layer
npm run coverage      # with line coverage
npm run build         # ui/ + src/ → dist/worker.js
npm run dev           # wrangler dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests are layered under `test/` (unit / integration
/ regression / e2e); handler tests run against a mock upstream, so the suite is offline and
deterministic. E2E tests hit the real service and are skipped unless `EDGETTS_E2E=1`.

## How it works

1. **Auth + validate** — checks the API key (constant-time), then validates every
   parameter against explicit limits, returning a precise error code on any mismatch.
2. **Clean + chunk** — optional text cleaning (markdown/emoji/urls), then sentence-aware
   chunking so no single request exceeds the upstream limit.
3. **Token** — fetches and caches a Microsoft speech token (JWT), refreshing before expiry;
   concurrent refreshes are coalesced into one.
4. **Synthesize** — each chunk becomes an SSML request (voice/style/prosody safely escaped);
   chunks run with sliding-window concurrency and stream back **in order**, with retries on
   transient upstream failures.

## Companion & legacy

- `legacy/worker-ndjson.js` — the original WebSocket + NDJSON variant with **word-level
  timestamps** (`WordBoundary`). Kept because downstream projects use it; see [ROADMAP](ROADMAP.md)
  for the plan to merge timestamp support into the main worker.
- [edgetts-ws](https://github.com/neosun100/edgetts-ws) — the same idea as a Python server.

## License

MIT
