// Edge TTS WebSocket Worker - streaming version (NDJSON)
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VER = '143.0.3650.75';
const MAJOR = CHROMIUM_VER.split('.')[0];
const WSS_BASE = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

function uuid() { return crypto.randomUUID().replace(/-/g, ''); }
function muid() { return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(); }
function dateStr() { return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)'); }

async function secMsGec() {
  let ticks = Date.now() / 1000 + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ticks.toFixed(0)}${TOKEN}`));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function cors(extra = {}) {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', ...extra };
}

function mkssml(text, voice, rate) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escaped}</prosody></voice></speak>`;
}

function b64(buf) {
  let s = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405, headers: cors() });

    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors() }); }

    const text = body.input || '';
    const voice = body.voice || 'en-US-AvaNeural';
    const speed = body.speed ?? 1.0;
    const stream = body.stream ?? false;
    if (!text) return Response.json({ error: 'Missing input' }, { status: 400, headers: cors() });

    const rate = speed >= 1 ? `+${Math.round((speed - 1) * 100)}%` : `-${Math.round((1 - speed) * 100)}%`;
    const connId = uuid();
    const gec = await secMsGec();
    const url = `${WSS_BASE}?TrustedClientToken=${TOKEN}&ConnectionId=${connId}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-${CHROMIUM_VER}`;

    let wsResp;
    try {
      wsResp = await fetch(url, {
        headers: {
          'Upgrade': 'websocket',
          'Pragma': 'no-cache',
          'Cache-Control': 'no-cache',
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
          'Cookie': `muid=${muid()};`,
        }
      });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: cors() });
    }

    const ws = wsResp.webSocket;
    if (!ws) return Response.json({ error: 'WebSocket upgrade failed' }, { status: 502, headers: cors() });
    ws.accept();

    // Send config + SSML
    ws.send(
      `X-Timestamp:${dateStr()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
    );
    ws.send(
      `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateStr()}Z\r\nPath:ssml\r\n\r\n` +
      mkssml(text, voice, rate)
    );

    // --- Non-streaming mode: collect all, return JSON ---
    if (!stream) {
      const audioChunks = [];
      const timestamps = [];
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 30000);
        ws.addEventListener('message', (evt) => {
          if (typeof evt.data === 'string') {
            const sep = evt.data.indexOf('\r\n\r\n');
            if (sep < 0) return;
            const hdr = evt.data.substring(0, sep);
            const dat = evt.data.substring(sep + 4);
            if (hdr.includes('Path:audio.metadata')) {
              try {
                const md = JSON.parse(dat).Metadata?.[0];
                if (md?.Type === 'WordBoundary') timestamps.push({ text: md.Data.text.Text, offset: md.Data.Offset / 10000, duration: md.Data.Duration / 10000 });
              } catch {}
            } else if (hdr.includes('Path:turn.end')) { clearTimeout(timeout); resolve(); }
          } else if (evt.data instanceof ArrayBuffer) {
            const headerLen = new DataView(evt.data).getUint16(0);
            const audio = evt.data.slice(2 + headerLen);
            if (audio.byteLength > 0) audioChunks.push(audio);
          }
        });
        ws.addEventListener('close', () => { clearTimeout(timeout); resolve(); });
      });
      ws.close();
      const total = audioChunks.reduce((s, c) => s + c.byteLength, 0);
      const combined = new Uint8Array(total);
      let off = 0;
      for (const c of audioChunks) { combined.set(new Uint8Array(c), off); off += c.byteLength; }
      return Response.json({ audio: b64(combined.buffer), content_type: 'audio/mpeg', timestamps }, { headers: cors() });
    }

    // --- Streaming mode: NDJSON ---
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
      const timeout = setTimeout(() => { ws.close(); }, 30000);
      ws.addEventListener('message', async (evt) => {
        try {
          if (typeof evt.data === 'string') {
            const sep = evt.data.indexOf('\r\n\r\n');
            if (sep < 0) return;
            const hdr = evt.data.substring(0, sep);
            const dat = evt.data.substring(sep + 4);
            if (hdr.includes('Path:audio.metadata')) {
              const md = JSON.parse(dat).Metadata?.[0];
              if (md?.Type === 'WordBoundary') {
                await writer.write(enc.encode(JSON.stringify({ type: 'word', text: md.Data.text.Text, offset: md.Data.Offset / 10000, duration: md.Data.Duration / 10000 }) + '\n'));
              }
            } else if (hdr.includes('Path:turn.end')) {
              clearTimeout(timeout);
              await writer.write(enc.encode(JSON.stringify({ type: 'done' }) + '\n'));
              await writer.close();
              ws.close();
            }
          } else if (evt.data instanceof ArrayBuffer) {
            const headerLen = new DataView(evt.data).getUint16(0);
            const audio = evt.data.slice(2 + headerLen);
            if (audio.byteLength > 0) {
              await writer.write(enc.encode(JSON.stringify({ type: 'audio', data: b64(audio) }) + '\n'));
            }
          }
        } catch {}
      });
      ws.addEventListener('close', async () => {
        clearTimeout(timeout);
        try { await writer.close(); } catch {}
      });
      ws.addEventListener('error', async () => {
        clearTimeout(timeout);
        try { await writer.close(); } catch {}
      });
    })();

    return new Response(readable, {
      headers: { ...cors(), 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' }
    });
  }
};
