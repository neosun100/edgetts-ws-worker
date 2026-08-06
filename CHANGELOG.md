# Changelog

## [2.22.1] - 2026-08-06

全局复盘整个项目后重写 ROADMAP 的规划部分。**没有新功能** —— 这一轮的产出是「把猜测换成
实测数字」，以及据此把两件事从待办里**移出去**。

### Fixed
- **版本号漂移**:`package.json` 停在 `2.20.0`,而 CHANGELOG 与 git tag 已是 `2.22.0`。
  它在项目开头设过一次就没再维护过,**且无任何测试守护**(版本号不参与运行时,漂移是静默的)。
  已改对,并加一致性测试(对比 `package.json` 与 CHANGELOG 首个版本号)。刻意**不查 git tag**:
  测试必须能在浅克隆(GitLab CI 用 `GIT_DEPTH: 1`)和无 `.git` 的 tarball 里通过。
- **ROADMAP 里一处不实描述**:P1-8 原写 CI 跑「全量测试」。实测两边跑的不是同一批 ——
  GitHub `ubuntu-latest` 预装 Chrome,跑 283 fast + **19 browser**(跳过 9 个真网);
  GitLab `node:22-slim` 无 Chrome,**19 个 browser 全跳过**(`pass 0 / skipped 28`)。
  即 **UI 回归的自动防线只有 GitHub 一条**。已改为写明边界。

### 量化后判定「不做」
- **P1-5 MP3 帧级拼接**。原文写「边界可能有极短的不连续」—— 把「可能」量掉了。同一段文本
  8 块 vs 单块线上实测:36.576s/1524 帧 vs 35.664s/1486 帧,**多 0.912s = 38 帧,每边界约
  130ms**;`ffprobe` 时长完整、`ffmpeg -f null` 零告警、`silencedetect -45dB:d=0.3`
  两者**各检出 0 处**。所以边界是「每块开头多了编码器 padding 的极短静音」,不是爆音/丢帧/
  间断。收益(8 块省 0.9s 静音)配不上成本(10ms CPU 预算内新增 MP3 帧解析)。
  与 WAV/WebM 合并**不是同一量级**:那两个不做会丢 58% / 90% 音频,是真缺陷;这个是打磨。
- 过程中一处自纠:我先按 MPEG-1 的 1152 样本/帧算出 1.824s,与时长差 0.912s 对不上。
  实测 24.00ms/帧 → **576 样本/帧**(MPEG-2 Layer III @24kHz)才对。
  **两个推导不一致时必有一个错,不能都写进文档。**

### 规划:下一步只剩一项
- **P1-6 结构化日志**是 P1 里唯一还有实质价值的。实测 `src/worker.js` 的 18 个日志点里
  **17 个只在异常路径**,唯一那条正常路径日志记的是 token 有效期 —— **一个成功的 200 请求
  不产生任何日志**。后果:5xx 率 / p99 / 重试率**没有分母**,「哪些音色真的被用」也答不出。
  这和本轮修掉的几个 bug 同源:分批栅栏白扔 2.5× 延迟、Deploy workflow 三天没通、UI 数值
  贴到隔壁列 —— **全都是「没人在看」才活下来的**。
- 其余排序:GitLab 跑 browser e2e(收益有限,GitHub 已在跑)> `cleanText` 脏数据来源注释
  (违反项目自己的铁律)> TS 化/前端拆分(**不建议现在动**)。

### 新增:项目现状快照
ROADMAP 增加一节实测数字,免得下次又靠印象规划:生产代码 1430 + 2460 行、测试 7988 行
/ 313 项(测试:源码 ≈ **2:1**)、`src/worker.js` 覆盖率 **99.51% 行 / 98.25% 分支**
(未覆盖仅 2 处,均为已证不可达的防御分支)、运行时依赖 **0**、89 个提交。
并说明「all files 78.67%」这个数字会误导 —— 它把构建产物 `dist/worker.js`(70.94%,
仅少数测试读取)也算进均值了,该看的是 `src` 的 99.51%。

共 303 个测试(284 fast + 19 e2e)。

## [2.22.0] - 2026-08-06

### Deployed — 并修好了一条自始至终没跑通的部署路径
- v2.22.0 已上线 `https://edgetts.aws.xin`。线上复验:`slider-label-row` 4 处、旧
  `slider-group span` 0 处;浏览器实测数值距**自己的**滑轨 11px、距右邻列 24px(修复前是
  18px vs 24px,几乎等距 —— 这就是「读起来像标注隔壁列」的成因),滑轨占列宽 98%,322 音色
  正常渲染。后端冒烟:单块 MP3 200/11808B、10 句多分块 WAV 合并成**单个 RIFF** 200/2.07MB、
  流式 wav 多分块按预期 400 `stream_format_not_chunkable`。
- **Deploy workflow 此前从未成功过一次**(`{"failure": 2}`):`v2.1.0` 三天前就以同样原因
  失败 —— repo 从来没配 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。也就是说线上那个
  v2.20 左右的版本**不是 CI 部署的**,是手工 `wrangler deploy` 上去的;这条路径一直是坏的,
  只因平时不打 tag 就没人看到它红。两个 secret 已配好,并**重跑 v2.22.0 的 deploy 确认
  success** —— 这是该 workflow 历史上第一次成功。「配好了」不等于「能用」,必须跑一次。
