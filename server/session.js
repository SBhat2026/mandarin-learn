import { db } from './db.js';
import { State, applyRating } from './fsrs.js';
import { hydrate, createCardsForWord, unlockSentences } from './cards.js';
import { dailyNew, newWordsStartedToday } from './scheduler.js';
import { weakTone, buildToneDrill } from './tone.js';
import { maybeHandleLeech } from './leech.js';
import { updateMastery, inferTraits } from './learner.js';
import { buildLesson, refreshStage } from './planner.js';
import { analyzeSpoken, accuracyToRating, persistPronunciation } from './pronunciation.js';

// The adaptive lesson is the primary session source.
export { buildLesson };

// The current unit = first unit not yet completed (< 80% of its words in review).
export function currentUnit() {
  const units = db().prepare('SELECT * FROM units ORDER BY position').all();
  for (const u of units) {
    if (!unitCompleted(u)) return u;
  }
  return units[units.length - 1] || null;
}

export function unitProgress(unit) {
  let ids = [];
  try { ids = JSON.parse(unit.word_ids || '[]'); } catch {}
  if (!ids.length) return { total: 0, review: 0, ratio: 1 };
  const placeholders = ids.map(() => '?').join(',');
  const row = db().prepare(`
    SELECT COUNT(DISTINCT item_id) c FROM cards
     WHERE item_type='word' AND item_id IN (${placeholders})
       AND card_type='memory' AND state >= ${State.Review}`).get(...ids);
  return { total: ids.length, review: row.c, ratio: row.c / ids.length };
}

export function unitCompleted(unit) {
  return unitProgress(unit).ratio >= 0.8;
}

// Sentence cards are playable only when all their known words are in review.
function sentenceUnlocked(itemId) {
  const s = db().prepare('SELECT word_ids FROM sentences WHERE id=?').get(itemId);
  let ids = [];
  try { ids = JSON.parse(s?.word_ids || '[]'); } catch {}
  if (!ids.length) return false;
  const placeholders = ids.map(() => '?').join(',');
  const row = db().prepare(`
    SELECT COUNT(DISTINCT item_id) c FROM cards
      WHERE item_type='word' AND item_id IN (${placeholders})
        AND card_type='memory' AND state >= ${State.Review}`).get(...ids);
  return row.c === ids.length;
}

function dueCards(now) {
  const rows = db().prepare(`
    SELECT * FROM cards
      WHERE state > 0 AND suspended = 0 AND due <= ?
      ORDER BY due ASC`).all(now.toISOString());
  return rows.filter(c => c.item_type !== 'sentence' || sentenceUnlocked(c.item_id));
}

// Introduce up to the remaining daily-new budget of new words from unlocked units.
function newQueue(unit) {
  const budget = Math.max(0, dailyNew() - newWordsStartedToday());
  if (budget <= 0) return [];

  // Existing new word-cards already created but not yet reviewed.
  const existingNew = db().prepare(`
    SELECT * FROM cards WHERE item_type='word' AND state=0 AND suspended=0`).all();
  const seenWords = new Set(existingNew.map(c => c.item_id));

  // Candidate words: in units up to the current unit, with no card yet.
  const unitsUpto = db().prepare('SELECT word_ids FROM units WHERE position <= ? ORDER BY position')
    .all(unit ? unit.position : 1_000_000);
  const ordered = [];
  for (const u of unitsUpto) {
    let ids = [];
    try { ids = JSON.parse(u.word_ids || '[]'); } catch {}
    ordered.push(...ids);
  }
  const withCards = new Set(db().prepare(`SELECT DISTINCT item_id FROM cards WHERE item_type='word'`).all().map(r => r.item_id));

  const introduce = [];
  for (const id of ordered) {
    if (seenWords.size + introduce.length >= budget) break;
    if (withCards.has(id) || seenWords.has(id)) continue;
    introduce.push(id);
  }
  const tx = db().transaction(() => { for (const id of introduce) createCardsForWord(id); });
  tx();

  // Return new word cards for the introduced + pre-existing new words, capped to budget words.
  const budgetWords = new Set([...seenWords, ...introduce].slice(0, budget));
  const cards = db().prepare(`SELECT * FROM cards WHERE item_type='word' AND state=0 AND suspended=0`).all()
    .filter(c => budgetWords.has(c.item_id));
  return cards;
}

