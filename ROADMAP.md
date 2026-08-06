# ROADMAP / TODO

审计日期：2026-08-03 · 审计对象：生产 Worker `edgetts-proxy`（服务 https://edgetts.aws.xin）
最近更新：2026-08-06（全局复盘 + 下一步规划，线上 `v2.22.0`）

---

## 下一步：只剩一项值得做

三天里 P0 全清、P1 的 3/4/7/8 关闭、P1-3 已裁定、P1-5 量化后判定不做。**剩下的清单里，
只有一项能改变「下一个 bug 会不会被发现」：**

| 优先级 | 项 | 为什么是这个顺序 |
|---|---|---|
| **1. 结构化日志**（P1-6） | 18 个日志点里 **17 个只在异常路径**，成功请求零日志 → 5xx 率/p99/重试率**没有分母** | 本轮三个 bug（分批栅栏白扔 2.5× 延迟、Deploy 三天没通、UI 数值贴错列）**全都是「没人在看」才活下来的**。补数据比补任何单个功能都值 |
| 2. 版本号一致性 ✅ 本次已做 | `package.json` 停在 2.20.0，CHANGELOG/tag 已 2.22.0，且无测试守护 | 15 分钟的事，已修 + 加测试 |
| 3. GitLab 跑 browser e2e | GitLab `node:22-slim` 无 Chrome，19 个 browser e2e **全跳过** | 但 GitHub 已在跑 19 个，重复收益有限 → 排在后面 |
| 4. `cleanText` 脏数据来源注释 | 违反项目自己的「容错代码必须注明脏数据来源」铁律 | 纯可维护性，无行为风险 |
| 5. TS 化 / 前端拆分 | `ui/index.html` 已 2460 行 | 大改动、零用户可见收益，**不建议现在动** |

**明确不做**（都有实测依据，不是拖延）：
- **P1-5 MP3 帧级拼接** —— 实测每边界仅 130ms padding、0 处可感知断点、ffmpeg 零告警。
  收益是 8 块省 0.9s 静音，成本是热路径新增帧解析。见下方 P1-5。
- **速率限制 / 收紧 CORS** —— by design，Neo 2026-08-03 明确。
- **P1-7 WordBoundary 合并** —— 架构上不可能（REST 端点实测不返回词边界）。

**一条判断原则**（本轮反复验证）：**先量，再改。** 本轮每个「可能有问题」的猜测被量化后，
一半变成了「确实是缺陷」（栅栏 2.5×、token 归因、UI 邻近性），另一半变成了「不值得做」
（MP3 padding）。没量之前两者长得一样。

---

## 背景：审计前的状态

审计发现线上服务的代码**没有任何本地副本或版本管理**。它是一个 1728 行的单文件 Worker（含内嵌 Vue 前端），
只存在于 Cloudflare 上。本仓库原有的 `worker.js`（166 行，NDJSON 协议）与线上是**完全不同的两份代码**。

已完成的归位：

| 项目 | 归位后位置 | 说明 |
|---|---|---|
| 线上 Worker 逻辑 | `src/worker.js` | 生产代码，反压缩为可读源码 |
| 线上内嵌前端 | `ui/index.html` | 构建时注入回 Worker |
| 构建脚本 | `scripts/build.mjs` | `ui/` + `src/` → `dist/worker.js` |
| 分层测试 | `test/{unit,integration,regression,e2e}/` | `npm test`，零外部依赖 |
| 旧 NDJSON 版本 | `legacy/worker-ndjson.js` | 保留：带 WordBoundary 时间戳，`pte-wfd-216` 依赖 |
| 部署前备份 | `~/backups/edgetts-proxy/` | 含改动前的原始线上版本 |

---

## P0 — 已完成（本次已修复并部署）

### 1. 流式播放被截断，只播前 1.67 秒 ✅

**症状**：选择「生成语音（流式）」时只播放开头一小节就停止。

**根因**（原 `edgetts-proxy.js:1432`）：

