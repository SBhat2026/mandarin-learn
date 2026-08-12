// Ladder acceptance (§11): a fresh zero-progress user gets a fully-scaffolded guided
// conversation — new words introduced before use, every teacher word grounded with its
// own pinyin+gloss, zero out-of-set content words across many turns, never stranded on
// confusion, and rungs that flip with measured level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-ladder-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');
process.env.ANTHROPIC_API_KEY = '';   // force offline Director (no fabricated context)

const { initSchema, db } = await import('../server/db.js');
const { startConversation, conversationTurn } = await import('../server/converse.js');
const { setRungOverride } = await import('../server/rung.js');
const { allowedSet, validateTurn } = await import('../server/vocabguard.js');
const { rungKnobs } = await import('../server/rung.js');
initSchema();

// A realistic pool of concrete, picturable nouns (emoji anchors exist) so the planner
// never runs dry — mirrors a real learner DB, not a 6-word toy.
const WORDS = [
  ['猫', 'māo', 'cat'], ['狗', 'gǒu', 'dog'], ['鱼', 'yú', 'fish'], ['水', 'shuǐ', 'water'],
  ['鸟', 'niǎo', 'bird'], ['花', 'huā', 'flower'], ['马', 'mǎ', 'horse'], ['猪', 'zhū', 'pig'],
  ['牛', 'niú', 'cow'], ['羊', 'yáng', 'sheep'], ['鸡', 'jī', 'chicken'], ['兔', 'tù', 'rabbit'],
  ['米', 'mǐ', 'rice'], ['面', 'miàn', 'noodle'], ['蛋', 'dàn', 'egg'], ['肉', 'ròu', 'meat'],
  ['茶', 'chá', 'tea'], ['奶', 'nǎi', 'milk'], ['树', 'shù', 'tree'], ['山', 'shān', 'mountain'],
  ['车', 'chē', 'car'], ['船', 'chuán', 'boat'], ['家', 'jiā', 'home'], ['门', 'mén', 'door'],
  ['书', 'shū', 'book'], ['钱', 'qián', 'money'], ['鞋', 'xié', 'shoe'], ['包', 'bāo', 'bag'],
  ['手', 'shǒu', 'hand'], ['眼', 'yǎn', 'eye'], ['球', 'qiú', 'ball'], ['火', 'huǒ', 'fire'],
];
const ins = db().prepare('INSERT INTO words(hanzi,pinyin,english,gloss,freq_rank,hsk_level,concrete,pos) VALUES(?,?,?,?,?,?,?,?)');
WORDS.forEach(([h, p, e], i) => ins.run(h, p, e, e, 200 + i * 30, 1, 2, '["n"]'));

test('a fresh zero-user opening meets its words and grounds every token', async () => {
  setRungOverride(0);
  const s = await startConversation();
  assert.equal(s.rung, 0, 'fresh user starts on the guided rung');
  assert.equal(s.guided, true);
  const opening = await conversationTurn({ id: s.sessionId, userText: '' });
  assert.ok(opening.newWords?.length >= 2, 'meet-the-words beat is present before use');
  for (const w of opening.newWords) assert.ok(w.hanzi && w.pinyin && w.gloss, 'each new word is glossed with audio-ready pinyin');
  // Every token in the teacher sentence carries its own pinyin + gloss (interlinear).
  for (const t of opening.tokens) assert.ok(t.pinyin || /[。，？！、]/.test(t.hanzi), `token ${t.hanzi} has pinyin`);
  // A reader can point to the word that means "cat": it exists as its own token/newWord.
  const catMeet = opening.newWords.find(w => /cat|dog|fish|water|bird|flower/i.test(w.gloss));
  assert.ok(catMeet, 'a concrete meaning is pointable to a single word');
  assert.ok(opening.choices.length >= 2, 'scaffolded choices are offered');
});

