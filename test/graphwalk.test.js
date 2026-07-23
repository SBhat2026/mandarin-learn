// Vocab-graph conversation continuity: from the words in play, the walk finds naturally
// adjacent concepts (co-occurrence / collocation / topic / shared char), preferring
// comprehensible reuse, and yields a hidden steer toward a related word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-gw-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db } = await import('../server/db.js');
const gw = await import('../server/graphwalk.js');
initSchema();

const WORDS = [['猫', 'cat'], ['狗', 'dog'], ['鱼', 'fish'], ['鸟', 'bird'], ['水', 'water']];
const ins = db().prepare('INSERT INTO words(hanzi,pinyin,english,gloss,freq_rank,pos) VALUES(?,?,?,?,?,?)');
WORDS.forEach(([h, e], i) => ins.run(h, '', e, e, 300 + i * 10, '["n"]'));
const id = (h) => db().prepare('SELECT id FROM words WHERE hanzi=?').get(h).id;

const edge = db().prepare('INSERT INTO graph_edges(src_type,src,rel,dst_type,dst,weight) VALUES(?,?,?,?,?,1.0)');
// 猫 co-occurs with 狗; collocates with 鱼; all three share the 'animals' topic.
edge.run('word', String(id('猫')), 'sentence_dep', 'word', String(id('狗')));
edge.run('word', String(id('猫')), 'collocation', 'word', String(id('鱼')));
for (const h of ['猫', '狗', '鱼', '鸟']) edge.run('word', String(id(h)), 'topic', 'topic', 'animals');

test('graphNeighbors surfaces co-occurring / collocated / same-topic words', () => {
  const nb = gw.graphNeighbors(id('猫'), { limit: 10 }).map(n => n.wordId);
  assert.ok(nb.includes(id('狗')), 'co-occurring 狗 is a neighbour');
  assert.ok(nb.includes(id('鱼')), 'collocated 鱼 is a neighbour');
  assert.ok(nb.includes(id('鸟')), 'same-topic 鸟 is a neighbour');
});

test('nextConcepts prefers comprehensible reuse and offers reachable growth', () => {
  const known = new Set([id('狗')]);          // 狗 already known → reuse
  const { reuse, grow } = gw.nextConcepts([id('猫')], { known, introduced: new Set(), limit: 5 });
  assert.ok(reuse.some(r => r.wordId === id('狗')), '狗 offered as reuse');
  assert.ok(grow.some(g => g.wordId === id('鱼') || g.wordId === id('鸟')), 'a fresh related word offered as growth');
  assert.ok(!reuse.concat(grow).some(x => x.wordId === id('猫')), 'the in-play word itself is excluded');
});

test('graphSteer yields a hidden, natural drift toward a related word', () => {
  const steer = gw.graphSteer([id('猫')], { known: new Set([id('狗')]), introduced: new Set() });
  assert.match(steer, /狗|鱼|鸟/, 'names a related word');
  assert.match(steer, /if|only if|never force/i, 'stays a soft, optional steer');
});
