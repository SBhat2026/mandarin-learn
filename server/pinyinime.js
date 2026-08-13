// Pinyin IME-lite: the learner types toneless pinyin ("wo xihuan mao", even
// "wo xihuan nao" with a typo) and gets a hanzi conversion built from the word
// database — frequency-ranked, longest-word-first, with edit-distance-1
// autocorrect against the legal syllable inventory. Powers the Converse input so
// typing pinyin is a first-class way to SPEAK (in text) from day one.
import { db } from './db.js';
import { knownWordIds } from './planner.js';

const strip = (s = '') => String(s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/ü/g, 'v').replace(/[^a-z]/g, ' ').replace(/\s+/g, ' ').trim();
const solid = (s = '') => strip(s).replace(/ /g, '');

let _cache = null;
function tables() {
  if (_cache) return _cache;
  const words = db().prepare(`SELECT hanzi, pinyin, gloss, english, freq_rank, register, particle FROM words
    WHERE pinyin IS NOT NULL AND pinyin != ''`).all();
  const byPinyin = new Map();      // toneless solid pinyin → [{hanzi, freq, syls}]
  const syllables = new Set();     // legal syllable inventory (from real word pinyin)
  const sylFreq = new Map();       // how "expected" a syllable is, from word frequency
  for (const w of words) {
    const toks = strip(w.pinyin).split(' ').filter(Boolean);
    if (!toks.length) continue;
    const weight = 1 / Math.log10((w.freq_rank ?? 999999) + 10);
    for (const t of toks) if (t.length <= 6) {
      syllables.add(t);
      sylFreq.set(t, (sylFreq.get(t) || 0) + weight);
    }
    const key = toks.join('');
    if (!byPinyin.has(key)) byPinyin.set(key, []);
    // Syllable count from the HANZI (unspaced DB pinyin makes token count wrong).
    byPinyin.get(key).push({ hanzi: w.hanzi, pinyin: w.pinyin,
      gloss: (w.gloss || w.english || '').split(/[;,]/)[0].trim().slice(0, 24),
      freq: w.freq_rank ?? 999999, register: w.register || 'both', particle: !!w.particle,
      syls: [...w.hanzi].filter(c => /[一-鿿]/.test(c)).length });
  }
  for (const list of byPinyin.values()) list.sort((a, b) => a.freq - b.freq);
  _cache = { byPinyin, syllables, sylFreq, maxSyl: 6 };
  return _cache;
}

// Edit-distance-1 variants of a chunk (deletion, substitution, insertion, swap).
function ed1(chunk) {
  const out = new Set();
  const az = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < chunk.length; i++) {
    out.add(chunk.slice(0, i) + chunk.slice(i + 1));                       // delete
    for (const c of az) out.add(chunk.slice(0, i) + c + chunk.slice(i + 1)); // substitute
    if (i < chunk.length - 1) out.add(chunk.slice(0, i) + chunk[i + 1] + chunk[i] + chunk.slice(i + 2)); // swap
  }
  for (let i = 0; i <= chunk.length; i++)
    for (const c of az) out.add(chunk.slice(0, i) + c + chunk.slice(i));   // insert
  out.delete(chunk);
  return out;
}

// Segment a solid toneless string into legal syllables. DP preferring fewer,
// longer syllables; a position with no legal match tries autocorrected variants.
function segmentSyllables(s, { syllables, sylFreq } = tables()) {
  const n = s.length;
  // best[i] = {cost, syls} covering s[0..i)
  const best = Array(n + 1).fill(null);
  best[0] = { cost: 0, syls: [] };
  for (let i = 0; i < n; i++) {
    if (!best[i]) continue;
    for (let len = Math.min(6, n - i); len >= 1; len--) {
      const chunk = s.slice(i, i + len);
      let candidates = null;
      if (syllables.has(chunk)) candidates = [{ syl: chunk, penalty: 0 }];
      else if (len >= 2) {
        // autocorrect: edit-distance-1 variants that are legal syllables, most
        // COMMON syllable first ("hoa" → hao, not ha) with a small extra penalty
        // for rarer fixes so the likely one wins the DP.
        const fixes = [...ed1(chunk)].filter(v => v.length >= 1 && v.length <= 6 && syllables.has(v))
          .sort((a, b) => (sylFreq.get(b) || 0) - (sylFreq.get(a) || 0));
        if (fixes.length) candidates = fixes.slice(0, 3).map((f, rank) => ({ syl: f, penalty: 1.5 + rank * 0.2 }));
      }
      if (!candidates) continue;
      for (const c of candidates) {
        const cost = best[i].cost + 1 + c.penalty;   // fewer syllables + fewer fixes win
        if (!best[i + len] || cost < best[i + len].cost) {
          best[i + len] = { cost, syls: [...best[i].syls, c.syl] };
        }
      }
    }
  }
  return best[n]?.syls || null;
}

