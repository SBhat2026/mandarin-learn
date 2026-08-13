#!/usr/bin/env node
// Beginner-turn bake-off: who should write a rung-0/1 turn?
//
//   npm run bakeoff
//
// The guided rungs currently call no model at all — turns come from templates, which
// is exactly why they read as sound bites ("这是屋。" "我有电脑。") instead of a
// conversation. Replacing that generator is the single biggest quality lever left, so
// this measures the candidates on the same scenarios rather than guessing:
//
//   template  — what ships today (deterministic frames)
//   qwen      — qwen3-235b-a22b-2507 via OpenRouter
//   claude    — claude-sonnet-5
//
// Scored on what a beginner turn has to DO, not on vibes:
//   decodable      every content word inside the allowed set (the rung-0 promise)
//   invites        ends with something that asks for a reply
//   responsive     picks up a content word the learner just used
//   onGoal         uses the session's goal vocabulary
//   latency/cost   what it costs to ship it
import { writeFileSync } from 'node:fs';

process.env.APP_DB_PATH ||= new URL('../data/app.db', import.meta.url).pathname;
const { validateTurn, segment, coreSet } = await import('../server/vocabguard.js');
const { complete } = await import('../server/anthropic.js');
const { chat } = await import('../server/qwen.js');

// Five scenarios taken from real transcripts, including the two that prompted this.
const SCENARIOS = [
  { goal: 'find out what is in the learner\'s home',
    words: ['房子', '电脑', '书'], said: '我也有电脑', beat: 'relate' },
  { goal: 'talk about animals the learner likes',
    words: ['猫', '狗'], said: '我喜欢猫', beat: 'relate' },
  { goal: 'find out how the learner gets around',
    words: ['车', '路'], said: '我有车', beat: 'identify' },
  { goal: 'talk about what the learner drinks',
    words: ['水', '茶'], said: '我想喝水', beat: 'use' },
  { goal: 'talk about the learner\'s friends',
    words: ['朋友', '老师'], said: '你好老师', beat: 'meet' },
];

const CORE = [...coreSet(1)];

function promptFor(s) {
  const allowed = [...new Set([...CORE, ...s.words])].join(' ');
  return `You are 老师, talking with a BEGINNER learner of Mandarin.

THE AIM OF THIS CONVERSATION: ${s.goal}. Everything you say should move toward it.

The learner just said: "${s.said}"

HARD VOCABULARY LIMIT — you may use ONLY these words, nothing else:
${allowed}

Write ONE short turn (1–2 sentences, under 14 characters) that:
- RESPONDS to what they just said — react to it, don't ignore it
- moves the aim forward
- ENDS BY ASKING THEM SOMETHING, so they have a reason to reply
- is a real exchange of information, not a statement of fact about an object

Bad (what we're replacing): "这是书。" — a fact, invites nothing.
Good: "你也喜欢书吗？你有几本？" — reacts, asks, keeps them talking.

Reply as strict JSON: {"hanzi":"...","pinyin":"...","english":"..."}
"hanzi" is characters only; "pinyin" has tone marks and matches the hanzi.`;
}

// The template baseline: what the app does today.
async function runTemplate(s) {
  const { buildFrameTurn } = await import('../server/vocabguard.js');
  const words = s.words.map(h => ({ hanzi: h, pinyin: '', gloss: '', isNew: true }));
  const t = buildFrameTurn({ rung: 0, sessionWords: words, turnIndex: 2 });
  return { hanzi: t?.hanzi || '', pinyin: t?.pinyin || '', english: t?.english || '' };
}

async function runClaude(s) {
  const txt = await complete({ system: 'You write beginner Mandarin teaching turns. Output strict JSON only.',
    messages: [{ role: 'user', content: promptFor(s) }], tier: 'rich', max_tokens: 300 });
  return parse(txt);
}

async function runQwen(s) {
  const r = await chat([{ role: 'system', content: 'You write beginner Mandarin teaching turns. Output strict JSON only.' },
    { role: 'user', content: promptFor(s) }], { temperature: 0.6, max_tokens: 300, json: true, kind: 'bakeoff' });
  return parse(r.text);
}

function parse(txt) {
  const body = String(txt || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { const o = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)); return { hanzi: o.hanzi || '', pinyin: o.pinyin || '', english: o.english || '' }; }
  catch { return { hanzi: '', pinyin: '', english: '', broken: true }; }
}

// ── Scoring ────────────────────────────────────────────────────────────────
function score(s, out) {
  const allowed = new Set([...CORE, ...s.words]);
  for (const w of [...allowed]) for (const c of w) allowed.add(c);
  const { violations } = out.hanzi ? validateTurn(out.hanzi, allowed) : { violations: ['(empty)'] };
  const invites = /[？?]/.test(out.hanzi) || /吗|呢|什么|几|谁|哪/.test(out.hanzi);
  // Did it pick up a content word the learner actually used?
  const saidWords = segment(s.said).filter(w => !coreSet(1).has(w));
  const responsive = saidWords.some(w => out.hanzi.includes(w));
  const onGoal = s.words.some(w => out.hanzi.includes(w));
  return { violations, invites, responsive, onGoal, chars: [...out.hanzi].length };
}

const RUNNERS = { template: runTemplate, qwen: runQwen, claude: runClaude };

const results = {};
for (const [name, run] of Object.entries(RUNNERS)) {
  results[name] = [];
  console.log(`\n${'═'.repeat(74)}\n▶ ${name}\n`);
  for (const s of SCENARIOS) {
    const t0 = Date.now();
    let out;
    try { out = await run(s); } catch (e) { out = { hanzi: '', pinyin: '', english: '', error: e.message }; }
    const ms = Date.now() - t0;
    const sc = score(s, out);
    results[name].push({ scenario: s.goal, said: s.said, ...out, ms, ...sc });
    const flags = [sc.violations.length ? `❌leak:${sc.violations.join('')}` : '✅decodable',
      sc.invites ? '✅invites' : '❌statement',
      sc.responsive ? '✅responsive' : '·', sc.onGoal ? '✅onGoal' : '·'].join(' ');
    console.log(`  learner: ${s.said}`);
    console.log(`  老师:    ${out.hanzi || '(nothing)'}${out.error ? '  ERROR ' + out.error : ''}`);
    console.log(`           ${out.english || ''}`);
    console.log(`           ${ms}ms  ${flags}\n`);
  }
}

console.log(`${'═'.repeat(74)}\nSCORECARD (n=${SCENARIOS.length})\n`);
console.log('  ' + 'engine'.padEnd(10) + 'decodable  invites  responsive  onGoal   p50ms');
for (const [name, rs] of Object.entries(results)) {
  const n = rs.length;
  const dec = rs.filter(r => !r.violations.length).length;
  const inv = rs.filter(r => r.invites).length;
  const res = rs.filter(r => r.responsive).length;
  const goal = rs.filter(r => r.onGoal).length;
  const ms = rs.map(r => r.ms).sort((a, b) => a - b)[Math.floor(n / 2)];
  console.log('  ' + name.padEnd(10) + `${dec}/${n}`.padEnd(11) + `${inv}/${n}`.padEnd(9)
    + `${res}/${n}`.padEnd(12) + `${goal}/${n}`.padEnd(9) + ms);
}
writeFileSync('bakeoff.json', JSON.stringify(results, null, 2));
console.log('\nfull outputs → bakeoff.json');
