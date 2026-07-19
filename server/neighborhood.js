// Neighborhood lesson planner. Lessons are no longer built around isolated words:
// the planner picks a focal concept and a small CONNECTED neighborhood of related
// concepts drawn from many relationship types at once (shared characters, radical
// families, phonetic series, visual-confusion look-alikes, collocations, topics,
// due reinforcement). It maximizes transfer — every new concept should reinforce
// several prior ones and open doors to future conversation.
import { db } from './db.js';
import { State } from './fsrs.js';
import { introducedWordIds, knownWordIds, newCandidates } from './planner.js';
import { cleanGloss } from './exercises.js';
import { scriptLevel } from './learner.js';
import { SEMANTIC_RADICALS, rhyme, firstReading } from './families.js';

const CJK = /[一-鿿]/;
const chars = (s) => [...(s || '')].filter(ch => CJK.test(ch));

function wordRow(id) {
  const w = db().prepare('SELECT * FROM words WHERE id=?').get(id);
  return w && { wordId: w.id, hanzi: w.hanzi, pinyin: w.pinyin, gloss: cleanGloss(w) };
}

function dueWordCards() {
  return db().prepare(`SELECT item_id FROM cards
    WHERE card_type='memory' AND item_type='word' AND state>0 AND suspended=0
      AND due<=datetime('now')`).all().map(r => r.item_id);
}

// ---- Instructional character families -------------------------------------
// Turns raw graph metadata into a teachable, transferable rule: what the shared
// radical MEANS (semantic family), what the phonetic component SOUNDS like
// (sound family), and which look-alikes to keep apart (visual family).
export function instructionalPattern(hanzi) {
  const out = [];
  for (const c of new Set(chars(hanzi))) {
    const m = db().prepare('SELECT * FROM char_meta WHERE hanzi=?').get(c);
    if (!m) continue;
    // Peers ordered by character frequency so common, useful examples surface
    // first (e.g. 时 before 暧昧) instead of obscure characters.
    const peers = (rel, dst) => db().prepare(
      `SELECT ge.src AS ch, cm.pinyin, cm.definition FROM graph_edges ge
         JOIN char_meta cm ON cm.hanzi=ge.src
         LEFT JOIN words w ON w.hanzi=ge.src
        WHERE ge.rel=? AND ge.dst=? AND ge.src!=?
        ORDER BY COALESCE(w.freq_rank, 999999) ASC LIMIT 6`).all(rel, dst, c)
      .map(r => ({ char: r.ch, pinyin: firstReading(r.pinyin), definition: shortDef(r.definition) }));
    const confus = db().prepare(
      `SELECT ge.dst AS ch, cm.pinyin, cm.definition FROM graph_edges ge
         JOIN char_meta cm ON cm.hanzi=ge.dst
         LEFT JOIN words w ON w.hanzi=ge.dst
        WHERE ge.rel='visual_confusion' AND ge.src=?
        ORDER BY COALESCE(w.freq_rank, 999999) ASC LIMIT 4`).all(c)
      .map(r => ({ char: r.ch, pinyin: firstReading(r.pinyin), definition: shortDef(r.definition) }));

    const p = { char: c, pinyin: firstReading(m.pinyin), definition: shortDef(m.definition) };

    // Semantic family — only for genuinely meaning-bearing radicals.
    const radMeaning = m.radical ? SEMANTIC_RADICALS[m.radical] : null;
    const radPeers = radMeaning ? peers('radical_family', m.radical) : [];
    if (radMeaning && radPeers.length) {
      p.semantic = { radical: m.radical, meaning: radMeaning, peers: radPeers,
        lesson: `the ${m.radical} radical means "${radMeaning}" — it flags the meaning in words like:` };
    }

    // Sound family — only when the phonetic component actually predicts this
    // character's reading (rhyme match), and only the peers that also match.
    if (m.phonetic) {
      const cRhyme = rhyme(p.pinyin);
      const phonPeers = peers('phonetic_series', m.phonetic).filter(x => x.pinyin && rhyme(x.pinyin) === cRhyme);
      if (cRhyme && phonPeers.length >= 2) {
        const snd = firstReading(db().prepare('SELECT pinyin FROM char_meta WHERE hanzi=?').get(m.phonetic)?.pinyin);
        p.phonetic = { component: m.phonetic, sound: snd, peers: phonPeers,
          lesson: `${m.phonetic} hints the "-${cRhyme}" sound — you'll hear it in:` };
      }
    }

    if (confus.length) {
      p.visual = { peers: confus, lesson: `looks like — keep ${c} apart from:` };
    }
    if (p.semantic || p.phonetic || p.visual) out.push(p);
  }
  return out;
}

function shortDef(def) {
  if (!def) return null;
  return def.split(/;|,/)[0].trim().slice(0, 40);
}

