# 交接文档 / HANDOFF

> **给接手这个项目的人（含其他 AI Agent）：先读这一份，再读代码。**
>
> 最后更新：2026-08-09 · 对应版本 `2.30.3` · 线上 `v2.29.1`
>
> 这份文档回答四个问题：**这是什么项目**、**现在是什么状态**、**还剩什么该做**、
> **动手前必须知道哪些坑**。ROADMAP.md 记「做什么」，CHANGELOG.md 记「做过什么」，
> 这份记「**为什么**，以及别再踩的坑」。

---

## 1. 这是什么项目

一个 **Cloudflare Worker**，把微软 Edge / Azure TTS 包成**兼容 OpenAI** 的语音合成 API，
并自带一个内嵌的 Vue 单页应用做 Web UI。

- 线上：<https://edgetts.aws.xin> · Worker 名 `edgetts-proxy`
- 定位：**让尽可能多的人能用** —— 所以**刻意不做**速率限制、不收紧 CORS（见 §5 设计决策）
- 零运行时依赖：`node_modules` 是空的，构建与测试只用 Node 内置能力（含测试用的 CDP 客户端）

### 代码地图

| 路径 | 行数 | 说明 |
|---|---|---|
| `src/worker.js` | 1708 | **生产 Worker**。单文件，含路由/鉴权/分块/合成/容器合并/日志 |
| `ui/index.html` | 2463 | **内嵌 Vue SPA**。构建时注入进 Worker（`UI_HTML`） |
| `scripts/build.mjs` | 64 | `ui/` + `src/` → `dist/worker.js`。含两个守卫（见 §6） |
| `legacy/worker-ndjson.js` | 166 | **不是死代码**：逐词时间戳（WordBoundary）的唯一来源，见 §5 |
| `test/{unit,integration,regression,e2e}/` | 23 个文件 / 9283 行 | 测试:源码 ≈ 2.2:1 |
| `docs/research/*.md` | 5 份 | 系统审计报告，每份都有实测数字 |

### 项目的由来（**重要背景**）

2026-08-03 审计发现：**线上服务的代码没有任何本地副本或版本管理**。它是一个压缩过的单文件
Worker，只存在于 Cloudflare 上；而仓库里原有的 `worker.js`（166 行 NDJSON 协议）与线上是
**完全不同的两份代码**。

所以这个仓库是「把线上代码反压缩、归位、补测试、再修 bug」的过程产物。这解释了为什么
`src/worker.js` 是单文件、为什么注释密度异常高（很多是逆向出来的结论）、
以及为什么 `legacy/` 与生产代码毫无关系。

---

## 2. 现在是什么状态

| 维度 | 数字 | 备注 |
|---|---|---|
| 测试 | **347 项**（326 fast + 21 browser e2e） | 另有 12 项真网 e2e 需凭证，默认 skip |
| `src/worker.js` 覆盖率 | **99.47% 行 / 97.76% 分支** | 未覆盖仅 2 处，均为**已证不可达**的防御分支 |
| CI | **GitLab + GitHub 双跑**，均含 browser e2e | 2026-08-08 起 |
| 累计修复缺陷 | **11 个**（五轮系统审计） | `cleanText` 8 + WebM 1 + UI 无障碍 1 + CI 守卫 1，逐项来源见 `ROADMAP.md` 快照 |

### ⚠️ 版本与部署的当前真相（别误判）

```
package.json   2.30.3
最新 git tag   v2.29.1
线上           v2.29.1
```

**看着像漏部署，其实不是。** `2.30.0` 起的几个版本只改了 `.gitlab-ci.yml`、
文档与测试（`git diff --stat v2.29.1..HEAD -- src ui` 可自行核实：**输出为空**，
无 `src/` 或 `ui/` 改动），所以**线上代码已是最新，无需部署**。

但这个模式**踩过一次**：2026-08-08 收尾时发现 `v2.28.0 / 2.28.1 / 2.29.0` 三个版本
**从未打 tag，也就从未部署** —— 含 UI 无障碍修复和 WebM 空输入守卫。
**动 `src/` 或 `ui/` 之后，务必打 tag**（见 §3 发布流程）。

---

## 3. 怎么干活（命令与流程）

