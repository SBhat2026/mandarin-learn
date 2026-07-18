import { db } from './db.js';
import { TOPIC_SET } from './taxonomy.js';

// Rebuild the unit path. Frequency-first, boosted for interest topics; ~size words
// per unit; each named after its dominant topic; sentences segmented + attached.
// Shared by the CLI (ingest/build-units.js) and the onboarding endpoint.
export function rebuildUnits(interestTopics = [], { size = 20, boost = 0.5 } = {}) {
  const sentinel = backfillFreq();
  const interest = new Set((interestTopics || []).filter(t => TOPIC_SET.has(t)));
  const words = db().prepare('SELECT id, hanzi, topics, freq_rank FROM words').all();
  for (const w of words) {
    let topics = [];
    try { topics = JSON.parse(w.topics || '[]'); } catch {}
    w._topics = topics;
    const boosted = topics.some(t => interest.has(t));
    w._eff = (w.freq_rank ?? sentinel) * (boosted ? boost : 1);
  }
  words.sort((a, b) => a._eff - b._eff || (a.freq_rank ?? sentinel) - (b.freq_rank ?? sentinel));

  const { units, wordUnit } = writeUnits(words, size);
  const cover = attachSentences(wordUnit);
  return { units: units.length, words: words.length, ...cover };
}

function backfillFreq() {
  const maxRank = db().prepare('SELECT COALESCE(MAX(rank),0) r FROM frequency').get().r || 0;
  const sentinel = maxRank + 1_000_000;
  db().prepare(`UPDATE words SET freq_rank = COALESCE(
    (SELECT rank FROM frequency WHERE frequency.word = words.hanzi), ?)`).run(sentinel);
  return sentinel;
}

// Dominant topic + how many words carry it. Offline keyword tags are noisy, so a
// topic only "wins" a unit if it covers a meaningful share of the words.
function dominantTopic(chunk) {
  const counts = new Map();
  for (const w of chunk) for (const t of w._topics) counts.set(t, (counts.get(t) || 0) + 1);
  let topic = null, count = 0;
  for (const [t, n] of counts) if (n > count) { topic = t; count = n; }
  return { topic, count };
}
const titleCase = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

function writeUnits(ordered, size) {
  db().exec('DELETE FROM units');
  const insert = db().prepare('INSERT INTO units(position, name, topic, word_ids) VALUES(?,?,?,?)');
  const wordUnit = new Map();
  const units = [];
  const usedNames = new Map();
  const threshold = Math.max(4, Math.round(size * 0.3)); // topic must cover ≥30% (or 4)
  let coreN = 0;
  const tx = db().transaction(() => {
    for (let i = 0, pos = 0; i < ordered.length; i += size, pos++) {
      const chunk = ordered.slice(i, i + size);
      const { topic, count } = dominantTopic(chunk);
      let baseTopic, name;
      if (topic && count >= threshold) {
        baseTopic = topic;
        name = titleCase(topic);
        const seen = (usedNames.get(topic) || 0) + 1;
        usedNames.set(topic, seen);
        if (seen > 1) name = `${name} ${seen}`;
      } else {
        // No clear theme (typical for high-frequency function words) → honest label.
        baseTopic = 'core';
        coreN++;
        name = coreN === 1 ? 'Essentials' : `Core ${coreN}`;
      }
      insert.run(pos + 1, name, baseTopic, JSON.stringify(chunk.map(w => w.id)));
      chunk.forEach(w => wordUnit.set(w.id, pos));
      units.push({ position: pos });
    }
  });
  tx();
  return { units, wordUnit };
}

function segmenter() {
  const rows = db().prepare('SELECT id, hanzi FROM words').all();
  const byHanzi = new Map(rows.map(r => [r.hanzi, r.id]));
  const maxLen = rows.reduce((m, r) => Math.max(m, r.hanzi.length), 1);
  return (text) => {
    const chars = [...String(text).replace(/[^一-鿿]/g, '')];
    const ids = new Set();
    for (let i = 0; i < chars.length;) {
      let matched = false;
      for (let L = Math.min(maxLen, chars.length - i); L >= 1; L--) {
        const sub = chars.slice(i, i + L).join('');
        if (byHanzi.has(sub)) { ids.add(byHanzi.get(sub)); i += L; matched = true; break; }
      }
      if (!matched) i++;
    }
    return [...ids];
  };
}

function attachSentences(wordUnit) {
  const segment = segmenter();
  const sentences = db().prepare('SELECT id, hanzi FROM sentences').all();
  const setWords = db().prepare('UPDATE sentences SET word_ids=? WHERE id=?');
  let covered = 0, partial = 0;
  const tx = db().transaction(() => {
    for (const s of sentences) {
      const ids = segment(s.hanzi);
      setWords.run(JSON.stringify(ids), s.id);
      if (ids.length && ids.every(id => wordUnit.has(id))) covered++; else partial++;
    }
  });
  tx();
  return { covered, partial };
}
