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
import { pinyinForHanzi, glossForHanzi, joinSyllables, pinyinForText, applySandhi, contextualReading } from './pronunciation.js';
import { knownWordIds } from './planner.js';
import { newCandidates } from './planner.js';
import { imageFor, picturableHead, EVERYDAY_KEYWORDS } from './images.js';
import { interestAnchors } from './profile.js';

const CJK = /[一-鿿]/;
const isCjk = (c) => CJK.test(c);
const cjkOnly = (s = '') => [...String(s)].filter(isCjk).join('');

// ── Core function-word whitelist, scaled gently by rung ─────────────────────
// Curated, deliberately SHORT. These are the structural glue (pronouns, numbers,
// measures, copula/negation/question particles) a learner acquires in context, not
// as isolated flashcards. Rung 0 is minimal; higher rungs widen it a little.
// NOTE (2026-08-12): the everyday HSK-1 verbs 喜欢/在/去/吃/喝/看/想 moved DOWN into
// rung 0. They are exactly the "acquired in context" glue this list is for, every
// frame that uses them glosses them word-by-word, and without them rung 0 had only
// 是/有/几个 to say — which is what made a guided session grind the same two nouns
// through "this is X / how many X do you have" over and over.
const CORE_RUNG0 = ['我', '你', '他', '她', '它', '这', '那', '是', '不', '没',
  '的', '吗', '呢', '了', '有', '也', '很', '和', '都', '好',
  '个', '只', '本', '杯', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '两', '几', '多少',
  '喜欢', '在', '去', '吃', '喝', '看', '想', '什么', '这个', '那个', '今天',
  '你好', '谢谢', '再见', '对', '请问', '吧'];
const CORE_RUNG1 = [...CORE_RUNG0, '们', '谁', '哪', '哪个', '得', '还是',
  '要', '会', '来', '说',
  '很多', '一点', '现在', '明天', '昨天', '因为', '所以', '但是', '觉得', '可以', '真',
  // Added 2026-08-13 when the guided rungs started composing real turns instead of
  // filling templates. These are HSK-1 glue a conversation cannot happen without —
  // "什么" and "还" are how you ask a follow-up, 家/里 are where everything is, 名字
  // and 为什么 are how you take an interest in someone. Without them the model had to
  // either leak them (a decodability failure) or fall back to "你有X吗？" forever.
  '家', '里', '还', '为什么', '名字', '叫', '几个', '怎么样', '一起', '给', '做'];

// Clean interlinear glosses for the core function words (the dictionary gloss for
// these is noisy). Content words fall through to glossForHanzi.
const FUNCTION_GLOSS = {
  我: 'I/me', 你: 'you', 他: 'he', 她: 'she', 它: 'it', 们: '(plural)',
  这: 'this', 那: 'that', 这个: 'this', 那个: 'that', 哪: 'which', 哪个: 'which',
  是: 'is', 不: 'not', 没: 'not/none', 有: 'have', 的: '(of)', 了: '(done)', 得: '(how well)',
  吗: '(question)', 呢: '(question)', 吧: '(suggestion)', 也: 'also', 很: 'very',
  和: 'and', 都: 'all', 好: 'good', 多少: 'how many', 几: 'how many',
  什么: 'what', 谁: 'who', 喜欢: 'like', 想: 'want', 要: 'want', 会: 'can', 在: 'at',
  还是: 'or',
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
  是: 'shì', 不: 'bù', 没: 'méi', 有: 'yǒu', 的: 'de', 了: 'le', 得: 'de',
  吗: 'ma', 呢: 'ne', 吧: 'ba', 也: 'yě', 很: 'hěn', 和: 'hé', 都: 'dōu', 好: 'hǎo',
  多少: 'duōshao', 几: 'jǐ', 什么: 'shénme', 谁: 'shéi', 喜欢: 'xǐhuan', 想: 'xiǎng', 还是: 'háishì',
  要: 'yào', 会: 'huì', 在: 'zài', 去: 'qù', 来: 'lái', 看: 'kàn', 吃: 'chī', 喝: 'hē', 说: 'shuō',
  个: 'gè', 只: 'zhī', 本: 'běn', 杯: 'bēi',
  一: 'yī', 二: 'èr', 两: 'liǎng', 三: 'sān', 四: 'sì', 五: 'wǔ', 六: 'liù', 七: 'qī', 八: 'bā', 九: 'jiǔ', 十: 'shí',
  你好: 'nǐhǎo', 谢谢: 'xièxie', 再见: 'zàijiàn', 对: 'duì', 请问: 'qǐngwèn',
  现在: 'xiànzài', 今天: 'jīntiān', 明天: 'míngtiān', 昨天: 'zuótiān',
  因为: 'yīnwèi', 所以: 'suǒyǐ', 但是: 'dànshì', 觉得: 'juéde', 可以: 'kěyǐ', 真: 'zhēn', 很多: 'hěnduō', 一点: 'yìdiǎn',
};
// RENDER-layer reading: a token is one word, so its syllables run together
// (gāozhōng, not gāo zhōng). The analysis layer keeps pinyinForHanzi's space-separated
// form, because tone/syllable comparison needs the syllables apart.
const py = (hanzi) => joinSyllables(pinyinForHanzi(hanzi) || CORE_PINYIN[hanzi] || '');

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
  // Core function words are guaranteed-known units and must segment as units even
  // when the imported dictionary happens not to carry them as rows — otherwise
  // 明天 splits into 明 + 天 and reaches the UI as un-glossed bare characters.
  const core = coreSet(1);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let seg = s[i], len = 1;
    for (let l = Math.min(4, s.length - i); l >= 2; l--) {
      const cand = s.slice(i, i + l);
      if (core.has(cand) || lookup.get(cand)) { seg = cand; len = l; break; }
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
  const tokens = segment(hanzi).map(seg => ({
    hanzi: seg,
    pinyin: py(seg),
    gloss: FUNCTION_GLOSS[seg] || cleanShort(glossForHanzi(seg)),
    isNew: newSet.has(seg),
    audioRef: null,
  }));
  // 一/不 sandhi crosses token boundaries (一 + 只 → yì zhī), so it has to be applied
  // to the line rather than per token — otherwise the interlinear shows a reading the
  // learner would never actually say.
  return applyTokenSandhi(tokens);
}

