// Conversation is the primary source of contextual learning. After a lesson
// dialogue with Laoshi we (1) capture the actual sentences as each word's
// examples, (2) infer how well each target concept was understood from how it
// was used, and (3) schedule future review from that inference — no grade buttons.
import { db } from './db.js';
import { createCardsForWord } from './cards.js';
import { submitReview } from './session.js';
import { updateMastery } from './learner.js';
import { llmUnderstanding } from './reasoner.js';

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

// Infer understanding and schedule review for each target concept.
export async function scheduleFromConversation({ plan, transcript }) {
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

  const examples = captureExamples(transcript, targetVocab);
  return { outcomes, examples };
}

// Which target words appeared in a single turn (for live UI chips).
export function detectUsed(turn, targetVocab) {
  return targetVocab.filter(v => mentions(turn.hanzi || turn.content || '', turn.pinyin, v).hit).map(v => v.wordId);
}
