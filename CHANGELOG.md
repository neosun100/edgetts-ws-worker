# Changelog

## [2.7.0] - 2026-08-04

### Added
- **语音列表缓存**（ROADMAP P2）—— 语音列表极少变动（连日核对均为 322 条），却此前
  **每个请求都穿透到微软上游**（实测 52KB / 最高 483ms，且完全没有 `Cache-Control`，
  浏览器每次开页面都重拉）。现在两层缓存：
  - 进程内缓存，TTL 6 小时；`/v1/models` 与 `/v1/models/public` 共用
  - 响应头 `Cache-Control: public, max-age=21600`，让浏览器与 CF 边缘也能缓存
  - **并发合并**：冷启动时 N 个同时到达的请求只打一次上游（实测 8 并发 → 1 次）
  - **降级分级**：TTL 过期但上游故障时返回**过期缓存**并打 warn（不静默）；只有
    冷缓存 + 上游故障才降级到内置的 2 条列表，且该降级响应标记 `no-store`
    ——降级产物不该被当成 6 小时有效的正常数据缓存
- 语音缓存的 8 项专项测试，含并发合并、过滤不污染缓存、过期缓存路径（真的走 stale
  分支并断言返回 322 条而非 2 条兜底）、以及 TTL 与 `max-age` 一致性。

### Changed
- 抽出 `getModels()` / `toModel()` / `modelsHeaders()`，消除两个 handler 里重复的
  fetch+map 逻辑。
- 覆盖率 98.51% → **98.58%**；测试 173 → **181**。
- `__test__` 增加 `resetVoicesCache()` / `expireVoicesCache()`，使涉及缓存的测试
  顺序无关（否则前一个测试填充的缓存会让后一个「是否打上游」的断言静默通过）。

## [2.6.0] - 2026-08-04

### Added
- **请求体大小上限（256KB）** —— 此前只限 `input` 字符数，但 `await request.json()` 会先把
  整个 body 读进内存**才**轮到校验，等于「先受伤再检查」：一个 `input` 合法、却塞了巨大
  `cleaning_options` 的请求可以绕过 `MAX_INPUT_CHARS` 白吃内存。现在双重检查 —— 先看
  `Content-Length` 快速拒绝，再量实际字节数兜底（chunked 下没有 `Content-Length`，
  只靠声明值可被绕过）。超限返回 413 `payload_too_large`，附实际值与上限。
- **上游失败路径测试（11 例）** —— 补齐生产最易出问题却一直没测的分支：上游 5xx 会重试、
  4xx 不重试、瞬时失败后恢复、token 端点宕机与恢复、语音列表故障时 `/v1/models` 降级到
  内置列表而 `/v1/models/public` 报 500、流式失败表现为 body 破裂（而非「短但合法」的音频）。

### Changed
- `src/worker.js` 覆盖率 95.37% → **98.51%**（分支 94.18% → 97.50%）。
- 测试总数 162 → **173**（+ E2E 6 例，真实凭证下打线上全绿）。

## [2.5.1] - 2026-08-04

### Fixed
暗色主题多处元素仍是浅色（用户截图反馈）。根因是变量体系有缺口，不只是个别样式写错：

- `--mint-start/middle/end`（近白的薄荷色）在暗色主题**完全没被覆盖**，导致页面背景
  与「当前音色」条变成大块白。
- `details`（API 配置 / 高级文本清理）背景写死 `rgba(248,250,252,0.8)`，未走变量。
- `.pause-input` 是 `type=number`，不匹配 `input[type=text]` 那组选择器，因此没继承
  `--input-bg`，暗色下是白底方块。
- 徽章与三种状态条（info/success/error）都是浅底深字硬编码，暗色下像贴纸；改为
  `--badge-* / --info-* / --ok-* / --err-*` 变量，暗色用深底亮字。
- `body` 的 `background-attachment: fixed` 只覆盖视口，页面（1789px）高于视口（1080px）时
  下方约 700px 露出浏览器默认白底；新增 `--page-base` 铺在 `html` 上兜底。
- 补 `color-scheme`（滚动条 / number 步进器等原生部件跟随主题）与 `select option` 配色。

同时加了一条一致性检查：列出 `:root` 中被 `var()` 引用但暗色未覆盖的变量，防止再出现
同类缺口（当前为 0 遗漏）。明暗两主题均已在浏览器与线上逐项核对。

## [2.5.0] - 2026-08-04

