// Inspect the capability-keyed lesson plan the Director/Qwen will consume. Prints
// the picked capability, hidden objectives, focal + target vocabulary, and the
// planning signals — a quick snapshot to sanity-check that vocab resolves sensibly.
//
//   npm run dump:plan            # one plan
//   npm run dump:plan -- 3       # three consecutive plans (with mastery drift)
import 'dotenv/config';
import { buildLessonPlan } from '../server/neighborhood.js';

const n = Number(process.argv[2]) || 1;
for (let i = 0; i < n; i++) {
  const p = buildLessonPlan();
  const cap = p.capability;
  console.log('\n' + '─'.repeat(66));
  console.log(`CAPABILITY  ${cap ? `${cap.name} [${cap.slug}] ${cap.cefr || ''}` : '(none — legacy focal)'}`);
  if (p.signals) console.log('  signals   ', JSON.stringify(p.signals));
  console.log(`FOCAL       ${p.focal.hanzi} (${p.focal.pinyin}) — ${p.focal.gloss}`);
  console.log('OBJECTIVES  (hidden):');
  for (const o of p.objectives) console.log(`   · ${o.objective}  vocab=[${(o.vocab || []).join(' ')}]${o.pattern ? '  pattern=' + o.pattern : ''}  p${o.priority}`);
  console.log('TARGET VOCAB:');
  for (const v of p.targetVocab) console.log(`   ${(v.role || '').padEnd(10)} ${v.hanzi}  ${v.pinyin || ''}  ${(v.gloss || '').slice(0, 24)}`);
  if (p.reviewVocab?.length) console.log('REVIEW      ', p.reviewVocab.map(v => v.hanzi).join(' '));
  console.log(`SCRIPT      level=${p.scriptLevel.toFixed(2)}   SCENE ${p.scene}`);
}
process.exit(0);