```js
if (!hasStartedPlaying && self.streamStats.size > 10000) {
  const partialBlob = new Blob(audioChunks, { type: 'audio/mpeg' });
  self.audioSrc = URL.createObjectURL(partialBlob);   // 静态 Blob
```

MP3 @ 48 kbit/s 下 10000 字节 = **1.67 秒**。`<audio>` 拿到的是一个「完整的 1.67 秒文件」，
播完即 `ended`。后续 chunk 仍被追加进数组，但 `audioSrc` 直到流结束才替换，播放早已停止。

服务端实测无问题（PCM 449400 B = 9.36s、MP3 56592 B ≈ 9.4s 均完整）——**故障纯在前端**。

**修复**：
- 流式模式强制 `response_format=pcm`。PCM 无容器、无帧同步，每个 chunk 可独立解码，
  由 Web Audio API 的 `nextPlayTime` 时间轴连续调度 —— 这才是真流式。
- 同时移除 MP3 路径的增量 Blob 播放（防御性）：容器格式改为收完再播，不再静默截断。
- UI 增加提示说明流式会改用 PCM（降级留痕，不静默改行为）。

**验证**：流式 PCM 输出与非流式**字节数完全一致**（449400 B = 9.36s）。

### 2. 生产接口完全无鉴权 ✅

原代码：

```js
if (env.API_KEY) {   // 线上 bindings 为空 → env.API_KEY 是 undefined → 整块跳过
```

实测确认：不带 `Authorization`、带错误 key，**均返回 200**。任何人可白嫖。

这是典型的静默降级：「未配置密钥」与「密钥校验通过」两条路径在日志里长得一模一样。

**修复**：
- 缺少 `API_KEY` 时返回 **503 + 明确错误码**，而非降级为公开访问。
- 要开放访问必须显式设置 `ALLOW_ANONYMOUS=true`，并打 warn 日志留痕。
- key 比较改为常数时间（`timingSafeEqual`），避免按字节爆破。
- 已绑定 `API_KEY` secret 到生产。实测：正确 key → 200，错误 key → 401，无 key → 401。

### 3. SSML 注入 ✅

`getSsml()` 把 `voiceName` / `style` 直接插值进 SSML 属性，无校验无转义：

```
voice = `x"><prosody rate="-100%">INJECTED</prosody></voice><voice name="y`
```

可注入任意 SSML 元素（改语速、插入 `<audio src>` 拉取外部资源等）。

**修复**：白名单校验（`VOICE_RE` / `STYLE_RE`）+ 属性转义双重防护。
`VOICE_RE` 边界对照线上真实语音列表校准（322 个语音全部通过，注入 payload 全部拒绝）。

### 4. 流式模式 `concurrency` 参数完全失效 ✅

`pipeChunksToStream` 接受 `concurrency` 但内部是串行 `for` 循环，参数被忽略。
长文本流式受限于每 chunk 的往返延迟。

**修复**：改为滑动窗口预取（保持 N 个合成请求在途）+ 严格保序写出。

**实测**：12 段长文本 **4374ms → 1053ms（4.2× 提速）**，输出字节数完全一致。

### 5. 其他已修复项 ✅

| 问题 | 说明 |
|---|---|
| `writer.abort()` 后又 `close()` | 原 `finally` 无条件 close，与 abort 冲突；失败时客户端会收到「短但合法」的音频，与正常结果无法区分 |
| `smartChunkText` 超长段不切分 | 无标点长段落会产生超过 `maxChunkLength` 的 chunk 发给上游；已改为强制切分 |
| OpenAI 别名映射失效 | `!voice ? MAP[...] : null` 逻辑导致传 `voice:"shimmer"` 时别名不解析；已修正 |
| 参数无校验 | `speed`/`pitch`/`concurrency`/`chunk_size`/`input` 长度/`response_format` 全部加校验，阈值集中在 `LIMITS` |
| 错误信息不含实际值 | 错误响应现在同时给：机器码、人话、实际值、限制值 |
| Token 刷新惊群 | N 个并发 chunk 遇到过期 token 会触发 N 次 token 请求；已合并为单次 in-flight |
| 上游瞬时失败无重试 | 增加 3 次重试（仅对 401/408/429/5xx），401 强制刷新 token |
| `wrangler.toml` 配置错误 | `name` 与 `main` 都指向不存在的目标，无法用 wrangler 部署；已修正 |

