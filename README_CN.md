# edgetts-ws-worker

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
- ⚡ **真流式** —— 流式下传裸 PCM，首个分块即可开播且不会中途截断（MP3 等容器格式无法
  边收边播，详见[流式说明](#流式)）。
- 🧩 **兼容 OpenAI** —— `POST /v1/audio/speech`，可直接替换 OpenAI TTS。
- 🚀 **并发合成** —— 长文本按句分块，滑动窗口并发合成后**保序**下传（长文本 4×+ 提速）。
- 🌍 **全球边缘** —— 跑在 Cloudflare 300+ 节点，单请求 CPU < 1ms。
- 🖥️ **内置 Web UI** —— Worker 自身托管的 Vue 单页应用。
- 🔓 **开放设计** —— 宽松 CORS、不限流；仅用 API key 作门槛。

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
  "input": "要合成的文本。",       // 必填，≤ 50000 字符
  "voice": "zh-CN-XiaoxiaoNeural", // 或 OpenAI 别名：alloy/echo/fable/onyx/nova/shimmer
  "speed": 1.0,                     // 0.25–4.0
  "pitch": 1.0,                     // 0.5–1.5
  "style": "general",              // 表达风格
  "response_format": "mp3",        // mp3 | opus | wav（pcm 为流式内部使用）
  "stream": false,                  // true → 裸音频流
  "cleaning_options": { }           // 合成前清理 markdown/emoji/url 等
}
```

返回对应 `Content-Type` 的音频字节。出错时返回 JSON `{ "error": { message, code, type } }`，
`code` 精确（如 `invalid_voice`、`invalid_response_format`、`input_too_long`）。

<a name="流式"></a>
#### 流式

设 `stream: true`。无论 `response_format` 是什么，服务端都流式下传**裸 PCM** —— 因为容器
格式（MP3/Opus/WAV）无法增量解码：部分 MP3 会被当成一个「完整的短片段」播完即停。内置
Web UI 用 Web Audio API 在连续时间轴上播放流式 PCM，因此立即开播、绝不截断。非流式请求
则返回正常的 MP3/Opus/WAV 文件。

### `GET /v1/models` · `GET /v1/models/public`

以类 OpenAI-models 结构列出全部音色（322 个）。查询过滤：`?neural=true`、`?multilingual=true`。

### `GET /`

返回内置 Web UI。

## 输出格式

| `response_format` | Content-Type | 流式 | 说明 |
|---|---|---|---|
| `mp3` | audio/mpeg | 非流式 | 默认，兼容性最好 |
| `opus` | audio/webm | 非流式 | 高压缩 |
| `wav` | audio/wav | 非流式 | 无损，体积大 |
| `pcm` | audio/pcm | **流式** | 流式自动使用；不是 UI 选项 |

> 不支持 AAC 与 FLAC —— 上游端点会返回 400 拒绝。

## 配置

| 变量 | 类型 | 用途 |
|---|---|---|
| `API_KEY` | secret | `/v1/audio/speech` 所需的 Bearer 令牌。**未设置时 Worker 返回 503**，而非无鉴权放行。 |
| `ALLOW_ANONYMOUS` | var | 设为 `"true"` 以明确开放访问（无需 key）。 |

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

- `legacy/worker-ndjson.js` —— 最初的 WebSocket + NDJSON 版本，带**逐词时间戳**（`WordBoundary`）。
  因下游项目仍在用而保留；合并时间戳能力到主 worker 的计划见 [ROADMAP](ROADMAP.md)。
- [edgetts-ws](https://github.com/neosun100/edgetts-ws) —— 同思路的 Python 服务端版本。

## 许可

MIT
