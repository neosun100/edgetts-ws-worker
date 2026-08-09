# ROADMAP / TODO

> **本文件的 P0/P1/P2 已全部关闭，现在是一份历史记录。**
> 「将来也许值得做、但当前明确不做」的事记在 [`docs/FUTURE_WORK.md`](docs/FUTURE_WORK.md)。
>
> **接手这个项目？先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)。** 那份讲「这是什么项目、
> 为什么这么做、动手前必须知道哪些坑」；本文件只列「做什么 / 做完了什么」。

审计日期：2026-08-03 · 审计对象：生产 Worker `edgetts-proxy`（服务 https://edgetts.aws.xin）
最近更新：2026-08-09（里程碑 v2.30.3 发布，线上 `v2.30.3`）

---

## 下一步：只剩一项值得做

P0 全清、P1 全部关闭（3 已裁定、5 量化后判定不做、6 已完成、7 架构不可行、4/8/9 已完成）。
P2 里 6/7 已完成或裁定。**唯一还值得做的是「让 GitLab 也能跑 browser e2e」** ——
优先级因 GitHub Actions 的一次 `major_outage` 上调（详见下表）。

| 优先级 | 项 | 为什么是这个顺序 |
|---|---|---|
| ~~1. 结构化日志~~ ✅ **已完成** | 每请求一行 JSON，成功请求也有；顺带修掉流式日志「记在响应头而非流结束」的假数据 | 见 P1-6 |
| ~~2. 版本号一致性~~ ✅ 已完成 | `package.json` 曾停在 2.20.0，CHANGELOG/tag 已 2.22.0，且无测试守护 | 已修 + 加测试 |
| ~~3. 用日志回答维度问题~~ ✅ **已做** | 用新日志跑了三轮维度普查（voice / format / chunks），**每一轮都抓到真 bug** | 见下方「日志驱动的三轮普查」 |
| ~~4. `cleanText` 脏数据来源注释~~ ✅ 已完成 | 三处补上来源与后果 | 见 P2 |
| ~~5. GitLab 跑 browser e2e~~ ✅ **已完成** | 拆出 `test:browser` job（`node:22-bookworm-slim` + apt chromium），21 项**全跑、0 skip** | 见下方「双 CI 覆盖」 |
| 6. TS 化 / 前端拆分 | `ui/index.html` 已 2463 行 | 大改动、零用户可见收益，**不建议现在动** |

**明确不做**（都有实测依据，不是拖延）：
- **P1-5 MP3 帧级拼接** —— 实测每边界仅 130ms padding、0 处可感知断点、ffmpeg 零告警。
  收益是 8 块省 0.9s 静音，成本是热路径新增帧解析。见下方 P1-5。
- **速率限制 / 收紧 CORS** —— by design，Neo 2026-08-03 明确。
- **P1-7 WordBoundary 合并** —— 架构上不可能（REST 端点实测不返回词边界）。

**一条判断原则**（本轮反复验证）：**先量，再改。** 本轮每个「可能有问题」的猜测被量化后，
一半变成了「确实是缺陷」（栅栏 2.5×、token 归因、UI 邻近性），另一半变成了「不值得做」
（MP3 padding）。没量之前两者长得一样。

---

## 双 CI 覆盖（2026-08-08）

UI 回归此前只有 GitHub 一条自动防线。2026-08-06 GitHub Actions 出现 `major_outage`
（官方状态页确认 `Actions: major_outage`）：同一 commit 在 GitLab 通过，而 GitHub 连 runner
都拿不到（job `steps` 数为 0，等 15 分钟被 cancelled）。**那天 21 个 browser e2e 一个都没跑**，
UI 只剩本机 `npm test` 守着。

现在 GitLab 拆成两个并行 job：

| job | 镜像 | 内容 | 耗时 |
|---|---|---|---|
| `test` | `node:22-slim` | 后端 326 项 + build + dist 守卫 | ~51s |
| `test:browser` | `node:22-bookworm-slim` + apt chromium | 21 项 browser e2e | ~193s |

**为什么拆开而不是合成一个**：apt 装 chromium 是耗时主项（50s → 193s）。合成一个会让每次
改后端也等满 193s；拆开后两者并行，总墙钟不变，但后端结论 51s 就有。

