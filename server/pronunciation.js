// Invisible pronunciation analysis. Given a target word and what the learner
// actually produced — the STT transcript (recognized characters), STT
// alternatives, an acoustic tone contour measured in the browser, and speech
// timing — this infers *probable* tone confusion, initial (consonant) confusion,
// final (vowel) confusion, fluency, hesitation, and confidence.
//
// Everything here is a hidden signal: it feeds the learner model, mastery, and
// Laoshi's behavior. No score is ever surfaced to the learner. It degrades
// gracefully — with only a transcript (no acoustic pitch) it still infers tones
// from the recognized characters; with only acoustic pitch (no STT, e.g. Safari)
// it still infers tones from the contour.
import { db } from './db.js';
import { tonesOf, clean, normalizeHanzi } from './pinyin.js';

const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l',
  'g', 'k', 'h', 'j', 'q', 'x', 'z', 'c', 's', 'r', 'y', 'w'];

// Initials the ear/STT most often swaps — used to weight a confusion as "likely"
// rather than random noise. Symmetric pairs.
const INITIAL_NEIGHBORS = [
  ['zh', 'z'], ['ch', 'c'], ['sh', 's'], ['zh', 'j'], ['ch', 'q'], ['sh', 'x'],
  ['n', 'l'], ['f', 'h'], ['b', 'p'], ['d', 't'], ['g', 'k'], ['r', 'l'], ['r', 'y'],
];
const FINAL_NEIGHBORS = [
  ['an', 'ang'], ['en', 'eng'], ['in', 'ing'], ['uan', 'uang'],
  ['e', 'o'], ['ie', 'ei'], ['ou', 'uo'], ['un', 'ong'], ['u', 'ü'], ['i', 'ü'],
];

