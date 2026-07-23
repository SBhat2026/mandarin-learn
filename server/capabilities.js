// The capability layer. A capability ("describe a living thing") is the primary
// planning objective; vocabulary is selected as the MEANS to it. This module
// scores which capability to work on next and resolves it into concrete focal +
// supporting vocabulary using the requirement refs seeded by ingest/seed-capabilities.
//
// It reuses the existing new-word ranking (planner.newCandidates) and known/due
// sets so capability planning layers ON TOP of the graph engine, not beside it.
import { db } from './db.js';
import { State } from './fsrs.js';
import { introducedWordIds, knownWordIds, newCandidates } from './planner.js';
import { cleanGloss } from './exercises.js';
import { interestWeights } from './interests.js';
import { levelCefr } from './level.js';

// Map a capability's rough CEFR band string to a 0..4 scale (A0..B2).
const CEFR_SCALE = { A0: 0, A1: 1, A2: 2, B1: 3, B2: 4 };
function capCefr(cap) { return CEFR_SCALE[cap?.cefr_ish] ?? null; }

const CJK = /[一-鿿]/;
const MASTERY_READY = 0.5;   // a capability counts as "held" for prereqs at this score

// ---- requirement resolution ------------------------------------------------
// A requirement ref is a resolvable token: "pos:a" | "topic:nature" | "word:好".
// Returns a WHERE fragment + params that select candidate words for that ref.
function refClause(ref) {
  const [kind, ...rest] = ref.split(':');
  const val = rest.join(':');
  if (kind === 'pos') return { sql: "w.pos LIKE ?", params: [`%"${val}"%`] };
  if (kind === 'topic') return { sql: "w.topics LIKE ?", params: [`%"${val}"%`] };
  if (kind === 'word') return { sql: "w.hanzi = ?", params: [val] };
  return null;
}

export function requirementsFor(capabilityId) {
  return db().prepare('SELECT kind, ref, weight FROM capability_requirements WHERE capability_id=?')
    .all(capabilityId);
}

// All vocab-kind refs for a capability, as resolvable clauses.
function vocabRefs(capabilityId) {
  return requirementsFor(capabilityId)
    .filter(r => r.kind === 'vocab')
    .map(r => ({ ...r, clause: refClause(r.ref) }))
    .filter(r => r.clause);
}

// ---- capability catalog + mastery -----------------------------------------
export function getCapability(slugOrId) {
  const col = typeof slugOrId === 'number' ? 'id' : 'slug';
  return db().prepare(`SELECT * FROM capabilities WHERE ${col}=?`).get(slugOrId);
}

export function allCapabilities() {
  return db().prepare('SELECT * FROM capabilities ORDER BY ordering ASC').all();
}

export function capabilityMastery(capabilityId) {
  return db().prepare('SELECT * FROM capability_mastery WHERE capability_id=?').get(capabilityId)
    || { capability_id: capabilityId, score: 0, demonstrations: 0, last_demo_at: null };
}

// Fraction of prerequisites the learner already holds (score ≥ MASTERY_READY).
// Capabilities with no prereqs are always fully ready.
export function prerequisiteReadiness(capability) {
  let prereqs = [];
  try { prereqs = JSON.parse(capability.prerequisites_json || '[]'); } catch {}
  if (!prereqs.length) return 1;
  let held = 0;
  for (const slug of prereqs) {
    const cap = getCapability(slug);
    if (cap && capabilityMastery(cap.id).score >= MASTERY_READY) held++;
  }
  return held / prereqs.length;
}