**镜像是实测选的，不是猜的**。探针分支 `probe/gitlab-chrome` 一次流水线并行试三个：

| 候选 | Node | Chrome | 结论 |
|---|---|---|---|
| `zenika/alpine-chrome:with-node` | 20.15 ⚠️ | Chromium 124 @ `/usr/bin/chromium` | Node 版本与仓库不符 |
| `mcr.microsoft.com/playwright:v1.49.1-jammy` | 22.12 | **不在任何标准路径** | `cdp.mjs` 找不到 |
| **`node:22-bookworm-slim` + apt** | **22.23** | **Chromium 151** | ✅ 采用 |

**关键设计:防「静默全 skip」守卫**。e2e 在找不到 Chrome 时是 **skip 而非 fail**（刻意设计，
否则无 Chrome 的机器会无故变红）。这意味着一旦镜像里的 Chrome 出问题，这个 job 会报
「21 ok」并**永远绿，却什么都没守住**。所以 job 末尾显式检查 `# skipped` 与 `# pass`
的数量。已用变异验证：把 `CHROME_PATH` 指向不存在的路径并跳过 apt 安装 →
`test:browser` **failed**。

这与本仓库另一次教训是同一件事：`__test__` 守卫此前只存在于 CI，`npm test` 跑不到它，
于是「本地绿」不等于「CI 绿」。**一个不会失败的守卫等于没有守卫。**

另一处细节：`| tee` 会让管道的退出码取 `tee` 的（永远 0），测试失败会被吞掉。
所以那一步显式 `set -o pipefail`。

---

## 日志驱动的三轮维度普查（2026-08-06/07）

P1-6 上线结构化日志后，用它逐个维度看真实数据。**三轮各抓到一个真 bug** —— 这就是做
可观测性的回报，也是「先量再改」这条原则最直接的证据。

| 维度 | 抓到的缺陷 | 性质 |
|---|---|---|
| **voice** | 上游对「音色对该书写系统零覆盖」返回 **200 + 0 字节**，被原样透传成成功 | 静默失败，已改为 502 `upstream_empty_audio` |
| **voice（全量普查）** | 无缺陷：322/322 音色都能合成自己语种 | 规律是**书写系统**而非语种；Multilingual 音色 9/9 通吃 |
| **chunks** | 413 文案宣称一个**自相矛盾**的容量（拒了 50000 字符却说 50580 可行） | 已改为二分实算可行值 |

另有两项**量化后判定不做**（不是拖延，有实测依据）：

- **MP3 分块 padding**：每边界仅 130ms、`silencedetect` 检出 **0 处**可感知断点、
  `ffmpeg` 零解码告警。收益配不上在 10ms CPU 预算内新增帧解析的成本。
- **希腊文送错音色**：不是空音频而是**错误音频**（逐个念字母名，时长 3.4 倍），
  现有 502 拦不住。判断「音频内容是否正确」需要启发式，误伤风险高，且用户听一遍就知道。

**五轮系统审计的方法论产出**（比缺陷本身更值得记）：真缺陷 : 假警报 ≈ **1 : 4**，
且假警报几乎全是同一形态 —— **为了验证 X 而手写一个 X 的实现，然后信了它**。
手写的 XML 良构检查器、EBML 字节扫描器、对比度计算器、注入元素选择器、RAF 泄漏探针
五个全错了。有效判据顺序：**可观测的最终结果**（截图 / 资源累积 / 时长）>
**标准工具**（`xml.etree` / `ffprobe`）> **被测代码自己的解析器** > 手写。
另外两条：荒谬的数字就是探针错了的信号；「通过」也要看是不是空洞的
（0 元素上的 `every()` 恒为 true）。

详见 `docs/research/` 下五份报告。

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

### 6. 可观测性 ✅ 已完成（2026-08-06）

**做之前的状态**：18 个日志点里 **17 个只在异常路径**，唯一那条正常路径日志记的是 token
有效期 —— 一个成功的 200 请求不产生任何日志。于是 5xx 率 / p99 / 重试率**都没有分母**。

**已做**：每个请求输出恰好一行 JSON（成功的也有），字段见双语 README 的「可观测性」一节。
两处设计决定值得记下来：

