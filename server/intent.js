// Never strand the learner (§6). Before the normal turn path, classify the learner's
// input for CONFUSION / HELP / expression-gap / English meta-questions, so the guided
// rungs can re-ground (slow down, break the last sentence word-by-word, offer simpler
// choices) instead of ever answering "I don't know" or dead-ending. This is also the
// "always find a way forward" rule: a confused or off turn still yields a next move.
import { pinyinForHanzi } from './pronunciation.js';
import { groundTokens } from './vocabguard.js';
import { convertPinyin } from './pinyinime.js';

const CJK = /[一-鿿]/;
const cjkCount = (s) => (String(s).match(/[一-鿿]/g) || []).length;
const latinCount = (s) => (String(s).match(/[a-zA-Z]/g) || []).length;

const CONFUSION_RE = /\b(what|huh|confused|don'?t (get|understand)|no idea|help|lost|stuck|unclear|again)\b|[?？]{2,}|不懂|不明白|没听懂|听不懂|不知道|什么意思/i;
const HOWDOISAY_RE = /how (?:do|to|can) (?:i|you|we)?\s*say\s+(.+)|how (?:do|to) (?:i|you) express\s+(.+)|怎么说|怎么讲/i;

// Extract the thing the learner wants to say, from a "how do I say X" input.
function extractGap(text) {
  const m = String(text).match(/say\s+["“]?([^"”?？]+?)["”]?\s*(?:in chinese|in mandarin)?\s*[?？]?\s*$/i);
  if (m && m[1]) return m[1].trim();
  const zh = String(text).match(/(.+?)\s*(?:用中文|中文)?\s*怎么(?:说|讲)/);
  if (zh && zh[1]) return zh[1].trim();
  return null;
}

// Classify a learner turn. `prevWasQuestion` lets an empty/one-word reply to a
// question read as a mild stall rather than confusion.
export function classifyIntent(text = '', { prevTeacherHanzi = '' } = {}) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'stall', text: t };
  const zh = cjkCount(t), lat = latinCount(t);

  const gap = t.match(HOWDOISAY_RE);
  if (gap) return { kind: 'howdoisay', phrase: extractGap(t) || null, text: t };

  if (CONFUSION_RE.test(t) && zh === 0) return { kind: 'confused', text: t };

  // Mostly-English content with a question mark, and not Chinese → English meta.
  if (lat >= 3 && lat > zh && /[?？]/.test(t)) return { kind: 'meta', text: t };

  // A short lone LATIN reply (e.g. "ok", "idk") with no Chinese reads as a stall; a
  // short CHINESE reply (对 / 好 / 是) is a legitimate answer at the guided rung, so it
  // flows as normal — never re-ground a correct one-word answer.
  //
  // PINYIN is the third case, and it is the one that matters now that tap-to-answer
  // choices are gone: a beginner with no IME types `mao`, which is a real attempt at
  // 猫, not a shrug. Treating it as a stall re-grounded the learner for answering
  // correctly and stalled the arc on the exact input the app now asks them for.
  if (zh === 0 && lat) {
    const conv = convertPinyin(t);
    if (conv.ok || conv.isPinyin) return { kind: 'normal', text: t, script: 'pinyin' };
    if (lat <= 3) return { kind: 'stall', text: t };
  }

  return { kind: 'normal', text: t };
}

// Build a deterministic RE-GROUNDING reply from the previous teacher sentence: a warm
// "let's slow down" line, the last sentence broken into per-word tokens, and simpler
// yes/echo choices. Never calls a model; can't fail; never says "I don't know".
export function regroundReply({ prevTeacherHanzi = '', sessionWords = [], choices = [] } = {}) {
  const line = { hanzi: '没关系，我们慢慢来。', pinyin: 'Méi guānxi, wǒmen màn man lái.', english: "It's OK — let's take it slowly." };
  const tokens = prevTeacherHanzi ? groundTokens(prevTeacherHanzi, {}) : [];
  const fallbackChoices = choices.length ? choices : [
    { hanzi: '好。', pinyin: 'Hǎo.', gloss: 'OK.' },
    { hanzi: '再说一次。', pinyin: 'Zài shuō yí cì.', gloss: 'Say it again.' },
  ];
  return {
    hanzi: line.hanzi, pinyin: line.pinyin, english: line.english,
    tokens: tokens.length ? tokens : groundTokens(line.hanzi, {}),
    reground: prevTeacherHanzi ? { hanzi: prevTeacherHanzi, tokens } : null,
    choices: fallbackChoices,
    note: '',
  };
}

// Teach JUST the requested phrase (expression-gap coaching) at the guided rungs, in
// flow: give it simply and invite a reuse. Kept minimal; if we can't resolve it we
// still return a helpful, non-stranding nudge to say it another way.
export function expressionGapReply(phrase) {
  if (!phrase) {
    return { hanzi: '你想说什么？用你会的词试试看。', pinyin: 'Nǐ xiǎng shuō shénme? Yòng nǐ huì de cí shì shi kàn.',
      english: 'What do you want to say? Try it with words you know.', tokens: null, choices: [] };
  }
  // We can't reliably translate arbitrary English offline; hand it to the caller to
  // resolve via the model at rung 2, or nudge circumlocution at the guided rungs.
  return { needsModel: true, phrase };
}
