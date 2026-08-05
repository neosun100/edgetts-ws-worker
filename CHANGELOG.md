# Changelog

## [2.12.0] - 2026-08-05

第二轮对抗式审计(44 agent)。本轮最重要的一条是**推翻我自己上一轮的结论** —— 审计 agent
用更硬的证据证明 opus 可以合并，而我之前判它「不可行」并据此拒绝请求，等于把一个 1.2ms
就能修好的容器问题固化成了产品限制。

### Fixed — 我上一轮判断错了
- **多分块 opus 现在真的合并了，不再拒绝**。三条结论逐一被实测推翻：
  ① 「音频没丢，只是时间轴乱」—— 我用 `decodeAudioData` 测的，它会读完所有拼接的容器所以
  永远显示完整；而 UI 用的 `<audio>` **只认第一个容器**：实测文件含 94.56s，元素只报 9.44s；
  三容器时 65.14s vs 162.91s。这是**最高 90% 的静默音频丢失**，与 WAV 同级，不是进度条小问题。
  ② 「duration 恒为 null 是上游封装的固有特性」—— 也是探针缺陷：UNKNOWN-size 的 Segment 要
  `currentTime = 1e9` seek 过末尾，Chrome 才会解析出真实时长。少这一步，任何这类文件都像没有时长。
  ③ 「合并要重写 EBML，远超 10ms CPU 预算」—— **我从未测过**。真 workerd 里 45 块 2.7MB 只需
  **1.2ms**（预算的 12%），与 `concatWavBlobs` 同量级：上游的封装恰好省掉了所有需要回填长度的
  元素（Segment/Cluster 都是 UNKNOWN-size，无 SeekHead/Cues/Duration），因此只需改写 Cluster
  Timecode，没有任何 size 字段要动。
  一并删除：那个 400、它的三条测试、以及 UI 里 `chunk_size=2000` 的遮掩补丁（后者还顺带
  抵消了本项目宣传的滑动窗口并发）。

### Fixed — 静默截断的第二个入口
- **流式的多分块 wav/opus 之前完全绕过合并**。上一轮只改了 `getVoice`，而 `streamVoice` 是
  边收边写。线上实测 901 字符（4 块）的流式 wav：文件含 191.67s，首个 RIFF 头只声明 61.46s
  —— 播放器在 **32%** 处停止，响应却是 200 + 合法 WAV。流式无法照搬非流式的修法（头已发出，
  无从回填），因此在发头之前返回 400 `stream_format_not_chunkable` 并指向 pcm。
  mp3/pcm 不受影响：前者帧自同步、后者无头部。

### Fixed — 流式播放的控制权
- **流式此前根本无法停止**。`playStreamPCM` 把整段音频一次排到 AudioContext 时间轴上就
  resolve，于是 `isLoading` 立刻变 false 而 34 个 source 仍在排队；组件上唯一带 stop 字样的
  方法是 `stopViz`（只管画布）。更糟的是 `<audio controls>` 的原生暂停键**看得见但对流式无效**
  —— 它驱动的是另一条路径，等于给用户一个假的控制权。新增 `stopAllPlayback()` 作为唯一收尾
  入口（停 source、cancel 流 reader、暂停 `<audio>`、停声纹），并加了绑定到新状态 `isPlaying`
  的停止按钮（`isPlaying` 跟踪**实际播放**，而 `isLoading` 只表示请求中）。
- **播放中再次生成会两路同时出声**：实测 31 个流式 source 仍在响、`<audio>` 同时播标准结果。
  `generateSpeech` 现在先调 `stopAllPlayback()`。

### 一个我自己引入又自己抓到的回归
把 `stopAllPlayback()` 放在了 `startViz()` **之后**，而它会无参调用 `stopViz()`（强制停止，
不受代际保护），于是刚领到的这一代声纹立刻被掐掉 —— 表现为音频正常播（4 个 source 在跑）
而 `vizActive` 一直是 false。清理必须发生在**建立新状态之前**。这与之前修过的「stale onended
关掉新一代声纹」是同一类。抓到它靠的是既有那条「声纹必须响应真实音频」的 e2e —— 弱一点的
断言会漏掉。

