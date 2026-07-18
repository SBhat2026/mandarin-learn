// Enrichment pass. Assigns 1-2 topic tags per word from the fixed taxonomy and
// flags Spoonfed sentences with a grammar pattern. Batched, resumable, cached.
//   node ingest/enrich.js [--limit N] [--batch N] [--sentences]
// Falls back to a keyword-based tagger when no ANTHROPIC_API_KEY is set, so the
// pipeline still produces sensible units offline.
import { db, initSchema } from '../server/db.js';
import { TOPICS, TOPIC_SET } from '../server/taxonomy.js';
import { hasApiKey, completeJson, complete } from '../server/anthropic.js';

const BATCH = num('--batch', 40);
const LIMIT = num('--limit', Infinity);
const DO_SENTENCES = process.argv.includes('--sentences');

function num(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

// --- Offline keyword fallback (rough, but keeps units usable without the API) ---
const KEYWORDS = {
  greetings: ['hello', 'hi', 'goodbye', 'thank', 'please', 'sorry', 'welcome'],
  numbers: ['one', 'two', 'three', 'number', 'hundred', 'thousand', 'zero', 'count'],
  time: ['time', 'day', 'week', 'month', 'year', 'hour', 'minute', 'today', 'tomorrow', 'yesterday', 'morning', 'night', 'clock'],
  family: ['mother', 'father', 'family', 'brother', 'sister', 'son', 'daughter', 'wife', 'husband', 'parent', 'child', 'grandma', 'grandpa'],
  food: ['eat', 'food', 'rice', 'meat', 'vegetable', 'noodle', 'bread', 'egg', 'fruit', 'meal', 'dish'],
  drink: ['drink', 'water', 'tea', 'coffee', 'wine', 'beer', 'juice', 'milk'],
  travel: ['travel', 'trip', 'hotel', 'passport', 'ticket', 'visa', 'tour', 'abroad'],
  transport: ['car', 'bus', 'train', 'plane', 'bike', 'taxi', 'subway', 'drive', 'road', 'airport', 'station'],
  shopping: ['buy', 'shop', 'store', 'market', 'sell', 'price', 'sale', 'mall'],
  money: ['money', 'yuan', 'dollar', 'pay', 'cost', 'bank', 'cash', 'cheap', 'expensive'],
  home: ['home', 'house', 'room', 'door', 'window', 'table', 'chair', 'bed', 'kitchen', 'floor'],
  work: ['work', 'job', 'office', 'boss', 'company', 'meeting', 'business', 'colleague'],
  school: ['school', 'student', 'teacher', 'study', 'learn', 'book', 'class', 'exam', 'university', 'homework'],
  body: ['head', 'hand', 'foot', 'eye', 'ear', 'mouth', 'body', 'hair', 'arm', 'leg', 'face'],
  health: ['sick', 'doctor', 'hospital', 'medicine', 'pain', 'health', 'ill', 'fever', 'tired'],
  weather: ['weather', 'rain', 'snow', 'wind', 'sun', 'cloud', 'hot', 'cold', 'warm'],
  nature: ['tree', 'flower', 'mountain', 'river', 'sea', 'sky', 'grass', 'stone', 'earth', 'nature'],
  animals: ['dog', 'cat', 'bird', 'fish', 'horse', 'animal', 'pig', 'cow', 'chicken', 'tiger'],
  colors: ['red', 'blue', 'green', 'yellow', 'black', 'white', 'color', 'purple', 'orange', 'pink'],
  clothing: ['clothes', 'shirt', 'shoe', 'hat', 'dress', 'wear', 'pants', 'coat', 'jacket'],
  hobbies: ['music', 'read', 'game', 'sing', 'dance', 'paint', 'hobby', 'movie', 'photo'],
  sports: ['sport', 'ball', 'run', 'swim', 'play', 'football', 'basketball', 'exercise', 'jump', 'team'],
  technology: ['computer', 'phone', 'internet', 'email', 'app', 'software', 'network', 'digital', 'online'],
  feelings: ['happy', 'sad', 'angry', 'love', 'afraid', 'like', 'feel', 'worry', 'glad', 'hope'],
  places: ['place', 'city', 'country', 'street', 'park', 'restaurant', 'library', 'here', 'there', 'where'],
};

function keywordTags(english = '') {
  const t = english.toLowerCase();
  const hits = [];
  for (const [topic, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => t.includes(w))) hits.push(topic);
    if (hits.length >= 2) break;
  }
  return hits;
}