// Sentence-final mood particles: when a turn ends on one of these syllables, the
// particle reading is nearly always the intended one (你好吗 not 你好马).
const FINAL_PARTICLES = new Set(['吗', '呢', '吧', '啊', '了', '呀']);

// The learner's own vocabulary, as hanzi — a typist types what they've LEARNED,
// so known words get a strong boost in the conversion (你好 over 号码).
function knownHanziSet() {
  const ids = [...knownWordIds()];
  if (!ids.length) return new Set();
  const ph = ids.map(() => '?').join(',');
  return new Set(db().prepare(`SELECT hanzi FROM words WHERE id IN (${ph})`).all(...ids).map(r => r.hanzi));
}

// Cover a syllable sequence with dictionary words (DP: length + frequency +
// known-to-the-learner). Returns the word list or null when uncoverable.
function wordsFor(syls, t = tables(), known = knownHanziSet()) {
  const { byPinyin, maxSyl } = t;
  const n = syls.length;
  const best = Array(n + 1).fill(null);
  best[0] = { score: 0, words: [] };
  // Length + frequency + learner-knows-it + spoken-register: the typist is
  // producing conversational Mandarin, so literary homophones lose ties. Rare
  // SINGLE characters are heavily penalized — a learner typing "pinggou" means
  // the word 苹果, not the improbable char sequence 瓶+狗.
  const wordScore = (w, len) => len * len * 10 + Math.max(0, 6 - Math.log10(w.freq + 10)) * 3
    + (known.has(w.hanzi) ? 12 * len : 0) + (w.register === 'written' ? -6 : w.register === 'spoken' ? 2 : 0)
    - (len === 1 && w.freq > 1500 && !known.has(w.hanzi) ? 14 : 0);
  for (let i = 0; i < n; i++) {
    if (!best[i]) continue;
    for (let len = Math.min(maxSyl, n - i); len >= 1; len--) {
      const key = syls.slice(i, i + len).join('');
      let hits = byPinyin.get(key);
      let fuzzPenalty = 0;
      // Typo rescue for multi-syllable words: "pinggou" is two legal syllables so
      // syllable-level autocorrect never fires, but 苹果 (pingguo) is one edit away.
      // When a 2-3 syllable span has no exact word, try edit-distance-1 keys and
      // take the most FREQUENT resulting word — ed1() order is arbitrary, so
      // first-hit would pick 并购 (binggou) over 苹果 by pure luck.
      if (!hits?.length && len >= 2 && len <= 3 && key.length <= 9) {
        let bestFuzz = null;
        for (const v of ed1(key)) {
          const h = byPinyin.get(v);
          if (!h?.length || h[0].syls !== len) continue;
          if (!bestFuzz || h[0].freq < bestFuzz[0].freq) bestFuzz = h;
        }
        // Penalty is deliberately smaller than the two-unigrams-vs-one-bigram gap:
        // a one-typo real word (苹果) is likelier than two unrelated chars (瓶+够),
        // but an EXACT match for the same span always still wins.
        if (bestFuzz) { hits = bestFuzz; fuzzPenalty = 6; }
      }
      if (!hits?.length) continue;
      // Consider the top few candidates for this span, not just the most frequent.
      for (const w of hits.slice(0, 4)) {
        // Sentence-final MOOD particle preference: a trailing "ma/ne/ba" is 吗/呢/吧.
        // Deliberately an explicit set — `particle` covers every function word
        // (够, 个, 都…), and a blanket bonus made trailing content words win.
        const particleBonus = (i + len === n && FINAL_PARTICLES.has(w.hanzi)) ? 10 : 0;
        const score = best[i].score + wordScore(w, len) - fuzzPenalty + particleBonus;
        if (!best[i + len] || score > best[i + len].score) {
          best[i + len] = { score, words: [...best[i].words, { ...w, alts: hits.filter(h => h !== w).slice(0, 3).map(h => h.hanzi) }] };
        }
      }
    }
    // Uncoverable syllable → skip it (keeps partial conversions usable).
    if (!best[i + 1]) best[i + 1] = { score: best[i].score - 100, words: [...best[i].words, null] };
  }
  return best[n]?.words?.filter(Boolean) || null;
}

