// workers.js
var DEFAULT_CONCURRENCY = 10;
var DEFAULT_CHUNK_SIZE = 300;

// 站点图标：docs/logo.svg 的精简版（去掉播放键、加粗声波），16px 下仍可辨识。
var FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
  '<stop offset="0%" stop-color="#6ee7b7"/><stop offset="55%" stop-color="#38bdf8"/>' +
  '<stop offset="100%" stop-color="#4f46e5"/></linearGradient></defs>' +
  '<rect width="512" height="512" rx="96" fill="url(#g)"/><g fill="#fff">' +
  '<rect x="104" y="206" width="44" height="100" rx="22" opacity="0.75"/>' +
  '<rect x="172" y="146" width="44" height="220" rx="22" opacity="0.9"/>' +
  '<rect x="240" y="86"  width="44" height="340" rx="22"/>' +
  '<rect x="308" y="156" width="44" height="200" rx="22" opacity="0.9"/>' +
  '<rect x="376" y="216" width="44" height="80"  rx="22" opacity="0.75"/>' +
  '</g></svg>';

// All tunable bounds live here rather than as magic numbers at the call sites.
var LIMITS = {
  MAX_INPUT_CHARS: 50000,
  // 50000 字符最坏情况(全 4 字节 UTF-8)约 200KB，留出 cleaning_options 等字段的余量
  MAX_BODY_BYTES: 262144,   // 256 KB
  MIN_SPEED: 0.25,
  MAX_SPEED: 4,
  MIN_PITCH: 0.5,
  MAX_PITCH: 1.5,
  MIN_CONCURRENCY: 1,
  MAX_CONCURRENCY: 20,
  MIN_CHUNK_SIZE: 50,
  MAX_CHUNK_SIZE: 2000,
  // 真正的硬约束是**分块数**，不是字符数：每个分块一次上游 subrequest，而 Workers 单次
  // 调用的 subrequest 上限是 50。默认 chunk_size=300 时，50000 字符要 167 个 subrequest，
  // 必然超限。线上实测（2026-08-04）：chunk_size=50 时 50 块还能过、51 块就 500；默认
  // 参数下约 6000 字符起就开始间歇性 503（CF error 1102），15000 字符稳定失败。
  //
  // 留 5 个余量给 token 端点与语音列表等非合成请求。超限时必须在**发出响应头之前**拒绝：
  // 流式路径一旦发过头，CF 掐掉 isolate 后客户端只会看到 200 + 干净 EOF 的短音频，
  // 与成功完全无法区分（实测截断响应与完整响应的结尾字节都是 0\r\n\r\n）。
  MAX_CHUNKS: 45,
};

// Microsoft voice names look like "zh-CN-XiaoxiaoNeural" or "zh-CN-liaoning-XiaobeiNeural".
// Anything outside this shape is rejected rather than escaped, because it is interpolated
// into an SSML attribute and there is no legitimate reason for other characters.
// Bounds verified against the live voice list (322 voices, 3-4 segments, longest 27 chars).
var VOICE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,40}){1,4}$/;
var STYLE_RE = /^[a-z][a-z0-9-]{0,30}$/;
var OPENAI_VOICE_MAP = {
  "shimmer": "zh-CN-XiaoxiaoNeural",
  // 温柔女声 -> 晓晓
  "alloy": "zh-CN-YunyangNeural",
  // 专业男声 -> 云扬  
  "fable": "zh-CN-YunjianNeural",
  // 激情男声 -> 云健
  "onyx": "zh-CN-XiaoyiNeural",
  // 活泼女声 -> 晓伊
  "nova": "zh-CN-YunxiNeural",
  // 阳光男声 -> 云希
  "echo": "zh-CN-liaoning-XiaobeiNeural"
  // 东北女声 -> 晓北
};
// ------------------------------------------------------------------ 结构化日志
//
// 为什么需要：审计发现 18 个日志点里 17 个只在**异常路径**，唯一那条正常路径日志记的是
// token 有效期 —— 于是一个成功的 200 请求不产生任何日志。后果是 5xx 率 / p99 / 重试率
// 都**没有分母**（只有出错才留痕，算不出「率」），「哪些音色真的被用」也答不出来。
// 本周修掉的几个 bug（分批栅栏白扔 2.5× 延迟、Deploy 三天没通、UI 数值贴到隔壁列）
// 都是「没人在看」才活下来的，缺的不是告警规则，是可被聚合的正常路径数据。
//
// 为什么是**每请求一个对象**、而不是模块级的「当前请求」变量：Workers 的单个 isolate
// 会并发处理多个请求，并在每个 await 处交错。实测同一模型下 3 个并发请求（延迟
// 30/5/15ms）用模块级变量记日志，三条全部记成最后一个开始的那个请求 —— 字段会串到
// 别的请求上，而这种错误在日志里是看不出来的。所以 ctx 必须显式穿过调用链。
//
// 成本：JSON.stringify 一个 9 字段对象实测中位 0.00021ms，占最坏合法请求纯 CPU
// （1.867ms 中位）的 0.011%。收集字段本身只是几个整数自增。
//
// 刻意**不记**的东西：input 文本（用户内容，连哈希也不记）、API key、上游返回体。
// 只记可聚合的维度与计数。
function newLogCtx(route) {
  return { route, t0: Date.now(), retries: 0, upstreamCalls: 0, degraded: null };
}

/**
 * 一条请求一行 JSON。level 用 log/warn/error 以便按严重度过滤。
 *
 * 错误码怎么拿到：错误响应的 body 里已经有 `code`，但 body 是流、读一次就消耗掉，
 * 不能直接读要返回给调用方的那个 Response。所以只对 **>=400** 的响应 `clone()` 后读
 * —— 错误体是几百字节的 JSON，克隆代价可忽略；成功响应可能是几 MB 音频，绝不克隆。
 * 另一条路是加 `x-error-code` 响应头，但那会把内部错误码暴露给公网（本项目刻意只在
 * body 里给 code），且响应头参与缓存键，所以不走那条。
 */
async function emitLog(ctx, res, extra) {
  if (!ctx) return;
  const status = res ? res.status : (extra && extra.status);
  let code;
  if (res && status >= 400) {
    try {
      const body = await res.clone().json();
      code = body && body.error && body.error.code;
    } catch {
      // 错误体不是 JSON（不该发生），但日志绝不能因此让请求失败。
      code = "unparseable_error_body";
    }
  }
  // 请求维度（voice/format/chunks/...）只在通过全部校验后才被设上，所以这里用「有就带、
  // 没有就省」—— 一个 400 请求的 voice 维度没有意义，硬塞 null 只会污染聚合。
  const line = JSON.stringify({
    ev: "req",
    route: ctx.route,
    status,
    ms: Date.now() - ctx.t0,
    upstream: ctx.upstreamCalls,
    retries: ctx.retries,
    ...(ctx.voice ? { voice: ctx.voice } : {}),
    ...(ctx.format ? { format: ctx.format } : {}),
    ...(ctx.chunks !== undefined ? { chunks: ctx.chunks } : {}),
    ...(ctx.concurrency !== undefined ? { conc: ctx.concurrency } : {}),
    ...(ctx.stream !== undefined ? { stream: ctx.stream } : {}),
    ...(ctx.inputChars !== undefined ? { chars: ctx.inputChars } : {}),
    ...(ctx.bytes !== undefined ? { bytes: ctx.bytes } : {}),
    ...(code ? { code } : {}),
    ...(ctx.degraded ? { degraded: ctx.degraded } : {}),
    ...extra
  });
  // 5xx 用 error、4xx 用 warn，其余 log —— Workers 日志面板按 level 过滤，
  // 这样「5xx 率」不必解析 JSON 就能先粗筛。
  if (status >= 500) console.error(line);
  else if (status >= 400) console.warn(line);
  else console.log(line);
}

