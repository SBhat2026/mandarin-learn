// The hidden learner model. Never surfaced to the learner as scores or ratings —
// it silently decides what to teach and test next.
//
// Per word we track six independent skill dimensions. One FSRS "memory" card
// schedules WHEN a word returns; these sub-scores pick WHICH exercise to show
// (always the weakest unlocked dimension) and drive the acquisition stage.
import { db, DIMENSIONS, getModel, setModel } from './db.js';
import { weakTone } from './tone.js';
import { getInterests } from './interests.js';

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
// `bias` (dimension → additive nudge) lets the planner lean the whole session
// toward the learner's globally weakest modality without overriding a word's own
// weakest dimension. Invisible personalization.
export function weakestDimension(wordId, { hasSentence = false, avoid = null, bias = null } = {}) {
  const m = getMastery(wordId);
  const unlocked = unlockedDimensions(wordId, hasSentence);
  let best = null, bestNeed = -Infinity;
  for (const d of unlocked) {
    const row = m[d];
    const uncertainty = row.alpha * row.beta / ((row.alpha + row.beta) ** 2 * (row.alpha + row.beta + 1));
    let need = (1 - row.score) + 2.5 * uncertainty;
    if (row.exposures === 0) need += 0.15;        // gentle nudge to cover untested skills
    if (d === avoid) need -= 0.4;
    if (bias && bias[d]) need += bias[d];
    if (need > bestNeed) { bestNeed = need; best = d; }
  }
  return best || 'meaning';
}

// The learner's globally weakest modality (from inferred per-dimension ability),
// as a small bias map to feed weakestDimension. Only meaningful once there's data.
export function modalityBias() {
  const t = traits();
  const ab = t?.dimAbility;
  if (!ab) return null;
  const scored = DIMENSIONS
    .map(d => ({ d, a: ab[d]?.ability }))
    .filter(x => x.a != null);
  if (scored.length < 2) return null;
  scored.sort((a, b) => a.a - b.a);
  const bias = {};
  bias[scored[0].d] = 0.2;                          // weakest modality gets a nudge
  if (scored[1]) bias[scored[1].d] = 0.08;
  return bias;
}

// ── Automatic modality emphasis (Workstream J) ──────────────────────────────
// Infer the learner's stronger CHANNEL (read-write/visual vs auditory) purely from
// behavior — no setting. Signals accumulate in learner_model.channel_obs:
//   reveal_text : they tapped to reveal hidden text (leaning on reading)
//   kept_audio  : they answered/continued from an audio-only turn without revealing
//                 (comfortable listening)
// Blended with per-dimension ability (listening vs reading) so it self-corrects.
export function recordChannelSignal(kind) {
  const obs = getModel('channel_obs', { reveal_text: 0, kept_audio: 0 }) || { reveal_text: 0, kept_audio: 0 };
  if (kind === 'reveal_text') obs.reveal_text = (obs.reveal_text || 0) + 1;
  else if (kind === 'kept_audio') obs.kept_audio = (obs.kept_audio || 0) + 1;
  else return obs;
  setModel('channel_obs', obs);
  return obs;
}

// Presentation bias derived from channel behavior + ability. Drives how readily text/
// pinyin show, whether audio autoplays, and how often a turn is delivered audio-first.
// Converges quietly on the learner's real preference; hidden. Defaults are neutral.
export function presentationBias() {
  const obs = getModel('channel_obs', { reveal_text: 0, kept_audio: 0 }) || {};
  const reveals = obs.reveal_text || 0, kept = obs.kept_audio || 0;
  const behaviorN = reveals + kept;
  // Behavioral lean in [-1,1]: + = auditory-comfortable, - = text-reliant.
  const behavior = behaviorN >= 3 ? (kept - reveals) / behaviorN : 0;

  // Ability lean: listening ability minus reading ability (if known).
  const t = traits();
  const ab = t?.dimAbility;
  let ability = 0;
  if (ab?.listening?.ability != null && ab?.reading?.ability != null) {
    ability = clamp((ab.listening.ability - ab.reading.ability) * 2, -1, 1);
  }
  const lean = clamp(0.6 * behavior + 0.4 * ability, -1, 1);   // + auditory, - visual
  const confidence = clamp(behaviorN / 8 + (ab ? 0.3 : 0), 0, 1);

  return {
    channel: lean > 0.25 ? 'auditory' : lean < -0.25 ? 'visual' : 'balanced',
    lean, confidence,
    autoplay: true,                                   // audio always available; cheap
    // Only hide-text-first for auditory-leaning learners, and only once we have some
    // signal. Visual learners never get audio-first (they rely on reading).
    audioFirstProb: lean > 0.15 ? Math.min(0.4, 0.5 * lean) * confidence : 0,
    // Image anchors help visual learners most, but are broadly gentle — show when not
    // strongly auditory.
    images: lean < 0.4,
  };
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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
    pronunciation: pronunciationTraits(),
    // Reading vs listening lean (>0 = stronger reader).
    readingVsListening: (dimAbility.reading.ability ?? 0) - (dimAbility.listening.ability ?? 0),
  };
  setModel('traits', traits);
  return traits;
}

