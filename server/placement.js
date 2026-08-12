// The entrance exam — an optional, skippable placement conversation.
//
// It is deliberately NOT a test page with a score. It runs through the same surface
// as a real conversation with Laoshi: teacher bubbles, interlinear grounding, and
// tap-to-say choices (vocabguard), escalating until the learner stops being able to
// follow. Where the ladder normally has to INFER a starting level over several
// sessions, this finds it in about a minute — and if you'd rather not, skipping puts
// you at the ordinary beginner start with nothing lost.
//
// Every probe is generated from real content (the word/sentence tables + the same
// frames the guided rung speaks), never from a hand-written syllabus, so it stays in
// step with whatever the learner's content DB actually contains.
import { db, getModel, setModel, setSetting } from './db.js';
import { groundTokens, buildFrameTurn, vocabToken, coreSet, shortGloss, isNamable, segment } from './vocabguard.js';
import { imageFor } from './images.js';
import { markFirstUnitsKnown } from './onboarding.js';

const RUN_KEY = 'placement_run';        // in-flight exam
const RESULT_KEY = 'placement';         // durable outcome

const CJK = /[一-鿿]/;
const cjkCount = (s) => (String(s || '').match(/[一-鿿]/g) || []).length;

// ── Probe construction ──────────────────────────────────────────────────────
// Six rungs of evidence, cheapest first. Each returns null when the content DB
// can't support it, and the ladder simply skips that rung.

// A probe word must be a CONTENT word with a nameable meaning. Testing 是 or 让 by
// multiple choice measures nothing except how well someone can gloss a function
// word in isolation, which is not what "have you studied before?" is asking.
const CONTENT_POS = new Set(['n', 'ns', 'nr', 'nz', 'nt', 'v', 'a']);

function contentWordsAt(hsk, skip = []) {
  const rows = db().prepare(`SELECT id, hanzi, pinyin, gloss, english, pos, particle FROM words
    WHERE hsk_level = ? ORDER BY COALESCE(freq_rank, 999999) ASC LIMIT 200`).all(hsk);
  const core = coreSet(1);
  const out = [];
  for (const r of rows) {
    if (r.particle || core.has(r.hanzi) || skip.includes(r.hanzi)) continue;
    let ok = false; try { ok = JSON.parse(r.pos || '[]').some(p => CONTENT_POS.has(p)); } catch {}
    if (!ok) continue;
    const gloss = shortGloss(r.gloss || r.english);
    if (!gloss || !isNamable(gloss)) continue;
    out.push({ ...r, gloss });
  }
  return out;
}

function wordAt({ hsk = 1, skip = [] } = {}) {
  return contentWordsAt(hsk, skip)[0] || null;
}

// Distractors must be plausible and equally short, or the right answer stands out
// by shape alone.
function distractorGlosses(exclude, n = 2) {
  const rows = db().prepare(`SELECT gloss, english FROM words
    WHERE (gloss IS NOT NULL OR english IS NOT NULL) AND hsk_level <= 3
    ORDER BY RANDOM() LIMIT 120`).all();
  const out = [];
  for (const r of rows) {
    const g = shortGloss(r.gloss || r.english);
    if (g && isNamable(g) && g !== exclude && !out.includes(g)) out.push(g);
    if (out.length >= n) break;
  }
  return out;
}

// A word-recognition probe: hear/see the word, pick what it means.
function recognizeProbe(level, hsk, skip) {
  const w = wordAt({ hsk, skip });
  if (!w) return null;
  const options = shuffle([w.gloss, ...distractorGlosses(w.gloss, 2)]);
  const img = imageFor(w.hanzi);
  return {
    id: `recognize-${w.id}`, level, kind: 'recognize',
    ask: { hanzi: w.hanzi, pinyin: w.pinyin || '', english: '' },
    tokens: groundTokens(w.hanzi, {}),
    prompt: 'What does this mean?',
    options, answer: w.gloss,
    image: img.kind !== 'none' ? img : null,
    wordHanzi: w.hanzi,
  };
}

// A comprehension probe built from the SAME frame engine the guided rung speaks:
// the teacher asks a real question, the learner picks a sensible reply.
function frameProbe(level) {
  // The same word-quality bar the guided rung uses — a picturable, likeable thing,
  // so the question ("do you like X?") is one a person could actually be asked.
  const w = contentWordsAt(1).concat(contentWordsAt(2))
    .map(r => vocabToken(r.id))
    .find(t => t && t.imageRef && !['body', 'nature', 'place'].includes(t.category));
  if (!w) return null;
  const frame = buildFrameTurn({ rung: 0, sessionWords: [w], turnIndex: 1, prefer: 'do-you-like-q' });
  if (!frame) return null;
  // The right answer is a real reply to the question; the wrong ones are well-formed
  // Chinese that answers something ELSE — so this tests comprehension, not grammar.
  const good = `我喜欢${w.hanzi}。`;
  const options = shuffle([good, '我叫小明。', '今天是星期一。']);
  return {
    id: `frame-${w.wordId}`, level, kind: 'comprehend',
    ask: { hanzi: frame.hanzi, pinyin: frame.pinyin, english: '' },
    tokens: frame.tokens,
    prompt: 'Which reply makes sense?',
    options, answer: good, chinese: true,
  };
}

