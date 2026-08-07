// Full re-enrichment pass (Claude). Fixes the noisy first-pass tags at the root:
//   • topics     — 0-2 tags from the fixed taxonomy; FUNCTION WORDS GET NONE
//                  (the old pass tagged 的 as "animals" — every downstream
//                  personalization signal read that noise)
//   • concrete   — 0-3 (3 = physically picturable object; 0 = grammatical/abstract)
//   • register   — 'spoken' | 'written' | 'both' (a speaking-first app should not
//                  teach literary-only words early)
//   • particle   — refreshed function-word flag
//   • hsk_band   — splits the collapsed HSK 7-9 level into 7/8/9 by frequency
//                  terciles (no LLM needed)
//
//   node ingest/reenrich.js [--limit N] [--batch N] [--concurrency N] [--fresh]
//
// Batched, cached (enrichment_v2 table), resumable, with a small concurrency pool.
import { db, initSchema } from '../server/db.js';
import { TOPICS, TOPIC_SET } from '../server/taxonomy.js';
import { hasApiKey, completeJson } from '../server/anthropic.js';

const BATCH = num('--batch', 40);
const LIMIT = num('--limit', Infinity);
const CONCURRENCY = num('--concurrency', 6);
const FRESH = process.argv.includes('--fresh');

function num(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const SYSTEM = `You are enriching a Mandarin vocabulary database for a personalized learning app that teaches SPEAKING and READING.

For each numbered word return an object with:
- "topics": array of 0-2 topics, ONLY from this list: ${TOPICS.join(', ')}.
  CRITICAL: grammatical/function words (particles like 的了吗呢, pronouns, measure words, conjunctions, prepositions, copulas, aspect markers, adverbs of degree like 很/都/也, auxiliaries) get an EMPTY array. A topic is only for content words that clearly BELONG to that topic (猫 → animals; 跑步 → sports). When unsure, prefer the empty array — a wrong tag is worse than no tag.
- "concrete": 0-3. 3 = a physically picturable object or being (猫, 桌子, 医生); 2 = concrete action or observable phenomenon (跑, 下雨); 1 = experiential but abstract (高兴, 觉得); 0 = grammatical or fully abstract (的, 制度, 而且).
- "func": true only for grammatical/function words as defined above, else false.
- "register": "spoken" if the word is common in everyday conversation, "written" if it is mostly literary/formal/newsy (而, 之, 即, 亦, formal connectors, literary verbs), "both" if genuinely common in both.

Respond ONLY with a JSON array: [{"i":0,"topics":[],"concrete":0,"func":true,"register":"both"}, ...] — one object per input word, same order, no other text.`;

function ensureCache() {
  db().exec(`CREATE TABLE IF NOT EXISTS enrichment_v2 (
    hanzi TEXT PRIMARY KEY,
    data  TEXT NOT NULL,
    updated TEXT
  )`);
}

async function llmBatch(items) {
  const list = items.map((w, i) => `${i}. ${w.hanzi} (${w.pinyin || ''}) [pos: ${posStr(w.pos)}] = ${w.english || w.gloss || ''}`).join('\n');
  const out = await completeJson({
    system: SYSTEM,
    tier: 'fast',
    messages: [{ role: 'user', content: list }],
    max_tokens: 4096,
  });
  if (!Array.isArray(out)) throw new Error('non-array response');
  const map = new Map();
  for (const row of out) {
    if (row == null || row.i == null) continue;
    map.set(Number(row.i), {
      topics: (Array.isArray(row.topics) ? row.topics : []).filter(t => TOPIC_SET.has(t)).slice(0, 2),
      concrete: clampInt(row.concrete, 0, 3),
      func: Boolean(row.func),
      register: ['spoken', 'written', 'both'].includes(row.register) ? row.register : 'both',
    });
  }
  return map;
}
const clampInt = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(x) || 0)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const posStr = (pos) => { try { return JSON.parse(pos || '[]').join(',') || '?'; } catch { return '?'; } };