### 测试
- 新增 WebM 合并 10 例（含真实上游分块 fixture 180KB —— 合成的 WAV 无法覆盖这条路径，因为
  故障只在真正的 EBML 容器上出现）、流式容器 5 例、停止控制 2 例。
- 265 项（256 通过 / 9 跳过）+ 13 项浏览器 e2e，全部通过。
  `src/worker.js` 覆盖率 **99.40% 行 / 98.49% 分支**（新高）。

## [2.11.0] - 2026-08-05

继续深挖。本轮的主题是**同类问题不等于同样后果** —— opus 与上一轮的 WAV 走同一段拼接代码，
但失败方式完全不同，测出差异后修法也随之改变。

### Fixed
- **多分块 opus 的时间轴是坏的**（不是丢音频）。同样文本实测：单容器时间戳单调、最大 pts
  43.37s；5 容器时回退 4 次、最大 pts 只有 10.85s。但 Chrome 的 `decodeAudioData` 仍解出
  完整 43.63s（WAV 是 43.40s）—— 因为 WebM 的 Cluster 是自描述的流式结构，解码器会一路读
  下去。所以审计报的「只播第一段」是**错的**，真实后果是进度条与拖动失准。
  在 Worker 里正确合并要重写 EBML（合并 Segment、逐个重定基 2179 个包的 Cluster 时间戳、
  注入顶层 Duration），远超 10ms CPU 预算。改为在**流式/非流式分支之前**返回 400
  `opus_requires_single_chunk`，此时错误还报得出去。
- **该护栏本会打断所有用 Opus 的界面用户**：UI 不传 `chunk_size`，于是继承服务端默认 300，
  任何超过约 300 字的 opus 请求都会被拒。`getRequestBody()` 现在为 opus 请求 `chunk_size`
  上限，并有浏览器测试同时断言「UI 实际发出的请求体」与「长文本仍返回音频」。
- **错误建议必须是当下真的可执行的**。我自己写的 opus 错误信息一律说「请调大 chunk_size
  （上限 2000）」—— 包括 chunk_size **已经是** 2000、以及文本长到任何设置都装不下的时候。
  线上实测 3400 字符 @ cs=2000 就收到这句无法执行的建议。现在判据是「调到上限够不够」
  （用 `smartChunkText` 实算，而不是看当前值），不够就只给换格式与拆分这两条真出路。

### Performance
- **注定被拒的请求不再白花 CPU**。`MAX_CHUNKS` 的检查原先要先把全部字符分块：50000 字符
  @ `chunk_size=50` 切出 1011 块，端到端实测 **39.2ms**，是 Workers 10ms 预算的 4 倍，
  而这个请求从一开始就注定失败 —— 等于给攻击者一条免费的算力消耗路径。
  `ceil(字符数 / chunk_size)` 是分块数的**下界**（`smartChunkText` 永不产生超长块），
  下界超限即可定论。预热后中位数 **0.65ms**（60 倍）。合法请求不受影响：同样输入
  `chunk_size=2000` 是 25 块，未超限，照样走完整流程。

### 关于「不修」的两个决定（都附了实测理由）
- `<audio>.duration` 对 opus 恒为 `null`：上游 `webm-24khz-16bit-mono-opus` 的封装不声明
  Duration 且 Segment 长度未知，**单分块响应同样如此**，与拼接无关。已写进双语 README，
  而不是假装修好。mp3/wav 在部署环境实测分别报 43.464s / 43.4s，正常。
- `input_empty_after_cleaning` 那条防御分支仍不可达：连同新增的 SSML 标签形状重跑穷举，
  5768 种组合无一能让「cleanText 后非空但分块为空」成立。保留为防御，不为覆盖率硬凑。

### 测试
- 新增 opus 护栏 5 例、下界短路 5 例（含**下界永不超过实际块数**的不变量检查，跨 5 种输入
  形状 × 3 种 chunk_size），以及慢路径的正反两例 —— 段长略超 `chunk_size/2` 时装箱最差，
  6946 字符下界 24 但实际 46 块，必须仍被拒，否则 46 个 subrequest 会打到平台上限、
  流式下变成静默截断的 200。
