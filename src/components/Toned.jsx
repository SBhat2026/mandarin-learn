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

// Progressive script: emphasis shifts with reading level.
//   'pinyin'   → pinyin primary, hanzi small + secondary (beginners)
//   'balanced' → hanzi and pinyin both prominent
//   'hanzi'    → hanzi primary, pinyin faded (revealed on hover)
export function ScriptBubble({ hanzi, pinyin, english, mode = 'pinyin', hanziSize = 'text-2xl' }) {
  if (mode === 'pinyin') {
    return (
      <div>
        <div className="text-lg font-medium"><TonedPinyin pinyin={pinyin} /></div>
        <div className="hanzi text-[15px] text-ink-faint mt-0.5">{hanzi}</div>
        {english && <div className="text-sm text-ink-soft mt-1">{english}</div>}
      </div>
    );
  }
  if (mode === 'hanzi') {
    return (
      <div className="group">
        <TonedHanzi hanzi={hanzi} pinyin={pinyin} size={hanziSize} />
        <div className="mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"><TonedPinyin pinyin={pinyin} className="text-sm" /></div>
        {english && <div className="text-sm text-ink-soft mt-1">{english}</div>}
      </div>
    );
  }
  return (
    <div>
      <TonedHanzi hanzi={hanzi} pinyin={pinyin} size={hanziSize} />
      <div className="mt-1"><TonedPinyin pinyin={pinyin} className="text-sm" /></div>
      {english && <div className="text-sm text-ink-soft mt-1">{english}</div>}
    </div>
  );
}

export function scriptModeFromLevel(level = 0) {
  return level < 0.33 ? 'pinyin' : level < 0.66 ? 'balanced' : 'hanzi';
}