var workers_default = {
  async fetch(request, env, ctx) {
    return await handleRequest(request, env);
  }
};
async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return handleOptions(request);
  const url = new URL(request.url);
  if (url.pathname === "/v1/models/public") return await handlePublicModelsRequest(request);
  // favicon 必须在鉴权之前短路：否则浏览器自动发起的 /favicon.ico 会命中鉴权分支
  // 返回 401，在 devtools 里留下一条无意义的错误。直接返回内嵌的 logo。
  if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
    return new Response(FAVICON_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=604800",
        ...makeCORSHeaders()
      }
    });
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(getHtmlContent(), {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        // 5 分钟 + must-revalidate：部署后几分钟内自然生效，不必强刷。
        // 之前是 max-age=86400（1 天），每次发版都得让用户手动硬刷才能看到新版。
        "Cache-Control": "public, max-age=300, must-revalidate"
      }
    });
  }
  // Auth is mandatory unless explicitly opted out. Previously this was `if (env.API_KEY)`,
  // which meant a missing binding silently downgraded the API to fully public — the
  // "no key configured" and "key verified" paths were indistinguishable.
  if (!env.API_KEY) {
    if (env.ALLOW_ANONYMOUS !== "true") {
      console.error("API_KEY 未绑定且未设置 ALLOW_ANONYMOUS=true，拒绝请求");
      return errorResponse(
        "服务端未配置 API_KEY。请绑定 API_KEY secret，或显式设置 ALLOW_ANONYMOUS=true 以开放访问。",
        503,
        "server_misconfigured"
      );
    }
    console.warn("以匿名模式运行（ALLOW_ANONYMOUS=true），接口无鉴权");
  } else {
    const authHeader = request.headers.get("authorization") || "";
    const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!timingSafeEqual(presented, env.API_KEY)) {
      return errorResponse("无效的 API 密钥", 401, "invalid_api_key");
    }
  }
  // 在这里(而不是每个 return 处)埋日志：handleSpeechRequest 有 20 个出口，逐个包裹既
  // 冗长又必然漏掉新增的那个。这里是唯一的漏斗，所有响应都要经过。
  const logCtx = newLogCtx(url.pathname);
  try {
    if (url.pathname === "/v1/audio/speech") {
      const res = await handleSpeechRequest(request, logCtx);
      // 流式已自行安排在流结束时记录（见 streamVoice），这里再记一次只会得到一条
      // upstream=0 的假数据。
      if (!logCtx.streamLogged) await emitLog(logCtx, res);
      return res;
    }
    if (url.pathname === "/v1/models") {
      const res = await handleModelsRequest(request);
      await emitLog(logCtx, res);
      return res;
    }
  } catch (err) {
    // 同上：内部错误细节只进日志。err.message 可能是运行时抛出的原始信息
    // (依赖内部路径、变量名等)，不该出现在面向公网的响应里。
    console.error("请求处理器错误:", err);
    const res = errorResponse("服务器内部错误", 500, "internal_server_error");
    await emitLog(logCtx, res);
    return res;
  }
  const notFound = errorResponse("未找到", 404, "not_found");
  await emitLog(logCtx, notFound);
  return notFound;
}
// Constant-time compare so a wrong key can't be recovered byte-by-byte from latency.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  // Length is not secret, but keep the loop length fixed regardless of mismatch.
  let diff = ba.length ^ bb.length;
  const max = Math.max(ba.length, bb.length);
  for (let i = 0; i < max; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function handleOptions(request) {
  // headers.get() yields null when the header is absent, and a default parameter only
  // kicks in for undefined — passing null straight through emitted the literal
  // "Access-Control-Allow-Headers: null", so a preflight that didn't advertise its
  // headers was never told Content-Type/Authorization are allowed.
  const requested = request.headers.get("Access-Control-Request-Headers") ?? undefined;
  return new Response(null, { status: 204, headers: makeCORSHeaders(requested) });
}
async function handleSpeechRequest(request, logCtx = null) {
  if (request.method !== "POST") {
    return errorResponse("不允许的方法", 405, "method_not_allowed", "api_error", {
      "Allow": "POST, OPTIONS"
    });
  }
  // 先看 Content-Length 再读 body：await request.json() 会把整个 body 收进内存后
  // 才轮到下面的 input 长度校验，等于「先受伤再检查」。一个 input 合法、但塞了
  // 巨大 cleaning_options 的请求可以绕过 MAX_INPUT_CHARS 白吃内存。
  const declaredLen = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > LIMITS.MAX_BODY_BYTES) {
    return errorResponse(
      `请求体过大：${declaredLen} > ${LIMITS.MAX_BODY_BYTES} 字节`,
      413,
      "payload_too_large"
    );
  }
  let requestBody;
  try {
    // 读成文本先量实际字节数：Content-Length 在 chunked 传输下可能缺失，
    // 光靠声明值会被绕过。
    const raw = await request.text();
    const actualBytes = new TextEncoder().encode(raw).length;
    if (actualBytes > LIMITS.MAX_BODY_BYTES) {
      return errorResponse(
        `请求体过大：${actualBytes} > ${LIMITS.MAX_BODY_BYTES} 字节`,
        413,
        "payload_too_large"
      );
    }
    requestBody = JSON.parse(raw);
  } catch {
    // param 指向整个 body,而不是某个字段 —— 与下面「input 字段缺失」区分开。
    return errorResponse("请求体不是合法 JSON", 400, "invalid_request_error", "api_error", null, "body");
  }
  if (typeof requestBody?.input !== "string" || !requestBody.input.trim()) {
    return errorResponse(
      "'input' 是必需参数，且必须为非空字符串",
      400,
      "invalid_request_error",
      "api_error",
      null,
      "input"
    );
  }
  if (requestBody.input.length > LIMITS.MAX_INPUT_CHARS) {
    return errorResponse(
      `'input' 超出长度上限：${requestBody.input.length} > ${LIMITS.MAX_INPUT_CHARS}`,
      400,
      "input_too_long"
    );
  }
  const {
    model = "tts-1",
    // 模型名称
    input,
    // 输入文本
    voice = "shimmer",
    // 语音
    speed = 1,
    // 语速 (0.25-2.0)
    pitch = 1,
    // 音调 (0.5-1.5)
    style = "general",
    // 语音风格
    stream = false,
    // 是否流式输出
    response_format = "mp3",
    // 输出格式: mp3 | pcm | opus | aac | flac | wav
    concurrency = DEFAULT_CONCURRENCY,
    // 并发数
    chunk_size = DEFAULT_CHUNK_SIZE,
    // 分块大小
    cleaning_options = {}
    // 文本清理选项
  } = requestBody;
  // stream 只接受布尔。之前是真值判断，于是 stream: "false" / "no" / [] 全都进流式 ——
  // 字符串 "false" 得到的行为与字面意思相反，而与 wav/opus 叠加时那正是静默截断的入口。
  if (stream !== undefined && typeof stream !== "boolean") {
    return errorResponse(
      `'stream' 必须是布尔值，收到 ${typeof stream}` +
        (typeof stream === "string" ? `（${JSON.stringify(stream)}）` : "") +
        "。JSON 里请写 true / false，不要加引号。",
      400,
      "invalid_stream"
    );
  }
  // 修:cleaning_options 必须是对象。传字符串/数组/数字时展开成 {...'abc'} 得到的是
  // {0:"a",1:"b",...}，于是所有清理选项静默退回默认值，调用方以为自己关掉了某项。
  if (
    cleaning_options !== undefined &&
    (typeof cleaning_options !== "object" || cleaning_options === null || Array.isArray(cleaning_options))
  ) {
    return errorResponse(
      `'cleaning_options' 必须是对象，收到 ${Array.isArray(cleaning_options) ? "array" : typeof cleaning_options}。` +
        "例如 {\"remove_markdown\": false}。",
      400,
      "invalid_cleaning_options"
    );
  }
  const finalCleaningOptions = {
    remove_markdown: true,
    // 移除 Markdown
    remove_emoji: true,
    // 移除 Emoji
    remove_urls: true,
    // 移除 URL
    remove_line_breaks: true,
    // 移除换行符
    remove_citation_numbers: true,
    // 移除引用数字
    custom_keywords: "",
    // 自定义关键词
    ...cleaning_options
  };
  // custom_keywords 会被 .split(",") —— 传数字/数组/对象时那个方法不存在，异常冒到最外层
  // 的 catch，调用方收到 500 internal_server_error。这是调用方的输入错误，必须是 400，
  // 而且要说清收到的是什么类型，否则对方只能猜。
  if (
    finalCleaningOptions.custom_keywords !== undefined &&
    typeof finalCleaningOptions.custom_keywords !== "string"
  ) {
    return errorResponse(
      `cleaning_options.custom_keywords 必须是逗号分隔的字符串，收到 ${typeof finalCleaningOptions.custom_keywords}`,
      400,
      "invalid_cleaning_options",
      "api_error",
      null,
      "cleaning_options.custom_keywords"
    );
  }
  const cleanedInput = cleanText(input, finalCleaningOptions);
  if (!cleanedInput) {
    return errorResponse("文本清理后为空，请检查 cleaning_options", 400, "input_empty_after_cleaning");
  }

  // Resolve the voice with explicit intent winning over inference:
  //   1. `voice` that is already a real Microsoft name  -> use as-is
  //   2. `voice` that is an OpenAI alias ("shimmer", …) -> map it
  //   3. otherwise fall back to an alias derived from `model` ("tts-1-alloy")
  // Ordering matters: resolving the alias map first let `model` silently hijack an
  // explicitly requested voice (e.g. voice=en-US-AvaNeural + model=tts-1-nova
  // synthesized Chinese), and made the model-derived branch unreachable because
  // `voice` defaults to the alias "shimmer".
  const modelAlias = typeof model === "string" ? OPENAI_VOICE_MAP[model.replace("tts-1-", "")] : undefined;
  const finalVoice =
    (typeof voice === "string" && VOICE_RE.test(voice) && voice) ||
    OPENAI_VOICE_MAP[voice] ||
    modelAlias ||
    voice;
  if (typeof finalVoice !== "string" || !VOICE_RE.test(finalVoice)) {
    return errorResponse(
      `无效的语音名称：${JSON.stringify(finalVoice)}。应形如 "zh-CN-XiaoxiaoNeural"`,
      400,
      "invalid_voice"
    );
  }
  if (typeof style !== "string" || !STYLE_RE.test(style)) {
    return errorResponse(
      `无效的 style：${JSON.stringify(style)}。仅允许小写字母、数字与连字符`,
      400,
      "invalid_style"
    );
  }

  const speedNum = Number(speed);
  const pitchNum = Number(pitch);
  if (!Number.isFinite(speedNum) || speedNum < LIMITS.MIN_SPEED || speedNum > LIMITS.MAX_SPEED) {
    return errorResponse(
      `speed 超出范围：${speed}，允许 ${LIMITS.MIN_SPEED}–${LIMITS.MAX_SPEED}`,
      400,
      "invalid_speed"
    );
  }
  if (!Number.isFinite(pitchNum) || pitchNum < LIMITS.MIN_PITCH || pitchNum > LIMITS.MAX_PITCH) {
    return errorResponse(
      `pitch 超出范围：${pitch}，允许 ${LIMITS.MIN_PITCH}–${LIMITS.MAX_PITCH}`,
      400,
      "invalid_pitch"
    );
  }

  const rate = ((speedNum - 1) * 100).toFixed(0);
  const finalPitch = ((pitchNum - 1) * 100).toFixed(0);
  const safeConcurrency = clamp(concurrency, LIMITS.MIN_CONCURRENCY, LIMITS.MAX_CONCURRENCY, DEFAULT_CONCURRENCY);
  const safeChunkSize = clamp(chunk_size, LIMITS.MIN_CHUNK_SIZE, LIMITS.MAX_CHUNK_SIZE, DEFAULT_CHUNK_SIZE);
  // Only formats the cognitiveservices/v1 endpoint actually accepts. aac and flac
  // (every bitrate variant) return a bare 400 from upstream, so they are not offered —
  // listing them would surface as an opaque "tts_generation_error" instead of a clear
  // 400 here. Verified against the live endpoint on 2026-08-03.
  const FORMAT_MAP = {
    "mp3": "audio-24khz-48kbitrate-mono-mp3",
    "pcm": "raw-24khz-16bit-mono-pcm",
    "opus": "webm-24khz-16bit-mono-opus",
    "wav": "riff-24khz-16bit-mono-pcm"
  };
  if (!Object.hasOwn(FORMAT_MAP, response_format)) {
    return errorResponse(
      `不支持的 response_format：${JSON.stringify(response_format)}。可选 ${Object.keys(FORMAT_MAP).join(" | ")}`,
      400,
      "invalid_response_format"
    );
  }
  const outputFormat = FORMAT_MAP[response_format];
  const CONTENT_TYPE_MAP = {
    "mp3": "audio/mpeg",
    "pcm": "audio/pcm",
    "opus": "audio/webm",
    "wav": "audio/wav"
  };
  const contentType = CONTENT_TYPE_MAP[response_format];

  // 先用 O(1) 的下界短路，再决定要不要真的分块。smartChunkText 永不产生超过 chunk_size
  // 的块，所以 ceil(字符数 / chunk_size) 是分块数的**下界** —— 下界已超上限时结论必然成立，
  // 这个判据只会漏报、绝不误报。
  //
  // 为什么值得这么做：分块本身要遍历全部字符（50000 字符 / chunk_size=50 实测 4.8ms 切出
  // 1011 块），而这个请求注定被下面的 MAX_CHUNKS 拒绝。端到端实测 39.2ms —— 一个必然失败
  // 的请求就花掉 4 倍于 Workers 10ms CPU 预算的算力，等于给攻击者一条免费的消耗路径。
  const minChunks = Math.ceil(cleanedInput.length / safeChunkSize);
  const tooManyChunks = (count) =>
    errorResponse(
      `文本过长：按 chunk_size=${safeChunkSize} 会切成 ${count} 个分块，` +
        `超过上限 ${LIMITS.MAX_CHUNKS}（Cloudflare Workers 单请求最多 50 个子请求）。` +
        `当前 chunk_size 下最多约 ${LIMITS.MAX_CHUNKS * safeChunkSize} 字符；调大 chunk_size` +
        `（上限 ${LIMITS.MAX_CHUNK_SIZE}）可处理更长文本，或把文本拆成多次请求。`,
      413,
      "too_many_chunks"
    );
  if (minChunks > LIMITS.MAX_CHUNKS) {
    // 报下界而不是真实块数：真实块数只会更大，而为了得到它就得付上面那笔算力。
    return tooManyChunks("至少 " + minChunks);
  }

  const textChunks = smartChunkText(cleanedInput, safeChunkSize);
  if (textChunks.length === 0) {
    return errorResponse("文本分块结果为空", 400, "input_empty_after_cleaning");
  }
  // 必须在这里拦：此时分块数已知，而响应头还没发出。放到流式循环里就来不及了。
  // 错误信息给出可执行的出路（调大 chunk_size 能显著减少分块数），而不是只说「太长」。
  // 下界没超但实际超了，是因为标点会让某些块提前收尾（分块数总是 >= 下界）。
  if (textChunks.length > LIMITS.MAX_CHUNKS) {
    return tooManyChunks(textChunks.length);
  }
  // 流式 + 容器格式 + 多分块 = 静默截断。streamVoice 边收边写，头部早已发出，事后无法回填
  // RIFF 的 data 长度、也无法把多个 WebM Segment 合成一个（非流式路径能做，是因为它先把
  // 所有分块收齐）。线上实测 901 字符 / 4 块的流式 wav：文件含 191.67s，但首个 RIFF 头只
  // 声明 61.46s —— 播放器在 32% 处停止，且响应是 200 + 合法 WAV，无法与正常结果区分。
  // opus 同样是 4 个独立容器。
  //
  // 这正是 README 里「容器格式无法增量解码」的直接后果，所以在发头之前明确拒绝，
  // 并指出 pcm 才是流式该用的格式（UI 已自动改写，直连 API 的调用方需要自己选）。
  if (stream && textChunks.length > 1 && (contentType === "audio/wav" || contentType === "audio/webm")) {
    return errorResponse(
      `流式不支持多分块的 ${response_format}：按 chunk_size=${safeChunkSize} 会切成 ` +
        `${textChunks.length} 块，而 ${response_format} 是带头部的容器格式，` +
        `边发边写无法把多个容器合成一个（播放器只认第一个，会静默截断）。` +
        `流式请用 response_format: "pcm"；若需要 ${response_format} 文件，请去掉 stream。`,
      400,
      "stream_format_not_chunkable"
    );
  }
  // 记在这里：此时所有参数都已校验并归一化（voice 解析过别名、format 已确认受支持、
  // 分块数已确定），而上游还没被调用。校验失败的请求走的是上面那些 return，它们的
  // 日志只有 status/code —— 那正是想要的：一个 400 的 voice 维度是没意义的。
  if (logCtx) {
    logCtx.voice = finalVoice;
    logCtx.format = response_format;
    logCtx.chunks = textChunks.length;
    logCtx.concurrency = safeConcurrency;
    logCtx.stream = stream;
    logCtx.inputChars = cleanedInput.length;
  }
  // ttsArgs 是位置参数、且调用点用 `...ttsArgs, label` 追加 label，所以**不能**往这个
  // 数组里塞新元素 —— 那会把 label 挤到后面一位。logCtx 作为独立参数单独传。
  const ttsArgs = [finalVoice, rate, finalPitch, style, outputFormat, contentType];
  if (stream) {
    return await streamVoice(textChunks, safeConcurrency, logCtx, ...ttsArgs);
  } else {
    return await getVoice(textChunks, safeConcurrency, logCtx, ...ttsArgs);
  }
}

