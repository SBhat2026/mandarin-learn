// The orthographic engine — what makes reading Chinese cheaper than 3,000 unrelated
// pictures. These tests pin the two claims the Reading track leans on: that phonetic
// series are judged by MEASURED consistency (not by trusting the decomposition), and
// that a prediction is only offered when the learner has something to reason from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-orth-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db } = await import('../server/db.js');
const orth = await import('../server/orthography.js');
initSchema();

// 方-series: perfectly consistent (all fāng-ish). 一 is a structural component whose
// "series" agrees on nothing — the case that makes nominal phonetics untrustworthy.
const CHARS = [
  // hanzi, reading, radical/semantic, phonetic
  ['方', 'fāng', '方', null],
  ['房', 'fáng', '户', '方'],
  ['放', 'fàng', '攵', '方'],
  ['访', 'fǎng', '讠', '方'],
  ['纺', 'fǎng', '纟', '方'],
  ['河', 'hé', '氵', '可'],
  ['海', 'hǎi', '氵', '每'],
  ['湖', 'hú', '氵', '胡'],
  // A fake series keyed on 一 whose members disagree completely.
  ['三', 'sān', '一', '一'],
  ['七', 'qī', '一', '一'],
  ['下', 'xià', '一', '一'],
];
const insChar = db().prepare('INSERT INTO char_meta(hanzi,pinyin,radical,semantic,phonetic,definition) VALUES(?,?,?,?,?,?)');
for (const [h, r, rad, ph] of CHARS) insChar.run(h, JSON.stringify([r]), rad, rad, ph, h + ' gloss');

// Series only count over characters that appear in the learner's word list.
const insWord = db().prepare('INSERT INTO words(hanzi,pinyin,english,gloss,freq_rank) VALUES(?,?,?,?,?)');
for (const [h, r] of CHARS) insWord.run(h, r, h + ' gloss', h + ' gloss', 100 + CHARS.findIndex(c => c[0] === h));
orth.resetSeriesCache();

// "Met" = has a card. The learner knows the 方 key and two of its family.
const insCard = db().prepare(`INSERT INTO cards(item_type,item_id,card_type,state) VALUES('word',?,'memory',2)`);
for (const h of ['方', '房', '放', '河', '海']) {
  const w = db().prepare('SELECT id FROM words WHERE hanzi=?').get(h);
  if (w) insCard.run(w.id);
}

test('consistency is measured, not assumed — a series that agrees is teachable, one that does not is not', () => {
  const series = orth.phoneticSeries();
  const fang = series.get('方');
  assert.ok(fang, '方 forms a series');
  assert.equal(fang.dominant, 'fang');
  assert.equal(fang.consistency, 1, 'every member agrees');

  const yi = series.get('一');
  assert.ok(yi, '一 nominally keys a series');
  assert.ok(yi.consistency < 0.6, 'but its members agree on nothing');

  const teachable = orth.teachableSeries().map(s => s.phonetic);
  assert.ok(teachable.includes('方'));
  assert.ok(!teachable.includes('一'), 'an inconsistent series would teach a false rule');
  assert.equal(orth.seriesFor('三'), null, 'so no character reasons from it');
});

test('a reading is only predicted when the learner has evidence to predict FROM', () => {
  assert.equal(orth.predictReading('访', new Set()), null, 'nothing met → nothing to reason from');

  const p = orth.predictReading('访', new Set(['方', '房', '放']));
  assert.ok(p, 'met the family → a guess is available');
  assert.equal(p.predicted, 'fang');
  assert.equal(p.holds, true, 'and the guess is right here');
  assert.ok(p.evidence.length >= 2, 'the guess is justified by characters actually met');
  assert.ok(!p.evidence.some(e => e.hanzi === '访'), 'never uses the target as its own evidence');
});

test('the semantic radical narrows meaning, and only for radicals with a real sense', () => {
  const hint = orth.semanticHint('河');
  assert.deepEqual(hint, { radical: '氵', sense: 'water, liquid' });
  assert.equal(orth.semanticHint('方'), null, 'a character that is its own radical hints nothing');

  const family = orth.semanticFamily('氵', new Set(['海', '湖']));
  assert.deepEqual(family.map(f => f.hanzi).sort(), ['海', '湖']);
  assert.equal(orth.semanticFamily('氵', new Set()).length, 0, 'family shows only what was met');
});

test('coverage bands follow the comprehension thresholds, not a syllabus position', () => {
  const known = new Set(['方', '房', '放', '访', '纺', '河', '海', '湖', '三', '七']);
  assert.equal(orth.charCoverage('方房放', known).coverage, 1);
  assert.deepEqual(orth.charCoverage('方下', known).unknown, ['下']);
  assert.equal(orth.readabilityBand(0.99), 'comfortable');
  assert.equal(orth.readabilityBand(0.96), 'readable');
  assert.equal(orth.readabilityBand(0.92), 'effortful');
  assert.equal(orth.readabilityBand(0.5), 'too-hard');
  assert.equal(orth.charCoverage('hello!', known).total, 0, 'non-CJK text is not scored');
});

test('the character insight asks the sound question before answering it', () => {
  const known = new Set(['方', '房', '放']);
  const ins = orth.characterInsight('访问', known);
  assert.equal(ins.hanzi, '访', 'reads the first character of the tapped context');
  assert.ok(ins.predict, 'a prediction is offered');
  assert.ok(ins.series.members.every(m => m.hanzi !== '访'), 'the family excludes the character itself');
  assert.equal(ins.semantic.radical, '讠');

  const cold = orth.characterInsight('三', new Set());
  assert.equal(cold.predict, null);
  assert.equal(cold.series, null, 'an untrustworthy series is never shown as a rule');
});

test('high-yield characters rank by what they unlock, not by frequency alone', () => {
  const hy = orth.highYieldCharacters(5);
  assert.ok(!hy.some(h => h.hanzi === '一'), 'an inconsistent key unlocks nothing');
  assert.ok(!hy.some(h => h.hanzi === '方'), 'a key already met is not proposed again');

  // A word carrying an unowned, consistent KEY is worth more than an isolated one:
  // learning 方 makes 访/纺 guessable, learning 下 makes nothing guessable.
  const carriesKey = orth.orthographicYield('方', new Set(['房', '放']));
  const isolated = orth.orthographicYield('下', new Set(['房', '放']));
  assert.ok(carriesKey > isolated, 'the key pays more than an isolated character');
  assert.equal(isolated, 0, 'a character keying nothing pays nothing');
  assert.equal(orth.orthographicYield('方', new Set(['方'])), 0, 'a key already held pays nothing again');
});

test('toneless folding keeps the useful inference and does not shatter series on tone', () => {
  assert.equal(orth.toneless('fáng'), 'fang');
  assert.equal(orth.toneless('fàng'), 'fang');
  assert.equal(orth.toneless('lǜ'), 'lu');
});
