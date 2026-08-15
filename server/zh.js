// Traditional → Simplified normalization.
//
// Whisper transcribes Mandarin to whichever script its decoder prefers, and for
// `language=zh` that is very often TRADITIONAL: a learner who says "这是猫" gets back
// "這是貓". Everything downstream of the microphone compares characters — the
// correction ladder, the vocabulary guard, the known-character set, the echo test in
// the diagnostics — so an unconverted transcript is not a slightly different string,
// it is a string that matches nothing. The learner says the right sentence and is told
// they used words that are not in the lesson.
//
// No new dependency: the bundled CC-CEDICT already carries a traditional and a
// simplified form for all 124k entries, so the character map falls out of a single
// query over the one-character rows.
import { db } from './db.js';

let _map = null;

// 19 traditional characters have two simplified readings in CC-CEDICT (妳 → 你/奶,
// 乾 → 乾/干, 蘋 → 苹/𬞟 …). They are rare and none are beginner vocabulary, but the
// choice still has to be principled rather than whatever the query returned last:
// take the simplified form that is more common in the frequency list, since that is
// overwhelmingly the one a learner will have said.
function buildMap() {
  const d = db();
  const rows = d.prepare(`SELECT traditional AS t, simplified AS s FROM dictionary
    WHERE length(traditional) = 1 AND length(simplified) = 1 AND traditional <> simplified`).all();
  const rank = new Map();
  for (const r of d.prepare('SELECT word, rank FROM frequency WHERE length(word) = 1').all()) rank.set(r.word, r.rank);
  const best = new Map();
  for (const { t, s } of rows) {
    const prev = best.get(t);
    if (!prev) { best.set(t, s); continue; }
    if ((rank.get(s) ?? Infinity) < (rank.get(prev) ?? Infinity)) best.set(t, s);
  }
  return best;
}

function map() {
  if (!_map) { try { _map = buildMap(); } catch { _map = new Map(); } }
  return _map;
}

// Convert any traditional characters to simplified. Safe to call on text that is
// already simplified: the map only contains characters whose two forms DIFFER, so a
// simplified character is never a key and is passed through untouched. (面, 后 and
// friends are identical in both scripts, so they are excluded by construction and
// cannot be mangled into the wrong one.)
export function toSimplified(text = '') {
  const m = map();
  if (!m.size) return String(text);
  let out = '';
  for (const ch of String(text)) out += m.get(ch) || ch;
  return out;
}

// Did this text contain traditional forms at all? Used to report what the recognizer
// actually returned, so a script mismatch stays visible rather than being silently
// papered over.
export function looksTraditional(text = '') {
  const m = map();
  for (const ch of String(text)) if (m.has(ch)) return true;
  return false;
}