- 部署前已按项目惯例备份线上产物到
  `~/backups/edgetts-proxy/edgetts-proxy.20260806-132127.pre-v2.22.0.js`(167KB,已校验含旧
  UI 标记,可回滚)。所有 CF 操作走 `~/.claude/skills/cloudflare`(强制规则)+
  `CLOUDFLARE_ADMIN_TOKEN`,token 只从 `~/.env` 现读,不落盘、不回显。

### Decided — ROADMAP P1-3:前端 API key 存储(Neo 裁定)
- **裁定:文档化边界,不改后端会话。** 后端会话(同源 cookie + 服务端持有 key)与本项目的
  立足点冲突 —— 任何人一条 `wrangler deploy` 就能部署副本,引入会话存储会给这条路径加依赖。
  把 key 交给浏览器是这份简洁的代价,这个选择**被写明,而不是被藏起来**。
- 双语 README 各加一节「内置 Web UI 仅供受信任环境使用」:说清机制(明文存 localStorage、
  同源脚本可读)、三条建议(自己的机器上用 / 不要把 UI 地址当共享访问的方式发给别人 /
  不要嵌进有第三方脚本的环境),并交代已堵掉的部分,以便准确界定**剩余**风险。
- 三条安全宣称已由测试钉住(逐条验证过变红):Vue 固定版本 + SRI + `crossorigin`
  (缺 `crossorigin` 时 SRI 会**静默失效**,所以单独断言)、注入面 0 处、
  localStorage 逐字段类型检查。

### Fixed — tts_config 的浅展开(存 key 的那个 store)
- `loadConfig` 用的是 `{ ...this.config, ...JSON.parse(saved) }` —— 与早先已在 `tts_form`
  上修掉的**同一形状**,但 config 漏了,而它恰好存 baseUrl 与 API key。
  实测把 `apiKey` 改成 `null` / `42` / `[1,2]` 后点「生成语音」,`generateSpeech()` 的
  `.trim()` 抛**未捕获**异常,页面既不报错也不动 —— 用户看到的是「按钮点了没反应」。
  已改为逐字段只收字符串,非法值退回默认,落到既有校验给出「请填写 API 配置和输入文本」。
- 刻意不写成通用的 `typeof parsed[k] === typeof this.config[k]`:那样一旦以后有字段默认值
  是对象,`typeof null === 'object'` 就会让 null 通过。

### 原有测试为什么没抓到
malformed-localStorage 那张表里 `tts_config` 只有 `{{{` 和 `[]` 两例 —— 而这两例本就被
`try` 与 `Array.isArray` 挡住。真正的洞是**格式合法、字段类型错**,且**只在点击生成时**触发,
而那个测试只断言到「页面还能挂载」。已补 7 个类型错例,并在每一例后真正点一次生成按钮、
断言 `window.onerror` 与 `unhandledrejection` 都为空。

### 两处自纠(记录以备后鉴)
- **我用 `>/dev/null 2>&1` 把构建失败藏掉了。** 加的注释里带了反引号,触发了项目自己的构建
  守卫(内嵌 script 不能有模板字面量),于是 `dist/` 从此停在旧版 —— 而我还在拿旧 `dist`
  跑探针,得出「修了但没生效」的错误结论。**构建输出不该静默丢弃**。
- 「改动是否生效」我一开始查的是 `grep 注释文本`,这个检查本身无效(构建会保留注释,但那不是
  判据)。应当查**逻辑**是否在产物里,后来改成直接读 `dist` 里 `loadConfig` 的函数体。
- 验证 SRI 断言时,我的 `sed` 变异是**空操作**(script 标签跨多行,单行 sed 匹配不上),
  一度看着像「测试没抓到」。换成跨行替换后确认断言正常变红 —— **变异测试里,先确认变异真的
  施加成功**,否则「没变红」是假阴性。

## [2.22.0] - 2026-08-06

### Fixed — 滑块数值读起来像在标注隔壁那一列
- 截图反馈:宽屏下「音调」的 `1.00` 紧贴「输出格式」的下拉框,看着像 `输出格式 = 1.00`。
  **成因是邻近性,不是溢出**。数值原先放在滑轨**右侧**(`.slider-group` 里),而栅格是
  `auto-fit minmax(200px, 1fr)`。1242px 实测:数值离**自己的**滑轨 18px、离**右邻列** 24px
  —— 两个距离几乎相等,Gestalt 邻近性就不再表达归属。没有任何元素溢出,所以查裁剪查不出来;
  且列越窄越糟。
- 数值挪到 **label 同一行的右端**:与自己的 label 共享容器边界,归属由布局本身决定,与列宽
  无关。滑轨同时拿回整列宽度(实测从 **66% → 98%**),更好拖。这与页面已有的
  `.label-with-controls` 是同一模式,不是新发明。
- 顺带修掉一处无障碍缺失:两个 label 原先**没有 `for`**,只是装饰文字。现在绑定到各自的
  range input —— 点 label 即聚焦滑轨(6px 高的轨道之外多了个点击目标),读屏也能正确播报
  「语速,滑块」。数值元素改用语义正确的 `<output for=...>`。
- 数值加 `font-variant-numeric: tabular-nums`:拖动时 `1.00 -> 1.05` 字形等宽,数值不再左右跳。
- 清掉两条已失效的 `.slider-group span` 规则(结构变了之后不再匹配任何元素)。留着就是
  项目自己规则里说的「lint 豁免目录」——没人敢动的死代码。

