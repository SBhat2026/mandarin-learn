// Character families as FIRST-CLASS curriculum items — not a display panel.
// A family is 'r:氵' (semantic radical) or 'p:青' (phonetic series). Each has its
// own mastery + spaced schedule; lessons teach the transferable rule (what the
// radical MEANS / what the phonetic SOUNDS like), ground it in characters the
// learner already knows, then extend it to 1-2 NEW frontier characters so one
// family unlocks many characters. A small check feeds mastery.
import { db, getModel, setModel } from './db.js';
import { SEMANTIC_RADICALS, rhyme, firstReading } from './families.js';
import { knownWordIds } from './planner.js';

const CJK = /[一-鿿]/;
const chars = (s) => [...(s || '')].filter(ch => CJK.test(ch));

function ensureTable() {
  db().exec(`CREATE TABLE IF NOT EXISTS family_mastery (
    family_key TEXT PRIMARY KEY,        -- 'r:氵' | 'p:青'
    kind       TEXT NOT NULL,           -- 'radical' | 'phonetic'
    score      REAL DEFAULT 0,
    exposures  INTEGER DEFAULT 0,
    due        TEXT,                    -- next scheduled resurfacing
    last_ts    TEXT
  )`);
}

// Every character the learner knows (from known words), with its word context.
function knownChars() {
  const ids = [...knownWordIds()];
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const rows = db().prepare(`SELECT id, hanzi, pinyin, gloss, english FROM words WHERE id IN (${ph})`).all(...ids);
  const map = new Map();   // char → [{word rows}]
  for (const w of rows) for (const c of chars(w.hanzi)) {
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(w);
  }
  return map;
}

// Meaning for a radical: curated map first, else the radical character's own
// dictionary definition (so coverage isn't capped at the 48 hand-listed radicals).
function radicalMeaning(radical) {
  if (SEMANTIC_RADICALS[radical]) return SEMANTIC_RADICALS[radical];
  const m = db().prepare('SELECT definition FROM char_meta WHERE hanzi=?').get(radical);
  const def = m?.definition ? String(m.definition).split(/[;,]/)[0].trim() : null;
  return def && def.length <= 24 ? def : null;
}

// All families where the learner knows ≥2 member characters — the teachable frontier.
function candidateFamilies(kmap) {
  const fams = new Map();  // key → {kind, component, members:[char]}
  for (const c of kmap.keys()) {
    const m = db().prepare('SELECT radical, phonetic FROM char_meta WHERE hanzi=?').get(c);
    if (m?.radical && radicalMeaning(m.radical)) {
      const key = 'r:' + m.radical;
      if (!fams.has(key)) fams.set(key, { key, kind: 'radical', component: m.radical, members: [] });
      fams.get(key).members.push(c);
    }
    if (m?.phonetic) {
      const key = 'p:' + m.phonetic;
      if (!fams.has(key)) fams.set(key, { key, kind: 'phonetic', component: m.phonetic, members: [] });
      fams.get(key).members.push(c);
    }
  }
  return [...fams.values()].filter(f => f.members.length >= 2);
}