- 251 项（242 通过 / 9 跳过）+ 11 项浏览器 e2e，全部通过。
  `src/worker.js` 覆盖率 **99.31% 行 / 98.19% 分支**（新高），未覆盖的只剩两条已证明
  不可达的防御分支。

## [2.10.0] - 2026-08-04

一轮变异测试 + 41 个 agent 的对抗式深度审计。每条修复都先在**生产环境或真实浏览器里
复现**，回归测试都先确认能在旧代码上变红。审计原始 35 条发现，复核确认 26 条、推翻 9 条。

### Fixed — 静默数据丢失（三条，都是 HTTP 200 + 看似正常的响应）
- **长文本流式静默截断**。`MAX_INPUT_CHARS` 校验的是字符数，而真正的硬约束是**分块数**：
  每块一次上游 subrequest，Workers 单次调用上限 50。默认 `chunk_size=300` 时，文档承诺的
  50000 字符需要 167 次 subrequest，根本不可能成功。线上实测：`chunk_size=50` 时 50 块能过、
  51 块就 500；默认参数下约 6000 字符起间歇性 503（CF error 1102），15000 字符稳定失败。
  流式路径更糟：响应头已发出后 CF 掐掉 isolate，客户端收到的是 200 + **格式完好的 EOF**
  —— 裸 socket 探测确认截断响应的结尾字节与完整响应完全相同（`0\r\n\r\n`），且无
  Content-Length 可核对。约 40% 的大 PCM 流式请求返回残缺音频，UI 显示「✅ PCM完成！0KB」。
  现在 `LIMITS.MAX_CHUNKS = 45`（给 token/语音列表留余量）在**写出任何字节之前**拦截，
  返回 413 `too_many_chunks` 并给出实际块数、上限、以及可行出路。调大 `chunk_size` 确实
  有效且已被测试固定：45000 字符 @ `chunk_size=2000` 正常返回。
- **多分块 WAV 是多个 RIFF 文件裸拼接**，播放器读到第一个头声明的长度就停止。默认参数下
  约 300 字符即触发。线上实测 720 个中文字符丢失 58.9% 的音频（含 150.64s，只播 61.94s），
  headless Chrome 中 `<audio>` 确实在 17.375s 就 `ended`。`concatWavBlobs` 保留首块头部、
  拼接各块 data 负载、重写 RIFF/data 长度字段；按 RIFF 结构遍历而非假设 44 字节头部
  （上游可能插入 LIST/fact 块）。非 WAV 或缺 data 块时退回裸拼接并**记日志**。
- **322 条语音的 description 全是 "undefined - Female"**。代码读 `voice.LocalName`，但上游
  322/322 条都没有该字段（对线上列表核对过），实际字段是 `FriendlyName`。两个 fixture 都
  基于同一个错误假设构建，所以无测试发现 —— 快照现已按真实上游字段重建。

### Fixed — 拒绝服务
- **`cleanText` 的 Markdown 正则存在灾难性回溯**。懒量词并不免疫:`\[(.*?)\]\(.*?\)` 遇到
  `"![](".repeat(n)` 时每个 `[` 都是候选起点，`.*?` 逐字符扩张找 `](` 再回溯。实测
  4KB→656ms、8KB→4.7s、**16KB→36 秒**，而 Workers CPU 上限是 10ms —— 一个远低于
  `MAX_BODY_BYTES` 的请求即可打爆。换成排除定界符的字符类后 16KB 降到 42ms（**863 倍**），
  输出逐例一致（16 个等价性断言，含必须保留下划线的 snake_case）。

### Fixed — 并发与降级
- **过期缓存降级只对一个并发请求生效**。`getModels` 的跟随者走 `return voicesInFlight`
  提前返回，拒绝发生在实现降级的 `try/catch` **之外**。实测上游挂掉时 5 个并发请求里
  只有 1 个拿到完整 322 条，另外 4 个拿到 2 条兜底列表 —— 音色选择器会随机只显示 2 个音色。
