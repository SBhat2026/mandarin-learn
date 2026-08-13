// The ladder rung machine. A conversation is the TOP of a ladder, not the only rung:
// a true beginner starts on a fully-scaffolded guided rung and the scaffolding fades
// automatically as their measured level rises, until it becomes the existing
// Director-driven free conversation.
//
//   rung 0 — Guided        frames + interlinear + always-on scaffolded choices
//   rung 1 — Semi-guided   hybrid generation, lighter interlinear, choices offered
//   rung 2 — Free          the existing blueprint/executor free conversation
//
// The rung is driven by the auto-detected level (level.js) AND a comprehension signal
// (choice accuracy + listening-vs-revealing behaviour), so a beginner who barely
// PRODUCES can still be measured and can still climb. Hysteresis (one step per
// session, a struggle-gate on climbing) keeps it from flapping. All hidden.
import { getModel, setModel } from './db.js';
import { knownWordIds } from './planner.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ── Comprehension signal (extra #2) ─────────────────────────────────────────
// Production-based level detection under-measures a beginner (they barely produce),
// so the ladder ALSO reads comprehension: how often the learner picks a correct
// scaffolded choice, and whether they handle audio-first turns without revealing text
// (comfortable listening) vs leaning on the reveal (still decoding). Neutral 0.6 with
// no data so a fresh user isn't pushed up or stranded down.
export function recordChoiceOutcome(correct) {
  const o = getModel('choice_obs', { correct: 0, total: 0 }) || { correct: 0, total: 0 };
  o.total = (o.total || 0) + 1;
  if (correct) o.correct = (o.correct || 0) + 1;
  setModel('choice_obs', o);
  return o;
}

// The signal used to come from tapping a scaffolded choice. Those are gone — picking
// a glossed chip is recognition wearing production's clothes, and it let a learner
// finish a whole session without composing a sentence. The ladder now reads the same
// store, filled by what the learner actually PRODUCED: a turn accepted without a hard
// correction is the evidence that used to come from a correct tap.
//
// This is a strictly better signal. It is automatic (every typed turn feeds it, with
// no UI to click), and it measures composition rather than selection.
export function recordProductionOutcome({ accepted = false, aside = false } = {}) {
  if (aside) return null;                 // an English question is not a failed sentence
  return recordChoiceOutcome(accepted);
}

export function comprehensionSignal() {
  const ch = getModel('choice_obs', { correct: 0, total: 0 }) || {};
  const chan = getModel('channel_obs', { reveal_text: 0, kept_audio: 0 }) || {};
  const parts = [];
  if ((ch.total || 0) >= 3) parts.push({ v: (ch.correct || 0) / ch.total, w: Math.min(1, ch.total / 8) });
  const behaviorN = (chan.reveal_text || 0) + (chan.kept_audio || 0);
  if (behaviorN >= 3) parts.push({ v: (chan.kept_audio || 0) / behaviorN, w: Math.min(1, behaviorN / 8) });
  if (!parts.length) return { value: 0.6, confidence: 0 };
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  const value = parts.reduce((s, p) => s + p.v * p.w, 0) / (wsum || 1);
  return { value: clamp(value, 0, 1), confidence: clamp(wsum / parts.length, 0, 1) };
}

// ── Rung target from measured level ─────────────────────────────────────────
// Robust to the two real cases: a fresh zero-progress user (nothing known → rung 0)
// and a user with a real known-word base. Level bands (level.js) refine it; the
// comprehension signal gates upward movement.
function rungTarget() {
  const override = getModel('rung_override', null);
  if (override === 0 || override === 1 || override === 2) return override;   // tests / manual

  const knownCount = knownWordIds().size;
  const rec = getModel('receptive_level', null);
  const prod = getModel('productive_level', null);

  let target = 0;
  if (knownCount >= 25 || (rec?.confidence ?? 0) >= 0.25) target = 1;
  if (knownCount >= 120 && (prod?.confidence ?? 0) >= 0.3) target = 2;
  return target;
}

// Current rung with hysteresis. `commit` persists a single-step move toward the
// target (climb only when comprehension is holding; drop immediately when it isn't),
// so difficulty never jumps two rungs or oscillates within a session.
export function currentRung({ commit = false } = {}) {
  const state = getModel('rung_state', { rung: 0 }) || { rung: 0 };
  let rung = clamp(Number(state.rung) || 0, 0, 2);
  const target = rungTarget();
  const comp = comprehensionSignal();

  let next = rung;
  if (target > rung) {
    // Only climb if the learner is comprehending (or the override forces it).
    if (getModel('rung_override', null) != null || comp.value >= 0.5) next = rung + 1;
  } else if (target < rung) {
    next = rung - 1;   // struggle / level slipped → ease off promptly
  }
  next = clamp(next, 0, 2);
  if (commit && next !== rung) setModel('rung_state', { rung: next });
  return next;
}

// The four knobs a rung sets (§2). `interlinear` fades PER CHANNEL (extra #4): full
// (hanzi+pinyin+gloss) → partial (drop the English gloss, keep pinyin) → reveal
// (plain sentence, tap-to-reveal) — so the learner stops leaning on English before
// they stop leaning on pinyin.
export function rungKnobs(rung = 0) {
  switch (clamp(rung, 0, 2)) {
    // `choices` is false at every rung and stays that way: a tap-to-answer chip lets
    // the learner offload the retrieval that IS the learning. `modelAnswer` replaces
    // it — the sentence is available, but only when the learner asks for it, and they
    // still have to produce it themselves.
    case 0: return { rung: 0, interlinear: 'full', newPerTurn: 1, generation: 'frame', choices: false, modelAnswer: 'on-request', name: 'guided' };
    case 1: return { rung: 1, interlinear: 'partial', newPerTurn: 2, generation: 'hybrid', choices: false, modelAnswer: 'on-request', name: 'semi' };
    default: return { rung: 2, interlinear: 'reveal', newPerTurn: 99, generation: 'free', choices: false, modelAnswer: 'off', name: 'free' };
  }
}

// Test/tuning hook: force a rung (0/1/2) or clear (null) the override.
export function setRungOverride(n) {
  if (n === null || n === undefined) setModel('rung_override', null);
  else setModel('rung_override', clamp(Number(n), 0, 2));
}
