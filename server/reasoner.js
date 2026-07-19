// The invisible reasoning engine (currently Claude). The learner never talks to
// it. It analyzes behavior, updates the hidden learner model, generates
// comprehensible-input examples, flags misconceptions, and tunes scheduling to
// fit a time budget. Everything degrades gracefully with no API key.
import { db, getModel, setModel } from './db.js';
import { hasApiKey, completeJson } from './anthropic.js';
import { inferTraits, traits } from './learner.js';
import { avgDailyReviewMinutes, recentRetention } from './scheduler.js';

const TIME_BUDGET_MIN = 15;   // target daily study minutes
const ADAPT_MIN_REVIEWS = 200;

// Words the learner knows well enough to reuse in generated input.
function knownWordStrings(limit = 300) {
  return db().prepare(`SELECT w.hanzi FROM words w
    JOIN acquisition a ON a.item_type='word' AND a.item_id=w.id
    WHERE a.stage>=2 ORDER BY w.freq_rank ASC LIMIT ?`).all(limit).map(r => r.hanzi);
}

// Generate 1–2 example sentences for a word using mostly already-known vocabulary
// (comprehensible input: one new concept at a time). Returns [] without a key.
export async function comprehensibleSentences(wordId, n = 2) {
  if (!hasApiKey()) return [];
  const w = db().prepare('SELECT hanzi, pinyin, english FROM words WHERE id=?').get(wordId);
  if (!w) return [];
  const known = knownWordStrings(200);
  try {
    const out = await completeJson({
      system: 'You are a Mandarin curriculum writer. Produce comprehensible-input example sentences: use ONLY the learner\'s known words plus the single target word. Keep them short and natural. Output a JSON array of {hanzi, pinyin, english}.',
      messages: [{ role: 'user', content:
        `Target word: ${w.hanzi} (${w.pinyin}, ${w.english}).\nKnown words: ${known.join(' ')}\nWrite ${n} short sentences that each use ${w.hanzi} and otherwise stay within the known words. JSON array only.` }],
      max_tokens: 500,
    });
    return Array.isArray(out) ? out.slice(0, n) : [];
  } catch { return []; }
}

// Nudge per-dimension retention targets toward a daily time budget. Pure heuristic,
// invisible to the learner. Gated until enough review history exists.
export function adaptDimTargets() {
  const total = db().prepare('SELECT COUNT(*) c FROM reviews').get().c;
  if (total < ADAPT_MIN_REVIEWS) return { adapted: false, reason: 'insufficient history' };
  const avgMin = avgDailyReviewMinutes(7);
  const ret = recentRetention(14) ?? 0.88;
  let delta = 0;
  if (avgMin > TIME_BUDGET_MIN * 1.4 && ret >= 0.85) delta = -0.01;   // over budget, retaining fine → ease off
  else if (avgMin < TIME_BUDGET_MIN * 0.6 && ret < 0.9) delta = +0.01; // spare time → push retention
  if (!delta) return { adapted: false, avgMin, ret };
  const rows = db().prepare('SELECT dimension, target FROM dim_retention').all();
  const upd = db().prepare('UPDATE dim_retention SET target=? WHERE dimension=?');
  for (const r of rows) upd.run(Math.min(0.93, Math.max(0.80, r.target + delta)), r.dimension);
  return { adapted: true, delta, avgMin, ret };
}

// Ask Claude to name likely misconceptions from recent errors (stored, not shown).
export async function analyzeMisconceptions() {
  if (!hasApiKey()) return null;
  const errs = db().prepare(`SELECT w.hanzi, w.pinyin, w.english, rd.dimension
    FROM reviews r JOIN review_dims rd ON rd.review_id=r.id
    JOIN cards c ON c.id=r.card_id JOIN words w ON w.id=c.item_id
    WHERE r.rating<3 AND c.item_type='word' ORDER BY r.ts DESC LIMIT 40`).all();
  if (errs.length < 8) return null;
  try {
    const out = await completeJson({
      system: 'You are a Mandarin learning diagnostician. Given recent errors, identify up to 3 concrete misconceptions or weak patterns (e.g. tone confusions, radical mix-ups, grammar). Output JSON {patterns:[{summary, examples:[hanzi], suggestion}]}.',
      messages: [{ role: 'user', content: JSON.stringify(errs) }],
      max_tokens: 500,
    });
    setModel('misconceptions', { ...out, at: new Date().toISOString() });
    return out;
  } catch { return null; }
}

// Full background pass: refresh traits, adapt scheduling, analyze misconceptions.
export async function runBackground() {
  const t = inferTraits();
  const adapt = adaptDimTargets();
  let mis = null;
  try { mis = await analyzeMisconceptions(); } catch {}
  setModel('last_background', { at: new Date().toISOString(), reviews: t.reviews });
  return { traits: t, adapt, misconceptions: mis };
}
