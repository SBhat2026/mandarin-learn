// Convenience runner for the whole ingest pipeline.
//   node ingest/run-all.js [--yes] [--topics food,travel]
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rest = process.argv.slice(2);
const yes = rest.includes('--yes') || rest.includes('-y');
const topicsIdx = rest.indexOf('--topics');
const topics = topicsIdx >= 0 ? rest[topicsIdx + 1] : null;

function run(script, args = []) {
  console.log(`\n===== ${script} =====`);
  const r = spawnSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`Step ${script} failed (${r.status}).`); process.exit(r.status || 1); }
}

run('import-apkg.js', yes ? ['--yes'] : []);
run('import-cedict.js');
run('import-frequency.js');
run('enrich.js', ['--sentences']);
run('backfill-meta.js');    // POS / HSK level / concreteness / particle + char_meta
run('build-graph.js');      // knowledge graph edges (families, phonetic series, collocations)
run('build-units.js', topics ? ['--topics', topics] : []);
run('dump-units.js');
console.log('\nPipeline complete.');
