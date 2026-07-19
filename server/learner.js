// The hidden learner model. Never surfaced to the learner as scores or ratings —
// it silently decides what to teach and test next.
//
// Per word we track six independent skill dimensions. One FSRS "memory" card
// schedules WHEN a word returns; these sub-scores pick WHICH exercise to show
// (always the weakest unlocked dimension) and drive the acquisition stage.
import { db, DIMENSIONS, getModel, setModel } from './db.js';

// Dimensions unlock progressively so early practice stays comprehensible.
export const RECEPTIVE = ['meaning', 'reading', 'listening'];
export const PRODUCTIVE = ['pronunciation', 'spoken'];
export const CONTEXTUAL = ['sentence'];

// rating (1..4) → outcome in [0,1] for mastery updates.
export function outcome(rating) {
  if (rating >= 4) return 1;      // Easy
  if (rating === 3) return 0.9;   // Good
  if (rating === 2) return 0.5;   // Hard (partial)
  return 0;                       // Again
}

function masteryRows(wordId) {
  return db().prepare('SELECT * FROM word_mastery WHERE word_id=?').all(wordId);
}

export function getMastery(wordId) {
  const out = {};
  for (const d of DIMENSIONS) out[d] = { score: 0, alpha: 1, beta: 1, exposures: 0 };
  for (const r of masteryRows(wordId)) out[r.dimension] = r;
  return out;
}

const upsertMastery = () => db().prepare(`
  INSERT INTO word_mastery(word_id,dimension,score,alpha,beta,exposures,last_ts)
  VALUES(@word_id,@dimension,@score,@alpha,@beta,@exposures,datetime('now'))
  ON CONFLICT(word_id,dimension) DO UPDATE SET
    score=excluded.score, alpha=excluded.alpha, beta=excluded.beta,
    exposures=excluded.exposures, last_ts=excluded.last_ts`);

// Update one dimension's mastery from a graded outcome.
// EWMA `score` gives recency-weighted mastery (planner reads this);
// alpha/beta accumulate a Beta posterior for uncertainty-aware exploration.
export function updateMastery(wordId, dimension, rating) {
  const cur = getMastery(wordId)[dimension];
  const o = outcome(rating);
  // Learning rate decays with exposure so early reps move the needle more.
  const k = Math.max(0.18, 0.5 / (1 + cur.exposures * 0.4));
  const score = cur.score * (1 - k) + o * k;
  upsertMastery().run({
    word_id: wordId, dimension,
    score,
    alpha: cur.alpha + o,
    beta: cur.beta + (1 - o),
    exposures: cur.exposures + 1,
  });
  return score;
}

// Which dimensions are "unlocked" for a word given how far along it is.
export function unlockedDimensions(wordId, hasSentence) {
  const m = getMastery(wordId);
  const meaningKnown = m.meaning.exposures > 0 && m.meaning.score >= 0.5;
  const dims = [...RECEPTIVE];
  if (meaningKnown) dims.push(...PRODUCTIVE);
  if (meaningKnown && hasSentence) dims.push(...CONTEXTUAL);
  return dims;
}

// The single most valuable dimension to practice next for this word:
// lowest mastery, with an uncertainty bonus (Thompson-ish exploration) and a
// small recency penalty so we don't drill the same dimension twice in a row.
export function weakestDimension(wordId, { hasSentence = false, avoid = null } = {}) {
  const m = getMastery(wordId);
  let best = null, bestNeed = -Infinity;
  for (const d of unlockedDimensions(wordId, hasSentence)) {
    const row = m[d];
    const uncertainty = row.alpha * row.beta / ((row.alpha + row.beta) ** 2 * (row.alpha + row.beta + 1));
    let need = (1 - row.score) + 2.5 * uncertainty;
    if (row.exposures === 0) need += 0.15;        // gentle nudge to cover untested skills
    if (d === avoid) need -= 0.4;
    if (need > bestNeed) { bestNeed = need; best = d; }
  }
  return best || 'meaning';
}

// Continuous acquisition stage (0..4). Derived, then persisted for fast reads.
//   0 first-exposure · 1 familiar · 2 recall · 3 functional · 4 automatic
export function computeStage(wordId, card) {
  const m = getMastery(wordId);
  const exposures = DIMENSIONS.reduce((s, d) => s + m[d].exposures, 0);
  if (exposures === 0) return 0;
  const recep = avg(RECEPTIVE.map(d => m[d].score));
  const prod = avg(PRODUCTIVE.map(d => m[d].score));
  const stability = card?.stability || 0;
  if (recep >= 0.8 && prod >= 0.75 && stability >= 30) return 4;   // automatic
  if (recep >= 0.7 && prod >= 0.5) return 3;                       // functional usage
  if (recep >= 0.55) return 2;                                     // reliable recall
  if (recep >= 0.3 || exposures >= 2) return 1;                    // familiar
  return 0;
}

export function setStage(itemType, itemId, stage) {
  db().prepare(`INSERT INTO acquisition(item_type,item_id,stage,updated)
    VALUES(?,?,?,datetime('now'))
    ON CONFLICT(item_type,item_id) DO UPDATE SET stage=excluded.stage, updated=excluded.updated`)
    .run(itemType, itemId, stage);
}