- **滑动窗口预取的拒绝处理挂得太晚**。`unhandledRejection` 的判定是时序性的（microtask
  队列排空那一刻检查），事后补 `.catch()` 拦不住上报。窗口内靠后的分块可能在主循环仍
  阻塞于靠前分块时就已 reject，于是 Workers 把一个**已被正确处理**的错误记成 runtime
  exception。改为在 `schedule()` 创建时即挂 handler。

### Fixed — 前端
- **流式失败后声纹 RAF 循环永不停止**。只有 `source.onended` 会 `stopViz`，而失败时可能
  一个 source 都没排上。实测失败后 0.8 秒内 RAF 句柄从 3 涨到 101（~120fps 空转烧 CPU
  和电量，直到关页面）。
- **非 JSON 错误体掩盖真实原因**。CF 自己产生的 503 是 text/plain `error code: 1102`，
  对它调 `response.json()` 抛 SyntaxError，用户看到的是「Unexpected token e in JSON」。
- **下载文件名恒为 `.mp3`**，wav/opus 文件因后缀与容器不符被系统播放器拒绝；流式下载的
  实际是 `pcmToWav` 产物，正确后缀是 `.wav`。
- **跨分块的 `<break>` 标签被拆成两半**。分块分隔符含 `,` 和 `:`，正好出现在
  `<break time="500ms"/>` 内部（UI 的「插入停顿」按钮生成的就是它）。两半各自被转义成
  `&lt;break…` 当正文念出来。SSML 标签现在作为原子片段，即使超出 `chunk_size` 也不切开。
- **非字符串 `custom_keywords` 返回 500** —— 调用方的输入错误却报成服务端错误，现在是
  400 并说明收到的类型。

### Fixed — CI 与测试基础设施
- **CI 自 v2.8.0 起持续红灯**，README badge 一直指向失败的构建。`dist/` 被 gitignore，而
  `npm test` 排在 `npm run build` 之前，于是读 `dist/worker.js` 的 6 个浏览器 e2e 加
  BUG#7c 在每次 CI 都失败，本地却因残留的 `dist/` 通过。干净 clone 实测：修复前
  186 pass / 6 fail，修复后 199 pass / 0 fail。GitHub CI 现在也跑浏览器 e2e。
- **7 个「绿灯但什么都不防」的测试**（变异测试发现，逐个确认修复后能杀掉对应变异）：
  token 生命周期的三条自愈分支可整段删除而 CI 全绿；413 快速路径的测试构造的 Request
  没有 content-length，它声称守护的分支根本不可能执行；「边界值」测试实际只发了 43 字节
  （上限的 0.016%）；语音列表降级断言 `length > 0` 分不清 2 条兜底与 322 条真实列表；
  声纹 e2e 用 `hueSpread > 0 || satSpread > 0`，两条色相通路同时死掉也照样通过；
  BUG#7b 用 try/catch 包住全部断言、两条分支都算通过（实测永远走 catch，三条断言从未执行）。
- **两个静默失效的护栏**：`build.mjs` 只匹配小写 `<script>`，大写 `<SCRIPT>` 完全绕过；
  `CHROME_PATH` 排在候选列表末位，装了 Chrome 的机器上永远不生效（与文档承诺相反）。
- **GitHub CI 的挂起有两个 Linux 特有原因**（修好构建顺序后才暴露出来，且因为「挂起不产生
  日志」，我先盲修了三轮才拿到证据 —— 是 `timeout-minutes` 让 job 结束、日志可下载才定的位）：
  ① Chrome 关闭时仍在异步写 profile 目录，`SIGKILL` 后立刻 `rm` 撞上正在写入的文件抛
  `ENOTEMPTY`，而这个拒绝来自 `after()` 钩子 —— node 子进程成为孤儿，job 挂到超时。
  macOS 允许删除已打开的文件，所以本地永不复现（`--test-concurrency=2` 也只需 30 秒）。
  现在等进程真正退出再删，且把临时目录清理当作 best-effort：残留一个目录不值得让构建变红。
  ② 暗色主题测试依赖浏览器的默认配色 —— headless Chrome 跟随 `prefers-color-scheme`，
  本机是深色而 GitHub runner 是浅色，于是「切到浅色」那条分支在 Linux 上从未执行，
  localStorage 里什么都没写。改为先驱动到已知状态再做两次真实切换。