function applyTokenSandhi(tokens) {
  // Context-dependent readings first — 只 after a numeral is the measure word zhī,
  // not zhǐ "only" — then sandhi over the corrected stream.
  const fixed = tokens.map((t, i) => {
    if ([...t.hanzi].length !== 1) return t;
    const read = contextualReading([tokens[i - 1]?.hanzi, t.hanzi, tokens[i + 1]?.hanzi], 1, t.pinyin);
    return read === t.pinyin ? t : { ...t, pinyin: read };
  });
  const flat = applySandhi(fixed.map(t => t.pinyin || ''));
  tokens = fixed;
  return tokens.map((t, i) => (flat[i] && flat[i] !== t.pinyin ? { ...t, pinyin: flat[i] } : t));
}
// One sense, chosen for a LEARNER rather than taken in dictionary order. CEDICT
// lists archaic senses first often enough that the naive first-sense gloss produced
// "city walls" for 城, "hog" for 猪 and "wine shop" for 酒店 — each of which then
// became the English the learner was taught. So: prefer a sense that names an
// everyday concept, then a short one.
function scrub(sense) {
  return String(sense || '')
    .replace(/\([^)]*\)/g, ' ')
    .split('(')[0]                       // an unbalanced "(courteous" survived the above
    .replace(/\s+/g, ' ')
    .trim();
}
// Dictionary bookkeeping that is not a meaning. CEDICT's first sense is regularly one
// of these, and they were reaching the learner as the gloss under a word: 还有 showed
// "surname Huan" (while the pinyin correctly said hái yǒu), 词 showed "old variant of
// 詞|词[ci2", 屋 is flagged "(bound form)". A gloss that describes the DICTIONARY
// rather than the world teaches nothing.
const NON_MEANING = /^(surname\b|old variant|variant of|abbr\.? for|used in|see [A-Z]|bound form)/i;

