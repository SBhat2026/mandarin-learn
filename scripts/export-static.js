// Export a read-only JSON snapshot for the GitHub Pages demo build.
// The demo has no backend: the frontend reads these files and treats reviews as
// local no-ops. Full functionality still requires the Express/SQLite server.
//   node scripts/export-static.js [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, initSchema, ROOT } from '../server/db.js';
import { hydrate } from '../server/cards.js';
import { lookup } from '../server/dictionary.js';
import { TOPICS } from '../server/taxonomy.js';

initSchema();
const outDir = process.argv[2] || join(ROOT, 'public', 'demo');
mkdirSync(outDir, { recursive: true });
const write = (name, obj) => { writeFileSync(join(outDir, name), JSON.stringify(obj)); console.log('  ', name, JSON.stringify(obj).length, 'bytes'); };

const DEMO_UNITS = 3;         // words drawn from the first N units
const DEMO_SENTENCES = 24;

const units = db().prepare('SELECT * FROM units ORDER BY position').all();
const wordRow = db().prepare('SELECT * FROM words WHERE id=?');
const demoWordIds = [];
for (const u of units.slice(0, DEMO_UNITS)) {
  try { demoWordIds.push(...JSON.parse(u.word_ids || '[]')); } catch {}
}

// Synthetic cards (all New) for the demo practice queue.
function demoCard(item_type, item_id, card_type, i) {
  return hydrate({ id: 100000 + i, item_type, item_id, card_type, state: 0, reps: 0, lapses: 0,
    stability: null, difficulty: null, due: null, suspended: 0 });
}
const sessionCards = [];
demoWordIds.slice(0, 8).forEach((id, i) => {
  sessionCards.push(demoCard('word', id, 'listening', i * 3));
  sessionCards.push(demoCard('word', id, 'reading', i * 3 + 1));
  if (i % 2 === 0) sessionCards.push(demoCard('word', id, 'speaking', i * 3 + 2));
});

// Demo reading passages: first sentences regardless of learned-state gate.
const sentences = db().prepare(
  `SELECT id, hanzi, pinyin, english, audio_path, pattern_tag, source FROM sentences
   WHERE length(hanzi) BETWEEN 4 AND 22 ORDER BY id LIMIT ?`).all(DEMO_SENTENCES);
const passages = [];
for (let i = 0; i < sentences.length; i += 4) passages.push({ index: passages.length + 1, sentences: sentences.slice(i, i + 4) });

// Dictionary map for every hanzi char appearing in demo content (+ whole words).
const dict = {};
const addTerm = (t) => { if (t && !(t in dict)) dict[t] = lookup(t); };
for (const id of demoWordIds.slice(0, 24)) { const w = wordRow.get(id); if (w) addTerm(w.hanzi); }
for (const s of sentences) for (const ch of s.hanzi) if (/[一-鿿]/.test(ch)) addTerm(ch);

const counts = {
  words: db().prepare('SELECT COUNT(*) c FROM words').get().c,
  sentences: db().prepare('SELECT COUNT(*) c FROM sentences').get().c,
  units: units.length,
  dictionary: db().prepare('SELECT COUNT(*) c FROM dictionary').get().c,
};

console.log('Writing demo snapshot to', outDir);
write('meta.json', { topics: TOPICS, counts, onboarding: { onboarded: true, interestTopics: [], micWorks: null, unitCount: units.length }, demo: true });
write('home.json', {
  units: units.map(u => {
    const ids = JSON.parse(u.word_ids || '[]');
    const review = u.position === 1 ? Math.round(ids.length * 0.35) : 0; // show a little progress
    return { id: u.id, position: u.position, name: u.name, topic: u.topic, wordCount: ids.length,
      progress: { total: ids.length, review, ratio: review / (ids.length || 1) }, completed: false };
  }),
  currentUnitId: units[0]?.id ?? null, dueNow: sessionCards.length, streak: 3,
  onboarding: { onboarded: true },
});
write('session.json', {
  unit: units[0] ? { ...units[0], progress: { total: JSON.parse(units[0].word_ids || '[]').length, review: 0, ratio: 0 } } : null,
  counts: { due: 0, new: sessionCards.length, dailyNew: 10, newDoneToday: 0 },
  toneDrill: null, due: [], new: sessionCards,
});
write('reading.json', { passages });
write('tone.json', { stats: { perTone: {}, weakest: null, weakPair: null }, weak: null, drill: [] });
write('stats.json', {
  wordsByState: { unseen: counts.words - 60, new: 36, learning: 12, review: 12, relearning: 0 },
  retentionCurve: [], reviewsPerDay: [], weakestWords: [],
  tones: { perTone: {}, weakest: null, weakPair: null },
  today: { count: 0, minutes: 0 }, retention14d: null,
  throttle: { decision: 'hold', reason: 'Demo preview — start reviewing locally to see your adaptive rate evolve.', previous: 10, current: 10, metrics: { retention: null, avgDailyMinutes: 0, backlogRatio: 0 }, appliedNow: false, nextEvalDue: null },
});
write('dict.json', dict);
console.log('Done.');
