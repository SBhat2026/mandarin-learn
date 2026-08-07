import { db } from './db.js';
import { TOPIC_SET } from './taxonomy.js';

const CJK = /[一-鿿]/;
const chars = (s) => [...(s || '')].filter(ch => CJK.test(ch));

// Rebuild the unit path. Ordering is frequency-first, then shaped by:
//   • interest boost (clean re-enriched tags — function words carry none)
//   • register: literary/written-only words wait (speaking-first app)
//   • capability alignment: the early curriculum's capabilities pull their best
//     serving words forward, so early units teach what early conversations need
//   • confusable separation: visually-confusable characters never land in the
//     same unit (他/她/它 style pairs get ≥1 unit of spacing)
// ~size words per unit; each named after its dominant topic; sentences attached.
// Shared by the CLI (ingest/build-units.js) and the onboarding endpoint.
export function rebuildUnits(interestTopics = [], { size = 20, boost = 0.5 } = {}) {
  const sentinel = backfillFreq();
  const interest = new Set((interestTopics || []).filter(t => TOPIC_SET.has(t)));
  const words = db().prepare('SELECT id, hanzi, topics, freq_rank, register, particle FROM words').all();
  const capPull = capabilityPull();
  for (const w of words) {
    let topics = [];
    try { topics = JSON.parse(w.topics || '[]'); } catch {}
    w._topics = topics;
    const boosted = topics.some(t => interest.has(t));
    let eff = (w.freq_rank ?? sentinel) * (boosted ? boost : 1);
    if (w.register === 'written') eff *= 1.6;                 // literary words wait
    const pull = capPull.get(w.id);
    if (pull != null) eff = Math.min(eff, pull);              // capability curriculum pull
    w._eff = eff;
  }
  words.sort((a, b) => a._eff - b._eff || (a.freq_rank ?? sentinel) - (b.freq_rank ?? sentinel));

  const ordered = separateConfusables(words, size);
  const { units, wordUnit } = writeUnits(ordered, size);
  const cover = attachSentences(wordUnit);
  return { units: units.length, words: words.length, ...cover };
}

// Early capabilities (curriculum order) pull their best-serving words forward: the
// k-th capability's top words get an effective rank around k*size*0.8, clustering
// early units around what early conversations actually need.
function capabilityPull(capCount = 14, perCap = 6) {
  const pull = new Map();
  let caps = [];
  try {
    caps = db().prepare(`SELECT c.id, c.ordering FROM capabilities c ORDER BY c.ordering ASC LIMIT ?`).all(capCount);
  } catch { return pull; }
  for (let k = 0; k < caps.length; k++) {
    const refs = db().prepare(`SELECT ref, weight FROM capability_requirements WHERE capability_id=? AND kind='vocab'`).all(caps[k].id);
    for (const r of refs) {
      const [kind, ...rest] = r.ref.split(':');
      const val = rest.join(':');
      let rows = [];
      if (kind === 'word') rows = db().prepare('SELECT id FROM words WHERE hanzi=?').all(val);
      else if (kind === 'topic') rows = db().prepare(`SELECT id FROM words WHERE topics LIKE ? AND particle=0
        ORDER BY COALESCE(freq_rank,999999) ASC LIMIT ?`).all(`%"${val}"%`, perCap);
      else if (kind === 'pos') rows = db().prepare(`SELECT id FROM words WHERE pos LIKE ? AND particle=0
        ORDER BY COALESCE(freq_rank,999999) ASC LIMIT ?`).all(`%"${val}"%`, Math.min(perCap, 4));
      const target = (k + 1) * 16;
      for (const row of rows) if (!pull.has(row.id) || pull.get(row.id) > target) pull.set(row.id, target);
    }
  }
  return pull;
}

// Greedy re-packing: a word whose character is a visual-confusion peer of a
// character already in the CURRENT unit is deferred to a later unit, so
// look-alikes are never met together (they're contrasted later, via families).
function separateConfusables(sorted, size) {
  const confus = new Map();   // char → Set(peer chars)
  for (const e of db().prepare(`SELECT src, dst FROM graph_edges WHERE rel='visual_confusion'`).all()) {
    if (!confus.has(e.src)) confus.set(e.src, new Set());
    confus.get(e.src).add(e.dst);
  }
  const out = [];
  let deferred = [];
  let unitChars = new Set();
  const conflicts = (w) => chars(w.hanzi).some(c =>
    [...(confus.get(c) || [])].some(peer => unitChars.has(peer)));
  let queue = [...sorted];
  while (queue.length || deferred.length) {
    if (!queue.length) { queue = deferred; deferred = []; }
    const w = queue.shift();
    if (conflicts(w)) { deferred.push(w); continue; }
    out.push(w);
    for (const c of chars(w.hanzi)) unitChars.add(c);
    if (out.length % size === 0) {           // unit boundary → reset, deferred re-enter
      unitChars = new Set();
      if (deferred.length) { queue = [...deferred, ...queue]; deferred = []; }
    }
  }
  return out;
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
  const threshold = Math.max(4, Math.round(size * 0.25)); // topic must cover ≥25% (or 4)
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
