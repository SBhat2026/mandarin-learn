import { db, getSetting, setSetting } from './db.js';
import { State } from './fsrs.js';
import { hasApiKey, completeJson } from './anthropic.js';
import { tonePattern } from './pinyin.js';
import { createCardsForSentence } from './cards.js';

export const LEECH_LAPSES = 4;

// Vocabulary the learner already knows (cards in review state) — the only words a
// leech example sentence is allowed to use.
function learnedWords(limit = 400) {
  return db().prepare(`
    SELECT DISTINCT w.hanzi FROM words w
    JOIN cards c ON c.item_type='word' AND c.item_id=w.id
    WHERE c.state >= ${State.Review}
    LIMIT ?`).all(limit).map(r => r.hanzi);
}

function alreadyHandled(cardId) {
  const set = new Set(getSetting('leech_handled', []));
  return set.has(cardId);
}
function markHandled(cardId) {
  const set = new Set(getSetting('leech_handled', []));
  set.add(cardId);
  setSetting('leech_handled', [...set]);
}

// When a card lapses LEECH_LAPSES+ times, generate 2 fresh example sentences that
// reuse the leech word and ONLY already-learned vocabulary. Non-blocking; failures
// are swallowed so the review flow is never affected.
export async function maybeHandleLeech(card) {
  if (!card || card.item_type !== 'word') return null;
  if (card.lapses < LEECH_LAPSES) return null;
  if (alreadyHandled(card.id)) return null;
  markHandled(card.id); // mark first so we never re-run even if generation fails

  if (!hasApiKey()) return null;

  const word = db().prepare('SELECT hanzi, pinyin, english FROM words WHERE id=?').get(card.item_id);
  if (!word) return null;
  const vocab = learnedWords();
  if (vocab.length < 5) return null;

  const system = `You write very short Mandarin example sentences for a beginner.
STRICT: use ONLY these characters/words: ${vocab.join(' ')}.
The sentence MUST contain the target word and use no other vocabulary.
Return ONLY JSON: [{"hanzi":"...","pinyin":"...","english":"..."}, {...}] with exactly 2 items.`;
  let out;
  try {
    out = await completeJson({
      system,
      messages: [{ role: 'user', content: `Target word: ${word.hanzi} (${word.pinyin}) = ${word.english}` }],
      max_tokens: 512,
    });
  } catch { return null; }

  const insert = db().prepare(`
    INSERT OR IGNORE INTO sentences(hanzi, pinyin, english, word_ids, pattern_tag, source)
    VALUES(?,?,?,?,?, 'leech')`);
  const created = [];
  for (const s of (out || []).slice(0, 2)) {
    if (!s.hanzi) continue;
    const info = insert.run(s.hanzi, s.pinyin || '', s.english || '', '[]', 'leech-example');
    const id = info.lastInsertRowid || db().prepare('SELECT id FROM sentences WHERE hanzi=?').get(s.hanzi)?.id;
    if (id) { createCardsForSentence(id); created.push({ id, ...s }); }
  }
  return created.length ? created : null;
}