// Is this latin input plausibly pinyin (vs English)? Fraction of it that
// segments into legal syllables without corrections.
function pinyinness(s) {
  const t = tables();
  const solidStr = solid(s);
  if (!solidStr) return 0;
  let covered = 0, i = 0;
  while (i < solidStr.length) {
    let hit = 0;
    for (let len = Math.min(6, solidStr.length - i); len >= 1; len--) {
      if (t.syllables.has(solidStr.slice(i, i + len))) { hit = len; break; }
    }
    if (hit) { covered += hit; i += hit; } else i += 1;
  }
  return covered / solidStr.length;
}

// Public: convert typed pinyin → hanzi. Honors the learner's own token spacing
// first (spaces are syllable hints), then falls back to solid-string DP.
export function convertPinyin(input) {
  const t = tables();
  const raw = String(input || '').trim();
  if (!raw) return { ok: false };
  const pn = pinyinness(raw);
  if (pn < 0.7) return { ok: false, isPinyin: false, pinyinness: Number(pn.toFixed(2)) };

  const syls = segmentSyllables(solid(raw), t);
  if (!syls?.length) return { ok: false, isPinyin: true };
  const words = wordsFor(syls, t);
  if (!words?.length) return { ok: false, isPinyin: true };

  return {
    ok: true, isPinyin: true,
    hanzi: words.map(w => w.hanzi).join(''),
    pinyin: words.map(w => w.pinyin).join(' '),
    corrected: syls.join(' '),
    words: words.map(w => ({ hanzi: w.hanzi, pinyin: w.pinyin, gloss: w.gloss, alts: w.alts })),
  };
}

// ── Is this actually pinyin, or is it English? ──────────────────────────────
// `pinyinness` measures how much of a SOLID string is covered by legal syllables,
// which English passes far too easily: "I have a computer" scores well above the 0.7
// threshold and converted to 差可啊凑铺个儿. Once the learner was expected to type
// rather than tap, that turned every English aside into a garbage "correction" —
// "I'm in my house" came back as "Mǐn2.zú hòu sè".
//
// The reliable test is per TOKEN, with no autocorrect: a real pinyin word segments
// exactly into legal syllables. "mao", "ni hao", "wo xihuan kan shu" do. "my",
// "hello", "computer" do not, and one failing token is enough.
const ENGLISH_STOP = new Set(['a', 'i', 'is', 'it', 'in', 'im', 'my', 'me', 'the', 'to', 'do', 'you',
  'have', 'has', 'want', 'this', 'that', 'what', 'why', 'how', 'and', 'or', 'but', 'not', 'no', 'yes',
  'am', 'are', 'was', 'were', 'be', 'can', 'will', 'would', 'of', 'for', 'with', 'on', 'at', 'so',
  'like', 'know', 'say', 'said', 'go', 'going', 'get', 'about', 'something', 'different', 'teacher']);

function segmentsExactly(s, t = tables()) {
  const n = s.length;
  if (!n) return false;
  const ok = Array(n + 1).fill(false);
  ok[0] = true;
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    for (let len = Math.min(6, n - i); len >= 1; len--) {
      if (t.syllables.has(s.slice(i, i + len))) ok[i + len] = true;
    }
  }
  return ok[n];
}

export function isConfidentPinyin(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return false;
  if (/[''’]/.test(raw)) return false;                       // English contractions
  if (/[^a-zü0-9\sÀ-ɏ]/.test(raw)) return false;   // punctuation → prose
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const t = tables();
  let english = 0;
  for (const tok of tokens) {
    const clean = tok.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zü]/g, '');
    if (!clean) return false;
    if (!segmentsExactly(clean, t)) return false;      // one impossible token is enough
    if (ENGLISH_STOP.has(clean)) english++;
  }
  // Some tokens are genuinely both: `you` is English and also 有 (yǒu), `he` is 和,
  // `me` is 么. So a stopword cannot veto on its own — it takes a MAJORITY for the
  // line to be English. "wo you yi zhi mao" is 1/5 and stays pinyin; "do you like
  // it" is 4/4 and does not.
  return english / tokens.length < 0.5;
}