// Coerce a numeric option into range; falls back to `fallback` for non-numeric input.
function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
// 语音列表极少变动（连日核对均为 322 条），但此前每个请求都穿透到微软上游
// （实测 52KB / 最高 483ms）。这里加两层缓存：
//   1. 模块级内存缓存 —— 同一个 isolate 内的后续请求零上游调用
//   2. 响应头 Cache-Control —— 让浏览器与 CF 边缘也能缓存，不必每次开页面重拉 322 条
// 上游失败时若手上有过期缓存，宁可返回过期数据也不让调用方拿不到列表（留 warn 痕迹）。
var VOICES_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
var VOICES_TTL_MS = 6 * 60 * 60 * 1e3;      // 6 小时
var MODELS_CACHE_SECONDS = 21600;           // 与 TTL 一致，供 Cache-Control 使用
var voicesCache = { models: null, fetchedAt: 0 };
var voicesInFlight = null;

/**
 * 从上游的 FriendlyName 里取出人类可读的音色名。
 *
 * 上游字段没有 LocalName —— 322 条里一条都没有（2026-08-04 对线上列表核对过），实际字段是
 * FriendlyName，形如 "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)"。原先读
 * voice.LocalName 使得每一条 description 都是字面量 "undefined - Female"。
 *
 * 只取中间那段名字（"Xiaoxiao"），因为语言和性别已经是独立字段，重复一遍没有信息量。
 * 上游若改了 FriendlyName 的格式，就退回整串原文而不是拼出 undefined。
 */
function voiceDisplayName(voice) {
  const friendly = voice.FriendlyName;
  if (typeof friendly !== "string" || !friendly) return voice.ShortName || "";
  const m = /^Microsoft\s+(.+?)\s+Online\b/.exec(friendly);
  return m ? m[1] : friendly;
}

// 语音列表是近乎静态的（连日核对都是同一批 322 个），所以 created 用一个固定值，
// 不用 Date.now()。OpenAI 的 models 语义里 created 是「模型创建时间」而不是「响应时间」，
// 而每次响应都变的后果很实际：322 条里每条都不同 → 响应体逐字节不同 → ETag 无从稳定、
// CF 边缘也无法复用（实测两次请求的 created 分别是 ...556724 和 ...519071）。
// 取值为上游语音列表首次被完整核对的日期，只是一个稳定的锚点，不代表微软那边的真实时间。
var MODELS_CREATED_AT = 1754265600;   // 2025-08-04T00:00:00Z，秒级（OpenAI 用秒）

function toModel(voice) {
  return {
    id: voice.ShortName,
    object: "model",
    created: MODELS_CREATED_AT,
    owned_by: "microsoft",
    language: voice.Locale,
    gender: voice.Gender,
    description: `${voiceDisplayName(voice)} - ${voice.Gender}`
  };
}

