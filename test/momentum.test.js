// Milestone 6 guard: momentum, metrics, and completion conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-mom-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');

const { computeMomentum, computeMetrics, liveCompletion } = await import('../server/momentum.js');

const U = (h) => ({ role: 'user', hanzi: h });
const A = (h, note) => ({ role: 'assistant', hanzi: h, note });

test('momentum stays high when the learner leans in, drops when they trail off', () => {
  const engaged = [U('你好'), A('你好吗'), U('我很好，今天去公园了'), A('真好'), U('我看到很多花，很漂亮，我很喜欢')];
  const fading = [U('我今天去公园了，看到很多花'), A('真好'), U('对'), A('还有呢'), U('嗯')];
  assert.ok(computeMomentum(engaged) > computeMomentum(fading), 'engaged transcript has higher momentum');
  assert.ok(computeMomentum(fading) < 0.6, 'one-word trailing replies drain momentum');
});

test('computeMetrics counts questions, spontaneous vocab, length, corrections', () => {
  const plan = { targetVocab: [{ wordId: 1, hanzi: '喜欢' }, { wordId: 2, hanzi: '公园' }] };
  const transcript = [
    A('你好'),
    U('我喜欢公园，你呢？'),        // uses 喜欢 + 公园 spontaneously (teacher hadn't said them), asks a question
    A('我也喜欢', '「你呢」用得好'), // a correction note
  ];
  const m = computeMetrics(transcript, plan);
  assert.equal(m.learner_initiated_questions, 1);
  assert.ok(m.spontaneous_vocab >= 1, 'spontaneous target-word use counted');
  assert.equal(m.corrections, 1);
  assert.ok(m.avg_learner_len > 0);
});

test('liveCompletion wraps at the budget ceiling', () => {
  const bp = { budget: { exchanges: [3, 5] } };
  const short = Array.from({ length: 2 }, (_, i) => U('这是一句比较长的话' + i));
  const long = Array.from({ length: 5 }, (_, i) => U('这是一句比较长的话' + i));
  assert.equal(liveCompletion(short, bp, {}).shouldWrap, false, 'not yet at ceiling');
  const done = liveCompletion(long, bp, {});
  assert.equal(done.shouldWrap, true);
  assert.equal(done.reason, 'budget');
});

test('liveCompletion wraps on momentum decay after minimum effort', () => {
  const bp = { budget: { exchanges: [3, 10] } };
  const transcript = [U('我今天去了公园，看到很多美丽的花'), A('真好'), U('对'), A('还有'), U('嗯'), A('然后呢'), U('没')];
  const c = liveCompletion(transcript, bp, {});
  assert.equal(c.shouldWrap, true);
  assert.equal(c.reason, 'momentum');
});