// ---- Neighborhood assembly ------------------------------------------------
// Score a candidate focal word by how much it connects to what the learner
// already knows / owes (reinforcement) and to future collocations (transfer).
function transferScore(wordId, hanzi, known, dueSet) {
  const cs = chars(hanzi);
  let score = 0;
  // characters shared with known/due words
  for (const c of cs) {
    const sharers = db().prepare(
      `SELECT src FROM graph_edges WHERE rel='shares_char' AND dst_type='char' AND dst=?`).all(c)
      .map(r => Number(r.src));
    for (const s of sharers) { if (dueSet.has(s)) score += 2; else if (known.has(s)) score += 1; }
    // radical / phonetic families already encountered → semantic+sound transfer
    const m = db().prepare('SELECT radical, phonetic FROM char_meta WHERE hanzi=?').get(c);
    if (m?.radical) score += peerKnownCount('radical_family', m.radical, known, dueSet) * 0.6;
    if (m?.phonetic) score += peerKnownCount('phonetic_series', m.phonetic, known, dueSet) * 0.8;
  }
  // collocations that point at known words → ready-made conversational scaffolding
  for (const r of db().prepare(`SELECT dst FROM graph_edges WHERE rel='collocation' AND src=?`).all(String(wordId))) {
    if (known.has(Number(r.dst))) score += 0.5;
  }
  return score;
}

function peerKnownCount(rel, dst, known, dueSet) {
  const peerChars = db().prepare(`SELECT src FROM graph_edges WHERE rel=? AND dst=?`).all(rel, dst).map(r => r.src);
  if (!peerChars.length) return 0;
  const ph = peerChars.map(() => '?').join(',');
  const words = db().prepare(
    `SELECT DISTINCT src FROM graph_edges WHERE rel='shares_char' AND dst IN (${ph})`).all(...peerChars).map(r => Number(r.src));
  return words.filter(w => known.has(w) || dueSet.has(w)).length;
}

// Pick the focal concept: a new word that maximizes transfer to prior + future.
function pickFocal(introduced, known, dueSet) {
  const cands = newCandidates(30, introduced);
  let best = cands[0], bestScore = -Infinity;
  for (const c of cands) {
    const t = transferScore(c.id, c.hanzi, known, dueSet);
    const combined = c.score + 1.5 * t;      // concreteness/frequency + transfer
    if (combined > bestScore) { bestScore = combined; best = { ...c, transfer: t }; }
  }
  return best;
}

// Assemble the neighborhood around the focal word.
function assemble(focal, dueSet, known) {
  const focalChars = chars(focal.hanzi);
  const relatedWordIds = new Set();

  // words that share a character with the focal
  for (const c of focalChars) {
    for (const r of db().prepare(
      `SELECT src FROM graph_edges WHERE rel='shares_char' AND dst=?`).all(c)) relatedWordIds.add(Number(r.src));
  }
  // collocations of the focal (words used alongside it)
  for (const r of db().prepare(`SELECT dst FROM graph_edges WHERE rel='collocation' AND src=?`).all(String(focal.id)))
    relatedWordIds.add(Number(r.dst));
  relatedWordIds.delete(focal.id);

  // reinforce: due words that fall inside the neighborhood
  const reinforce = [...relatedWordIds].filter(id => dueSet.has(id)).slice(0, 4).map(wordRow).filter(Boolean);

  // expose: 1–3 fresh, closely-connected words (prefer known-adjacent, high frequency)
  const exposeIds = [...relatedWordIds]
    .filter(id => !dueSet.has(id))
    .sort((a, b) => (db().prepare('SELECT freq_rank FROM words WHERE id=?').get(a)?.freq_rank || 9e9)
                  - (db().prepare('SELECT freq_rank FROM words WHERE id=?').get(b)?.freq_rank || 9e9))
    .slice(0, 3);
  const exposeRelated = exposeIds.map(id => { const w = wordRow(id); return w && { ...w, isNew: !known.has(id) }; }).filter(Boolean);

  return { reinforce, exposeRelated };
}

// A conversational scene seed from the focal word's topic.
function sceneFor(focal) {
  const w = db().prepare('SELECT topics FROM words WHERE id=?').get(focal.id);
  let topics = []; try { topics = JSON.parse(w?.topics || '[]'); } catch {}
  return topics[0] || 'everyday conversation';
}

// The lesson plan the Practice screen and Laoshi consume.
export function buildLessonPlan() {
  const introduced = introducedWordIds();
  const known = knownWordIds();
  const dueSet = new Set(dueWordCards());

  const focal = pickFocal(introduced, known, dueSet);
  const focalRow = wordRow(focal.id) || { wordId: focal.id, hanzi: focal.hanzi, pinyin: '', gloss: '' };
  const focalFull = db().prepare('SELECT audio_path FROM words WHERE id=?').get(focal.id);
  const { reinforce, exposeRelated } = assemble(focal, dueSet, known);

  const patterns = instructionalPattern(focal.hanzi);
  const targetVocab = dedupe([
    { ...focalRow, role: 'focal' },
    ...exposeRelated.map(w => ({ ...w, role: 'expose' })),
    ...reinforce.map(w => ({ ...w, role: 'reinforce' })),
  ]);

  return {
    focal: { ...focalRow, audio: focalFull?.audio_path || null, transfer: focal.transfer || 0 },
    patterns,
    reinforce,
    exposeRelated,
    targetVocab,
    scriptLevel: scriptLevel(),
    scene: sceneFor(focal),
  };
}

function dedupe(list) {
  const seen = new Set(), out = [];
  for (const w of list) { if (w && !seen.has(w.wordId)) { seen.add(w.wordId); out.push(w); } }
  return out;
}