const pinyinSyllables = (p = '') => clean(p).toLowerCase().split(/[\s'·]+/).filter(Boolean);

// Toneless, ASCII-folded syllable body.
function baseSyllable(syl = '') {
  return String(syl).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/v/g, 'ü')
    .replace(/[0-9]/g, '').replace(/[^a-zü]/g, '');
}

// Split a pinyin syllable into { initial, final } (no tone).
export function splitSyllable(syl = '') {
  const b = baseSyllable(syl);
  let initial = '';
  for (const i of INITIALS) { if (b.startsWith(i)) { initial = i; break; } }
  return { initial, final: b.slice(initial.length) };
}

const pairListed = (list, a, b) => list.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

// ---------------------------------------------------------------------------
// Hanzi → pinyin, so we can map an STT transcript back to sounds and tones.
// Prefers the app's own `words` table (matches the learner's material), then
// falls back to per-character CC-CEDICT readings.
// ---------------------------------------------------------------------------
export function pinyinForHanzi(hanzi = '') {
  const h = normalizeHanzi(hanzi);
  if (!h) return '';
  const whole = db().prepare('SELECT pinyin FROM words WHERE hanzi=?').get(h);
  if (whole?.pinyin) return whole.pinyin;
  // Character by character.
  const out = [];
  for (const ch of h) {
    const w = db().prepare('SELECT pinyin FROM words WHERE hanzi=?').get(ch);
    if (w?.pinyin) { out.push(w.pinyin); continue; }
    const d = db().prepare('SELECT pinyin FROM dictionary WHERE simplified=? LIMIT 1').get(ch);
    if (d?.pinyin) out.push(d.pinyin.split(/\s+/)[0]);
  }
  return out.join(' ');
}

// Rough English gloss for a hanzi string, used only as a fallback when the
// teacher model forgets to include one — a beginner should never see a reply
// with no English at all. Prefers a whole-word gloss, else joins per-word/char
// meanings with a middot. Not a fluent translation; just a meaning scaffold.
export function glossForHanzi(hanzi = '') {
  const h = normalizeHanzi(hanzi);
  if (!h) return '';
  // COALESCE, because plenty of imported rows carry `english` with `gloss` NULL. Without
  // it those words fell through to the raw dictionary, which is ordered by entry and
  // whose FIRST entry is often a cross-reference: 词 was taught as "old variant of
  // 詞|词[ci2" while its own words row said "word; statement; speech".
  const whole = db().prepare('SELECT COALESCE(gloss, english) g FROM words WHERE hanzi=? AND COALESCE(gloss, english) IS NOT NULL').get(h);
  if (whole?.g) return whole.g;
  const out = [];
  for (const ch of h) {
    const w = db().prepare('SELECT COALESCE(gloss, english) g FROM words WHERE hanzi=? AND COALESCE(gloss, english) IS NOT NULL').get(ch);
    if (w?.g) { out.push(w.g.split(/[;,]/)[0].trim()); continue; }
    out.push(bestDictionaryGloss(ch));
  }
  return out.filter(Boolean).join(' · ');
}

// A character can have several dictionary entries, and the first is frequently
// bookkeeping rather than a meaning. Take the first entry that actually says what the
// character MEANS.
const NON_MEANING_DEF = /^(old variant|variant of|surname\b|abbr\.? for|used in|see )/i;
function bestDictionaryGloss(ch) {
  const rows = db().prepare('SELECT definitions FROM dictionary WHERE simplified=? LIMIT 6').all(ch);
  const defs = [];
  for (const r of rows) {
    try { for (const d of JSON.parse(r.definitions)) defs.push(String(d).trim()); } catch {}
  }
  return defs.find(d => d && !NON_MEANING_DEF.test(d)) || defs[0] || '';
}

// ---------------------------------------------------------------------------
// The analysis. Pure aside from the dictionary lookups above.
// ---------------------------------------------------------------------------
// spoken = { transcript, alternatives:[], heardTones:[1..5]|null, timing:{latencyMs, speechMs, totalMs} }
export function analyzeSpoken({ targetHanzi = '', targetPinyin = '', spoken = {} }) {
  const { transcript = '', alternatives = [], heardTones = null, timing = {} } = spoken || {};

  const targetTones = tonesOf(targetPinyin);
  const targetSyls = pinyinSyllables(targetPinyin).map(splitSyllable);
  const n = targetSyls.length;

  // Best recognized string: the alternative whose characters match the target
  // most closely (STT's first guess is often auto-corrected by language model).
  const cand = [transcript, ...alternatives].filter(Boolean);
  const tgtNorm = normalizeHanzi(targetHanzi);
  let recognized = transcript;
  let bestOverlap = -1;
  for (const c of cand) {
    const cn = normalizeHanzi(c);
    const overlap = cn === tgtNorm ? 100 : [...cn].filter(ch => tgtNorm.includes(ch)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; recognized = c; }
  }
  const contentMatch = tgtNorm && normalizeHanzi(transcript).includes(tgtNorm);

  const recPinyin = pinyinForHanzi(recognized);
  const recSyls = pinyinSyllables(recPinyin).map(splitSyllable);
  const recTones = tonesOf(recPinyin);

  // ---- Tones: prefer the acoustic contour, fall back to recognized characters.
  const acoustic = Array.isArray(heardTones) && heardTones.length ? heardTones : null;
  let heard = acoustic ? acoustic.slice(0, n) : (recTones.length === n ? recTones : []);
  // Pad/trim to target length so patterns line up.
  if (heard.length && heard.length < n) heard = heard.concat(Array(n - heard.length).fill(0));

  const toneErrors = [];
  for (let i = 0; i < n && i < heard.length; i++) {
    const t = targetTones[i], h = heard[i];
    if (!t || !h || h === 0) continue;          // 0 = uncertain/neutral, skip
    if (t !== h) toneErrors.push({ i, target: t, heard: h });
  }

  // ---- Segmental confusion: only when the recognized syllable count matches,
  // so we're comparing like with like (else STT heard a different word entirely).
  const initialErrors = [], finalErrors = [];
  if (recSyls.length === n && !contentMatch) {
    for (let i = 0; i < n; i++) {
      const tSyl = targetSyls[i], rSyl = recSyls[i];
      if (tSyl.initial !== rSyl.initial) {
        initialErrors.push({ target: tSyl.initial || '∅', heard: rSyl.initial || '∅',
          likely: pairListed(INITIAL_NEIGHBORS, tSyl.initial, rSyl.initial) });
      }
      if (tSyl.final !== rSyl.final) {
        finalErrors.push({ target: tSyl.final, heard: rSyl.final,
          likely: pairListed(FINAL_NEIGHBORS, tSyl.final, rSyl.final) });
      }
    }
  }

  // ---- Fluency / hesitation from acoustic timing (all invisible, 0..1).
  const { latencyMs = null, speechMs = null } = timing;
  const expectedMs = Math.max(300, n * 380);    // ~380ms per syllable is relaxed-beginner pace
  let fluency = null, hesitation = null;
  if (speechMs != null && speechMs > 0) {
    // Too long = laboured; near expected = fluent.
    const ratio = speechMs / expectedMs;
    fluency = clamp01(1 - Math.max(0, ratio - 1.15) * 0.6);
  }
  if (latencyMs != null) {
    // >1.2s before speaking reads as hesitation.
    hesitation = clamp01((latencyMs - 400) / 2000);
  }

  // ---- Combined correctness (hidden) → drives the pronunciation mastery update.
  const toneAcc = n ? 1 - Math.min(1, toneErrors.length / n) : (contentMatch ? 1 : 0.5);
  const segPenalty = Math.min(0.5, 0.12 * (initialErrors.length + finalErrors.length));
  let accuracy = clamp01(0.55 * toneAcc + 0.30 * (contentMatch ? 1 : 0.4) + 0.15 * (fluency ?? 0.6) - segPenalty);

  // ---- Confidence: fast, fluent, on-target = confident.
  let confidence = null;
  if (latencyMs != null || fluency != null) {
    confidence = clamp01(0.4 * (contentMatch ? 1 : 0.3)
      + 0.3 * (fluency ?? 0.5)
      + 0.3 * (1 - (hesitation ?? 0.5)));
  }

  return {
    targetTonePattern: targetTones.join('-') || null,
    heardTonePattern: heard.length ? heard.join('-') : null,
    toneSource: acoustic ? 'acoustic' : (heard.length ? 'transcript' : 'none'),
    toneErrors, initialErrors, finalErrors,
    contentMatch: !!contentMatch,
    fluency, hesitation, confidence, accuracy,
  };
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Map hidden accuracy → an FSRS rating so the shared memory card still schedules.
export function accuracyToRating(accuracy) {
  if (accuracy >= 0.85) return 4;
  if (accuracy >= 0.65) return 3;
  if (accuracy >= 0.4) return 2;
  return 1;
}

// Persist one attempt's hidden pronunciation signal.
export function persistPronunciation({ wordId = null, source = 'exercise', analysis }) {
  if (!analysis) return;
  db().prepare(`INSERT INTO pron_signals
    (ts, word_id, source, tone_source, target_tone, heard_tone, initial_conf, final_conf, fluency, hesitation, confidence, accuracy)
    VALUES(datetime('now'),?,?,?,?,?,?,?,?,?,?,?)`).run(
    wordId, source, analysis.toneSource,
    analysis.targetTonePattern, analysis.heardTonePattern,
    JSON.stringify(analysis.initialErrors || []),
    JSON.stringify(analysis.finalErrors || []),
    analysis.fluency, analysis.hesitation, analysis.confidence, analysis.accuracy,
  );
}

// ── Pinyin orthography ──────────────────────────────────────────────────────
// Pinyin is written by WORD, not by syllable (GB/T 16159): 高中 is `gāozhōng`, not
// `gāo zhōng`. Our imported data disagrees — 8668 of 8736 two-character words store
// their reading space-separated — so the learner was reading syllable soup, and the
// app's own teaching doctrine ("wǒmen, not wǒ men") contradicted its output.
// Normalising at render time rather than migrating the data keeps the source
// dictionaries untouched and fixes every call site at once.
const TONE_TO_PLAIN = { ā: 'a', á: 'a', ǎ: 'a', à: 'a', ē: 'e', é: 'e', ě: 'e', è: 'e',
  ī: 'i', í: 'i', ǐ: 'i', ì: 'i', ō: 'o', ó: 'o', ǒ: 'o', ò: 'o',
  ū: 'u', ú: 'u', ǔ: 'u', ù: 'u', ǖ: 'ü', ǘ: 'ü', ǚ: 'ü', ǜ: 'ü' };

export function toneNumber(syllable = '') {
  const s = String(syllable).toLowerCase();
  for (const ch of s) {
    const t = '01234'.indexOf('x') , m = { 1: 'āēīōū ǖ', 2: 'áéíóú ǘ', 3: 'ǎěǐǒǔ ǚ', 4: 'àèìòù ǜ' };
    for (const [n, set] of Object.entries(m)) if (set.includes(ch)) return Number(n);
  }
  return 0;
}

// One word's syllables run together. Apostrophe where the join would be ambiguous —
// 西安 is `Xī'ān`, not `Xīan`.
export function joinSyllables(pinyin = '') {
  const syls = String(pinyin).trim().split(/\s+/).filter(Boolean);
  if (syls.length <= 1) return String(pinyin).trim();
  let out = syls[0];
  for (const s of syls.slice(1)) {
    const firstPlain = TONE_TO_PLAIN[s[0]] || s[0];
    out += /[aoe]/.test(firstPlain) ? `'${s}` : s;
  }
  return out;
}

// 一 and 不 sandhi IS written in teaching materials, because it is lexicalised and
// the learner has to say it that way. Third-tone sandhi (3-3 → 2-3) is NOT written —
// that one stays a pronunciation fact, per the standard and per our own doctrine.
export function applySandhi(syllables = []) {
  const out = [...syllables];
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i], next = out[i + 1];
    const bare = String(cur).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // Some syllables are neutral on the surface but carry an underlying tone that
    // still triggers sandhi — 个 is toneless in speech yet 一个 is `yí ge`, because
    // 个 is underlyingly 4th. Without this the commonest phrase in the language
    // rendered as "yī ge".
    const nextBare = String(next).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const nt = toneNumber(next) || UNDERLYING_TONE[nextBare] || 0;
    if (bare === 'yi') out[i] = nt === 4 ? 'yí' : (nt >= 1 && nt <= 3 ? 'yì' : cur);
    else if (bare === 'bu') out[i] = nt === 4 ? 'bú' : cur;
  }
  return out;
}