1. **每请求一个上下文对象，不用模块级「当前请求」变量。** Workers 单个 isolate 会并发处理
   请求并在每个 `await` 处交错。写代码前先验证过那个错误形状：3 个并发请求（延迟
   30/5/15ms）用模块级变量记日志，**三条全部记成最后开始的那个请求**。这种错在日志里是
   看不出来的 —— 数据看着完全合理。已由测试钉住（改成模块级会让它变红）。
2. **日志埋在 `handleRequest` 这一个漏斗上**，而不是 `handleSpeechRequest` 的 20 个出口。
   逐个包裹既冗长、又必然漏掉以后新增的那个。

**过程中发现并修掉一个真缺陷**：流式路径的响应头在合成开始前就发出，所以漏斗那次 emitLog
会在**合成还没开始**时跑 —— 实测记出 `ms:6, upstream:0`，而该请求实际打了 4 次上游、耗时
192ms。**这种数据比没有更糟**：它会把每个流式请求的 p99 与上游用量都算低，而且数字看着
很正常。改为流式自己在流结束时记录（`phase: stream_end`），中途断流记
`phase: stream_broken` —— 响应头一发出 HTTP 状态就锁在 200 了，日志是断流**唯一**看得见
的地方。

**CPU 成本**：序列化一行实测 0.00013ms，占最坏合法请求（约 3.2ms）的 **0.004%**，比机器
噪声（0.121ms）低三个数量级。关键设计：**只对 >=400 的响应 clone** 以取回错误码 ——
几 MB 的音频体永远不 clone。已加测试盯住这个比例（<5%），免得以后加字段悄悄吃预算。

**安全**：绝不记 API key、绝不记 input 文本（连哈希、连截断都不记）。`chars` 只带长度。

**测试**：新增 15 项（`test/integration/structured-logs.test.mjs`）+ 1 项 CPU 比例测试。
逐个验证过对着它所守护的实现会变红，含 8 个变异：改模块级共享、去掉成功路径日志、
把 input 记进去、级别全用 log、不计重试、回退流式日志、断流记成 stream_end、
往日志加未写进文档的字段。

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
| GitLab CI | `test` = `node:22-slim`；`test:browser` = `node:22-bookworm-slim` + apt chromium | 全跑 | ✅ **全跑**（2026-08-08 起） | 跳过 |

GitLab 日志实测：`# tests 28 / pass 0 / skipped 28`，原因 `Chrome unavailable or not
launchable`。GitHub 实测：`# tests 28 / pass 19 / skipped 9`。

**2026-08-08 起两边都跑 browser e2e**，UI 回归有了两条独立防线。此前只有 GitHub 一条，
而 2026-08-06 GitHub Actions 的 `major_outage` 正好暴露了那个单点：那天 UI 回归实际上
没有任何 CI 防线。详见下方「双 CI 覆盖」。

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
| ~~**版本号漂移**~~ ✅ | 已修（2.28.1）：`package.json` 曾停在 2.20.0 而 CHANGELOG/tag 已 2.22.0，且无守护。现有一致性测试比对 `package.json` 与 CHANGELOG 首个版本号（刻意**不查 git tag** —— 测试必须能在浅克隆与无 `.git` 的 tarball 里通过） |
| ~~让 GitLab 也能跑 browser e2e~~ ✅ | 已完成（2.30.0）：拆出 `test:browser` job。镜像是**实测选出来的**，探针分支一次流水线并行试了三个 —— `zenika/alpine-chrome:with-node` 有 Chromium 124 但 Node 只有 20.15（本仓库用 22）；`mcr.microsoft.com/playwright` 有 Node 22 但 Chrome 不在任何标准路径下，`cdp.mjs` 找不到；`node:22-bookworm-slim` + apt chromium 两项都对（Node 22.23 + Chromium 151），实测 21 项全跑、0 skip |
| TypeScript 化 | 现为 JS。加 `// @ts-check` + JSDoc 是低成本折中，无需改造构建 |
| 前端拆分 | `ui/index.html` 已 **2463 行**（原记 1200+），含 322 语音的语言映射表。可抽出数据表 |
| ~~语音列表缓存~~ ✅ | 已完成：进程内 6 小时缓存 + `Cache-Control: max-age=21600`；并发合并；上游故障时返回过期缓存(留 warn 痕迹)，冷启动失败才降级到内置列表(`no-store`) |
| ~~`cleanText` 的容错来源注释~~ ✅ | 已完成（2.26.0）：`remove_urls` / `custom_keywords` / `remove_line_breaks` 三处补上「脏数据从哪来、不容错的后果是什么」。其中 `remove_line_breaks` 注明了**必须放在最后**的原因：前面每条清理都会产生新的连续空白 |
| ~~前端 e2e~~ ✅ | 已完成：用**裸 CDP**(本机 Chrome + Node 内置 WebSocket)驱动真实浏览器，**零依赖**、不引入 Playwright。现有 **19 项** browser 测试（原记 8 项）。无 Chrome 时自动 skip。**首次运行即抓到一个真实 bug**(见 CHANGELOG 2.8.0) |
| ~~`legacy/` 的去留~~ ✅ | 已裁定**保留**：它是逐词时间戳的唯一来源（P1-7 实测证明无法合并进生产 worker），已由 e2e 锁定契约，不是死代码 |

