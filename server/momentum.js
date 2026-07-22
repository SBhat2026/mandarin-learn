// Hidden conversational health signals. Momentum is a live scalar (0..1) inferred
// per turn from how the learner is engaging — response-length trend, question-
// asking, on-topic continuation vs one-word stalling. It separates EDUCATIONAL
// completion (the blueprint's budget met + a capability demonstrated) from
// CONVERSATIONAL completion (momentum decays / exchange ceiling / fatigue), so a
// conversation ends naturally rather than at a fixed turn count. Never surfaced.

const CJK = /[一-鿿]/;
const textOf = (t) => t.hanzi || t.content || '';
const len = (t) => [...textOf(t)].filter(c => CJK.test(c) || /\w/.test(c)).length;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const isQuestion = (t) => /[?？]/.test(textOf(t));

// Momentum in [0,1] from the transcript so far. Warm at the start (benefit of the
// doubt), then driven by whether the learner is leaning in or trailing off.
export function computeMomentum(transcript = []) {
  const learner = transcript.filter(t => t.role === 'user');
  if (learner.length < 2) return 1;
  const lens = learner.map(len);
  const recent = lens.slice(-2);
  const earlier = lens.slice(0, Math.max(1, lens.length - 2));
  const recentAvg = avg(recent), earlierAvg = avg(earlier) || recentAvg;

  // Engagement trend: recent replies growing vs shrinking (clamped).
  const trend = Math.min(1.4, recentAvg / (earlierAvg || 1)) / 1.4;
  // Curiosity: learner asking questions keeps momentum up.
  const questions = learner.filter(isQuestion).length;
  const curiosity = Math.min(1, questions / 2);
  // Stalling: very short recent replies (one-word / "对" / "是") drain momentum.
  const alive = recentAvg < 2 ? 0.3 : recentAvg < 4 ? 0.7 : 1;

  return clamp01(0.45 * trend + 0.2 * curiosity + 0.35 * alive);
}

// Hidden per-conversation metrics (Workstream F). `targetVocab` lets us count
// spontaneous (learner-initiated) target-word use vs merely-exposed.
export function computeMetrics(transcript = [], plan = {}) {
  const learner = transcript.filter(t => t.role === 'user');
  const teacher = transcript.filter(t => t.role === 'assistant');
  const target = plan.targetVocab || [];
  const norm = (s = '') => String(s).replace(/[\s\p{P}\p{S}]/gu, '');

  let spontaneous = 0;
  const usedIds = new Set();
  for (const v of target) {
    const said = learner.some(t => v.hanzi && norm(textOf(t)).includes(norm(v.hanzi)));
    const exposedFirst = teacher.some(t => v.hanzi && norm(textOf(t)).includes(norm(v.hanzi)));
    if (said && !usedIds.has(v.wordId)) { usedIds.add(v.wordId); if (!exposedFirst) spontaneous++; }
  }

  return {
    learner_initiated_questions: learner.filter(isQuestion).length,
    spontaneous_vocab: spontaneous,
    avg_learner_len: Number(avg(learner.map(len)).toFixed(2)),
    branches: countBranches(learner),
    corrections: teacher.filter(t => t.note).length,
    exchanges: learner.length,
    max_question_rung: maxQuestionRung(learner),
    momentum: Number(computeMomentum(transcript).toFixed(3)),
  };
}

// A "branch" ≈ the learner steering the conversation themselves: asking a question
// or making a substantial statement (not a one-word acknowledgment).
function countBranches(learner) {
  return learner.filter(t => isQuestion(t) || len(t) >= 5).length;
}

// Rough estimate of the highest question-ladder rung the learner OPERATED at, from
// the shape of their turns. Index into QUESTION_RUNGS (0..5). Heuristic, hidden.
function maxQuestionRung(learner) {
  let rung = 0;
  for (const t of learner) {
    const s = textOf(t), l = len(t);
    if (l >= 4) rung = Math.max(rung, 2);                                  // personal_experience
    if (/比|更|最|一样/.test(s)) rung = Math.max(rung, 3);                  // comparison
    if (/因为|所以|觉得|因此|由于/.test(s)) rung = Math.max(rung, 4);        // explanation
    if (l >= 12) rung = Math.max(rung, 5);                                  // creation (extended production)
  }
  return rung;
}

// Live completion decision. Prefer to satisfy education before wrapping, but never
// run past the momentum/budget ceiling.
export function liveCompletion(transcript = [], blueprint = {}, plan = {}) {
  const [min, max] = blueprint.budget?.exchanges || [4, 8];
  const exchanges = transcript.filter(t => t.role === 'user').length;
  const momentum = computeMomentum(transcript);
  const metrics = computeMetrics(transcript, plan);

  // Educational completion: enough exchanges to have woven the material AND at least
  // one spontaneous use of a target word (a rough in-flight demonstration proxy).
  const eduReady = exchanges >= min && metrics.spontaneous_vocab >= 1;

  let reason = null;
  if (exchanges >= max) reason = 'budget';                        // hard ceiling
  else if (momentum < 0.32 && exchanges >= Math.max(2, min - 1)) reason = 'momentum';
  else if (eduReady && momentum < 0.5) reason = 'educational';    // done + energy fading

  return { shouldWrap: !!reason, reason, momentum, metrics };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