---

## 设计决策：保持开放访问（2026-08-03，Neo 明确）

本服务的定位是「让尽可能多的人能用」，因此以下两项**按设计不做**，不是待办：

### ❌ 速率限制 —— 不做（by design）
不加任何限流。已绑定的 `API_KEY` 是唯一门槛，持有 key 即可自由使用。
（代价：key 泄漏时可被跑满配额。已知并接受。）

### ❌ CORS 收紧 —— 不做（by design）
保持 `Access-Control-Allow-Origin: *`，允许任意来源跨域调用，方便第三方前端集成。

> 若未来定位改变（如商用限额），再回到「限流 + 来源白名单」方案；当前明确不做。

---

## P1 — 建议下一步

### 3. 前端 API key 存储 ✅ 已裁定（2026-08-06，Neo 决策）

key 明文存 `localStorage`，任何同源脚本可读。**裁定：文档化边界，不改后端会话。**

理由：后端会话（同源 cookie + 服务端持有 key）与本项目的立足点冲突 —— 任何人一条
`wrangler deploy` 就能部署副本，引入会话存储会给这条路径加依赖。把 key 交给浏览器是这份
简洁的代价，**这个边界选择被写明，而不是被藏起来**。

**已收口的三条**（双语 README 各有一节，且由 `test/unit/pure-helpers.test.mjs` 钉住）：
- Vue 固定到 3.5.40 + sha384 SRI + `crossorigin`（缺 `crossorigin` 时 SRI 会**静默失效**，
  所以这一项单独断言）。线上验证 SRI 生效、322 音色正常。
- UI 自身注入面为零：`v-html` / `innerHTML =` / `eval` 实测各 0 处。
- `localStorage` 读回值逐字段类型检查，不浅展开 —— 见下方补记。

**顺带修掉一个真缺陷**：`tts_config`（存 baseUrl 与 API key）此前用的是无保护的
`{ ...this.config, ...JSON.parse(saved) }` —— 与早先已在 `tts_form` 上修掉的是同一形状，
但 config 漏了，而它恰好是存 key 的那个。实测把 `apiKey` 改成 `null` / `42` / `[1,2]` 后点
「生成语音」，`generateSpeech()` 的 `.trim()` 抛**未捕获**异常，页面既不报错也不动 ——
用户看到的是「按钮点了没反应」，最难查的那种症状。已改为逐字段只收字符串，非法值退回默认，
落到既有校验上给出「请填写 API 配置和输入文本」。

原有的 malformed-localStorage e2e **没能发现它**：那张表里 `tts_config` 只有 `{{{` 和 `[]`
两例，而这两例本就被 `try` 与 `Array.isArray` 挡住了。真正的漏洞是**格式合法、字段类型错**，
且它只在**点击生成时**才触发 —— 而那个测试只断言到「页面还能挂载」。现已补 7 个类型错例，
并在每一例后真正点一次生成按钮、断言无未捕获异常。

### 4. 请求体大小上限 ✅ 已完成
`input` 限 50000 字符外，整体请求体限 256KB。双重检查：先看 `Content-Length` 快速拒绝，
再量实际字节数兜底（chunked 传输下没有 `Content-Length`，只靠声明值可被绕过）。
超限返回 413 `payload_too_large`，附实际值与上限。

### 5. MP3 分块边界的 padding · 已量化，判定为**低优先级**（2026-08-06 实测）

原文写「块边界可能有极短的不连续」—— **「可能」已经量化掉了**。同一段文本（8 块 vs 单块，
`chunk_size` 40 vs 2000），线上实测：

| | 时长 | 帧数 | 体积 |
|---|---|---|---|
| 多块拼接 | 36.576s | 1524 | 219456B |
| 单块 | 35.664s | 1486 | 213984B |