export function buildSession({ now = new Date() } = {}) {
  const unit = currentUnit();
  unlockSentences();                    // make newly-eligible sentence cards
  const due = dueCards(now).map(hydrate);
  const fresh = newQueue(unit).map(hydrate);

  const weak = weakTone();
  const drill = weak ? { tone: weak.tone, pair: weak.pair, items: buildToneDrill(weak.pair, 6) } : null;

  return {
    unit: unit ? { ...unit, progress: unitProgress(unit) } : null,
    counts: { due: due.length, new: fresh.length, dailyNew: dailyNew(), newDoneToday: newWordsStartedToday() },
    toneDrill: drill && drill.items.length ? drill : null,
    due, new: fresh,
  };
}

// Persist a review, advance the shared FSRS memory card using the dimension just
// tested, update that dimension's mastery, refresh the acquisition stage, log
// telemetry, and trigger leech handling.
export async function submitReview({ cardId, rating, durationMs, targetTone, heardTone, dimension, exercise, spoken }) {
  const card = db().prepare('SELECT * FROM cards WHERE id=?').get(cardId);
  if (!card) throw new Error('card not found');
  const now = new Date();

  // Spoken tasks: analyze the utterance server-side (invisible). This yields the
  // real heard-tone pattern (STT never reports it) plus a hidden accuracy that we
  // trust over any client-side self-grade when it's available.
  let analysis = null;
  if (spoken && card.item_type === 'word' && (exercise === 'pronounce' || exercise === 'production' || dimension === 'pronunciation' || dimension === 'spoken')) {
    const w = db().prepare('SELECT hanzi, pinyin, tone_pattern FROM words WHERE id=?').get(card.item_id);
    if (w) {
      analysis = analyzeSpoken({ targetHanzi: w.hanzi, targetPinyin: w.pinyin, spoken });
      targetTone = targetTone || analysis.targetTonePattern;
      heardTone = analysis.heardTonePattern || heardTone;
      if (analysis.toneSource !== 'none' || analysis.contentMatch) rating = accuracyToRating(analysis.accuracy);
    }
  }

  const next = applyRating(card, rating, dimension, now);
  const correct = rating >= 3 ? 1 : 0;

  const tx = db().transaction(() => {
    db().prepare(`UPDATE cards SET due=@due, stability=@stability, difficulty=@difficulty,
        elapsed_days=@elapsed_days, scheduled_days=@scheduled_days, reps=@reps,
        lapses=@lapses, state=@state, last_review=@last_review, dimension=@dimension WHERE id=@id`)
      .run({ ...next, dimension: dimension ?? null, id: cardId });
    const info = db().prepare(`INSERT INTO reviews(card_id, ts, rating, duration_ms, target_tone, heard_tone)
        VALUES(?,?,?,?,?,?)`)
      .run(cardId, now.toISOString(), rating, durationMs ?? null, targetTone ?? null, heardTone ?? null);
    if (dimension) {
      db().prepare(`INSERT INTO review_dims(review_id, dimension, exercise, correct, latency_ms)
          VALUES(?,?,?,?,?)`).run(info.lastInsertRowid, dimension, exercise ?? null, correct, durationMs ?? null);
      if (card.item_type === 'word') updateMastery(card.item_id, dimension, rating);
    }
    if (analysis) persistPronunciation({ wordId: card.item_id, source: 'exercise', analysis });
  });
  tx();

  const stage = refreshStage(card.item_type, card.item_id);
  try { inferTraits(); } catch {}          // keep the hidden model fresh (cheap, no LLM)
  const updated = db().prepare('SELECT * FROM cards WHERE id=?').get(cardId);
  let leechExamples = null;
  try { leechExamples = await maybeHandleLeech(updated); } catch {}

  return { card: updated, next, leechExamples, stage };
}
