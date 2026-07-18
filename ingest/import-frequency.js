// Frequency importer (SUBTLEX-CH style CSV/TSV).
//   node ingest/import-frequency.js [path] [--col-word N] [--col-freq N]
// Auto-detects the word column and a frequency/count column; ranks by descending
// frequency. If a rank column exists it is used directly.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { db, initSchema, ROOT } from '../server/db.js';

const SOURCES_DIR = join(ROOT, 'ingest', 'sources');

function findSource(arg) {
  if (arg && !arg.startsWith('--') && existsSync(arg)) return arg;
  if (existsSync(SOURCES_DIR)) {
    const f = readdirSync(SOURCES_DIR).find(x => /subtlex|freq/i.test(x) && /\.(csv|tsv|txt)$/i.test(x));
    if (f) return join(SOURCES_DIR, f);
  }
  return null;
}

function splitLine(line) {
  return line.includes('\t') ? line.split('\t') : line.split(',');
}

const CJK = /[一-鿿]/;

async function main() {
  initSchema();
  const args = process.argv.slice(2);
  const src = findSource(args[0]);
  if (!src) { console.error('Frequency file not found. Place a SUBTLEX-CH CSV in ingest/sources/'); process.exit(1); }

  const rl = createInterface({ input: createReadStream(src, 'utf8'), crlfDelay: Infinity });
  let header = null, wordCol = -1, freqCol = -1, rankCol = -1;
  const rows = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = splitLine(line).map(c => c.trim());
    if (!header) {
      header = cols.map(c => c.toLowerCase());
      wordCol = header.findIndex(h => /^word$|词|hanzi|chinese/.test(h));
      freqCol = header.findIndex(h => /freq|count|wcount|subtlex/.test(h));
      rankCol = header.findIndex(h => /rank/.test(h));
      // If no header row (first cell looks like data), fall back to positional.
      if (wordCol < 0 && CJK.test(cols[0])) {
        wordCol = 0; freqCol = cols.length > 1 ? 1 : -1; header = null;
        // reprocess this line as data below
      } else {
        continue;
      }
    }
    const word = cols[wordCol];
    if (!word || !CJK.test(word)) continue;
    const rank = rankCol >= 0 ? Number(cols[rankCol]) : null;
    const freq = freqCol >= 0 ? Number(cols[freqCol]) : null;
    rows.push({ word, rank, freq });
  }

  // Assign ranks if not provided: sort by freq desc.
  let ranked;
  if (rows.every(r => r.rank != null && !Number.isNaN(r.rank))) {
    ranked = rows.map(r => ({ word: r.word, rank: r.rank }));
  } else {
    ranked = rows
      .filter(r => r.freq != null && !Number.isNaN(r.freq))
      .sort((a, b) => b.freq - a.freq)
      .map((r, i) => ({ word: r.word, rank: i + 1 }));
  }

  db().exec('DELETE FROM frequency');
  const insert = db().prepare('INSERT OR REPLACE INTO frequency(word, rank) VALUES(?,?)');
  const tx = db().transaction((items) => { for (const it of items) insert.run(it.word, it.rank); });
  tx(ranked);
  console.log(`Imported ${ranked.length} frequency entries from ${src}`);
}

main().catch(e => { console.error(e); process.exit(1); });
