# Changelog

## [2.1.0] - 2026-08-03

Test-hardening release. A layered test suite (161 cases, zero external deps) was added and
immediately surfaced six real source defects, all fixed here. `src/worker.js` line coverage
is now 95%.

### Fixed
- **voice hijacked by `model`** — `{voice:"en-US-AvaNeural", model:"tts-1-nova"}` synthesized
  Chinese. Resolution now prefers an explicit real voice, then a voice alias, then the model
  alias (which was previously unreachable).
- **non-string `model` → 500** leaking `model.replace is not a function`. Now ignored safely.
- **CORS preflight advertised `Access-Control-Allow-Headers: null`** when the request omitted
  `Access-Control-Request-Headers` — could block cross-origin `Authorization` POSTs.
- **`cleanText` ate markdown link parens** — `[docs](url)` became `[docs](`. Markdown now
  runs before URL stripping.
- **`cleanText` mangled snake_case** — `my_func_name` → `myfuncname`. Underscore emphasis is
  now word-boundary aware.
- **`getSsml` leaked its internal nonce** when a `<break>` attribute contained `$&`. Now uses
  a function replacement.

### Added
- Layered test suite under `test/` (unit / integration / regression / e2e), Node's built-in
  runner, mock upstream harness, 322-voice snapshot.
- GitHub Actions CI (test + build + coverage) and tag-triggered deploy.
- Community health files, animated SVG architecture diagram, full README rewrite.

## [2.0.0] - 2026-08-03

生产服务 `edgetts.aws.xin`（Worker `edgetts-proxy`）此前无本地源码与版本管理。
本次将其纳管进本仓库，并修复一批缺陷。详见 [ROADMAP.md](ROADMAP.md)。

### Fixed
- **流式播放只播前 1.67 秒**：前端把部分 MP3 包成静态 Blob 交给 `<audio>`，
  MP3 @48kbit/s 下 10000 字节仅 1.67 秒，播完即 `ended`。流式模式改为强制 PCM
  （无容器，可边收边播）；容器格式移除增量 Blob 播放
- **接口完全无鉴权**：`if (env.API_KEY)` 在 binding 缺失时跳过整个校验块，
  实测无 key / 错误 key 均返回 200。改为缺 key 返回 503，开放须显式
  `ALLOW_ANONYMOUS=true`；key 比较改为常数时间
- **SSML 注入**：`voice` / `style` 直接插值进 SSML 属性。改为白名单校验 + 属性转义
- **流式 `concurrency` 失效**：内部实为串行循环。改为滑动窗口预取 + 保序写出，
  长文本 4374ms → 1053ms（4.2x）
- `writer.abort()` 后又无条件 `close()`，失败时客户端收到「短但合法」的音频
- `smartChunkText` 对无标点超长段落不切分，会把超限 chunk 发给上游
- OpenAI 别名映射逻辑错误，传 `voice:"shimmer"` 时不解析
- Token 过期时并发请求触发惊群，改为合并单次 in-flight
- `wrangler.toml` 的 `name` / `main` 指向不存在的目标，无法部署

### Added
- 参数全面校验（`speed` / `pitch` / `concurrency` / `chunk_size` / `input` 长度 /
  `response_format`），阈值集中于 `LIMITS`；错误响应含机器码 + 人话 + 实际值 + 限制值
- 上游瞬时失败重试（3 次，仅 401/408/429/5xx）
- 单元测试 15 项（`npm test`，零外部依赖）
- 构建流程：`ui/index.html` + `src/worker.js` → `dist/worker.js`

### Changed
- 仓库结构：`src/`（Worker）、`ui/`（前端）、`scripts/`（构建）、`test/`
- 原 `worker.js`（NDJSON + WordBoundary 时间戳）移至 `legacy/worker-ndjson.js`

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
