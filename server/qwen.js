// Laoshi — the in-app Mandarin teacher, powered by Qwen. Runs locally via Ollama
// (qwen2.5:7b-instruct) and falls back to Alibaba DashScope's OpenAI-compatible
// API only if the local model is unavailable. Qwen is NOT a general chatbot: it
// is prompted to behave as a patient teacher who converses within the learner's
// known vocabulary, corrects gently, and reinforces prior material.
import 'dotenv/config';
import { pinyinForHanzi, glossForHanzi } from './pronunciation.js';
import { buildBlueprint, buildBlueprintLocal } from './director.js';
import { profileForPrompt } from './profile.js';
import { conversationProfile } from './level.js';
import { recordSpend } from './spend.js';

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

// OpenRouter path (Workstream D) — WIRED BUT INERT. Off by default; when off it is
// never called and the resolution order stays Ollama → DashScope. Flip on later by
// setting USE_OPENROUTER=true plus OPENROUTER_API_KEY/OPENROUTER_MODEL. See docs/openrouter.md.
const USE_OPENROUTER = process.env.USE_OPENROUTER === 'true';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-72b-instruct';

// OpenAI-compatible OpenRouter chat. Minimal by design; not reached unless the flag
// is on. TODO(openrouter): activate for remote hosting (see docs/openrouter.md).
async function chatOpenRouter(messages, { temperature = 0.6, max_tokens = 512, json = false, kind = 'conversation' } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    // usage.include asks OpenRouter to report the ACTUAL charged cost, so the
    // spend ledger reflects real billing rather than a local price estimate.
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, temperature, max_tokens,
      usage: { include: true },
      ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
  const d = await r.json();
  if (d.usage?.cost != null) recordSpend(d.usage.cost, { kind });
  return { text: d.choices?.[0]?.message?.content ?? '', via: 'openrouter' };
}

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

