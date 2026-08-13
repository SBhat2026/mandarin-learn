#!/usr/bin/env node
// Level-sweep diagnostics — drive the real engine as five different learners.
//
//   npm run diagnose                 # all five levels
//   npm run diagnose -- --levels 0,4 # just those
//   npm run diagnose -- --json       # machine-readable
//   npm run diagnose -- --keep       # keep the scratch DBs for inspection
//
// Why a sweep rather than a unit test: nearly every bug this app has shipped was a
// LEVEL bug — behaviour that is correct for one learner and broken for another. The
// guided rung grinding two nouns was invisible to anyone with 500 words; the free
// rung never ending was invisible to a beginner who never reached it. So the harness
// seeds five learners spanning true-beginner → advanced, drives a whole session for
// each, and runs the same probes across all of them.
//
// Isolation: one scratch COPY of app.db (content is shared, read-through) plus a
// scratch users dir, so the real data/app.db is never written to. Each level is a
// secondary user with its own state DB.
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

// ── The five learners ───────────────────────────────────────────────────────
// `words` = how many of the most frequent words they hold solidly. `expectRung` is
// the rung the ladder SHOULD settle on once hysteresis has run its course.
const LEVELS = [
  { id: 0, name: 'true beginner',  words: 0,    expectRung: 0, produces: 'none',
    blurb: 'never seen Chinese; cannot read a character' },
  { id: 1, name: 'novice',         words: 40,   expectRung: 1, produces: 'single-words',
    blurb: 'a few weeks in; recognises common nouns, produces single words' },
  { id: 2, name: 'elementary',     words: 180,  expectRung: 2, produces: 'short-sentences',
    blurb: 'HSK1-ish; can make short sentences with help' },
  { id: 3, name: 'intermediate',   words: 700,  expectRung: 2, produces: 'sentences',
    blurb: 'HSK3-ish; converses about familiar topics' },
  { id: 4, name: 'advanced',       words: 1600, expectRung: 2, produces: 'fluent',
    blurb: 'HSK4/5-ish; discusses opinions and abstractions' },
];

// What the learner says back, per level. Deliberately imperfect — a real learner
// mixes languages, stalls, and gets things wrong.
// What the learner says back, per level. Each line is tagged so the probes know what
// they are looking at:
//   error:<kind> — a DELIBERATE mistake that must come back corrected
//   toneless     — pinyin without tone marks; fine early, a correction later
//   good         — unambiguously correct; must never be "corrected"
const SCRIPTS = {
  none:            [['猫', 'toneless'], ['这是猫', 'good'], ['好', ''], ['mao', 'toneless']],
  'single-words':  [['猫', 'good'], ['mao', 'toneless'], ['我有猫', ''], ['水', 'good']],
  'short-sentences': [['我有一只猫。', 'good'], ['我是好', 'error:shi-adjective'], ['mao', 'toneless'],
                      ['我有一个猫', 'error:measure-word'], ['我想喝水。', 'good']],
  sentences:       [['我今天很累，因为我工作了很久。', 'good'], ['二个人在这儿', 'error:er-liang'],
                    ['wo xihuan kan shu', 'toneless'], ['我有一个书', 'error:measure-word'],
                    ['我以前住在北京。', 'good']],
  fluent:          [['我最近在想换工作的事，可是还没决定。', 'good'], ['我是很累', ''],
                    ['wo juede zhongwen hen nan', 'toneless'], ['我有一个猫', 'error:measure-word'],
                    ['我认为这个问题没有简单的答案。', 'good']],
};
const CONFUSION = "I don't understand";
const CONFUSION_AT = 3;               // inject on this turn so never-strand is exercised