// ---- vocabulary resolution -------------------------------------------------
// Resolve a capability into concrete vocabulary: a focal NEW word (the fresh
// means this session introduces) plus supporting words the learner already has
// (so the capability is expressible), and any due words that fall in its pool.
export function resolveVocab(capability, { known, dueSet, introduced, newLimit = 40 } = {}) {
  known = known || knownWordIds();
  introduced = introduced || introducedWordIds();
  dueSet = dueSet || new Set();
  const refs = vocabRefs(capability.id);

  // Supporting = already-introduced words that serve the capability, so Laoshi can
  // build the expression from known ground. Introduced words are already curated,
  // so any positive strength counts (ranked by strength, then frequency).
  const supporting = [];
  for (const id of introduced) {
    const w = wordFull(id);
    if (!w) continue;
    const strength = servedStrength(refs, w);
    if (strength > 0) supporting.push({ ...toVocab(w), weight: strength, due: dueSet.has(id), role: dueSet.has(id) ? 'reinforce' : 'support' });
  }
  supporting.sort((a, b) => b.weight - a.weight || (a.freq_rank || 9e9) - (b.freq_rank || 9e9));

  // Focal = the best NEW word that CREDIBLY serves this capability. The candidate
  // pool unions two sources so focal is both TOPICALLY apt and COMPREHENSIBLE:
  //   (a) the concrete-first graph ranker (newCandidates) — comprehensible, well-
  //       connected words, carrying a plannerScore;
  //   (b) a direct topical/structural pull per requirement — guarantees on-topic
  //       words (e.g. weather words) are considered even if they're not in the
  //       top-frequency slice.
  // Ranking is capability-RELEVANCE first (servedStrength), frequency second, so a
  // weather word beats a generic high-frequency adjective. Comprehensible words get
  // a small bonus so, among equally-relevant options, the easier one wins.
  const plannerScore = new Map(newCandidates(newLimit, introduced).map(c => [c.id, c.score]));
  const pool = new Map();
  for (const id of plannerScore.keys()) { const w = wordFull(id); if (w) pool.set(id, w); }
  for (const c of directCandidates(capability, 8)) if (!pool.has(c.id)) pool.set(c.id, c);

  let focal = null, bestF = -Infinity;
  for (const w of pool.values()) {
    if (!qualifiesAsFocal(refs, w)) continue;
    const relevance = servedStrength(refs, w);
    const freqBonus = 2 / Math.log10((w.freq_rank || 999999) + 10);
    const comprehensible = plannerScore.has(w.id) ? 0.6 : 0;
    const combined = 2.5 * relevance + freqBonus + comprehensible;
    if (combined > bestF) { bestF = combined; focal = { ...toVocab(w), role: 'focal', plannerScore: plannerScore.get(w.id) || 0 }; }
  }
  // Fallback: nothing qualified → pull the highest-freq unstudied word matching a
  // structural ref directly, so a capability is never un-teachable.
  if (!focal) focal = directNewWord(capability);

  return {
    focal,
    supporting: supporting.slice(0, 6),
    reviewVocab: supporting.filter(w => w.due).slice(0, 4),
  };
}

// Does a single word row satisfy a ref? (in-memory mirror of refClause)
function testRef(ref, w) {
  const [kind, ...rest] = ref.split(':');
  const val = rest.join(':');
  if (kind === 'pos') { try { return JSON.parse(w.pos || '[]').includes(val); } catch { return false; } }
  if (kind === 'topic') { try { return JSON.parse(w.topics || '[]').includes(val); } catch { return false; } }
  if (kind === 'word') return w.hanzi === val;
  return false;
}

// Content POS that make a TOPIC match trustworthy: nouns and adjectives (things
// you can name/describe). Topic tagging is noisy on frequent function/abstract
// words (作为 "act as", pos p/v, is mis-tagged "numbers"), so a topic match only
// counts when the word is a namable content word. Bare verbs are matched via
// explicit pos:v refs where a capability actually wants them.
const CONTENT_POS = new Set(['n', 'ns', 'nr', 'nz', 'nt', 'a', 'an', 'vn']);
function hasContentPos(w) {
  try { return JSON.parse(w.pos || '[]').some(p => CONTENT_POS.has(p)); } catch { return false; }
}

// How strongly a word serves a capability. Structural (POS/word) matches count in
// full; topic matches only count for content words, and are discounted otherwise.
function servedStrength(refs, w) {
  let strength = 0;
  const content = hasContentPos(w);
  for (const r of refs) {
    if (!testRef(r.ref, w)) continue;
    const kind = r.ref.split(':')[0];
    if (kind === 'pos' || kind === 'word') strength += r.weight;
    else if (kind === 'topic') strength += r.weight * (content ? 1 : 0.1);
  }
  return strength;
}

