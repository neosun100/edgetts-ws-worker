# edgetts-ws-worker

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Edge TTS](https://img.shields.io/badge/Edge_TTS-WebSocket-purple)](https://github.com/rany2/edge-tts)

**[中文文档](README_CN.md)**

一个 Cloudflare Worker，通过 WebSocket 连接微软 Edge TTS，提供带**逐词时间戳**的文字转语音服务。支持流式（NDJSON）和非流式（JSON）两种模式。无服务器架构，全球边缘分发，零运维。

## 工作原理

```
客户端 POST → CF Worker（边缘节点）→ Bing TTS WebSocket → WordBoundary + 音频
                                                                ↓
                                                     JSON 或 NDJSON 流 → 客户端
```

本 Worker 从零实现了完整的 Edge TTS WebSocket 协议（不依赖任何外部库）：
1. **DRM 令牌生成**（`Sec-MS-GEC`）— 使用 Web Crypto API 计算 Windows 文件时间 + TrustedClientToken 的 SHA-256 哈希
2. **Chrome 指纹伪装** — Origin、User-Agent、Cookie（MUID）模拟 Edge 浏览器扩展
3. **SSML 消息封装** — speech.config + ssml 消息通过 WebSocket 发送
4. **二进制音频解析** — 从 WebSocket 二进制帧中提取音频数据（2 字节头部长度前缀）

## ⚠️ 重要限制：自定义域名不可用

> **Cloudflare Workers 的出站 WebSocket 连接只能在默认的 `*.workers.dev` 域名上工作。**
>
> 通过 Workers Routes 或 AAAA `100::` 记录绑定的自定义域名会失败，返回 `"WebSocket upgrade failed"`。这是因为 Cloudflare 的代理层会干扰 Worker 向 Bing 发起的出站 WebSocket 握手。

| 域名类型 | 出站 WebSocket | 状态 |
|---------|---------------|------|
| `*.workers.dev` | ✅ 正常 | **请使用这个** |
| 自定义域名（Workers Route） | ❌ 失败 | 不要使用 |
| 自定义域名（AAAA `100::`） | ❌ 失败 | 不要使用 |

**原因分析**：当请求通过自定义域名进入时，会经过 Cloudflare 的代理层（处理 DNS、SSL、WAF、缓存等），然后才路由到 Worker。这个代理层会干扰 Worker 内部发起的出站 WebSocket 升级请求。而 `workers.dev` 域名直接执行 Worker 代码，不经过这层代理。

**解决方案**：前端直接使用 `*.workers.dev` URL。如果必须使用自定义域名，请使用 [edgetts-ws](https://github.com/neosun100/edgetts-ws)（Python 服务器版本）。

## 功能特性

- 🎯 **逐词时间戳** — 精确的偏移量 + 持续时间（毫秒）
- ⚡ **流式模式** — NDJSON 实时推送，适用于低延迟场景
- 📦 **非流式模式** — 单次 JSON 响应
- 🌍 **全球边缘** — 运行在 Cloudflare 300+ 个边缘节点
- 🔐 **DRM 令牌** — 使用 Web Crypto API 自动生成 `Sec-MS-GEC` 令牌
- 🆓 **免费额度** — Workers 免费计划每天 100K 请求
- 🌐 **CORS 支持** — 可直接从浏览器前端调用

## 快速开始

```bash
npx wrangler deploy worker.js --name edgetts-ws-worker --compatibility-date 2024-12-13
```

部署后可通过 `https://edgetts-ws-worker.<你的子域名>.workers.dev` 访问。

## API 接口

### `POST /v1/audio/speech`

与 [edgetts-ws](https://github.com/neosun100/edgetts-ws)（Python 版本）**100% API 兼容**，可互相替换。

**请求体：**

```json
{
  "input": "The celebrated theory is still the source of great controversy.",
  "voice": "en-US-AvaNeural",
  "speed": 0.8,
  "stream": true
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `input` | string | *（必填）* | 要合成的文本 |
| `voice` | string | `en-US-AvaNeural` | Edge TTS 语音名称 |
| `speed` | number | `1.0` | 播放速度（0.5–2.0） |
| `stream` | boolean | `false` | 是否启用 NDJSON 流式输出 |

### 非流式响应（`stream: false`）

```json
{
  "audio": "<base64 编码的 MP3>",
  "content_type": "audio/mpeg",
  "timestamps": [
    { "text": "The", "offset": 100, "duration": 218.75 },
    { "text": "celebrated", "offset": 334.375, "duration": 750 }
  ]
}
```

### 流式响应（`stream: true`）

```jsonl
{"type":"word","text":"The","offset":100,"duration":218.75}
{"type":"word","text":"celebrated","offset":334.375,"duration":750}
{"type":"audio","data":"<base64 MP3 块>"}
{"type":"done"}
```

两种模式返回的时间戳数据完全一致，唯一区别是传输方式。

## DRM 令牌生成算法

```
1. 获取当前 Unix 时间戳（秒）
2. 加上 11644473600（转换为 Windows 文件时间纪元）
3. 向下取整到最近的 300 秒（5 分钟）
4. 乘以 10^7（转换为 100 纳秒间隔）
5. 与 TrustedClientToken 字符串拼接
6. SHA-256 哈希 → 大写十六进制字符串
```

## WebSocket 连接细节

```
URL: https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
     ?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4
     &ConnectionId={uuid}
     &Sec-MS-GEC={drm_token}
     &Sec-MS-GEC-Version=1-143.0.3650.75

请求头:
  Upgrade: websocket
  Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold
  User-Agent: Mozilla/5.0 ... Chrome/143.0.0.0 ... Edg/143.0.0.0
  Cookie: muid={随机十六进制};

发送的消息:
  1. speech.config（JSON）— 输出格式 + 元数据选项
  2. ssml（XML）— 语音、语速、文本的 SSML 封装

接收的消息:
  - 文本帧: audio.metadata（WordBoundary JSON）或 turn.end
  - 二进制帧: 音频数据（2 字节头部长度 + 头部 + MP3 数据）
```

> **重要**：CF Workers 必须使用 `fetch()` + `https://` URL + `Upgrade: websocket` 头，**不能**使用 `wss://` URL。`wss://` 会导致 `"Fetch API cannot load"` 错误。

## 与 edgetts-ws（Python 版）对比

| 特性 | edgetts-ws-worker（CF） | edgetts-ws（Python） |
|------|----------------------|---------------------|
| 运行环境 | Cloudflare Workers | Python + aiohttp |
| WebSocket 实现 | 从零实现（fetch + Upgrade） | `edge_tts` 库 |
| 托管方式 | 无服务器（免费额度） | 需要 VPS |
| 延迟 | 全球边缘（~50ms） | 单一地点 |
| 自定义域名 | ❌ 仅 workers.dev | ✅ 任意域名 |
| 流式输出 | ✅ NDJSON | ✅ NDJSON |
| 时间戳 | ✅ WordBoundary | ✅ WordBoundary |
| CPU 时间限制 | 免费 10ms / 付费 5min | 无限制 |
| Wall Clock 时间 | 无限制 | 无限制 |

> **关于 Workers 时间限制**：CF Workers 区分 CPU 时间（实际计算耗时）和 Wall Clock 时间（包含 I/O 等待的总耗时）。我们的 Worker 大部分时间在等待 Bing WebSocket 返回数据（I/O 等待），这**不计入** CPU 时间限制。实际 CPU 消耗（DRM 哈希计算、JSON 序列化等）远低于 10ms。因此即使在免费计划上，TTS 合成也没有实际的时间限制。
>
> **实测 CPU 耗时**（10 词句子，42 个音频块）：
>
> | 操作 | 单次耗时 | 次数 | 小计 |
> |------|---------|------|------|
> | DRM 令牌（SHA-256） | 0.001 ms | 1 | 0.001 ms |
> | 词时间戳解析 | 0.001 ms | 10 | 0.01 ms |
> | 音频块 base64 编码 | 0.009 ms | 42 | 0.39 ms |
> | **总计** | | | **~0.4 ms** |
>
> 仅为 10ms 免费限制的 1/25。即使是 500 词的长文章（约 2000 个音频块），CPU 时间也只有约 18ms。此外 Cloudflare 有"滚动额度"机制（rollover）——如果大部分请求都在限制以内，偶尔超出也不会报错。

**建议**：CF Worker 作为主要服务（低延迟、零运维），Python 服务作为备用（支持自定义域名、无 Workers 限制）。

## 开发经验总结

1. **`wss://` 在 CF Workers 中不可用** — 必须使用 `fetch('https://...', { headers: { Upgrade: 'websocket' } })`
2. **自定义域名会破坏出站 WebSocket** — 这是 Cloudflare 基础设施层面的限制，不是代码 bug。测试了 Workers Routes 和 AAAA `100::` 两种方式，均失败。
3. **DRM 令牌是必需的** — 没有 `Sec-MS-GEC`，Bing 返回 403。早期没有实现 DRM 的尝试全部失败。
4. **二进制帧解析** — WebSocket 二进制消息有 2 字节大端序头部长度前缀，然后是 ASCII 头部，最后是原始 MP3 音频数据。
5. **`TransformStream`** 是在 Worker 中实现流式响应的正确方式，可以在异步处理 WebSocket 事件的同时逐步输出数据。

## 关联项目

| 项目 | 说明 |
|------|------|
| [edgetts-ws](https://github.com/neosun100/edgetts-ws) | 相同 API 的 Python 服务器版本（VPS 部署） |
| [pte-wfd-216](https://github.com/neosun100/pte-wfd-216) | 使用 4 级降级 + 逐词高亮的完整示例应用 |

## 许可证

MIT