### Added
- **Audio-driven colour.** The visualiser's palette now encodes acoustic information
  instead of drifting arbitrarily:
  - **Hue ← spectral centroid** (log-mapped): low vowels render amber/orange, mid sounds
    violet, high fricatives (s/sh/f) cyan.
  - **Saturation ← spectral crest factor**: tonal (voiced) frames are vivid, noisy
    (unvoiced) frames wash out to grey.
  - **Brightness ← loudness**, as before.
  - **Per-voice hue offset ← fundamental frequency** (autocorrelation), so a given voice
    keeps a recognisable colour identity: measured f0 Yunjian 131Hz / Guy 148Hz /
    Ava 211Hz / Xiaoxiao 242Hz map to bias −12° … +14°.
  Every threshold is calibrated from measured distributions of real TTS output rather than
  guessed (centroid p5≈910Hz/p95≈4524Hz, crest p5≈1.43/p95≈3.25).
- `favicon.svg` / `favicon.ico` served **before** the auth check, so the browser's
  automatic request no longer logs a 401. The tab now shows the project logo.

### Changed
- HTML `Cache-Control` from `max-age=86400` to **`max-age=300, must-revalidate`** — a
  deploy is now picked up within minutes instead of needing a hard refresh.

### Fixed
- Spectral features were computed over all FFT bins, so hundreds of near-empty
  high-frequency bins dragged the centroid up (a 1.5kHz tone measured as 11.6kHz) and made
  flatness ≈0.98 always, pinning saturation. Now bounded to the vocal range with a
  magnitude floor, and tonality uses crest factor instead of flatness.

## [2.4.0] - 2026-08-04

### Added
- **Siri-style pulsing ring** — three polar-coordinate spectrum rings at staggered radii,
  counter-rotating, drawn as smoothed closed curves (circular moving-average + quadratic
  segments) with a breathing central halo.
- **Particle bursts** — an onset detector (frame-to-frame RMS jump) sprays glowing sparks
  from the ring edge, with velocity, damping, gravity and lifetime.
- **Theme-aware palette** — lightness and glow are offset on the light theme, and the hue
  is constrained to a cool cyan→violet→magenta band (calibrated to sweep the full band in
  ~8s) so it never drifts into muddy yellow-green or spill into red.

### Fixed
- **Ring had a sharp notch at angle 0 every frame.** Root cause found by measuring rather
  than guessing: FFT bin 0 (DC) always reads far lower than its neighbours (26 vs 89/141),
  so the mirrored mapping produced a dent. The band now skips the DC bin.

![Visualizer](docs/screenshots/viz-dark.png)

## [2.3.1] - 2026-08-04

### Changed
- **Visualizer reworked from spectrum bars to a scrolling pulse.** The frequency-domain
  bars animated in place (a "rainbow that shakes"); real players convey motion by moving
  along the time axis. Now it combines a scrolling amplitude history (voice-memo style,
  newest on the right, older bars fading) with a live time-domain waveform
  (`getByteTimeDomainData`) and a breathing center glow. Attack is instant and release
  decays, so each syllable reads as a distinct pulse. `fftSize` 256 → 1024 and
  `smoothingTimeConstant` 0.8 → 0.45 for a snappier, higher-resolution response.

## [2.3.0] - 2026-08-04

### Added
- **Live colorful spectrum visualizer** — playback (both streaming PCM and standard
  `<audio>`) drives a shared `AnalyserNode`, drawn as a mirrored, HSL-gradient bar
  spectrum on a canvas.
- **Light / dark theme** — a neon deep-space dark theme with a top-right toggle,
  persisted to localStorage and defaulting to the system preference on first visit.

### Fixed
- **build guard**: the build now rejects template literals (backtick / `${`) inside the
  UI's inline `<script>`. Such literals get escaped when the HTML is embedded in the
  worker's own template literal, which silently breaks the inline script so Vue never
  mounts (page shows raw `{{ }}`). The guard fails the build with the offending line.

## [2.2.0] - 2026-08-04

### Added
- **Voice picker overhaul** — the 322 voices are now filterable by search / language /
  region / gender / “multilingual only”, shown as a card list with each voice's full
  `ShortName` + one-click copy (for pasting into API calls). All voices remain selectable.
- Project **logo** (`docs/logo.svg`) and a **Web UI screenshot** in the READMEs.
- **GitLab CI** (`.gitlab-ci.yml`) mirroring the GitHub Actions pipeline; GitLab is the
  primary CI, GitHub a private backup.

### Fixed
- Multilingual voices were indistinguishable in the old dropdown — the display name
  stripped the word “Multilingual”, colliding en-US Ava/Andrew/Brian/Emma with their
  single-language namesakes. They now carry a 🌏 badge and are filterable.

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
