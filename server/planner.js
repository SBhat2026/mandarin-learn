// The adaptive lesson planner. At any moment it decides the highest-value
// session: which items to review (weakest dimension each), which new words to
// introduce (concrete-first, comprehensible, well-connected in the graph), and
// how to interleave them. Replaces static unit-by-unit progression.
import { db } from './db.js';
import { State } from './fsrs.js';
import { createCardsForWord, unlockSentences } from './cards.js';
import { dailyNew, newWordsStartedToday } from './scheduler.js';
import { weakestDimension, getStage, computeStage, setStage, modalityBias, unlockedDimensions } from './learner.js';
import { buildExercise } from './exercises.js';
import { weakTone } from './tone.js';
import { interestWeights } from './interests.js';

const CJK = /[一-鿿]/;
const chars = (s) => [...(s || '')].filter(ch => CJK.test(ch));

export function introducedWordIds() {
  return new Set(db().prepare(
    `SELECT DISTINCT item_id FROM cards WHERE item_type='word'`).all().map(r => r.item_id));
}

// Words solid enough to count as "known" for comprehensible-input purposes.
export function knownWordIds() {
  const rows = db().prepare(`SELECT c.item_id, c.stability, c.state, a.stage
    FROM cards c LEFT JOIN acquisition a ON a.item_type='word' AND a.item_id=c.item_id
    WHERE c.item_type='word'`).all();
  const s = new Set();
  for (const r of rows) if ((r.stage ?? 0) >= 2 || r.state >= State.Review) s.add(r.item_id);
  return s;
}

function hasSentence(wordId) {
  return !!db().prepare('SELECT 1 FROM sentences WHERE word_ids LIKE ? LIMIT 1').get(`%${wordId}%`);
}

function unlockedForPronunciation(wordId) {
  return unlockedDimensions(wordId, false).includes('pronunciation');
}

function dueMemoryCards(now) {
  const rows = db().prepare(`SELECT * FROM cards
    WHERE card_type='memory' AND state>0 AND suspended=0 AND due<=? ORDER BY due ASC`)
    .all(now.toISOString());
  return rows.filter(c => c.item_type !== 'sentence' || sentenceUnlocked(c.item_id));
}

function sentenceUnlocked(sentenceId) {
  const s = db().prepare('SELECT word_ids FROM sentences WHERE id=?').get(sentenceId);
  let ids = []; try { ids = JSON.parse(s?.word_ids || '[]'); } catch {}
  if (!ids.length) return false;
  const ph = ids.map(() => '?').join(',');
  const r = db().prepare(`SELECT COUNT(DISTINCT item_id) c FROM cards
    WHERE item_type='word' AND item_id IN (${ph}) AND card_type='memory' AND state>=${State.Review}`).get(...ids);
  return r.c === ids.length;
}

