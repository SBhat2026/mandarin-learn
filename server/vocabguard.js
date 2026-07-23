// The vocabulary guard (ladder rung 0/1 engine). This is what makes a beginner turn
// DECODABLE: at the guided rungs a teacher sentence is built from controlled frames
// filled only with an ALLOWED set of words, and every generated turn is validated in
// code so no un-glossed unknown content word ever reaches the learner.
//
//   allowed set  = mastered/known words (learner DB)
//                ∪ words introduced earlier THIS session
//                ∪ a small level-appropriate core function-word whitelist
//
// Beginner generation is frame-based (deterministic, offline, immune to the small
// model garbling pinyin — see buildFrameTurn). Validation (validateTurn) runs on ALL
// rungs so even free-conversation output is checked before it's rendered. Everything
// here is invisible; it never announces vocabulary or a lesson.
import { db } from './db.js';
import { pinyinForHanzi, glossForHanzi } from './pronunciation.js';
import { knownWordIds } from './planner.js';
import { newCandidates } from './planner.js';
import { imageFor } from './images.js';

const CJK = /[一-鿿]/;
const isCjk = (c) => CJK.test(c);
const cjkOnly = (s = '') => [...String(s)].filter(isCjk).join('');

// ── Core function-word whitelist, scaled gently by rung ─────────────────────
// Curated, deliberately SHORT. These are the structural glue (pronouns, numbers,
// measures, copula/negation/question particles) a learner acquires in context, not
// as isolated flashcards. Rung 0 is minimal; higher rungs widen it a little.
const CORE_RUNG0 = ['我', '你', '他', '她', '它', '这', '那', '是', '不', '没',
  '的', '吗', '呢', '了', '有', '也', '很', '和', '都', '好',
  '个', '只', '本', '杯', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '两', '几', '多少',
  '你好', '谢谢', '再见', '对', '请问', '吧'];
const CORE_RUNG1 = [...CORE_RUNG0, '们', '什么', '谁', '哪', '这个', '那个', '哪个',
  '喜欢', '想', '要', '会', '在', '去', '来', '看', '吃', '喝', '说',
  '很多', '一点', '现在', '今天', '明天', '昨天', '因为', '所以', '但是', '觉得', '可以', '真'];

// Clean interlinear glosses for the core function words (the dictionary gloss for
// these is noisy). Content words fall through to glossForHanzi.
const FUNCTION_GLOSS = {
  我: 'I/me', 你: 'you', 他: 'he', 她: 'she', 它: 'it', 们: '(plural)',
  这: 'this', 那: 'that', 这个: 'this', 那个: 'that', 哪: 'which', 哪个: 'which',
  是: 'is', 不: 'not', 没: 'not/none', 有: 'have', 的: '(of)', 了: '(done)',
  吗: '(question)', 呢: '(question)', 吧: '(suggestion)', 也: 'also', 很: 'very',
  和: 'and', 都: 'all', 好: 'good', 多少: 'how many', 几: 'how many',
  什么: 'what', 谁: 'who', 喜欢: 'like', 想: 'want', 要: 'want', 会: 'can', 在: 'at',
  个: '(measure)', 只: '(measure)', 本: '(measure)', 杯: 'cup of',
  一: 'one', 二: 'two', 两: 'two', 三: 'three', 四: 'four', 五: 'five',
  六: 'six', 七: 'seven', 八: 'eight', 九: 'nine', 十: 'ten',
  你好: 'hello', 谢谢: 'thanks', 再见: 'bye', 对: 'right/yes', 请问: 'excuse me',
  现在: 'now', 今天: 'today', 明天: 'tomorrow', 昨天: 'yesterday',
  因为: 'because', 所以: 'so', 但是: 'but', 觉得: 'feel/think', 可以: 'can', 真: 'really',
  去: 'go', 来: 'come', 看: 'look', 吃: 'eat', 喝: 'drink', 说: 'say', 很多: 'many', 一点: 'a bit',
};