### 测试
新增 2 个浏览器 e2e,均验证过对着旧布局会变红:
- 360px–1600px 八个宽度下,数值必须**在自己的栅格单元内**、**离自己的滑轨比离右邻列更近**、
  且滑轨占列宽 >90%。
- 点 label 必须聚焦对应滑轨。

「在自己单元内」这条单独不够 —— **旧版本也满足它**(从来没溢出过)。真正断言到那个 bug 的是
**邻近性顺序**那条,已单独构造「滑轨满宽 + 数值贴右邻列」的变体确认它会独立变红,不是靠
滑轨宽度那条顺带抓到的。

共 300 个测试(281 fast + 19 e2e)。

## [2.21.0] - 2026-08-05

审计**并发调度**与**token 生命周期**两条路径。查出一处性能缺陷和一处归因错误的故障,
两者都是「看着对、也一直没人量」的类型。

### Performance
- **非流式路径的分批栅栏换成工作池**。原写法是 `for (i += concurrency) { await
  Promise.all(batch) }`,每个批边界都是一道栅栏,于是每批的耗时是**该批最慢一块**而不是平均值。
  上游延迟有长尾(多数 ~100ms、偶发 500ms+),一块慢就让同批其他槽位空转到批结束。
  用真 worker 打 mock 上游实测(每 10 块里一块 500ms、其余 100ms):

  | 分块数 @ 并发 10 | 分批 | 工作池 | 工作量下界 |
  |---|---|---|---|
  | 12 | 645ms | 530ms | 160ms |
  | 24 | 1505ms | 708ms | 360ms |
  | 40 | 2012ms | 812ms | 560ms |

  流式路径(`pipeChunksToStream`)本来就是滑动窗口 —— 它必须按序输出,逼得它显式记下标,
  顺手就成了工作池。非流式靠 `Promise.all` 白拿顺序,分批写法看着对,就没人发现它在白扔延迟。
  两条路径的调度语义现在一致。输出未变:并发 1/2/4/10/45 下 sha256 逐字节相同(且故意让
  上游倒序应答)。
- **补上工作池缺的熔断**。分批栅栏顺带当了熔断器:批一里有块致命失败,批二就不会开始,
  所以 45 块请求在第 0 块失败时只花 10 次上游调用。无保护的工作池会把整个数组抽干 ——
  实测 45/45 —— 白烧单次调用仅 50 次的 subrequest 配额,换一个注定被丢弃的响应。
  这是修第一版时引入的回归,已加显式停止标志,调用数回到与分批相同的 2/10/10。

### Fixed
- **token 端点挂 + 缓存 token 已过期时,错误归因完全错误**。兜底判断只看
  `tokenInfo.token` 存不存在,过期的照样交给上游,于是形成一条谁都想不到的因果链:

  ```
  token 端点挂 + 缓存已过期 → 返回死 token → 上游 401 → 401 属可重试
  → forceRefresh → 端点还是挂 → 又是同一个死 token → 3 次耗尽 → 抛 status 401
  → getVoice 把上游 4xx 当调用方错误 → 回「voice 不存在,请用 GET /v1/models 里的 id」
  ```

  实测复现:`status=400` + 那句音色文案。真实原因是**我们自己**拿不到 token,却让调用方
  去换音色 —— 排查方向完全错。改为只在缓存 token **仍然有效**时兜底(提前 5 分钟刷新,
  所以这种缓存通常还有几分钟寿命,顶过一次上游抖动是划算的);已过期则不再兜底,
  返回 500 `tts_generation_error`,归因回到我们这边。流式路径同一场景会**中断流**而不是
  给一个干净的零字节 EOF —— 已补测试确认(把 `writer.abort` 换成 `close` 会让它变红)。

### 一处测试命名掩盖了上述 bug
- 原有测试叫 *"an expired cached token is reused when the token endpoint is down"*,
  但它的 fixture 是 `tokenExp: 120` —— **还剩 120 秒寿命**,并没有过期,只是落在 5 分钟
  刷新窗口内(所以刷新会触发)。交给上游的 token 是完全有效的。
  两个独立测试(`token-lifecycle` 与 `error-disclosure`)都继承了这个错误说法,于是
  「真的过期」这个分支从来没被覆盖过 —— 套件看着已经覆盖了,就没人再写。
  两处命名与注释均已更正,并补上真正的过期分支。
- 「降级必须留痕」这条规则**双向成立**:选择**不**降级也是运维需要看到的决策,
  且必须与成功兜底区分开。`error-disclosure` 的降级路径清单从 6 条增加到 7 条。

### 测试
新增 11 个测试(8 个并发工作池 + 3 个 token 生命周期),**每一个都验证过对着它所守护的
实现会变红**。这一轮里我写出过两个「绿着却什么都没守住」的测试:
- 并发栅栏测试最初断言**派发顺序**,而分批也满足那个断言 —— 改为断言「慢块完成的那一刻
  已派发多少块」(分批恒等于窗口大小)。计数也比时长可移植,这是 CPU 预算测试在 CI 上
  变红换来的教训。
- README 文档测试当场抓出我刚写的 prose 缺陷:中文 README 用全角括号,断言匹配不上。

### Fixed — 一个 fixture 自己在竞争(不是产品缺陷)
- `multi-chunk stream emits every chunk exactly once...` 在 GitLab CI 上变红,分块 2 与 3
  的完成顺序交换。fixture 用 `sleep((N - i) * 12)` 制造「倒序应答」,相邻分块只差 **12ms** ——
  这不是保证,只是一个赌注。失败的恰好是相邻(余量最小)的那一对,而真正要断言的字节顺序
  **通过了**:产品没问题,是 fixture 在竞争。