- **多出 0.912s = 38 帧**，即每个边界约 **130ms**（7 个边界）。两种算法交叉验证一致：
  实测 24.00ms/帧 → 576 样本/帧（MPEG-2 Layer III @24kHz。我一开始按 MPEG-1 的 1152
  算成 1.824s，与时长差不上，是错的 —— **两个推导不一致时必有一个错，不能都写进文档**）。
- **不丢音频**：`ffprobe` 时长完整，`ffmpeg -f null` 零解码告警。
- **无可感知断点**：`silencedetect -45dB:d=0.3` 在多块与单块中**各检出 0 处**。

即：边界现象是「每块开头多了编码器 padding 的极短静音」，不是爆音、不是丢帧、不是间断。
帧级拼接能省掉这 0.912s，代价是解析 MP3 帧头并剥离每块 padding。

**判定：不做**（除非有人真的报告听感问题）。理由：收益是 8 块省 0.9s 的静音，而成本是在
10ms CPU 预算内新增一套帧解析逻辑 —— WAV/WebM 合并是**必须**做（不做会丢 58%/90% 音频），
MP3 这个不是同一量级的问题。**已做的两个容器合并才是真缺陷，这个是打磨。**

### 6. 可观测性 · **P1 里唯一还有实质价值的一项**（2026-08-06 量化）

`wrangler.toml` 已开 `[observability]`，但日志内容本身有个结构性缺口 —— 实测统计
`src/worker.js` 的 18 个日志点：

| 类别 | 数量 |
|---|---|
| `console.error` / `console.warn`（**仅异常路径**） | **17** |
| `console.log`（正常路径） | **1** —— 且只记「成功获取新 Token，有效期 N 分钟」 |

**即：一个成功的 200 请求不产生任何日志。** 后果是这些问题现在全都答不出来：

- 哪些音色/格式真的被用？（决定该不该继续维护 322 个音色的映射表）
- p50/p99 延迟多少？分块数分布如何？（决定 `MAX_CHUNKS=45` 与默认 `chunk_size=300` 是否合理）
- 重试率多高？上游 401 频率？（现在只有出错才留痕，无法算「率」——**没有分母**）

这与本轮修掉的两个 bug 是同一根源：**分批栅栏白扔 2.5 倍延迟、Deploy workflow 三天没通，
都是「没人在看」才活下来的。** 缺的不是告警规则，是可被聚合的正常路径数据。

**建议做法**（一条日志一个请求，避免 10ms CPU 预算下的开销累积）：
```
console.log(JSON.stringify({
  ev: "speech", ok: true, ms: <耗时>, voice, format, chunks,
  concurrency, retries: <本请求重试次数>, bytes: <响应体大小>
}))
```
- 单条 JSON，落在响应返回**之后**（`ctx.waitUntil` 不适用于 CPU，但 JSON.stringify 一次
  的成本可忽略 —— 需实测确认在 1.96ms 中位数上的增量）。
- **不记录 input 文本、不记录 API key**（就算哈希也不记：文本是用户内容）。
- 有了这条，5xx 率 / 401 率 / p99 才有分母，Cloudflare 的 Logpush + Workers Analytics
  就能直接聚合，不必自建后端。

**风险**：这是唯一会碰生产热路径的改动，必须先量 CPU 增量（项目已有
`test/unit/redos.test.mjs` 的线性伸缩测试可复用同一手法）。

### 7. WordBoundary 时间戳 · 🔒 架构上无法合并（2026-08-04 实测结论）

原计划是「在 `edgetts-proxy` 加个 `/timestamps` 端点或支持 `response_format: ndjson`，
把两套实现合并」。实测后确认**这条路走不通**，改为明确记录约束与可用路径。

**实测证据：**

| 检验项 | 结果 |
|---|---|
| REST 端点（`cognitiveservices/v1`）能否返回词边界 | ❌ 试了裸请求、`X-Microsoft-OutputFormat-WordBoundary`、`Ocp-Apim-Subscription-Key` 三种组合，**均只回纯音频**（15264B，响应头零时间戳字段） |
| legacy WebSocket 版是否还有时间戳 | ✅ 完好：非流式返回 4 词精确 `offset`/`duration`；NDJSON 流式返回 19 audio + 4 word + 1 done |

