// Tone-colored pinyin & hanzi. A consistent color per tone builds an implicit
// tonal memory as the learner reads — the same signal Pleco/Hanping use.
export const TONE_COLORS = {
  1: '#c0392b', // high–flat  (red)
  2: '#d68910', // rising     (amber)
  3: '#1e8449', // dip        (green)
  4: '#2471a3', // falling    (blue)
  0: '#7f8c8d', // neutral    (grey)
};

const TONE_MARKS = {
  ā: 1, á: 2, ǎ: 3, à: 4, a: 0,
  ē: 1, é: 2, ě: 3, è: 4, e: 0,
  ī: 1, í: 2, ǐ: 3, ì: 4, i: 0,
  ō: 1, ó: 2, ǒ: 3, ò: 4, o: 0,
  ū: 1, ú: 2, ǔ: 3, ù: 4, u: 0,
  ǖ: 1, ǘ: 2, ǚ: 3, ǜ: 4, ü: 0,
};

// Tone number for one pinyin syllable (from its diacritic, or trailing digit).
export function toneOf(syllable = '') {
  const s = syllable.toLowerCase();
  const digit = s.match(/[1-5]\s*$/);
  if (digit) return Number(digit[0]) % 5;
  for (const ch of s) if (ch in TONE_MARKS && TONE_MARKS[ch] > 0) return TONE_MARKS[ch];
  return 0;
}

// Split a pinyin string into syllable tokens (keeps separators out).
export function pinyinSyllables(pinyin = '') {
  return String(pinyin).trim().split(/\s+/).filter(Boolean);
}

// Zip hanzi characters to their pinyin syllables + tones. Best-effort alignment:
// if the counts match we color per-character, else we color pinyin only.
export function toneSpans(hanzi = '', pinyin = '') {
  const syl = pinyinSyllables(pinyin);
  const chars = [...hanzi].filter(c => /[㐀-鿿]/.test(c) || c === '＿');
  const aligned = chars.length === syl.length;
  return { syl: syl.map(s => ({ text: s, tone: toneOf(s) })),
           chars: chars.map((c, i) => ({ text: c, tone: aligned ? toneOf(syl[i]) : null })),
           aligned };
}
