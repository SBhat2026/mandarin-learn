// Generated graded readers — the reading core. A story is written AT the learner's
// level (i+1): built almost entirely from known words, plus a few stretch words
// that are glossed and become scheduled vocabulary. Interests pick the topic,
// measured level picks the length, and finishing the story (plus a comprehension
// check) feeds READING mastery for every word actually read — so extensive
// reading, not isolated flashcards, is what advances the script-fade gate.
//
// Generation prefers Claude (invisible engine), falls back to the Qwen teacher
// model, and finally to a deterministic assembly from known sentences — a story
// is always available offline.
import { db, getModel, setModel } from './db.js';
import { hasApiKey, completeJson } from './anthropic.js';
import { chat, available as qwenAvailable } from './qwen.js';
import { knownWordIds, newCandidates } from './planner.js';
import { conversationProfile } from './level.js';
import { scriptLevel, updateMastery } from './learner.js';
import { getInterests } from './interests.js';
import { pinyinForHanzi, glossForHanzi } from './pronunciation.js';
import { segment, validateTurn } from './vocabguard.js';
import { createCardsForWord } from './cards.js';
import { cleanGloss } from './exercises.js';
import { storyThrottle } from './spend.js';

const CJK = /[一-鿿]/;

function knownRows(limit = 500) {
  const ids = [...knownWordIds()];
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db().prepare(`SELECT id, hanzi, pinyin, gloss, english, freq_rank FROM words
    WHERE id IN (${ph}) ORDER BY COALESCE(freq_rank, 999999) ASC LIMIT ${limit}`).all(...ids);
}

// Up to `n` stretch words: the planner's best next candidates (comprehensible,
// graph-connected, interest-aware) — these are the story's i+1.
function stretchWords(n = 3) {
  return newCandidates(n, undefined).map(c => {
    const w = db().prepare('SELECT id, hanzi, pinyin, gloss, english FROM words WHERE id=?').get(c.id);
    return w && { wordId: w.id, hanzi: w.hanzi, pinyin: w.pinyin || pinyinForHanzi(w.hanzi), gloss: cleanGloss(w) };
  }).filter(Boolean);
}

function storyPrompt({ known, stretch, topic, sentences }) {
  return `Write a tiny graded reader in simplified Chinese for a learner.
TOPIC: ${topic}. LENGTH: exactly ${sentences} short sentences. It should be a coherent little story or scene (beginning → small event → end), warm and concrete — not a word list.

VOCABULARY RULES (critical):
- Use ONLY words from this KNOWN list (plus basic function words 的了是不在有我你他她我们吗呢吧很也都和): ${known.join(' ')}
- Weave in each of these NEW words exactly 2 times, in contexts that make their meaning obvious: ${stretch.map(s => `${s.hanzi} (${s.gloss})`).join(', ') || '(none)'}
- Every sentence 4-12 characters. No rare words, no idioms, no literary style.

Also write 2 simple comprehension questions in English about what happened, each with 3 short options (one correct).

Output STRICT JSON only:
{"title": {"hanzi":"...","english":"..."},
 "sentences": [{"hanzi":"...","pinyin":"...","english":"..."}],
 "questions": [{"q":"...","options":["...","...","..."],"answer":0}]}`;
}

async function generateStory() {
  const prof = conversationProfile();
  const sentences = 4 + Math.round(prof.t * 6);              // 4 → 10 with progression
  const known = knownRows().map(r => r.hanzi);
  if (known.length < 8) return null;                          // too early for stories
  const stretch = stretchWords(known.length < 40 ? 2 : 3);
  const interests = getInterests().slice(0, 3).map(i => i.topic).filter(Boolean);
  const topic = interests.length ? interests[Math.floor(Math.random() * interests.length)] : 'everyday life';
  const prompt = storyPrompt({ known, stretch, topic, sentences });

  // One generation + up to one REPAIR pass naming the leaked words — small local
  // models write good stories but drift off-list; naming the violations fixes most.
  let messages = [{ role: 'user', content: prompt }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await generateOnce(messages);
    if (!out) return null;
    const v = validateStory(out, stretch);
    if (v.story) return v.story;
    console.log(`[stories] attempt ${attempt + 1} rejected — leaks: ${v.leakWords?.join(' ') || '(shape)'}`);
    if (!v.leakWords?.length || attempt === 1) return null;
    messages = [...messages,
      { role: 'assistant', content: JSON.stringify(out) },
      { role: 'user', content: `You used words NOT on the allowed list: ${v.leakWords.join(' ')}. Rewrite the whole story using ONLY the KNOWN list (plus the NEW words). Same JSON format.` }];
  }
  return null;
}

