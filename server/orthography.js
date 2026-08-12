// Hanzi acceleration — the orthographic engine.
//
// Reading Chinese is the slow half of this app, and the reason is structural: a
// learner who treats characters as 3,000 unrelated pictures is doing 3,000 units of
// work. The research says they aren't unrelated, and that the regularities are
// teachable:
//
//   • PHONETIC CONSISTENCY beats regularity. What predicts whether a learner can
//     guess a new character's reading is not "does this character sound like its
//     phonetic component" but "do the characters sharing this component agree with
//     each other" (Lee et al.; Ho & Bryant). Only ~38% of characters are strictly
//     regular, so nominal phonetics are a weak signal — measured consistency is a
//     strong one. 方 → fāng holds for 仿妨房放纺肪芳访防 (9/9); 一 as a "phonetic"
//     predicts nothing. We therefore MEASURE consistency instead of trusting the
//     decomposition's `phonetic` field.
//   • Phonetic radicals support orthographic learning via SELF-TEACHING (Shu et al.):
//     a learner who can guess a reading and then have it confirmed acquires the
//     character far faster than one who is told. So the move is "predict, then
//     check" — never "here is a fact".
//   • SEMANTIC RADICALS let learners INFER the meaning of unseen characters in
//     context (Wang et al., Frontiers 2017). Notably, explicit radical instruction
//     HURTS 1–3 day retention and HELPS at 4+ days — so these get long intervals and
//     are never judged on immediate recall.
//   • COVERAGE governs comprehension: ~95% of tokens known for reasonable
//     comprehension, ~98% for comfortable (Laufer; Hu & Nation). In Chinese the top
//     1,000 characters cover ~90% of running text and 2,000 cover ~97%, so character
//     coverage is the lever that makes reading feel possible at all.
//
// Everything here is derived from data already in the DB (char_meta's decomposition,
// radical, phonetic + the word list); nothing is hand-authored.
import { db } from './db.js';
import { knownWordIds } from './planner.js';

const CJK = /[一-鿿]/;
const isCjk = (c) => CJK.test(c);

// Pinyin without tone marks or spaces — the unit consistency is measured over. Tone
// is deliberately ignored: a learner who guesses "fang" for 妨 has made the useful
// inference even if they miss the tone, and including tone shatters every series.
export function toneless(pinyin = '') {
  return String(pinyin).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
}

function firstReading(pinyinJson) {
  try { const a = JSON.parse(pinyinJson); return Array.isArray(a) ? a[0] : a; } catch { return pinyinJson || null; }
}

// ── Phonetic series, scored by measured consistency ──────────────────────────
// Built once per process (a few hundred ms over ~9.5k characters) and memoised.
let _series = null;