async function getModels() {
  const fresh = voicesCache.models && Date.now() - voicesCache.fetchedAt < VOICES_TTL_MS;
  if (fresh) return voicesCache.models;

  // 合并并发请求：冷启动时多个请求同时进来不应各打一次上游。
  if (!voicesInFlight) {
    voicesInFlight = (async () => {
      const response = await fetch(VOICES_URL);
      if (!response.ok) throw new Error("Failed to fetch voices from EdgeTTS");
      const voices = await response.json();
      const models = voices.map(toModel);
      voicesCache = { models, fetchedAt: Date.now() };
      return models;
    })().finally(() => { voicesInFlight = null; });
  }

  // 关键：降级逻辑必须包住**所有**调用方，而不只是发起那一次刷新的那个。
  // 原先跟随者在上面直接 `return voicesInFlight`，于是拒绝发生在这段 catch 之外，
  // 它们完全跳过了过期缓存回退。实测上游挂掉时 5 个并发请求里只有 1 个拿到完整的
  // 322 条，另外 4 个拿到 2 条兜底列表——UI 的音色选择器会随机只显示 2 个音色。
  try {
    return await voicesInFlight;
  } catch (error) {
    if (voicesCache.models) {
      // 降级留痕：明确区分「拿到的是过期缓存」与「拿到的是新鲜数据」
      console.warn("语音列表上游失败，返回过期缓存:", error.message);
      return voicesCache.models;
    }
    throw error;
  }
}

/**
 * 语音列表是只读的，但之前对 PUT/DELETE/PATCH 一律返回 200 + 完整列表 —— 调用方会以为
 * 自己的写操作成功了。405 必须带 Allow 头（RFC 9110 要求），否则客户端无从知道该用什么方法。
 */
function modelsMethodCheck(request) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  return errorResponse("不允许的方法，语音列表是只读的", 405, "method_not_allowed", "api_error", {
    "Allow": "GET, HEAD, OPTIONS"
  });
}

function modelsHeaders(etag) {
  return {
    "Content-Type": "application/json",
    "Cache-Control": `public, max-age=${MODELS_CACHE_SECONDS}`,
    ...(etag ? { "ETag": etag } : {}),
    ...makeCORSHeaders()
  };
}

/**
 * 语音列表的弱 ETag。列表本身近乎静态，加上 created 已固定，同一份列表 + 同一组过滤参数
 * 就能得到稳定的标识，于是 304 与边缘复用才有意义（实测此前 cf-cache-status 一直是空）。
 *
 * 用长度 + 逐条 id 的 FNV-1a 哈希，而不是把整个 body 再算一遍 SHA：这里只需要「内容变了
 * 就一定变」，而 32 位碰撞的代价是一次多余的 200，不是错误响应。弱 ETag（W/ 前缀）正是
 * 表达这种语义等价而非字节相同的记法。
 */
function modelsEtag(models) {
  let h = 0x811c9dc5;
  for (const m of models) {
    const s = m.id;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
  }
  return `W/"${models.length}-${h.toString(16)}"`;
}

/** 请求带的 If-None-Match 命中当前 ETag 时，回 304（不带 body）。 */
function notModified(request, etag) {
  const inm = request.headers.get("if-none-match");
  if (!inm) return null;
  // 客户端可以带多个，也可能把弱标记去掉，逐个宽松比对。
  const wanted = etag.replace(/^W\//, "");
  const hit = inm.split(",").some((t) => t.trim().replace(/^W\//, "") === wanted);
  if (!hit) return null;
  return new Response(null, { status: 304, headers: modelsHeaders(etag) });
}

/**
 * 按查询参数过滤语音列表。两个端点共用，因为 README 承诺的过滤能力不该只在
 * 需要鉴权的那一个上生效 —— 内置 UI 的音色筛选走的正是公开端点。
 *
 * 注意 ?neural：上游 322 个音色**全部**含 "Neural"，所以这个参数恒为 no-op。
 * 保留它是为了向后兼容既有调用方（去掉会让 ?neural=true 的请求行为改变），
 * 但文档里已标注它没有实际作用，不要在此基础上做新设计。
 */
function filterModels(models, url) {
  const on = (v) => v === "true" || v === "1";
  let out = models;
  if (on(url.searchParams.get("neural"))) {
    out = out.filter((m) => m.id.includes("Neural"));
  }
  if (on(url.searchParams.get("multilingual"))) {
    out = out.filter((m) => m.id.includes("Multilingual"));
  }
  return out;
}

async function handlePublicModelsRequest(request) {
  const wrongMethod = modelsMethodCheck(request);
  if (wrongMethod) return wrongMethod;
  try {
    const models = filterModels(await getModels(), new URL(request.url));
    // ETag 按**过滤后**的列表算：?multilingual=true 与不带参数是两个不同的表示，
    // 若共用一个 ETag，带 If-None-Match 的第二个请求会拿到 304 而误用前一份内容。
    const etag = modelsEtag(models);
    const fresh = notModified(request, etag);
    if (fresh) return fresh;
    return new Response(JSON.stringify(models), {
      headers: modelsHeaders(etag)
    });
  } catch (error) {
    console.error("获取语音列表失败:", error);
    return errorResponse("Failed to fetch voices", 500, "fetch_error");
  }
}
async function handleModelsRequest(request) {
  const wrongMethod = modelsMethodCheck(request);
  if (wrongMethod) return wrongMethod;
  try {
    const models = filterModels(await getModels(), new URL(request.url));
    // ETag 按**过滤后**的列表算：?multilingual=true 与不带参数是两个不同的表示，
    // 若共用一个 ETag，带 If-None-Match 的第二个请求会拿到 304 而误用前一份内容。
    const etag = modelsEtag(models);
    const fresh = notModified(request, etag);
    if (fresh) return fresh;
    return new Response(JSON.stringify(models), {
      headers: modelsHeaders(etag)
    });
  } catch (error) {
    console.error("获取语音列表失败:", error);
    const fallbackModels = [
      { id: "zh-CN-XiaoxiaoNeural", object: "model", created: MODELS_CREATED_AT, owned_by: "microsoft", language: "zh-CN", gender: "Female", description: "晓晓 - 温柔女声" },
      { id: "zh-CN-YunxiNeural", object: "model", created: MODELS_CREATED_AT, owned_by: "microsoft", language: "zh-CN", gender: "Male", description: "云希 - 阳光男声" }
    ];
    // 兜底列表不缓存：它是降级产物，不该被边缘/浏览器当成 6 小时有效的正常结果
    return new Response(JSON.stringify(fallbackModels), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...makeCORSHeaders() }
    });
  }
}
async function streamVoice(textChunks, concurrency, logCtx, ...ttsArgs) {
  const { readable, writable } = new TransformStream();
  const contentType = ttsArgs[5] || "audio/mpeg";
  // 流式的响应头在第一个分块之前就发出，所以 handleRequest 里那次 emitLog 会在合成**还没
  // 开始**时就跑 —— 实测记出 `ms:6, upstream:0`，而这个请求实际打了 4 次上游、耗时 192ms。
  // 那种数据比没有更糟：它会把每个流式请求的 p99 和上游用量都算低。
  //
  // 所以流式自己负责在流真正结束（或失败）时再记一次，并让 handleRequest 那次跳过
  // （streamLogged 标记）。这也是 `ms` 对两条路径含义不同的地方，已在字段名注释里说明。
  if (logCtx) logCtx.streamLogged = true;
  pipeChunksToStream(writable.getWriter(), textChunks, concurrency, logCtx, ...ttsArgs)
    .then(() => {
      // 流式无法在发头之后改状态码，所以「上游给了 0 字节」这件事在流式路径上**只能**靠
      // 日志暴露（非流式已改为 502 upstream_empty_audio）。单独标记出来，这样
      // "phase=stream_empty" 可以直接聚合，而不必先算 bytes==0。
      const empty = !logCtx || !logCtx.bytes;
      emitLog(logCtx, null, { status: 200, phase: empty ? "stream_empty" : "stream_end" });
    })
    .catch((error) => {
      console.error("流式 TTS 失败:", error);
      // 头已发出，HTTP 状态无法再改，但日志必须体现「这条流是断的」——
      // 否则一个中途失败的流在聚合里与成功的流长得一样。
      emitLog(logCtx, null, { status: 200, phase: "stream_broken", err: error?.status || "error" });
    });
  return new Response(readable, {
    headers: { "Content-Type": contentType, ...makeCORSHeaders() }
  });
}
async function pipeChunksToStream(writer, chunks, concurrency, logCtx, ...ttsArgs) {
  // Sliding-window prefetch: keep `concurrency` synthesis requests in flight while
  // writing results strictly in order. The previous implementation awaited each chunk
  // sequentially, so the `concurrency` argument had no effect and long inputs were
  // bottlenecked on round-trip latency per chunk.
  const inFlight = new Map();
  let aborted = false;

  const schedule = (index) => {
    if (index >= chunks.length) return;
    const task = getAudioChunk(chunks[index], ...ttsArgs, `#${index + 1}/${chunks.length}`, logCtx)
      .then((blob) => blob.arrayBuffer());
    // 必须在这里就挂上 handler，不能等主循环结束后补。unhandledRejection 的判定是
    // 时序性的：V8 在 microtask 队列排空的那一刻检查「此刻有没有 handler」，事后
    // 补 .catch() 只会换来 PromiseRejectionHandledWarning，拦不住那次上报。
    // 滑动窗口正好制造这个窗口期——窗口内靠后的分块可能在主循环仍阻塞于靠前的
    // 分块时就已 reject（实测 concurrency=4、chunk0 慢 400ms 时必然触发）。在
    // Workers 运行时里这会被记成 runtime exception，让已被正确处理的错误看着像事故。
    task.catch(() => {});
    inFlight.set(index, task);
  };

  try {
    const window = Math.max(1, Math.min(concurrency, chunks.length));
    for (let i = 0; i < window; i++) schedule(i);

    for (let i = 0; i < chunks.length; i++) {
      const buffer = await inFlight.get(i);
      if (logCtx) logCtx.bytes = (logCtx.bytes || 0) + buffer.byteLength;
      inFlight.delete(i);
      schedule(i + window);
      await writer.write(new Uint8Array(buffer));
    }
    await writer.close();
  } catch (error) {
    aborted = true;
    console.error("流式 TTS 失败:", error);
    // Surface the failure to the client as a broken stream rather than a silently
    // short-but-valid audio file, which is indistinguishable from a complete result.
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    // 被放弃的预取已在 schedule() 里挂过 handler，这里无需再兜一次；只清引用。
    // aborted 时保留 Map 不清，是为了让仍在飞的请求保有引用直到自然结束。
    if (!aborted) inFlight.clear();
  }
}
/**
 * 把多个完整的 WAV 分块合并成单个合法 WAV。
 *
 * 做法：保留第一块的头部（含它自己的 fmt 块，采样率/位深/声道数由 FORMAT_MAP 固定，
 * 所有分块必然一致），把每一块的 data 负载抽出来接在一起，再改写 RIFF 与 data 两处
 * 长度字段。头部长度不能假设是 44 字节 —— 上游可能插入 LIST/fact 等附加块，所以按
 * RIFF 的 (id, size) 结构真正遍历到 data 块为止。
 *
 * 任何一块不像 WAV（缺 RIFF/WAVE 魔数或找不到 data 块）就退回裸拼接：那说明上游换了
 * 格式，此时猜测比原样透传更危险，且降级会记进日志而不是静默发生。
 */
// ---------------------------------------------------------------- WebM / Opus 合并
//
// 上游对每个分块返回一个**完整独立**的 WebM 容器。裸拼接后 `<audio>` 只认第一个容器：
// 实测 3 容器的响应里 Chrome 报 65.14s，而文件实际含 162.91s 音频 —— 静默丢掉 60%。
// （早前用 decodeAudioData 测得「完整」是假象：它会一路读完所有容器，而 UI 用的是
// `<audio>`。两者结论相反时，以用户真实走的那条路径为准。另外 duration 要 seek 到
// 超末尾才会被 Chrome 解析出来，只看 loadedmetadata 时的 null 会误判成上游特性。）
//
// 合并是纯字节层的，因为上游的封装恰好省掉了所有需要回填长度的元素：Segment 与 Cluster
// 都是 UNKNOWN-size，且没有 SeekHead / Cues / 顶层 Duration。于是只需保留块 0 的头部，
// 后续块丢掉头部、把每个 Cluster 的 Timecode 改写成绝对时间即可，没有任何 size 字段要动。
// Timecode 固定写成 8 字节（0xE7 0x88 + uint64BE），长度恒定，父级的 UNKNOWN size 不受影响。
//
// 成本实测（真 workerd，45 块 / 2.7MB / 21240 个 SimpleBlock）：约 1.2ms，是 10ms CPU
// 预算的 12%，与 concatWavBlobs 同量级。本机对 10 块 / 601KB 复测为 2.42ms，且输出的 PCM
// 与裸拼接逐字节相同 —— 只有时间戳变了，音频无损。
var WEBM_FRAME_MS = 20;      // 上游恒定 20ms 一帧（实测每个 SimpleBlock 的相对步长都是 20）
var OPUS_CODEC_DELAY_MS = 10; // 加上它才能消掉 ffmpeg 的 non-monotonic dts 告警（44 -> 0）

var EBML_ID = {
  SEGMENT: 0x18538067,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLEBLOCK: 0xa3
};

/** 读一个 EBML 变长整数。keepMarker 时返回含前导标记位的原始 ID。 */
function readEbmlVint(b, p, keepMarker) {
  const first = b[p];
  if (first === undefined) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) {
    mask >>= 1;
    len++;
  }
  if (len > 8) return null;
  let val = keepMarker ? first : first & (mask - 1);
  // size 字段全 1 表示「长度未知」，这正是上游流式封装的写法。
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    val = val * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { val, len, unknown: !keepMarker && allOnes };
}