- 诚实交代证据边界:**本机复现不出来**,连把所有核心压满也是 0/8 失败。实测本机
  `setTimeout` 偏差最大 2.8ms,对 12ms 间隔有约 4 倍余量,所以顺序不会翻;runner 上的相对
  偏差超过了 12ms。因此「CPU 竞争是触发条件」**未经证实** —— 但机制不需要复现来确认:
  两个独立定时器之间 12ms 的余量本就不是保证,而观测到的相邻交换正是余量被突破的样子。
- 改为用 **promise 链**排序(分块 i 等分块 i+1 应答完才应答),倒序从此是因果保证而非计时
  结果。不是把间隔调大再赌一次 —— 间隔在某台机器上总可能不够。同类教训第三次:
  `redos.test.mjs` 的 CPU 预算测试也是把 wall-clock 当确定量。
- 顺带核查了新写的并发测试有没有同一毛病:栅栏测试是 400ms vs 4ms(100 倍余量,已注明
  不要缩小);「逐字节相同」测试用 6ms 间隔但**不断言完成顺序**,抖动重排后断言依然成立 ——
  倒序只是提高暴露顺序依赖的概率,不承重。

共 298 个测试(281 fast + 17 e2e)全部通过。

## [2.20.0] - 2026-08-05

系统核对了**文档与代码/线上行为的一致性** —— 这是唯一还没扫过的维度:文档里每个可机器验证
的宣称,是否真的成立。查出两处**文档缺陷**(代码本身没问题)。

### Fixed — 文档宣称与实际不符
- **「chunk_size 调到 2000 可处理约 9 万字符」—— 这个数字永远达不到**。两个上限是**串联**的:
  分块预算允许 45 × 2000 = 90000,但 `MAX_INPUT_CHARS` 的校验在分块**之前**,所以 50000 才是
  硬上限。线上实证:50000 字符 @ `chunk_size=2000` 返回音频,50001 返回 400 `input_too_long`。
  调用方按 9 万规划,会在 50001 处撞墙,而 `input_too_long` 与「我按文档调大了 chunk_size」
  毫无关联,排查方向完全错。双语 README 已改为说明哪个上限先撞到,并同时给出两个数字。
- **「单请求 CPU < 1ms」不再成立**。这句写在分块、WAV/WebM 合并、ETag 哈希都还不存在的时候,
  此后没人盯过。实测:`smartChunkText` 单项在 50000 字符时就要 1.58ms;整条最坏合法路径
  (清理 + 分块 + 每块 SSML,50000 字符切 25 块)中位数 **1.96ms**、p95 3.55ms。
  而典型 280 字符请求只要 **0.007ms** —— 所以旧说法对日常流量成立、在上限处不成立,
  而上限恰恰是容量宣称最该覆盖的情形。双语 README 已换成实测数字并指出瓶颈在分块。

### 核对通过、无需改动(全部线上实证)
322 个音色、12 个多语言音色、OpenAI 别名可解析、`speed` 0.25–4 与 `pitch` 0.5–1.5 的边界
均接受、aac/flac 返回 400、preflight 的宽松 CORS、语音列表的 `Cache-Control: public,
max-age=21600`;以及所有代码常量(`MAX_INPUT_CHARS`/`MAX_BODY_BYTES`/`MAX_CHUNKS`/
`MAX_CHUNK_SIZE`/`MODELS_CACHE_SECONDS`)与文档逐一一致,13500 = 45 × 300 的推导也正确。

### 新增测试
- 两个上限的**串联关系**:恰好 MAX_INPUT_CHARS 时成功且真的分了多块;多一个字符时由
  `input_too_long` 拒绝(而不是分块检查)—— 保证错误码指向正确的成因。
- 最坏合法请求的 CPU 必须明显低于平台 10ms 预算(上限设 6ms 留余量)。
- 文档措辞守护:任何提到分块预算乘积的段落,必须在**同一段**里给出真实上限。

### 一处自我更正
文档守护测试的第一版只检查「`MAX_INPUT_CHARS` 是否出现在文件里」—— 它在**回退成旧措辞后
依然通过**,因为 50000 也出现在无关段落。全文件级的 `includes` 什么都证明不了。改为检查
**段落级**的局部性质后,回退措辞会立刻变红(已验证)。

### 测试
287 项(270 fast + 17 e2e)全部通过。

## [2.19.0] - 2026-08-05

用**变异测试**从另一个方向验证测试体系:对 `src/worker.js` 施加 36 个语义变异,看套件能否杀掉。
结果 **35 杀 1 存活**,存活那个经查是等价变异体。同时补测了两个从未量化过的宣称。

### Fixed
- **`timingSafeEqual` 的常数时间性质此前没有任何断言约束**。变异测试发现:把函数体整个换成
  `return a === b` 后套件依然全绿 —— 因为原测试只检查**结果**(相等/不等),而 `===` 完全
  满足。这个函数存在的唯一理由就是抗时序侧信道,而那个性质是裸的。
  时序本身无法可靠断言(测量噪声远大于信号),所以新测试钉的是**结构成因**:比较必须读完
  每个字节,与不匹配出现在第几位无关。用 Proxy 统计字节读取次数,要求「首字节不同」与
  「末字节不同」的读取数相等。实测能杀掉两种真正危险的写法(循环内提前 `break`、
  直接 `return true`)。