async function main() {
  const want = (opt('levels', '') || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const levels = want.length ? LEVELS.filter(l => want.includes(l.id)) : LEVELS;
  // Must exceed the engine's own ceiling or arc-completion "fails" for every free-rung
  // level purely because the harness stopped first (`FREE_CEILING` is 14, and the
  // level-scaled exchange budget can push the natural wrap later still).
  const maxTurns = Number(opt('turns', 18));

  // Scratch: a copy of the content DB + an empty users registry.
  const dir = mkdtempSync(join(tmpdir(), 'mandarin-diag-'));
  cpSync(join(ROOT, 'data', 'app.db'), join(dir, 'app.db'));
  const usersDir = join(dir, 'users');
  process.env.APP_DB_PATH = join(dir, 'app.db');
  process.env.APP_USERS_DIR = usersDir;
  process.env.APP_MEDIA_DIR = join(dir, 'media');
  writeFileSync(join(dir, 'users.json'), '');   // placeholder; real one written below
  const { mkdirSync } = await import('node:fs');
  mkdirSync(usersDir, { recursive: true });
  writeFileSync(join(usersDir, 'users.json'), JSON.stringify({
    users: [
      { id: 1, slug: 'me', displayName: 'Me', primary: true, createdAt: new Date(0).toISOString() },
      ...levels.map((l, i) => ({ id: i + 2, slug: `lvl${l.id}`, displayName: `Level ${l.id}`, primary: false, createdAt: new Date(0).toISOString() })),
    ],
  }, null, 2));

  const db = await import('../server/db.js');
  const probes = await import('./lib/probes.js');
  const results = [];

  for (const level of levels) {
    process.stdout.write(`\n${'─'.repeat(72)}\n▶ level ${level.id} — ${level.name} (${level.blurb})\n`);
    const r = await db.runAsUser(`lvl${level.id}`, () => runLevel({ level, maxTurns, probes }));
    results.push(r);
    report(r);
  }

  summary(results);
  if (flag('json')) writeFileSync(join(ROOT, 'diagnostics.json'), JSON.stringify(results, null, 2));
  if (flag('keep')) console.log(`\nscratch kept at ${dir}`);
  else rmSync(dir, { recursive: true, force: true });

  const failed = results.some(r => r.probes.some(p => !p.ok && p.severity === 'fail' && !p.skipped));
  process.exit(failed ? 1 : 0);
}

// ── Seeding a learner at a level ────────────────────────────────────────────
// Solid vocabulary is the honest lever: cards in review state + acquisition stage 2
// is exactly what knownWordIds() reads, and it is what the planner, the ladder, and
// the reading engine all key off. Production observations are seeded for the upper
// levels so `inferProductiveLevel` has the confidence the rung machine requires.
async function seedLevel(level) {
  const { db, setModel } = await import('../server/db.js');
  const d = db();
  if (!level.words) return { knownHanzi: new Set() };

  const rows = d.prepare(`SELECT id, hanzi, freq_rank, hsk_level FROM words
    WHERE freq_rank IS NOT NULL AND hanzi IS NOT NULL ORDER BY freq_rank ASC LIMIT ?`).all(level.words);
  const card = d.prepare(`INSERT OR IGNORE INTO cards(item_type,item_id,card_type,state,stability,due)
    VALUES('word',?,'memory',2,20,datetime('now','+5 days'))`);
  const acq = d.prepare(`INSERT OR REPLACE INTO acquisition(item_type,item_id,stage,updated) VALUES('word',?,2,datetime('now'))`);
  const tx = d.transaction(() => { for (const r of rows) { card.run(r.id); acq.run(r.id); } });
  tx();

  // Production observations: the learner has USED some of these unprompted. Drives
  // productive level/confidence, which gates the climb to the free rung.
  if (level.words >= 150) {
    const obs = {};
    for (const r of rows.slice(0, Math.min(40, rows.length))) {
      obs[r.hanzi] = { rank: r.freq_rank, hsk: r.hsk_level || null, unprompted: 3, total: 4 };
    }
    setModel('production_obs', obs);
  }
  const { refreshLevels } = await import('../server/level.js');
  refreshLevels([]);

  const knownHanzi = new Set();
  for (const r of rows) for (const c of r.hanzi) if (/[一-鿿]/.test(c)) knownHanzi.add(c);
  return { knownHanzi };
}

// ── Driving one level ───────────────────────────────────────────────────────
async function runLevel({ level, maxTurns, probes }) {
  const { knownHanzi } = await seedLevel(level);
  const rungMod = await import('../server/rung.js');
  const converse = await import('../server/converse.js');
  const vocabguard = await import('../server/vocabguard.js');

  // Hysteresis moves one rung per conversation, so a learner who belongs on the free
  // rung still opens their FIRST session on a guided one. Settle it the way real use
  // would (a few prior sessions) and record how many that took — a beginner-facing
  // app that takes five sessions to stop scaffolding an advanced learner is a bug.
  const firstRung = rungMod.currentRung({ commit: false });
  let settleSessions = 0, rung = firstRung;
  for (let i = 0; i < 4; i++) {
    const next = rungMod.currentRung({ commit: true });
    settleSessions++;
    if (next === rung && i > 0) break;
    rung = next;
  }

  const start = await converse.startConversation();
  const script = SCRIPTS[level.produces];
  const turns = [];
  const history = [];
  let userText = '';                       // the opening turn takes no input
  let tag = '';                            // what this line is (planted error / toneless / good)

  for (let i = 0; i < maxTurns; i++) {
    const wasConfusion = userText === CONFUSION;
    const plantedError = tag.startsWith('error:') ? tag.slice(6) : null;
    const tonelessProbe = tag === 'toneless';
    const knownGood = tag === 'good';
    const t0 = Date.now();
    let reply, error = null;
    try {
      reply = await converse.conversationTurn({ id: start.sessionId, userText, history });
    } catch (e) { error = e.message; reply = {}; }
    const ms = Date.now() - t0;

    // Everything the learner actually SEES this turn — intro line, main sentence,
    // the follow-up frame after a detour, and the goodbye tail.
    // Everything the learner SEES, in order. `followFrame` repeats `hanzi` on a detour
    // turn (kept in the payload for UI back-compat), so dedupe rather than counting it
    // twice and reporting a repetition the learner never sees.
    const visible = [...new Set([reply.intro?.hanzi, reply.hanzi, reply.followFrame?.hanzi, reply.outro?.hanzi]
      .filter(Boolean))].join('');
    const introduced = (reply.newWords || []).map(w => w.hanzi).filter(Boolean);
    // Every grounding strip this turn ships — what the interlinear can actually
    // render. A character the learner does not know is only fair if it is in here.
    const groundedTokens = [
      ...(reply.tokens || []), ...(reply.followFrame?.tokens || []),
      ...(reply.intro?.tokens || []), ...(reply.outro?.tokens || []),
      ...(reply.reground?.tokens || []),
      ...(reply.newWords || []).map(w => ({ hanzi: w.hanzi, pinyin: w.pinyin, gloss: w.gloss })),
    ];

    turns.push({
      i: i + 1, userText, wasConfusion, ms, error,
      plantedError, tonelessProbe, knownGood,
      reply: { ...reply, hanzi: visible, _main: reply.hanzi },
      introduced, groundedTokens,
      sessionNouns: [...new Set(turns.flatMap(t => t.introduced || []).concat(introduced))],
    });
    if (reply.hanzi) history.push({ role: 'assistant', content: reply.hanzi });

    if (reply.shouldWrap) break;
    if (i + 1 === CONFUSION_AT) { userText = CONFUSION; tag = ''; }
    else { const line = script[i % script.length] || script[0]; [userText, tag] = line; }
    history.push({ role: 'user', content: userText });
  }

  const reading = await readingSnapshot();

  const ctx = {
    level, rung, expectedRung: level.expectRung, turns, reading, knownHanzi,
    classify: (w) => { try { return vocabguard.nounCategory({ hanzi: w, gloss: '' }); } catch { return null; } },
  };
  const run = ([id, fn]) => { const r = fn(ctx); return { id, ...r }; };
  return {
    level: { ...level }, rung, firstRung, settleSessions,
    turnCount: turns.length,
    transcript: turns.map(t => ({ i: t.i, said: t.userText, teacher: t.reply.hanzi, beat: t.reply.beat, ms: t.ms, error: t.error })),
    reading: { profile: reading.profile, passages: reading.passages.length },
    probes: [...probes.CONVERSATION_PROBES, ...probes.READING_PROBES].map(run),
  };
}

// Reading-track snapshot: the profile, the graded passages, and a few tapped
// characters (the self-teaching moment) drawn from what the learner can actually see.
async function readingSnapshot() {
  const orth = await import('../server/orthography.js');
  const { passages } = await import('../server/reading.js');
  const profile = { ...orth.readingProfile(), highYield: orth.highYieldCharacters(6) };
  const ps = passages({});
  const known = orth.knownCharacters();
  // Tap the unmet characters the learner would actually meet in these passages.
  const taps = [...new Set(ps.flatMap(p => p.sentences.flatMap(s => s.unknown || [])))].slice(0, 8);
  const insights = taps.map(h => {
    const ins = orth.characterInsight(h, known);
    return { hanzi: h, predict: ins?.predict || null, knownPhonetic: ins?.series ? known.has(ins.series.phonetic) : false };
  });
  return { profile, passages: ps, insights };
}

// ── Reporting ───────────────────────────────────────────────────────────────
const MARK = { pass: '✅', fail: '❌', warn: '⚠️ ', skip: '·' };

function report(r) {
  console.log(`  rung ${r.rung} (first session would be ${r.firstRung}, settled after ${r.settleSessions}) · ${r.turnCount} turns · ${r.reading.passages} passages`);
  console.log('  transcript:');
  for (const t of r.transcript) {
    if (t.said) console.log(`    ${String(t.i).padStart(2)} learner  ${t.said}`);
    console.log(`    ${t.said ? '  ' : String(t.i).padStart(2)} 老师     ${t.teacher || '(nothing)'}${t.beat ? `  [${t.beat}]` : ''}${t.ms > 2000 ? `  ${t.ms}ms` : ''}${t.error ? `  ERROR ${t.error}` : ''}`);
  }
  console.log('  probes:');
  for (const p of r.probes) {
    const mark = p.skipped ? MARK.skip : p.ok ? MARK.pass : p.severity === 'fail' ? MARK.fail : MARK.warn;
    console.log(`    ${mark} ${p.id.padEnd(20)} ${p.detail}`);
    for (const e of (p.ok ? [] : p.evidence || []).slice(0, 4)) console.log(`         ↳ ${e}`);
  }
}

function summary(results) {
  console.log(`\n${'═'.repeat(72)}\nSUMMARY\n`);
  const ids = [...new Set(results.flatMap(r => r.probes.map(p => p.id)))];
  const head = 'probe'.padEnd(20) + results.map(r => `L${r.level.id}`.padStart(5)).join('');
  console.log('  ' + head);
  for (const id of ids) {
    const cells = results.map(r => {
      const p = r.probes.find(x => x.id === id);
      if (!p) return '    -';
      return (p.skipped ? MARK.skip : p.ok ? MARK.pass : p.severity === 'fail' ? MARK.fail : '⚠').padStart(5);
    });
    console.log('  ' + id.padEnd(20) + cells.join(''));
  }
  const fails = results.flatMap(r => r.probes.filter(p => !p.ok && p.severity === 'fail' && !p.skipped).map(p => `L${r.level.id} ${p.id}: ${p.detail}`));
  const warns = results.flatMap(r => r.probes.filter(p => !p.ok && p.severity === 'warn' && !p.skipped).map(p => `L${r.level.id} ${p.id}: ${p.detail}`));
  if (fails.length) { console.log('\n  ❌ failures'); for (const f of fails) console.log(`     ${f}`); }
  if (warns.length) { console.log('\n  ⚠️  warnings'); for (const w of warns) console.log(`     ${w}`); }
  if (!fails.length && !warns.length) console.log('\n  ✅ all probes clean across every level');
}

main().catch(e => { console.error(e); process.exit(1); });
