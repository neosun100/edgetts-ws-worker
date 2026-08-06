// 全音色空音频普查。两个独立问题:
//   A) 有没有音色连**自己语种**的文本都合成不出来?(322 次)
//   B) 「零覆盖」的规律是什么?用每个书写系统一个代表音色跑 9x9 交叉矩阵(~81 次)
// 结果落盘到 docs/research/,不只靠 stdout。
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.EDGETTS_KEY;
const URL_ = 'https://edgetts.aws.xin/v1/audio/speech';
if (!KEY) { console.error('缺少 EDGETTS_KEY'); process.exit(1); }

const VOICES_PATH = process.env.VOICES_JSON || '/tmp/voices.json';
const voices = JSON.parse(readFileSync(VOICES_PATH, 'utf8'));

// 按 LANGUAGE 给母语文本,不按「书写系统组」。
// 第一版把 bn/ta/te/kn/ml/si/gu 全归为 "Indic" 并统一送天城文 —— 那是我的错:
// 这些语言各有自己的字母。结果 30 个「失败」全部是我送错了文字,不是产品缺陷。
// 教训:分组前先确认组内成员真的共用同一套字母。
const NATIVE = {
  zh: '你好，这是一句简短的测试文本。', yue: '你好，這是一句測試文字。',
  ja: 'こんにちは、これはテスト文です。', ko: '안녕하세요, 이것은 테스트 문장입니다.',
  ar: 'مرحبا، هذه جملة اختبار قصيرة.', fa: 'سلام، این یک جمله آزمایشی است.',
  ur: 'ہیلو، یہ ایک ٹیسٹ جملہ ہے۔', ps: 'سلام، دا یو ازموینې جمله ده.',
  he: 'שלום, זהו משפט בדיקה קצר.',
  hi: 'नमस्ते, यह एक छोटा परीक्षण वाक्य है।', mr: 'नमस्कार, हे एक चाचणी वाक्य आहे.',
  ne: 'नमस्ते, यो एक परीक्षण वाक्य हो।',
  bn: 'হ্যালো, এটি একটি পরীক্ষার বাক্য।', gu: 'નમસ્તે, આ એક પરીક્ષણ વાક્ય છે.',
  ta: 'வணக்கம், இது ஒரு சோதனை வாக்கியம்.', te: 'నమస్కారం, ఇది ఒక పరీక్ష వాక్యం.',
  kn: 'ನಮಸ್ಕಾರ, ಇದು ಒಂದು ಪರೀಕ್ಷಾ ವಾಕ್ಯ.', ml: 'നമസ്കാരം, ഇതൊരു പരീക്ഷണ വാക്യമാണ്.',
  si: 'ආයුබෝවන්, මෙය පරීක්ෂණ වාක්‍යයකි.', pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਇਹ ਇੱਕ ਟੈਸਟ ਵਾਕ ਹੈ।',
  or: 'ନମସ୍କାର, ଏହା ଏକ ପରୀକ୍ଷା ବାକ୍ୟ।', as: 'নমস্কাৰ, এইটো এটা পৰীক্ষা বাক্য।',
  th: 'สวัสดี นี่คือประโยคทดสอบสั้นๆ', km: 'សូស្តី នេះជាប្រយោគសាកល្បង។',
  lo: 'ສະບາຍດີ ນີ້ແມ່ນປະໂຫຍກທົດສອບ.', my: 'မင်္ဂလာပါ၊ ဤသည်စမ်းသပ်ဝါကျဖြစ်သည်။',
  ru: 'Привет, это короткое тестовое предложение.', uk: 'Привіт, це тестове речення.',
  bg: 'Здравейте, това е тестово изречение.', sr: 'Здраво, ово је тест реченица.',
  mk: 'Здраво, ова е тест-изречение.', kk: 'Сәлем, бұл сынақ сөйлемі.',
  mn: 'Сайн байна уу, энэ бол тест юм.', be: 'Прывітанне, гэта тэставы сказ.',
  el: 'Γεια σας, αυτή είναι μια δοκιμαστική πρόταση.',
  hy: 'Բարեւ, սա փորձնական նախադասություն է:',
  ka: 'გამარჯობა, ეს არის ტესტური წინადადება.',
  am: 'ሰላም፣ ይህ የፈተና ዓረፍተ ነገር ነው።',
};
const LATIN = 'Hello, this is a short test sentence.';
const nativeText = (loc) => NATIVE[loc.split('-')[0]] || LATIN;