// Readings that depend on the word around them. 只 is `zhī` as a measure word and
// `zhǐ` as "only" — the dictionary's first reading gave "yī zhǐ māo" for 一只猫,
// which is a different word and the wrong sound.
// Neutral-tone syllables whose underlying tone still conditions 一/不 sandhi.
const UNDERLYING_TONE = { ge: 4, xie: 1, zi: 3, men: 2, le: 4, de: 4 };

const MEASURE = new Set(['个', '只', '本', '条', '杯', '件', '张', '把', '支', '辆', '匹', '位', '些', '点']);
const NUMERAL = /^[一二两三四五六七八九十几这那每半]$/;

const CONTEXT_READING = [
  { char: '只', when: (prev) => /^[一二两三四五六七八九十几这那每]$/.test(prev || ''), read: 'zhī' },
  { char: '长', when: (prev, next) => next === '大', read: 'zhǎng' },
  { char: '行', when: (prev) => /^[银不]$/.test(prev || ''), read: 'háng' },
  { char: '觉', when: (prev) => prev === '睡', read: 'jiào' },
  { char: '乐', when: (prev) => /^[音]$/.test(prev || ''), read: 'yuè' },
];
export function contextualReading(chars, i, fallback) {
  for (const r of CONTEXT_READING) {
    if (chars[i] === r.char && r.when(chars[i - 1], chars[i + 1])) return r.read;
  }
  return fallback;
}

