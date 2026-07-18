// Unit builder CLI. Delegates to server/units.js (shared with the app).
//   node ingest/build-units.js [--topics food,travel,family] [--size 20] [--boost 0.5]
import { initSchema, getSetting, setSetting } from '../server/db.js';
import { rebuildUnits } from '../server/units.js';

function num(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? Number(process.argv[i + 1]) : def; }
function arr(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1]).split(',').map(s => s.trim()).filter(Boolean) : null;
}

initSchema();
let topics = arr('--topics');
if (!topics) topics = getSetting('interest_topics', []);
else setSetting('interest_topics', topics);
console.log('Interest topics:', topics.length ? topics.join(', ') : '(none)');

const r = rebuildUnits(topics, { size: num('--size', 20), boost: num('--boost', 0.5) });
if (!r.words) { console.log('No words imported yet.'); process.exit(0); }
console.log(`Built ${r.units} units from ${r.words} words.`);
console.log(`Sentences: ${r.covered} fully covered, ${r.partial} partial/uncovered.`);