test('across 20 guided turns, no un-glossed out-of-set content word reaches the UI', async () => {
  setRungOverride(0);
  let s = await startConversation();
  let met = [];
  let allowed = null;
  // The invariant is MET-BEFORE-USED, not a fixed word list: a session opens with two
  // words and grows a third mid-arc, and a grown word arrives with its own glossed
  // meet-the-words chip on the very turn it is first used. So the allowed set grows
  // with whatever the turn just introduced.
  const check = (turn) => {
    met = [...met, ...(turn.newWords || [])];
    allowed = allowedSet({ rung: 0, sessionWords: met });
    // (a) every FRAME-generated sentence is validated against the allowed set;
    const frames = [turn.frameId ? turn.hanzi : null, turn.followFrame?.hanzi].filter(Boolean);
    for (const h of frames) {
      const { ok, violations } = validateTurn(h, allowed);
      assert.ok(ok, `out-of-set word in generated "${h}": ${violations.join(',')}`);
    }
    // (b) every teacher token that reaches the UI carries pinyin/gloss (nothing un-glossed).
    for (const t of (turn.tokens || [])) assert.ok(t.pinyin || t.gloss || /[。，？！、]/.test(t.hanzi), `un-glossed token ${t.hanzi}`);
  };
  const restart = async () => { s = await startConversation(); met = []; check(await conversationTurn({ id: s.sessionId, userText: '' })); };
  check(await conversationTurn({ id: s.sessionId, userText: '' }));
  let count = 1;
  while (count < 20) {
    const t = await conversationTurn({ id: s.sessionId, userText: '我有猫。' });
    check(t);
    count++;
    if (t.shouldWrap) { await restart(); count++; }
  }
});

test('a guided session follows an arc: it grows a new word and then actually ends', async () => {
  setRungOverride(0);
  const s = await startConversation();
  const beats = [], subjects = new Set();
  let turn = await conversationTurn({ id: s.sessionId, userText: '' });
  for (let i = 0; i < 12 && !turn.shouldWrap; i++) {
    beats.push(turn.beat);
    for (const w of (turn.newWords || [])) subjects.add(w.hanzi);
    turn = await conversationTurn({ id: s.sessionId, userText: '我有猫。' });
  }
  beats.push(turn.beat);
  assert.ok(turn.shouldWrap, 'the arc ends on its own — no infinite frame carousel');
  assert.equal(turn.beat, 'farewell', 'and it ends on the farewell beat');
  assert.ok(subjects.size >= 3, `the conversation travels: met ${subjects.size} words, expected 3+`);
  assert.ok(beats.includes('grow'), 'a new word is introduced mid-conversation');
});

test('"how many X do you have?" is never asked about a place or the weather', async () => {
  const { pickFrame, nounCategory } = await import('../server/vocabguard.js');
  assert.equal(nounCategory({ hanzi: '高中', gloss: 'senior high school' }), 'place');
  assert.equal(nounCategory({ hanzi: '太阳', gloss: 'sun' }), 'nature');
  for (const category of ['place', 'nature']) {
    for (let i = 0; i < 12; i++) {
      const fr = pickFrame({ rung: 1, turnIndex: i, category });
      assert.ok(!['how-many-q', 'i-have-num', 'i-have', 'you-have-q'].includes(fr.id),
        `frame ${fr.id} does not make sense for a ${category} noun`);
    }
  }
});

test('the learner can ask to finish and gets a real goodbye', async () => {
  setRungOverride(0);
  const s = await startConversation();
  await conversationTurn({ id: s.sessionId, userText: '' });
  await conversationTurn({ id: s.sessionId, userText: '我有猫。' });
  const bye = await conversationTurn({ id: s.sessionId, userText: '', forceWrap: true });
  assert.equal(bye.shouldWrap, true, 'asking to wrap up ends the conversation');
  assert.match(bye.hanzi, /再见|明天/, 'and it is an actual goodbye');
});

test('confusion is re-grounded with simpler choices, never "I don\'t know"', async () => {
  setRungOverride(0);
  const s = await startConversation();
  await conversationTurn({ id: s.sessionId, userText: '' });
  const r = await conversationTurn({ id: s.sessionId, userText: "what? I'm confused" });
  assert.ok(!/i don'?t know|不知道/i.test(r.english + r.hanzi), 'never strands the learner');
  assert.ok(r.choices.length >= 1, 'offers a next move');
  assert.ok(r.reground || r.followFrame, 're-grounds or re-asks a simpler frame');
});

test('rung override flips the scaffolding knobs 0 → 1 → 2', () => {
  assert.equal(rungKnobs(0).generation, 'frame');
  assert.equal(rungKnobs(0).interlinear, 'full');
  assert.equal(rungKnobs(1).generation, 'hybrid');
  assert.equal(rungKnobs(1).interlinear, 'partial');   // English gloss faded before pinyin
  assert.equal(rungKnobs(2).generation, 'free');
  assert.equal(rungKnobs(2).choices, false);
});