---

## 项目现状快照（2026-08-08 实测）

| 维度 | 数字 | 备注 |
|---|---|---|
| 生产代码 | `src/worker.js` **1708** 行 + `ui/index.html` **2463** 行 | 单文件 Worker + 内嵌 Vue SPA |
| 测试代码 | **9283** 行 / **359** 项（347 跑 + 12 需凭证 skip） | 测试:源码 ≈ **2.2:1** |
| `src/worker.js` 覆盖率 | **99.47% 行 / 97.76% 分支** | 未覆盖仅 2 处，均为**已证不可达**的防御分支（catch-all 处理器；`input_empty_after_cleaning` 已穷举 5768 种组合证明不可达） |
| 运行时依赖 | **0** | `node_modules` 空；构建与测试只用 Node 内置能力 |
| 硬编码密钥扫描 | 干净 | 唯一硬编码 base64 是微软 Edge TTS 客户端的**公开固定签名密钥**（逆向公知），非用户凭据 |
| 累计修复缺陷 | **11 个**（五轮系统审计） | `cleanText` 8 + WebM 1 + UI 无障碍 1 + CI 守卫缺失 1 |

`cleanText` 那 8 个的来源（此前这里记 `cleanText 7`，把 **7 条正则**误当成 7 个缺陷，
恰好掩盖了漏记的第 8 个，于是总数少算 1、与 HANDOFF 的「11 个」长期矛盾）：
2.25.0 的 `custom_keywords` 空分支遮蔽 1 个、2.26.0 的小数被吃与 VS16 emoji 残留 2 个、
2.27.0 的 markdown A/B/C/C2/D 共 5 个（E/F 判定为 markdown 固有歧义，不修、不计）。

**「all files」那个百分比会误导**：它把 `dist/worker.js`（构建产物，仅被少数测试读取，
**66.90%**）也算进去，把均值拉低到 **76.42%**。真正该看的是 `src/worker.js` 的 99.47%
（就是上面那一行，此处刻意不再重复具体数字 —— 同一个数字写在多处正是它会漂移的原因）。

---

## 已知的架构约束（不是 bug）

1. **出站 WebSocket 只能走 `*.workers.dev`** —— 自定义域名下 CF 代理层会破坏到 Bing 的
   WebSocket 握手。这影响 `legacy/worker-ndjson.js`，不影响生产的 `edgetts-proxy`（走 REST）。
2. **CF Workers 不能用 `wss://`** —— 必须 `fetch('https://...', { headers: { Upgrade: 'websocket' } })`。
3. **CPU 时间 vs 挂钟时间** —— 本服务绝大部分时间在等上游 I/O，不计入 CPU 配额。

## 命令速查

```bash
npm test        # 单元 + 集成 + 回归 + browser e2e（359 项，零依赖）
npm run test:e2e # 真网 E2E，需 EDGETTS_E2E=1
npm run coverage # 覆盖率（具体数字见上方「项目现状快照」，不在此重复）
npm run check   # 语法检查 + 单测
npm run build   # ui/ + src/ → dist/worker.js
npm run deploy  # 构建并部署（需 wrangler + API_KEY secret 已绑定）
```