function applyRow(w, e) {
  // Function words: force empty topics + concrete 0, whatever the model said.
  const topics = e.func ? [] : e.topics;
  const concrete = e.func ? 0 : e.concrete;
  db().prepare('UPDATE words SET topics=?, concrete=?, particle=?, register=? WHERE id=?')
    .run(JSON.stringify(topics), concrete, e.func ? 1 : 0, e.register, w.id);
}

async function enrichWords() {
  ensureCache();
  const cacheGet = db().prepare('SELECT data FROM enrichment_v2 WHERE hanzi=?');
  const cachePut = db().prepare(`INSERT INTO enrichment_v2(hanzi, data, updated) VALUES(?,?,datetime())
    ON CONFLICT(hanzi) DO UPDATE SET data=excluded.data, updated=datetime()`);

  const all = db().prepare('SELECT id, hanzi, pinyin, english, gloss, pos FROM words ORDER BY COALESCE(freq_rank, 999999) ASC').all();

  let fromCache = 0;
  const toDo = [];
  for (const w of all) {
    const c = FRESH ? null : cacheGet.get(w.hanzi);
    if (c) {
      try { applyRow(w, JSON.parse(c.data)); fromCache++; continue; } catch {}
    }
    toDo.push(w);
  }
  const limited = toDo.slice(0, Number.isFinite(LIMIT) ? LIMIT : toDo.length);
  console.log(`Words: ${all.length} total, ${fromCache} from cache, ${limited.length} to enrich (batch ${BATCH}, x${CONCURRENCY})`);

  const batches = [];
  for (let i = 0; i < limited.length; i += BATCH) batches.push(limited.slice(i, i + BATCH));

  let done = 0, failed = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const my = cursor++;
      const batch = batches[my];
      let map = null;
      for (let attempt = 0; attempt < 3 && !map; attempt++) {
        try { map = await llmBatch(batch); }
        catch (e) {
          if (attempt === 2) { console.warn(`  batch ${my} failed permanently: ${e.message}`); failed += batch.length; }
          else await sleep(1500 * (attempt + 1));
        }
      }
      if (!map) continue;
      const tx = db().transaction(() => {
        batch.forEach((w, j) => {
          const e = map.get(j);
          if (!e) { failed++; return; }
          applyRow(w, e);
          cachePut.run(w.hanzi, JSON.stringify(e));
          done++;
        });
      });
      tx();
      if (my % 5 === 0 || my === batches.length - 1) console.log(`  ${done}/${limited.length} enriched (${failed} failed)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  console.log(`Done: ${done} enriched, ${failed} failed.`);
}

// HSK 7-9 was imported as one level ("7"). Split into 7/8/9 by frequency terciles so
// leveling and CEFR mapping see a real gradient. Other levels: hsk_band = hsk_level.
function splitHskBand() {
  db().prepare('UPDATE words SET hsk_band = hsk_level WHERE hsk_level IS NOT NULL AND hsk_level < 7').run();
  const b7 = db().prepare('SELECT id FROM words WHERE hsk_level=7 ORDER BY COALESCE(freq_rank, 999999) ASC').all();
  const third = Math.ceil(b7.length / 3);
  const set = db().prepare('UPDATE words SET hsk_band=? WHERE id=?');
  const tx = db().transaction(() => {
    b7.forEach((r, i) => set.run(i < third ? 7 : i < 2 * third ? 8 : 9, r.id));
  });
  tx();
  console.log(`HSK 7-9 split: ${b7.length} words → bands 7/8/9 by frequency terciles.`);
}

async function main() {
  initSchema();
  if (!hasApiKey()) { console.error('ANTHROPIC_API_KEY required for re-enrichment.'); process.exit(1); }
  splitHskBand();
  await enrichWords();
}

main().catch(e => { console.error(e); process.exit(1); });
