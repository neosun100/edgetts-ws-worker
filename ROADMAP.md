# ROADMAP / TODO

审计日期：2026-08-03 · 审计对象：生产 Worker `edgetts-proxy`（服务 https://edgetts.aws.xin）

## 背景：审计前的状态

审计发现线上服务的代码**没有任何本地副本或版本管理**。它是一个 1728 行的单文件 Worker（含内嵌 Vue 前端），
只存在于 Cloudflare 上。本仓库原有的 `worker.js`（166 行，NDJSON 协议）与线上是**完全不同的两份代码**。

已完成的归位：

| 项目 | 归位后位置 | 说明 |
|---|---|---|
| 线上 Worker 逻辑 | `src/worker.js` | 生产代码，反压缩为可读源码 |
| 线上内嵌前端 | `ui/index.html` | 构建时注入回 Worker |
| 构建脚本 | `scripts/build.mjs` | `ui/` + `src/` → `dist/worker.js` |
| 单元测试 | `test/worker.test.mjs` | `npm test`，零外部依赖 |
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

## P1 — 建议下一步（尚未做）

### 1. 速率限制与滥用防护 · 🟡 已知风险，主动暂缓（2026-08-03）
**状态**：已评估，Neo 决定暂不做，先记录。
**暴露面**：目前无任何限流。key 一旦泄漏，持有者即可跑满账号配额（Workers 请求数 /
上游 TTS 调用），无熔断、无按 key 计量。当前唯一防线是「已绑定 API_KEY」这一层鉴权。
**触发重评的信号**：观察到异常流量 / 账单异常 / key 有外泄迹象时，应立即启用。
**建议方案**（届时）：
- Cloudflare Rate Limiting 规则，或 Workers KV / Durable Object 计数
- 按 key + IP 双维度，超限返回 429 + `Retry-After`

### 2. CORS 收紧 · 🟡 已知风险，主动暂缓（2026-08-03）
**状态**：已评估，Neo 决定暂不做，先记录。
**暴露面**：当前 `Access-Control-Allow-Origin: *` 且允许 `Authorization` 头。配合浏览器端
localStorage 明文存 key（见 P1-3），任意第三方站点都能引导已在本站存过 key 的用户浏览器，
带着该 key 向本 API 发跨源请求 —— 等价于 key 在「用户访问过恶意站点」时可被滥用。
**触发重评的信号**：UI 面向不受信任的公网用户开放，或发生 key 被跨站滥用的迹象。
**建议方案**（届时）：改为可配置的来源白名单（`Access-Control-Allow-Origin` 按 `Origin` 回显匹配项）。

### 3. 前端 API key 存储
key 明文存 `localStorage`，任何 XSS 或同源脚本可读。当前无 `v-html`，XSS 面较小，但建议：
- 要么改为后端会话（同源 cookie + 服务端持有 key）
- 要么明确文档化「此 UI 仅供受信任环境使用」

### 4. 请求体大小上限
已限制 `input` 为 50000 字符，但未限制整体请求体。建议在入口处检查 `Content-Length`。

### 5. 长音频的真流式（去掉分块拼接痕迹）
当前按标点分块后拼接 MP3/PCM。PCM 拼接无痕；但 MP3/AAC 分块拼接在块边界可能有极短的
不连续。若追求极致，可考虑对容器格式做帧级拼接或统一走 PCM 再转码。

### 6. 可观测性
已在 `wrangler.toml` 开启 observability。建议进一步：
- 结构化日志（JSON），字段含 voice/format/chunks/耗时/是否重试
- 关键指标告警：5xx 率、上游 401 率、p99 延迟

### 7. 恢复 WordBoundary 时间戳能力
`legacy/worker-ndjson.js` 有逐词时间戳（`pte-wfd-216` 的逐词高亮依赖它），但走的是
WebSocket + NDJSON 协议；生产 `edgetts-proxy` 走 REST 裸流，没有时间戳。
建议：在 `edgetts-proxy` 上增加一个 `/v1/audio/speech/timestamps` 端点，
或让 `response_format` 支持 `ndjson` 以合并两套实现。

### 8. CI
建议加 GitHub Actions：`npm run check`（syntax + 单测）+ 构建产物校验，PR 必过。
仓库已有 `gh` CLI 可用。

---

## P2 — 可选打磨

| 项 | 说明 |
|---|---|
| TypeScript 化 | 现为 JS。加 `// @ts-check` + JSDoc 是低成本折中，无需改造构建 |
| 前端拆分 | `ui/index.html` 仍是 1200+ 行单文件（含 322 语音的语言映射表）。可抽出数据表 |
| 语音列表缓存 | `/v1/models` 每次都打上游。可用 Cache API 缓存数小时 |
| `cleanText` 的容错来源注释 | 多处正则清理未说明脏数据来源，半年后无人知道是否还需要 |
| 前端 e2e | 当前只有服务端单测。可用 Playwright 验证「流式播放不中断」这一核心回归 |
| `legacy/` 的去留 | 按「lint 豁免目录 = 永不清理的目录」原则，应明确：要么迁移合并（见 P1-7），要么删除 |

---

## 已知的架构约束（不是 bug）

1. **出站 WebSocket 只能走 `*.workers.dev`** —— 自定义域名下 CF 代理层会破坏到 Bing 的
   WebSocket 握手。这影响 `legacy/worker-ndjson.js`，不影响生产的 `edgetts-proxy`（走 REST）。
2. **CF Workers 不能用 `wss://`** —— 必须 `fetch('https://...', { headers: { Upgrade: 'websocket' } })`。
3. **CPU 时间 vs 挂钟时间** —— 本服务绝大部分时间在等上游 I/O，不计入 CPU 配额。

## 命令速查

```bash
npm test        # 单元测试（15 项，零依赖）
npm run check   # 语法检查 + 单测
npm run build   # ui/ + src/ → dist/worker.js
npm run deploy  # 构建并部署（需 wrangler + API_KEY secret 已绑定）
```