/** 定位一个分块的首个 Cluster、每个 Cluster 的 Timecode 位置，以及该块的时长。 */
function parseWebmChunk(b) {
  let p = 0;
  let firstCluster = -1;
  const clusters = [];
  let lastAbs = -1;
  let base = 0;
  while (p < b.length) {
    const id = readEbmlVint(b, p, true);
    if (!id) break;
    const size = readEbmlVint(b, p + id.len, false);
    if (!size) break;
    const body = p + id.len + size.len;
    if (id.val === EBML_ID.SEGMENT) {
      p = body;                                   // 进入 Segment
      continue;
    }
    if (id.val === EBML_ID.CLUSTER) {
      if (firstCluster < 0) firstCluster = p;
      clusters.push({ start: p, headerEnd: body });
      p = body;                                   // Cluster 也是 UNKNOWN-size，直接进入
      continue;
    }
    if (id.val === EBML_ID.TIMECODE && clusters.length) {
      let n = 0;
      for (let i = 0; i < size.val; i++) n = n * 256 + b[body + i];
      base = n;
      const c = clusters[clusters.length - 1];
      c.tcStart = p;
      c.tcEnd = body + size.val;
      c.tc = n;
      p = body + size.val;
      continue;
    }
    if (id.val === EBML_ID.SIMPLEBLOCK) {
      // track 号占 1 字节 vint，随后是 int16BE 的块内相对时间戳。
      const rel = (((b[body + 1] << 8) | b[body + 2]) << 16) >> 16;
      lastAbs = base + rel;
      p = body + size.val;
      continue;
    }
    if (size.unknown) {
      p = body;
      continue;
    }
    p = body + size.val;
  }
  if (firstCluster < 0) return null;              // 不像 WebM，交给调用方降级
  return { firstCluster, clusters, duration: lastAbs + WEBM_FRAME_MS };
}