// A NEW focal word must serve the capability CREDIBLY: match a structural ref, or
// match a topic ref while being a namable content word (noun/adjective).
function qualifiesAsFocal(refs, w) {
  const content = hasContentPos(w);
  for (const r of refs) {
    if (!testRef(r.ref, w)) continue;
    const kind = r.ref.split(':')[0];
    if (kind === 'pos' || kind === 'word') return true;
    if (kind === 'topic' && content) return true;
  }
  return false;
}

// Pull up to `perRef` unstudied words for each requirement directly from the pool,
// so on-topic words are always candidates. Topic refs are guarded to content words.
function directCandidates(capability, perRef = 8) {
  const out = new Map();
  for (const r of vocabRefs(capability.id)) {
    const { sql, params } = r.clause;
    const guard = r.ref.startsWith('topic:')
      ? " AND (" + [...CONTENT_POS].map(() => "w.pos LIKE ?").join(' OR ') + ")" : '';
    const guardParams = r.ref.startsWith('topic:') ? [...CONTENT_POS].map(p => `%"${p}"%`) : [];
    const rows = db().prepare(`SELECT w.* FROM words w
      WHERE ${sql}${guard} AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_type='word' AND c.item_id=w.id)
      ORDER BY COALESCE(w.freq_rank,999999) ASC LIMIT ?`).all(...params, ...guardParams, perRef);
    for (const w of rows) out.set(w.id, w);
  }
  return [...out.values()];
}

function directNewWord(capability) {
  // Prefer structural (POS/word) refs; a concrete topic ref only as last resort.
  const refs = vocabRefs(capability.id)
    .sort((a, b) => refPriority(b.ref) - refPriority(a.ref) || b.weight - a.weight);
  for (const r of refs) {
    const { sql, params } = r.clause;
    // For topic refs, require a namable content word (noun/adjective) so topic-tag
    // noise on function words can't surface as a focal word.
    const guard = r.ref.startsWith('topic:')
      ? " AND (" + [...CONTENT_POS].map(() => "w.pos LIKE ?").join(' OR ') + ")" : '';
    const guardParams = r.ref.startsWith('topic:') ? [...CONTENT_POS].map(p => `%"${p}"%`) : [];
    const w = db().prepare(`SELECT w.* FROM words w
      WHERE ${sql}${guard} AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_type='word' AND c.item_id=w.id)
      ORDER BY COALESCE(w.freq_rank,999999) ASC LIMIT 1`).get(...params, ...guardParams);
    if (w) return { ...toVocab(w), role: 'focal', plannerScore: 0 };
  }
  return null;
}
const refPriority = (ref) => (ref.startsWith('word:') ? 3 : ref.startsWith('pos:') ? 2 : 1);

function wordFull(id) { return db().prepare('SELECT * FROM words WHERE id=?').get(id); }
function toVocab(w) {
  return { wordId: w.id, hanzi: w.hanzi, pinyin: w.pinyin, gloss: cleanGloss(w), freq_rank: w.freq_rank,
    audio: w.audio_path || null };
}

// How many of a capability's due words are waiting — review pressure.
function duePressure(capability, dueSet) {
  if (!dueSet.size) return 0;
  const refs = vocabRefs(capability.id);
  if (!refs.length) return 0;
  let n = 0;
  for (const id of dueSet) { const w = wordFull(id); if (w && refs.some(r => testRef(r.ref, w))) n++; }
  return n;
}

// Marginal expressive gain: how much NEW ground this capability opens that the
// learner is *almost* ready for. Approximated by how many of its vocab refs
// resolve to at least one fresh, high-frequency word (a means they can add now).
function expressiveGain(capability, introduced) {
  const refs = vocabRefs(capability.id);
  if (!refs.length) return 0;
  let openable = 0;
  for (const r of refs) {
    const { sql, params } = r.clause;
    const row = db().prepare(`SELECT COUNT(*) c FROM words w
      WHERE ${sql} AND w.freq_rank IS NOT NULL AND w.freq_rank < 4000
        AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_type='word' AND c.item_id=w.id)`).get(...params);
    if (row.c > 0) openable += r.weight;
  }
  return openable;
}