async function generateOnce(messages) {
  const system = 'You write graded readers for Mandarin learners. Follow the vocabulary constraints exactly. Output strict JSON only.';
  if (hasApiKey()) {
    try { return await completeJson({ system, tier: 'fast', messages, max_tokens: 1600 }); }
    catch { /* fall through */ }
  }
  if (await qwenAvailable()) {
    try {
      const r = await chat([{ role: 'system', content: system }, ...messages], { temperature: 0.7, max_tokens: 1600, json: true, kind: 'story' });
      return JSON.parse(r.text.replace(/```json\s*/gi, '').replace(/```/g, '').trim());
    } catch { return null; }
  }
  return null;
}

// Validate the generated story: sane shape, decodable sentences (bounded out-of-set
// leakage beyond the declared stretch words). Repairs pinyin/gloss gaps from the
// dictionary. Returns {story} on success or {leakWords} so the caller can run a
// repair pass naming exactly what drifted.
function validateStory(out, stretch) {
  const sents = (Array.isArray(out?.sentences) ? out.sentences : [])
    .map(s => ({ hanzi: String(s?.hanzi || '').trim(), pinyin: String(s?.pinyin || '').trim(), english: String(s?.english || '').trim() }))
    .filter(s => s.hanzi && [...s.hanzi].some(c => CJK.test(c)));
  if (sents.length < 3) return { story: null, leakWords: [] };

  const allowed = new Set([...knownRows().map(r => r.hanzi), ...stretch.map(s => s.hanzi),
    ...'的了是不在有我你他她它我们你们他们吗呢吧很也都和跟就还没别去来说看想要会能可以'.split('')]);
  for (const h of [...allowed]) for (const c of h) if (CJK.test(c)) allowed.add(c);

  const leakWords = [];
  for (const s of sents) {
    const { violations } = validateTurn(s.hanzi, allowed);
    leakWords.push(...violations);
    if (!s.pinyin) s.pinyin = pinyinForHanzi(s.hanzi);
    if (!s.english) s.english = glossForHanzi(s.hanzi);
  }
  if (leakWords.length > Math.max(2, sents.length)) return { story: null, leakWords: [...new Set(leakWords)] };

  const questions = (Array.isArray(out?.questions) ? out.questions : [])
    .map(q => ({ q: String(q?.q || ''), options: (Array.isArray(q?.options) ? q.options : []).map(String).slice(0, 3), answer: Number(q?.answer) || 0 }))
    .filter(q => q.q && q.options.length === 3 && q.answer >= 0 && q.answer < 3).slice(0, 3);

  return { story: {
    title: { hanzi: String(out?.title?.hanzi || '小故事'), english: String(out?.title?.english || 'A little story') },
    sentences: sents,
    newWords: stretch,
    questions,
    generated: true,
    createdAt: new Date().toISOString(),
  }, leakWords: [] };
}