function senseScore(s) {
  if (!s) return -99;
  if (NON_MEANING.test(s.trim())) return -50;         // never the gloss, if anything else exists
  const words = s.toLowerCase().split(/\s+/);
  let score = 0;
  for (const w of words) {
    const bare = w.replace(/[^a-z]/g, '');
    if (EVERYDAY_KEYWORDS.has(bare) || EVERYDAY_KEYWORDS.has(bare.replace(/s$/, ''))) { score += 3; break; }
  }
  score += words.length === 1 ? 1.5 : -0.5 * (words.length - 1);
  if (/^to\s/.test(s)) score -= 1;                    // a verb reading of a noun entry
  return score;
}
export function shortGloss(g) { return cleanShort(g); }
function cleanShort(g) {
  if (!g) return '';
  const senses = String(g).split(/[;,·]/).map(scrub).filter(Boolean);
  if (!senses.length) return '';
  let best = senses[0], bestScore = senseScore(senses[0]);
  // Only the first few senses are candidates — deep in the list is where the truly
  // obscure readings live. Widened to 6 when the early ones are all dictionary
  // bookkeeping, so a real meaning further down can still be reached.
  const depth = senses.slice(0, 3).every(s => NON_MEANING.test(s.trim())) ? 6 : 4;
  for (const s of senses.slice(1, depth)) {
    const sc = senseScore(s);
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  return best.slice(0, 22);
}

// ── Semantic categories: what you can sensibly SAY about a noun ─────────────
// A frame is only decodable if it is also SENSIBLE. Rotating "你有几个X？" over
// whatever picturable noun came up produced things like "how many senior high
// schools do you have?" and "how many suns do you have?" — grammatical, glossable,
// and nonsense. Every noun therefore gets a coarse category, and every frame
// declares which categories it fits. Derived from the (already curated) emoji
// anchor plus gloss keywords — no new hand-maintained vocabulary list.
const CATEGORY_KEYWORDS = [
  ['person', ['teacher', 'student', 'doctor', 'friend', 'baby', 'child', 'boy', 'girl', 'man', 'woman',
    'mother', 'father', 'sister', 'brother', 'people', 'person', 'family', 'nurse', 'worker', 'driver']],
  ['creature', ['cat', 'dog', 'bird', 'fish', 'horse', 'pig', 'cow', 'sheep', 'chicken', 'rabbit',
    'tiger', 'panda', 'mouse', 'snake', 'dragon', 'monkey', 'bear', 'elephant', 'animal', 'insect']],
  ['drink', ['tea', 'coffee', 'milk', 'water', 'wine', 'beer', 'juice', 'soup', 'drink']],
  ['food', ['rice', 'noodle', 'bread', 'egg', 'meat', 'apple', 'banana', 'fruit', 'vegetable',
    'dumpling', 'cake', 'food', 'meal', 'breakfast', 'lunch', 'dinner', 'candy', 'sugar', 'fish']],
  ['place', ['school', 'hospital', 'shop', 'store', 'restaurant', 'house', 'home', 'city', 'road',
    'country', 'park', 'room', 'office', 'station', 'market', 'library', 'university', 'college',
    'classroom', 'village', 'town', 'street', 'bank', 'hotel', 'airport', 'building', 'entrance',
    'gate', 'floor', 'apartment', 'kitchen', 'garden', 'zoo', 'museum', 'factory']],
  // Weather and landscape: there IS sun today, you don't own two of them.
  ['nature', ['sun', 'moon', 'star', 'sky', 'rain', 'snow', 'cloud', 'wind', 'fire', 'mountain',
    'sea', 'river', 'weather', 'earth', 'world', 'air',
    'ocean', 'lake', 'island', 'forest', 'field', 'hill', 'stone', 'rock', 'sand', 'ice']],
  // Plants are countable things you can have and like — kept apart from weather so
  // nobody gets asked whether there is flower today.
  ['plant', ['tree', 'flower', 'grass', 'leaf', 'plant', 'seed', 'root', 'bamboo', 'rose']],
  // Body parts: you can point at them and like them, but "I have two hands" is not
  // a sentence anyone says to a beginner.
  ['body', ['hand', 'eye', 'foot', 'face', 'head', 'hair', 'mouth', 'nose', 'ear', 'arm',
    'leg', 'heart', 'tooth', 'finger', 'body', 'back', 'skin']],
];

// The category of a noun token. `object` is the default: a countable, ownable,
// pointable-at thing, which is what the original frames all assumed.
export function nounCategory(word) {
  const hanzi = typeof word === 'string' ? word : word?.hanzi;
  if (!hanzi) return 'object';
  const glossText = (typeof word === 'object' && word.gloss)
    ? word.gloss
    : (glossForHanzi(hanzi) || '');
  const s = ` ${String(glossText).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const [cat, words] of CATEGORY_KEYWORDS) {
    for (const kw of words) if (s.includes(` ${kw} `) || s.includes(` ${kw}s `)) return cat;
  }
  return 'object';
}

// Categories you can own and count with 个 — the precondition for 有/几个 frames.
const COUNTABLE = ['object', 'creature', 'person', 'food', 'drink', 'plant'];
const ALL_CATS = ['object', 'creature', 'person', 'food', 'drink', 'place', 'nature', 'body', 'plant'];
// Things it makes sense to have an OPINION about. "Do you like both hands?" is the
// kind of sentence that made these conversations feel like a machine talking.
const LIKEABLE = ALL_CATS.filter(c => c !== 'body' && c !== 'person');

// "How many boat do you have?" — the count frame is the one place plural matters.
function plural(gloss) {
  const g = String(gloss || '').trim();
  if (!g || MASS.has(g.toLowerCase()) || /s$/i.test(g) || /\s/.test(g)) return g;
  if (/(ch|sh|x|z)$/i.test(g)) return `${g}es`;
  if (/[^aeiou]y$/i.test(g)) return `${g.slice(0, -1)}ies`;
  return `${g}s`;
}

// English rendering helper: a bare gloss reads as "This is car." Countable things
// take an article; mass nouns, places and body parts read better without one.
const NO_ARTICLE = new Set(['nature', 'drink', 'place']);
// Mass nouns take no article whatever their category ("This is a rice").
const MASS = new Set(['rice', 'meat', 'bread', 'food', 'fruit', 'water', 'tea', 'milk', 'soup',
  'sugar', 'money', 'music', 'fire', 'snow', 'rain', 'grass', 'hair', 'wine', 'beer', 'oil', 'paper']);
function withArticle(gloss, category) {
  const g = String(gloss || '').trim();
  if (!g || NO_ARTICLE.has(category) || MASS.has(g.toLowerCase())) return g;
  if (/^(a|an|the|some|to)\s/i.test(g)) return g;
  if (category === 'body') return `your ${g}`;
  return `${/^[aeiou]/i.test(g) ? 'an' : 'a'} ${g}`;
}
const A = (n) => withArticle(n.gloss, n.category || nounCategory(n));

// ── Controlled frames (rung 0/1) ────────────────────────────────────────────
// Each frame is a template whose fixed tokens are core words and whose slots are
// filled ONLY from the allowed set. Qwen never selects vocabulary here; the sentence
// is fully determined, so rung 0 is deterministic, offline, and always decodable.
// `fits` is the semantic gate above; `n` is a chosen noun vocab token; `num` a small
// integer. `pair` frames take a SECOND noun so a session can combine what it taught.
const NUM_HANZI = ['', '一', '两', '三', '四', '五'];
const f = (hanzi) => ({ hanzi, fixed: true });     // fixed core token
const FRAMES = [
  // — universal: naming/pointing works for anything —
  { id: 'this-is', rung: 0, kind: 'statement', fits: ALL_CATS,
    parts: (n) => [f('这'), f('是'), n, f('。')],
    english: (n) => `This is ${A(n)}.` },
  { id: 'this-is-q', rung: 0, kind: 'yesno', fits: ALL_CATS,
    parts: (n) => [f('这'), f('是'), n, f('吗'), f('？')],
    english: (n) => `Is this ${A(n)}?` },
  { id: 'i-like', rung: 0, kind: 'statement', fits: LIKEABLE,
    parts: (n) => [f('我'), f('喜欢'), n, f('。')],
    english: (n) => `I like ${n.gloss}.` },
  { id: 'do-you-like-q', rung: 0, kind: 'yesno', fits: LIKEABLE,
    parts: (n) => [f('你'), f('喜欢'), n, f('吗'), f('？')],
    english: (n) => `Do you like ${n.gloss}?` },
  // — countable, ownable things only —
  { id: 'i-have', rung: 0, kind: 'statement', fits: COUNTABLE,
    parts: (n) => [f('我'), f('有'), n, f('。')],
    english: (n) => `I have ${A(n)}.` },
  { id: 'you-have-q', rung: 0, kind: 'yesno', fits: COUNTABLE,
    parts: (n) => [f('你'), f('有'), n, f('吗'), f('？')],
    english: (n) => `Do you have ${A(n)}?` },
  { id: 'i-have-num', rung: 0, kind: 'statement', fits: COUNTABLE,
    parts: (n, num) => [f('我'), f('有'), f(NUM_HANZI[num] || '一'), f('个'), n, f('。')],
    english: (n, num) => `I have ${num || 1} ${(num || 1) > 1 ? plural(n.gloss) : n.gloss}.` },
  { id: 'how-many-q', rung: 0, kind: 'count', fits: COUNTABLE,
    parts: (n) => [f('你'), f('有'), f('几'), f('个'), n, f('？')],
    english: (n) => `How many ${plural(n.gloss)} do you have?` },
  // — places: you go to them / are at them, you don't own two of them —
  { id: 'go-place-q', rung: 0, kind: 'yesno', fits: ['place'],
    parts: (n) => [f('你'), f('今天'), f('去'), n, f('吗'), f('？')],
    english: (n) => `Are you going to ${n.gloss} today?` },
  { id: 'at-place', rung: 0, kind: 'statement', fits: ['place'],
    parts: (n) => [f('我'), f('在'), n, f('。')],
    english: (n) => `I'm at ${n.gloss}.` },
  { id: 'at-place-q', rung: 0, kind: 'yesno', fits: ['place'],
    parts: (n) => [f('你'), f('在'), n, f('吗'), f('？')],
    english: (n) => `Are you at ${n.gloss}?` },
  // — weather/sky/landscape: you look at it, it's there today —
  { id: 'today-has-q', rung: 0, kind: 'yesno', fits: ['nature'],
    parts: (n) => [f('今天'), f('有'), n, f('吗'), f('？')],
    english: (n) => `Is there ${n.gloss} today?` },
  { id: 'look-at', rung: 0, kind: 'statement', fits: ['nature', 'creature', 'object', 'body', 'plant'],
    parts: (n) => [f('你'), f('看'), f('，'), f('这'), f('是'), n, f('。')],
    english: (n) => `Look — this is ${A(n)}.` },
  // — food / drink —
  { id: 'like-eat-q', rung: 0, kind: 'yesno', fits: ['food'],
    parts: (n) => [f('你'), f('喜欢'), f('吃'), n, f('吗'), f('？')],
    english: (n) => `Do you like eating ${n.gloss}?` },
  { id: 'want-eat', rung: 0, kind: 'statement', fits: ['food'],
    parts: (n) => [f('我'), f('想'), f('吃'), n, f('。')],
    english: (n) => `I want to eat ${n.gloss}.` },
  { id: 'like-drink-q', rung: 0, kind: 'yesno', fits: ['drink'],
    parts: (n) => [f('你'), f('喜欢'), f('喝'), n, f('吗'), f('？')],
    english: (n) => `Do you like drinking ${n.gloss}?` },
  { id: 'want-drink', rung: 0, kind: 'statement', fits: ['drink'],
    parts: (n) => [f('我'), f('想'), f('喝'), n, f('。')],
    english: (n) => `I want to drink ${n.gloss}.` },
  // — people —
  { id: 'is-person-q', rung: 0, kind: 'yesno', fits: ['person'],
    parts: (n) => [f('他'), f('是'), n, f('吗'), f('？')],
    english: (n) => `Is he ${A(n)}?` },
  // — PAIR frames: combine two of today's words into one bigger sentence —
  { id: 'like-both', rung: 0, kind: 'statement', pair: true, fits: LIKEABLE,
    parts: (n, num, o) => [f('我'), f('喜欢'), n, f('和'), o, f('。')],
    english: (n, num, o) => `I like ${n.gloss} and ${o.gloss}.` },
  { id: 'which-do-you-like-q', rung: 1, kind: 'choice', pair: true, fits: LIKEABLE,
    parts: (n, num, o) => [f('你'), f('喜欢'), n, f('，'), f('还是'), o, f('？')],
    english: (n, num, o) => `Do you like ${n.gloss}, or ${o.gloss}?` },
];

// Scaffolded ready-to-say responses for a frame — glossed, always in the allowed set,
// never a puzzle. The learner can tap one instead of open production. `other` is a
// second session noun (for a contrasting answer) when available.
// Scaffolded replies are built from the FRAME's actual shape, so a tap always
// produces a sensible answer to the question that was asked (never "I have two
// suns"). `other` is a second session noun for a contrasting answer.
function choicesFor(frame, n, other) {
  const tok = (hanzi, gloss) => ({ hanzi, pinyin: py(hanzi) || pinyinForHanzi(cjkOnly(hanzi)), gloss });
  const cat = n.category || 'object';
  switch (frame.kind) {
    case 'count':
      return [tok('一个。', 'One.'), tok('两个。', 'Two.'), tok('三个。', 'Three.')];
    case 'choice':
      return [tok(`我喜欢${n.hanzi}。`, `I like ${n.gloss}.`),
        other ? tok(`我喜欢${other.hanzi}。`, `I like ${other.gloss}.`) : null,
        tok('都喜欢。', 'Both.')].filter(Boolean);
    case 'yesno': {
      const yes = frame.id.startsWith('like-eat') ? tok('我喜欢吃。', 'I like it.')
        : frame.id.startsWith('like-drink') ? tok('我喜欢喝。', 'I like it.')
        : frame.id === 'go-place-q' ? tok('我去。', "I'm going.")
        : frame.id === 'at-place-q' ? tok('我在。', 'I am.')
        : frame.id === 'today-has-q' ? tok('今天有。', 'There is.')
        : frame.id === 'do-you-like-q' ? tok(`我喜欢${n.hanzi}。`, `I like ${n.gloss}.`)
        : tok('对。', 'Right.');
      const no = frame.id === 'go-place-q' ? tok('我不去。', "I'm not.")
        : frame.id === 'today-has-q' ? tok('今天没有。', "There isn't.")
        : /like|have/.test(frame.id) ? tok('我不喜欢。', "I don't.")
        : tok('不是。', "It isn't.");
      const third = other ? tok(`我喜欢${other.hanzi}。`, `I like ${other.gloss}.`) : null;
      return [yes, no, third].filter(Boolean);
    }
    default: {
      // Statement → invite a reciprocal the learner can actually mean.
      const mirror = cat === 'place' ? tok(`我也去${n.hanzi}。`, `I go to ${n.gloss} too.`)
        : cat === 'food' ? tok(`我也想吃。`, 'Me too.')
        : cat === 'drink' ? tok(`我也想喝。`, 'Me too.')
        : (cat === 'nature' || cat === 'body') ? tok(`我也喜欢${n.hanzi}。`, `I like ${n.gloss} too.`)
        : tok(`我也有${n.hanzi}。`, `I have ${A(n)} too.`);
      return [tok('好。', 'OK.'), mirror,
        other ? tok(`我喜欢${other.hanzi}。`, `I like ${other.gloss}.`) : null].filter(Boolean);
    }
  }
}

// Pick a frame for this turn. Three gates, in order: the rung must allow it, the
// noun's CATEGORY must fit it (semantic sense), and it must not repeat a frame the
// session already used on this word (variety). Question frames are preferred so the
// learner is usually invited to respond.
export function pickFrame({ rung = 0, turnIndex = 0, prefer = null, category = 'object', pair = false, exclude = [] } = {}) {
  const fits = (fr) => fr.rung <= rung && (fr.fits || ALL_CATS).includes(category) && !!fr.pair === !!pair;
  const pool = FRAMES.filter(fits);
  if (prefer) { const p = FRAMES.find(fr => fr.id === prefer && fr.rung <= rung); if (p) return p; }
  if (!pool.length) return FRAMES[0];                       // 这是X。always works
  const fresh = pool.filter(fr => !exclude.includes(fr.id));
  const bank0 = fresh.length ? fresh : pool;                // exhausted → allow repeats
  const questions = bank0.filter(fr => fr.kind !== 'statement');
  const bank = (turnIndex % 3 === 0) ? bank0 : (questions.length ? questions : bank0);
  return bank[Math.abs(turnIndex) % bank.length];
}

// Build a fully-grounded frame turn: aligned tokens, natural English, scaffolded
// choices, and the meet-the-words payload when this turn introduces a word. The
// vocabulary comes only from `sessionWords`; nothing new is invented.
export function buildFrameTurn({ rung = 0, sessionWords = [], turnIndex = 0, num = 1, focusHanzi = null, prefer = null, pair = false, exclude = [] }) {
  const nouns = sessionWords.filter(Boolean);
  if (!nouns.length) return null;
  const n = (focusHanzi && nouns.find(w => w.hanzi === focusHanzi)) || nouns[Math.abs(turnIndex) % nouns.length];
  const other = nouns.find(w => w.hanzi !== n.hanzi) || null;
  const category = n.category || nounCategory(n);
  const frame = pickFrame({ rung, turnIndex, prefer, category, pair: pair && !!other, exclude });
  const parts = frame.parts(nounTok(n), num, other ? nounTok(other) : nounTok(n));

  const tokens = parts.map(p => {
    if (p.fixed) return { hanzi: p.hanzi, pinyin: /[。，？！、]/.test(p.hanzi) ? '' : py(p.hanzi),
      gloss: /[。，？！、]/.test(p.hanzi) ? '' : (FUNCTION_GLOSS[p.hanzi] || cleanShort(glossForHanzi(p.hanzi))), isNew: false, audioRef: null };
    return { hanzi: p.hanzi, pinyin: p.pinyin || py(p.hanzi), gloss: p.gloss, isNew: !!p.isNew, audioRef: null };
  });
  const hanzi = tokens.map(t => t.hanzi).join('');
  return {
    hanzi,
    pinyin: tokens.filter(t => t.pinyin).map(t => t.pinyin).join(' '),
    english: frame.english(n, num, other || n),
    tokens,
    choices: choicesFor(frame, { ...n, category }, other),
    frameId: frame.id,
    focusHanzi: n.hanzi,
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

// A beginner word has to be NAMEABLE, and the imported dictionary is full of
// entries whose "gloss" is a description, not a name — 楼 came through as "house
// with more than 1", which then got poured into every frame as if it were a word.
// A gloss that reads like a definition is a reliable signal the entry is a bad
// first word, whatever its frequency.
export function isNamable(g) { return namableGloss(g); }
function namableGloss(g) {
  const s = String(g || '').trim();
  if (!s || s.length > 18) return false;
  if (/\d/.test(s)) return false;                                  // "house with more than 1"
  if (/\b(with|than|which|used|kind of|sort of|classifier|measure word|abbr|surname|variant|see also|form of|courteous|polite|honorific|pronoun)\b/i.test(s)) return false;
  if (s.split(/\s+/).length > 3) return false;                     // a phrase, not a name
  return true;
}

// The words the learner's own vocabulary pulls toward: everything the knowledge graph
// links to a word they have used unprompted (collocation, topic, sentence
// co-occurrence, shared character). Character-overlap alone was far too narrow — 猫
// shares nothing with 车/钱/路, yet "cat" should obviously pull toward other animals
// and the things you do with them.
// NOT collocation edges: those are raw co-occurrence, so the "neighbours" of 猫 come
// back as 有 的 了 是 我 — the commonest particles in the language, which relate every
// word to every other and steer nothing. TOPIC edges are the ones that carry meaning:
// 猫 and 狗 both point at `animals`, so a learner who talks about their cat gets
// taught the rest of that world.
function affinityIds(anchors) {
  const ids = new Set();
  if (!anchors?.engaged?.length) return ids;
  const idOf = db().prepare('SELECT id FROM words WHERE hanzi=?');
  const topicsOf = db().prepare(`SELECT dst FROM graph_edges
    WHERE src_type='word' AND src=? AND rel='topic' AND dst_type='topic'`);
  const wordsIn = db().prepare(`SELECT src FROM graph_edges
    WHERE rel='topic' AND dst_type='topic' AND dst=? AND src_type='word' LIMIT 60`);
  const topics = new Set();
  for (const a of anchors.engaged) {
    const row = idOf.get(a);
    if (!row) continue;
    for (const t of topicsOf.all(String(row.id))) topics.add(t.dst);
  }
  for (const t of topics) {
    for (const e of wordsIn.all(t)) {
      const n = Number(e.src);
      if (Number.isFinite(n)) ids.add(n);
    }
  }
  return ids;
}

// A stated interest still matters when the graph has nothing — match it against the
// candidate's gloss.
function interestMatch(hanzi, anchors) {
  const gloss = String(glossForHanzi(hanzi) || '').toLowerCase();
  for (const i of anchors?.interests || []) {
    const word = String(i).toLowerCase().split(/\s+/)[0];
    if (word.length >= 3 && gloss.includes(word)) return 0.8;
  }
  return 0;
}

export function beginnerNewWords(n = 3, { introduced } = {}) {
  const anchors = interestAnchors();
  const affinity_ids = affinityIds(anchors);
  const cands = newCandidates(240, introduced);
  const core = coreSet(1);                                       // never "meet" a function word
  // Source `concrete` is noisy (many words default high), so PICTURABILITY (the curated
  // emoji map) is the reliable rung-0 signal. Two tiers: picturable words first, then
  // noun+concrete words only if we couldn't find enough picturable ones.
  const picturableTier = [], nounTier = [];
  for (const c of cands) {
    const w = db().prepare('SELECT hanzi, freq_rank, hsk_level, concrete, particle, pos, gloss, english FROM words WHERE id=?').get(c.id);
    if (!w || w.particle || core.has(w.hanzi)) continue;
    const charLen = [...w.hanzi].filter(isCjk).length;
    if (charLen > 2) continue;                                  // low character load
    // Must be a NOUN — a namable thing. This is what keeps verbs out: the emoji map
    // whole-word-matches a gloss, so a verb with a noun in its gloss (扶 "support with
    // the hand"→✋, 忍 "to bear"→🐻) would false-positive as picturable without this.
    let isNoun = false; try { isNoun = JSON.parse(w.pos || '[]').some(p => NOUN_POS.has(p)); } catch {}
    if (!isNoun) continue;
    // Judge the gloss the learner will actually SEE (same resolution as vocabToken),
    // not a different one — otherwise the filter and the display disagree.
    const gloss = cleanShort(w.gloss || w.english || glossForHanzi(w.hanzi));
    if (!namableGloss(gloss)) continue;
    // Body parts are nameable and picturable but make poor conversation subjects at
    // this level: with only these frames the talk becomes "is this your foot? do you
    // like your face?". They are still taught through reading and reps.
    if (nounCategory({ hanzi: w.hanzi, gloss }) === 'body') continue;
    // HSK level is the best "would a human teach this first?" signal in the data —
    // it is a curated syllabus, not a corpus artifact. Without it the picturable tier
    // happily served 市民 "city resident" (HSK5), 好友 "close friend" (HSK4, where
    // 朋友 is the ordinary word) and 高中 (HSK2) to absolute beginners, because each
    // one matched an emoji. Beginner words must be HSK 1–2, strongly preferring 1.
    const hsk = w.hsk_level ?? null;
    if (hsk != null && hsk > 2) continue;
    const hskBonus = hsk === 1 ? 1.2 : hsk === 2 ? 0.3 : 0;
    // Pull new vocabulary toward what this learner actually talks about. A word that
    // shares a character or a topic with something they have used unprompted is worth
    // more to them than the next entry on a frequency list.
    const affinity = (affinity_ids.has(c.id) ? 1.2 : 0) + interestMatch(w.hanzi, anchors);
    // The emoji must depict the word itself, not a modifier in its gloss.
    if (picturableHead(cleanShort(w.gloss || w.english || '')) || imageFor(w.hanzi).kind === 'url') {
      picturableTier.push({ id: c.id, hanzi: w.hanzi, score: c.score + hskBonus + affinity + (charLen === 1 ? 0.6 : 0), picturable: true });
    } else if ((w.concrete ?? 0) >= 2) {
      nounTier.push({ id: c.id, hanzi: w.hanzi, score: c.score + hskBonus + affinity, picturable: false });
    }
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
  const gloss = cleanShort(w.gloss || w.english || glossForHanzi(w.hanzi));
  return {
    wordId: w.id, hanzi: w.hanzi, pinyin: w.pinyin || pinyinForHanzi(w.hanzi) || '',
    gloss,
    // The semantic category rides with the token so every frame/choice decision
    // downstream stays sensible for THIS kind of noun.
    category: nounCategory({ hanzi: w.hanzi, gloss }),
    audioRef: w.audio_path || null,
    imageRef: img.kind !== 'none' ? img : null,
  };
}

// ── Model-composed beginner turns ───────────────────────────────────────────
// Rungs 0/1 used to be templates only, which is why a guided session read as a list
// of facts — five turns of "你有X吗？" in a row, never referring to anything the
// learner had said. Templates guarantee decodability but cannot hold a conversation.
//
// So the model composes, and this module still holds the line: the turn is validated
// against the allowed set, gets exactly ONE repair pass naming what leaked, and falls
// back to the template if it still drifts or if no backend is reachable. The offline
// guarantee is unchanged — a turn always exists.
export function beginnerPrompt({ goal, allowed, sessionWords, userText, history = [], push = 'gentle', move = '', follow = null }) {
  const vocab = [...allowed].join(' ');
  const focus = sessionWords.map(w => `${w.hanzi} (${w.gloss || ''})`).join(', ');
  const recent = history.slice(-4).map(m => `${m.role === 'user' ? 'learner' : '老师'}: ${m.content}`).join('\n');
  const PUSH = {
    gentle: 'If they answer with only one word, that is FINE — accept it warmly and keep going. Do not push for more.',
    shaping: 'If they answer with only one word, accept it, then ask one small follow-up that invites a longer answer.',
    firm: 'If they answer briefly, follow up until they say something real — ask 为什么 or 什么 or 怎么样 about their own answer.',
    exacting: 'Expect a full sentence. Follow up on what they said, ask for a reason or a detail, and keep the thread going.',
  };
  return `You are 老师, having a real conversation with a BEGINNER learner of Mandarin.

THE AIM OF THIS CONVERSATION: ${goal}. Move toward it, but follow the learner.
TODAY'S WORDS: ${focus}
${follow ? `
THE LEARNER CHOSE ${follow.hanzi} (${follow.gloss || ''}). Stay on it. Your turn MUST contain
${follow.hanzi}. Do not switch to a different word from today's list — they picked this one,
and moving off it tells them their answer did not matter.
` : ''}
${recent ? `The conversation so far:\n${recent}\n` : ''}${userText ? `The learner just said: "${userText}"` : 'Open the conversation.'}

HARD VOCABULARY LIMIT — use ONLY these words, nothing else. This is absolute:
${vocab}

Write ONE short turn (1–2 sentences, under 16 characters) that:
- REACTS to what they just said before anything else — never ignore it
- ENDS BY ASKING THEM SOMETHING, so they have a reason to reply
- trades information: tell them something small about you, or ask about them
- ${PUSH[push] || PUSH.gentle}
${move ? `\n${move}\n` : ''}

NEVER just state a fact about an object. "这是书。" is what we are replacing — it
tells them nothing and invites nothing.

Reply as strict JSON: {"hanzi":"...","pinyin":"...","english":"..."}
"hanzi" is Chinese characters only; "pinyin" carries tone marks and matches it exactly.`;
}
