// Conversation is the primary source of contextual learning. After a lesson
// dialogue with Laoshi we (1) capture the actual sentences as each word's
// examples, (2) infer how well each target concept was understood from how it
// was used, and (3) schedule future review from that inference — no grade buttons.
import { db } from './db.js';
import { createCardsForWord } from './cards.js';
import { submitReview } from './session.js';
import { updateMastery } from './learner.js';
import { llmUnderstanding } from './reasoner.js';
import { bumpInterests } from './interests.js';
import { analyzeSpoken, persistPronunciation, accuracyToRating } from './pronunciation.js';
import { recordCapabilityDemonstration } from './capabilities.js';
import { harvestFromTranscript } from './profile.js';
import { computeMetrics } from './momentum.js';
import { refreshLevels } from './level.js';

const norm = (s = '') => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
const tonelessPinyin = (s = '') => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

// Did `text` (hanzi and/or pinyin) contain this vocab word?
function mentions(text, pinyin, word) {
  if (word.hanzi && norm(text).includes(norm(word.hanzi))) return { hit: true, viaHanzi: true };
  if (word.pinyin && pinyin && tonelessPinyin(pinyin).includes(tonelessPinyin(word.pinyin))) return { hit: true, viaHanzi: false };
  return { hit: false };
}

// Heuristic per-word signals from the transcript.
function heuristicSignals(transcript, targetVocab) {
  const learner = transcript.filter(t => t.role === 'user');
  const teacher = transcript.filter(t => t.role === 'assistant');
  const learnerEngaged = learner.length > 0;
  const sig = {};
  for (const v of targetVocab) {
    let produced = false, producedHanzi = false, exposed = false;
    for (const t of learner) { const m = mentions(t.hanzi || t.content || '', t.pinyin, v); if (m.hit) { produced = true; producedHanzi = producedHanzi || m.viaHanzi; } }
    for (const t of teacher) { if (mentions(t.hanzi || '', t.pinyin, v).hit) exposed = true; }
    const understood = produced ? 0.9 : (exposed && learnerEngaged ? 0.6 : exposed ? 0.4 : 0.45);
    sig[v.wordId] = { produced, producedHanzi, exposed, understood };
  }
  return sig;
}

// Store each Laoshi turn that used a target word as that word's example sentence
// (source='conversation'), so future review draws on the learner's own dialogue.
export function captureExamples(transcript, targetVocab) {
  const up = db().prepare(`INSERT INTO sentences(hanzi,pinyin,english,word_ids,source)
    VALUES(@hanzi,@pinyin,@english,@word_ids,'conversation')
    ON CONFLICT(hanzi) DO UPDATE SET pinyin=excluded.pinyin, english=excluded.english,
      word_ids=excluded.word_ids, source='conversation'`);
  const setEx = db().prepare('UPDATE words SET example_sentence_id=(SELECT id FROM sentences WHERE hanzi=?) WHERE id=? AND example_sentence_id IS NULL');
  let n = 0;
  const tx = db().transaction(() => {
    for (const t of transcript) {
      if (t.role !== 'assistant' || !t.hanzi || t.hanzi.length < 2) continue;
      const used = targetVocab.filter(v => mentions(t.hanzi, t.pinyin, v).hit);
      if (!used.length) continue;
      up.run({ hanzi: t.hanzi, pinyin: t.pinyin || '', english: t.english || '', word_ids: JSON.stringify(used.map(v => v.wordId)) });
      for (const v of used) setEx.run(t.hanzi, v.wordId);
      n++;
    }
  });
  tx();
  return n;
}