### 一处自我更正
我最初把那个存活变异当成测试真空,**这个判断不准确**。它保留了定长循环,所以**依然是常数
时间的**;而 UTF-8 编码是单射,字节相等 <=> 字符串相等,返回值恒同。它是**等价变异体**,
存活是正确的。这条 scope 限制已写进测试注释,免得后人为了「杀掉它」把断言放松。

### Verified — 两个从未量化的宣称
- **README 的「长文本快 4 倍以上」**:此前从未实测。600 字符 / `chunk_size=50`(12 块),
  `concurrency=1` 需 3683ms、`concurrency=10` 需 918ms —— **4.0 倍**,且各并发档位输出
  **逐字节相同**(786240 字节)。双语 README 已把笼统的倍数换成实测数字。
- **并发承载**:对线上连发 10 个合成请求,10/10 成功,484–977ms。

### 变异测试的完整结果
- 36 个变异:35 杀、1 等价体存活。首轮有 4 个因锚点不唯一被跳过(304 短路、created 回到
  `Date.now()`、models 方法检查、SSML 不转义 `<`),用带上下文的唯一锚点补跑后**全部被杀**
  —— 那 4 个「跳过」是我 harness 的局限,不是覆盖缺口。
- 被杀的变异覆盖了本轮之前所有修复:容器合并、Duration 注入、流式容器拒绝、ETag/304、
  ERROR_PARAM、分块上限与下界短路、ReDoS、break 正则、SSML 转义、鉴权四态、降级留痕等。

### 测试
284 项(267 fast + 17 e2e)全部通过。

## [2.18.0] - 2026-08-05

系统审计了此前没专门查过的 **SSML 注入面与 `<break>` 校验**。注入面确认稳固,但 break 校验
过宽,把畸形标签透传给上游、换来一个查错方向的 400。

### Fixed
- **畸形 `<break>` 之前会导致误导性的 400**。break 正则太宽:`time="[^"]*"` 接受 "abc"、
  "-5s",末尾 `/?` 让非自闭合的 `<break time="1s">` 也当标签保留。这三种上游都回 400,
  而调用方看到的却是「voice 不存在」那句(实测 voice 明明合法)—— 因为裸的上游 4xx 会被
  映射成 upstream_rejected_request,那条消息在猜 voice。
  收紧为「必须自闭合 + time 若有则为非负数值 + 可选小数 + 可选 s/ms 单位」,与实测上游接受
  的形态一致。畸形 break 现在落到转义分支变成无害正文,上游接受(200),用户听到字面文本 ——
  远好过一个指错方向的 400。线上验证:三种原本 400 的形态现在都 200,合法 break 照常工作。

### Verified — SSML 注入面稳固,刻意不改
- `</voice>` 闭合注入、伪造 nonce 占位符、用引号截断 break 属性注入、CDATA 逃逸、`&`/`<`/`>`
  实体 —— 逐一实测,全部被转义,`<voice>` 标签数恒为 1。text 走 escape、voice/style/rate/pitch
  走 escapeXmlAttr,两道都在。

### 过程中两处自纠(记录以备后鉴)
- 用 `node -e` 改测试文件时,替换串里的 `# Changelog

` 触发了 String.replace 的模式展开,把文件改烂
  —— 讽刺的是这正是那个测试要防的 bug。改用 `git checkout` 恢复 + Edit 精确替换。
- 我最初把输出里的 `# Changelog

amp;` 当成错误,实际 `&` 转义成实体是**正确**的 SSML 行为,是我的
  断言写错了。再次印证:测试失败时先分清「代码错」还是「断言错」。

### 测试
- 改造了 ` 替换模式测试(载体从非法的 time="# Changelog

" 换到正文,保留原意),新增「哪些 break
  形态保留 vs 转义」的用例。回退到宽松正则会让 3 条变红。
- 283 项(266 fast + 17 e2e)全部通过。`src/worker.js` 覆盖率 **99.49% 行 / 98.21% 分支**。

## [2.17.0] - 2026-08-05

从 ROADMAP 的 P1-3(前端 API key 存储)入手,顺带**找到了折腾我好几轮的间歇性 e2e 失败的另一半根因**。

### Security
- **Vue 固定版本 + SRI**。此前是 `unpkg.com/vue@3` —— 浮动大版本、无完整性校验,而 unpkg
  对那个重定向只缓存 60s,所以页面会静默采用新发布的任意 Vue(实测当时解析到 3.5.40)。
  这个脚本**能读到 UI 明文存在 localStorage 里的 API key**,CDN 一旦被污染 key 就随之泄漏。
  现固定到 3.5.40 + sha384 integrity + crossorigin(SRI 生效的前置要求)+ referrerpolicy,
  升级命令写在旁边的注释里。线上实测:SRI 生效且页面正常(322 音色全部渲染)。
  顺带核实 UI 自身 XSS 面:`v-html` / `innerHTML=` / `eval` 各为 0。

### Fixed — 间歇性 e2e 失败的另一半根因
- **浏览器测试此前隐含依赖外网**。UI 用 `<script src="https://unpkg.com/...">` 加载 Vue,
  于是每个浏览器测试都要求**浏览器**能连上 unpkg。连不上时 `page.goto` 在
  readyState=complete 上超时(报 "page load timeout"),或者页面起来了但 `window.Vue`
  不存在、DOM 里 0 个 `.voice-item` —— 症状读起来就是「应用坏了」。
  实测同一时刻:node 侧 `curl` unpkg 三次都是 200,而 headless Chrome 完全取不到。
  我此前把这个 flake 归因于泄漏的 Chrome 进程。**那个泄漏是真的、也该修**,但它只是一半;
  这是另一半 —— 同一个症状有两个独立成因,只修一个就会继续偶发。
  harness 现在从 `test/.cache/` 本地供给 Vue(首次联网时下载,已 gitignore),并把 CDN 标签
  重写成 `/vendor/` 本地路由;重写一旦没生效就**直接抛错**,静默漏掉等于悄悄恢复外网依赖。

### 记录两处我自己的错判
- 我先从「Vue 没加载」推出「SRI 阻止了合法脚本」并写进了输出。**去掉 SRI 后同样加载不出来**
  —— 一个对照实验就能否掉的结论,我却先下了判断。
- 重写用的正则从任意 `<script` 起匹配,于是撞上页面里别的 script 标签、把中间大段内容一起
  吞掉;它还被我自己写在注释里的那条 unpkg 示例 URL 干扰。已收窄到
  `<script src="https://unpkg.com`,注释里的 URL 改成 `<CDN>` 占位。

