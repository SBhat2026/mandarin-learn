import { db } from './db.js';

// Tap-to-lookup. Tries exact simplified/traditional match, then falls back to the
// longest dictionary entry that is a prefix of the query (for tapping into a word).
export function lookup(term) {
  if (!term) return [];
  const exact = db().prepare(`
    SELECT traditional, simplified, pinyin, definitions FROM dictionary
    WHERE simplified=? OR traditional=? LIMIT 8`).all(term, term);
  const rows = exact.length ? exact : longestPrefix(term);
  return rows.map(r => ({
    traditional: r.traditional, simplified: r.simplified, pinyin: r.pinyin,
    definitions: safeParse(r.definitions),
  }));
}

function longestPrefix(term) {
  for (let len = Math.min(term.length, 4); len >= 1; len--) {
    const sub = term.slice(0, len);
    const rows = db().prepare(`
      SELECT traditional, simplified, pinyin, definitions FROM dictionary
      WHERE simplified=? OR traditional=? LIMIT 8`).all(sub, sub);
    if (rows.length) return rows;
  }
  return [];
}

function safeParse(s) { try { return JSON.parse(s); } catch { return [s]; } }