**为什么不能合并：** 词边界只存在于 WebSocket 协议（`wordBoundaryEnabled` + `Path:audio.metadata`
消息），而**出站 WebSocket 只能跑在 `*.workers.dev`** —— 自定义域名下 CF 代理层会破坏到 Bing
的 WS 握手（见文末架构约束 #1）。所以同一个自定义域名的 worker 里，物理上不可能同时提供
REST 裸流与 WS 时间戳。

**当前可用路径（下游按需选择）：**

| 需求 | 用哪个 | 地址 |
|---|---|---|
| 语音合成（主用） | 生产 REST worker | `https://edgetts.aws.xin/v1/audio/speech` |
| **逐词时间戳**（如 `pte-wfd-216` 的逐词高亮） | legacy NDJSON worker | `https://edgetts-ws-worker.neosun808.workers.dev/` |

**因此 `legacy/` 保留而非删除** —— 它不是死代码，是唯一的时间戳来源，已由
`test/e2e/legacy-timestamps.test.mjs` 锁定契约（词序、offset 单调递增、NDJSON 事件构成）。
若微软将来给 REST 端点加上词边界，那个 e2e 里的第三条测试会开始失败，届时即可合并。

### 8. CI ✅ 已完成（2026-08-06 更正了一处不实描述）
GitLab CI（`.gitlab-ci.yml`）+ GitHub Actions（`ci.yml`）双跑：syntax check + build +
测试 + coverage + 校验 dist 不含 `__test__`。

**此处原写「全量测试」，不准确。** 实测两边跑的**不是同一批**：

e2e 共 28 项 = **19** browser（`browser-playback`，需 Chrome）+ **3** legacy 时间戳
+ **6** real-synth（后两者需访问已部署服务）。两边实测：

| | 镜像 | fast 层 283 | 19 browser | 9 真网 |
|---|---|---|---|---|
| GitHub Actions | `ubuntu-latest`（**预装 Chrome**） | 全跑 | ✅ **全跑** | 跳过 |
| GitLab CI | `node:22-slim`（**无 Chrome**） | 全跑 | ❌ **全跳过** | 跳过 |

GitLab 日志实测：`# tests 28 / pass 0 / skipped 28`，原因 `Chrome unavailable or not
launchable`。GitHub 实测：`# tests 28 / pass 19 / skipped 9`。

所以 **UI 回归的自动防线只有 GitHub 一条**，GitLab 只覆盖后端。自动 skip 是刻意设计（否则
镜像差异会让构建无故变红），但**边界要写明**：GitHub 一旦长期不可用，UI 就退回「只有本机
`npm test` 才守得住」。见 P2「让 GitLab 也能跑 browser e2e」。

### 9. 部署链路 ✅ 已修（2026-08-06）
`v2.22.0` 之前 **Deploy workflow 从未成功过一次**（`{"failure": 2}`）：repo 从来没配
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，`v2.1.0` 三天前就以同样原因失败。
线上那个版本其实是手工 `wrangler deploy` 上去的 —— 路径一直坏着，只因平时不打 tag，
就没人看到它红。两个 secret 已配好，并**重跑 v2.22.0 确认 success**（该 workflow 史上首次）。

教训：**「配好了」不等于「能用」**，必须真跑一次。另：一条从不执行的路径不会变红，
所以它的损坏是静默的 —— 与 P1-6 可观测性是同一类问题。

---

## P2 — 可选打磨

