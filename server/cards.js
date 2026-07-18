import { db } from './db.js';
import { State } from './fsrs.js';

export const WORD_CARD_TYPES = ['listening', 'reading', 'speaking'];
export const SENTENCE_CARD_TYPES = ['listening', 'reading'];

const insertCard = () => db().prepare(
  `INSERT OR IGNORE INTO cards(item_type, item_id, card_type, state) VALUES(?,?,?,0)`);

export function createCardsForWord(wordId) {
  const stmt = insertCard();
  for (const t of WORD_CARD_TYPES) stmt.run('word', wordId, t);
}

export function createCardsForSentence(sentenceId) {
  const stmt = insertCard();
  for (const t of SENTENCE_CARD_TYPES) stmt.run('sentence', sentenceId, t);
}

export function wordHasCards(wordId) {
  return !!db().prepare(`SELECT 1 FROM cards WHERE item_type='word' AND item_id=? LIMIT 1`).get(wordId);
}

// A word is "learned enough" when its listening+reading are in review state.
export function wordInReview(wordId) {
  const row = db().prepare(
    `SELECT MIN(state) m, COUNT(*) c FROM cards
       WHERE item_type='word' AND item_id=? AND card_type IN ('listening','reading')`).get(wordId);
  return row.c >= 1 && row.m >= State.Review;
}

// Create sentence cards for any sentence whose known words are all in review.
export function unlockSentences(limit = 20) {
  const created = [];
  const sentences = db().prepare(
    `SELECT s.id, s.word_ids FROM sentences s
       WHERE s.word_ids IS NOT NULL AND s.word_ids != '[]'
         AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_type='sentence' AND c.item_id=s.id)`).all();
  for (const s of sentences) {
    if (created.length >= limit) break;
    let ids = [];
    try { ids = JSON.parse(s.word_ids); } catch { continue; }
    if (!ids.length) continue;
    if (ids.every(wordInReview)) { createCardsForSentence(s.id); created.push(s.id); }
  }
  return created;
}

// Hydrate a card row with its item payload for the client.
export function hydrate(card) {
  if (card.item_type === 'word') {
    const w = db().prepare('SELECT hanzi, pinyin, english, tone_pattern, audio_path FROM words WHERE id=?').get(card.item_id);
    return { ...card, ...w, kind: 'word' };
  }
  const s = db().prepare('SELECT hanzi, pinyin, english, audio_path, pattern_tag, source FROM sentences WHERE id=?').get(card.item_id);
  return { ...card, ...s, kind: 'sentence' };
}