function interestOverlap(capability) {
  const weights = interestWeights();
  if (!weights.size) return 0;
  let best = 0;
  for (const r of requirementsFor(capability.id)) {
    if (r.kind !== 'vocab' || !r.ref.startsWith('topic:')) continue;
    best = Math.max(best, weights.get(r.ref.slice('topic:'.length)) || 0);
  }
  return best;
}

// ---- the primary decision --------------------------------------------------
// Pick the highest-value capability to make this session's objective. Scores by
// prerequisite readiness (can they build on what they have), marginal expressive
// gain, interest, and due-review pressure. Mastered capabilities are de-prioritized
// so the learner keeps expanding what they can say.
export function pickCapability({ introduced, known, dueSet } = {}) {
  introduced = introduced || introducedWordIds();
  known = known || knownWordIds();
  dueSet = dueSet || new Set();

  const caps = allCapabilities();
  if (!caps.length) return null;

  // Inferred learner CEFR (Workstream E). When confident, gently prefer capabilities
  // at or just above the learner's level and discourage ones far above/below — so
  // capability difficulty tracks measured level. Null/low-confidence → no effect.
  const learnerLevel = levelCefr();

  let best = null, bestScore = -Infinity;
  for (const cap of caps) {
    const m = capabilityMastery(cap.id);
    const readiness = prerequisiteReadiness(cap);
    // Only consider capabilities the learner is roughly ready for; unready ones
    // are heavily penalized rather than excluded (so early on, something is picked).
    const readyGate = readiness >= 0.6 ? 0 : -3 * (0.6 - readiness);
    const gain = expressiveGain(cap, introduced);
    const interest = interestOverlap(cap);
    const due = duePressure(cap, dueSet);
    // Prefer not-yet-mastered, gently ordered by curriculum position (earlier
    // capabilities first when all else is equal).
    const masteryPenalty = 2.2 * m.score;
    const orderNudge = -0.02 * (cap.ordering || 0);
    // Level fit: sweet spot is the learner's level or one band above (i+1 stretch).
    let levelFit = 0;
    if (learnerLevel.cefr != null) {
      const cc = capCefr(cap);
      if (cc != null) {
        const delta = cc - learnerLevel.cefr;            // <0 too easy, >1 too hard
        const raw = delta >= 0 && delta <= 1 ? 1 : delta < 0 ? -0.4 * Math.abs(delta) : -0.6 * (delta - 1);
        levelFit = 0.9 * learnerLevel.confidence * raw;
      }
    }
    const score = 1.6 * readiness + 0.9 * gain + 1.2 * interest + 0.8 * due
      - masteryPenalty + readyGate + orderNudge + levelFit;
    if (score > bestScore) { bestScore = score; best = { cap, readiness, gain, interest, due, mastery: m.score, score }; }
  }
  if (!best) return null;

  const vocab = resolveVocab(best.cap, { known, dueSet, introduced });
  return { capability: best.cap, vocab, signals: {
    readiness: best.readiness, gain: best.gain, interest: best.interest, due: best.due, mastery: best.mastery } };
}

// ---- mastery update (called post-conversation from Workstream F) ----------
// Fold an inferred demonstration count into capability mastery (EWMA), analogous
// to word mastery. `quality` in [0,1] reflects how cleanly the capability was
// expressed. Hidden.
export function recordCapabilityDemonstration(capabilityId, quality = 0.9) {
  const cur = capabilityMastery(capabilityId);
  const k = Math.max(0.2, 0.5 / (1 + cur.demonstrations * 0.4));
  const score = cur.score * (1 - k) + Math.min(1, Math.max(0, quality)) * k;
  db().prepare(`INSERT INTO capability_mastery(capability_id,score,demonstrations,last_demo_at)
    VALUES(?,?,?,datetime('now'))
    ON CONFLICT(capability_id) DO UPDATE SET score=excluded.score,
      demonstrations=capability_mastery.demonstrations+1, last_demo_at=excluded.last_demo_at`)
    .run(capabilityId, score, (cur.demonstrations || 0) + 1);
  return score;
}