export function phoneticSeries() {
  if (_series) return _series;
  // Only characters that actually occur in the learner's word list count — series
  // padded with characters nobody will ever meet are not worth teaching.
  const inUse = new Set();
  for (const w of db().prepare('SELECT hanzi FROM words').all()) for (const c of w.hanzi) if (isCjk(c)) inUse.add(c);

  const groups = new Map();
  for (const r of db().prepare('SELECT hanzi, pinyin, phonetic FROM char_meta WHERE phonetic IS NOT NULL').all()) {
    if (!inUse.has(r.hanzi) || r.phonetic === r.hanzi) continue;
    const reading = firstReading(r.pinyin);
    if (!reading) continue;
    if (!groups.has(r.phonetic)) groups.set(r.phonetic, []);
    groups.get(r.phonetic).push({ hanzi: r.hanzi, reading, key: toneless(reading) });
  }

  const out = new Map();
  for (const [phonetic, members] of groups) {
    if (members.length < 3) continue;
    const counts = new Map();
    for (const m of members) counts.set(m.key, (counts.get(m.key) || 0) + 1);
    const [dominant, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const consistency = n / members.length;
    out.set(phonetic, {
      phonetic,
      dominant,                                   // the reading the series predicts
      consistency,                                // measured, not assumed
      size: members.length,
      members,
      // The members that actually follow the rule — the ones worth showing together.
      regular: members.filter(m => m.key === dominant),
    });
  }
  _series = out;
  return out;
}

// A series is worth TEACHING when it predicts more often than not and has enough
// members to pay for the effort. Below this, showing it would teach a false rule.
const TEACHABLE_CONSISTENCY = 0.6;
const TEACHABLE_SIZE = 3;

export function teachableSeries() {
  return [...phoneticSeries().values()]
    .filter(s => s.consistency >= TEACHABLE_CONSISTENCY && s.regular.length >= TEACHABLE_SIZE)
    .sort((a, b) => b.regular.length * b.consistency - a.regular.length * a.consistency);
}

// The series a character belongs to, if that series is trustworthy enough to reason
// from. Returns null for 一/口/丿-style structural components, which is the point.
export function seriesFor(hanzi) {
  const row = db().prepare('SELECT phonetic FROM char_meta WHERE hanzi=?').get(hanzi);
  if (!row?.phonetic) return null;
  const s = phoneticSeries().get(row.phonetic);
  if (!s || s.consistency < TEACHABLE_CONSISTENCY) return null;
  return s;
}

// SELF-TEACHING: can the learner GUESS this character's reading from a series they
// already have evidence for? Returns the prediction plus the members that justify
// it, so the UI can say "you know 方, 房, 放 — so what does 访 sound like?" and only
// then confirm. `knownChars` is what they have actually met.
export function predictReading(hanzi, knownChars = new Set()) {
  const s = seriesFor(hanzi);
  if (!s) return null;
  const evidence = s.regular.filter(m => m.hanzi !== hanzi && knownChars.has(m.hanzi));
  if (!evidence.length && !knownChars.has(s.phonetic)) return null;
  const self = s.members.find(m => m.hanzi === hanzi);
  return {
    phonetic: s.phonetic,
    predicted: s.dominant,
    actual: self ? toneless(self.reading) : null,
    holds: self ? toneless(self.reading) === s.dominant : null,
    consistency: s.consistency,
    evidence: evidence.slice(0, 4).map(m => ({ hanzi: m.hanzi, reading: m.reading })),
  };
}

// ── Semantic radicals: inferring MEANING of an unmet character ───────────────
// The radical narrows the semantic field ("this is something to do with water"),
// which is exactly the inference that lets a reader keep going instead of stopping.
// Curated gloss for the high-yield radicals; anything else falls back to the
// radical's own dictionary meaning rather than inventing a story.
const RADICAL_SENSE = {
  '氵': 'water, liquid', '水': 'water', '木': 'tree, wood', '火': 'fire, heat', '灬': 'fire, heat',
  '土': 'earth, ground', '钅': 'metal', '金': 'metal', '石': 'stone', '山': 'mountain',
  '亻': 'a person', '人': 'a person', '女': 'woman', '子': 'child', '口': 'mouth, speaking, eating',
  '讠': 'speech, saying', '言': 'speech', '心': 'feeling, the heart', '忄': 'feeling, the heart',
  '扌': 'the hand, doing', '手': 'the hand', '足': 'the foot, walking', '辶': 'movement, going',
  '彳': 'walking, a road', '目': 'the eye, seeing', '耳': 'the ear', '页': 'the head',
  '艹': 'a plant', '竹': 'bamboo', '禾': 'grain, crops', '米': 'rice, grain', '食': 'food, eating',
  '饣': 'food, eating', '衣': 'clothing', '衤': 'clothing', '纟': 'thread, cloth', '巾': 'cloth',
  '虫': 'an insect or small creature', '鸟': 'a bird', '鱼': 'a fish', '犭': 'an animal', '马': 'a horse',
  '日': 'the sun, time', '月': 'the moon, or the body', '雨': 'weather', '车': 'a vehicle',
  '门': 'a door, a gate', '宀': 'a building, a roof', '广': 'a building', '疒': 'illness',
  '贝': 'money, value', '刀': 'a blade, cutting', '刂': 'a blade, cutting', '力': 'strength, effort',
};

export function semanticHint(hanzi) {
  const row = db().prepare('SELECT radical, semantic, definition FROM char_meta WHERE hanzi=?').get(hanzi);
  const radical = row?.semantic || row?.radical;
  if (!radical || radical === hanzi) return null;
  const sense = RADICAL_SENSE[radical];
  if (!sense) return null;
  return { radical, sense };
}

// Other characters the learner already knows that share this semantic radical —
// the family that makes the inference feel like a rule rather than a claim.
export function semanticFamily(radical, knownChars = new Set(), limit = 4) {
  if (!radical) return [];
  const rows = db().prepare(
    `SELECT hanzi, definition FROM char_meta WHERE (semantic=? OR radical=?) AND hanzi != ?`).all(radical, radical, radical);
  return rows.filter(r => knownChars.has(r.hanzi))
    .slice(0, limit)
    .map(r => ({ hanzi: r.hanzi, gloss: String(r.definition || '').split(/[;,]/)[0].trim() }));
}

// ── Coverage: the number that decides whether reading is possible ────────────
// Known-character coverage of a text. 95% ≈ reasonable comprehension, 98% ≈
// comfortable; below ~90% a text is decoding practice, not reading.
export function charCoverage(text, knownChars) {
  const chars = [...String(text || '')].filter(isCjk);
  if (!chars.length) return { coverage: 1, total: 0, unknown: [] };
  const unknown = chars.filter(c => !knownChars.has(c));
  return {
    coverage: (chars.length - unknown.length) / chars.length,
    total: chars.length,
    unknown: [...new Set(unknown)],
  };
}

export function readabilityBand(coverage) {
  if (coverage >= 0.98) return 'comfortable';
  if (coverage >= 0.95) return 'readable';
  if (coverage >= 0.90) return 'effortful';
  return 'too-hard';
}

// Every character the learner has met (via any word they have a card for), plus the
// characters of words they know solidly. Character-level, because reading is
// character-level even when vocabulary is word-level.
export function knownCharacters({ solidOnly = false } = {}) {
  const ids = solidOnly ? [...knownWordIds()] : null;
  const rows = solidOnly
    ? (ids.length ? db().prepare(`SELECT hanzi FROM words WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [])
    : db().prepare(`SELECT w.hanzi FROM words w JOIN cards c ON c.item_type='word' AND c.item_id=w.id`).all();
  const set = new Set();
  for (const r of rows) for (const c of r.hanzi) if (isCjk(c)) set.add(c);
  return set;
}

// ── High-yield next characters: what to teach for maximum unlock ─────────────
// Not "the next most frequent character" but the character that makes the MOST other
// characters guessable — the phonetic component of a consistent series the learner
// is about to keep meeting. This is the acceleration heuristic: learning 方 buys you
// nine characters' worth of reading, learning an equally frequent but isolated
// character buys you one.
export function highYieldCharacters(limit = 8) {
  const known = knownCharacters();
  const freq = new Map();
  for (const r of db().prepare('SELECT hanzi, freq_rank FROM words WHERE freq_rank IS NOT NULL').all()) {
    for (const c of r.hanzi) if (isCjk(c)) freq.set(c, Math.min(freq.get(c) ?? Infinity, r.freq_rank));
  }
  const out = [];
  for (const s of teachableSeries()) {
    if (known.has(s.phonetic)) continue;                        // already have the key
    const unlocks = s.regular.filter(m => !known.has(m.hanzi));
    if (unlocks.length < TEACHABLE_SIZE) continue;
    const rank = freq.get(s.phonetic) ?? 99999;
    out.push({
      hanzi: s.phonetic,
      reading: s.dominant,
      unlocks: unlocks.map(m => ({ hanzi: m.hanzi, reading: m.reading })),
      consistency: s.consistency,
      // Value = how many characters it makes predictable, tempered by how soon the
      // learner will actually meet the key itself.
      yield: unlocks.length * s.consistency + 2 / Math.log10(rank + 10),
    });
  }
  return out.sort((a, b) => b.yield - a.yield).slice(0, limit);
}

// A compact, honest readout of where the learner's reading actually stands. Used by
// the Reading track to say something true instead of a percentage of a syllabus.
export function readingProfile() {
  const met = knownCharacters();
  const solid = knownCharacters({ solidOnly: true });
  // Coverage of running text, estimated from character frequency in the word list
  // weighted by word frequency — a stand-in for a corpus we don't ship.
  const rows = db().prepare('SELECT hanzi, freq_rank FROM words WHERE freq_rank IS NOT NULL ORDER BY freq_rank ASC LIMIT 4000').all();
  let weighted = 0, total = 0;
  for (const r of rows) {
    const w = 1 / Math.log10((r.freq_rank || 9999) + 10);
    for (const c of r.hanzi) {
      if (!isCjk(c)) continue;
      total += w;
      if (met.has(c)) weighted += w;
    }
  }
  const coverage = total ? weighted / total : 0;
  return {
    charactersMet: met.size,
    charactersSolid: solid.size,
    estimatedCoverage: coverage,
    band: readabilityBand(coverage),
    // What it would take to reach the next threshold — concrete, not a level.
    toReadable: coverage >= 0.95 ? 0 : Math.max(0, Math.round((0.95 - coverage) * 1000)),
  };
}

// ── The tap-a-character moment ───────────────────────────────────────────────
// What the Reading track shows when a learner taps an unfamiliar character. The
// ORDER matters and encodes the research: the sound question is asked BEFORE it is
// answered (self-teaching), and the radical is offered as an inference about
// meaning rather than a fact to memorise. A character with no trustworthy series
// and no known radical returns nulls — the UI then just shows the dictionary,
// which is the honest outcome rather than an invented mnemonic.
export function characterInsight(hanzi, knownChars) {
  const ch = [...String(hanzi || '')].find(isCjk);
  if (!ch) return null;
  const known = knownChars || knownCharacters();
  const s = seriesFor(ch);
  const sem = semanticHint(ch);
  return {
    hanzi: ch,
    // "You know 方, 房, 放 — so what does 访 sound like?" Null when the learner has
    // met nothing in the series, because then there is nothing to reason FROM.
    predict: predictReading(ch, known),
    // The family shown after the guess is checked — the evidence that it is a rule.
    series: s ? {
      phonetic: s.phonetic,
      dominant: s.dominant,
      consistency: s.consistency,
      members: s.regular.filter(m => m.hanzi !== ch).slice(0, 6)
        .map(m => ({ hanzi: m.hanzi, reading: m.reading, known: known.has(m.hanzi) })),
    } : null,
    semantic: sem ? { ...sem, family: semanticFamily(sem.radical, known) } : null,
  };
}

// Does this word carry a high-yield phonetic key the learner hasn't got yet?
// Used to break ties when picking a story's stretch words: two equally
// comprehensible new words are NOT equally valuable if one of them hands over the
// key to nine more characters.
export function orthographicYield(hanzi, knownChars) {
  const known = knownChars || knownCharacters();
  let score = 0;
  for (const c of String(hanzi || '')) {
    if (!isCjk(c) || known.has(c)) continue;
    const s = phoneticSeries().get(c);                          // the char IS a phonetic key
    if (s && s.consistency >= TEACHABLE_CONSISTENCY) {
      score += s.regular.filter(m => !known.has(m.hanzi)).length * s.consistency;
      continue;
    }
    const own = seriesFor(c);                                   // or belongs to a live series
    if (own && known.has(own.phonetic)) score += 0.5;
  }
  return score;
}

// Test/ingest hook: drop the memoised series (after a content import changes words).
export function resetSeriesCache() { _series = null; }