```bash
npm run build      # ui/ + src/ → dist/worker.js（必须先跑，多个测试读 dist）
npm test           # 全量门禁：326 fast + 21 e2e（约 5 分钟）
npm run test:fast  # 只跑后端，快速反馈
npm run coverage   # 带覆盖率
npm run dev        # wrangler dev
```

### 发布 / 部署

**Deploy workflow 只在推 `v*` tag 时触发**（`.github/workflows/deploy.yml`）。
推 main 不会部署。

```bash
# 1. 确认 CI 双绿（下方 §7 有查询命令）
# 2. 打 tag 并推两个远端
git tag -a v2.31.0 -m "..."
git push github v2.31.0 && git push gitlab v2.31.0
# 3. 等 Deploy workflow success，然后**实测线上**而不是只看绿灯
```

必要凭据在 `~/.env`：`CLOUDFLARE_ADMIN_TOKEN`（走 CF skill）、`CLOUDFLARE_EDGETTS_API_KEY`
（打线上 API 用）、`GITHUB_TOKEN`。**绝不硬编码、绝不贴进对话、绝不嵌进 push URL。**

**部署前备份线上产物**（项目惯例，`~/backups/edgetts-proxy/`）：

```bash
source ~/.env
curl -s -H "Authorization: Bearer $CLOUDFLARE_ADMIN_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/27ed3325f4acbeec8a852da73c9c5e02/workers/scripts/edgetts-proxy" \
  -o ~/backups/edgetts-proxy/edgetts-proxy.$(date +%Y%m%d-%H%M%S).pre-vX.Y.Z.js
```

> **核验备份只能用 ASCII 标记**：`wrangler` 会把中文转成 `\uXXXX`，
> 用中文 grep 备份会得到「内容可疑」的假结论（踩过）。

---

## 4. 已完成的工作与它们的**原因**

P0/P1/P2 的完整条目见 `ROADMAP.md`。这里只讲**为什么**，因为那才是接手时最难重建的部分。

### 贯穿全项目的一条主线：**静默失败**

这个项目修掉的绝大多数 bug 属于同一类 —— **响应是 200、格式合法、内容是错的**，
调用方无从察觉。按发现顺序：

| 缺陷 | 症状 | 为什么危险 |
|---|---|---|
| 流式播放截断 | 只播前 **1.67 秒** | 部分 MP3 blob 解码成「完整的短片段」，播完即 `ended` |
| 多分块 WAV | 静默丢 **58%** 音频 | 裸拼接 N 个 RIFF，播放器读第一个头的长度就停 |
| 多分块 Opus | 静默丢最多 **90%** | `<audio>` 只认第一个 WebM 容器（实测 9.44s vs 实际 94.56s） |
| 流式容器格式 | 播到 **32%** 停止 | 首个头声明 61.46s，实际含 191.67s，且无法回填 |
| 上游空音频 | **200 + 0 字节** | 音色对该书写系统零覆盖时上游不报错，直接返回空 |
| 小数被吃 | `3.14159` → `.14159` | `remove_citation_numbers` 分不清句号与小数点，**UI 默认开启** |
| VS16 emoji 残留 | `❤️` 被念出来 | `\p{Emoji_Presentation}` 不含文本样式 emoji |

**所以本项目的核心原则是：宁可明确报错，也不要返回一个「看着正常」的错误结果。**
新增任何降级路径时，必须留痕（`degraded` 字段 + warn 日志），见 §6。

### 为什么做了结构化日志（P1-6）

审计发现 18 个日志点里 **17 个只在异常路径**，唯一那条正常路径日志记的是 token 有效期
—— **一个成功的 200 请求不产生任何日志**。后果：5xx 率 / p99 / 重试率**都没有分母**。

上线后**三轮维度普查各抓到一个真 bug**（voice 的空音频、chunks 的自相矛盾文案、
以及 UI 无障碍）。这是「先量再改」最直接的回报。日志字段见双语 README 的「可观测性」一节。

### 为什么 GitLab 也要跑 browser e2e（2026-08-08 刚完成）

2026-08-06 GitHub Actions 出现 `major_outage`（官方状态页确认）：同一 commit 在 GitLab
通过，而 GitHub 连 runner 都拿不到。**那天 21 个 browser e2e 一个都没跑**，UI 只剩本机
`npm test` 守着。现在两边都跑，UI 回归有两条独立防线。