- 加了 `--test-timeout=120000` 与 `timeout-minutes: 10`：任何将来的挂起都会变成带堆栈的
  失败，而不是一个静默烧 runner 时间的 in_progress。
- **e2e 套件 101s → 29s**。`server.close()` 只停止接受新连接、然后等 Chrome 的 keep-alive
  socket 自然结束，单个测试因此干等 58 秒。改用 `closeAllConnections()`（58s → 0.28s）。
- 修掉一个自己引入的顺序依赖：「完整时长」测试的全局计数器从不重置，另一条流式测试跑过
  之后它会读到 6.00s 而超出 3.3s 上界。

### Changed
- `/v1/models/public` 现在也支持 `?multilingual` 过滤（README 早已承诺，但只有需要鉴权的
  `/v1/models` 实现了，而内置 UI 用的正是公开端点）。两端点共用同一过滤函数。
- `?neural` 明确标注为 **no-op**：上游 322 个音色全部含 "Neural"，过滤不掉任何东西。
  为兼容既有调用方而保留。
- 双语 README 更正三处与实现不符的表述：input 上限、「服务端流式无论格式都下传裸 PCM」
  （实际只有内置 UI 在客户端改写）、以及 `/v1/models/public` 的过滤能力。

### 测试
240 项（231 通过 / 9 跳过）+ 10 项浏览器 e2e，全部通过。
`src/worker.js` 覆盖率 99.28% 行 / 98.14% 分支。

## [2.9.0] - 2026-08-04

深度审计发现并修复两个真实缺陷，均由「亲手复现」而非静态检查得出。

### Fixed
- **上游错误响应体被原样转发给调用方（信息泄漏）**。`getAudioChunk` 把上游响应体拼进
  `Error.message`，`getVoice` 的 catch 又把 `error.message` 直接放进 HTTP 响应，形成
  「上游响应体 → Error → 公网响应」的泄漏链。用 stub 上游返回
  `Subscription key sk-INTERNAL-abc123 rejected at /internal/host`，该字符串原样出现在
  500 响应体里。微软的错误原文可能含订阅密钥片段、内部主机名、请求 ID。
  现在完整内容只进日志，回给调用方的是我们自己的措辞 + 稳定机器码。
  顶层 handler 与 `/v1/models/public` 的错误路径一并收口。
  **注意保留了该保留的**：调用方自身的参数错误仍然给出实际值与允许范围
  （如 `speed 超出范围：99，允许 0.25–4`），只有内部细节被隐去。
- **`audioSrc` 的 Object URL 每次播放泄漏一个**。清理路径只 `revoke` 了 `downloadUrl`，
  而 `audioSrc` 每次标准播放都新建、仅被重新赋值为 `''` 从未释放 —— 每个 URL 持有整个
  音频 Blob，而单页应用几乎不会卸载。真实浏览器实测：4 次播放泄漏 4 个 URL。
  改为统一的 `releaseObjectUrls()`（去重后释放两者，非流式下二者指向同一 URL），
  `beforeUnmount` 也复用它以免两处规则漂移。修复后实测 4 次播放仅剩 1 个
  （最后一次仍在播，属正确）。

### Added
- `test/integration/error-disclosure.test.mjs`（4 例）：断言上游错误体/内部路径不出现在
  响应中、完整内容仍可从日志取得，并**反向断言**校验类错误必须继续携带实际值与限制值。
- 浏览器回归：`object URLs are released between playbacks`，通过挂钩
  `URL.createObjectURL`/`revokeObjectURL` 计数来量化泄漏，而不是读代码判断。

### Changed
- 测试 189 → **194**；E2E 14 → **15**。

## [2.8.0] - 2026-08-04

