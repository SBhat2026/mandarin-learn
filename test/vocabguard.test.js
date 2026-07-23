// Ladder milestone 1 guard: the vocabulary guard. A frame-built beginner turn must
// be fully decodable (no out-of-set content word), produce aligned per-word tokens,
// and offer glossed scaffolded choices. Validation must catch a smuggled unknown word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-vg-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db } = await import('../server/db.js');
const vg = await import('../server/vocabguard.js');
initSchema();

// A few concrete nouns (with pinyin+gloss) + a rare word never introduced.
const WORDS = [
  ['猫', 'māo', 'cat', 900, 1, 2, 0, '["n"]'],
  ['狗', 'gǒu', 'dog', 950, 1, 2, 0, '["n"]'],
  ['鱼', 'yú', 'fish', 1200, 1, 2, 0, '["n"]'],
  ['水', 'shuǐ', 'water', 200, 1, 2, 0, '["n"]'],
  ['经济', 'jīngjì', 'economy', 1800, 5, 0, 0, '["n"]'],   // rare, abstract → never a beginner word
  ['的', 'de', '(particle)', 3, 1, 0, 1, '["u"]'],
];
const ins = db().prepare('INSERT INTO words(hanzi,pinyin,english,gloss,freq_rank,hsk_level,concrete,particle,pos) VALUES(?,?,?,?,?,?,?,?,?)');
for (const [h, p, e, r, hsk, con, par, pos] of WORDS) ins.run(h, p, e, e, r, hsk, con, par, pos);

const catTok = vg.vocabToken(db().prepare('SELECT id FROM words WHERE hanzi=?').get('猫').id);
const dogTok = vg.vocabToken(db().prepare('SELECT id FROM words WHERE hanzi=?').get('狗').id);

test('a frame-built beginner turn is fully decodable against its allowed set', () => {
  const sessionWords = [catTok, dogTok];
  const allowed = vg.allowedSet({ rung: 0, sessionWords });
  for (let i = 0; i < 8; i++) {
    const turn = vg.buildFrameTurn({ rung: 0, sessionWords, turnIndex: i });
    assert.ok(turn && turn.hanzi, 'a turn was built');
    const { ok, violations } = vg.validateTurn(turn.hanzi, allowed);
    assert.ok(ok, `turn "${turn.hanzi}" had out-of-set words: ${violations.join(',')}`);
    assert.ok(turn.english && /cat|dog/i.test(turn.english), 'natural english present');
    assert.ok(turn.tokens.length >= 3, 'aligned tokens present');
    // Every token carries its own pinyin+gloss (interlinear alignment is per-word).
    const noun = turn.tokens.find(t => t.hanzi === '猫' || t.hanzi === '狗');
    assert.ok(noun && noun.pinyin && noun.gloss, 'the noun token is self-glossed');
  }
});

test('validation flags a smuggled out-of-set content word', () => {
  const allowed = vg.allowedSet({ rung: 0, sessionWords: [catTok] });
  const good = vg.validateTurn('这是猫吗？', allowed);
  assert.ok(good.ok, 'in-set sentence passes');
  const bad = vg.validateTurn('这是经济。', allowed);   // 经济 never introduced
  assert.ok(!bad.ok && bad.violations.includes('经济'), 'unknown content word caught');
});

test('groundTokens aligns each word with its own pinyin + gloss', () => {
  const toks = vg.groundTokens('我有猫', { newSet: new Set(['猫']) });
  const cat = toks.find(t => t.hanzi === '猫');
  assert.equal(cat.pinyin, 'māo');
  assert.match(cat.gloss, /cat/);
  assert.equal(cat.isNew, true, 'session-new word is flagged for highlight');
  assert.equal(toks.find(t => t.hanzi === '我').isNew, false);
});

test('scaffolded choices are offered and glossed', () => {
  const turn = vg.buildFrameTurn({ rung: 0, sessionWords: [catTok, dogTok], turnIndex: 1 });
  assert.ok(turn.choices.length >= 2, 'at least two ready replies');
  for (const c of turn.choices) assert.ok(c.hanzi && c.gloss, 'each choice is glossed');
});

test('rung-0 word selection excludes particles and long/abstract words', () => {
  const picks = vg.beginnerNewWords(5, { introduced: new Set() });
  const hanzi = picks.map(p => p.hanzi);
  assert.ok(!hanzi.includes('的'), 'no bare particle');
  assert.ok(!hanzi.includes('经济'), 'no rare abstract word');
  assert.ok(hanzi.includes('猫') || hanzi.includes('水') || hanzi.includes('鱼'), 'concrete nouns surface');
});