// A sentence-comprehension probe from the real sentence bank at a chosen difficulty.
// The imported sentence bank carries some traditional-character entries. Showing one
// during a placement check is worse than a wrong answer: the learner concludes they
// can't read something they can in fact read.
const TRADITIONAL_ONLY = /[歲來說時國會學東車馬語話經開關長門問題點無為對灣體萬與個們這樣讓覺聽讀寫買賣錢銀鐵飯麵鳥魚陽發電視業務員區愛親歡樂機藥點]/;

function sentenceProbe(level, maxHsk) {
  const rows = db().prepare(`SELECT id, hanzi, pinyin, english, word_ids FROM sentences
    WHERE english IS NOT NULL AND length(hanzi) BETWEEN ? AND ?
    ORDER BY length(hanzi) ASC LIMIT 400`).all(maxHsk <= 2 ? 4 : 8, maxHsk <= 2 ? 9 : 18);
  const pick = rows.filter(r => !TRADITIONAL_ONLY.test(r.hanzi)).find(r => {
    let ids = []; try { ids = JSON.parse(r.word_ids || '[]'); } catch {}
    if (!ids.length) return false;
    const ph = ids.map(() => '?').join(',');
    const hard = db().prepare(`SELECT COUNT(*) c FROM words WHERE id IN (${ph}) AND (hsk_level IS NULL OR hsk_level > ?)`).get(...ids, maxHsk).c;
    return hard === 0;
  });
  if (!pick) return null;
  const others = db().prepare(`SELECT english FROM sentences WHERE english IS NOT NULL AND id != ?
    AND length(english) BETWEEN 8 AND 60 ORDER BY RANDOM() LIMIT 2`).all(pick.id).map(r => r.english);
  if (others.length < 2) return null;
  return {
    id: `sentence-${pick.id}`, level, kind: 'comprehend',
    ask: { hanzi: pick.hanzi, pinyin: pick.pinyin || '', english: '' },
    tokens: groundTokens(pick.hanzi, {}),
    prompt: 'What is this saying?',
    options: shuffle([pick.english, ...others]), answer: pick.english,
  };
}

// Open production: Laoshi asks, the learner says whatever they can. Scored by what
// they actually produced (segmented against the real word DB) — no model needed, and
// a blank or English answer is simply evidence, never a failure to punish.
function produceProbe(level, ask, prompt, minWords) {
  return {
    id: `produce-${level}`, level, kind: 'produce',
    ask, tokens: groundTokens(ask.hanzi, {}), prompt, minWords, options: null, answer: null,
  };
}

// The full ladder, easiest → hardest. Built fresh each run so word choices vary.
function buildLadder() {
  const skip = [];
  const probes = [];
  const push = (p) => { if (p) { probes.push(p); if (p.wordHanzi) skip.push(p.wordHanzi); } };
  push(recognizeProbe(1, 1, skip));
  push(recognizeProbe(2, 1, skip));
  push(frameProbe(2));
  push(recognizeProbe(3, 2, skip));
  push(sentenceProbe(3, 2));
  push(sentenceProbe(4, 4));
  push(produceProbe(5,
    { hanzi: '你今天做了什么？', pinyin: 'Nǐ jīntiān zuò le shénme?', english: 'What did you do today?' },
    'Answer in Chinese — however much you can.', 3));
  push(produceProbe(6,
    { hanzi: '你为什么想学中文？', pinyin: 'Nǐ wèishénme xiǎng xué zhōngwén?', english: 'Why do you want to learn Chinese?' },
    'Answer in Chinese — a sentence or two.', 6));
  return probes.sort((a, b) => a.level - b.level);
}

function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

// ── Running the exam ────────────────────────────────────────────────────────

export function placementState() {
  const result = getModel(RESULT_KEY, null);
  return { taken: !!result, result, inProgress: !!getModel(RUN_KEY, null) };
}

export function startPlacement() {
  const probes = buildLadder();
  const run = { probes, index: 0, reached: 0, misses: 0, answers: [] };
  setModel(RUN_KEY, run);
  return { total: probes.length, probe: publicProbe(probes[0]), index: 0 };
}

// Never send the answer key to the client.
function publicProbe(p) {
  if (!p) return null;
  const { answer, minWords, ...rest } = p;
  return rest;
}

