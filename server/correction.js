// What the learner actually produced, and what was wrong with it.
//
// This exists because the app used to let a learner answer by TAPPING a glossed chip.
// That is recognition wearing production's clothes: picking 这是猫 from three options
// exercises none of the retrieval that saying 这是猫 does, and it let the whole session
// be completed without ever composing a sentence. Choices are gone; the learner types
// or speaks, and this module is what makes that safe — because production without
// correction is just uncorrected error, practised.
//
// Everything here is DETERMINISTIC. Rungs 0 and 1 never call a model, so correction
// cannot depend on one; and at rung 2 a deterministic pass is still what turns a vague
// "recast it naturally" into a directive naming the exact error.
import { segment, nounCategory, shortGloss } from './vocabguard.js';
import { pinyinForHanzi, glossForHanzi } from './pronunciation.js';
import { convertPinyin } from './pinyinime.js';

const CJK = /[一-鿿]/;
const hasCjk = (s) => CJK.test(String(s || ''));
const TONE_MARKS = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;

// ── The strictness ladder ───────────────────────────────────────────────────
// The single thing the learner should feel getting harder. A beginner typing `mao`
// has done something real and must not be told off for it; an advanced learner typing
// `mao` when they have known 猫 for months is avoiding the work, and letting it pass
// is how someone ends up fluent in pinyin and illiterate in Chinese.
//
// `t` is level.js's progression scalar (conversationProfile().t).
//
//   script  'any'      — pinyin, hanzi, even English attempts all fine
//           'prefer'   — pinyin fine, but hanzi is named as the next step
//           'require'  — pinyin for a word they KNOW is corrected to characters
//   tones   'ignore' | 'note' | 'require'
export function strictness(t = 0, rung = 0) {
  if (rung === 0 || t < 0.15) return { band: 'gentle', script: 'any', tones: 'ignore', grammar: false };
  if (t < 0.4) return { band: 'shaping', script: 'any', tones: 'note', grammar: true };
  if (t < 0.7) return { band: 'firm', script: 'prefer', tones: 'require', grammar: true };
  return { band: 'exacting', script: 'require', tones: 'require', grammar: true };
}

// ── What script did they answer in? ─────────────────────────────────────────
export function scriptOf(text = '') {
  const s = String(text).trim();
  if (!s) return 'empty';
  if (hasCjk(s)) return /[a-zA-Z]/.test(s.replace(/[a-zA-Z]*[0-9]/g, '')) ? 'mixed' : 'hanzi';
  const conv = convertPinyin(s);
  if (conv.isPinyin || conv.ok) return 'pinyin';
  return /[a-zA-Z]/.test(s) ? 'english' : 'other';
}

// Tone marks present on a pinyin string? Tone NUMBERS (hao3) count as "they know tones
// exist" but are still not what we write, so they get their own issue.
function toneShape(text = '') {
  const s = String(text);
  if (TONE_MARKS.test(s)) return 'marks';
  if (/[a-zü]+[1-5]\b/i.test(s)) return 'numbers';
  return 'none';
}

// ── Grammar checks that are worth making deterministically ──────────────────
// Deliberately few. Each one is an error English speakers make constantly, is
// unambiguous to detect, and is wrong in a way that a learner will otherwise repeat
// for years. Anything subtler is left to the model at rung 2.

// 我是好 / 她是高 — 是 does not link a subject to an adjective.
const ADJECTIVES = new Set(['好', '高', '大', '小', '累', '忙', '快', '慢', '冷', '热', '难', '容易', '漂亮', '开心', '贵', '便宜', '远', '近']);
function shiAdjective(hanzi) {
  const m = String(hanzi).match(/是\s*(很)?\s*([一-鿿]{1,2})/);
  if (!m || m[1]) return null;                    // 是很好 is a different (rarer) error
  const adj = ADJECTIVES.has(m[2]) ? m[2] : (ADJECTIVES.has(m[2][0]) ? m[2][0] : null);
  if (!adj) return null;
  return { kind: 'shi-adjective', found: `是${adj}`, fix: `很${adj}`,
    why: '是 joins a subject to a NOUN. With an adjective you want 很.' };
}

// 一个猫 — the measure word 个 is the default, not the universal.
const MEASURE_BY_CATEGORY = { creature: '只', drink: '杯', place: null, nature: null, body: null };
const MEASURE_BY_NOUN = { 书: '本', 猫: '只', 狗: '只', 鱼: '条', 鸟: '只', 马: '匹', 车: '辆', 茶: '杯', 水: '杯',
  咖啡: '杯', 牛奶: '杯', 衣服: '件', 裤子: '条', 纸: '张', 桌子: '张', 椅子: '把', 笔: '支', 路: '条', 河: '条' };