| 项 | 说明 |
|---|---|
| **版本号漂移**（新） | `package.json` 停在 `2.20.0`，而 CHANGELOG / git tag 已是 `2.22.0`。它在项目开头设过一次就没再维护，**且无任何测试守护**。低成本：改对 + 加一条一致性测试（对比 package.json / CHANGELOG 首个版本号 / 最新 tag） |
| 让 GitLab 也能跑 browser e2e（新） | 现 `node:22-slim` 无 Chrome，19 个 browser e2e 全跳过。换 `zenika/alpine-chrome` 或 playwright 镜像即可，但需确认内部 runner 能拉该镜像。**收益有限**：GitHub 已在跑这 19 个，重复跑主要是防「GitHub 挂了没人兜」 |
| TypeScript 化 | 现为 JS。加 `// @ts-check` + JSDoc 是低成本折中，无需改造构建 |
| 前端拆分 | `ui/index.html` 已 **2460 行**（原记 1200+，已翻倍），含 322 语音的语言映射表。可抽出数据表 |
| ~~语音列表缓存~~ ✅ | 已完成：进程内 6 小时缓存 + `Cache-Control: max-age=21600`；并发合并；上游故障时返回过期缓存(留 warn 痕迹)，冷启动失败才降级到内置列表(`no-store`) |
| `cleanText` 的容错来源注释 | 多处正则清理未说明脏数据来源，半年后无人知道是否还需要 |
| ~~前端 e2e~~ ✅ | 已完成：用**裸 CDP**(本机 Chrome + Node 内置 WebSocket)驱动真实浏览器，**零依赖**、不引入 Playwright。现有 **19 项** browser 测试（原记 8 项）。无 Chrome 时自动 skip。**首次运行即抓到一个真实 bug**(见 CHANGELOG 2.8.0) |
| ~~`legacy/` 的去留~~ ✅ | 已裁定**保留**：它是逐词时间戳的唯一来源（P1-7 实测证明无法合并进生产 worker），已由 e2e 锁定契约，不是死代码 |

---

## 项目现状快照（2026-08-06 实测）

| 维度 | 数字 | 备注 |
|---|---|---|
| 生产代码 | `src/worker.js` 1430 行 + `ui/index.html` 2460 行 | 单文件 Worker + 内嵌 Vue SPA |
| 测试代码 | 7988 行 / 313 项 | 测试:源码 ≈ **2:1** |
| `src/worker.js` 覆盖率 | **99.51% 行 / 98.25% 分支** | 未覆盖仅 2 处，均为已证不可达的防御分支 |
| 运行时依赖 | **0** | `node_modules` 空；构建与测试只用 Node 内置能力 |
| 提交数 | 89（38 fix / 24 docs / 10 test / 9 feat / 4 perf） | Conventional Commits |
| 线上版本 | `v2.22.0`（version id `11d201b3`） | `https://edgetts.aws.xin` |
| 硬编码密钥扫描 | 干净 | 唯一硬编码 base64 是微软 Edge TTS 客户端的**公开固定签名密钥**（逆向公知），非用户凭据 |

**「all files 78.67%」这个数字会误导**：它把 `dist/worker.js`（构建产物，仅被少数测试读取，
70.94%）也算进去，拉低了均值。真正该看的是 `src/worker.js` 的 99.51%。

---

## 已知的架构约束（不是 bug）

1. **出站 WebSocket 只能走 `*.workers.dev`** —— 自定义域名下 CF 代理层会破坏到 Bing 的
   WebSocket 握手。这影响 `legacy/worker-ndjson.js`，不影响生产的 `edgetts-proxy`（走 REST）。
2. **CF Workers 不能用 `wss://`** —— 必须 `fetch('https://...', { headers: { Upgrade: 'websocket' } })`。
3. **CPU 时间 vs 挂钟时间** —— 本服务绝大部分时间在等上游 I/O，不计入 CPU 配额。

## 命令速查

```bash
npm test        # 单元 + 集成 + 回归（226 项，零依赖）
npm run test:e2e # E2E，需 EDGETTS_E2E=1
npm run coverage # 覆盖率（当前 src/worker.js 行 99.2% / 分支 98.0%）
npm run check   # 语法检查 + 单测
npm run build   # ui/ + src/ → dist/worker.js
npm run deploy  # 构建并部署（需 wrangler + API_KEY secret 已绑定）
```
