// Backfill word POS / HSK level / concreteness and character metadata.
//   node ingest/backfill-meta.js
// Sources (gitignored, in ingest/sources/):
//   hsk.json           complete-hsk-vocabulary (level, pos, frequency)
//   makemeahanzi.txt   per-character decomposition (radical, components, phonetic)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, initSchema, ROOT } from '../server/db.js';

const SRC = join(ROOT, 'ingest', 'sources');
const IDC = new Set([...'⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻']);

// POS → concreteness tier used for concrete-first ordering.
//   2 = concrete noun/verb (surface early)  1 = adj/adverb  0 = function/grammar
const CONCRETE = new Set(['n', 'v', 'vn', 'nz', 'an', 'vd', 'ns']);
const MID = new Set(['a', 'ad', 'd', 'm', 'q', 'i', 'l', 's', 't', 'z', 'b', 'f']);
const PROPER = new Set(['nr', 'ns', 'nz', 'nt']);
// Bare grammar particles/interjections (dominant POS): taught in context, never
// as isolated flashcards. Keyed on pos[0] — the word's dominant sense.
const PARTICLE_HEAD = new Set(['u', 'y', 'e', 'o', 'k']);
const isParticle = (pos) => pos.length > 0 && PARTICLE_HEAD.has(pos[0]);

function concreteTier(pos) {
  if (!pos || !pos.length) return 1;
  if (pos.some(p => CONCRETE.has(p))) return 2;
  if (pos.some(p => MID.has(p))) return 1;
  return 0; // u/p/c/r/e/o/y/h/k particles, pronouns, conjunctions…
}

function lvlNum(levels) {
  // level tags like "new-1", "old-3", "newest-2" → smallest numeric band.
  let best = 99;
  for (const t of levels || []) {
    const n = Number(String(t).split('-').pop());
    if (Number.isFinite(n)) best = Math.min(best, n);
  }
  return best === 99 ? null : best;
}

function backfillWords() {
  const path = join(SRC, 'hsk.json');
  if (!existsSync(path)) { console.warn('! hsk.json missing — skipping word POS/level'); return; }
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  const byHanzi = new Map();
  for (const e of entries) byHanzi.set(e.simplified, e);

  const words = db().prepare('SELECT id, hanzi FROM words').all();
  const upd = db().prepare(
    'UPDATE words SET pos=?, hsk_level=COALESCE(?,hsk_level), concrete=?, particle=? WHERE id=?');
  let hit = 0;
  const tx = db().transaction(() => {
    for (const w of words) {
      const e = byHanzi.get(w.hanzi);
      const pos = e?.pos || [];
      const proper = pos.length > 0 && pos.every(p => PROPER.has(p));
      const part = isParticle(pos) ? 1 : 0;
      // Proper nouns and particles get concreteness 0 so the planner de-prioritizes them.
      const tier = (proper || part) ? 0 : concreteTier(pos);
      upd.run(JSON.stringify(pos), e ? lvlNum(e.level) : null, tier, part, w.id);
      if (e) hit++;
    }
  });
  tx();
  console.log(`✓ words: POS/level/concrete set for ${hit}/${words.length}`);
}

function backfillChars() {
  const path = join(SRC, 'makemeahanzi.txt');
  if (!existsSync(path)) { console.warn('! makemeahanzi.txt missing — skipping char_meta'); return; }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const up = db().prepare(`INSERT INTO char_meta(hanzi,pinyin,radical,components,decomposition,phonetic,semantic,definition)
    VALUES(@hanzi,@pinyin,@radical,@components,@decomposition,@phonetic,@semantic,@definition)
    ON CONFLICT(hanzi) DO UPDATE SET pinyin=excluded.pinyin, radical=excluded.radical,
      components=excluded.components, decomposition=excluded.decomposition,
      phonetic=excluded.phonetic, semantic=excluded.semantic, definition=excluded.definition`);
  let n = 0;
  const tx = db().transaction(() => {
    for (const line of lines) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const decomp = o.decomposition || '';
      const comps = [...decomp].filter(ch => !IDC.has(ch) && ch !== '？' && ch !== o.character);
      const radical = o.radical || null;
      // Phonetic = the component that is NOT the semantic radical (carries sound).
      const phonetic = comps.find(c => c !== radical) || null;
      up.run({
        hanzi: o.character,
        pinyin: JSON.stringify(o.pinyin || []),
        radical,
        components: JSON.stringify([...new Set(comps)]),
        decomposition: decomp,
        phonetic,
        semantic: radical,
        definition: o.definition || null,
      });
      n++;
    }
  });
  tx();
  console.log(`✓ char_meta: ${n} characters`);
}

initSchema();
backfillWords();
backfillChars();
console.log('done.');
