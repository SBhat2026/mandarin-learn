// Pinyin / tone helpers. Convert accented pinyin to numbered tones and extract
// a tone_pattern (e.g. "ni3 hao3" -> "3-3").

const TONE_MARKS = {
  'ā': ['a', 1], 'á': ['a', 2], 'ǎ': ['a', 3], 'à': ['a', 4],
  'ē': ['e', 1], 'é': ['e', 2], 'ě': ['e', 3], 'è': ['e', 4],
  'ī': ['i', 1], 'í': ['i', 2], 'ǐ': ['i', 3], 'ì': ['i', 4],
  'ō': ['o', 1], 'ó': ['o', 2], 'ǒ': ['o', 3], 'ò': ['o', 4],
  'ū': ['u', 1], 'ú': ['u', 2], 'ǔ': ['u', 3], 'ù': ['u', 4],
  'ǖ': ['ü', 1], 'ǘ': ['ü', 2], 'ǚ': ['ü', 3], 'ǜ': ['ü', 4],
};

// Strip HTML, normalize whitespace.
export function clean(text = '') {
  return String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\[sound:[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// One accented syllable -> {base, tone}
function convertSyllable(syl) {
  let tone = 5; // neutral by default
  let base = '';
  for (const ch of syl) {
    if (TONE_MARKS[ch]) {
      const [b, t] = TONE_MARKS[ch];
      base += b;
      tone = t;
    } else {
      base += ch;
    }
  }
  // Trailing digit tone notation (e.g. "ni3")
  const m = base.match(/([a-zü:]+)([1-5])$/i);
  if (m) { base = m[1]; tone = Number(m[2]); }
  return { base, tone };
}

// Accented or numbered pinyin -> array of tone numbers.
export function tonesOf(pinyin = '') {
  const p = clean(pinyin).toLowerCase();
  if (!p) return [];
  return p.split(/[\s'·]+/).filter(Boolean).map(s => convertSyllable(s).tone);
}

export function tonePattern(pinyin = '') {
  const t = tonesOf(pinyin);
  return t.length ? t.join('-') : null;
}

// Normalize a spoken/target string for speaking-card comparison: hanzi only,
// strip punctuation & spaces.
export function normalizeHanzi(text = '') {
  return clean(text).replace(/[\s\p{P}\p{S}]/gu, '');
}
