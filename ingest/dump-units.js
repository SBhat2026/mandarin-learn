// CLI sanity dump of the built units.
//   node ingest/dump-units.js [--limit N]
import { db, initSchema } from '../server/db.js';

const i = process.argv.indexOf('--limit');
const LIMIT = i >= 0 ? Number(process.argv[i + 1]) : 12;

function main() {
  initSchema();
  const units = db().prepare('SELECT * FROM units ORDER BY position LIMIT ?').all(LIMIT);
  if (!units.length) { console.log('No units. Run ingest:units first.'); return; }
  const getWord = db().prepare('SELECT hanzi, pinyin, english, freq_rank FROM words WHERE id=?');
  const sentCount = db().prepare('SELECT COUNT(*) c FROM sentences').get().c;

  for (const u of units) {
    const ids = JSON.parse(u.word_ids || '[]');
    console.log(`\n#${u.position} ${u.name}  [${u.topic}]  (${ids.length} words)`);
    ids.slice(0, 8).forEach(id => {
      const w = getWord.get(id);
      if (w) console.log(`   ${w.hanzi.padEnd(6)} ${String(w.pinyin || '').padEnd(14)} ${(w.english || '').slice(0, 34)}  #${w.freq_rank}`);
    });
    if (ids.length > 8) console.log(`   … +${ids.length - 8} more`);
  }
  console.log(`\nTotal: ${units.length}+ units shown, ${sentCount} sentences in DB.`);
}

main();