/** Cluster Timecode 定长编码：0xE7 + 0x88(8 字节) + uint64BE，改写后长度不变。 */
function encodeClusterTimecode(ms) {
  const out = new Uint8Array(10);
  out[0] = EBML_ID.TIMECODE;
  out[1] = 0x88;
  let v = BigInt(ms);
  for (let i = 9; i >= 2; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * 把 N 个独立 WebM 容器合并成一个。任一分块解析不出 Cluster 就返回 null，
 * 由调用方降级为裸拼接并留日志（与 concatWavBlobs 的降级方式一致）。
 */
/**
 * 往合并结果的 Info 元素里插入顶层 Duration，让浏览器在 loadedmetadata 时就知道总时长。
 *
 * 为什么值得做：上游的 Segment 是 UNKNOWN-size 且不声明 Duration，所以 `<audio>.duration`
 * 在 loadedmetadata 时是 null —— 原生进度条一片空白，要等用户 seek 过末尾浏览器才解析出
 * 时长。实测注入后 loadedmetadata 时 duration/seekable 直接是 28.35，ffprobe 也从 N/A 变成
 * 28.350000（零告警）。代价是 11 字节、0.177ms。
 *
 * 为什么能原地做：Info 的 size 是**已知长度**，所以插 11 字节必须同时改写它 —— 而上游把所有
 * size 都编成 8 字节 vint（实测 `01 00 00 00 00 00 00 56` = 86），能表示到 2^56-1，
 * 86 -> 97 只改值字节、编码宽度不变，因此后续字节一个都不用移动。
 * 只处理这种 8 字节编码；换成别的宽度就放弃注入（返回原样），因为那时改 size 会让字段变宽、
 * 需要整体搬移，收益不值得那个复杂度。
 */
function injectWebmDuration(bytes, durationMs) {
  let infoAt = -1;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x15 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0xa9 && bytes[i + 3] === 0x66) {
      infoAt = i;
      break;
    }
  }
  if (infoAt < 0) return bytes;                 // 没有 Info，放弃注入
  const sizeAt = infoAt + 4;
  if (bytes[sizeAt] !== 0x01) return bytes;     // 不是 8 字节 vint，放弃（见上）
  let size = 0;
  for (let i = sizeAt + 1; i < sizeAt + 8; i++) size = size * 256 + bytes[i];
  const bodyAt = sizeAt + 8;
  if (bodyAt + size > bytes.length) return bytes;   // size 与实际不符，别碰

  // Duration = 0x4489 + size 标记 0x88 + float64 BE，共 11 字节
  const dur = new Uint8Array(11);
  dur[0] = 0x44;
  dur[1] = 0x89;
  dur[2] = 0x88;
  new DataView(dur.buffer).setFloat64(3, durationMs, false);

  const out = new Uint8Array(bytes.length + dur.length);
  out.set(bytes.subarray(0, bodyAt), 0);
  out.set(dur, bodyAt);                         // 放在 Info body 开头
  out.set(bytes.subarray(bodyAt), bodyAt + dur.length);
  // 原地把 Info 的 size 加 11（编码宽度不变）
  let v = size + dur.length;
  for (let i = sizeAt + 7; i >= sizeAt + 1; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

function mergeWebmChunks(buffers) {
  const parsed = [];
  for (const buf of buffers) {
    const bytes = new Uint8Array(buf);
    const info = parseWebmChunk(bytes);
    if (!info) return null;
    parsed.push({ bytes, info });
  }
  const pieces = [];
  // 块 0 的头部（EBML + Segment + Info + Tracks）原样保留，后续块的头部全部丢弃。
  pieces.push(parsed[0].bytes.subarray(0, parsed[0].info.firstCluster));
  let offset = 0;
  for (const { bytes, info } of parsed) {
    for (let i = 0; i < info.clusters.length; i++) {
      const c = info.clusters[i];
      const end = i + 1 < info.clusters.length ? info.clusters[i + 1].start : bytes.length;
      pieces.push(bytes.subarray(c.start, c.headerEnd));       // Cluster ID + UNKNOWN size
      pieces.push(encodeClusterTimecode(c.tc + offset));       // 改写成绝对时间
      pieces.push(bytes.subarray(c.tcEnd, end));               // SimpleBlock 原样透传
    }
    offset += info.duration + OPUS_CODEC_DELAY_MS;
  }
  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = new Uint8Array(total);
  let w = 0;
  for (const piece of pieces) {
    out.set(piece, w);
    w += piece.length;
  }
  // offset 此时正好等于所有分块的时长之和（含每块的 CodecDelay 尾），即合并后的总时长。
  return injectWebmDuration(out, offset);
}

async function concatWebmBlobs(blobs, contentType, logCtx = null) {
  const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
  const merged = mergeWebmChunks(buffers);
  if (!merged) {
    if (logCtx) logCtx.degraded = "webm_merge_declined";
    console.warn("WebM 合并：分块里找不到 Cluster，退回裸拼接");
    return new Blob(blobs, { type: contentType });
  }
  return new Blob([merged], { type: contentType });
}

async function concatWavBlobs(blobs, contentType, logCtx = null) {
  const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
  const parsed = [];
  for (const buf of buffers) {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const magic = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    if (buf.byteLength < 12 || magic(0) !== "RIFF" || magic(8) !== "WAVE") {
      if (logCtx) logCtx.degraded = "wav_merge_declined_no_riff";
      console.warn("WAV 合并：分块缺少 RIFF/WAVE 魔数，退回裸拼接");
      return new Blob(blobs, { type: contentType });
    }
    // 遍历 RIFF 子块找到 data，而不是假设头部固定 44 字节。
    let offset = 12;
    let data = null;
    while (offset + 8 <= buf.byteLength) {
      const id = magic(offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === "data") {
        // 上游可能把 size 写成 0 或超出实际长度（流式生成的 WAV 常见），
        // 以实际剩余字节为准，避免截断或越界。
        const usable = Math.min(size || buf.byteLength - body, buf.byteLength - body);
        data = { start: body, length: usable, headerEnd: body };
        break;
      }
      offset = body + size + (size % 2); // RIFF 块按偶数字节对齐
    }
    if (!data) {
      if (logCtx) logCtx.degraded = "wav_merge_declined_no_data";
      console.warn("WAV 合并：分块里找不到 data 块，退回裸拼接");
      return new Blob(blobs, { type: contentType });
    }
    parsed.push({ bytes, data });
  }

  const header = parsed[0].bytes.slice(0, parsed[0].data.headerEnd);
  const totalData = parsed.reduce((sum, p) => sum + p.data.length, 0);
  const out = new Uint8Array(header.length + totalData);
  out.set(header, 0);
  let write = header.length;
  for (const p of parsed) {
    out.set(p.bytes.subarray(p.data.start, p.data.start + p.data.length), write);
    write += p.data.length;
  }
  // 改写两处长度：RIFF size（不含前 8 字节）与 data size。
  const outView = new DataView(out.buffer);
  outView.setUint32(4, out.length - 8, true);
  outView.setUint32(header.length - 4, totalData, true);
  return new Blob([out], { type: contentType });
}

/**
 * 用固定大小的工作池并发合成所有分块，结果按原始下标归位。
 *
 * 取代原先的「每 concurrency 块 Promise.all 一批」：那种分批有栅栏，每批的耗时是
 * **该批最慢一块**，而不是平均值。上游延迟有长尾（多数 ~100ms，偶发 500ms+），
 * 于是一块慢就让同批另外 9 个槽位空转到批结束。
 *
 * 实测（真 worker + mock 上游，每 10 块里第 4 块 500ms、其余 100ms）：
 * 12 块/并发 10 = 645ms，而工作量下界是 160ms。工作池把槽位一空就立刻补下一块，
 * 总耗时收敛到 sum(work)/concurrency 附近。
 *
 * 流式路径（pipeChunksToStream）本来就是滑动窗口 —— 它必须按序输出，逼得它显式记
 * 下标，顺手就成了工作池。非流式靠 Promise.all 白拿顺序，分批写法看着对，就没人发现
 * 它在白扔延迟。这里补齐，两条路径的调度语义从此一致。
 */
async function synthesizeAllChunks(textChunks, concurrency, ttsArgs, logCtx) {
  const out = new Array(textChunks.length);
  const width = Math.max(1, Math.min(concurrency, textChunks.length));
  let next = 0;
  // 一块失败则整个响应必定失败，剩下的分块再合成也没人要。必须显式停：
  // 分批实现里栅栏**顺带**当了熔断（一批做完才开下一批，所以最多多花一批），
  // 工作池没有批边界，不设这个标志就会把整个数组抽干 —— 实测 45 块 / 并发 10、
  // 第 1 块就 400：分批只发 10 次上游调用，无标志的工作池发满 45 次。
  // 那 35 次既白烧 subrequest 配额（单次调用上限 50），又白打上游。
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= textChunks.length) return;
      try {
        out[i] = await getAudioChunk(textChunks[i], ...ttsArgs, `#${i + 1}/${textChunks.length}`, logCtx);
      } catch (error) {
        failed = true; // 先置位再抛，让同伴 worker 在下一轮循环即退出
        throw error;
      }
    }
  };
  // 任一 worker 抛错就整体 reject（和 Promise.all 语义一致，调用方的 catch 不变）。
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

async function getVoice(textChunks, concurrency, logCtx, ...ttsArgs) {
  const contentType = ttsArgs[5] || "audio/mpeg";
  try {
    const allAudioBlobs = await synthesizeAllChunks(textChunks, concurrency, ttsArgs, logCtx);
    // WAV 是带头部的容器：裸拼接 N 个分块等于把 N 个完整 RIFF 文件首尾相接，
    // 播放器读到第一个头里的 data 长度就停了，后面全部音频被静默丢弃。默认
    // chunk_size=300，所以约 300 字符以上的输入就会触发——用户听到的是被截断的
    // 语音，且响应是 200 + 合法 WAV，无法与正常结果区分。opus/webm 有同样性质的问题
    // （`<audio>` 只认第一个容器，实测 3 容器时 65.14s / 实际 162.91s），见
    // mergeWebmChunks。mp3/pcm 不受影响：前者帧自同步、后者无头部。
    let audioBody;
    if (allAudioBlobs.length > 1 && contentType === "audio/wav") {
      audioBody = await concatWavBlobs(allAudioBlobs, contentType, logCtx);
    } else if (allAudioBlobs.length > 1 && contentType === "audio/webm") {
      audioBody = await concatWebmBlobs(allAudioBlobs, contentType, logCtx);
    } else {
      audioBody = new Blob(allAudioBlobs, { type: contentType });
    }
    if (logCtx) logCtx.bytes = audioBody.size;
    // 上游会对「文本的语种该音色完全不支持」返回 **200 + 0 字节**，而不是报错。
    // 线上实测（2026-08-06）：中文 / 日文 / 纯标点 送给 en-US-AvaNeural，5/5 次都是
    // `200 audio/mpeg, content-length: 0`；同一音色送英文正常（12240B），同一中文送
    // en-US-AvaMultilingualNeural 也正常（10656B）。zh-CN 音色读英文没问题，所以这不是
    // 「跨语种」而是「该音色对这套书写系统零覆盖」。
    //
    // 原样透传 = 又一次静默失败：调用方拿到的是格式合法的空音频，与成功无法区分
    // （本项目已经为 WAV / Opus 各修过一次同类问题）。UI 侧早已拒绝零字节流，但直连
    // API 的调用方没有这层保护。这里明确报错，并指出可执行的出路。
    if (audioBody.size === 0) {
      return errorResponse(
        "上游返回了空音频（0 字节）。最常见的原因是该 voice 完全不支持这段文本的书写系统 —— " +
          "例如把中文送给 en-US-AvaNeural。请换成对应语种的音色，或用带 Multilingual 的音色；" +
          "可用 id 见 GET /v1/models。",
        502,
        "upstream_empty_audio",
        "api_error",
        null,
        "voice"
      );
    }
    return new Response(audioBody, {
      headers: { "Content-Type": contentType, ...makeCORSHeaders() }
    });
  } catch (error) {
    // 完整错误(含堆栈)只进日志；回给调用方的是我们自己的措辞 + 机器码，
    // 避免任何内部实现细节(上游原文、路径、依赖名)顺着 message 泄漏出去。
    console.error("非流式 TTS 失败:", error);
    // 上游的 4xx 是**调用方**的错误，不该报成 500。最常见的情形是 voice 形状合法
    // （通得过 VOICE_RE）但上游没有这个音色 —— 报 500 会让调用方去查我们的服务状态，
    // 而真正该做的是换一个音色。上游原文仍然只进日志，不进响应（见 getAudioChunk）。
    if (error?.status >= 400 && error.status < 500) {
      return errorResponse(
        `上游拒绝了该请求（${error.status}）。最常见的原因是 voice 不存在 —— ` +
          "请用 GET /v1/models 里的 id；也可能是 style 不被该音色支持。",
        400,
        "upstream_rejected_request"
      );
    }
    return errorResponse("语音合成失败，请稍后重试", 500, "tts_generation_error");
  }
}
var MAX_CHUNK_ATTEMPTS = 3;