### 测试
- 新增 BUG#11(线上 Vue 必须固定版本 + 带 SRI)与 BUG#11b(harness 必须本地供给 Vue,
  且 `/vendor/` 路由真的返回可用的 Vue bundle)。
- 282 项(265 fast + 17 e2e)全部通过。

## [2.16.0] - 2026-08-05

补完最后一个从未审过的角度:error-and-observability(它的 agent 连续三轮都因凭证失败挂掉)。
两个发现,另有三项**确认已正确**、刻意不动。

### Added
- **`error.param` 现在指出出错的字段**。响应结构一直带 `param`(OpenAI 用它标明哪个参数
  出错),但 26 个错误出口全都硬写 `null`。这在本项目里尤其要紧,因为**有两个 code 各服务
  两种不同原因**:`invalid_request_error` 既是「body 不是 JSON」也是「input 字段缺失」,
  `invalid_cleaning_options` 既是「容器类型错」也是「custom_keywords 类型错」——
  调用方只看 code 分辨不出该改哪个字段。
  改 code 会破坏既有调用方(测试也钉着它们),所以补 `param`:**纯新增**,老调用方读不到就
  当没有。不明确的用一处 code→param 映射覆盖(26 个调用点一行不动),三个歧义点显式传参 ——
  按 code 查的映射当然分不清 code 本身分不清的东西。
  线上实测:body 非 JSON → `body`,input 缺失 → `input`,容器类型错 → `cleaning_options`,
  嵌套字段错 → `cleaning_options.custom_keywords`。无字段可归因的(如 `not_found`)保持
  `null`,而不是硬造一个。

### Fixed
- **分块失败此前无法归因到具体分块**。并发重试时日志里「分块合成第 2 次失败」会出现两次,
  看起来像计数 bug,实际是两个不同分块各自的第二次尝试。运维因此分不清「某一块反复失败」
  (那段文本有问题)和「所有块都在失败」(上游整体限流)—— 这两种情况的处置完全不同。
  日志现在带 `#序号/总数` 与上游输出格式。

### 确认已正确、刻意不动
- 21 个错误 code **各自只对应一个状态码**,无冲突。
- **六条降级路径全部留痕**(过期语音缓存、兜底列表、过期 token、WAV 合并降级、WebM 合并降级、
  匿名模式)。写成**一条**测试统一断言,这样将来新增的静默降级会直接让它变红。
- 唯一没有日志的 catch 是「body 不是合法 JSON」,它返回 400 —— 那是调用方的错误,
  不是需要留痕的降级。

### 测试
- 两处共享 helper 此前断言 `param === null`,钉的是**旧占位值而非契约**;现在改为断言形状
  (null 或非空字符串),具体值交给 error-disclosure.test.mjs。一处流式测试钉了旧的重试日志
  原文,已更新为带分块序号的格式。
- 变异验证:把 param 改回恒 null 会让 **5** 条测试变红,去掉分块标签会让 **3** 条变红。
- 280 项(263 fast + 17 e2e)全部通过。`src/worker.js` 覆盖率 **99.49% 行 / 98.21% 分支**(新高)。

## [2.15.0] - 2026-08-05

补跑了此前两轮都因 agent 凭证失败而**从未审过**的 ui-robustness 角度，找到两个真缺陷。
两者同属一类:**数据没问题，但界面不可用** —— 而且症状都极具误导性。

### Fixed
- **畸形 localStorage 会让音色列表整块消失**。合并用的是
  `{ ...this.form, ...JSON.parse(saved) }` 浅展开，于是存储里的 `cleaning: null` **整体
  替换**掉嵌套默认值。模板读 `form.cleaning.removeMarkdown`，对 null 取属性会抛，Vue 随即
  放弃**整个** render pass。实测症状:`filteredVoices` 明明返回 4 条、`.voice-list` 容器也在，
  但 DOM 里 0 个 `.voice-item` —— 数据是好的、渲染死了。这正是两轮前审计报的
  「音色列表整块静默消失」。`inputText: null` 同理。
  只 catch `JSON.parse` 从来不够:**解析成功的垃圾同样能让页面不可用**，而 localStorage
  是不可信输入(旧版本写的形状、用户手改、扩展写脏)。
  `mergeSavedForm` 现在逐字段按类型取值、数字字段挡住 NaN/Infinity、`cleaning` 逐键合并
  （一个坏字段不会丢掉整个对象）。17 种畸形值实测:修复前 2 种让应用不可用，修复后 0 种。