### Fixed
- **重复播放时声纹冻结**（由本轮新增的浏览器 e2e 首次运行即抓到）。第 2 次及以后的播放，
  声纹画面卡住不再变化 —— 实测第 1 次播放 hue 有 7 种取值，第 2、3 次永远是同一个值。
  根因是一个竞态：`startViz()` 每次会起新的 `requestAnimationFrame` 循环，而**上一次播放
  遗留的 `source.onended`** 会晚于本次 `startViz` 触发，它调用的 `stopViz()` 取消掉的是
  **本次**的 RAF 句柄，于是新循环刚起就被杀死，`vizDebug` 保留最后一帧的值 —— 看上去就是
  「颜色冻结」。修法：给可视化引入「代号」(`vizRun`)，`startViz()` 领号并返回，
  `stopViz(run)` 只接受当前代号的停止请求，陈旧回调的 stop 自动失效。
  修复后第 2、3 次播放各有 8 种色相；线上真实浏览器复验：13 帧 / 12 种色相。

### Added
- **浏览器 e2e（`test/e2e/browser-playback.test.mjs`，5 例）**，用**裸 CDP** 驱动本机
  Chrome —— 本项目坚持零 `dependencies`/`devDependencies`，因此没有引入 Playwright，
  而是用 Node 内置 `WebSocket` 写了一个约 100 行的 CDP 客户端（`test/helpers/cdp.mjs`）。
  无 Chrome 的环境自动 skip，不会把 CI 弄红。覆盖：
  - **「流式必须调度完整时长」** —— 本项目历史上最严重的 bug（1.67s 截断）此前只靠 grep
    UI 源码里是否还有 `size > 10000` 这个字符串来防守，**从未真正播放过一次**。现在
    instrument `AudioBufferSourceNode.start` 累加实际调度的秒数，断言覆盖完整 3s
    （既不能少于 90%，也不能超过 110% —— 后者会暴露重复调度）
  - 流式强制 PCM（由 stub 服务端记录 app 真实发出的 `response_format`）
  - 声纹颜色确实随音频变化（断言色相/饱和有变化量，而不是硬编码区间）
  - 暗色主题的 toggle→持久化→重载恢复，且断言页面底色 RGB 确实是深色
- `test/helpers/ui-server.mjs` —— 零依赖 stub 服务端，从 `dist/worker.js` 取出真实 UI，
  并合成**频谱随时间扫动**的类语音 PCM。（一开始用固定 220Hz 正弦，结果「颜色必须变化」
  的断言对着正确代码失败 —— 固定频谱本就该产生固定色相；这属于 fixture 不真实，
  已改为带音节包络 + 基频扫动 + 噪声混比的信号。）

### Changed
- 测试 184 → **189**；E2E 9 → **14**（其中 5 项浏览器测试在无凭证环境下也会运行）。

## [2.7.1] - 2026-08-04

### Added
- **`test/e2e/legacy-timestamps.test.mjs`（3 例）** —— 锁定 legacy NDJSON worker 的逐词
  时间戳契约：词序正确、`offset` 单调递增（逐词高亮的前提）、NDJSON 事件构成
  （audio + 恰好 4 个 word + 恰好 1 个 done、done 在最后）。另有一条测试**固化「REST
  端点无时间戳」这一约束**：若微软将来补上词边界，该测试会开始失败，即为可以合并的信号。

### Changed
- **ROADMAP P1-7 结论反转：从「待办」改为「架构上无法合并」**，附实测证据。
  原计划是给 `edgetts-proxy` 加 `/timestamps` 端点或支持 `response_format: ndjson`。
  实测后确认走不通：
  - REST 端点（`cognitiveservices/v1`）试了裸请求、`X-Microsoft-OutputFormat-WordBoundary`、
    `Ocp-Apim-Subscription-Key` 三种组合，**均只回纯音频**，响应头零时间戳字段
  - 词边界只存在于 WebSocket 协议，而出站 WS 只能跑在 `*.workers.dev`（自定义域名下
    CF 代理层破坏握手）—— 同一个自定义域名的 worker 物理上无法同时提供两者
  ROADMAP 与双语 README 现在明确写出「要时间戳请调 legacy 部署」及其地址与响应结构。
- **`legacy/` 去留裁定：保留**。它不是死代码，是逐词时间戳的唯一来源（`pte-wfd-216` 依赖），
  且已由 e2e 锁定契约 —— 这样它就不再是「lint 豁免的永不清理目录」。
- 测试 181 → **184**（E2E 6 → 9）。

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
