// workers.js
var DEFAULT_CONCURRENCY = 10;
var DEFAULT_CHUNK_SIZE = 300;

// All tunable bounds live here rather than as magic numbers at the call sites.
var LIMITS = {
  MAX_INPUT_CHARS: 50000,
  MIN_SPEED: 0.25,
  MAX_SPEED: 4,
  MIN_PITCH: 0.5,
  MAX_PITCH: 1.5,
  MIN_CONCURRENCY: 1,
  MAX_CONCURRENCY: 20,
  MIN_CHUNK_SIZE: 50,
  MAX_CHUNK_SIZE: 2000,
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
var workers_default = {
  async fetch(request, env, ctx) {
    return await handleRequest(request, env);
  }
};
async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return handleOptions(request);
  const url = new URL(request.url);
  if (url.pathname === "/v1/models/public") return await handlePublicModelsRequest();
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(getHtmlContent(), {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "public, max-age=86400"
        // 缓存1d
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
  try {
    if (url.pathname === "/v1/audio/speech") return await handleSpeechRequest(request);
    if (url.pathname === "/v1/models") return await handleModelsRequest(request);
  } catch (err) {
    console.error("请求处理器错误:", err);
    return errorResponse(err.message, 500, "internal_server_error");
  }
  return errorResponse("未找到", 404, "not_found");
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
  const headers = makeCORSHeaders(request.headers.get("Access-Control-Request-Headers"));
  return new Response(null, { status: 204, headers });
}
async function handleSpeechRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("不允许的方法", 405, "method_not_allowed");
  }
  let requestBody;
  try {
    requestBody = await request.json();
  } catch {
    return errorResponse("请求体不是合法 JSON", 400, "invalid_request_error");
  }
  if (typeof requestBody?.input !== "string" || !requestBody.input.trim()) {
    return errorResponse("'input' 是必需参数，且必须为非空字符串", 400, "invalid_request_error");
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
  const cleanedInput = cleanText(input, finalCleaningOptions);
  if (!cleanedInput) {
    return errorResponse("文本清理后为空，请检查 cleaning_options", 400, "input_empty_after_cleaning");
  }

  // OpenAI-style aliases ("shimmer", "alloy", ...) map to real Microsoft voice names.
  // Resolve the alias whenever one is given, not only when `voice` is absent.
  const finalVoice = OPENAI_VOICE_MAP[voice] || OPENAI_VOICE_MAP[model.replace("tts-1-", "")] || voice;
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
  const FORMAT_MAP = {
    "mp3": "audio-24khz-48kbitrate-mono-mp3",
    "pcm": "raw-24khz-16bit-mono-pcm",
    "opus": "webm-24khz-16bit-mono-opus",
    "aac": "audio-24khz-96kbitrate-mono-aac",
    "flac": "audio-48khz-96kbitrate-stereo-flac",
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
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav"
  };
  const contentType = CONTENT_TYPE_MAP[response_format];
  const textChunks = smartChunkText(cleanedInput, safeChunkSize);
  if (textChunks.length === 0) {
    return errorResponse("文本分块结果为空", 400, "input_empty_after_cleaning");
  }
  const ttsArgs = [finalVoice, rate, finalPitch, style, outputFormat, contentType];
  if (stream) {
    return await streamVoice(textChunks, safeConcurrency, ...ttsArgs);
  } else {
    return await getVoice(textChunks, safeConcurrency, ...ttsArgs);
  }
}

// Coerce a numeric option into range; falls back to `fallback` for non-numeric input.
function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
async function handlePublicModelsRequest() {
  try {
    const response = await fetch("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4");
    if (!response.ok) {
      throw new Error("Failed to fetch voices from EdgeTTS");
    }
    const voices = await response.json();
    const models = voices.map((voice) => ({
      id: voice.ShortName,
      object: "model",
      created: Date.now(),
      owned_by: "microsoft",
      language: voice.Locale,
      gender: voice.Gender,
      description: `${voice.LocalName} - ${voice.Gender}`
    }));
    return new Response(JSON.stringify(models), {
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    });
  } catch (error) {
    console.error("获取语音列表失败:", error);
    return errorResponse("Failed to fetch voices", 500, "fetch_error");
  }
}
async function handleModelsRequest(request) {
  try {
    const response = await fetch("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4");
    if (!response.ok) {
      throw new Error("Failed to fetch voices from EdgeTTS");
    }
    const voices = await response.json();
    let models = voices.map((voice) => ({
      id: voice.ShortName,
      object: "model",
      created: Date.now(),
      owned_by: "microsoft",
      language: voice.Locale,
      gender: voice.Gender,
      description: `${voice.LocalName} - ${voice.Gender}`
    }));
    const url = new URL(request.url);
    const filterNeural = url.searchParams.get("neural");
    const filterMultilingual = url.searchParams.get("multilingual");
    if (filterNeural === "true" || filterNeural === "1") {
      models = models.filter((m) => m.id.includes("Neural"));
    }
    if (filterMultilingual === "true" || filterMultilingual === "1") {
      models = models.filter((m) => m.id.includes("Multilingual"));
    }
    return new Response(JSON.stringify(models), {
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    });
  } catch (error) {
    console.error("获取语音列表失败:", error);
    const fallbackModels = [
      { id: "zh-CN-XiaoxiaoNeural", object: "model", created: Date.now(), owned_by: "microsoft", language: "zh-CN", gender: "Female", description: "晓晓 - 温柔女声" },
      { id: "zh-CN-YunxiNeural", object: "model", created: Date.now(), owned_by: "microsoft", language: "zh-CN", gender: "Male", description: "云希 - 阳光男声" }
    ];
    return new Response(JSON.stringify(fallbackModels), {
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    });
  }
}
async function streamVoice(textChunks, concurrency, ...ttsArgs) {
  const { readable, writable } = new TransformStream();
  const contentType = ttsArgs[5] || "audio/mpeg";
  pipeChunksToStream(writable.getWriter(), textChunks, concurrency, ...ttsArgs).catch((error) => console.error("流式 TTS 失败:", error));
  return new Response(readable, {
    headers: { "Content-Type": contentType, ...makeCORSHeaders() }
  });
}
async function pipeChunksToStream(writer, chunks, concurrency, ...ttsArgs) {
  // Sliding-window prefetch: keep `concurrency` synthesis requests in flight while
  // writing results strictly in order. The previous implementation awaited each chunk
  // sequentially, so the `concurrency` argument had no effect and long inputs were
  // bottlenecked on round-trip latency per chunk.
  const inFlight = new Map();
  let aborted = false;

  const schedule = (index) => {
    if (index >= chunks.length) return;
    inFlight.set(
      index,
      getAudioChunk(chunks[index], ...ttsArgs).then((blob) => blob.arrayBuffer())
    );
  };

  try {
    const window = Math.max(1, Math.min(concurrency, chunks.length));
    for (let i = 0; i < window; i++) schedule(i);

    for (let i = 0; i < chunks.length; i++) {
      const buffer = await inFlight.get(i);
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
    // Swallow rejections from prefetches we abandoned, so they don't surface as
    // unhandled promise rejections in the Workers runtime.
    for (const pending of inFlight.values()) pending.catch(() => {});
    if (!aborted) inFlight.clear();
  }
}
async function getVoice(textChunks, concurrency, ...ttsArgs) {
  const allAudioBlobs = [];
  const contentType = ttsArgs[5] || "audio/mpeg";
  try {
    for (let i = 0; i < textChunks.length; i += concurrency) {
      const batch = textChunks.slice(i, i + concurrency);
      const audioPromises = batch.map((chunk) => getAudioChunk(chunk, ...ttsArgs));
      const audioBlobs = await Promise.all(audioPromises);
      allAudioBlobs.push(...audioBlobs);
    }
    const concatenatedAudio = new Blob(allAudioBlobs, { type: contentType });
    return new Response(concatenatedAudio, {
      headers: { "Content-Type": contentType, ...makeCORSHeaders() }
    });
  } catch (error) {
    console.error("非流式 TTS 失败:", error);
    return errorResponse(error.message, 500, "tts_generation_error");
  }
}
var MAX_CHUNK_ATTEMPTS = 3;

async function getAudioChunk(text, voiceName, rate, pitch, style, outputFormat, contentType) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    try {
      // A 401 means the cached token expired mid-request; force a refresh before retrying.
      const endpoint = await getEndpoint({ forceRefresh: attempt > 1 && lastError?.status === 401 });
      const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const ssml = getSsml(text, voiceName, rate, pitch, style);
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
        const err = new Error(
          `Edge TTS API 错误: ${response.status} ${response.statusText} - ${errorText}`
        );
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
      console.warn(`分块合成第 ${attempt} 次失败（${status ?? "network"}），重试中`);
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
    if (tokenInfo.token) {
      console.log("使用过期的缓存 Token 作为备用");
      return tokenInfo.endpoint;
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
  const breakTagRegex = /<break\s+time="[^"]*"\s*\/?>|<break\s*\/?>|<break\s+time='[^']*'\s*\/?>/gi;
  const breakTags = [];
  const processedText = text.replace(breakTagRegex, (match) => {
    const placeholder = `__BREAK_${nonce}_${breakTags.length}__`;
    breakTags.push(match);
    return placeholder;
  });
  const sanitizedText = processedText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let finalText = sanitizedText;
  breakTags.forEach((tag, index) => {
    finalText = finalText.replace(`__BREAK_${nonce}_${index}__`, tag);
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

  const sentences = text.split(/([.?!,;:\n。？！，；：\r]+)/g);
  for (const part of sentences) {
    if (currentChunk.length + part.length <= maxChunkLength) {
      currentChunk += part;
      continue;
    }
    flush();
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
  if (options.remove_urls) {
    cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, "");
  }
  if (options.remove_markdown) {
    cleanedText = cleanedText.replace(/!\[.*?\]\(.*?\)/g, "");
    cleanedText = cleanedText.replace(/\[(.*?)\]\(.*?\)/g, "$1");
    cleanedText = cleanedText.replace(/(\*\*|__)(.*?)\1/g, "$2");
    cleanedText = cleanedText.replace(/(\*|_)(.*?)\1/g, "$2");
    cleanedText = cleanedText.replace(/`{1,3}(.*?)`{1,3}/g, "$1");
    cleanedText = cleanedText.replace(/#{1,6}\s/g, "");
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
function errorResponse(message, status, code, type = "api_error") {
  return new Response(
    JSON.stringify({
      error: { message, type, param: null, code }
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
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
  smartChunkText,
  cleanText,
};
