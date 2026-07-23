// Automatic level detection (Workstream E). Infers the learner's PRODUCTIVE and
// RECEPTIVE level from what they actually use — not a manual setting — and exposes a
// target new-word frequency band + a rough CEFR so the planner can shift lesson
// difficulty to match. This complements FSRS (which times individual items) by
// calibrating the *band* of new material. All hidden; stored in learner_model.
//
// Distinction from Workstream F: THIS sets the cross-session BASELINE band; live
// difficulty calibration handles WITHIN-session swings. They cooperate, stay distinct.
import { db, getModel, setModel } from './db.js';
import { State } from './fsrs.js';

const CJK = /[一-鿿]/;
const cjk = (s) => [...String(s || '')].filter(c => CJK.test(c)).join('');
const textOf = (t) => t.hanzi || t.content || '';

// ---- observing production ---------------------------------------------------
// Segment a learner's Chinese into known dictionary words (greedy longest-match up
// to 4 chars) and return {hanzi, freq_rank, hsk_level} for each recognized word.
function segment(text) {
  const s = cjk(text);
  const out = [];
  const lookup = db().prepare('SELECT id, freq_rank, hsk_level FROM words WHERE hanzi=?');
  let i = 0;
  while (i < s.length) {
    let matched = null;
    for (let len = Math.min(4, s.length - i); len >= 1; len--) {
      const sub = s.slice(i, i + len);
      const w = lookup.get(sub);
      if (w) { matched = { hanzi: sub, freq_rank: w.freq_rank, hsk_level: w.hsk_level }; i += len; break; }
    }
    if (!matched) { i += 1; continue; }
    out.push(matched);
  }
  return out;
}

// From a finished transcript, accumulate which words the learner PRODUCED and how
// often UNPROMPTED (the teacher hadn't already said them earlier in the talk). A
// word must be produced unprompted repeatedly before it lifts the band (noise guard).
export function observeProduction(transcript = []) {
  const obs = getModel('production_obs', {}) || {};
  let teacherSoFar = '';
  let recorded = 0;
  for (const turn of transcript) {
    if (turn.role === 'assistant') { teacherSoFar += cjk(textOf(turn)); continue; }
    if (turn.role !== 'user') continue;
    for (const w of segment(textOf(turn))) {
      const prompted = teacherSoFar.includes(w.hanzi);
      const e = obs[w.hanzi] || { rank: w.freq_rank ?? null, hsk: w.hsk_level ?? null, count: 0, unprompted: 0 };
      e.count += 1;
      if (!prompted) e.unprompted += 1;
      obs[w.hanzi] = e;
      recorded++;
    }
  }
  // Bound the stored map so it can't grow without limit (keep the most-used words).
  const trimmed = Object.entries(obs).sort((a, b) => b[1].count - a[1].count).slice(0, 400);
  setModel('production_obs', Object.fromEntries(trimmed));
  return { recorded };
}

// ---- inference --------------------------------------------------------------
function percentile(nums, p) {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Productive level: from words the learner used UNPROMPTED at least twice. A high
// percentile of their frequency rank = the harder end of what they reliably produce.
export function inferProductiveLevel() {
  const obs = getModel('production_obs', {}) || {};
  const solid = Object.values(obs).filter(e => e.unprompted >= 2);
  if (solid.length < 3) return { rank: null, hsk: null, confidence: 0 };
  const rank = percentile(solid.map(e => e.rank), 0.75);
  const hsk = percentile(solid.map(e => e.hsk).filter(Boolean), 0.75);
  const confidence = clamp(solid.length / 20, 0, 1);
  const out = { rank, hsk, confidence };
  setModel('productive_level', out);
  return out;
}

// Receptive level: from words the learner reliably KNOWS (FSRS review / advanced
// acquisition). Usually a higher band than production. Cross-references the word DB.
export function inferReceptiveLevel() {
  const rows = db().prepare(`SELECT w.freq_rank, w.hsk_level
    FROM cards c JOIN words w ON w.id=c.item_id
    LEFT JOIN acquisition a ON a.item_type='word' AND a.item_id=c.item_id
    WHERE c.item_type='word' AND (c.state>=${State.Review} OR a.stage>=2)`).all();
  if (rows.length < 8) return { rank: null, hsk: null, confidence: 0 };
  const rank = percentile(rows.map(r => r.freq_rank), 0.8);
  const hsk = percentile(rows.map(r => r.hsk_level).filter(Boolean), 0.8);
  const confidence = clamp(rows.length / 60, 0, 1);
  const out = { rank, hsk, confidence };
  setModel('receptive_level', out);
  return out;
}

// Recompute both levels; call after a conversation. Returns the pair.
export function refreshLevels(transcript = []) {
  observeProduction(transcript);
  return { productive: inferProductiveLevel(), receptive: inferReceptiveLevel() };
}

// ---- planner hooks ----------------------------------------------------------
// Target new-word frequency band. New material should sit just BEYOND what the
// learner already comprehends (receptive), stretched a little, so it's reachable but
// not trivial. Smoothed against the previously stored center so the band doesn't
// swing violently session-to-session. Returns null when there isn't enough signal
// (planner then keeps its default most-frequent-first behavior).
export function newWordBand() {
  const receptive = getModel('receptive_level', null);
  const productive = getModel('productive_level', null);
  const recRank = receptive?.rank, confidence = receptive?.confidence ?? 0;
  if (!recRank || confidence < 0.25) return null;
  // Stretch ~30% rarer than the receptive ceiling; never below what they already
  // produce. (Higher rank = rarer/harder.)
  let center = Math.max(recRank * 1.3, productive?.rank || 0);
  const prev = getModel('new_word_band', null);
  if (prev?.center) center = prev.center * 0.6 + center * 0.4;   // smooth
  center = clamp(center, 200, 8000);
  const band = { center, min: center * 0.5, max: center * 1.8, confidence };
  setModel('new_word_band', band);
  return band;
}

// How well a candidate's frequency rank fits the target band, in [0,1]. Peaks at the
// band center, tapers within [min,max], ~0 outside. Weighted lightly by the caller
// so it nudges without overriding comprehensibility/frequency.
export function bandFit(rank, band = newWordBand()) {
  if (!band || !Number.isFinite(rank)) return 0;
  const d = Math.abs(Math.log(rank + 10) - Math.log(band.center + 10));
  const spread = Math.log(band.max + 10) - Math.log(band.center + 10);
  return clamp(1 - d / (spread || 1), 0, 1) * (band.confidence ?? 1);
}

// Rough learner CEFR (0..4 → A0..B2) from inferred HSK, for capability difficulty
// bias. Receptive HSK maps ~2 HSK levels per CEFR band; blended with productive.
export function levelCefr() {
  const receptive = getModel('receptive_level', null);
  const productive = getModel('productive_level', null);
  const hsk = Math.max(receptive?.hsk || 0, (productive?.hsk || 0) + 1);
  const conf = Math.max(receptive?.confidence || 0, productive?.confidence || 0);
  if (!hsk || conf < 0.25) return { cefr: null, confidence: 0 };
  // HSK 1→A1(1), 2→A2(2), 3-4→B1(3), 5-6→B2(4).
  const cefr = hsk <= 1 ? 1 : hsk <= 2 ? 2 : hsk <= 4 ? 3 : 4;
  return { cefr, confidence: conf };
}
