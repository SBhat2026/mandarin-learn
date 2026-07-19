// Tone-colored hanzi and pinyin. Coloring is consistent across the whole app so
// the learner builds tonal memory implicitly while reading.
import { TONE_COLORS, toneSpans, pinyinSyllables, toneOf } from '../lib/tones.js';

export function TonedHanzi({ hanzi, pinyin, className = '', size = 'text-6xl' }) {
  const { chars, aligned } = toneSpans(hanzi, pinyin);
  return (
    <span className={`hanzi ${size} leading-tight tracking-wide ${className}`}>
      {chars.map((c, i) => (
        <span key={i} style={aligned && c.tone != null ? { color: TONE_COLORS[c.tone] } : undefined}>
          {c.text}
        </span>
      ))}
    </span>
  );
}

export function TonedPinyin({ pinyin, className = '' }) {
  const syl = pinyinSyllables(pinyin);
  return (
    <span className={className}>
      {syl.map((s, i) => (
        <span key={i} style={{ color: TONE_COLORS[toneOf(s)] }}>{s}{i < syl.length - 1 ? ' ' : ''}</span>
      ))}
    </span>
  );
}

// Inline colored sentence: aligns characters to pinyin when counts match.
export function TonedSentence({ hanzi, pinyin, className = '', size = 'text-3xl' }) {
  return <TonedHanzi hanzi={hanzi} pinyin={pinyin} className={className} size={size} />;
}