---

## 5. 刻意**不做**的事（别当成待办重新提出来）

| 项 | 为什么不做 |
|---|---|
| **速率限制** | 定位是「让尽可能多的人能用」，`API_KEY` 是唯一门槛。Neo 2026-08-03 明确。代价（key 泄漏可跑满配额）已知并接受 |
| **收紧 CORS** | 同上，保持 `Access-Control-Allow-Origin: *` 方便第三方前端集成 |
| **前端 key 改后端会话** | Neo 2026-08-06 裁定：与「任何人一条 `wrangler deploy` 就能部署副本」的定位冲突。改为**文档化边界**（双语 README 有「仅供受信任环境使用」一节） |
| **合并 WordBoundary 时间戳** | **架构上不可能**：词边界只存在于 WebSocket 协议，而出站 WebSocket 只能跑在 `*.workers.dev`（自定义域名下 CF 代理层破坏握手）。实测三种 header 组合请求 REST 端点，返回的都是纯音频、零时间戳字段。所以 `legacy/` 保留 |
| **MP3 帧级拼接** | 量化后判定不值得：每边界仅 **130ms** padding、`silencedetect` 检出 **0 处**可感知断点、`ffmpeg` 零告警。收益配不上在 10ms CPU 预算内新增帧解析 |
| **拦「音频内容错误」** | 希腊文送非希腊音色不是空音频而是**错误音频**（逐个念字母名，时长 3.4 倍）。判断内容正确性需要启发式，误伤风险高；且与空音频不同，用户听一遍就知道 |

---

## 6. 动手前必须知道的坑（**这一节最省时间**）

### 6.1 `ui/index.html` 的内联 `<script>` 里不能有反引号或 `${`

构建会把 UI 塞进 Worker 的模板字符串，反引号会破坏它、Vue 直接不挂载。
`scripts/build.mjs` 有守卫，**构建会失败并指出行号**。写字符串拼接，别用模板字面量。

### 6.2 注释里不能写出测试导出的字面名字

`src/worker.js` 末尾导出一个测试专用对象。CI 与本地测试都会 grep `dist/worker.js`
里有没有那个名字，用来确认构建剥掉了测试面。**构建只剥导出、保留注释** ——
所以在注释里提到它会让 CI 变红（踩过）。要提就用「测试导出」这类描述性说法。

### 6.3 mock 上游会捕获 `console.*`

`test/helpers/mock-upstream.mjs` 刻意接管 `console.log/warn/error`（否则 Worker 写 stdout
会污染 `node --test` 的结果通道）。**在探针脚本里 `console.log` 会被吞掉** ——
要么先 `mock.restore()` 再打印，要么把输出缓存到数组、最后统一打。踩过两次。

### 6.4 断言绝对毫秒数会在 CI 上变红

**本 session 犯过三次。** 同一段代码在开发机 1.96ms、在共享 runner 20.07ms。
要断言性能就断言**比例**（半量 vs 全量、日志开销占请求的百分比），不要断言绝对值。
同理，用 `sleep` 制造时序差时**别依赖小间隔**：12ms 的间隔在 CI 上被抖动翻转过，
改用 promise 链把顺序变成因果保证。

### 6.5 e2e 是「无 Chrome 时 skip 而非 fail」——所以需要防 skip 守卫

这是刻意设计（否则无 Chrome 的机器无故变红）。但它意味着**镜像里 Chrome 一坏，
job 会报「21 ok」并永远绿、却什么都没守住**。GitLab 的 `test:browser` job 末尾显式检查
`# skipped` 与 `# pass` 的数量。**改镜像或 Chrome 路径后，要把 `CHROME_PATH` 指向不存在的
地方，验证守卫仍会失败** —— 一个不会失败的守卫等于没有守卫。

### 6.6 `| tee` 会吞掉退出码

管道退出码取 `tee` 的（永远 0），测试失败会被静默忽略。CI 脚本里用了 `tee` 就必须
`set -o pipefail`。

### 6.7 改正则前先想 ReDoS

