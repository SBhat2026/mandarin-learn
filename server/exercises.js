// Exercise generators. Given an item + a target dimension, produce the concrete
// activity payload the client renders. Reviews are generated dynamically (varied
// by the learner's weakest dimension) rather than a single fixed flashcard.
import { db } from './db.js';

const CJK = /[一-鿿]/;
const chars = (s) => [...(s || '')].filter(ch => CJK.test(ch));

// A dimension → the interaction mode the client should render.
export const DIM_EXERCISE = {
  meaning: 'recognition',   // hanzi+pinyin shown → recall meaning
  reading: 'reading',       // hanzi only → produce pinyin + meaning
  listening: 'listening',   // audio only → recall meaning
  pronunciation: 'pronounce', // word shown → record, tone-focused check
  spoken: 'production',     // meaning/context prompt → say the word/phrase
  sentence: 'cloze',        // sentence with the word blanked → supply it
};

// Turn a messy CC-CEDICT dump into a concise gloss.
export function cleanGloss(word) {
  if (word.gloss) return word.gloss;
  const raw = word.english || '';
  const senses = raw.split(/;|\/|，|、/).map(s => s.trim())
    .filter(s => s && !/^CL:|^surname\b|measure word|classifier|variant of|old variant|see also/i.test(s));
  const pick = (senses.length ? senses : raw.split(/;|\//)).slice(0, 2)
    .map(s => s.replace(/\([^)]*\)/g, '').trim()).filter(Boolean);
  return pick.join('; ') || raw;
}

// Characters that only occur in CC-CEDICT's traditional column (never as a
// simplified form) — used to keep example sentences simplified-only.
let _tradSet = null;
function traditionalChars() {
  if (_tradSet) return _tradSet;
  const simp = new Set(), trad = new Set();
  for (const r of db().prepare('SELECT traditional, simplified FROM dictionary').all()) {
    for (const c of r.simplified || '') simp.add(c);
    if (r.traditional && r.traditional !== r.simplified) for (const c of r.traditional) trad.add(c);
  }
  _tradSet = new Set([...trad].filter(c => !simp.has(c)));
  return _tradSet;
}
function isTraditional(hanzi) {
  const t = traditionalChars();
  for (const c of hanzi || '') if (t.has(c)) return true;
  return false;
}

export function hydrateWord(id) {
  const w = db().prepare('SELECT * FROM words WHERE id=?').get(id);
  if (!w) return null;
  return { ...w, gloss: cleanGloss(w) };
}

// Pick the most comprehensible example sentence for a word: contains the word,
// shortest, and built mostly from already-introduced vocabulary.
export function pickExample(wordId, knownWordIds) {
  const rows = db().prepare(
    `SELECT * FROM sentences WHERE word_ids LIKE ? ORDER BY length(hanzi) ASC LIMIT 40`
  ).all(`%${wordId}%`);
  let best = null, bestScore = -1;
  for (const s of rows) {
    let ids = []; try { ids = JSON.parse(s.word_ids || '[]'); } catch {}
    if (!ids.includes(wordId)) continue;                     // LIKE can false-match substrings
    if (isTraditional(s.hanzi)) continue;                    // simplified-only learner
    const known = ids.filter(id => id === wordId || knownWordIds.has(id)).length;
    const frac = ids.length ? known / ids.length : 0;
    const lenPenalty = Math.min(1, 8 / Math.max(chars(s.hanzi).length, 1));
    const score = frac + 0.3 * lenPenalty;                   // comprehensible + short
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best ? { ...best, comprehensibility: bestScore } : null;
}

// Character-family teaching context for a (usually new) word: how its characters
// decompose and which learned/soon characters share meaning (radical) or sound
// (phonetic). Teaches transferable patterns instead of isolated facts.
export function charFamilies(hanzi) {
  const out = [];
  for (const c of new Set(chars(hanzi))) {
    const m = db().prepare('SELECT * FROM char_meta WHERE hanzi=?').get(c);
    if (!m) { out.push({ char: c }); continue; }
    const peers = (rel, dst) => db().prepare(
      `SELECT DISTINCT src FROM graph_edges WHERE rel=? AND dst=? AND src!=? LIMIT 6`
    ).all(rel, dst, c).map(r => r.src);
    let comps = []; try { comps = JSON.parse(m.components || '[]'); } catch {}
    out.push({
      char: c,
      definition: m.definition,
      radical: m.radical,
      components: comps,
      radicalPeers: m.radical ? peers('radical_family', m.radical) : [],
      phoneticPeers: m.phonetic ? peers('phonetic_series', m.phonetic) : [],
      phonetic: m.phonetic,
    });
  }
  return out;
}

// Build the payload for one exercise: (card, item, dimension) → renderable card.
export function buildExercise({ card, dimension, knownWordIds, isNew = false }) {
  if (card.item_type === 'sentence') return buildSentenceExercise(card, dimension, knownWordIds);
  const w = hydrateWord(card.item_id);
  if (!w) return null;
  const example = pickExample(w.id, knownWordIds);
  // Bare particles are always taught/tested inside a sentence, never in isolation.
  const isParticle = !!w.particle;
  if (isParticle && example) dimension = 'sentence';
  const base = {
    cardId: card.id, itemType: 'word', itemId: w.id, particle: isParticle,
    dimension, exercise: DIM_EXERCISE[dimension] || 'recognition',
    hanzi: w.hanzi, pinyin: w.pinyin, gloss: w.gloss, tone_pattern: w.tone_pattern,
    audio: w.audio_path || null,
    example: example && { hanzi: example.hanzi, pinyin: example.pinyin, english: example.english,
                          audio: example.audio_path || null },
    isNew,
  };
  // Teach-then-test: a brand-new word leads with its character family + example.
  // Particles get a grammar-function note instead of character decomposition.
  if (isNew) base.teach = {
    families: charFamilies(w.hanzi), gloss: w.gloss,
    grammar: isParticle ? `${w.hanzi} is a grammar particle — learn it by how it works in a sentence, not on its own.` : null,
  };

  if (dimension === 'sentence' && example) {
    return { ...base, exercise: 'cloze', cloze: makeCloze(example, w.hanzi) };
  }
  return base;
}

function buildSentenceExercise(card, dimension, knownWordIds) {
  const s = db().prepare('SELECT * FROM sentences WHERE id=?').get(card.item_id);
  if (!s) return null;
  const exercise = dimension === 'listening' ? 'listening'
    : dimension === 'spoken' || dimension === 'pronunciation' ? 'production' : 'reading';
  return {
    cardId: card.id, itemType: 'sentence', itemId: s.id, dimension, exercise,
    hanzi: s.hanzi, pinyin: s.pinyin, gloss: s.english, english: s.english,
    audio: s.audio_path || null, pattern: s.pattern_tag,
  };
}

// Blank out the target word inside a sentence for a cloze exercise.
function makeCloze(sentence, targetHanzi) {
  const idx = sentence.hanzi.indexOf(targetHanzi);
  return {
    hanzi: sentence.hanzi, pinyin: sentence.pinyin, english: sentence.english,
    audio: sentence.audio_path || null,
    answer: targetHanzi,
    blanked: idx >= 0
      ? sentence.hanzi.slice(0, idx) + '＿'.repeat([...targetHanzi].length) + sentence.hanzi.slice(idx + targetHanzi.length)
      : sentence.hanzi,
  };
}