async function getAudioChunk(text, voiceName, rate, pitch, style, outputFormat, contentType, label = "", logCtx = null) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    try {
      // A 401 means the cached token expired mid-request; force a refresh before retrying.
      const endpoint = await getEndpoint({ forceRefresh: attempt > 1 && lastError?.status === 401 });
      const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const ssml = getSsml(text, voiceName, rate, pitch, style);
      // 计在 fetch 之前：这一次尝试无论成败都消耗了一个 subrequest 配额（上限 50/次调用），
      // 所以「实际发出多少」才是要观测的量，不是「成功多少」。
      if (logCtx) logCtx.upstreamCalls++;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": endpoint.t,
          "Content-Type": "application/ssml+xml",
          "User-Agent": "okhttp/4.5.0",
          "X-Microsoft-OutputFormat": outputFormat
        },
        body: ssml
      });
      if (!response.ok) {
        const errorText = await response.text();
        // 上游的响应体只进日志，不进 Error.message —— 因为 getVoice 的 catch 会把
        // error.message 原样放进 HTTP 响应，等于把微软的错误原文(可能含订阅密钥片段、
        // 内部主机名、请求 ID)转发给任意调用方。实测泄漏过
        // "Subscription key sk-... rejected at /internal/host" 这种内容。
        // 带上分块序号与输出格式：多分块并发重试时，光看「第 2 次失败」分不清是同一个分块
        // 反复失败还是多个分块都在失败 —— 这两种情况的处置完全不同（前者多半是那段文本有
        // 问题，后者是上游整体在限流）。format 则让「只有 wav 出问题」这类模式看得见。
        console.error(
          `上游合成失败${label}[${outputFormat}]: ${response.status} ${response.statusText} - ` +
            errorText.slice(0, 500)
        );
        const err = new Error(`上游语音合成失败（${response.status}）`);
        err.status = response.status;
        throw err;
      }
      return response.blob();
    } catch (error) {
      lastError = error;
      // 4xx other than 401/408/429 are caller errors — retrying cannot help.
      const status = error?.status;
      const retryable = !status || status === 401 || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_CHUNK_ATTEMPTS) throw error;
      if (logCtx) logCtx.retries++;
      console.warn(`分块${label}合成第 ${attempt} 次失败（${status ?? "network"}），重试中`);
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
  throw lastError;
}
var tokenInfo = { endpoint: null, token: null, expiredAt: null };
var TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60;
var tokenRefreshInFlight = null;

async function getEndpoint({ forceRefresh = false } = {}) {
  const now = Date.now() / 1e3;
  if (!forceRefresh && tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
    return tokenInfo.endpoint;
  }
  // Coalesce concurrent refreshes: with a sliding window of N in-flight chunk requests,
  // an expired token would otherwise trigger N simultaneous token fetches.
  if (tokenRefreshInFlight) return tokenRefreshInFlight;
  tokenRefreshInFlight = fetchEndpoint(now).finally(() => {
    tokenRefreshInFlight = null;
  });
  return tokenRefreshInFlight;
}