function measureWord(hanzi) {
  const m = String(hanzi).match(/([一二两三四五六七八九十几])个\s*([一-鿿]{1,2})/);
  if (!m) return null;
  const noun = MEASURE_BY_NOUN[m[2]] ? m[2] : (MEASURE_BY_NOUN[m[2][0]] ? m[2][0] : null);
  const want = noun ? MEASURE_BY_NOUN[noun] : MEASURE_BY_CATEGORY[nounCategory({ hanzi: m[2], gloss: glossForHanzi(m[2]) })];
  if (!want || want === '个') return null;
  return { kind: 'measure-word', found: `${m[1]}个${noun || m[2]}`, fix: `${m[1]}${want}${noun || m[2]}`,
    why: `${noun || m[2]} takes ${want}, not 个.` };
}

// 二个人 — 两 is the counting form.
function erLiang(hanzi) {
  const m = String(hanzi).match(/二([个只本条杯件张把支辆匹])/);
  if (!m) return null;
  return { kind: 'er-liang', found: `二${m[1]}`, fix: `两${m[1]}`,
    why: 'Counting things uses 两, not 二.' };
}

const GRAMMAR_CHECKS = [shiAdjective, measureWord, erLiang];

// ── The main entry ──────────────────────────────────────────────────────────
// `expected` is the sentence the turn invited (a frame's hanzi), when there is one.
// Returns a correction the caller renders under the learner's own bubble, plus an
// `accepted` verdict the ladder reads as its comprehension signal.
export function evaluateProduction({ text = '', expected = null, t = 0, rung = 0, knownHanzi = new Set() } = {}) {
  const raw = String(text || '').trim();
  const rules = strictness(t, rung);
  const script = scriptOf(raw);
  const issues = [];

  if (!raw) return { script: 'empty', accepted: false, issues: [], rules, produced: null };
  // An English aside is a different intent (handled by intent.js), not a production
  // error — never "correct" someone for asking a question in English.
  if (script === 'english' || script === 'other') {
    return { script, accepted: false, issues: [], rules, produced: null, aside: true };
  }

  // Resolve what they meant, in characters, so every later check works on one form.
  const conv = script === 'pinyin' ? convertPinyin(raw) : null;
  const meant = script === 'pinyin' ? resolveMeant({ raw, conv, expected }) : { hanzi: raw, confident: true };
  const produced = meant.hanzi;

  // ── Script strictness ────────────────────────────────────────────────────
  if (script === 'pinyin') {
    // Only words the learner already KNOWS are held to the characters standard —
    // being asked for hanzi you have never been shown is not rigour, it is a wall.
    // Only assert the characters when we are sure which ones they meant. The IME is
    // tone-blind, so an unguarded guess turns `máo` (毛) into "you meant 猫" — the app
    // being confidently wrong, which is worse than saying nothing.
    const knownInAnswer = (produced && meant.confident)
      ? segment(produced).filter(w => knownHanzi.has(w) || [...w].every(c => knownHanzi.has(c)))
      : [];
    if (rules.script === 'require' && knownInAnswer.length) {
      issues.push({ kind: 'script', found: raw, fix: produced,
        why: `You know these characters — write them: ${knownInAnswer.join('')}.` });
    } else if (rules.script === 'prefer' && knownInAnswer.length) {
      issues.push({ kind: 'script-nudge', soft: true, found: raw, fix: produced,
        why: `You could write this in characters now: ${knownInAnswer.join('')}.` });
    }

    // ── Tone strictness ────────────────────────────────────────────────────
    const shape = toneShape(raw);
    if (shape !== 'marks' && rules.tones !== 'ignore') {
      const target = (produced && meant.confident) ? pinyinForHanzi(produced) : null;
      issues.push({
        kind: shape === 'numbers' ? 'tone-numbers' : 'tone-missing',
        soft: rules.tones === 'note',
        found: raw, fix: target || raw,
        why: shape === 'numbers'
          ? 'Write the tone as a mark, not a number.'
          : 'Without a tone it is not a word yet — the tone is part of how it is said.',
      });
    } else if (shape === 'marks' && expected && rules.tones === 'require') {
      // They wrote tones — are they the RIGHT ones?
      //
      // This check REQUIRES knowing what they were trying to say. Without a target,
      // a different tone is a different WORD, not a mistake: `máo` is 毛, and telling
      // someone who typed 毛 that they meant 猫 is the app being wrong, loudly. So
      // tones are only marked against the sentence the turn actually invited.
      const wrong = wrongTones(raw, pinyinForHanzi(expected));
      if (wrong.length) {
        issues.push({ kind: 'tone-wrong', found: wrong.map(w => w.said).join(' '), fix: wrong.map(w => w.want).join(' '),
          why: `Tone: ${wrong.map(w => `${w.said} → ${w.want}`).join(', ')}.` });
      }
    }
  }

  // ── Grammar ──────────────────────────────────────────────────────────────
  if (rules.grammar && produced) {
    for (const check of GRAMMAR_CHECKS) {
      const hit = check(produced);
      if (hit) issues.push(hit);
    }
  }

  // A `soft` issue is a nudge, not a failure — the turn still counts as produced.
  const hard = issues.filter(i => !i.soft);
  return {
    script, produced, issues, rules,
    accepted: hard.length === 0,
    corrected: hard.length ? bestFix(produced, hard) : null,
    expected: expected || null,
  };
}