async function llmBatchTags(items) {
  const list = items.map((w, i) => `${i}. ${w.hanzi} (${w.pinyin || ''}) = ${w.english || ''}`).join('\n');
  const system = `You tag Mandarin vocabulary with topics for a beginner learning app.
Allowed topics (use ONLY these): ${TOPICS.join(', ')}.
For each numbered word, return 1-2 topics that best fit. If none fit well, return an empty array.
Respond with ONLY a JSON array of objects: [{"i":0,"topics":["food"]}, ...].`;
  const out = await completeJson({
    system,
    messages: [{ role: 'user', content: list }],
    max_tokens: 2048,
  });
  const map = new Map();
  for (const row of out) {
    const topics = (row.topics || []).filter(t => TOPIC_SET.has(t)).slice(0, 2);
    map.set(row.i, topics);
  }
  return map;
}

async function enrichWords(useLlm) {
  const cache = db().prepare('SELECT topics FROM enrichment_cache WHERE hanzi=?');
  const putCache = db().prepare(
    'INSERT INTO enrichment_cache(hanzi, topics, updated) VALUES(?,?,datetime()) ON CONFLICT(hanzi) DO UPDATE SET topics=excluded.topics, updated=datetime()');
  const setTopics = db().prepare('UPDATE words SET topics=? WHERE id=?');

  // Words needing tags: no topics yet AND not cached.
  const pending = db().prepare(`
    SELECT id, hanzi, pinyin, english FROM words
    WHERE (topics IS NULL OR topics='' OR topics='[]')`).all();

  // First fill from cache.
  let fromCache = 0, tagged = 0;
  const toDo = [];
  for (const w of pending) {
    const c = cache.get(w.hanzi);
    if (c && c.topics != null) {
      setTopics.run(c.topics, w.id);
      fromCache++;
    } else {
      toDo.push(w);
    }
  }
  console.log(`Words: ${pending.length} pending, ${fromCache} restored from cache, ${toDo.length} to tag`);

  const limited = toDo.slice(0, Number.isFinite(LIMIT) ? LIMIT : toDo.length);
  for (let i = 0; i < limited.length; i += BATCH) {
    const batch = limited.slice(i, i + BATCH);
    let tagsFor;
    if (useLlm) {
      try { tagsFor = await llmBatchTags(batch); }
      catch (e) { console.warn('  LLM batch failed, falling back to keywords:', e.message); tagsFor = null; }
    }
    const tx = db().transaction((rows) => {
      rows.forEach((w, j) => {
        const topics = tagsFor?.get(j) ?? keywordTags(w.english);
        const json = JSON.stringify(topics);
        setTopics.run(json, w.id);
        putCache.run(w.hanzi, json);
        tagged++;
      });
    });
    tx(batch);
    console.log(`  tagged ${Math.min(i + BATCH, limited.length)}/${limited.length}`);
  }
  console.log(`Done words: ${tagged} newly tagged.`);
}

async function enrichSentences(useLlm) {
  const pending = db().prepare(`SELECT id, hanzi, pinyin, english FROM sentences
    WHERE pattern_tag IS NULL`).all();
  if (!pending.length) { console.log('No sentences need pattern tags.'); return; }
  if (!useLlm) { console.log(`Skipping ${pending.length} sentence patterns (no API key).`); return; }

  const setPattern = db().prepare('UPDATE sentences SET pattern_tag=? WHERE id=?');
  const limited = pending.slice(0, Number.isFinite(LIMIT) ? LIMIT : pending.length);
  for (let i = 0; i < limited.length; i += BATCH) {
    const batch = limited.slice(i, i + BATCH);
    const list = batch.map((s, j) => `${j}. ${s.hanzi} = ${s.english || ''}`).join('\n');
    const system = `You label Mandarin example sentences with the single grammar pattern they best demonstrate (e.g. "是...的", "把 construction", "verb+过 experience", "measure word", "comparative 比"). Respond ONLY with a JSON array: [{"i":0,"pattern":"..."}].`;
    let out;
    try { out = await completeJson({ system, messages: [{ role: 'user', content: list }], max_tokens: 2048 }); }
    catch (e) { console.warn('  sentence batch failed:', e.message); continue; }
    const tx = db().transaction((rows) => {
      const byI = new Map(rows.map(r => [r.i, r.pattern]));
      batch.forEach((s, j) => setPattern.run(byI.get(j) || 'general', s.id));
    });
    tx(out);
    console.log(`  sentences ${Math.min(i + BATCH, limited.length)}/${limited.length}`);
  }
  console.log('Done sentence patterns.');
}

async function main() {
  initSchema();
  const useLlm = hasApiKey();
  console.log(useLlm ? 'Using Anthropic API for enrichment.' : 'No API key — using offline keyword tagger.');
  await enrichWords(useLlm);
  if (DO_SENTENCES) await enrichSentences(useLlm);
}

main().catch(e => { console.error(e); process.exit(1); });
