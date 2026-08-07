// The pinyin IME is the primary INPUT path for a typing-first learner, so its
// conversion quality is load-bearing. These cases pin behaviors that were each a
// real bug: span-level fuzzy rescue, compound-over-singles preference, and
// sentence-final mood particles (which must NOT leak to ordinary function words).
//
// Seeded with a purpose-built vocabulary rather than the shared fixture: IME
// ranking is a function of what's IN the dictionary, so the words under test and
// their competing homophones both have to be present for the assertions to mean
// anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-ime-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { db, initSchema } = await import('../server/db.js');
const { convertPinyin } = await import('../server/pinyinime.js');

// The syllable inventory is derived from the dictionary itself, and DB pinyin for
// compounds is unspaced ("gōngyuán"), so a realistic fixture must also contain the
// single characters those compounds decompose into — exactly as the real one does.
// [hanzi, pinyin, freq_rank, register, particle]
const CHARS = [
  ['公', 'gōng', 700, 'both', 0], ['园', 'yuán', 1900, 'both', 0], ['学', 'xué', 300, 'both', 0],
  ['生', 'shēng', 260, 'both', 0], ['哪', 'nǎ', 500, 'spoken', 1], ['里', 'lǐ', 200, 'both', 0],
  ['姐', 'jiě', 1400, 'spoken', 0], ['气', 'qì', 600, 'both', 0], ['朋', 'péng', 2100, 'both', 0],
  ['友', 'yǒu', 900, 'both', 0], ['喜', 'xǐ', 1100, 'both', 0], ['欢', 'huan', 1000, 'both', 0],
  ['今', 'jīn', 800, 'both', 0], ['什', 'shén', 950, 'both', 1], ['么', 'me', 46, 'spoken', 1],
  ['们', 'men', 80, 'both', 1], ['果', 'guǒ', 1600, 'both', 0], ['平', 'píng', 850, 'both', 0],
  ['狗', 'gǒu', 1700, 'both', 0], ['问', 'wèn', 400, 'both', 0],
];

const WORDS = [
  ['我', 'wǒ', 3, 'both', 1], ['你', 'nǐ', 5, 'both', 1], ['他', 'tā', 10, 'both', 1],
  ['她', 'tā', 60, 'both', 1], ['是', 'shì', 4, 'both', 1], ['有', 'yǒu', 9, 'both', 1],
  ['好', 'hǎo', 20, 'both', 1], ['这', 'zhè', 11, 'both', 1], ['个', 'ge', 19, 'both', 1],
  ['一', 'yī', 21, 'both', 0], ['很', 'hěn', 120, 'both', 1], ['了', 'le', 3, 'both', 1],
  ['吗', 'ma', 90, 'spoken', 1], ['吧', 'ba', 300, 'spoken', 1], ['呢', 'ne', 310, 'spoken', 1],
  ['马', 'mǎ', 1200, 'both', 0], ['码', 'mǎ', 2600, 'written', 0],
  ['什么', 'shénme', 45, 'spoken', 1], ['我们', 'wǒmen', 19, 'both', 1],
  ['苹果', 'píngguǒ', 2562, 'both', 0], ['瓶', 'píng', 1373, 'spoken', 0], ['够', 'gòu', 1173, 'both', 1],
  ['喜欢', 'xǐhuan', 400, 'spoken', 0], ['猫', 'māo', 1800, 'both', 0],
  ['朋友', 'péngyou', 280, 'spoken', 0], ['今天', 'jīntiān', 155, 'spoken', 0],
  ['天气', 'tiānqì', 900, 'spoken', 0], ['进', 'jìn', 400, 'both', 0], ['天', 'tiān', 250, 'both', 0],
  ['两', 'liǎng', 350, 'both', 0], ['姐姐', 'jiějie', 1500, 'spoken', 0],
  ['吃', 'chī', 700, 'spoken', 0], ['饭', 'fàn', 800, 'spoken', 0],
  ['去', 'qù', 100, 'both', 0], ['公园', 'gōngyuán', 2000, 'both', 0],
  ['学生', 'xuésheng', 500, 'both', 0], ['哪里', 'nǎlǐ', 600, 'spoken', 0],
];

initSchema();
const ins = db().prepare(`INSERT OR IGNORE INTO words(hanzi, pinyin, freq_rank, register, particle, gloss)
  VALUES(?,?,?,?,?,?)`);
for (const [hanzi, pinyin, freq, register, particle] of [...CHARS, ...WORDS]) {
  ins.run(hanzi, pinyin, freq, register, particle, hanzi);
}

test('converts clean multi-syllable pinyin', () => {
  assert.equal(convertPinyin('ni hao ma').hanzi, '你好吗');
  assert.equal(convertPinyin('zhe shi shenme').hanzi, '这是什么');
});

test('unspaced input still segments', () => {
  assert.equal(convertPinyin('nihao').hanzi, '你好');
  assert.equal(convertPinyin('woxihuanmao').hanzi, '我喜欢猫');
});

test('prefers a one-typo compound over two unrelated single chars', () => {
  // "pinggou" is two LEGAL syllables (ping+gou), so syllable-level autocorrect
  // never fires — only the span-level edit-distance rescue reaches 苹果. It must
  // also outrank the exact-but-nonsense 瓶+够.
  assert.equal(convertPinyin('wo you yi ge pinggou').hanzi, '我有一个苹果');
  assert.equal(convertPinyin('wo you yi ge pingguo').hanzi, '我有一个苹果');
});

test('a real compound beats two high-frequency single chars', () => {
  // 今天 (jintian) must win over 进+天, which are individually more frequent.
  assert.equal(convertPinyin('jintian tianqi hen hao').hanzi, '今天天气很好');
});

test('sentence-final mood particle wins over its homophones', () => {
  // 吗 not 马/码 — but the bonus must NOT leak to ordinary function words, which
  // is what made a trailing 够 beat the 苹果 compound.
  assert.equal(convertPinyin('ni hao ma').hanzi, '你好吗');
  assert.equal(convertPinyin('women qu gongyuan ba').hanzi, '我们去公园吧');
});

test('English passes through untouched', () => {
  assert.equal(convertPinyin('how do i say tired').ok, false);
  assert.equal(convertPinyin('thanks').ok, false);
});

test('offers homophone alternatives rather than guessing silently', () => {
  // 他/她 are genuinely ambiguous for "tā"; the alternative must be reachable.
  const r = convertPinyin('ta hen hao');
  assert.ok(r.ok);
  const first = r.words[0];
  assert.ok([first.hanzi, ...first.alts].includes('她'), 'she should be offered as an alternative');
});
