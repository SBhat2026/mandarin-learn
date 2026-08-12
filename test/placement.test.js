// The entrance exam: it must be skippable without penalty, must stop as soon as it
// has found the ceiling, must never leak the answer key to the client, and must
// actually MOVE the starting position — otherwise it is a quiz, not a placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-placement-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db, getModel } = await import('../server/db.js');
const P = await import('../server/placement.js');
initSchema();

const WORDS = [
  ['人', 'rén', 'person', 1], ['猫', 'māo', 'cat', 1], ['水', 'shuǐ', 'water', 1],
  ['书', 'shū', 'book', 1], ['车', 'chē', 'car', 1], ['狗', 'gǒu', 'dog', 1],
  ['做', 'zuò', 'do', 2], ['茶', 'chá', 'tea', 2], ['树', 'shù', 'tree', 2],
  ['鱼', 'yú', 'fish', 2], ['花', 'huā', 'flower', 2], ['门', 'mén', 'door', 2],
  ['马', 'mǎ', 'horse', 3], ['鸟', 'niǎo', 'bird', 3], ['山', 'shān', 'mountain', 3],
];
const ins = db().prepare('INSERT INTO words(hanzi,pinyin,english,gloss,freq_rank,hsk_level,concrete,pos) VALUES(?,?,?,?,?,?,?,?)');
WORDS.forEach(([h, p, e, hsk], i) => ins.run(h, p, e, e, 100 + i * 20, hsk, 2, '["n"]'));

const currentProbe = () => {
  const run = getModel('placement_run', null);
  return run?.probes?.[run.index] ?? null;
};

test('skipping is a real outcome: it places you at the beginning and never asks again', () => {
  P.clearPlacement();
  assert.equal(P.placementState().taken, false);
  const r = P.skipPlacement();
  assert.equal(r.result.source, 'skipped');
  assert.equal(r.result.rung, 0, 'skipping starts at the guided rung');
  assert.equal(P.placementState().taken, true, 'and the offer does not come back');
});

test('the exam never sends the answer key to the client', () => {
  P.clearPlacement();
  const { probe } = P.startPlacement();
  assert.ok(probe, 'a first probe exists');
  assert.equal('answer' in probe, false, 'the correct answer is not serialized');
  assert.equal('minWords' in probe, false, 'nor the production threshold');
  assert.ok(probe.options?.length >= 2 || probe.kind === 'produce');
});

test('two consecutive misses ends it — nobody is marched through questions they cannot read', () => {
  P.clearPlacement();
  P.startPlacement();
  const first = P.answerPlacement({ answer: 'definitely wrong' });
  assert.equal(first.done, false, 'one miss is not a verdict');
  const second = P.answerPlacement({ answer: 'also wrong' });
  assert.equal(second.done, true, 'two in a row is');
  assert.equal(second.result.rung, 0);
});

test('answering correctly moves the starting position up the ladder', () => {
  P.clearPlacement();
  P.startPlacement();
  let res = null, guard = 0;
  while (guard++ < 12) {
    const probe = currentProbe();
    if (!probe) break;
    const answer = probe.kind === 'produce' ? '我今天在家喝茶，也看了一本书。' : probe.answer;
    res = P.answerPlacement({ answer });
    if (res.done) break;
  }
  assert.ok(res?.done, 'the exam finishes');
  assert.ok(res.result.reached >= 3, `a learner who answers everything places above the floor (got ${res.result.reached})`);
  assert.ok(res.result.rung >= 1, 'and starts past the fully-scaffolded rung');
  assert.equal(getModel('rung_state', null)?.rung, res.result.rung, 'the rung machine agrees with the exam');
});

test('probes are content words, not bare function words', () => {
  P.clearPlacement();
  P.startPlacement();
  let guard = 0;
  while (guard++ < 8) {
    const probe = currentProbe();
    if (!probe) break;
    if (probe.kind === 'recognize') {
      assert.ok(!['是', '的', '了', '吗', '我', '你'].includes(probe.ask.hanzi),
        `${probe.ask.hanzi} is a function word — glossing it in isolation measures nothing`);
    }
    P.answerPlacement({ answer: probe.answer ?? 'x' });
  }
});
