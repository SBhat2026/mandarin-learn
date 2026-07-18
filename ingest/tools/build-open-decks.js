// Package open-licensed datasets into real .apkg decks + a frequency CSV so the
// standard ingest pipeline can consume them.
//
//   node ingest/tools/build-open-decks.js
//
// Inputs (place in ingest/sources/):
//   hsk.json   — drkameleon/complete-hsk-vocabulary  (MIT)
//   cmn.txt    — Tatoeba cmn-eng sentence pairs        (CC-BY 2.0)
// Outputs (written to ingest/sources/):
//   hsk-vocab.apkg, tatoeba-sentences.apkg, subtlex-style-frequency.csv
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(here, '..', 'sources');
const FIELD_SEP = '\x1f';

const MAX_SENTENCES = Number(process.env.MAX_SENTENCES || 6000);
const MAX_SENTENCE_LEN = Number(process.env.MAX_SENTENCE_LEN || 12);

function packApkg({ outPath, models, notes }) {
  const work = join(tmpdir(), 'build-apkg-' + process.pid + '-' + outPath.length);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const adb = new Database(join(work, 'collection.anki21'));
  adb.exec(`CREATE TABLE col (models TEXT);
            CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, flds TEXT);`);
  adb.prepare('INSERT INTO col(models) VALUES(?)').run(JSON.stringify(models));
  const ins = adb.prepare('INSERT INTO notes(id, guid, mid, flds) VALUES(?,?,?,?)');
  const tx = adb.transaction((rows) => {
    let id = 1;
    for (const n of rows) { ins.run(id, 'g' + id, n.mid, n.fields.join(FIELD_SEP)); id++; }
  });
  tx(notes);
  adb.close();
  writeFileSync(join(work, 'media'), JSON.stringify({}));
  rmSync(outPath, { force: true });
  const r = spawnSync('zip', ['-q', '-r', outPath, '.'], { cwd: work });
  if (r.status !== 0) throw new Error('zip failed: ' + r.stderr);
  rmSync(work, { recursive: true, force: true });
}

// In complete-hsk-vocabulary, forms[0] is often the surname/proper-noun or a rare
// tone reading. Prefer common readings (lowercase pinyin) and, among those, the
// richest real gloss — meta-glosses ("used in…", "variant of…") don't count.
function pickForm(forms = []) {
  if (!forms.length) return {};
  const isCommon = (f) => {
    const p = f.transcriptions?.pinyin || '';
    return p && p[0] === p[0].toLowerCase() && p[0] !== p[0].toUpperCase();
  };
  const realGlosses = (f) =>
    (f.meanings || []).filter(m => !/^(used in|variant of|old variant|see |surname )/i.test(m)).length;
  const pool = forms.filter(isCommon);
  const ranked = (pool.length ? pool : forms)
    .map((f, i) => ({ f, i, score: realGlosses(f) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return ranked[0].f;
}

function buildWords() {
  const src = join(SOURCES, 'hsk.json');
  if (!existsSync(src)) { console.log('skip words: hsk.json not found'); return null; }
  const data = JSON.parse(readFileSync(src, 'utf8'));
  const model = { id: '11001', name: 'HSK 1-7 Vocabulary',
    flds: [{ name: 'Hanzi' }, { name: 'Pinyin' }, { name: 'English' }, { name: 'Audio' }] };
  const notes = [];
  const freq = [];
  const seen = new Set();
  for (const e of data) {
    const hanzi = e.simplified;
    if (!hanzi || seen.has(hanzi)) continue;
    seen.add(hanzi);
    const form = pickForm(e.forms);
    const pinyin = form.transcriptions?.pinyin || '';
    const english = (form.meanings || []).slice(0, 4).join('; ');
    notes.push({ mid: Number(model.id), fields: [hanzi, pinyin, english, ''] });
    if (Number.isFinite(e.frequency)) freq.push({ word: hanzi, rank: e.frequency });
  }
  packApkg({ outPath: join(SOURCES, 'hsk-vocab.apkg'), models: { [model.id]: model }, notes });
  console.log(`hsk-vocab.apkg: ${notes.length} words`);

  // Frequency CSV (SUBTLEX-CH style): word,rank — smaller rank = more frequent.
  freq.sort((a, b) => a.rank - b.rank);
  const csv = 'word,rank\n' + freq.map(f => `${f.word},${f.rank}`).join('\n') + '\n';
  writeFileSync(join(SOURCES, 'subtlex-style-frequency.csv'), csv);
  console.log(`subtlex-style-frequency.csv: ${freq.length} ranked words`);
  return notes.length;
}

function buildSentences() {
  const src = join(SOURCES, 'cmn.txt');
  if (!existsSync(src)) { console.log('skip sentences: cmn.txt not found'); return null; }
  const lines = readFileSync(src, 'utf8').split('\n');
  const model = { id: '12002', name: 'Spoonfed-style Sentences (Tatoeba)',
    flds: [{ name: 'Hanzi' }, { name: 'Pinyin' }, { name: 'English' }] };

  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [english, hanzi] = line.split('\t');
    if (!hanzi || !english) continue;
    const chars = (hanzi.match(/[一-鿿]/g) || []).length;
    if (!chars || chars > MAX_SENTENCE_LEN) continue;
    const key = hanzi.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ hanzi: hanzi.trim(), english: english.trim(), len: chars });
  }
  // Beginner-first: shortest sentences first (Spoonfed's i+1 flavor), cap the count.
  rows.sort((a, b) => a.len - b.len);
  const chosen = rows.slice(0, MAX_SENTENCES);
  const notes = chosen.map(r => ({ mid: Number(model.id), fields: [r.hanzi, '', r.english] }));
  packApkg({ outPath: join(SOURCES, 'tatoeba-sentences.apkg'), models: { [model.id]: model }, notes });
  console.log(`tatoeba-sentences.apkg: ${notes.length} sentences (<= ${MAX_SENTENCE_LEN} hanzi, of ${rows.length} eligible)`);
  return notes.length;
}

buildWords();
buildSentences();
console.log('Done. Run: npm run ingest:all -- --topics <your,topics>');
