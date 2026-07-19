// Laoshi — the in-app Mandarin teacher, powered by Qwen. Runs locally via Ollama
// (qwen2.5:7b-instruct) and falls back to Alibaba DashScope's OpenAI-compatible
// API only if the local model is unavailable. Qwen is NOT a general chatbot: it
// is prompted to behave as a patient teacher who converses within the learner's
// known vocabulary, corrects gently, and reinforces prior material.
import 'dotenv/config';
import { pinyinForHanzi, glossForHanzi } from './pronunciation.js';

// Keep only Chinese characters (+ CJK punctuation) in the hanzi field, so a
// non-JSON model reply never leaks pinyin/English into the spoken text or the
// hanzi bubble. TTS then reads the Mandarin once — nothing else.
function cjkOnly(s = '') {
  return String(s).replace(/[^㐀-鿿　-〿＀-￯]/g, '').trim();
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.QWEN_MODEL || 'qwen3.5:latest';
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus';

async function withTimeout(promise, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await promise(ctl.signal); } finally { clearTimeout(t); }
}

export async function ollamaUp() {
  try {
    const r = await withTimeout(sig => fetch(`${OLLAMA_URL}/api/tags`, { signal: sig }), 800);
    return r.ok;
  } catch { return false; }
}

// Low-level chat completion. Tries Ollama, then DashScope. Returns assistant text.
export async function chat(messages, { temperature = 0.6, max_tokens = 512 } = {}) {
  // 1) local Ollama
  if (await ollamaUp()) {
    try {
      const r = await withTimeout(sig => fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', signal: sig,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false, think: false,
          options: { temperature, num_predict: max_tokens } }),
      }), 60000);
      if (r.ok) { const d = await r.json(); return { text: d.message?.content ?? '', via: 'ollama' }; }
    } catch (e) { /* fall through to cloud */ }
  }
  // 2) DashScope fallback
  const key = process.env.DASHSCOPE_API_KEY;
  if (key) {
    const r = await fetch(DASHSCOPE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: DASHSCOPE_MODEL, messages, temperature, max_tokens }),
    });
    if (r.ok) { const d = await r.json(); return { text: d.choices?.[0]?.message?.content ?? '', via: 'dashscope' }; }
    throw new Error(`DashScope ${r.status}`);
  }
  throw new Error('No Qwen backend available (start Ollama or set DASHSCOPE_API_KEY)');
}

export async function available() {
  return (await ollamaUp()) || Boolean(process.env.DASHSCOPE_API_KEY);
}

// Build the teacher system prompt constrained to the learner's known vocabulary,
// so every teacher turn is comprehensible input (mostly known + ≤1-2 new items).
function laoshiSystem({ knownWords = [], focusWords = [], scene = 'free chat', level = 'beginner', persona = '' }) {
  const known = knownWords.slice(0, 400).join(' ');
  const focus = focusWords.join(' ');
  return [
    'You are 老师 (Lǎoshī), a warm, patient Mandarin teacher for a ' + level + ' learner who wants to SPEAK and READ (no handwriting).',
    'Speak mostly in simple Mandarin the learner can understand. Keep turns SHORT (1–2 sentences).',
    'Comprehensible input rule: build sentences almost entirely from the KNOWN words below; introduce at most one or two new words per turn and make their meaning obvious from context.',
    focus ? `Gently work these target words into the conversation when natural: ${focus}.` : '',
    persona || '',
    'When the learner makes a mistake, model the correct form naturally rather than lecturing.',
    'Ask a simple question most turns to keep them talking. Never switch to being a generic AI assistant; stay in character as their teacher.',
    'ALWAYS respond as strict JSON: {"hanzi": "...", "pinyin": "...", "english": "...", "note": "optional short tip or correction in English"}.',
    'CRITICAL: "hanzi" MUST be Chinese characters only (never romanization); "pinyin" MUST be the matching romanization.',
    'The learner leans on pinyin and English — EVERY reply MUST include full pinyin with tone marks AND a natural English translation. Never leave them empty.',
    `Scene: ${scene}.`,
    known ? `KNOWN words the learner has studied: ${known}` : 'The learner is a true beginner; use only the most basic words.',
  ].filter(Boolean).join('\n');
}