// Concrete-first, comprehensible, graph-connected new-word ranking.
export function newCandidates(limit, introduced) {
  const known = introduced || introducedWordIds();
  // Characters already in play — new words sharing them are easier + transferable.
  const knownChars = new Set();
  if (known.size) {
    const ph = [...known].map(() => '?').join(',');
    for (const w of db().prepare(`SELECT hanzi FROM words WHERE id IN (${ph})`).all(...known))
      for (const c of chars(w.hanzi)) knownChars.add(c);
  }
  // Radicals/phonetics already encountered → family transfer bonus.
  const knownFamilies = new Set();
  for (const c of knownChars) {
    const m = db().prepare('SELECT radical, phonetic FROM char_meta WHERE hanzi=?').get(c);
    if (m?.radical) knownFamilies.add('r:' + m.radical);
    if (m?.phonetic) knownFamilies.add('p:' + m.phonetic);
  }

  const pool = db().prepare(`SELECT w.id, w.hanzi, w.freq_rank, w.hsk_level, w.concrete, w.particle, w.topics
    FROM words w
    WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_type='word' AND c.item_id=w.id)
    ORDER BY COALESCE(w.freq_rank, 999999) ASC LIMIT 4000`).all();

  // Inferred interests gently pull relevant vocabulary forward — never so hard
  // that it overrides comprehensibility/frequency, just enough that lessons feel
  // personally relevant. Invisible to the learner.
  const interests = interestWeights();
  const interestBoost = (topicsJson) => {
    if (!interests.size) return 0;
    let t = []; try { t = JSON.parse(topicsJson || '[]'); } catch {}
    let best = 0; for (const topic of t) best = Math.max(best, interests.get(topic) || 0);
    return best * 1.4;
  };

  const scored = pool.map(w => {
    const cs = chars(w.hanzi);
    const fracKnown = cs.length ? cs.filter(c => knownChars.has(c)).length / cs.length : 0;
    let familyBonus = 0;
    for (const c of cs) {
      const m = db().prepare('SELECT radical, phonetic FROM char_meta WHERE hanzi=?').get(c);
      if (m?.radical && knownFamilies.has('r:' + m.radical)) familyBonus += 0.4;
      if (m?.phonetic && knownFamilies.has('p:' + m.phonetic)) familyBonus += 0.6;
    }
    const rank = w.freq_rank || 999999;
    const freqBoost = 2 / Math.log10(rank + 10);
    const levelPenalty = (w.hsk_level == null || w.hsk_level > 6) ? 2 : 0;
    // One-or-two-new-characters rule keeps input comprehensible.
    const loadPenalty = cs.filter(c => !knownChars.has(c)).length > 2 ? 1.2 : 0;
    // Bare particles are acquired in context (sentences/cloze), not as isolated
    // cards — push them well below concrete vocabulary so they surface only once
    // the learner has words to embed them in.
    const particlePenalty = w.particle ? 6 : 0;
    const score = 3 * (w.concrete ?? 1) + freqBoost + 1.5 * fracKnown
      + Math.min(2, familyBonus) + interestBoost(w.topics) - levelPenalty - loadPenalty - particlePenalty;
    return { id: w.id, hanzi: w.hanzi, score };
  }).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

// Introduce new words up to the remaining daily budget, creating their cards.
function introduceNew(budgetOverride) {
  const budget = budgetOverride ?? Math.max(0, dailyNew() - newWordsStartedToday());
  // Words already introduced but never reviewed still count against the budget.
  const pendingNew = db().prepare(
    `SELECT c.item_id FROM cards c WHERE c.item_type='word' AND c.state=0`).all().map(r => r.item_id);
  const remaining = budget - pendingNew.length;
  const fresh = [];
  if (remaining > 0) {
    const introduced = introducedWordIds();
    const cands = newCandidates(remaining, introduced);
    const tx = db().transaction(() => { for (const c of cands) { createCardsForWord(c.id); fresh.push(c.id); } });
    tx();
  }
  return [...new Set([...pendingNew, ...fresh])].slice(0, Math.max(budget, 0));
}

function interleave(reviews, news) {
  // Front-load one review to warm up, then weave new words through reviews.
  if (!news.length) return reviews;
  if (!reviews.length) return news;
  const out = [];
  const gap = Math.max(2, Math.ceil(reviews.length / news.length));
  let ri = 0, ni = 0;
  if (reviews.length) out.push(reviews[ri++]);
  while (ri < reviews.length || ni < news.length) {
    for (let g = 0; g < gap && ri < reviews.length; g++) out.push(reviews[ri++]);
    if (ni < news.length) out.push(news[ni++]);
  }
  return out;
}

// The core entry point: assemble the next best lesson.
export function buildLesson({ now = new Date(), size = 16 } = {}) {
  unlockSentences();
  const known = knownWordIds();

  const due = dueMemoryCards(now);
  const newIds = introduceNew();
  const newCards = newIds
    .map(id => db().prepare(`SELECT * FROM cards WHERE item_type='word' AND item_id=? AND card_type='memory'`).get(id))
    .filter(Boolean);

  // Bias the whole session toward the learner's weakest modality; separately, if
  // a tone is shaky, steer words that contain it toward a pronunciation rep so the
  // weakness gets addressed in context rather than in an isolated drill.
  const bias = modalityBias();
  const weak = weakTone();

  // Build review exercises (weakest unlocked dimension per item).
  const reviewItems = due.slice(0, size).map(card => {
    let dim = 'listening';
    if (card.item_type === 'word') {
      const w = db().prepare('SELECT particle, tone_pattern FROM words WHERE id=?').get(card.item_id);
      if (w?.particle) dim = 'sentence';
      else {
        dim = weakestDimension(card.item_id, { hasSentence: hasSentence(card.item_id), bias });
        const hasWeakTone = weak && w?.tone_pattern && String(w.tone_pattern).split('-').includes(String(weak.tone));
        if (hasWeakTone && unlockedForPronunciation(card.item_id)) dim = 'pronunciation';
      }
    }
    return buildExercise({ card, dimension: dim, knownWordIds: known, isNew: false });
  }).filter(Boolean);

  // New words: teach-then-test, always starting from meaning recognition.
  const newItems = newCards.map(card =>
    buildExercise({ card, dimension: 'meaning', knownWordIds: known, isNew: true })
  ).filter(Boolean);

  const items = interleave(reviewItems, newItems).slice(0, size);

  return {
    items,
    counts: {
      due: due.length, new: newItems.length,
      dailyNew: dailyNew(), newDoneToday: newWordsStartedToday(),
    },
  };
}

// Recompute + persist acquisition stage after a review (called by session).
export function refreshStage(itemType, itemId) {
  const card = db().prepare(
    `SELECT * FROM cards WHERE item_type=? AND item_id=? AND card_type='memory'`).get(itemType, itemId);
  const stage = itemType === 'word' ? computeStage(itemId, card) : (card?.state >= State.Review ? 3 : 1);
  setStage(itemType, itemId, stage);
  return stage;
}
