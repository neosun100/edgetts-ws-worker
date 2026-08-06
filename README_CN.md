<p align="center">
  <img src="docs/logo.svg" width="128" height="128" alt="edgetts-ws-worker logo"/>
</p>

<h1 align="center">edgetts-ws-worker</h1>

[![CI](https://github.com/neosun100/edgetts-ws-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/neosun100/edgetts-ws-worker/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI_compatible-412991?logo=openai&logoColor=white)](#api)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[English](README.md)** · **[路线图](ROADMAP.md)** · **[更新日志](CHANGELOG.md)**

一个 Cloudflare Worker，把微软 Edge / Azure TTS 封装成一套**兼容 OpenAI** 的语音合成
API —— 支持真流式播放、322 个音色、内置 Web UI，零运维。无服务器、全球边缘、免费额度友好。

> **在线服务：** [edgetts.aws.xin](https://edgetts.aws.xin) —— 直接用网页，或 `POST /v1/audio/speech`。

![架构图](docs/architecture.svg)

## 特性

- 🎙️ **322 个音色，40+ 语言** —— 微软全部神经网络音色，含多语言音色。
- ⚡ **真流式** —— 用 `response_format: "pcm"` 时首个分块即可开播并完整播到结束
  （MP3 等容器格式无法边收边播，详见[流式说明](#流式)）。
- 🧩 **兼容 OpenAI** —— `POST /v1/audio/speech`，可直接替换 OpenAI TTS。
- 🚀 **并发合成** —— 长文本按句分块，交给工作池并发合成后**保序**返回。线上实测：600 字符
  切成 12 块，串行 3683ms、并发 10 时 918ms —— **4.0 倍**提速，且各并发档位输出逐字节相同。
  流式与非流式两条路径都是槽位一空立刻补下一块，单块慢不会拖住其他槽位（见[并发](#并发)）。
- 🌍 **全球边缘** —— 跑在 Cloudflare 300+ 节点。实测单请求 CPU：典型 280 字符输入 0.007ms；
  50000 字符上限时中位数 1.96ms（p95 3.55ms），对应平台 10ms 预算。绝大部分耗时在分块。
- 🖥️ **内置 Web UI** —— Worker 自身托管的 Vue 单页应用。
- 🔓 **开放设计** —— 宽松 CORS、不限流；仅用 API key 作门槛。

## Web 界面

浏览器打开 `/`。322 个音色可按语言、地区、性别、「仅多语言」逐层筛选，也可直接搜名字 /
ShortName。每个音色都展示完整 `ShortName` 并带一键复制，方便直接粘进 API 调用。
选择器是标准的 **radio group**：方向键 / Home / End 移动并选中、Enter 与空格确认、焦点环
可见 —— 322 个音色全部可键盘到达，读屏也会正确播报当前选择。播放时绘制
三层声纹 —— **Siri 风格环形律动** + 每个音节起音的**粒子迸发** + **滚动脉冲波形**
（每个音节沿时间轴前进）。右上角可切换**亮色 / 暗夜**主题（记忆到本地）。

配色**由音频本身决定**，不是随机变色：色相跟随谱质心（低频元音→琥珀，高频擦音→青），
饱和度跟随谱峰均比（浊音浓郁、噪声发灰），亮度跟随音量，并按音色基频给整段一个稳定的
色相偏移 —— 低音音色永远比高音音色更暖。所有阈值都用真实 TTS 音频的实测分布标定。

![声纹 — 暗夜主题](docs/screenshots/viz-dark.png)
![声纹 — 亮色主题](docs/screenshots/viz-light.png)

![Web 界面 — 亮色主题与实时声纹](docs/screenshots/ui-voice-picker.png)

<p align="center"><em>暗夜主题</em></p>

![Web 界面 — 暗夜主题](docs/screenshots/ui-dark.png)

## 快速开始

### 使用托管实例

```bash
curl -X POST https://edgetts.aws.xin/v1/audio/speech \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"input":"你好，来自边缘节点！","voice":"zh-CN-XiaoxiaoNeural"}' \
  --output speech.mp3
```

### 自行部署

```bash
git clone https://github.com/neosun100/edgetts-ws-worker
cd edgetts-ws-worker
npm run build                    # 打包 ui/ + src/ → dist/worker.js
npx wrangler secret put API_KEY  # 设置密钥（或设 ALLOW_ANONYMOUS=true 开放访问）
npx wrangler deploy
```

无需安装依赖 —— 构建与测试只用 Node 内置能力。

## API

### `POST /v1/audio/speech`

```jsonc
{
  "input": "要合成的文本。",       // 必填，长度上限见下文
  "voice": "zh-CN-XiaoxiaoNeural", // 或 OpenAI 别名：alloy/echo/fable/onyx/nova/shimmer
  "speed": 1.0,                     // 0.25–4.0
  "pitch": 1.0,                     // 0.5–1.5
  "style": "general",              // 表达风格
  "response_format": "mp3",        // mp3 | opus | wav（pcm 为流式内部使用）
  "stream": false,                  // true → 裸音频流
  "cleaning_options": { }           // 合成前清理 markdown/emoji/url 等
}
```

返回对应 `Content-Type` 的音频字节。出错时返回 JSON `{ "error": { message, code, type, param } }`，
`code` 精确（如 `invalid_voice`、`invalid_response_format`、`input_too_long`）。

`param` 指出出错的请求字段（`voice`、`speed`、`cleaning_options.custom_keywords`，body 本身
解析不了时是 `body`），没有单一字段可归因时为 `null`。它有必要是因为有两个 code 各服务两种
原因：`invalid_request_error` 既是「body 不是 JSON」也是「input 缺失」，
`invalid_cleaning_options` 既是容器类型错也是嵌套字段类型错 —— code 为了兼容既有调用方保持
不变，靠 `param` 区分。

<a name="流式"></a>
#### 流式

设 `stream: true`，服务端会按分块到达的顺序流式下传，格式就是你请求的那个。

**流式请务必用 `response_format: "pcm"`。** 容器格式（MP3/Opus/WAV）无法增量解码：部分
MP3 会被当成一个「完整的短片段」播完即停 —— 这正是本项目最初要解决的 1.67 秒截断。服务端
**不会**替你改写格式，你请求什么就下传什么。内置 Web UI 会在发送流式请求前自动把格式改成
`pcm`，并用 Web Audio API 在连续时间轴上播放，因此立即开播、不会截断；直接调 API 的调用方
需要自己做这个选择。

流式请求若会切成多块，`wav` 与 `opus` 会被拒绝并返回 400 `stream_format_not_chunkable`。
它们是带头部的容器格式：第二块到达时响应头早已发出，既无法把多个容器合成一个、也无法回填
长度。放任不管的结果是 200 响应里首个头声明 61.46s、而实际含 191.67s —— 播放器在 32% 处停止。
流式请用 `pcm`，或去掉 `stream` 拿一个已合并的文件。

非流式请求则返回正常的 MP3/Opus/WAV 文件。

#### 上游返回空音频会被拒绝，不会透传

当音色对输入文本的**书写系统完全没有覆盖**时，上游返回的是 `200` + **0 字节**，并不报错。
线上实测：中文 / 日文 / 纯标点送给 `en-US-AvaNeural`，5 次全是
`200 audio/mpeg, content-length: 0`；而同一音色送英文正常（12240 字节）、同一段中文送
`en-US-AvaMultilingualNeural` 也正常（10656 字节）。（`zh-CN` 音色读英文没问题 ——
所以这不是「语种不匹配」，而是「零覆盖」。）

原样透传就是又一次静默成功：调用方拿到一个格式合法的空音频，与真结果无法区分。因此非流式
请求会返回 502 `upstream_empty_audio`，并指出可能原因与出路。**流式无法拒绝**（响应头早已
发出），改为在日志里记 `phase: "stream_empty"` + `bytes: 0`。

### `GET /v1/models` · `GET /v1/models/public`

以类 OpenAI-models 结构列出全部音色（322 个）。两个端点接受相同的查询过滤：

- `?multilingual=true` —— 只返回多语言音色（322 个里的 12 个）。
- `?neural=true` —— 为兼容既有调用方而保留，但是个 **no-op**：上游所有音色本身都是
  Neural 音色，过滤不掉任何东西。

列表在进程内缓存 6 小时，并带 `Cache-Control: public, max-age=21600`，重复调用不再穿透上游。
上游故障时返回最后一次成功的列表（并打 warn 日志），而不是直接失败。

### `GET /`

返回内置 Web UI。

## 输出格式

| `response_format` | Content-Type | 流式 | 说明 |
|---|---|---|---|
| `mp3` | audio/mpeg | 非流式 | 默认，兼容性最好 |
| `opus` | audio/webm | 非流式 | 高压缩；分块会被合并（见下） |
| `wav` | audio/wav | 非流式 | 无损，体积大 |
| `pcm` | audio/pcm | **流式** | 流式自动使用；不是 UI 选项 |

> 不支持 AAC 与 FLAC —— 上游端点会返回 400 拒绝。

**多分块 opus 会被合并成单个 WebM 段。** 上游对每个分块返回一个完整独立的容器，而
`<audio>` 只认第一个 —— 用真实分块实测：文件含 94.56s 音频，元素只报 9.44s，静默丢掉
最多 90%。现在 Worker 会把各容器的 Cluster 时间戳改写成一条连续时间轴（45 块约 1.2ms；
上游的封装恰好省掉了所有需要回填长度的元素，因此没有任何 size 字段要动）。若某块不是可解析
的 WebM，则放弃合并、原样透传字节，并把原因记进日志。

合并结果还会带上顶层 `Duration`，因此 `<audio>.duration` 与 `seekable` 在
`loadedmetadata` 时就可用 —— 进度条一开始就正常，拖动也准确，不必先拖到末尾。线上实测：
4 分块请求的 `duration = 191.7`，直接拖到 150s 落在 150.00。

<a name="并发"></a>
### 并发

`concurrency`（1–20，默认 10）是同时合成的分块数。两条路径都用**工作池**：槽位一空就立刻
领取下一个未合成的分块，单块慢不会让其他槽位空转。结果按分块下标归位，因此无论上游以什么
顺序应答，各并发档位的输出都逐字节相同。

非流式路径原先是分批 —— `Promise.all` 跑 `concurrency` 块，做完再开下一批 —— 每个批边界
都是一道栅栏，于是每批的耗时是**该批最慢一块**而不是平均值。上游延迟有长尾，槽位就此空转。
用真 worker 打 mock 上游实测（每 10 块里有一块 500ms、其余 100ms）：

| 分块数 @ 并发 10 | 分批 | 工作池 | 工作量下界 |
|---|---|---|---|
| 12 | 645ms | 530ms | 160ms |
| 24 | 1505ms | 708ms | 360ms |
| 40 | 2012ms | 812ms | 560ms |

某块因不可重试的原因失败时，工作池会**停下**而不是把剩余分块抽干：响应已经注定失败，再打
上游只是白烧 Cloudflare 单次调用仅 50 次的 subrequest 配额。

### 故障归因

`4xx` 表示请求需要改，`5xx` 表示本服务或其上游出了问题。这个区分是刻意维护的 —— 归因错了
会把调用方送去排查完全无关的东西。两个值得点名的情形：

- 上游拒绝了一个形状合法的请求（最常见是 `voice` 通得过命名规则但上游没这个音色），
  返回 400 `upstream_rejected_request` 而不是 500 —— 该改的是调用方那边。
- **token 获取失败返回 500 `tts_generation_error`**，尽管上游应答的是 401。微软 token 是
  本服务自己的依赖，调用方的请求没问题。这里原先会表现成 400 +「voice 不存在」：一个已死的
  缓存 token 被反复重试到次数耗尽，最后那个 401 被当成调用方错误。现在缓存 token 只在
  **仍然有效**时才用于兜底。

## 配置

| 变量 | 类型 | 用途 |
|---|---|---|
| `API_KEY` | secret | `/v1/audio/speech` 所需的 Bearer 令牌。**未设置时 Worker 返回 503**，而非无鉴权放行。 |
| `ALLOW_ANONYMOUS` | var | 设为 `"true"` 以明确开放访问（无需 key）。 |

### 可观测性

**每个请求输出恰好一行 JSON，成功的请求也有。** `wrangler.toml` 已开 `[observability]`，
这些行可在 Workers 面板查询，也可用 Logpush 推出。

```jsonc
{"ev":"req","route":"/v1/audio/speech","status":200,"ms":412,"upstream":4,"retries":0,
 "voice":"zh-CN-XiaoxiaoNeural","format":"mp3","chunks":4,"conc":10,"stream":false,"chars":901}
```

| 字段 | 含义 |
|---|---|
| `ev` | 恒为 `"req"` —— 用于把遥测行与普通日志行区分开 |
| `route` | `/v1/audio/speech` 或 `/v1/models` |
| `status` | HTTP 状态。console 级别与之对应：5xx → `error`、4xx → `warn`、其余 `log`，于是「5xx 率」不必解析 JSON 就能先粗筛 |
| `ms` | 挂钟耗时。**流式记的是到流结束**，不是响应头发出的时刻 |
| `upstream` | 实际发出的上游调用数 —— 每次都消耗 Cloudflare 单次调用 50 个 subrequest 之一，所以重试的那次也算 |
| `retries` | 重试次数。有了它，「重试率」才终于有分母 |
| `bytes` | 响应音频字节数。`0` 就是上游静默失败的样子 —— 见下方 `upstream_empty_audio` |
| `code` | 仅 4xx/5xx 才有：与响应体里同一个机器可读错误码 |
| `voice` `format` `chunks` `conc` `stream` `chars` | 请求维度。**校验失败时是省略、不是填 null** —— 一个被拒的请求没有有意义的 voice，填 null 只会污染聚合 |
| `degraded` | 仅在发生静默降级时出现（如 `wav_merge_declined_no_riff`） |
| `phase` | 仅流式：`stream_end`、`stream_empty` 或 `stream_broken`。响应头一发出状态就锁在 200 了，所以这是中途断流**唯一**看得见的地方 |

**绝不记录**：API key，以及 input 文本 —— 连哈希、连截断都不记，因为那是调用方的内容。
`chars` 只带长度，让输入规模仍可聚合。

成本：序列化一行实测约 0.0001ms，约占最坏请求 ~3ms CPU 的 **0.004%** —— 比测量噪声还低三个
数量级，且**有测试盯住**，免得以后往里加字段悄悄吃进 10ms 预算。只有错误响应会被 clone
以取回 code，几 MB 的音频体永远不 clone。

### 内置 Web UI 仅供受信任环境使用

`/` 处的 UI 会把你填入的 API key **明文存在 `localStorage`**，同源的任何脚本都能读到。
这是一个**有意的取舍**，不是疏漏；写在这里，是为了让这个判断由你来做，而不是变成意外：

- **在你自己掌控的机器与浏览器上用它。** 它是给你自己的 key 配的便利前端，性质与你 shell
  history 里的那条 `curl` 相同。
- **不要把 UI 的地址交给不受信任的人当作「共享访问」的方式** —— 那等于让他们把你的 key
  敲进他们自己浏览器的存储里。请给每个使用方单独发 key，让他们直接调
  `POST /v1/audio/speech`。
- **不要把这个页面嵌进有第三方脚本运行的环境**（广告位、tag manager、未经审计的浏览器扩展）。

已经堵掉的部分，以便准确界定剩余风险：

- 页面唯一加载的第三方脚本（Vue）已**固定到确切版本并带 SRI 哈希**，CDN 被污染也无法替换成
  偷 key 的版本。线上已验证：SRI 生效，322 个音色正常渲染。
- UI 自身的注入面为零 —— `v-html`、`innerHTML =`、`eval` 实测各 0 处。
- 从 `localStorage` 读回的值**逐字段做类型检查**，不是往默认值上浅展开，所以被篡改的条目会
  退回默认，而不是让页面崩掉。

另一条路 —— 后端会话（同源 cookie + 服务端持有 key）—— **评估过但未采用**：它与本项目的立足点
冲突。任何人一条 `wrangler deploy` 就能部署自己的副本，而引入会话存储会给这条路径增加依赖。
把 key 交给浏览器是这份简洁的代价，这个边界选择被写明，而不是被藏起来。

### 长度上限

请求体上限 256KB（413 `payload_too_large`），`input` 上限 50000 字符（400 `input_too_long`）。

**真正的约束是分块数，不是字符数。** 文本按 `chunk_size` 切块，每块消耗一次上游
subrequest，而 Cloudflare 单次调用只允许 50 次。因此超过 45 块会被拒绝并返回 413
`too_many_chunks` —— 默认 `chunk_size=300` 时约合 13500 字符。

要合成更长的文本，把 `chunk_size` 调大，或拆成多次请求。块越粗则上游调用越少越长：
首字节略慢，但余量大得多。

**两个上限是串联的，实际能力取先撞到的那个。** `chunk_size=2000` 时分块预算允许
45 × 2000 = 90000 字符，但 `MAX_INPUT_CHARS` 的校验在分块之前，所以 50000 才是硬上限 ——
线上实证：50000 字符 @ `chunk_size=2000` 返回音频，50001 返回 400 `input_too_long`。
调大 `chunk_size` 能把余量顶到 50000，但不会超过它。

这个校验刻意放在写出任何响应字节**之前**：流式请求一旦超出平台预算，旧行为是
HTTP 200 + 格式完好的 EOF，调用方无法区分被截断的音频和完整音频。

## 开发

```bash
npm test              # 单元 + 集成 + 回归（Node 内置 runner，零依赖）
npm run coverage      # 带行覆盖率
npm run build         # ui/ + src/ → dist/worker.js
npm run dev           # wrangler dev
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。测试分层于 `test/`（unit/integration/regression/e2e）；
handler 测试对着 mock 上游跑，因此离线且确定。E2E 测试打真实服务，除非设 `EDGETTS_E2E=1` 否则跳过。

## 工作原理

1. **鉴权 + 校验** —— 常数时间校验 API key，再逐项校验参数，任一不符返回精确错误码。
2. **清理 + 分块** —— 可选文本清理，按句分块使单次请求不超上游上限。
3. **令牌** —— 获取并缓存微软 speech 令牌（JWT），到期前刷新；并发刷新合并为一次。
4. **合成** —— 每块生成 SSML 请求（voice/style/prosody 安全转义）；滑动窗口并发、保序下传，
   上游瞬时失败自动重试。

## 配套与遗留

- `legacy/worker-ndjson.js` —— 最初的 WebSocket + NDJSON 版本，也是**逐词时间戳**
  （`WordBoundary`）的**唯一来源**。这个能力无法合并进主 worker：词边界只存在于 WebSocket
  协议，而出站 WebSocket 只能跑在 `*.workers.dev`（自定义域名下 CF 代理层会破坏握手）。
  实测用多种 header 组合请求 REST 端点，返回的都是纯音频、零时间戳字段。所以需要时间戳
  （如逐词高亮）时请调 legacy 部署：

  ```bash
  curl -X POST https://edgetts-ws-worker.neosun808.workers.dev/ \
    -H 'Content-Type: application/json' \
    -d '{"input":"你好世界","voice":"zh-CN-XiaoxiaoNeural"}'
  # -> { audio: "<base64 mp3>", timestamps: [{ text, offset, duration }, ...] }
  ```

  其契约由 `test/e2e/legacy-timestamps.test.mjs` 锁定。完整分析见 [ROADMAP](ROADMAP.md)。
- [edgetts-ws](https://github.com/neosun100/edgetts-ws) —— 同思路的 Python 服务端版本。

## 许可

MIT
