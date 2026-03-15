# Changelog

## [1.0.0] - 2026-03-15

### Added
- Initial release
- Cloudflare Worker connecting to Bing TTS via WebSocket
- DRM token generation (`Sec-MS-GEC`) using Web Crypto API
- Streaming mode (NDJSON) and non-streaming mode (JSON)
- Word-level timestamps via `WordBoundary` events
- CORS support for browser frontends
- Speed control (0.5x–2.0x)

### Known Limitations
- Custom domains do not work for outbound WebSocket — must use `*.workers.dev` domain
