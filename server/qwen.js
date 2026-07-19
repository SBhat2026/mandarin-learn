// Laoshi — the in-app Mandarin teacher, powered by Qwen. Runs locally via Ollama
// (qwen2.5:7b-instruct) and falls back to Alibaba DashScope's OpenAI-compatible
// API only if the local model is unavailable. Qwen is NOT a general chatbot: it
// is prompted to behave as a patient teacher who converses within the learner's
// known vocabulary, corrects gently, and reinforces prior material.
import 'dotenv/config';

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
function laoshiSystem({ knownWords = [], focusWords = [], scene = 'free chat', level = 'beginner' }) {
  const known = knownWords.slice(0, 400).join(' ');
  const focus = focusWords.join(' ');
  return [
    'You are 老师 (Lǎoshī), a warm, patient Mandarin teacher for a ' + level + ' learner who wants to SPEAK and READ (no handwriting).',
    'Speak mostly in simple Mandarin the learner can understand. Keep turns SHORT (1–2 sentences).',
    'Comprehensible input rule: build sentences almost entirely from the KNOWN words below; introduce at most one or two new words per turn and make their meaning obvious from context.',
    focus ? `Gently work these target words into the conversation when natural: ${focus}.` : '',
    'When the learner makes a mistake, model the correct form naturally rather than lecturing.',
    'Ask a simple question most turns to keep them talking. Never switch to being a generic AI assistant; stay in character as their teacher.',
    'ALWAYS respond as strict JSON: {"hanzi": "...", "pinyin": "...", "english": "...", "note": "optional short tip or correction in English"}.',
    `Scene: ${scene}.`,
    known ? `KNOWN words the learner has studied: ${known}` : 'The learner is a true beginner; use only the most basic words.',
  ].filter(Boolean).join('\n');
}

// One teacher turn. Returns {hanzi, pinyin, english, note, via}.
export async function laoshiReply({ history = [], userText = '', context = {} }) {
  const messages = [
    { role: 'system', content: laoshiSystem(context) },
    ...history.slice(-8).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  ];
  if (userText) messages.push({ role: 'user', content: userText });
  const { text, via } = await chat(messages, { temperature: 0.6, max_tokens: 400 });
  let parsed;
  try {
    // qwen3 models may emit a <think>…</think> preamble — strip it before parsing.
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const start = cleaned.search(/\{/);
    const end = cleaned.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
  } catch {
    parsed = { hanzi: text.trim(), pinyin: '', english: '', note: '' };
  }
  return { ...parsed, via };
}