// Low-level chat completion. Resolution order OpenRouter (opt-in) → Ollama →
// DashScope. `json: true` requests structured output from every backend that
// supports it (Ollama `format`, OpenAI-compat `response_format`).
export async function chat(messages, { temperature = 0.6, max_tokens = 512, json = false, kind = 'conversation' } = {}) {
  // 0) OpenRouter (opt-in remote) — off unless USE_OPENROUTER=true.
  if (USE_OPENROUTER) {
    try { return await chatOpenRouter(messages, { temperature, max_tokens, json, kind }); }
    catch (e) { /* fall through to local/cloud so a turn always completes */ }
  }
  // 1) local Ollama
  if (await ollamaUp()) {
    try {
      const r = await withTimeout(sig => fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', signal: sig,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false, think: false,
          ...(json ? { format: 'json' } : {}),
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
      body: JSON.stringify({ model: DASHSCOPE_MODEL, messages, temperature, max_tokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (r.ok) { const d = await r.json(); return { text: d.choices?.[0]?.message?.content ?? '', via: 'dashscope' }; }
    throw new Error(`DashScope ${r.status}`);
  }
  throw new Error('No Qwen backend available (start Ollama or set DASHSCOPE_API_KEY)');
}

export async function available() {
  return (await ollamaUp()) || Boolean(process.env.DASHSCOPE_API_KEY);
}

// The hidden conversation lifecycle. Qwen's behavior shifts by stage, but the
// stage itself is NEVER shown to the learner. The turn endpoint advances it.
export const STAGES = ['opening', 'personal_connection', 'explore', 'introduce', 'practice', 'confirm', 'wrap'];

// Derive the current stage from how far the conversation has run against the
// blueprint's exchange budget, plus the hidden shouldWrap signal from momentum/
// completion (Workstream F). Education is woven in the middle; the close is natural.
export function conversationStage({ exchanges = 0, budget = {}, shouldWrap = false } = {}) {
  if (shouldWrap) return 'wrap';
  const [min, max] = Array.isArray(budget.exchanges) ? budget.exchanges : [4, 8];
  if (exchanges <= 0) return 'opening';
  if (exchanges === 1) return 'personal_connection';
  const span = Math.max(max, min + 1);
  const frac = exchanges / span;
  if (frac < 0.45) return 'explore';
  if (frac < 0.6) return 'introduce';
  if (frac < 0.8) return 'practice';
  return 'confirm';
}

// Stage-specific behavior directive. Keeps educational moves invisible and shifts
// Laoshi from personal opening → weaving → production → natural close.
function stageDirective(stage, bp) {
  switch (stage) {
    case 'opening':
      return `This is your FIRST turn — open the conversation. ${bp.openingStrategy} Never ask "what do you want to talk about?".`;
    case 'personal_connection':
      return 'React warmly to what they just said and ask a follow-up about THEM. Build the personal connection before any teaching.';
    case 'explore':
      return 'Explore the topic naturally within their comfort zone. Listen for a natural opening to use a target word later — do not force it yet.';
    case 'introduce':
      return 'If it fits the flow, work in ONE educational opportunity now: use a target word in a context that makes its meaning obvious, WITHOUT flagging it as new.';
    case 'practice':
      return 'Give them room to USE the new material themselves: ask a question that invites them to produce it.';
    case 'confirm':
      return 'Invite one more natural use to lightly confirm they can handle it. Keep it low-stakes and encouraging.';
    case 'wrap':
      return `Wrap up NATURALLY now: ${bp.exitStrategy} Refer back to something you actually talked about, and leave a warm thread for NEXT time (e.g. "下次跟我说说…"). Do NOT re-greet them, do NOT say the lesson is over, and do NOT give a summary or score.`;
    default:
      return '';
  }
}

// Hidden per-turn difficulty nudge (Workstream F). `signal` in [-1,1]: negative =
// the learner is struggling (simplify), positive = breezing (enrich). Never surfaced.
function calibrationDirective(signal) {
  if (typeof signal !== 'number' || Number.isNaN(signal)) return '';
  if (signal <= -0.4) return 'They seem to be finding this hard right now: use SHORTER sentences, only words they clearly know, go a little slower, and add gentle scaffolding. Do not introduce anything new this turn.';
  if (signal >= 0.4) return 'They are handling this easily: you can raise the richness a little — a slightly longer turn or one more new word is fine.';
  return '';
}

// Build the executor system prompt: Qwen PERFORMS the hidden blueprint turn-by-turn,
// owning wording, curiosity, and tone, while the educational objectives stay
// invisible. Replaces the old raw-vocab conductor prompt.
function executorSystem({ blueprint, stage = 'explore', knownWords = [], profileDigest = '', scriptDirective = '', graphSteer = '', conversationMemory = '', profile = null, extraDirective = '' }) {
  const known = knownWords.slice(0, 300).join(' ');
  const opps = (blueprint.educationalOpportunities || []).slice(0, 3)
    .map(o => `${o.objective}${o.vocab?.length ? ' [' + o.vocab.join(' ') + ']' : ''}`).join(' · ');
  const conn = (blueprint.personalConnections || []).slice(0, 3).join('; ');
  const nextRung = (blueprint.questionLadder || [])[0] || 'personal_experience';
  // Mini-narration: a rare comprehensible-input vignette. Offer the option ONLY mid-
  // conversation and phrase it as an at-most-once possibility so it stays sparing.
  const narr = blueprint.microNarration;
  const mayNarrate = narr?.use && (stage === 'explore' || stage === 'introduce')
    ? `You MAY — at most ONCE in this whole conversation, and only if it flows naturally — tell a tiny 1–2 sentence story (${narr.seed}) using words they know, then ask them something about it. If it would feel forced, skip it.`
    : '';
  // A light scene gives production a purpose without becoming a quiz.
  const scene = blueprint.scene && (stage === 'explore' || stage === 'introduce' || stage === 'practice')
    ? `You may lightly set the scene of ${blueprint.scene} so talking has a real purpose — keep it situational and playful, never like an exercise.`
    : '';
  // Live difficulty calibration (Workstream F) — a hidden nudge to simplify or enrich.
  const calib = calibrationDirective(blueprint._calibration);
  // Capability unlock (Workstream G): acknowledge a newly-earned ability in-character,
  // once, early — like a proud teacher, never a badge/score.
  const unlock = blueprint.capabilityUnlock && (stage === 'opening' || stage === 'personal_connection')
    ? `At a natural early moment, warmly note in-character that they can now ${blueprint.capabilityUnlock.name} in Chinese — like a proud teacher (e.g. "你现在能用中文…了，挺厉害!"). Say it ONCE, briefly, then keep chatting. No praise-score.`
    : '';
  return [
    'You are 老师 (Lǎoshī), a warm Mandarin teacher who has an ONGOING relationship with THIS learner. You are continuing that relationship, NOT starting a lesson, and NOT a generic AI assistant.',
    profileDigest ? `What you know about them (let it shape you; never recite it as data): ${profileDigest}` : '',
    `The hidden aim of THIS conversation: ${blueprint.conversationGoal}.`,
    conn ? `Personal hooks you may use: ${conn}.` : '',
    opps ? `Educational opportunities to weave in ONLY when the conversation naturally invites them (never as the subject): ${opps}.` : '',
    `Tone: ${blueprint.tone}.`,
    stageDirective(stage, blueprint),
    unlock,
    scene,
    mayNarrate,
    calib,
    // Vocab-graph continuity (invisible): a naturally-adjacent concept to drift toward.
    graphSteer || '',
    // Conversational memory: refer back to something specific they actually said.
    conversationMemory ? `Earlier in THIS chat they mentioned: ${conversationMemory}. Refer back to one of these naturally when it fits — it shows you were listening.` : '',
    `When you ask a question, prefer a "${nextRung}" style question.`,
    scriptDirective || 'Write primarily in pinyin with supporting hanzi.',
    // WORDING (Workstream C): the 9.7B model tends to reach for literary flourish.
    // Steer it hard toward plain, reusable, learner-first language.
    'WORDING: use SIMPLE, common, everyday words and short natural sentences. Avoid literary, idiomatic, or stylistic flourish and rare vocabulary unless the learner is clearly advanced. Clarity and reusability beat sounding impressive — say things the way a kind teacher would to a beginner.',
    'Comprehensible input: build turns almost entirely from KNOWN words; introduce at most one new idea per turn and make its meaning obvious from context.',
    // Turn size scales with measured level (conversationProfile) — a beginner gets
    // 1-2 short sentences; an advancing learner gets longer, richer turns.
    `${(profile?.turnDirective) || 'Keep every turn SHORT (1–2 sentences).'} Model corrections naturally instead of lecturing. Stay fully in character.`,
    // Human-likeness: sound like a warm friend, not a textbook or a quiz machine.
    'BE HUMAN: react to how they seem to FEEL, not just to the words. Use light, natural backchannels sometimes (嗯、真的？、哈哈、我也是) and small personal reactions. Vary your turns — do NOT ask a question every single time; sometimes just react, share a tiny bit of yourself, or make a warm comment, then let them respond. Let the topic wander naturally the way friends chat.',
    // Communicative production coaching (Workstream I) — the core mechanic: help them
    // SAY WHAT THEY MEAN. Not drills.
    'EXPRESSION-GAP: if the learner asks in English how to say something (e.g. "how do I say I\'m tired?"), teach JUST that phrase simply — give it in hanzi+pinyin+english, invite them to try saying it, and then USE it yourself naturally in your very next line so it sticks.',
    'CIRCUMLOCUTION: if the learner is stuck for a word, FIRST encourage them to say it another way with words they already know ("用你会的词说说看"), and only then offer the target word and gently recast their sentence — training them not to freeze.',
    'RECAST: when they make a mistake, model the correct version naturally inside your reply (a gentle aside in "note" at most) — never grade or lecture.',
    'HARD RULES: never announce a lesson, a topic, or a "new word"; never present vocabulary as the subject; establish the personal connection before teaching; keep them talking — usually (not always) leave an easy opening for them to reply.',
    'NO FABRICATED HISTORY: never invent shared past events or personal facts that are not in the profile above or earlier in THIS conversation (no "did you go to…", "how was your weekend…", "last time you…"). With no real personal hook, open from the concrete here-and-now instead of a made-up memory.',
    'ALWAYS respond as strict JSON: {"hanzi":"...","pinyin":"...","english":"...","note":"optional short English tip/correction"}.',
    'CRITICAL: "hanzi" MUST contain Chinese characters only (never romanization); "pinyin" MUST contain the matching romanization with tone marks. Never put pinyin in the hanzi field.',
    'The "pinyin" and "english" MUST correspond EXACTLY to the characters you wrote in "hanzi" — never romanize or translate a different sentence than the one in "hanzi". If you do not know the word for something, say it a simpler way using words you know rather than inventing one.',
    'The learner leans on pinyin and English — EVERY reply MUST include full pinyin with tone marks AND a natural English translation. Never leave "pinyin" or "english" empty.',
    known ? `KNOWN words the learner has studied: ${known}` : 'The learner is a true beginner; use only the most basic words.',
    // Repair pass: when a previous attempt used out-of-set vocabulary, this names the
    // violations so the regenerated turn stays decodable.
    extraDirective,
  ].filter(Boolean).join('\n');
}

// One executor turn: Qwen speaks the blueprint at the current stage. The single
// code path for BOTH guided lessons and free chat. Returns {hanzi,pinyin,english,note,via}.
// Hardened: JSON mode, one retry on an empty/unparseable reply, and pinyin↔hanzi
// alignment verification (a model that romanized a different sentence gets its
// pinyin re-synthesized from the actual hanzi instead of being trusted).
export async function laoshiConverse({ blueprint, stage = 'explore', history = [], userText = '', knownWords = [], profileDigest = '', scriptDirective = '', graphSteer = '', conversationMemory = '', profile = null, extraDirective = '' }) {
  const prof = profile || conversationProfile();
  const messages = [
    { role: 'system', content: executorSystem({ blueprint, stage, knownWords, profileDigest, scriptDirective, graphSteer, conversationMemory, profile: prof, extraDirective }) },
    ...history.slice(-prof.historyWindow).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  ];
  if (userText) messages.push({ role: 'user', content: userText });
  const opts = { temperature: 0.6, max_tokens: prof.maxTokens, json: true };
  let reply = parseTeacher(await chat(messages, opts));
  if (!reply.hanzi) {
    // One retry with a slightly higher temperature — a blank turn strands the learner.
    reply = parseTeacher(await chat(messages, { ...opts, temperature: 0.8 }));
  }
  return verifyAlignment(reply);
}

// Count Mandarin syllables in a pinyin string (vowel-group heuristic; handles
// unspaced multi-syllable words like "xǐhuan" well enough for a mismatch test).
function syllableCount(pinyin = '') {
  const s = String(pinyin).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = s.match(/[aeiouü](?:[aeiouü])*(?:ng|n|r)?/g);
  return m ? m.length : 0;
}

// The pinyin/english must describe the hanzi actually shown. When the syllable
// count disagrees badly with the character count, the model romanized something
// else — re-derive pinyin from the hanzi (dictionary-backed) rather than trust it.
function verifyAlignment(reply) {
  if (!reply.hanzi) return reply;
  const cjkLen = [...reply.hanzi].filter(c => /[㐀-鿿]/.test(c)).length;
  if (!cjkLen) return reply;
  const syl = syllableCount(reply.pinyin);
  if (Math.abs(syl - cjkLen) > Math.max(1, Math.round(cjkLen * 0.25))) {
    const derived = pinyinForHanzi(reply.hanzi);
    if (derived) reply = { ...reply, pinyin: derived };
  }
  return reply;
}

// Legacy shim: the current /api/lesson/turn hands a plan + persona. Build (or reuse)
// a blueprint for the plan and route through the executor so nothing breaks during
// the migration to the blueprint-native turn endpoint (Workstream E).
export async function laoshiLesson({ plan, history = [], userText = '', knownWords = [], persona = '' }) {
  const blueprint = plan.blueprint || await buildBlueprint(plan, {});
  const exchanges = history.filter(m => m.role === 'user').length;
  const stage = conversationStage({ exchanges, budget: blueprint.budget });
  return laoshiConverse({ blueprint, stage, history, userText, knownWords,
    profileDigest: profileForPrompt(), scriptDirective: plan.scriptDirective });
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

// Free-chat teacher turn. Builds a MINIMAL blueprint internally so free chat and
// guided lessons share one executor code path. Returns {hanzi,pinyin,english,note,via}.
export async function laoshiReply({ history = [], userText = '', context = {} }) {
  const minimalPlan = {
    capability: null,
    objectives: (context.focusWords || []).length
      ? [{ objective: 'reuse familiar words in a natural chat', vocab: context.focusWords, pattern: null, priority: 1 }] : [],
    focal: null,
    targetVocab: (context.focusWords || []).map(h => ({ hanzi: h })),
    reviewVocab: [],
    scriptLevel: context.scriptLevel ?? 0,
  };
  const blueprint = buildBlueprintLocal(minimalPlan, {});
  const exchanges = history.filter(m => m.role === 'user').length;
  const stage = conversationStage({ exchanges, budget: blueprint.budget });
  return laoshiConverse({ blueprint, stage, history, userText,
    knownWords: context.knownWords || [], profileDigest: profileForPrompt(),
    scriptDirective: context.scriptDirective || '' });
}