async function fetchEndpoint(now) {
  const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const clientId = crypto.randomUUID().replace(/-/g, "");
  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Accept-Language": "zh-Hans",
        "X-ClientVersion": "4.0.530a 5fe1dc6c",
        "X-UserId": "0f04d16a175c411e",
        "X-HomeGeographicRegion": "zh-Hans-CN",
        "X-ClientTraceId": clientId,
        "X-MT-Signature": await sign(endpointUrl),
        "User-Agent": "okhttp/4.5.0",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "0",
        "Accept-Encoding": "gzip"
      }
    });
    if (!response.ok) {
      throw new Error(`获取端点失败: ${response.status}`);
    }
    const data = await response.json();
    const jwt = data.t.split(".")[1];
    const decodedJwt = JSON.parse(atob(jwt));
    tokenInfo = {
      endpoint: data,
      token: data.t,
      expiredAt: decodedJwt.exp
    };
    console.log(`成功获取新 Token，有效期 ${((decodedJwt.exp - now) / 60).toFixed(1)} 分钟`);
    return data;
  } catch (error) {
    console.error("获取端点失败:", error);
    // 缓存 token 只有**还没到期**时才配得上当兜底。getEndpoint 提前 5 分钟就刷新，
    // 所以这里的缓存通常是「还有几分钟寿命」的，拿它顶过一次上游抖动是划算的。
    //
    // 但原来的判断只看 `tokenInfo.token` 存不存在，过期的照样返回。结果是一条谁都
    // 想不到的因果链：token 端点挂 + 缓存已过期 → 返回死 token → 上游 401 → 401 属
    // 可重试 → forceRefresh → token 端点还是挂 → 又返回同一个死 token → 三次耗尽 →
    // 抛出 status 401 → getVoice 把 4xx 当调用方错误 → 回给用户「voice 不存在，请用
    // GET /v1/models 里的 id」。真实原因是我们自己的 token 拿不到，却让调用方去换音色。
    // 实测复现：status=400 + 那句音色文案，token 端点被调用 3 次。
    // `tokenInfo.expiredAt &&` is redundant for behaviour — `n < null` is already false —
    // and a mutation run will flag dropping it as a surviving mutant. It is an equivalent
    // mutant, not a coverage gap: the guard is kept so the intent (both fields must be
    // populated) reads explicitly rather than resting on a coercion rule.
    if (tokenInfo.token && tokenInfo.expiredAt && Date.now() / 1e3 < tokenInfo.expiredAt) {
      const leftSec = tokenInfo.expiredAt - Date.now() / 1e3;
      console.warn(`token 刷新失败，改用仍有效的缓存 Token 兜底（剩余 ${(leftSec / 60).toFixed(1)} 分钟）`);
      return tokenInfo.endpoint;
    }
    if (tokenInfo.token) {
      // 有缓存但已过期：拿它去打上游是必然 401，只会把真实原因掩埋成音色错误。
      console.error("token 刷新失败且缓存 Token 已过期，不再用它兜底");
    }
    throw error;
  }
}
async function sign(urlStr) {
  const url = urlStr.split("://")[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = crypto.randomUUID().replace(/-/g, "");
  const formattedDate = (/* @__PURE__ */ new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT";
  const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
  const decode = await base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
  const signData = await hmacSha256(decode, bytesToSign);
  const signBase64 = await bytesToBase64(signData);
  return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}
async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}
async function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
async function bytesToBase64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}
// Escapes a value for use inside a double-quoted XML attribute.
function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getSsml(text, voiceName, rate, pitch, style) {
  // <break> is the one tag callers may legitimately embed, so it is preserved verbatim
  // while everything else in the text is escaped. The placeholder includes a random
  // token so text that literally contains the placeholder string cannot forge a tag.
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // 只保留**格式正确**的 <break>,其余(含未自闭合的 <break time="1s">、非法/负数 time)
  // 落到下面的转义分支,变成无害的正文,而不是原样透传给上游。
  //
  // 之前的正则太宽:time="[^"]*" 会吞下 "abc"、"-5s";末尾 /? 让 <break time="1s">(无斜杠)
  // 也被当标签保留。这三种上游都回 400,而调用方看到的却是「voice 不存在」那句误导性错误
  // (实测 voice 明明合法)。收紧后:必须自闭合(/>),time 若有则为可选负号后跟数字、
  // 可选小数、可选 s/ms 单位 —— 与实测上游接受的形态一致(接受 "1s"/"500ms"/"0.5s"/"1",
  // 拒绝 "abc"/"-5s"/无斜杠)。负号允许进正则、但值非法的交给上游判(这里只挡明显畸形)。
  const breakTagRegex = /<break(?:\s+time=(?:"[0-9]+(?:\.[0-9]+)?(?:ms|s)?"|'[0-9]+(?:\.[0-9]+)?(?:ms|s)?'))?\s*\/>/gi;
  const breakTags = [];
  const processedText = text.replace(breakTagRegex, (match) => {
    const placeholder = `__BREAK_${nonce}_${breakTags.length}__`;
    breakTags.push(match);
    return placeholder;
  });
  const sanitizedText = processedText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let finalText = sanitizedText;
  breakTags.forEach((tag, index) => {
    // Function replacement so `$&`, `$1`, etc. inside a break tag's attributes are
    // inserted literally rather than expanded as replacement patterns (which would
    // leak the internal nonce placeholder into the outgoing SSML).
    finalText = finalText.replace(`__BREAK_${nonce}_${index}__`, () => tag);
  });
  // voiceName/style are already whitelist-validated in handleSpeechRequest; escaping here
  // keeps getSsml safe on its own so a future caller can't reintroduce SSML injection.
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="en-US">
    <voice name="${escapeXmlAttr(voiceName)}">
      <mstts:express-as style="${escapeXmlAttr(style)}">
        <prosody rate="${escapeXmlAttr(rate)}%" pitch="${escapeXmlAttr(pitch)}%">${finalText}</prosody>
      </mstts:express-as>
    </voice>
  </speak>`;
}
function smartChunkText(text, maxChunkLength) {
  if (!text) return [];
  const chunks = [];
  let currentChunk = "";

  const flush = () => {
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    currentChunk = "";
  };

  // SSML 标签必须整块保留。分隔符里含 `,` 和 `:`，而 `<break time="500ms"/>` 内部就有
  // 引号和数字后的单位，一旦按分隔符切开，两半各自进不同分块，getSsml 里再转义就变成
  // 字面量 &lt;break…，被当正文念出来（UI 的「插入停顿」按钮生成的正是这个标签）。
  // 先把标签整体切出来当作不可分割的原子片段，再对其余文本做正常的标点切分。
  const SSML_TAG = /<\/?[a-zA-Z][^<>]*\/?>/g;
  const atoms = [];
  let cursor = 0;
  for (const tag of text.matchAll(SSML_TAG)) {
    if (tag.index > cursor) atoms.push({ text: text.slice(cursor, tag.index), splittable: true });
    atoms.push({ text: tag[0], splittable: false });
    cursor = tag.index + tag[0].length;
  }
  if (cursor < text.length) atoms.push({ text: text.slice(cursor), splittable: true });

  // 展开成 (片段, 是否可切) 的序列。splittable 必须一路带到下面的硬切分支：一个
  // `<break time="500ms"/>` 有 21 字符，只要 chunk_size 比它小，硬切照样会把它劈成两半。
  const sentences = atoms.flatMap((a) =>
    a.splittable
      ? a.text.split(/([.?!,;:\n。？！，；：\r]+)/g).map((t) => ({ text: t, splittable: true }))
      : [{ text: a.text, splittable: false }]
  );
  for (const { text: part, splittable } of sentences) {
    if (currentChunk.length + part.length <= maxChunkLength) {
      currentChunk += part;
      continue;
    }
    flush();
    // 标签宁可超出 chunk_size 也不能切开：超长一点上游能接受，标签断裂则一定被念出来。
    if (!splittable) {
      currentChunk = part;
      continue;
    }
    // A single segment with no usable break point (e.g. a long unpunctuated paragraph)
    // still has to be split, otherwise it goes upstream over the length limit.
    if (part.length > maxChunkLength) {
      for (let i = 0; i < part.length; i += maxChunkLength) {
        const slice = part.slice(i, i + maxChunkLength);
        if (slice.length === maxChunkLength) {
          if (slice.trim()) chunks.push(slice.trim());
        } else {
          currentChunk = slice; // keep the tail open for the next segment
        }
      }
    } else {
      currentChunk = part;
    }
  }
  flush();
  return chunks.filter((chunk) => chunk.length > 0);
}
function cleanText(text, options) {
  let cleanedText = text;
  // Markdown must run before URL stripping: the URL regex is greedy over non-space, so
  // on `[docs](https://x.com/a)` it would swallow the closing paren and leave `[docs](`,
  // which reads aloud as bracket noise. Extracting the link text first turns it into
  // `docs`, and any bare URL left over is removed in the URL pass below.
  if (options.remove_markdown) {
    // 定界符用「排除自身的字符类」而不是 .*? / .+? —— 这是 ReDoS 防线，不是风格偏好。
    // 懒量词并不免疫灾难性回溯：`\[(.*?)\]\(.*?\)` 遇到 "![](" 重复 N 次这种畸形输入时，
    // 每个 `[` 都是一个候选起点，而 `.*?` 会为每个起点逐字符扩张去找 `](`，匹配到了 `\)`
    // 又失败、回溯再扩张，复杂度是超线性的。实测 4KB 输入 656ms、8KB 4.7s、16KB 36s，
    // 而 Workers 的 CPU 上限是 10ms —— 一个远小于 MAX_BODY_BYTES 的请求就能打爆 Worker。
    // 换成 [^\]]* / [^)]* 后引擎无法跨越定界符扩张，16KB 从 36156ms 降到 42ms（863 倍），
    // 且对合法 Markdown 的输出逐例一致（见 test/unit/redos.test.mjs 的等价性断言）。
    cleanedText = cleanedText.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    cleanedText = cleanedText.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    cleanedText = cleanedText.replace(/(\*\*|__)(.*?)\1/g, "$2");
    // Single * / _ emphasis. The underscore form requires non-word boundaries so it
    // doesn't eat delimiters inside snake_case identifiers (my_func_name → my_func_name).
    cleanedText = cleanedText.replace(/\*(?!\s)(.+?)\*/g, "$1");
    // 同上：(.+?) 换成 ([^_]+)，否则 " _a" 重复 N 次时 48KB 要 322ms。
    cleanedText = cleanedText.replace(/(^|[^\w])_(?!\s)([^_]+)_(?![\w])/g, "$1$2");
    cleanedText = cleanedText.replace(/`{1,3}(.*?)`{1,3}/g, "$1");
    cleanedText = cleanedText.replace(/#{1,6}\s/g, "");
  }
  if (options.remove_urls) {
    cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, "");
  }
  if (options.custom_keywords) {
    const keywords = options.custom_keywords.split(",").map((k) => k.trim()).filter((k) => k);
    if (keywords.length > 0) {
      const escapedKeywords = keywords.map(
        (k) => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
      );
      const regex = new RegExp(escapedKeywords.join("|"), "g");
      cleanedText = cleanedText.replace(regex, "");
    }
  }
  if (options.remove_emoji) {
    cleanedText = cleanedText.replace(/\p{Emoji_Presentation}/gu, "");
  }
  if (options.remove_citation_numbers) {
    cleanedText = cleanedText.replace(/\s\d{1,2}(?=[.。，,;；:：]|$)/g, "");
  }
  if (options.remove_line_breaks) {
    cleanedText = cleanedText.replace(/\s+/g, " ");
  }
  return cleanedText.trim();
}
/**
 * code -> 出错的请求字段。OpenAI 的错误结构里 param 就是干这个的，而我们此前 26 个错误
 * 出口全都硬写 `param: null`。
 *
 * 为什么用映射而不是给 errorResponse 加第 6 个参数：有两个 code 各自服务两种不同原因
 * （`invalid_request_error` = body 不是 JSON / input 字段缺失；`invalid_cleaning_options`
 * = 容器类型错 / custom_keywords 类型错），调用方光看 code 分辨不出该改哪个字段。改 code
 * 会破坏既有调用方（测试也钉着它们），而补 param 是**纯新增**：老调用方读不到就当没有，
 * 新调用方能精确定位。一处映射即可，26 个调用点一行都不用动。
 *
 * 没有对应字段的（如 internal_server_error、not_found）留空 -> 仍然是 null。
 */
var ERROR_PARAM = {
  input_too_long: "input",
  invalid_voice: "voice",
  invalid_speed: "speed",
  invalid_pitch: "pitch",
  invalid_style: "style",
  invalid_response_format: "response_format",
  invalid_stream: "stream",
  invalid_cleaning_options: "cleaning_options",
  input_empty_after_cleaning: "input",
  too_many_chunks: "chunk_size",
  stream_format_not_chunkable: "response_format",
  opus_requires_single_chunk: "response_format",
  payload_too_large: "input",
  invalid_api_key: "Authorization",
  upstream_rejected_request: "voice",
};

// extraHeaders 供个别状态码补必需的响应头（如 405 的 Allow，RFC 9110 要求）。
// 放在最后一个参数是为了不动既有的 (message, status, code) 三参调用点。
function errorResponse(message, status, code, type = "api_error", extraHeaders = null, param = undefined) {
  return new Response(
    JSON.stringify({
      // 显式传入的 param 优先：ERROR_PARAM 是按 code 查的，而有两个 code 各服务两种原因
      // （见上），那时只有调用点自己知道是哪个字段。
      error: { message, type, param: param ?? ERROR_PARAM[code] ?? null, code }
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...makeCORSHeaders(), ...(extraHeaders || {}) }
    }
  );
}
function makeCORSHeaders(extraHeaders = "Content-Type, Authorization") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": extraHeaders,
    "Access-Control-Max-Age": "86400"
  };
}
// HTML UI is injected at build time from ui/index.html
function getHtmlContent() {
  return UI_HTML;
}

export default workers_default;

// Exported for unit tests; not part of the HTTP surface.
export const __test__ = {
  LIMITS,
  VOICE_RE,
  STYLE_RE,
  clamp,
  timingSafeEqual,
  escapeXmlAttr,
  getSsml,
  voiceDisplayName,
  mergeWebmChunks,
  parseWebmChunk,
  smartChunkText,
  cleanText,
  // Reset the module-level token cache so tests are order-independent.
  resetTokenCache() {
    tokenInfo = { endpoint: null, token: null, expiredAt: null };
    tokenRefreshInFlight = null;
  },
  // Same for the voice-list cache — without this a test that populated it would
  // silently satisfy the next test's "does it hit upstream?" assertion.
  resetVoicesCache() {
    voicesCache = { models: null, fetchedAt: 0 };
    voicesInFlight = null;
  },
  // Make the cache look expired while KEEPING the data, so tests can exercise the
  // "upstream is down, serve stale" path (clearing it would take the fallback branch).
  expireVoicesCache() {
    voicesCache = { models: voicesCache.models, fetchedAt: 0 };
    voicesInFlight = null;
  },
  VOICES_TTL_MS,
  MODELS_CACHE_SECONDS,
};