// Fallback pinyin for the core words + numbers/measures, so interlinear grounding is
// guaranteed even if a word row is missing its reading. pinyinForHanzi (the word DB)
// wins when present; this is the floor.
const CORE_PINYIN = {
  我: 'wǒ', 你: 'nǐ', 他: 'tā', 她: 'tā', 它: 'tā', 们: 'men',
  这: 'zhè', 那: 'nà', 这个: 'zhège', 那个: 'nàge', 哪: 'nǎ', 哪个: 'nǎge',
  是: 'shì', 不: 'bù', 没: 'méi', 有: 'yǒu', 的: 'de', 了: 'le',
  吗: 'ma', 呢: 'ne', 吧: 'ba', 也: 'yě', 很: 'hěn', 和: 'hé', 都: 'dōu', 好: 'hǎo',
  多少: 'duōshao', 几: 'jǐ', 什么: 'shénme', 谁: 'shéi', 喜欢: 'xǐhuan', 想: 'xiǎng',
  要: 'yào', 会: 'huì', 在: 'zài', 去: 'qù', 来: 'lái', 看: 'kàn', 吃: 'chī', 喝: 'hē', 说: 'shuō',
  个: 'gè', 只: 'zhī', 本: 'běn', 杯: 'bēi',
  一: 'yī', 二: 'èr', 两: 'liǎng', 三: 'sān', 四: 'sì', 五: 'wǔ', 六: 'liù', 七: 'qī', 八: 'bā', 九: 'jiǔ', 十: 'shí',
  你好: 'nǐhǎo', 谢谢: 'xièxie', 再见: 'zàijiàn', 对: 'duì', 请问: 'qǐngwèn',
  现在: 'xiànzài', 今天: 'jīntiān', 明天: 'míngtiān', 昨天: 'zuótiān',
  因为: 'yīnwèi', 所以: 'suǒyǐ', 但是: 'dànshì', 觉得: 'juéde', 可以: 'kěyǐ', 真: 'zhēn', 很多: 'hěnduō', 一点: 'yìdiǎn',
};
const py = (hanzi) => pinyinForHanzi(hanzi) || CORE_PINYIN[hanzi] || '';

export function coreSet(rung = 0) {
  return new Set(rung >= 1 ? CORE_RUNG1 : CORE_RUNG0);
}