// Infer understanding and schedule review for each target concept. Extended (F):
// also infers capability demonstrations, harvests durable personal facts, and
// records hidden conversation metrics. Everything stays invisible.
export async function scheduleFromConversation({ plan, transcript, sessionId = null, endedReason = null }) {
  const targetVocab = plan.targetVocab || [];
  const sig = heuristicSignals(transcript, targetVocab);

  // Optional invisible-engine refinement of the understanding estimate.
  let llm = null;
  try { llm = await llmUnderstanding(transcript, targetVocab); } catch {}

  const outcomes = [];
  for (const v of targetVocab) {
    const s = sig[v.wordId];
    const score = llm && llm[v.hanzi] != null ? (s.understood + llm[v.hanzi]) / 2 : s.understood;

    // Rating from inferred understanding. Due words that never surfaced stay due.
    let rating, dim;
    if (s.produced) { rating = score >= 0.85 ? 3 : 3; dim = 'spoken'; }
    else if (score >= 0.6) { rating = 2; dim = 'meaning'; }
    else if (v.role !== 'reinforce') { rating = 2; dim = 'meaning'; }  // seed a newly taught concept
    else continue;                                                     // review didn't come up → leave due

    // Ensure the word has a scheduling card, then schedule from the inference.
    createCardsForWord(v.wordId);
    const card = db().prepare(`SELECT id FROM cards WHERE item_type='word' AND item_id=? AND card_type='memory'`).get(v.wordId);
    try { await submitReview({ cardId: card.id, rating, durationMs: 0, dimension: dim, exercise: 'conversation' }); } catch {}

    // Extra multi-dimensional credit: reading if they read/typed hanzi; listening if exposed.
    if (s.producedHanzi) updateMastery(v.wordId, 'reading', rating);
    if (s.exposed) updateMastery(v.wordId, 'listening', s.produced ? 3 : 2);

    outcomes.push({ wordId: v.wordId, hanzi: v.hanzi, produced: s.produced, exposed: s.exposed, understood: Number(score.toFixed(2)), role: v.role });
  }

  // Interests are inferred from what the learner actually engaged with: producing
  // a word counts more than merely meeting it. (Hidden; steers future lessons.)
  bumpInterests(outcomes.filter(o => o.produced).map(o => o.wordId), 2);
  bumpInterests(outcomes.filter(o => !o.produced && o.exposed).map(o => o.wordId), 0.5);

  const examples = captureExamples(transcript, targetVocab);

  // (a) Capability demonstration: did the learner actually EXPRESS the capability
  // (produce ≥1 of its target words, with real production)? Update hidden mastery.
  const metrics = computeMetrics(transcript, plan);
  let capabilityDemo = null;
  if (plan.capability?.id && (outcomes.some(o => o.produced) || metrics.spontaneous_vocab >= 1)) {
    const quality = Math.min(1, 0.55 + 0.08 * metrics.spontaneous_vocab + 0.03 * metrics.avg_learner_len);
    const score = recordCapabilityDemonstration(plan.capability.id, quality);
    capabilityDemo = { capabilityId: plan.capability.id, quality: Number(quality.toFixed(2)), score: Number(score.toFixed(2)) };
  }

  // (b) Harvest durable personal facts + open threads for future personalization.
  let profileHarvest = null;
  try { profileHarvest = await harvestFromTranscript(transcript); } catch {}

  // (b2) Automatic level detection (Workstream E): observe what the learner produced
  // and recompute the productive/receptive bands that steer new-word difficulty.
  try { refreshLevels(transcript); } catch {}

  // (c) Persist the hidden conversation metrics.
  metrics.capability_demos = capabilityDemo ? 1 : 0;
  metrics.ended_reason = endedReason;
  if (sessionId) persistMetrics(sessionId, metrics);

  return { outcomes, examples, capabilityDemo, profileHarvest, metrics };
}

// Store the hidden conversation metrics row.
function persistMetrics(sessionId, m) {
  db().prepare(`INSERT INTO conversation_metrics(session_id, learner_initiated_questions,
      spontaneous_vocab, avg_learner_len, branches, corrections, capability_demos, exchanges,
      max_question_rung, momentum, ended_reason, created)
    VALUES(@session_id,@lq,@sv,@len,@br,@corr,@cd,@ex,@rung,@mom,@reason,datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET learner_initiated_questions=@lq, spontaneous_vocab=@sv,
      avg_learner_len=@len, branches=@br, corrections=@corr, capability_demos=@cd, exchanges=@ex,
      max_question_rung=@rung, momentum=@mom, ended_reason=@reason`)
    .run({ session_id: sessionId, lq: m.learner_initiated_questions, sv: m.spontaneous_vocab,
      len: m.avg_learner_len, br: m.branches, corr: m.corrections, cd: m.capability_demos,
      ex: m.exchanges, rung: m.max_question_rung, mom: m.momentum, reason: m.ended_reason });
}

// Invisible pronunciation observation from a single spoken conversation turn.
// For every target word the learner actually said, analyze the utterance and
// fold the result into hidden telemetry + pronunciation mastery. Pronunciation
// thus permeates conversation instead of living in an isolated drill.
export function observePronunciation({ spoken, targetVocab = [], source = 'conversation' }) {
  const transcript = spoken?.transcript || '';
  const said = targetVocab.filter(v => mentions(transcript, null, v).hit);
  if (!said.length) return { observed: 0 };
  // Acoustic tones only align to a single word when the whole turn IS ~that word;
  // otherwise fall back to transcript-derived tones per matched word.
  const soloUtterance = said.length === 1 && norm(transcript).length <= norm(said[0].hanzi).length + 1;
  let observed = 0;
  for (const v of said) {
    const w = db().prepare('SELECT hanzi, pinyin FROM words WHERE id=?').get(v.wordId);
    if (!w) continue;
    const perWord = { ...spoken, heardTones: soloUtterance ? spoken.heardTones : null };
    const analysis = analyzeSpoken({ targetHanzi: w.hanzi, targetPinyin: w.pinyin, spoken: perWord });
    persistPronunciation({ wordId: v.wordId, source, analysis });
    if (analysis.toneSource !== 'none' || analysis.contentMatch) {
      updateMastery(v.wordId, 'pronunciation', accuracyToRating(analysis.accuracy));
    }
    observed++;
  }
  return { observed };
}

// Which target words appeared in a single turn (for live UI chips).
export function detectUsed(turn, targetVocab) {
  return targetVocab.filter(v => mentions(turn.hanzi || turn.content || '', turn.pinyin, v).hit).map(v => v.wordId);
}
