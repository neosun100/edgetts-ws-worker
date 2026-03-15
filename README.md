# edgetts-ws-worker

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Edge TTS](https://img.shields.io/badge/Edge_TTS-WebSocket-purple)](https://github.com/rany2/edge-tts)

A Cloudflare Worker that connects to Microsoft Edge TTS via WebSocket to provide text-to-speech with **word-level timestamps**. Supports both streaming (NDJSON) and non-streaming (JSON) modes. Serverless, globally distributed, zero infrastructure to maintain.

## How It Works

The Worker implements the full Edge TTS WebSocket protocol including DRM token generation (`Sec-MS-GEC`), Chrome fingerprint headers, and SSML message framing. It connects to Bing's TTS WebSocket, collects `WordBoundary` events and audio chunks, then returns them to the client.

```
Client POST → CF Worker (edge) → Bing TTS WebSocket → WordBoundary + audio
                                                              ↓
                                                   JSON or NDJSON stream
```

## ⚠️ Critical: Custom Domain Limitation

> **Outbound WebSocket connections from Cloudflare Workers only work on the default `*.workers.dev` domain.** Custom domains via Workers Routes (e.g., `edgetts.example.com`) will fail with "WebSocket upgrade failed" because Cloudflare's proxy layer interferes with the outbound WebSocket handshake.
>
> **Always use the `*.workers.dev` URL for this Worker.**

| Domain Type | Outbound WebSocket | Status |
|-------------|-------------------|--------|
| `*.workers.dev` | ✅ Works | Use this |
| Custom domain (Workers Route) | ❌ Fails | Do not use |
| Custom domain (AAAA 100::) | ❌ Fails | Do not use |

## Features

- 🎯 **Word-level timestamps** — precise offset + duration in milliseconds
- ⚡ **Streaming mode** — NDJSON for low-latency, real-time applications
- 📦 **Non-streaming mode** — single JSON response
- 🌍 **Global edge** — runs on Cloudflare's 300+ edge locations
- 🔐 **DRM token** — auto-generates `Sec-MS-GEC` token for Bing authentication
- 🆓 **Free tier** — 100K requests/day on Workers free plan
- 🌐 **CORS enabled** — ready for browser frontends

## Quick Start

### Deploy with Wrangler

```bash
npx wrangler deploy worker.js --name edgetts-ws-worker --compatibility-date 2024-12-13
```

The Worker will be available at `https://edgetts-ws-worker.<your-subdomain>.workers.dev`.

### Deploy via Dashboard

1. Go to [Cloudflare Dashboard → Workers](https://dash.cloudflare.com/?to=/:account/workers)
2. Create a new Worker
3. Paste the contents of `worker.js`
4. Deploy

## API

### `POST /v1/audio/speech`

Identical API to [edgetts-ws](https://github.com/neosun100/edgetts-ws) (the Python server version).

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

## DRM Token Generation

The Worker implements Microsoft's `Sec-MS-GEC` DRM token algorithm:

1. Get current Unix timestamp with clock skew correction
2. Convert to Windows file time epoch (add 11644473600 seconds)
3. Round down to nearest 5 minutes (300 seconds)
4. Convert to 100-nanosecond intervals
5. Concatenate with `TrustedClientToken`
6. SHA-256 hash → uppercase hex

This is computed using the Web Crypto API (`crypto.subtle.digest`).

## Architecture

```
┌─────────┐    HTTPS POST     ┌─────────────┐   WebSocket (https://)  ┌──────────────┐
│  Client  │ ────────────────→ │  CF Worker   │ ─────────────────────→ │ Bing TTS API │
│ (browser)│ ←──────────────── │ (workers.dev)│ ←───────────────────── │  (Microsoft) │
└─────────┘  JSON or NDJSON   └─────────────┘   audio + WordBoundary  └──────────────┘
```

Key implementation details:
- Uses `fetch()` with `Upgrade: websocket` header (not `wss://` URL)
- Sets `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold` to mimic Edge browser
- Generates random MUID cookie for each request
- Streaming mode uses `TransformStream` for chunked response

## Comparison with edgetts-ws (Python)

| Feature | edgetts-ws-worker (CF) | edgetts-ws (Python) |
|---------|----------------------|---------------------|
| Runtime | Cloudflare Workers | Python + aiohttp |
| Hosting | Serverless (free tier) | VPS required |
| Latency | Global edge (~50ms) | Single location |
| Custom domain | ❌ workers.dev only | ✅ Any domain |
| Streaming | ✅ NDJSON | ✅ NDJSON |
| Timestamps | ✅ WordBoundary | ✅ WordBoundary |
| Max request time | 30s (Workers limit) | Unlimited |

**Recommendation:** Use CF Worker as primary (lower latency, no maintenance), Python server as fallback (custom domain, no Workers limits).

## Available Voices

| Voice | Accent |
|-------|--------|
| `en-US-AvaNeural` | 🇺🇸 US Female |
| `en-US-AndrewNeural` | 🇺🇸 US Male |
| `en-GB-SoniaNeural` | 🇬🇧 UK Female |
| `en-GB-RyanNeural` | 🇬🇧 UK Male |
| `en-AU-WilliamNeural` | 🇦🇺 AU Male |

Full list: `edge-tts --list-voices`

## License

MIT