// Which characters did they actually mean? Answered with a CONFIDENCE flag, because
// every downstream correction that names characters is only honest when that flag is
// true. Confident means the reading round-trips: the same syllables, and the same
// tones whenever the learner supplied tones at all.
function resolveMeant({ raw, conv, expected }) {
  const bare = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-zü\s]/g, '').split(/\s+/).filter(Boolean).join('');
  const tonesOf = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).map(toneOf).join('');
  const typedTones = TONE_MARKS.test(raw) || /[a-zü]+[1-5]\b/i.test(raw);

  // The sentence this turn invited is the best hypothesis available.
  if (expected) {
    const py = pinyinForHanzi(expected);
    if (py && bare(py) === bare(raw) && (!typedTones || tonesOf(py) === tonesOf(raw))) {
      return { hanzi: expected, confident: true };
    }
  }
  if (conv?.ok && conv.hanzi) {
    const back = pinyinForHanzi(conv.hanzi);
    const sameSound = back && bare(back) === bare(raw);
    const sameTone = !typedTones || tonesOf(back) === tonesOf(raw);
    return { hanzi: conv.hanzi, confident: !!(sameSound && sameTone) };
  }
  return { hanzi: null, confident: false };
}

// Tone number carried by one syllable — from its diacritic, or a trailing digit.
const TONE_OF_VOWEL = { ā: 1, á: 2, ǎ: 3, à: 4, ē: 1, é: 2, ě: 3, è: 4, ī: 1, í: 2, ǐ: 3, ì: 4,
  ō: 1, ó: 2, ǒ: 3, ò: 4, ū: 1, ú: 2, ǔ: 3, ù: 4, ǖ: 1, ǘ: 2, ǚ: 3, ǜ: 4 };
export function toneOf(syllable = '') {
  const s = String(syllable).toLowerCase();
  const digit = s.match(/[1-5]\s*$/);
  if (digit) return Number(digit[0]) % 5;
  for (const ch of s) if (TONE_OF_VOWEL[ch]) return TONE_OF_VOWEL[ch];
  return 0;
}
// The syllable with its tone stripped, so two spellings of the same sound compare.
export function bareSyllable(syllable = '') {
  return String(syllable).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-zü]/g, '');
}

// Compare the tones the learner wrote against the tones the word actually has. Only
// syllables that are the same SOUND are compared — if they typed a different word we
// have nothing to say about its tone.
function wrongTones(said, want) {
  const a = String(said).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const b = String(want || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!b.length || a.length !== b.length) return [];      // can't align — say nothing
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (bareSyllable(a[i]) !== bareSyllable(b[i])) continue;
    if (toneOf(a[i]) !== toneOf(b[i])) out.push({ said: a[i], want: b[i] });
  }
  return out;
}

// The single sentence the learner should have said, with every hard fix applied.
function bestFix(produced, hard) {
  let hanzi = produced || '';
  for (const i of hard) if (i.found && i.fix && hanzi.includes(i.found)) hanzi = hanzi.replace(i.found, i.fix);
  if (!hanzi || !hasCjk(hanzi)) hanzi = hard.find(i => hasCjk(i.fix))?.fix || hanzi;
  return { hanzi, pinyin: pinyinForHanzi(hanzi), english: glossForHanzi(hanzi) };
}

// ── Turning a correction into something Laoshi says ─────────────────────────
// A RECAST, not a mark: the right version said back warmly, the way a person would.
// Never "wrong", never a score. One issue at a time — a learner handed three
// corrections stops talking.
export function recastLine(correction) {
  const hard = (correction?.issues || []).filter(i => !i.soft);
  const lead = hard[0] || (correction?.issues || [])[0];
  if (!lead || !correction.produced) return null;
  const fixed = correction.corrected?.hanzi || lead.fix;
  return {
    kind: lead.kind,
    said: correction.produced,
    hanzi: fixed,
    pinyin: correction.corrected?.pinyin || pinyinForHanzi(String(fixed)),
    english: lead.why,
    // The learner sees their own attempt beside the fix — the contrast IS the lesson.
    contrast: { from: lead.found, to: lead.fix },
    soft: !!lead.soft,
  };
}

// The directive handed to the rung-2 executor so the model recasts the SPECIFIC error
// instead of being told to "correct naturally" and inventing something else.
export function recastDirective(correction) {
  const issues = (correction?.issues || []).filter(i => !i.soft);
  if (!issues.length) return '';
  const i = issues[0];
  return `The learner just wrote "${correction.produced}". It should be "${i.fix}" — ${i.why} `
    + 'Use the corrected form naturally in your own next line so they hear it right, and do NOT '
    + 'name the rule, grade them, or say they made a mistake. Keep the conversation going.';
}

export { MEASURE_BY_NOUN };