export function getStage(itemType, itemId) {
  const r = db().prepare('SELECT stage FROM acquisition WHERE item_type=? AND item_id=?').get(itemType, itemId);
  return r ? r.stage : 0;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---------------------------------------------------------------------------
// Invisible trait inference. Aggregates observed behavior into a hidden model
// the reasoning engine and planner consult. Cheap; safe to call periodically.
// ---------------------------------------------------------------------------
export function inferTraits() {
  const d = db();
  const rev = d.prepare(`SELECT r.rating, r.duration_ms, r.target_tone, r.heard_tone, rd.dimension, rd.correct
    FROM reviews r LEFT JOIN review_dims rd ON rd.review_id=r.id`).all();
  const n = rev.length;

  // Per-dimension ability (mean recent score across all words).
  const dimAbility = {};
  for (const dim of DIMENSIONS) {
    const row = d.prepare('SELECT AVG(score) a, COUNT(*) c FROM word_mastery WHERE dimension=? AND exposures>0').get(dim);
    dimAbility[dim] = { ability: row.a ?? null, n: row.c };
  }

  // Forgetting rate: lapses per review-state card, and median stability.
  const lapseRow = d.prepare(`SELECT AVG(lapses) l, AVG(stability) s FROM cards WHERE reps>0`).get();
  // Learning rate: average mastery gain per exposure (proxy: mean score / mean exposures).
  const lr = d.prepare(`SELECT AVG(score) s, AVG(exposures) e FROM word_mastery WHERE exposures>0`).get();
  const learningRate = lr.e ? (lr.s || 0) / lr.e : null;

  // Confidence calibration: fast+correct = confident; slow-but-correct or fast-wrong = shaky.
  let confSum = 0, confN = 0;
  for (const r of rev) {
    if (r.duration_ms == null) continue;
    const correct = r.rating >= 3 ? 1 : 0;
    const fast = r.duration_ms < 4000 ? 1 : 0;
    confSum += (correct === fast) ? 1 : 0; confN++;
  }
  const confidence = confN ? confSum / confN : null;

  // Pronunciation tendencies: per-tone error rate from speaking telemetry.
  const tone = {};
  for (const r of rev) {
    if (!r.target_tone) continue;
    const t = r.target_tone;
    tone[t] = tone[t] || { seen: 0, miss: 0 };
    tone[t].seen++;
    if (r.heard_tone && r.heard_tone !== r.target_tone) tone[t].miss++;
  }

  // Modality preference: which exercise dimension yields the best success rate.
  const modality = {};
  for (const r of rev) {
    if (!r.dimension) continue;
    modality[r.dimension] = modality[r.dimension] || { seen: 0, ok: 0 };
    modality[r.dimension].seen++;
    if (r.correct) modality[r.dimension].ok++;
  }

  const traits = {
    reviews: n,
    dimAbility,
    learningRate,
    forgettingRate: lapseRow.l ?? null,
    medianStability: lapseRow.s ?? null,
    confidence,
    tone,
    modality,
    // Reading vs listening lean (>0 = stronger reader).
    readingVsListening: (dimAbility.reading.ability ?? 0) - (dimAbility.listening.ability ?? 0),
  };
  setModel('traits', traits);
  return traits;
}

export function traits() {
  return getModel('traits', null);
}

// ---------------------------------------------------------------------------
// Progressive script exposure. Reading strength grows continuously, so script
// emphasis shifts from pinyin-primary → balanced → hanzi-primary. This is
// derived, never chosen by the learner, and adapts at the vocabulary level.
// ---------------------------------------------------------------------------

// Global reading readiness 0..1 (drives Laoshi's overall pinyin↔hanzi mix).
export function scriptLevel() {
  const d = db();
  const r = d.prepare("SELECT AVG(score) a, COUNT(*) c FROM word_mastery WHERE dimension='reading' AND exposures>0").get();
  const totalReviews = d.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const readingAbility = r.a ?? 0;
  const experience = Math.min(1, totalReviews / 300);
  return Math.max(0, Math.min(1, 0.65 * readingAbility + 0.35 * experience));
}

// Per-word script mode from that word's own reading mastery, so common words go
// hanzi-first while newer ones stay pinyin-first — no global switch.
export function scriptMode(wordId) {
  const row = db().prepare("SELECT score, exposures FROM word_mastery WHERE word_id=? AND dimension='reading'").get(wordId);
  const s = row?.score ?? 0;
  if (!row || row.exposures === 0 || s < 0.4) return 'pinyin';   // pinyin primary, hanzi secondary
  if (s < 0.7) return 'balanced';                                 // both prominent
  return 'hanzi';                                                 // hanzi primary, pinyin on demand
}

// Directive injected into Laoshi so its LANGUAGE tracks the learner's level. The
// output format never changes — the "hanzi" field is always real characters and
// "pinyin" is always romanization; the UI decides which to emphasize. This
// directive only controls sentence complexity and reading expectations.
export function scriptDirective(level = scriptLevel()) {
  if (level < 0.33) return 'The learner is a beginning reader: use only very simple, high-frequency words and short sentences. They will lean on the pinyin, so keep the characters common.';
  if (level < 0.66) return 'The learner is building reading ability: use natural everyday language and gradually include less-common characters.';
  return 'The learner reads well: you may use richer vocabulary and longer sentences, and rely less on pinyin crutches.';
}