// Pick the next family to teach: due families first, then never-taught ones with the
// most known members (biggest transfer payoff). Returns null when nothing qualifies.
export function nextFamily() {
  ensureTable();
  const kmap = knownChars();
  if (!kmap.size) return null;
  const cands = candidateFamilies(kmap);
  if (!cands.length) return null;
  const mastery = new Map(db().prepare('SELECT * FROM family_mastery').all().map(r => [r.family_key, r]));
  const now = new Date().toISOString();

  let best = null, bestScore = -Infinity;
  for (const f of cands) {
    const m = mastery.get(f.key);
    const due = m?.due && m.due <= now;
    const never = !m;
    if (!never && !due) continue;                       // scheduled for later
    const s = (never ? 2 : 1) + 0.4 * f.members.length - (m?.score || 0);
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return best ? buildFamilyLesson(best, kmap) : null;
}

// The lesson: rule + known anchors + new frontier chars + a self-check.
function buildFamilyLesson(fam, kmap) {
  const meta = (c) => db().prepare('SELECT pinyin, definition FROM char_meta WHERE hanzi=?').get(c) || {};
  const shortDef = (d) => d ? String(d).split(/[;,]/)[0].trim().slice(0, 30) : '';

  // Known members, each grounded in a word the learner has studied.
  const knownMembers = fam.members.slice(0, 4).map(c => {
    const m = meta(c);
    const w = (kmap.get(c) || [])[0];
    return { char: c, pinyin: firstReading(m.pinyin), definition: shortDef(m.definition),
      knownWord: w ? { hanzi: w.hanzi, pinyin: w.pinyin, gloss: (w.gloss || w.english || '').split(/[;,]/)[0] } : null };
  });

  // Frontier: unknown characters in this family that appear in high-frequency
  // unstudied words — the transfer payoff ("you can now read these too").
  const rel = fam.kind === 'radical' ? 'radical_family' : 'phonetic_series';
  const memberSet = new Set(fam.members);
  let frontier = db().prepare(`SELECT ge.src AS ch, cm.pinyin, cm.definition, w.hanzi AS word, w.pinyin AS wpinyin, w.gloss, w.english, w.freq_rank
      FROM graph_edges ge
      JOIN char_meta cm ON cm.hanzi = ge.src
      JOIN words w ON instr(w.hanzi, ge.src) > 0 AND length(w.hanzi) <= 2
      WHERE ge.rel = ? AND ge.dst = ?
        AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_type='word' AND c.item_id=w.id)
      ORDER BY COALESCE(w.freq_rank, 999999) ASC LIMIT 12`).all(rel, fam.component)
    .filter(r => !memberSet.has(r.ch));
  // For phonetic families, only frontier chars whose reading the component actually predicts.
  if (fam.kind === 'phonetic') {
    const famRhymes = new Set(fam.members.map(c => rhyme(firstReading(meta(c).pinyin))).filter(Boolean));
    frontier = frontier.filter(r => famRhymes.has(rhyme(firstReading(r.pinyin))));
  }
  const seen = new Set();
  frontier = frontier.filter(r => !seen.has(r.ch) && seen.add(r.ch)).slice(0, 2)
    .map(r => ({ char: r.ch, pinyin: firstReading(r.pinyin), definition: shortDef(r.definition),
      exampleWord: { hanzi: r.word, pinyin: r.wpinyin, gloss: (r.gloss || r.english || '').split(/[;,]/)[0] } }));

  // Self-check: which of these belongs to the family? (members + one outsider)
  const outsider = db().prepare(`SELECT cm.hanzi, cm.pinyin FROM char_meta cm
    JOIN words w ON w.hanzi = cm.hanzi
    WHERE cm.radical != ? AND COALESCE(cm.phonetic,'') != ?
    ORDER BY COALESCE(w.freq_rank, 999999) ASC LIMIT 30`).all(fam.component, fam.component)
    .filter(r => !memberSet.has(r.hanzi))[Math.floor(fam.members.length * 7 % 20)];
  const checkPool = [...knownMembers.slice(0, 2).map(m => m.char), ...(frontier[0] ? [frontier[0].char] : [])];
  const check = outsider ? {
    prompt: fam.kind === 'radical'
      ? `Which one does NOT carry the "${radicalMeaning(fam.component)}" idea?`
      : `Which one does NOT rhyme with the others?`,
    options: shuffleDet([...checkPool, outsider.hanzi]),
    answer: outsider.hanzi,
  } : null;

  const sound = fam.kind === 'phonetic' ? firstReading(meta(fam.component).pinyin) : null;
  return {
    key: fam.key, kind: fam.kind, component: fam.component,
    meaning: fam.kind === 'radical' ? radicalMeaning(fam.component) : null,
    sound,
    lesson: fam.kind === 'radical'
      ? `${fam.component} means "${radicalMeaning(fam.component)}" — when you see it inside a character, the meaning is usually nearby.`
      : `${fam.component}${sound ? ` (${sound})` : ''} carries the SOUND — characters built on it rhyme with it.`,
    knownMembers, frontier, check,
  };
}

function shuffleDet(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

// Record the outcome of the family self-check; schedule the next resurfacing with
// an expanding interval (1 → 3 → 7 → 16 → 35 days, halved on a miss).
export function recordFamilyOutcome(key, correct) {
  ensureTable();
  const cur = db().prepare('SELECT * FROM family_mastery WHERE family_key=?').get(key)
    || { family_key: key, kind: key.startsWith('r:') ? 'radical' : 'phonetic', score: 0, exposures: 0 };
  const k = Math.max(0.25, 0.6 / (1 + cur.exposures * 0.5));
  const score = cur.score * (1 - k) + (correct ? 1 : 0) * k;
  const steps = [1, 3, 7, 16, 35];
  let days = steps[Math.min(cur.exposures, steps.length - 1)];
  if (!correct) days = Math.max(1, Math.round(days / 2));
  const due = new Date(Date.now() + days * 86400e3).toISOString();
  db().prepare(`INSERT INTO family_mastery(family_key, kind, score, exposures, due, last_ts)
    VALUES(?,?,?,?,?,datetime('now'))
    ON CONFLICT(family_key) DO UPDATE SET score=excluded.score,
      exposures=family_mastery.exposures+1, due=excluded.due, last_ts=excluded.last_ts`)
    .run(key, cur.kind, score, (cur.exposures || 0) + 1, due);
  return { key, score: Number(score.toFixed(2)), nextInDays: days };
}
