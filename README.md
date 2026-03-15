# edgetts-ws-worker

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Edge TTS](https://img.shields.io/badge/Edge_TTS-WebSocket-purple)](https://github.com/rany2/edge-tts)


**[中文文档 / Chinese](README_CN.md)**

A Cloudflare Worker that connects to Microsoft Edge TTS via WebSocket to provide text-to-speech with **word-level timestamps**. Supports both streaming (NDJSON) and non-streaming (JSON) modes. Serverless, globally distributed, zero infrastructure to maintain.

## How It Works

```
Client POST → CF Worker (edge) → Bing TTS WebSocket → WordBoundary + audio
                                                              ↓
                                                   JSON or NDJSON stream → Client
```

The Worker implements the full Edge TTS WebSocket protocol from scratch (no external libraries):
1. **DRM token generation** (`Sec-MS-GEC`) — SHA-256 hash of Windows file time + TrustedClientToken
2. **Chrome fingerprint headers** — Origin, User-Agent, Cookie (MUID) mimicking Edge browser extension
3. **SSML message framing** — speech.config + ssml messages over WebSocket
4. **Binary audio parsing** — extracts audio data from WebSocket binary frames (2-byte header length prefix)

## ⚠️ Critical: Custom Domain Limitation

> **Outbound WebSocket connections from Cloudflare Workers ONLY work on the default `*.workers.dev` domain.**
>
> Custom domains via Workers Routes or AAAA `100::` records will fail with `"WebSocket upgrade failed"` because Cloudflare's proxy layer interferes with the outbound WebSocket handshake to Bing.

| Domain Type | Outbound WebSocket | Status |
|-------------|-------------------|--------|
| `*.workers.dev` | ✅ Works | **Use this** |
| Custom domain (Workers Route) | ❌ Fails | Do not use |
| Custom domain (AAAA `100::`) | ❌ Fails | Do not use |

This was discovered during development after multiple failed attempts. The Worker code itself is correct — the issue is at the Cloudflare infrastructure level when routing through custom domains.

**Workaround**: Use the `*.workers.dev` URL directly from your frontend. If you need a custom domain, use the [edgetts-ws](https://github.com/neosun100/edgetts-ws) Python server instead.

## Features

- 🎯 **Word-level timestamps** — precise offset + duration in milliseconds
- ⚡ **Streaming mode** — NDJSON for low-latency, real-time applications
- 📦 **Non-streaming mode** — single JSON response
- 🌍 **Global edge** — runs on Cloudflare's 300+ edge locations
- 🔐 **DRM token** — auto-generates `Sec-MS-GEC` token via Web Crypto API
- 🆓 **Free tier** — 100K requests/day on Workers free plan
- 🌐 **CORS enabled** — ready for browser frontends

## Quick Start

```bash
# Deploy with Wrangler CLI
npx wrangler deploy worker.js --name edgetts-ws-worker --compatibility-date 2024-12-13
```

Or copy `worker.js` into the [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/workers) editor.

## API

### `POST /v1/audio/speech`

**100% API-compatible** with [edgetts-ws](https://github.com/neosun100/edgetts-ws) (the Python server). They are interchangeable.

**Request:**

```json
{
  "input": "The celebrated theory is still the source of great controversy.",
  "voice": "en-US-AvaNeural",
  "speed": 0.8,
  "stream": true
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `input` | string | *(required)* | Text to synthesize |
| `voice` | string | `en-US-AvaNeural` | Edge TTS voice name |
| `speed` | number | `1.0` | Playback speed (0.5–2.0) |
| `stream` | boolean | `false` | Enable NDJSON streaming |

### Non-Streaming Response (`stream: false`)

```json
{
  "audio": "<base64-encoded MP3>",
  "content_type": "audio/mpeg",
  "timestamps": [
    { "text": "The", "offset": 100, "duration": 218.75 },
    { "text": "celebrated", "offset": 334.375, "duration": 750 }
  ]
}
```

### Streaming Response (`stream: true`)

```jsonl
{"type":"word","text":"The","offset":100,"duration":218.75}
{"type":"word","text":"celebrated","offset":334.375,"duration":750}
{"type":"audio","data":"<base64 MP3 chunk>"}
{"type":"done"}
```

All timestamps are in milliseconds. Both modes return identical timestamp data — the only difference is delivery method.

## DRM Token Generation

The Worker implements Microsoft's `Sec-MS-GEC` algorithm using Web Crypto API:

```
1. Unix timestamp (seconds) + 11644473600 (Windows epoch offset)
2. Round down to nearest 300 seconds (5 minutes)
3. Multiply by 10^7 (convert to 100-nanosecond intervals)
4. Concatenate with TrustedClientToken string
5. SHA-256 hash → uppercase hex string
```

This token is passed as a URL parameter on the WebSocket connection.

## WebSocket Connection Details

```
URL: https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
     ?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4
     &ConnectionId={uuid}
     &Sec-MS-GEC={drm_token}
     &Sec-MS-GEC-Version=1-143.0.3650.75

Headers:
  Upgrade: websocket
  Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold
  User-Agent: Mozilla/5.0 ... Chrome/143.0.0.0 ... Edg/143.0.0.0
  Cookie: muid={random_hex};

Messages sent:
  1. speech.config (JSON) — output format + metadata options
  2. ssml (XML) — voice, rate, text wrapped in SSML

Messages received:
  - Text: audio.metadata (WordBoundary JSON) or turn.end
  - Binary: audio data (2-byte header length prefix + header + MP3 data)
```

> **Important**: CF Workers use `fetch()` with `https://` URL + `Upgrade: websocket` header, NOT `wss://` URL. The `wss://` scheme causes `"Fetch API cannot load"` errors.

## Comparison with edgetts-ws (Python)

| Feature | edgetts-ws-worker (CF) | edgetts-ws (Python) |
|---------|----------------------|---------------------|
| Runtime | Cloudflare Workers | Python + aiohttp |
| WebSocket library | From scratch (fetch + Upgrade) | `edge_tts` library |
| Hosting | Serverless (free tier) | VPS required |
| Latency | Global edge (~50ms) | Single location |
| Custom domain | ❌ workers.dev only | ✅ Any domain |
| Streaming | ✅ NDJSON | ✅ NDJSON |
| Timestamps | ✅ WordBoundary | ✅ WordBoundary |
| CPU time limit | 10ms free / 5min paid | Unlimited |
| Wall clock time | Unlimited | Unlimited |

> **About Workers time limits**: CF Workers distinguish between CPU time (actual computation) and wall clock time (total elapsed time including I/O wait). Our Worker spends most of its time waiting for Bing's WebSocket response (I/O), which does NOT count toward the CPU limit. The actual CPU usage (DRM hash, JSON serialization) is well under 10ms. So even on the free plan, there is effectively no time limit for TTS synthesis.
| DRM token | Web Crypto API | `edge_tts` built-in |

**Recommendation**: Use CF Worker as primary (lower latency, no maintenance), Python server as fallback (custom domain, no Workers limits).

## Word-by-Word Highlighting

Both this Worker and the Python server return identical timestamp data. See [edgetts-ws README](https://github.com/neosun100/edgetts-ws#word-by-word-highlighting-frontend-integration) for a complete frontend implementation guide.

For a full working example, see [pte-wfd-216](https://github.com/neosun100/pte-wfd-216) which implements a 4-level fallback chain using both backends.

## Development Lessons

1. **`wss://` doesn't work in CF Workers** — must use `fetch('https://...', { headers: { Upgrade: 'websocket' } })` instead
2. **Custom domains break outbound WebSocket** — this is a Cloudflare infrastructure limitation, not a code bug. Tested with both Workers Routes and AAAA `100::` records — both fail.
3. **DRM token is required** — without `Sec-MS-GEC`, Bing returns 403. Earlier attempts without DRM failed.
4. **Binary frame parsing** — WebSocket binary messages have a 2-byte big-endian header length prefix, then ASCII headers, then raw MP3 audio data.
5. **`TransformStream`** is the correct way to stream responses from a Worker while processing WebSocket events asynchronously.

## Companion Projects

| Project | Description |
|---------|-------------|
| [edgetts-ws](https://github.com/neosun100/edgetts-ws) | Same API as a Python server (VPS deployment) |
| [pte-wfd-216](https://github.com/neosun100/pte-wfd-216) | Example app with 4-level fallback + word highlighting |

## License

MIT