// The reading of a whole sentence, written properly: segmented into words, each word
// run together, words separated by spaces, sandhi applied across the whole line.
export function pinyinForText(text = '') {
  const h = normalizeHanzi(text);
  if (!h) return '';
  const chars = [...h];
  const wordRow = db().prepare('SELECT pinyin FROM words WHERE hanzi=? AND pinyin IS NOT NULL');
  const words = [];
  let i = 0;
  while (i < chars.length) {
    let taken = null;
    for (let len = Math.min(4, chars.length - i); len >= 2; len--) {
      const cand = chars.slice(i, i + len).join('');
      // A measure word binds LEFT to the number in front of it, so greedy matching
      // must not swallow it into the following noun: 一个人 is 一+个 人, and taking
      // 个人 ("individual") as the word produced "yí gèrén".
      if (MEASURE.has(cand[0]) && NUMERAL.test(chars[i - 1] || '')) continue;
      const row = wordRow.get(cand);
      if (row?.pinyin) { taken = { syls: String(row.pinyin).trim().split(/\s+/), len }; break; }
    }
    if (!taken) {
      const single = pinyinForHanzi(chars[i]);
      taken = { syls: [contextualReading(chars, i, single)], len: 1 };
    }
    words.push(taken);
    i += taken.len;
  }
  // Sandhi runs across the flattened syllable stream, then syllables regroup by word.
  const flat = applySandhi(words.flatMap(w => w.syls));
  const out = [];
  let k = 0;
  for (const w of words) { out.push(joinSyllables(flat.slice(k, k + w.syls.length).join(' '))); k += w.syls.length; }
  return out.join(' ');
}
