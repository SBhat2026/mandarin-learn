// Workstream E guard: automatic level detection. Producing rarer (higher-level)
// words unprompted raises the inferred productive band; sticking to only the most
// common words keeps it low. Also checks the receptive band + band-fit shaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-lvl-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db, setModel } = await import('../server/db.js');
const level = await import('../server/level.js');
initSchema();

// Seed a small vocabulary spanning common → rare (rank ascending = more common).
const WORDS = [
  ['我', 5, 1], ['你', 8, 1], ['好', 12, 1], ['吃', 60, 1], ['饭', 90, 1],
  ['环境', 1400, 5], ['保护', 1600, 5], ['经济', 1800, 5], ['社会', 1500, 5], ['政策', 2600, 6],
  ['天', 40, 1], ['水', 55, 1], ['大', 22, 1], ['小', 33, 1], ['人', 6, 1],
  ['学校', 300, 2], ['朋友', 320, 2], ['时间', 210, 2], ['问题', 260, 2], ['工作', 280, 2],
];
const ins = db().prepare('INSERT INTO words(hanzi,pinyin,english,freq_rank,hsk_level) VALUES(?,?,?,?,?)');
for (const [h, r, hsk] of WORDS) ins.run(h, '', '', r, hsk);

function transcriptFrom(words) {
  // Each learner turn uses the words; no teacher turn contains them → unprompted.
  return [
    { role: 'assistant', hanzi: '嗯。' },
    { role: 'user', hanzi: words.join('') },
    { role: 'assistant', hanzi: '很好。' },
    { role: 'user', hanzi: words.join('') },   // second unprompted use → passes the noise guard
  ];
}

test('rarer unprompted production yields a higher productive rank than common-only', () => {
  setModel('production_obs', {});
  level.observeProduction(transcriptFrom(['环境', '保护', '经济', '社会']));
  const advanced = level.inferProductiveLevel();
  assert.ok(advanced.confidence > 0, 'has signal');
  assert.ok(advanced.rank >= 1400, 'advanced band reflects rare words');

  setModel('production_obs', {});
  level.observeProduction(transcriptFrom(['我', '你', '好', '吃']));
  const basic = level.inferProductiveLevel();
  assert.ok(basic.rank <= 100, 'basic band stays low');
  assert.ok(advanced.rank > basic.rank, 'heavy rarer-word use raises the band');
});

test('a single lucky word does not move the band (noise guard)', () => {
  setModel('production_obs', {});
  level.observeProduction([{ role: 'user', hanzi: '政策' }]);   // used once only
  const p = level.inferProductiveLevel();
  assert.equal(p.confidence, 0, 'one unprompted use is not enough');
});

test('receptive band + newWordBand target sit beyond comprehension', () => {
  // Mark ~16 mid-band words known (FSRS review) so receptive inference is confident.
  const card = db().prepare(`INSERT INTO cards(item_type,item_id,card_type,state) VALUES('word',?,'memory',2)`);
  for (let id = 1; id <= 16; id++) card.run(id);   // 16 distinct known words
  const rec = level.inferReceptiveLevel();
  assert.ok(rec.confidence > 0.25, 'confident receptive estimate');
  const band = level.newWordBand();
  assert.ok(band && band.center > rec.rank * 0.9, 'new-word target stretches beyond current comprehension');
  // band-fit peaks near the center and falls off outside.
  assert.ok(level.bandFit(band.center, band) >= level.bandFit(band.max * 4, band));
});
