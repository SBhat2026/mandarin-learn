// Correction replaced tap-to-answer choices, so it carries the weight those chips
// used to: it is the only thing standing between "the learner produces" and "the
// learner practises their own errors". Two properties matter most — that strictness
// actually rises with level, and that the app never corrects something that was right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-corr-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db } = await import('../server/db.js');
const c = await import('../server/correction.js');
initSchema();

const WORDS = [
  ['猫', 'māo', 'cat'], ['狗', 'gǒu', 'dog'], ['书', 'shū', 'book'], ['水', 'shuǐ', 'water'],
  ['人', 'rén', 'person'], ['我', 'wǒ', 'I'], ['这', 'zhè', 'this'], ['是', 'shì', 'to be'],
  ['有', 'yǒu', 'to have'], ['好', 'hǎo', 'good'],
];
const ins = db().prepare('INSERT INTO words(hanzi,pinyin,english,gloss,freq_rank,pos) VALUES(?,?,?,?,?,?)');
for (const [h, p, e] of WORDS) ins.run(h, p, e, e, 100, '["n"]');
const KNOWN = new Set(WORDS.map(w => w[0]));

const ev = (text, t, opts = {}) => c.evaluateProduction({ text, t, rung: t < 0.15 ? 0 : 2, knownHanzi: KNOWN, ...opts });
const kinds = (r) => r.issues.map(i => i.kind);

test('strictness rises with level — the same answer is fine, then noted, then corrected', () => {
  assert.equal(c.strictness(0.05, 0).band, 'gentle');
  assert.equal(c.strictness(0.3, 2).band, 'shaping');
  assert.equal(c.strictness(0.5, 2).band, 'firm');
  assert.equal(c.strictness(0.9, 2).band, 'exacting');
  // The guided rung is gentle whatever the measured level says — someone on frames is
  // being scaffolded, and scaffolding plus strictness is just discouragement.
  assert.equal(c.strictness(0.9, 0).band, 'gentle');

  // Toneless pinyin: a real attempt from a beginner, avoidance from an advanced learner.
  assert.equal(ev('mao', 0.05).accepted, true, 'a beginner is not told off for typing mao');
  assert.ok(!kinds(ev('mao', 0.05)).length, 'and nothing is even flagged');

  assert.ok(kinds(ev('mao', 0.3)).includes('tone-missing'), 'tones start being noted');
  assert.equal(ev('mao', 0.3).accepted, true, 'but the turn still counts — it is a nudge');

  assert.equal(ev('mao', 0.9).accepted, false, 'at the top it is a real correction');
  assert.ok(kinds(ev('mao', 0.9)).includes('script'), 'and characters are now expected');
});

test('pinyin-vs-hanzi strictness only applies to words the learner actually knows', () => {
  const known = ev('mao', 0.9);
  assert.ok(kinds(known).includes('script'), '猫 is known, so write it');

  // A word they have never met is not held to the characters standard — that is a
  // wall, not rigour.
  const unknown = c.evaluateProduction({ text: 'mao', t: 0.9, rung: 2, knownHanzi: new Set() });
  assert.ok(!kinds(unknown).includes('script'), 'nothing known in the answer → no script demand');
});

test('a different tone is a different WORD unless we know what they were reaching for', () => {
  // máo is 毛. Telling someone who wrote 毛 that they meant 猫 is the app being
  // confidently wrong, which is worse than staying quiet.
  assert.ok(!kinds(ev('máo', 0.9)).includes('tone-wrong'), 'no target → no tone claim');

  // With the invited sentence known, the tone IS markable.
  const withTarget = ev('zhè shì máo', 0.9, { expected: '这是猫。' });
  assert.ok(kinds(withTarget).includes('tone-wrong'), 'against a target, a wrong tone is a wrong tone');
  const rc = c.recastLine(withTarget);
  assert.equal(rc.contrast.from, 'máo');
  assert.equal(rc.contrast.to, 'māo');
});

test('correct input is never "corrected"', () => {
  for (const good of ['这是猫。', '我有书。', '我很好。']) {
    const r = ev(good, 0.9);
    assert.equal(r.accepted, true, `${good} passes untouched`);
    assert.equal(c.recastLine(r), null, `${good} produces no recast`);
  }
  // Correct toned pinyin at a level where pinyin is still allowed.
  assert.equal(ev('zhè shì māo', 0.5, { expected: '这是猫。' }).issues.filter(i => !i.soft).length, 0);
});

test('the grammar checks catch the errors English speakers actually make', () => {
  const shi = ev('我是好', 0.5);
  assert.ok(kinds(shi).includes('shi-adjective'));
  assert.equal(c.recastLine(shi).contrast.to, '很好');

  const measure = ev('我有一个猫', 0.5);
  assert.ok(kinds(measure).includes('measure-word'));
  assert.equal(c.recastLine(measure).contrast.to, '一只猫');

  assert.ok(kinds(ev('二个人', 0.5)).includes('er-liang'));
  // 一个人 is correct — 个 IS the measure word for people.
  assert.ok(!kinds(ev('我有一个人', 0.5)).includes('measure-word'));
  // Grammar is not policed at the gentle band; a beginner needs to keep talking.
  assert.ok(!kinds(ev('我是好', 0.05)).includes('shi-adjective'));
});

test('an English question is an aside, not a failed sentence', () => {
  const r = ev('How do I say cat?', 0.5);
  assert.equal(r.aside, true);
  assert.equal(r.issues.length, 0, 'never corrected for asking a question');
});

test('the executor directive names the specific error instead of "correct naturally"', () => {
  const d = c.recastDirective(ev('我有一个猫', 0.5));
  assert.match(d, /一只猫/, 'contains the fix');
  assert.match(d, /do NOT/i, 'and forbids grading them for it');
  assert.equal(c.recastDirective(ev('这是猫。', 0.9)), '', 'nothing to say about a correct sentence');
});