// Score one answer and hand back the next probe (or the finished result). Two misses
// in a row means we've found the ceiling — there is nothing kind or informative about
// pushing someone through four more questions they can't read.
export function answerPlacement({ answer = '' } = {}) {
  const run = getModel(RUN_KEY, null);
  if (!run) return { error: 'no placement in progress' };
  const probe = run.probes[run.index];
  if (!probe) return finishPlacement(run);

  const correct = judge(probe, answer);
  run.answers.push({ id: probe.id, level: probe.level, kind: probe.kind, answer, correct });
  if (correct) { run.reached = Math.max(run.reached, probe.level); run.misses = 0; }
  else run.misses += 1;
  run.index += 1;

  const done = run.misses >= 2 || run.index >= run.probes.length;
  if (done) { setModel(RUN_KEY, run); return finishPlacement(run); }
  setModel(RUN_KEY, run);
  return { correct, done: false, index: run.index, total: run.probes.length, probe: publicProbe(run.probes[run.index]) };
}

// Multiple choice is exact; production is judged on what they actually produced —
// Chinese words the dictionary recognises, not spelling or grammar.
function judge(probe, answer) {
  if (probe.kind !== 'produce') return String(answer || '').trim() === String(probe.answer || '').trim();
  const text = String(answer || '');
  if (cjkCount(text) < 2) return false;
  const known = segment(text).filter(seg => CJK.test(seg) &&
    db().prepare('SELECT 1 FROM words WHERE hanzi=?').get(seg));
  return known.length >= (probe.minWords || 3);
}

// ── Placing the learner ─────────────────────────────────────────────────────
// The reached level maps to a starting rung, a seeded level estimate (so the ladder
// and the planner agree with the exam instead of re-deriving it from scratch), and
// how much of the path counts as already behind them.
const PLACEMENTS = {
  0: { rung: 0, knownUnits: 0, hsk: null, label: 'Starting from the very beginning' },
  1: { rung: 0, knownUnits: 0, hsk: 1, label: 'Starting from the very beginning' },
  2: { rung: 0, knownUnits: 1, hsk: 1, label: 'You know some words already' },
  3: { rung: 1, knownUnits: 2, hsk: 2, label: 'You can follow simple sentences' },
  4: { rung: 1, knownUnits: 3, hsk: 3, label: 'You read short sentences comfortably' },
  5: { rung: 2, knownUnits: 4, hsk: 4, label: 'You can hold a simple conversation' },
  6: { rung: 2, knownUnits: 6, hsk: 4, label: 'You can explain yourself in Chinese' },
};

export function finishPlacement(run) {
  const reached = run?.reached ?? 0;
  const place = PLACEMENTS[reached] || PLACEMENTS[0];
  applyPlacement(place, { reached, source: 'exam', answers: run?.answers || [] });
  setModel(RUN_KEY, null);
  return { done: true, result: getModel(RESULT_KEY, null) };
}

// Skipping is a first-class outcome, not an error: it places you at the ordinary
// beginner start and never asks again.
export function skipPlacement() {
  applyPlacement(PLACEMENTS[0], { reached: 0, source: 'skipped', answers: [] });
  setModel(RUN_KEY, null);
  return { done: true, skipped: true, result: getModel(RESULT_KEY, null) };
}

function applyPlacement(place, meta) {
  // The rung machine reads rung_state directly; setting it means the first
  // conversation already speaks at the right level instead of climbing to it.
  setModel('rung_state', { rung: place.rung });
  setModel('rung_override', null);

  // Seed the level estimates the planner/rung read, with modest confidence — real
  // observed behaviour overwrites these within a session or two.
  if (place.hsk) {
    const rank = place.hsk * 400;
    setModel('receptive_level', { rank, hsk: place.hsk, confidence: 0.35 });
    if (meta.reached >= 5) setModel('productive_level', { rank: Math.round(rank * 0.7), hsk: Math.max(1, place.hsk - 1), confidence: 0.3 });
  }

  // Mark the path already behind them as known, exactly the way onboarding's
  // "I already know some" answer does — same mechanism, measured instead of guessed.
  let marked = 0;
  if (place.knownUnits > 0) marked = markFirstUnitsKnown(place.knownUnits);

  setSetting('onboarded', true);
  setModel(RESULT_KEY, {
    reached: meta.reached, rung: place.rung, label: place.label, source: meta.source,
    knownUnits: place.knownUnits, wordsMarked: marked,
    at: new Date().toISOString(),
    answers: meta.answers.map(a => ({ level: a.level, kind: a.kind, correct: a.correct })),
  });
}

// Testing/reset hook: forget the placement so the exam is offered again.
export function clearPlacement() {
  setModel(RESULT_KEY, null);
  setModel(RUN_KEY, null);
}
