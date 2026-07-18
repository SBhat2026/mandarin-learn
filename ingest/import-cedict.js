// CC-CEDICT importer.
//   node ingest/import-cedict.js [path/to/cedict_ts.u8]
// Default source: ingest/sources/cedict_ts.u8
// Line format: Traditional Simplified [pin1 yin1] /def1/def2/
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { db, initSchema, ROOT } from '../server/db.js';

const SOURCES_DIR = join(ROOT, 'ingest', 'sources');
const LINE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.+)\/\s*$/;

function findSource(arg) {
  if (arg && existsSync(arg)) return arg;
  const known = ['cedict_ts.u8', 'cedict_1_0_ts_utf-8_mdbg.txt', 'cedict.txt']
    .map(f => join(SOURCES_DIR, f)).find(existsSync);
  if (known) return known;
  if (existsSync(SOURCES_DIR)) {
    const cedict = readdirSync(SOURCES_DIR).find(f => /cedict/i.test(f));
    if (cedict) return join(SOURCES_DIR, cedict);
  }
  return null;
}

async function main() {
  initSchema();
  const src = findSource(process.argv[2]);
  if (!src) { console.error('CC-CEDICT file not found. Place cedict_ts.u8 in ingest/sources/'); process.exit(1); }

  db().exec('DELETE FROM dictionary');
  const insert = db().prepare(
    'INSERT INTO dictionary(traditional, simplified, pinyin, definitions) VALUES(?,?,?,?)');
  const rl = createInterface({ input: createReadStream(src, 'utf8'), crlfDelay: Infinity });

  let count = 0;
  const batch = [];
  const flush = db().transaction((rows) => { for (const r of rows) insert.run(...r); });

  for await (const line of rl) {
    if (line.startsWith('#') || !line.trim()) continue;
    const m = line.match(LINE);
    if (!m) continue;
    const [, trad, simp, pinyin, defs] = m;
    batch.push([trad, simp, pinyin, JSON.stringify(defs.split('/').filter(Boolean))]);
    count++;
    if (batch.length >= 5000) { flush(batch.splice(0)); }
  }
  if (batch.length) flush(batch);
  console.log(`Imported ${count} dictionary entries from ${src}`);
}

main().catch(e => { console.error(e); process.exit(1); });
