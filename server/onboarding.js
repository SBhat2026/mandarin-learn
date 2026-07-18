import { db, getSetting, setSetting } from './db.js';
import { State } from './fsrs.js';
import { WORD_CARD_TYPES } from './cards.js';
import { rebuildUnits } from './units.js';

// Mark all words in the first N units as already known: create their cards in
// review state so they're skipped as new and count toward unit completion.
export function markFirstUnitsKnown(n) {
  if (!n || n <= 0) return 0;
  const units = db().prepare('SELECT word_ids FROM units ORDER BY position LIMIT ?').all(n);
  const ids = [];
  for (const u of units) { try { ids.push(...JSON.parse(u.word_ids || '[]')); } catch {} }

  const now = new Date();
  const due = new Date(now.getTime() + 4 * 24 * 3600 * 1000).toISOString();
  const insert = db().prepare(`
    INSERT INTO cards(item_type, item_id, card_type, due, stability, difficulty, reps, lapses, state, last_review)
    VALUES('word', ?, ?, ?, 8, 5, 1, 0, ${State.Review}, ?)
    ON CONFLICT(item_type, item_id, card_type) DO UPDATE SET
      state=${State.Review}, stability=MAX(cards.stability,8), due=excluded.due, reps=MAX(cards.reps,1), last_review=excluded.last_review`);
  const tx = db().transaction(() => {
    for (const id of ids) for (const t of WORD_CARD_TYPES) insert.run(id, t, due, now.toISOString());
  });
  tx();
  return ids.length;
}

export function saveOnboarding({ interestTopics, knownUnits, micWorks }) {
  const topics = (interestTopics || []).slice(0, 3);
  setSetting('interest_topics', topics);
  if (typeof micWorks === 'boolean') setSetting('mic_works', micWorks);

  // Rebuild the path so interest topics actually reshape unit ordering, THEN mark
  // known units (which depend on the new ordering).
  let rebuilt = null;
  if (db().prepare('SELECT COUNT(*) c FROM words').get().c > 0) {
    rebuilt = rebuildUnits(topics);
  }
  let marked = 0;
  if (knownUnits && knownUnits > 0) marked = markFirstUnitsKnown(knownUnits);
  setSetting('onboarded', true);
  return { interestTopics: topics, knownWordsMarked: marked, units: rebuilt?.units ?? null };
}

export function onboardingState() {
  return {
    onboarded: getSetting('onboarded', false),
    interestTopics: getSetting('interest_topics', []),
    micWorks: getSetting('mic_works', null),
    unitCount: db().prepare('SELECT COUNT(*) c FROM units').get().c,
  };
}