// Aggregate the invisible pronunciation telemetry into initial/final confusion
// matrices and mean fluency/hesitation/confidence. Feeds Laoshi + the planner.
function pronunciationTraits() {
  const rows = db().prepare(`SELECT tone_source, target_tone, heard_tone, initial_conf, final_conf,
    fluency, hesitation, confidence, accuracy FROM pron_signals ORDER BY ts DESC LIMIT 300`).all();
  if (!rows.length) return null;
  const initials = {}, finals = {}, toneMiss = {};
  const meanOf = (key) => { const v = rows.map(r => r[key]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  for (const r of rows) {
    for (const e of safeArr(r.initial_conf)) { const k = `${e.target}→${e.heard}`; initials[k] = (initials[k] || 0) + 1; }
    for (const e of safeArr(r.final_conf)) { const k = `${e.target}→${e.heard}`; finals[k] = (finals[k] || 0) + 1; }
    const tt = String(r.target_tone || '').split('-'), ht = String(r.heard_tone || '').split('-');
    for (let i = 0; i < tt.length; i++) {
      const a = tt[i], b = ht[i];
      if (/^[1-5]$/.test(a) && /^[1-5]$/.test(b) && a !== b) { const k = `${a}→${b}`; toneMiss[k] = (toneMiss[k] || 0) + 1; }
    }
  }
  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([pair, count]) => ({ pair, count }));
  return {
    samples: rows.length,
    initialConfusion: top(initials),
    finalConfusion: top(finals),
    toneConfusion: top(toneMiss),
    fluency: meanOf('fluency'),
    hesitation: meanOf('hesitation'),
    confidence: meanOf('confidence'),
  };
}
function safeArr(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

export function traits() {
  return getModel('traits', null);
}

// ---------------------------------------------------------------------------
// Progressive script exposure. Reading strength grows continuously, so script
// emphasis shifts from pinyin-primary → balanced → hanzi-primary. This is
// derived, never chosen by the learner, and adapts at the vocabulary level.
// ---------------------------------------------------------------------------

// Global reading readiness 0..1 (drives Laoshi's overall pinyin↔hanzi mix).
// Beginners start firmly in pinyin: hanzi is phased in only as the learner
// actually reads a BREADTH of characters, not because a handful score high.
// A few well-known words can't jump the level — you need ~250 solidly-read
// words before hanzi becomes primary, so the transition is gradual and earned.
export function scriptLevel() {
  const d = db();
  // Words the learner can genuinely read (solid score, seen more than once).
  const readWords = d.prepare(
    "SELECT COUNT(*) c FROM word_mastery WHERE dimension='reading' AND score>0.6 AND exposures>=2"
  ).get().c;
  const abilityRow = d.prepare(
    "SELECT AVG(score) a FROM word_mastery WHERE dimension='reading' AND exposures>0"
  ).get();
  const breadth = Math.min(1, readWords / 250);       // 0 until real reading history
  const ability = abilityRow.a ?? 0;
  // Breadth gates everything; ability only modulates within what breadth allows.
  return Math.max(0, Math.min(1, breadth * (0.5 + 0.5 * ability)));
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

// ---------------------------------------------------------------------------
// Personalization directive for Laoshi. Translates the HIDDEN learner model into
// behavior guidance the teacher can act on — never into anything the learner sees
// as a score. Covers confidence/pace, interests, and weak-tone reinforcement.
// ---------------------------------------------------------------------------
const TONE_NAME = { 1: 'first (high level)', 2: 'second (rising)', 3: 'third (dipping)', 4: 'fourth (falling)', 5: 'neutral' };

// A couple of words that exercise the learner's weakest tone, for Laoshi to weave
// in naturally. Prefers words with audio so native pronunciation is available.
export function weakToneWords(tone, limit = 4) {
  if (!tone) return [];
  return db().prepare(`SELECT w.hanzi, w.pinyin FROM words w
    JOIN cards c ON c.item_type='word' AND c.item_id=w.id AND c.card_type='memory'
    WHERE w.tone_pattern LIKE ? AND c.state>0
    ORDER BY COALESCE(w.freq_rank,999999) ASC LIMIT ?`).all(`%${tone}%`, limit).map(r => r.hanzi);
}

export function personaDirective() {
  const t = traits();
  const bits = [];

  const conf = t?.confidence;
  if (conf != null) {
    if (conf < 0.45) bits.push('This learner is tentative: be especially warm and encouraging, keep every turn very short, and make replying feel safe and low-stakes.');
    else if (conf > 0.78) bits.push('This learner is confident: you can gently stretch them with slightly longer replies and a follow-up question.');
  }

  const interests = getInterests().slice(0, 4).map(i => i.topic).filter(Boolean);
  if (interests.length) bits.push(`Lean the conversation toward topics they enjoy: ${interests.join(', ')}.`);

  const weak = weakTone();
  const words = weak ? weakToneWords(weak.tone) : [];
  if (weak && words.length) {
    bits.push(`They find the ${TONE_NAME[weak.tone] || weak.tone} tone tricky — naturally reuse words like ${words.join(' ')} so they get gentle extra practice hearing and saying it. Never mention tones or that you are doing this.`);
  }

  const pron = t?.pronunciation;
  if (pron?.hesitation != null && pron.hesitation > 0.6) bits.push('They tend to pause before speaking — give them a beat and keep prompts simple and concrete.');

  return { directive: bits.join(' '), interests, weakTone: weak?.tone ?? null };
}