// The hanzi of every word the learner already knows solidly (comprehensible-input base).
export function knownHanzi() {
  const ids = [...knownWordIds()];
  if (!ids.length) return [];
  return db().prepare(`SELECT hanzi FROM words WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids).map(r => r.hanzi);
}

// Build the allowed set for a turn: core ∪ known ∪ this-session's introduced words,
// plus every INDIVIDUAL character of those words (so compositional reuse validates).
export function allowedSet({ rung = 0, sessionWords = [] } = {}) {
  const core = coreSet(rung);
  const allowed = new Set(core);
  const add = (h) => { if (!h) return; allowed.add(h); for (const c of h) if (isCjk(c)) allowed.add(c); };
  for (const h of core) add(h);
  for (const h of knownHanzi()) add(h);
  for (const w of sessionWords) add(typeof w === 'string' ? w : w.hanzi);
  return allowed;
}

// ── Segmentation (greedy longest-match against the word DB, ≤4 chars) ────────
// Reuses the same approach as level.js. Returns segments in order; punctuation and
// non-CJK are dropped. Each segment is the longest dictionary word starting there,
// else a single character.
export function segment(text) {
  const s = cjkOnly(text);
  const lookup = db().prepare('SELECT 1 FROM words WHERE hanzi=?');
  const out = [];
  let i = 0;
  while (i < s.length) {
    let seg = s[i], len = 1;
    for (let l = Math.min(4, s.length - i); l >= 2; l--) {
      if (lookup.get(s.slice(i, i + l))) { seg = s.slice(i, i + l); len = l; break; }
    }
    out.push(seg); i += len;
  }
  return out;
}

// Is a segment allowed? Either the whole segment is in the set, or every one of its
// characters is (compositional: 你 + 好 known ⇒ 你好 decodable even if unlisted).
function segAllowed(seg, allowed) {
  if (allowed.has(seg)) return true;
  return [...seg].every(c => !isCjk(c) || allowed.has(c));
}

// Validate a teacher sentence against the allowed set. Returns the list of
// out-of-set content segments (empty ⇒ fully decodable). Core function words are
// always in `allowed`, so violations are genuinely un-introduced content words.
export function validateTurn(hanzi, allowed) {
  const violations = [];
  for (const seg of segment(hanzi)) if (!segAllowed(seg, allowed)) violations.push(seg);
  return { ok: violations.length === 0, violations };
}

// ── Interlinear grounding: aligned per-word tokens ──────────────────────────
// Turn a Chinese sentence into {hanzi,pinyin,gloss,isNew,audioRef} per word so the UI
// can render word-by-word. `newSet` marks words introduced this session (highlight).
export function groundTokens(hanzi, { newSet = new Set() } = {}) {
  return segment(hanzi).map(seg => ({
    hanzi: seg,
    pinyin: py(seg),
    gloss: FUNCTION_GLOSS[seg] || cleanShort(glossForHanzi(seg)),
    isNew: newSet.has(seg),
    audioRef: null,
  }));
}
function cleanShort(g) { return g ? String(g).split(/[;,·]/)[0].trim().slice(0, 22) : ''; }

// ── Controlled frames (rung 0/1) ────────────────────────────────────────────
// Each frame is a template whose fixed tokens are core words and whose slots are
// filled ONLY from the allowed set. Qwen never selects vocabulary here; the sentence
// is fully determined, so rung 0 is deterministic, offline, and always decodable.
// `n` is a chosen noun vocab token {hanzi,pinyin,gloss}; `num` a small integer.
const NUM_HANZI = ['', '一', '两', '三', '四', '五'];
const f = (hanzi) => ({ hanzi, fixed: true });     // fixed core token
const FRAMES = [
  { id: 'this-is', rung: 0, kind: 'statement',
    parts: (n) => [f('这'), f('是'), n, f('。')],
    english: (n) => `This is ${n.gloss}.` },
  { id: 'this-is-q', rung: 0, kind: 'yesno',
    parts: (n) => [f('这'), f('是'), n, f('吗'), f('？')],
    english: (n) => `Is this ${n.gloss}?` },
  { id: 'i-have', rung: 0, kind: 'statement',
    parts: (n) => [f('我'), f('有'), n, f('。')],
    english: (n) => `I have ${n.gloss}.` },
  { id: 'you-have-q', rung: 0, kind: 'yesno',
    parts: (n) => [f('你'), f('有'), n, f('吗'), f('？')],
    english: (n) => `Do you have ${n.gloss}?` },
  { id: 'i-have-num', rung: 0, kind: 'statement',
    parts: (n, num) => [f('我'), f('有'), f(NUM_HANZI[num] || '一'), f('个'), n, f('。')],
    english: (n, num) => `I have ${num || 1} ${n.gloss}.` },
  { id: 'how-many-q', rung: 0, kind: 'count',
    parts: (n) => [f('你'), f('有'), f('几'), f('个'), n, f('？')],
    english: (n) => `How many ${n.gloss} do you have?` },
  { id: 'i-like', rung: 1, kind: 'statement',
    parts: (n) => [f('我'), f('喜欢'), n, f('。')],
    english: (n) => `I like ${n.gloss}.` },
  { id: 'do-you-like-q', rung: 1, kind: 'yesno',
    parts: (n) => [f('你'), f('喜欢'), n, f('吗'), f('？')],
    english: (n) => `Do you like ${n.gloss}?` },
];

// Scaffolded ready-to-say responses for a frame — glossed, always in the allowed set,
// never a puzzle. The learner can tap one instead of open production. `other` is a
// second session noun (for a contrasting answer) when available.
function choicesFor(frame, n, other) {
  const tok = (hanzi) => ({ hanzi, pinyin: py(hanzi) || pinyinForHanzi(cjkOnly(hanzi)), gloss: glossEnglish(hanzi, n, other) });
  switch (frame.kind) {
    case 'yesno':
      return [tok('对。'), tok('不是。'), other ? tok(`这是${other.hanzi}。`) : null].filter(Boolean);
    case 'count':
      return [tok('一个。'), tok('两个。'), tok('三个。')];
    default: // statement → invite a simple echo / reciprocal
      return [tok('好。'), other ? tok(`我有${other.hanzi}。`) : tok('我也有。')];
  }
}
function glossEnglish(hanzi, n, other) {
  const map = { '对。': 'Right.', '不是。': "It isn't.", '好。': 'OK.', '我也有。': 'Me too.',
    '一个。': 'One.', '两个。': 'Two.', '三个。': 'Three.' };
  if (map[hanzi]) return map[hanzi];
  if (hanzi.includes('我有')) return `I have ${other?.gloss || n.gloss}.`;
  if (hanzi.includes('这是') && other && hanzi.includes(other.hanzi)) return `This is ${other.gloss}.`;
  if (other && hanzi.includes(other.hanzi)) return `${other.gloss}.`;
  return '';
}

// Pick a frame for this turn: rotate by turn index within the rung's frames, and
// prefer a question frame (so the learner is invited to respond) most turns.
export function pickFrame({ rung = 0, turnIndex = 0, prefer = null } = {}) {
  const pool = FRAMES.filter(fr => fr.rung <= rung);
  if (prefer) { const p = pool.find(fr => fr.id === prefer); if (p) return p; }
  const questions = pool.filter(fr => fr.kind !== 'statement');
  const bank = (turnIndex % 3 === 0 && rung === 0) ? pool : (questions.length ? questions : pool);
  return bank[turnIndex % bank.length];
}

// Build a fully-grounded frame turn: aligned tokens, natural English, scaffolded
// choices, and the meet-the-words payload when this turn introduces a word. The
// vocabulary comes only from `sessionWords`; nothing new is invented.
export function buildFrameTurn({ rung = 0, sessionWords = [], turnIndex = 0, num = 1, focusHanzi = null, prefer = null }) {
  const nouns = sessionWords.filter(Boolean);
  if (!nouns.length) return null;
  const n = (focusHanzi && nouns.find(w => w.hanzi === focusHanzi)) || nouns[turnIndex % nouns.length];
  const other = nouns.find(w => w.hanzi !== n.hanzi) || null;
  const frame = pickFrame({ rung, turnIndex, prefer });
  const parts = frame.parts(nounTok(n), num);

  const tokens = parts.map(p => {
    if (p.fixed) return { hanzi: p.hanzi, pinyin: /[。，？！、]/.test(p.hanzi) ? '' : py(p.hanzi),
      gloss: /[。，？！、]/.test(p.hanzi) ? '' : (FUNCTION_GLOSS[p.hanzi] || cleanShort(glossForHanzi(p.hanzi))), isNew: false, audioRef: null };
    return { hanzi: p.hanzi, pinyin: p.pinyin || py(p.hanzi), gloss: p.gloss, isNew: !!p.isNew, audioRef: null };
  });
  const hanzi = tokens.map(t => t.hanzi).join('');
  return {
    hanzi,
    pinyin: tokens.filter(t => t.pinyin).map(t => t.pinyin).join(' '),
    english: frame.english(n, num),
    tokens,
    choices: choicesFor(frame, n, other),
    frameId: frame.id,
    _frame: true,
  };
}
function nounTok(w) { return { hanzi: w.hanzi, pinyin: w.pinyin || py(w.hanzi), gloss: w.gloss || cleanShort(glossForHanzi(w.hanzi)), isNew: !!w.isNew }; }

// ── Rung-0 word selection bias (§8) ─────────────────────────────────────────
// Keep the graph+frequency+concreteness picker (newCandidates) but, at the bottom
// rung, bias HARD toward: high frequency, high concreteness/picturability, low
// character load (1–2 chars), and exclude bare particles/abstract function words.
// Picturability (an emoji anchor exists) is a strong, free signal of a decodable,
// meetable beginner noun. No hand-curated syllabus.
const NOUN_POS = new Set(['n', 'ns', 'nr', 'nz', 'nt']);
export function beginnerNewWords(n = 3, { introduced } = {}) {
  const cands = newCandidates(240, introduced);
  const core = coreSet(1);                                       // never "meet" a function word
  // Source `concrete` is noisy (many words default high), so PICTURABILITY (the curated
  // emoji map) is the reliable rung-0 signal. Two tiers: picturable words first, then
  // noun+concrete words only if we couldn't find enough picturable ones.
  const picturableTier = [], nounTier = [];
  for (const c of cands) {
    const w = db().prepare('SELECT hanzi, freq_rank, concrete, particle, pos FROM words WHERE id=?').get(c.id);
    if (!w || w.particle || core.has(w.hanzi)) continue;
    const charLen = [...w.hanzi].filter(isCjk).length;
    if (charLen > 2) continue;                                  // low character load
    // Must be a NOUN — a namable thing. This is what keeps verbs out: the emoji map
    // whole-word-matches a gloss, so a verb with a noun in its gloss (扶 "support with
    // the hand"→✋, 忍 "to bear"→🐻) would false-positive as picturable without this.
    let isNoun = false; try { isNoun = JSON.parse(w.pos || '[]').some(p => NOUN_POS.has(p)); } catch {}
    if (!isNoun) continue;
    const img = imageFor(w.hanzi);
    if (img.kind !== 'none') picturableTier.push({ id: c.id, hanzi: w.hanzi, score: c.score + (charLen === 1 ? 0.6 : 0), picturable: true });
    else if ((w.concrete ?? 0) >= 2) nounTier.push({ id: c.id, hanzi: w.hanzi, score: c.score, picturable: false });
  }
  picturableTier.sort((a, b) => b.score - a.score);
  nounTier.sort((a, b) => b.score - a.score);
  return [...picturableTier, ...nounTier].slice(0, n);
}

// Resolve a word id to a vocab token used by frames / meet-the-words.
export function vocabToken(wordId) {
  const w = db().prepare('SELECT id, hanzi, pinyin, gloss, english, audio_path FROM words WHERE id=?').get(wordId);
  if (!w) return null;
  const img = imageFor(w.hanzi);
  return {
    wordId: w.id, hanzi: w.hanzi, pinyin: w.pinyin || pinyinForHanzi(w.hanzi) || '',
    gloss: cleanShort(w.gloss || w.english || glossForHanzi(w.hanzi)),
    audioRef: w.audio_path || null,
    imageRef: img.kind !== 'none' ? img : null,
  };
}