// Deterministic fallback: a coherent-ish "passage" from known sentences that share
// vocabulary — grouped by overlap instead of DB row order, shortest first.
function assembleFallback() {
  const learned = knownWordIds();
  if (!learned.size) return null;
  const rows = db().prepare(`SELECT id, hanzi, pinyin, english, word_ids FROM sentences
    WHERE word_ids IS NOT NULL AND word_ids != '[]' AND length(hanzi) BETWEEN 4 AND 20`).all();
  // Learned hanzi (words + their characters) for a real coverage check — word_ids
  // alone lets sentences through whose unmatched characters (e.g. traditional
  // variants) were silently dropped by segmentation.
  const learnedIds = [...learned];
  const learnedHanzi = new Set();
  if (learnedIds.length) {
    const ph = learnedIds.map(() => '?').join(',');
    for (const r of db().prepare(`SELECT hanzi FROM words WHERE id IN (${ph})`).all(...learnedIds)) {
      learnedHanzi.add(r.hanzi);
      for (const c of r.hanzi) if (CJK.test(c)) learnedHanzi.add(c);
    }
  }
  const fullyCovered = (hanzi) => segment(hanzi).every(seg =>
    learnedHanzi.has(seg) || [...seg].every(c => !CJK.test(c) || learnedHanzi.has(c)));
  const eligible = rows.filter(s => {
    let ids = []; try { ids = JSON.parse(s.word_ids); } catch { return false; }
    s._ids = new Set(ids);
    return ids.length && ids.every(id => learned.has(id)) && fullyCovered(s.hanzi);
  });
  if (eligible.length < 3) return null;
  // Seed with the shortest, then greedily chain by vocabulary overlap.
  eligible.sort((a, b) => a.hanzi.length - b.hanzi.length);
  const chain = [eligible.shift()];
  while (chain.length < 6 && eligible.length) {
    const last = chain[chain.length - 1];
    let bestI = 0, bestOv = -1;
    for (let i = 0; i < eligible.length; i++) {
      const ov = [...eligible[i]._ids].filter(id => last._ids.has(id)).length;
      if (ov > bestOv) { bestOv = ov; bestI = i; }
    }
    chain.push(eligible.splice(bestI, 1)[0]);
  }
  return {
    title: { hanzi: '读一读', english: 'Read along' },
    sentences: chain.map(s => ({ hanzi: s.hanzi, pinyin: s.pinyin || pinyinForHanzi(s.hanzi), english: s.english || '' })),
    newWords: [], questions: [], generated: false,
    createdAt: new Date().toISOString(),
  };
}

// The current story (persisted until completed), or a fresh one on demand.
// When metered spend is running hot, story FREQUENCY is reduced — a fresh
// generation is rate-limited and the existing story is reused instead. Story
// quality and the model used are never downgraded.
export async function getStory({ fresh = false } = {}) {
  const cur = getModel('current_story', null);
  if (!fresh && cur && !cur.completed) return cur;

  if (fresh && cur) {
    const t = storyThrottle();
    if (t.on && cur.createdAt) {
      const ageH = (Date.now() - new Date(cur.createdAt).getTime()) / 3600e3;
      if (ageH < t.minHoursBetween) {
        console.log(`[stories] throttled (${t.reason}: $${t.today.toFixed(3)} today) — reusing current story`);
        return { ...cur, throttled: true, throttleReason: t.reason };
      }
    }
  }

  const story = (await generateStory()) || assembleFallback();
  if (story) setModel('current_story', story);
  return story;
}

// Completion: reading credit for every known word actually in the story (this is
// what moves the script-fade gate), stretch words enter scheduling, comprehension
// results shade the rating. Marks the story completed so the next visit is fresh.
export function storyOutcome({ correct = 0, total = 0 } = {}) {
  const story = getModel('current_story', null);
  if (!story) return { ok: false };
  const ratio = total > 0 ? correct / total : 1;
  const rating = ratio >= 0.66 ? 3 : 2;

  const lookup = db().prepare('SELECT id FROM words WHERE hanzi=?');
  const credited = new Set();
  for (const s of story.sentences) {
    for (const seg of segment(s.hanzi)) {
      const w = lookup.get(seg);
      if (!w || credited.has(w.id)) continue;
      credited.add(w.id);
      updateMastery(w.id, 'reading', rating);
    }
  }
  for (const nw of story.newWords || []) {
    if (!nw.wordId) continue;
    createCardsForWord(nw.wordId);
    updateMastery(nw.wordId, 'meaning', rating);
  }
  setModel('current_story', { ...story, completed: true });
  return { ok: true, creditedWords: credited.size, newWordsScheduled: (story.newWords || []).length, rating };
}