这个项目曾因 `\[(.*?)\]\(.*?\)` 在 16KB 输入上跑到 **36 秒**（Workers CPU 上限 **10ms**）。
**懒量词不免疫灾难性回溯。** 用「排除定界符的字符类」（`[^\]]*`）而不是 `.*?`。
`test/unit/redos.test.mjs` 有预算测试，改动 `cleanText` 的正则后必须重跑。

### 6.8 Workers 的并发模型：模块级可变状态会串

单个 isolate 并发处理多个请求，并在**每个 `await` 处交错**。实测：3 个并发请求
（延迟 30/5/15ms）用模块级变量记日志，**三条全部记成最后开始的那个请求**。
所以日志上下文是**每请求一个对象**、显式穿过调用链。别引入模块级的「当前请求」。

### 6.9 平台硬约束

- **subrequest 上限 50/次调用** → `MAX_CHUNKS=45`（留 5 个给 token 与语音列表）
- **CPU 10ms**（挂钟不限，等上游 I/O 不计入）→ 任何热路径改动都要量
- **出站 WebSocket 只能在 `*.workers.dev`** → 见 §5 WordBoundary

---

## 7. 常用查询命令

```bash
# GitLab 流水线（主链路）
source ~/.env
mcurl -s "https://gitlab.aws.dev/api/v4/projects/jiasunm%2Fedgetts-ws-worker/pipelines?ref=main&per_page=3" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN"

# GitHub CI / Deploy
source ~/.env
gh run list --repo neosun100/edgetts-ws-worker --workflow=ci.yml --limit 3
gh run list --repo neosun100/edgetts-ws-worker --workflow=deploy.yml --limit 3

# GitHub Actions 是否在故障（踩过两次，别误判成自己的代码问题）
curl -s https://www.githubstatus.com/api/v2/components.json | grep -o '"name":"Actions","status":"[a-z_]*"'

# 线上日志（结构化 JSON，每请求一行）
source ~/.env && export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_ADMIN_TOKEN"
export CLOUDFLARE_ACCOUNT_ID=27ed3325f4acbeec8a852da73c9c5e02
npx wrangler tail edgetts-proxy --format=json
# 注意：输出是「多个 pretty-print JSON 对象首尾相接」，不是 JSONL。
# 按行解析会得到 0 条（踩过）——要按大括号配平切分。
```

---

## 8. 还剩什么（TODO）

> **完整清单见 [`docs/FUTURE_WORK.md`](FUTURE_WORK.md)** —— 那份还额外记了「观察到但明确
> 不构成问题」的 6 项（防止重复调查），以及每条的前置条件。
>
> **当前状态：Neo 2026-08-09 明确「当前已经很好了」，下列一项都不要主动做。**

**P0 / P1 全部关闭，P2 里「值得做」的也都做完了。** 剩下两项，**当前明确不建议动**：

### TODO-1：`// @ts-check` + JSDoc（低成本那半）

- **是什么**：给 `src/worker.js` 顶部加 `// @ts-check`，逐步补 JSDoc 类型注解。
  不引入 TypeScript、不改构建、不改运行时。
- **为什么值得**：能在编辑器里抓到 `undefined` 传参、拼错的属性名之类。
  本项目修过的 bug 里有几个属于这类（`parseWebmChunk` 的字段叫 `tc` 而非 `timecode`，
  审计时我就猜错过）。
- **为什么现在不做**：纯内部收益，用户看不到；而 `src/worker.js` 刚经过契约审计
  （7 模块 250 用例）、覆盖率 99.47%，现在动它是拿已验证的稳定性换抽象的「更严谨」。
- **怎么做**：一次只加一个函数的 JSDoc，每次跑 `npm test`。别一把全加。

### TODO-2：前端拆分（**最不建议**）

- **是什么**：`ui/index.html` 已 2463 行，含 322 个音色的语言映射表。可把数据表抽出去。
- **为什么现在不做**：
  1. 用户零可见收益
  2. 它刚经过系统审计（7 个方向，1 真缺陷已修），有 21 项 browser e2e 守着
  3. **拆分会撞上 §6.1 那个约束**（内联 script 不能有反引号），且构建脚本要跟着改
- **如果一定要做**：先只抽「音色语言映射表」这一块纯数据，别动逻辑；
  抽完立刻跑 `npm test` 确认 21 项 browser e2e 全过。

