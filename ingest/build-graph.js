// Build the knowledge graph edges that drive teaching order, review generation,
// and lesson planning.  node ingest/build-graph.js
//
// Edge relations produced:
//   shares_char      word  → char        (composition: which characters a word uses)
//   component        char  → char        (a character's reusable sub-components)
//   radical_family   char  → radical     (semantic radical grouping)
//   phonetic_series  char  → phonetic    (shared phonetic component → shared sound)
//   visual_confusion char  → char        (look-alikes, taught together to pre-empt mistakes)
//   topic            word  → topic        (topic clustering)
//   collocation      word  → word         (frequently co-occurring in sentences)
//   sentence_dep     sentence → word      (sentence depends on these words)
//   grammar_pattern  sentence → pattern   (grammar pattern demonstrated)
import { db, initSchema } from '../server/db.js';

const CJK = /[一-鿿]/;
const chars = (s) => [...(s || '')].filter(ch => CJK.test(ch));

function reset() {
  db().exec('DELETE FROM graph_edges');
}

const insert = () => db().prepare(
  `INSERT OR IGNORE INTO graph_edges(src_type,src,rel,dst_type,dst,weight) VALUES(?,?,?,?,?,?)`);

function build() {
  const ins = insert();
  const words = db().prepare('SELECT id, hanzi, topics FROM words').all();
  const meta = new Map(db().prepare('SELECT * FROM char_meta').all().map(m => [m.hanzi, m]));

  // Which characters actually appear in our vocabulary — bound family/confusion work.
  const vocabChars = new Set();
  for (const w of words) for (const c of chars(w.hanzi)) vocabChars.add(c);

  const tx = db().transaction(() => {
    // --- word → char, word → topic ---
    for (const w of words) {
      for (const c of new Set(chars(w.hanzi))) ins.run('word', String(w.id), 'shares_char', 'char', c, 1);
      let topics = []; try { topics = JSON.parse(w.topics || '[]'); } catch {}
      for (const t of topics) ins.run('word', String(w.id), 'topic', 'topic', t, 1);
    }

    // --- character composition + families (only vocab chars matter) ---
    for (const c of vocabChars) {
      const m = meta.get(c);
      if (!m) continue;
      let comps = []; try { comps = JSON.parse(m.components || '[]'); } catch {}
      for (const sub of comps) ins.run('char', c, 'component', 'char', sub, 1);
      if (m.radical) ins.run('char', c, 'radical_family', 'radical', m.radical, 1);
      if (m.phonetic) ins.run('char', c, 'phonetic_series', 'phonetic', m.phonetic, 1);
    }

    // --- visual confusion: genuine look-alikes ---
    // Decomposition similarity alone is noisy (it can't tell 未 from 末), so we
    // require multi-component chars that share ≥2 components and differ by ≤1,
    // and we seed the classic beginner confusables curated below.
    const vc = [...vocabChars].filter(c => meta.has(c));
    const compSet = new Map();
    for (const c of vc) {
      let comps = []; try { comps = JSON.parse(meta.get(c).components || '[]'); } catch {}
      compSet.set(c, new Set(comps));
    }
    const byRadical = new Map();
    for (const c of vc) {
      const r = meta.get(c).radical || '?';
      (byRadical.get(r) || byRadical.set(r, []).get(r)).push(c);
    }
    for (const group of byRadical.values()) {
      if (group.length < 2 || group.length > 120) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          const A = compSet.get(a), B = compSet.get(b);
          if (A.size < 2 || B.size < 2) continue;                 // single-component chars → skip
          const inter = [...A].filter(x => B.has(x)).length;
          const diff = (A.size - inter) + (B.size - inter);
          if (inter >= 2 && diff <= 1) {                          // share most, differ by ≤1 piece
            ins.run('char', a, 'visual_confusion', 'char', b, inter);
            ins.run('char', b, 'visual_confusion', 'char', a, inter);
          }
        }
      }
    }
    // Curated classic confusables (subtle stroke differences decomposition misses).
    const CONFUSE = [
      ['己', '已', '巳'], ['未', '末'], ['土', '士'], ['天', '夫'], ['大', '太', '犬'],
      ['日', '曰', '目'], ['人', '入', '八'], ['干', '千'], ['王', '玉', '主'],
      ['白', '百', '自'], ['木', '本', '术'], ['我', '找'], ['明', '朋'], ['话', '活'],
      ['买', '卖'], ['右', '石'], ['牛', '午'], ['问', '间'], ['很', '跟'], ['借', '错'],
      ['休', '体'], ['贝', '见'], ['特', '持'],
    ];
    for (const grp of CONFUSE) {
      for (const a of grp) for (const b of grp) if (a !== b) ins.run('char', a, 'visual_confusion', 'char', b, 3);
    }

    // --- sentence dependencies, grammar patterns, collocations ---
    const sentences = db().prepare('SELECT id, word_ids, pattern_tag FROM sentences').all();
    const coCount = new Map();
    for (const s of sentences) {
      let ids = []; try { ids = JSON.parse(s.word_ids || '[]'); } catch {}
      for (const id of ids) ins.run('sentence', String(s.id), 'sentence_dep', 'word', String(id), 1);
      if (s.pattern_tag) ins.run('sentence', String(s.id), 'grammar_pattern', 'pattern', s.pattern_tag, 1);
      // co-occurrence within a sentence → collocation candidates
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
          coCount.set(key, (coCount.get(key) || 0) + 1);
        }
    }
    for (const [key, n] of coCount) {
      if (n < 2) continue;               // needs to co-occur at least twice
      const [a, b] = key.split('|');
      ins.run('word', a, 'collocation', 'word', b, n);
      ins.run('word', b, 'collocation', 'word', a, n);
    }
  });
  tx();

  const total = db().prepare('SELECT COUNT(*) c FROM graph_edges').get().c;
  const byRel = db().prepare('SELECT rel, COUNT(*) c FROM graph_edges GROUP BY rel ORDER BY c DESC').all();
  console.log(`✓ graph: ${total} edges`);
  for (const r of byRel) console.log(`   ${r.rel.padEnd(16)} ${r.c}`);
}

initSchema();
reset();
build();
