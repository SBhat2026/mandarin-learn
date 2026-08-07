// Interests, inferred from behavior — never from a questionnaire. Onboarding
// topic picks act as a weak prior; the real signal is which topics' words the
// learner actually engages with and produces in conversation. The weights decay
// slightly on each update so interests drift with the learner instead of
// ossifying. Hidden: used to steer new-word selection and Laoshi's scenes.
import { db, getModel, setModel, getSetting } from './db.js';

const DECAY = 0.98;

function topicsForWords(wordIds = []) {
  if (!wordIds.length) return [];
  const ph = wordIds.map(() => '?').join(',');
  const rows = db().prepare(`SELECT topics FROM words WHERE id IN (${ph})`).all(...wordIds);
  const out = [];
  for (const r of rows) { try { out.push(...JSON.parse(r.topics || '[]')); } catch {} }
  return out;
}

// Reinforce interest in the topics of words the learner engaged with. `weight`
// lets a produced word count more than a merely-seen one.
export function bumpInterests(wordIds = [], weight = 1) {
  const topics = topicsForWords(wordIds);
  if (!topics.length) return;
  const cur = getModel('interests', {}) || {};
  for (const k of Object.keys(cur)) cur[k] *= DECAY;    // gentle forgetting
  for (const t of topics) cur[t] = (cur[t] || 0) + weight;
  setModel('interests', cur);
}

// Sorted interest weights, with onboarding picks folded in as a prior so early
// lessons already lean toward stated interests before behavior accumulates.
// An explicit "today I want to talk about X" pick (prefs) outweighs everything.
export function getInterests() {
  const model = getModel('interests', {}) || {};
  const merged = { ...model };
  for (const t of getSetting('interest_topics', []) || []) merged[t] = (merged[t] || 0) + 1.5;
  for (const t of getSetting('chat_topics', []) || []) merged[t] = (merged[t] || 0) + 3;
  return Object.entries(merged)
    .map(([topic, weight]) => ({ topic, weight }))
    .sort((a, b) => b.weight - a.weight);
}

// Fast lookup: topic → normalized interest weight in [0,1].
export function interestWeights() {
  const list = getInterests();
  const max = list[0]?.weight || 1;
  const map = new Map();
  for (const { topic, weight } of list) map.set(topic, weight / max);
  return map;
}