### 更值得做的第三条：**看真实流量数据**

日志上线才两天。等积累一段真实流量后，用 `voice` / `format` / `chunks` 分布回答：

- **322 个音色的语言映射表还值得维护吗？** 如果 99% 请求集中在 10 个音色，那张表就是负债
- **`MAX_CHUNKS=45` 与默认 `chunk_size=300` 合理吗？** 实测默认值容量是 12179–13500 字符
- **重试率与 5xx 率是多少？** 现在终于有分母了

查询方式见 §7。这条不需要写代码，是「看」而不是「改」——
而本项目的经验是**没量之前，"该改"和"不值得改"长得一模一样**。

---

## 9. 方法论：五轮系统审计的教训（**给 Agent 的重点**）

五轮审计的统计是：**真缺陷 : 假警报 ≈ 1 : 4**。假警报几乎全是同一形态：

> **为了验证 X，我手写了一个 X 的实现，然后信了它。**

具体翻车记录：

| 手写的验证工具 | 错在哪 | 假结论 |
|---|---|---|
| XML 良构检查器 | 正则处理不了引号属性值里的 `/` | 「getSsml 输出非良构」 |
| EBML 字节扫描器 | 撞到音频负载里巧合的 `E7 88` | 「WebM 时间戳非单调」 |
| 同上（第二版） | 只匹配到 0 个元素 | 「✅ 单调」—— **空数组上的空洞通过** |
| 对比度计算器 | 忽略 alpha 合成 | 「浅色主题 17/25 元素对比度不足」 |
| 注入元素选择器 | 命中页面自己的 `<script>` | 「XSS 注入成功 1 处」 |
| RAF 泄漏探针 | 测在了循环启动之前 | 「无泄漏」（结论对，过程无效） |

**有效的判据顺序**：

1. **可观测的最终结果** —— 截图、资源累积、音频时长
2. **标准工具** —— `xml.etree`、`ffprobe`、DevTools a11y 面板
3. **被测代码自己的解析器** —— 读它自己的格式，别另写一个
4. 手写检查器（最后手段，且要先验证检查器本身）

**两条快速自检**：

- **荒谬的数字就是探针错了的信号**：`1.00:1` 对比度、`1.65e19` 时间戳、
  夹在 15450 和 15950 之间的异常值。
- **「通过」也要看是不是空洞的**：0 个元素上的 `every()` 恒为 true。

还有一条独立的：**失败集合与自己某个实现选择完美相关时，先怀疑探针。**
（全音色普查第一版报 30/322 失败，失败的语言集合与「我发错文字的语言集合」完全重合 ——
改成按语言给母语文本后，异常从 30 变成 **0**。）

### 测试的标准：必须验证过「对着 bug 会变红」

本项目的所有新测试都做了变异验证。这不是形式主义 —— 本 session 写出过**两个绿着却什么都
没守住的测试**：

- 并发栅栏测试最初断言「派发顺序」，而**分批实现也满足那个断言**
- `chunk_size` 建议值测试最初只用 50000 字符输入，**放过了 `* 1.05` 那个错误实现**
  （它在 5000 字符处才失效 —— 短输入才有区分力）

**写完测试就故意把代码改坏，确认它变红。** 参数化测试要覆盖「机制会改变」的那一段，
不只是极值。

---

## 10. 研究报告索引

五份系统审计报告，都带实测数字与复现方式：

| 报告 | 内容 |
|---|---|
| `docs/research/empty-audio-sweep-20260806.md` | 全 322 音色空音频普查 + 9×9 书写系统交叉矩阵 |
| `docs/research/chunk-distribution-20260806.md` | `chunk_size` → 容量映射、填充率、413 文案修复 |
| `docs/research/markdown-cleaning-audit-20260806.md` | `remove_markdown` 7 条正则审计，5 个缺陷 |
| `docs/research/module-audit-20260806.md` | 7 个后端模块契约审计，250 用例 |
| `docs/research/ui-audit-20260807.md` | Vue SPA 7 个方向审计 |

`CHANGELOG.md` 里每个版本都记了**为什么**而不只是**改了什么**，包括我自己的判断失误
与自纠 —— 那些是重建上下文时最有用的部分。