// 交叉矩阵仍按书写系统抽样(用于回答「零覆盖的规律」)
const SAMPLE = {
  Latin: LATIN, CJK: NATIVE.zh, Arabic: NATIVE.ar, Hebrew: NATIVE.he,
  Devanagari: NATIVE.hi, Tamil: NATIVE.ta, Thai: NATIVE.th,
  Cyrillic: NATIVE.ru, Greek: NATIVE.el,
};

async function hit(voice, text) {
  const t0 = Date.now();
  try {
    const r = await fetch(URL_, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice }),
    });
    const buf = await r.arrayBuffer();
    let code = null;
    if (r.status >= 400) { try { code = JSON.parse(new TextDecoder().decode(buf)).error.code; } catch {} }
    return { status: r.status, bytes: buf.byteLength, code, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, bytes: 0, code: 'fetch_failed:' + e.message.slice(0, 40), ms: Date.now() - t0 };
  }
}

// 并发池,别把上游打爆
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
      done++;
      if (done % 25 === 0) process.stderr.write(`    ...${done}/${items.length}\n`);
    }
  }));
  return out;
}

const mode = process.argv[2];

if (mode === 'native') {
  console.error(`  A) 全部 ${voices.length} 个音色 x 自身书写系统文本`);
  const rows = await pool(voices, 5, async (v) => {
    const text = nativeText(v.language);
    const r = await hit(v.id, text);
    return { voice: v.id, locale: v.language, lang: v.language.split('-')[0],
             hasNativeText: NATIVE[v.language.split('-')[0]] !== undefined,
             multilingual: /Multilingual/i.test(v.id), ...r };
  });
  writeFileSync('/tmp/native.json', JSON.stringify(rows, null, 1));
  const bad = rows.filter((r) => r.bytes === 0 || r.status !== 200);
  console.error(`  完成。异常 ${bad.length}/${rows.length}`);
} else if (mode === 'cross') {
  const scripts = Object.keys(SAMPLE);
  // 每个书写系统挑一个代表音色(用该书写系统的母语音色)
  const PICK = { Latin: 'en-US-AvaNeural', CJK: 'zh-CN-XiaoxiaoNeural', Arabic: 'ar-EG-SalmaNeural',
                 Hebrew: 'he-IL-HilaNeural', Devanagari: 'hi-IN-SwaraNeural', Tamil: 'ta-IN-PallaviNeural',
                 Thai: 'th-TH-PremwadeeNeural', Cyrillic: 'ru-RU-SvetlanaNeural', Greek: 'el-GR-AthinaNeural' };
  const rep = {};
  for (const s of scripts) if (voices.some((v) => v.id === PICK[s])) rep[s] = PICK[s];
  const ava = voices.find((v) => /en-US-AvaMultilingualNeural/.test(v.id));
  if (ava) rep['Latin(Multiling)'] = ava.id;
  const pairs = [];
  for (const [vs, vid] of Object.entries(rep)) for (const ts of scripts) pairs.push({ vs, vid, ts });
  console.error(`  B) ${Object.keys(rep).length} 个代表音色 x ${scripts.length} 种文本 = ${pairs.length} 次`);
  const rows = await pool(pairs, 5, async (p) => ({ voiceScript: p.vs, voice: p.vid, textScript: p.ts, ...(await hit(p.vid, SAMPLE[p.ts])) }));
  writeFileSync('/tmp/cross.json', JSON.stringify(rows, null, 1));
  console.error('  完成。');
}
