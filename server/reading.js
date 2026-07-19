import { db } from './db.js';
import { State } from './fsrs.js';

// Words that are in review state (learned) — the vocabulary a passage may use.
function learnedWordIds() {
  return new Set(db().prepare(`
    SELECT DISTINCT item_id FROM cards
    WHERE item_type='word' AND card_type='memory' AND state >= ${State.Review}`).all().map(r => r.item_id));
}

// Assemble short read-aloud passages from sentences whose words are all learned.
export function passages({ size = 5, max = 6 } = {}) {
  const learned = learnedWordIds();
  if (!learned.size) return [];
  const sentences = db().prepare(`
    SELECT id, hanzi, pinyin, english, word_ids, audio_path, pattern_tag, source
    FROM sentences WHERE word_ids IS NOT NULL AND word_ids != '[]'`).all();

  const eligible = sentences.filter(s => {
    let ids = [];
    try { ids = JSON.parse(s.word_ids); } catch { return false; }
    return ids.length && ids.every(id => learned.has(id));
  });

  const out = [];
  for (let i = 0; i < eligible.length && out.length < max; i += size) {
    const group = eligible.slice(i, i + size);
    out.push({ index: out.length + 1, sentences: group });
  }
  return out;
}