- **音色选择器完全无法用键盘操作**。条目是纯 `<div>` + `@click`，实测 0/4 可聚焦、无 role、
  无 aria-label —— 键盘与读屏用户做不了这个应用**最核心的交互**。现在是
  `role=radiogroup` / `role=radio` + `aria-checked` + `aria-label` + roving tabindex
  （恰好一个条目在 tab 序列里），Enter/空格/方向键/Home/End 按 WAI-ARIA 的 radiogroup 模式。
  处理器不认识的键会放行，否则搜索框就没法打字了。另加 `:focus-visible` 焦点环
  （用 `--primary-color` 跟随主题）—— 焦点看不见和没有焦点差不多。
  线上实测:322 个音色全部可键盘到达，ArrowDown 生效，tabindex=0 恰好 1 个。

### 查过但**刻意不改**的(附实测理由，避免下一轮重报)
- 主题切换与全部 5 个复制按钮**已有**标签(实测 5/5)。
- 音色搜索用 `.includes()` 而非 `RegExp`，正则元字符天然是字面量，不会抛也不会误匹配。
- 请求的 `Content-Type` 不校验是**故意**的:body 是合法 JSON 就能工作，不是 JSON 已由
  `JSON.parse` 拒成 400。强制校验只会拒掉本可服务的请求，与「开放访问」的取向冲突。
- 重复 `Authorization` 头返回的 400 来自 **Cloudflare 边缘**(HTML body、Worker 还没跑)，
  不是我们的代码。
- 缺 `Accept-Ranges` 与本项目无关:`<audio>` 播的是 `blob:` URL，拖动不走网络 ——
  wav/mp3/opus 的拖动准确性此前都已实测。

### 测试
275 项(258 fast + 17 e2e)全部通过。`src/worker.js` 覆盖率 **99.47% 行 / 98.19% 分支**。
两条新 e2e 都验证过能在旧代码上变红。

## [2.14.0] - 2026-08-05

本轮最有价值的产出不是新功能，而是**定位到一个我自己造成的、追了五轮的假故障**。

### Added
- **合并后的 opus 带上顶层 `Duration`**。此前 Segment 是 UNKNOWN-size 且上游不声明时长，
  `<audio>.duration` 在 `loadedmetadata` 时是 `null` —— 原生进度条一片空白，要等用户拖过
  末尾浏览器才解析出时长。注入代价 **11 字节 / 0.18ms**，实测 Chrome 里 duration 与 seekable
  在 `loadedmetadata` 时就是 28.35（此前 null），直接拖到 20s 落在 20.00，ffprobe 从 N/A
  变成 28.350000 且零告警。线上 4 分块请求实测 `duration = 191.7`，拖到 150s 落在 150.00。

  之前有审计说这是「11 字节、0.25ms」，但漏了最关键的一步：**Info 的 size 是已知长度**，
  加字节必须改写它。之所以仍然便宜，是因为上游把所有 size 都编成 8 字节 vint
  （实测 `01 00 00 00 00 00 00 56` = 86），可表示到 2^56-1，86 → 97 只改值字节、
  编码宽度不变，后续字节一个都不用移动。换成别的编码宽度就放弃注入而不是冒险改写 ——
  用手工构造的 1 字节 size fixture 做了断言。

### Performance
- **语音列表变得可复用**。此前 `Cache-Control: public, max-age=21600` 但没有任何 validator，
  而且 `created` 用的是 `Date.now()`：线上连打三次都没有 `cf-cache-status`，两次的 created
  分别是 ...556724 和 ...519071。322 条每条都变 → 响应体逐字节不同 → 下游无从复用。
  （Brotli 本来就由 CF 加，压缩不是缺口。）
  `created` 改为固定值（OpenAI 语义是「模型创建时间」而非「响应构造时间」），两个端点都给
  弱 ETag 并支持 `If-None-Match` → 304。线上实测：带 validator 下载 **0 字节**，不带 50407 字节。
  ETag 在**过滤之后**计算：`?multilingual=true` 与不带参数是两个不同的表示，共用 validator
  会让条件请求拿到 304 并复用错内容 —— 那是正确性 bug，不只是缓存未命中。方法检查也必须在
  条件请求检查之前，否则带 `If-None-Match` 的 PUT 会得到 304 而不是 405。两条都有断言。

### Fixed — 一个我自己造成的假故障
之前有条 e2e 约三次一失败，报「没有 buffer 被排入」，看起来像截断回归。我为此排除了五个假设
（导航模式 4 变体、冷启动、`closeAllConnections` 开关、导航打断 fetch —— 后者报的是
AbortError 而非 "Failed to fetch"），全部不成立，最后加了重试凑过去。

真正的原因是**我的探针脚本泄漏了 248 个 headless Chrome**：用 `timeout` 掐掉脚本时，
`finally { chrome.close() }` 根本没机会跑。这些进程抢端口与 CPU，导致 `page.goto` 超时、
fetch 偶发失败。这也解释了为什么「单独跑就好、全量跑才偶发」（泄漏要累积）以及为什么所有
文件内部的假设都排除不出来 —— 问题在**测试环境**，不在被测代码。

清掉泄漏后连跑两次全量皆 0 失败，于是**撤掉了那个重试** —— 留着它会掩盖将来真正的失败。
`launchChrome()` 现在在残留超过 20 个时警告一次并给出清理命令；它**不自动杀进程**，
误杀用户自己的浏览器比留个警告糟得多（把阈值临时降到 0 验证过警告路径真的会打印）。

