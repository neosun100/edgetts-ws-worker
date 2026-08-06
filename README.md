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
- ⚡ **True streaming** — with `response_format: "pcm"`, playback starts on the first chunk
  and runs to the end (container formats like MP3 can't be played incrementally — see
  [the streaming note](#streaming)).
- 🧩 **OpenAI-compatible** — `POST /v1/audio/speech`, drop-in for the OpenAI TTS shape.
- 🚀 **Concurrent synthesis** — long text is sentence-chunked and synthesized through a
  work-conserving pool, then returned in chunk order. Measured on the deployed worker:
  600 characters split into 12 chunks took 3683ms serially versus 918ms at concurrency 10 —
  a 4.0x speedup, with byte-identical output at every concurrency level. Both the streaming
  and non-streaming paths refill a slot the moment one frees, so a single slow chunk never
  idles the others (see [Concurrency](#concurrency)).
- 🌍 **Global edge** — runs on Cloudflare's 300+ locations. Measured CPU per request: 0.007 ms
  for a typical 280-character input, 1.96 ms median (3.55 ms p95) for the 50000-character
  maximum, against the platform's 10 ms budget. Nearly all of it is chunking.
- 🖥️ **Built-in web UI** — a Vue single-page app served by the Worker itself.
- 🔓 **Open by design** — permissive CORS, no rate limit; gated only by an API key.

## Web UI

Open `/` in a browser. All 322 voices are filterable by language, region, gender, and a
“multilingual only” toggle — or search by name / ShortName. Each voice shows its full
`ShortName` with a one-click copy button, so it drops straight into an API call.
The picker is a proper **radio group**: arrows / Home / End move and select, Enter and Space
confirm, and a visible focus ring follows along — so all 322 voices are reachable without a
mouse, and screen readers announce the selection. Playback
draws a three-layer visualizer — a **Siri-style pulsing ring**, **particle bursts** on each
syllable onset, and a **scrolling pulse waveform** where every syllable travels along the
time axis. A **light / dark** theme toggle (top-right) is remembered across visits. A **stop button** appears while audio is playing — necessary because streamed
audio is scheduled onto the Web Audio timeline up front, so the request finishes while
sound continues and the native `<audio>` pause cannot reach it.

The colour is **derived from the audio**, not random: hue follows the spectral centroid
(low vowels → amber, high fricatives → cyan), saturation follows spectral crest factor
(tonal → vivid, noisy → grey), brightness follows loudness, and each voice gets a stable
hue offset from its fundamental frequency — so a deep voice always reads warmer than a
high one. All thresholds are calibrated against measured distributions from real TTS output.

![Visualizer — dark theme](docs/screenshots/viz-dark.png)
![Visualizer — light theme](docs/screenshots/viz-light.png)

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
  "input": "The text to speak.",   // required; see the length limits below
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
`audio/wav`). On error, a JSON body `{ "error": { message, code, type, param } }` with a precise
`code` (e.g. `invalid_voice`, `invalid_response_format`, `input_too_long`).

`param` names the request field at fault (`voice`, `speed`, `cleaning_options.custom_keywords`,
or `body` for an unparseable payload), and is `null` when no single field is responsible. It
matters because two codes each cover two causes: `invalid_request_error` is both
"body is not JSON" and "input is missing", and `invalid_cleaning_options` is both a wrong
container type and a wrong nested field — the codes are kept stable for existing callers, so
`param` is what tells them apart.

<a name="streaming"></a>
#### Streaming

Set `stream: true` and the server streams the synthesised chunks as they arrive, in
whatever `response_format` you asked for.

**Use `response_format: "pcm"` when you stream.** Container formats (MP3/Opus/WAV) cannot
be decoded incrementally — a partial MP3 blob plays as a short *complete* clip and stops,
which is exactly the 1.67s truncation this project was built to fix. The server does not
override your choice; it streams what you request. The bundled web UI rewrites the format
to `pcm` for you before sending a streaming request, and plays the result through the Web
Audio API on a continuous timeline, so audio starts immediately and never truncates. A
direct API caller has to make that choice itself.

A streamed request that would split into more than one chunk is refused for `wav` and
`opus` with 400 `stream_format_not_chunkable`. Those are container formats: the response
headers are already out by the time the second chunk arrives, so there is no way to fuse the
containers or backfill a length. Left alone it produced a 200 whose first header declared
61.46s for a body holding 191.67s — a player stops at 32%. Use `pcm` to stream, or drop
`stream` to get a merged file.

For non-streaming requests you get a normal MP3/Opus/WAV file.

### `GET /v1/models` · `GET /v1/models/public`

Lists the available voices (322) in an OpenAI-models-like shape. Both endpoints accept
the same query filters:

- `?multilingual=true` — only the multilingual voices (12 of 322).
- `?neural=true` — accepted for backward compatibility, but a **no-op**: every voice
  upstream is already a Neural voice, so nothing is filtered out.

The list is cached in-process for 6 hours and served with
`Cache-Control: public, max-age=21600`, so repeat calls don't hit upstream. If upstream
is down the last known list is served (with a warning logged) rather than failing.

### `GET /`

Serves the built-in web UI.

## Formats

| `response_format` | Content-Type | Streaming | Notes |
|---|---|---|---|
| `mp3` | audio/mpeg | non-stream | default, best compatibility |
| `opus` | audio/webm | non-stream | high compression; chunks are merged (see below) |
| `wav` | audio/wav | non-stream | lossless, large |
| `pcm` | audio/pcm | **stream** | used automatically for streaming; not a UI option |

> AAC and FLAC are **not** supported — the upstream endpoint rejects them with a 400.

**Multi-chunk Opus is merged into one WebM segment.** Each chunk arrives from upstream as
a complete, independent container, and `<audio>` honours only the first one — measured on
real chunks, the element reported 9.44s for a file holding 94.56s, silently losing up to 90%
of the audio. The Worker now rewrites the per-container Cluster timestamps into one
continuous timeline (~1.2ms for 45 chunks; the upstream muxing conveniently omits every
length-bearing element, so no size field has to move). If a chunk is not parseable WebM the
merge declines and the bytes are passed through unchanged, with the reason logged.

The merged file also carries a top-level `Duration`, so `<audio>.duration` and
`seekable` are available at `loadedmetadata` — the progress bar works from the start and
seeking is accurate without scrubbing to the end first. Measured on the deployed worker:
`duration = 191.7` for a 4-chunk request, and a seek to 150s lands at 150.00.

<a name="concurrency"></a>
### Concurrency

`concurrency` (1–20, default 10) is the number of chunks synthesized at once. Both paths use
a **work-conserving pool**: a slot takes the next unsynthesized chunk the instant it frees,
so one slow chunk never idles the others. Output is assembled by chunk index, so it is
byte-identical at every concurrency level regardless of the order upstream answers.

The non-streaming path previously batched — `Promise.all` over `concurrency` chunks, then the
next batch — which put a barrier at every batch boundary, making each batch cost its *slowest*
chunk rather than its average. Upstream latency has a long tail, so that idled slots. Measured
through the worker against a mock upstream where every 10th chunk takes 500ms and the rest
100ms:

| Chunks @ concurrency 10 | Batched | Pool | Work-conserving bound |
|---|---|---|---|
| 12 | 645ms | 530ms | 160ms |
| 24 | 1505ms | 708ms | 360ms |
| 40 | 2012ms | 812ms | 560ms |

A chunk failing for a non-retryable reason stops the pool rather than draining the remaining
chunks: the response is already lost, and each further call would spend one of the 50
subrequests Cloudflare allows per invocation.

### Failure attribution

A `4xx` means the request needs changing; a `5xx` means this service or its upstream failed.
The distinction is maintained deliberately, because getting it wrong sends callers to debug
the wrong thing. Two cases worth naming:

- An upstream rejection of a well-formed request (most often a `voice` that matches the name
  pattern but does not exist) is reported as 400 `upstream_rejected_request`, not 500 — the
  fix is on the caller's side.
- A token-fetch failure is reported as 500 `tts_generation_error`, even though upstream
  answered 401. The Microsoft token is this service's own dependency; the caller's request was
  fine. This previously surfaced as 400 with a "voice does not exist" message, via a chain
  where a dead cached token was retried until the attempts ran out and the final 401 was
  mapped to a caller error. The cached token is now only used as a fallback while it is still
  valid.

## Configuration

| Var | Type | Purpose |
|---|---|---|
| `API_KEY` | secret | Bearer token required for `/v1/audio/speech`. **Without it the Worker returns 503** rather than serving unauthenticated traffic. |
| `ALLOW_ANONYMOUS` | var | Set to `"true"` to intentionally run open (no key). |

### Observability

Every request emits exactly one JSON line, successes included. `[observability]` is enabled in
`wrangler.toml`, so these are queryable in the Workers dashboard and pushable via Logpush.

```jsonc
{"ev":"req","route":"/v1/audio/speech","status":200,"ms":412,"upstream":4,"retries":0,
 "voice":"zh-CN-XiaoxiaoNeural","format":"mp3","chunks":4,"conc":10,"stream":false,"chars":901}
```

| Field | Meaning |
|---|---|
| `ev` | Always `"req"` — filters telemetry apart from prose log lines |
| `route` | `/v1/audio/speech` or `/v1/models` |
| `status` | HTTP status. Console level tracks it: 5xx → `error`, 4xx → `warn`, else `log`, so a 5xx rate can be pre-filtered without parsing JSON |
| `ms` | Wall-clock duration. **For streams this covers synthesis to stream end**, not header commit |
| `upstream` | Upstream calls actually made — each spends one of Cloudflare's 50 subrequests per invocation, so retried attempts count |
| `retries` | Retried attempts, which finally gives a retry *rate* a denominator |
| `code` | Present on 4xx/5xx only: the same machine-readable code as the response body |
| `voice` `format` `chunks` `conc` `stream` `chars` | Request dimensions. **Omitted, not nulled, when the request failed validation** — a rejected request has no meaningful voice, and nulls would pollute aggregation |
| `degraded` | Present only when something silently fell back (e.g. `wav_merge_declined_no_riff`) |
| `phase` | Streams only: `stream_end` or `stream_broken`. Once headers are out the status is stuck at 200, so this is the *only* place a mid-stream failure is visible |

**Never logged:** the API key, and the input text — not even hashed or truncated, because it is
the caller's content. `chars` carries the length so input size stays aggregatable.

Cost: serialising one line measures ~0.0001 ms, about **0.004%** of a worst-case request's
~3 ms of CPU — three orders of magnitude under the measurement noise floor, and pinned by a
test so the payload can't quietly grow into the 10 ms budget. Only error responses are cloned
to recover their code; a multi-megabyte audio body never is.

### The built-in web UI is for trusted environments

The UI at `/` keeps the API key you type into it in `localStorage`, in plain text. Any script
running on the same origin can read it. That is a deliberate trade-off, not an oversight, and
it is stated here so the decision is yours rather than a surprise:

- **Use the UI on a machine and browser you control.** It is a convenience front-end for your
  own key, in the same category as a `curl` command in your shell history.
- **Do not hand the UI's URL to untrusted users as a way to share access.** They would be
  typing your key into their own browser's storage. Issue keys per consumer and let them call
  `POST /v1/audio/speech` directly instead.
- **Do not embed this page in a context where third-party script runs** (an ad slot, a tag
  manager, a browser extension you did not audit).

What has been closed off, so the remaining risk is scoped accurately:

- The one third-party script the page loads (Vue) is **pinned to an exact version with an SRI
  hash**, so a compromised CDN cannot substitute a key-stealing build. Verified live: SRI
  active, page renders all 322 voices.
- The UI's own injection surface is nil — measured 0 occurrences each of `v-html`,
  `innerHTML =`, and `eval`.
- Values read back from `localStorage` are type-checked field by field rather than spread over
  the defaults, so a tampered entry degrades to the default instead of breaking the page.

The alternative — a backend session with a same-origin cookie and the key held server-side —
was considered and **not** adopted. It conflicts with the point of this project: anyone can
deploy their own copy in a single `wrangler deploy`, and requiring a session store would add a
dependency to that path. Serving the key to the browser is the cost of that simplicity, and
the boundary is documented rather than hidden.

### Length limits

Request bodies are capped at 256KB (413 `payload_too_large`) and `input` at 50000
characters (400 `input_too_long`).

**Characters are not the binding constraint — chunk count is.** The text is split into
chunks of `chunk_size` and each chunk costs one upstream subrequest, while Cloudflare
allows 50 per invocation. The Worker therefore refuses more than 45 chunks with 413
`too_many_chunks`, which at the default `chunk_size` of 300 is about 13500 characters.

To synthesise longer text, raise `chunk_size` or split the text across requests. Coarser
chunks mean fewer, longer upstream calls — slightly slower to first byte, but far more
headroom.

**The two limits are in series, so the real ceiling is whichever binds first.** At
`chunk_size` 2000 the chunk budget would allow 45 × 2000 = 90000 characters, but
`MAX_INPUT_CHARS` is checked first, so 50000 is the hard maximum — verified live: 50000
characters at `chunk_size` 2000 returns audio, 50001 returns 400 `input_too_long`. Raising
`chunk_size` buys headroom up to 50000, not beyond it.

The check runs before any response byte is written, deliberately: a streaming request that
exceeded the platform budget mid-flight used to end as HTTP 200 with a well-formed EOF, so
a caller could not distinguish a truncated clip from a complete one.

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

- `legacy/worker-ndjson.js` — the original WebSocket + NDJSON variant, and the **only**
  source of **word-level timestamps** (`WordBoundary`). These cannot be merged into the
  main worker: word boundaries exist only in the WebSocket protocol, and outbound
  WebSocket only works on `*.workers.dev` (a custom domain's proxy layer breaks the
  handshake). Probing the REST endpoint with several header combinations returned audio
  with no timestamp data at all. So if you need timestamps — e.g. karaoke-style
  highlighting — call the legacy deployment:

  ```bash
  curl -X POST https://edgetts-ws-worker.neosun808.workers.dev/ \
    -H 'Content-Type: application/json' \
    -d '{"input":"Hello world","voice":"en-US-AvaNeural"}'
  # -> { audio: "<base64 mp3>", timestamps: [{ text, offset, duration }, ...] }
  ```

  Its contract is pinned by `test/e2e/legacy-timestamps.test.mjs`. See [ROADMAP](ROADMAP.md#7-wordboundary-时间戳--架构上无法合并2026-08-04-实测结论) for the full analysis.
- [edgetts-ws](https://github.com/neosun100/edgetts-ws) — the same idea as a Python server.

## License

MIT