// Lesson-conductor system prompt. Laoshi runs a mini-lesson around ONE focal
// concept and its neighborhood, reusing target vocabulary, surfacing related
// characters naturally, and adapting its script to the learner's reading level.
function conductorSystem({ plan, knownWords = [], persona = '' }) {
  const target = (plan.targetVocab || []).map(v => `${v.hanzi} (${v.pinyin}) = ${v.gloss}`).join('; ');
  const focal = plan.focal;
  const families = (plan.patterns || []).flatMap(p => [p.semantic?.lesson, p.phonetic?.lesson].filter(Boolean)).slice(0, 3);
  const known = knownWords.slice(0, 300).join(' ');
  return [
    'You are 老师 (Lǎoshī), a warm Mandarin teacher running a short, live mini-lesson — NOT a generic assistant.',
    `Today's focal concept: ${focal.hanzi} (${focal.pinyin}) = ${focal.gloss}.`,
    target && `Weave these connected words into the conversation naturally, reusing them more than once: ${target}.`,
    families.length ? `When it fits, reinforce these patterns in passing: ${families.join(' ')}` : '',
    persona || '',
    plan.scriptDirective || 'Write primarily in pinyin with supporting hanzi.',
    'Comprehensible input: build turns almost entirely from KNOWN words + the target words; introduce at most one new idea per turn and make its meaning obvious.',
    'Keep every turn SHORT (1–2 sentences) and end most turns with a simple question so the learner keeps talking.',
    'Model corrections naturally instead of lecturing. Stay fully in character as their teacher.',
    'ALWAYS respond as strict JSON: {"hanzi":"...","pinyin":"...","english":"...","note":"optional short English tip/correction"}.',
    'CRITICAL: "hanzi" MUST contain Chinese characters only (never romanization); "pinyin" MUST contain the matching romanization with tone marks. Never put pinyin in the hanzi field.',
    (plan.scriptLevel ?? 0) < 0.5
      ? 'The learner CANNOT read hanzi yet — they rely on pinyin and English. EVERY reply MUST include full pinyin with tone marks AND a natural English translation. Never leave "pinyin" or "english" empty.'
      : 'Always fill "pinyin" and "english"; the learner may still lean on them.',
    `Scene: ${plan.scene || 'everyday conversation'}.`,
    known ? `KNOWN words: ${known}` : 'The learner is a true beginner; use only the most basic words.',
  ].filter(Boolean).join('\n');
}

// One conductor turn within a lesson. Returns {hanzi, pinyin, english, note, via}.
export async function laoshiLesson({ plan, history = [], userText = '', knownWords = [], persona = '' }) {
  const messages = [
    { role: 'system', content: conductorSystem({ plan, knownWords, persona }) },
    ...history.slice(-10).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  ];
  if (userText) messages.push({ role: 'user', content: userText });
  return parseTeacher(await chat(messages, { temperature: 0.6, max_tokens: 400 }));
}

// Extract every top-level {...} object from a string (qwen3 sometimes emits one
// JSON object per sentence instead of a single reply).
function extractObjects(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json\s*/gi, '').replace(/```/g, '');
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(clean.slice(start, i + 1))); } catch {} start = -1; } }
  }
  return objs;
}

function parseTeacher({ text, via }) {
  const objs = extractObjects(text);
  // No JSON at all: salvage just the Chinese so the bubble/TTS stay clean, and
  // synthesize pinyin from it (English can't be recovered, but pinyin can).
  if (!objs.length) {
    const hanzi = cjkOnly(text);
    return { hanzi, pinyin: hanzi ? pinyinForHanzi(hanzi) : '', english: '', note: '', via };
  }
  // Merge multiple sentence-objects into one turn.
  const merged = objs.reduce((a, o) => ({
    hanzi: (a.hanzi || '') + (o.hanzi || ''),
    pinyin: [a.pinyin, o.pinyin].filter(Boolean).join(' '),
    english: [a.english, o.english].filter(Boolean).join(' '),
    note: a.note || o.note || '',
  }), {});
  // Never let romanization/English contaminate the hanzi field (spoken + shown).
  merged.hanzi = cjkOnly(merged.hanzi);
  // Beginners read the pinyin, not the characters — so it must ALWAYS be present.
  // Trust the model's pinyin when it gave one (it keeps proper tone marks and
  // word spacing); only synthesize from the hanzi when it's missing entirely.
  if (merged.hanzi && !merged.pinyin.trim()) {
    const derived = pinyinForHanzi(merged.hanzi);
    if (derived) merged.pinyin = derived;
  }
  // A beginner should never get a reply with no English. Fall back to a gloss
  // scaffold when the model omits it.
  if (merged.hanzi && !merged.english) {
    const g = glossForHanzi(merged.hanzi);
    if (g) merged.english = g;
  }
  return { ...merged, via };
}

// One teacher turn. Returns {hanzi, pinyin, english, note, via}.
export async function laoshiReply({ history = [], userText = '', context = {} }) {
  const messages = [
    { role: 'system', content: laoshiSystem(context) },
    // context may carry a persona directive (see index.js).
    ...history.slice(-8).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  ];
  if (userText) messages.push({ role: 'user', content: userText });
  return parseTeacher(await chat(messages, { temperature: 0.6, max_tokens: 400 }));
}