### Changed
- `npm test` 拆成 `test:fast`（unit/integration/regression，并行）+ `test:e2e`（串行）。
  e2e 要驱动真实 Chrome 与多个 HTTP server，与另外 8 个测试文件并行时会因资源竞争出现
  `page load timeout`：实测全并行 27 失败，`--test-concurrency=1` 则 0 失败。
  CONTRIBUTING 补了这条以及「先查残留 Chrome」的排查步骤。

### 测试
273 项（258 fast + 15 e2e），全部通过。`src/worker.js` 覆盖率 **99.47% 行 / 98.19% 分支**。

## [2.13.0] - 2026-08-05

第二轮审计的剩余发现，全部先复现再修。主题是**「看起来成功」比失败更危险**。

### Fixed — 又一处静默截断
- **流式的多分块 wav/opus 之前完全绕过合并**。上一轮只改了 `getVoice`，而 `streamVoice` 是
  边收边写。线上实测 901 字符（4 块）的流式 wav：文件含 191.67s，首个 RIFF 头只声明 61.46s
  —— 播放器在 **32%** 处停止，响应却是 200 + 合法 WAV。流式无从事后回填长度或合并容器，
  因此在发头之前返回 400 `stream_format_not_chunkable` 并指向 pcm。mp3/pcm 不受影响。
- **0 字节的 200 被报成成功**。CF 在头发出后掐掉 isolate 时，客户端看到的是 200 + 干净的
  chunked EOF —— 与完整响应的收尾字节完全相同，且无 Content-Length 可核对。UI 此前无条件
  显示「✅ PCM完成！0KB, 约0.0秒」并给出下载按钮，用户会以为合成成功、只是音频莫名很短。
  两条流式路径现在都拒绝空响应，并说明可能原因与两条出路。

### Fixed — 三个「假的控制权」
- **流式根本无法停止**。`playStreamPCM` 把整段音频一次排到 AudioContext 时间轴上就 resolve，
  于是 `isLoading` 立刻变 false 而 34 个 source 仍在排队；组件上唯一带 stop 字样的方法是
  `stopViz`（只管画布）。更糟的是 `<audio controls>` 的原生暂停键**看得见但对流式无效** ——
  它驱动的是另一条路径。新增 `stopAllPlayback()` 作为唯一收尾入口，并加了绑定到新状态
  `isPlaying`（跟踪**实际播放**，而 `isLoading` 只表示请求中）的停止按钮。
- **播放中再次生成会两路同时出声**：实测 31 个流式 source 仍在响、`<audio>` 同时播标准结果。
- **`<audio>` 的 pause/ended 会关掉仍在播的流式声纹**：那两个事件只代表标准播放那条路结束了，
  而流式音频由 AudioContext 驱动、与该元素无关。实测 32 个 source 还在播、声纹已经是 false。
  现在只有确实没有音频在播时才收尾。
- 失败路径此前只调 `stopViz()`，把 `isPlaying` 留在 true —— 停止按钮赖在界面上却已无音频可停。

### Fixed — 参数类型的静默行为改变
- **`stream` 曾是真值判断**：`stream: "false"` 会进流式，与字面意思相反；`"no"`、`1`、`{}`、
  `[]` 同理。与 wav/opus 叠加时那正是上面静默截断的入口。现在必须是布尔，并报出收到的类型。
- **`cleaning_options` 被无条件展开**：传字符串会得到 `{0:r,1:e,...}`，于是所有清理选项
  静默退回默认值 —— 调用方传 `"remove_markdown"` 想关掉它，结果恰好相反且毫无提示。
- **上游 4xx 曾报成 500**。voice 形状合法但上游没有这个音色是最常见的情形，报 500 会让调用方
  去查我们的服务状态，而该做的是换音色。现在映射为 400 `upstream_rejected_request` 并指向
  `/v1/models`；上游 5xx 仍是 500（两个方向都有断言）。上游原文依旧只进日志。
- **`/v1/models` 对 PUT/DELETE/PATCH 返回 200 + 完整列表**，调用方会以为写操作成功了。现在
  405 + `Allow` 头（RFC 9110 要求）；语音合成端点的既有 405 也补上了 Allow。

### 一个我自己引入又自己抓到的回归
把 `stopAllPlayback()` 放在了 `startViz()` **之后**，而它会强制 `stopViz()`，于是刚领到的
这一代声纹立刻被掐掉 —— 音频正常播（4 个 source）而 `vizActive` 一直 false。清理必须发生在
**建立新状态之前**。抓到它靠的是既有那条「声纹必须响应真实音频」的 e2e。

### 测试
- 新增流式容器 5 例、停止控制 3 例、0 字节响应 1 例、参数类型与只读端点 8 例。
- e2e harness 新增 `emptyStream` 选项：这个故障只存在于协议层，返回一个短 body 造不出来。
- 「完整时长」那条 e2e 加了一次重试：它驱动真实 fetch 打本地 stub，在同文件其他测试各自起停
  server 之后会偶发失败，表现为「没有 buffer 被排入」，看起来像截断回归。重试把「环境把请求
  丢了」与「应用真的截断了」分开；连续两次失败仍然算失败。
- 275 项（266 通过 / 9 跳过）+ 15 项浏览器 e2e，全部通过。
  `src/worker.js` 覆盖率 **99.43% 行 / 98.59% 分支**。

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
