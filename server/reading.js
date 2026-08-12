// Sentence-level reading practice, graded by CHARACTER COVERAGE.
//
// This used to demand that every word in a sentence be in review state, which is a
// word-level gate on a character-level skill: a sentence made of five known words
// and one unknown character was rejected outright, while the coverage research says
// that sentence is exactly the one worth reading (~95% known ≈ reasonable
// comprehension, ~98% ≈ comfortable). Below ~90% it stops being reading and becomes
// decoding, so that is where the floor sits.
import { db } from './db.js';
import { charCoverage, readabilityBand, knownCharacters } from './orthography.js';

const PASSAGE_FLOOR = 0.90;   // below this a passage is decoding practice, not reading
const MAX_NEW_PER_SENTENCE = 1;

// Assemble short read-aloud passages the learner can actually get through.
//
// The floor is applied to the PASSAGE, not to each sentence: coverage is a
// running-text measure, and one unknown character in a four-character sentence
// scores 75% while being exactly the kind of line a learner should read. So a
// sentence is admitted on "at most one character you haven't met" and the 90% floor
// then governs the passage as a whole.
//
// Order matters as much as selection. A first passage of fully-known sentences is a
// warm-up; after that the ~95% band is where characters are actually acquired from
// context, so passages deliberately climb into it rather than staying at 100%.
export function passages({ size = 5, max = 6 } = {}) {
  const known = knownCharacters();
  if (!known.size) return [];

  const rows = db().prepare(`
    SELECT id, hanzi, pinyin, english, word_ids, audio_path, pattern_tag, source
    FROM sentences WHERE hanzi IS NOT NULL AND length(hanzi) BETWEEN 4 AND 24`).all();

  const clean = [], stretch = [];
  for (const s of rows) {
    const cov = charCoverage(s.hanzi, known);
    if (cov.total < 2) continue;
    const graded = { ...s, coverage: cov.coverage, unknown: cov.unknown, band: readabilityBand(cov.coverage) };
    if (!cov.unknown.length) clean.push(graded);
    else if (cov.unknown.length <= MAX_NEW_PER_SENTENCE) stretch.push(graded);
  }
  if (!clean.length && !stretch.length) return [];

  clean.sort((a, b) => a.hanzi.length - b.hanzi.length);
  // Among stretch sentences, the most supported context wins — a new character is
  // guessable when everything around it is known.
  stretch.sort((a, b) => (b.coverage - a.coverage) || (a.hanzi.length - b.hanzi.length));

  // One warm-up group, then alternate so each passage mixes consolidation with a
  // little new. Falls back gracefully when either pool is empty.
  const ordered = [...clean.slice(0, size)];
  let ci = size, si = 0;
  while (ordered.length < size * max && (ci < clean.length || si < stretch.length)) {
    for (let k = 0; k < 2 && si < stretch.length; k++) ordered.push(stretch[si++]);
    if (ci < clean.length) ordered.push(clean[ci++]);
  }

  const out = [];
  for (let i = 0; i < ordered.length && out.length < max; i += size) {
    const group = ordered.slice(i, i + size);
    if (group.length < 2) break;
    const chars = group.reduce((n, s) => n + [...s.hanzi].length, 0);
    const unknown = group.reduce((n, s) => n + s.unknown.length, 0);
    const coverage = chars ? (chars - unknown) / chars : 1;
    if (coverage < PASSAGE_FLOOR) continue;
    out.push({ index: out.length + 1, sentences: group, coverage, band: readabilityBand(coverage) });
  }
  return out;
}
