// Vocab-graph conversation continuity. A real conversation drifts through RELATED
// ideas, it doesn't jump between an arbitrary target list. This walks the knowledge
// graph (the 83k-edge graph the app already built) from the words actually in play to
// find the most natural NEXT concept — words that co-occur in real sentences, collocate,
// share a topic, or share a character. It powers three things, all hidden:
//   • guided rungs — seed a CONNECTED cluster of meet-words (each reinforces the last)
//   • free rung   — a soft steer toward a naturally-adjacent concept
//   • across sessions — open on a graph-neighbour of last time's focal (honest callback)
import { db } from './db.js';
import { cleanGloss } from './exercises.js';

// Relation → conversational-adjacency weight. Co-occurrence in real sentences and
// collocation are the strongest "these belong together when you talk" signals; topic and
// shared-character are weaker associative links.
const REL_WEIGHT = { sentence_dep: 1.0, collocation: 0.9, topic: 0.5, shares_char: 0.4 };

function wordRow(id) {
  const w = db().prepare('SELECT id, hanzi, pinyin, gloss, english, freq_rank, pos FROM words WHERE id=?').get(id);
  return w && { wordId: w.id, hanzi: w.hanzi, pinyin: w.pinyin, gloss: cleanGloss(w) || w.english || '', freq_rank: w.freq_rank, pos: w.pos };
}

// Direct + associative graph neighbours of one word, as {wordId, relation, weight}.
// Direction-agnostic for word↔word edges (an edge either way means adjacency).
export function graphNeighbors(wordId, { limit = 20 } = {}) {
  const acc = new Map();
  const bump = (id, rel) => {
    const n = Number(id);
    if (!n || n === wordId) return;
    const w = REL_WEIGHT[rel] || 0.3;
    const cur = acc.get(n);
    if (!cur || w > cur.weight) acc.set(n, { wordId: n, relation: rel, weight: w });
  };
  // word↔word: collocation + sentence co-occurrence (both directions).
  for (const rel of ['sentence_dep', 'collocation']) {
    for (const r of db().prepare('SELECT dst FROM graph_edges WHERE rel=? AND src=?').all(rel, String(wordId))) bump(r.dst, rel);
    for (const r of db().prepare('SELECT src FROM graph_edges WHERE rel=? AND dst=?').all(rel, String(wordId))) bump(r.src, rel);
  }
  // same topic → other words in that topic.
  for (const t of db().prepare("SELECT dst FROM graph_edges WHERE rel='topic' AND src=?").all(String(wordId))) {
    for (const r of db().prepare("SELECT src FROM graph_edges WHERE rel='topic' AND dst=? LIMIT 40").all(t.dst)) bump(r.src, 'topic');
  }
  // shared character → words that share a character (transfer).
  for (const c of db().prepare("SELECT dst FROM graph_edges WHERE rel='shares_char' AND src=?").all(String(wordId))) {
    for (const r of db().prepare("SELECT src FROM graph_edges WHERE rel='shares_char' AND dst=? LIMIT 40").all(c.dst)) bump(r.src, 'shares_char');
  }
  return [...acc.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

// The most natural next concepts given the words currently IN PLAY (used this
// conversation). Aggregates neighbours, excludes what's already in play, and splits into
// REUSE (comprehensible — already known/introduced, good to weave back in) and GROW
// (fresh, reachable — one small step outward). Comprehensibility is preferred so the
// conversation stretches gently, never lurches. Fully offline/deterministic.
export function nextConcepts(inPlayIds = [], { known = new Set(), introduced = new Set(), limit = 6 } = {}) {
  const inPlay = new Set(inPlayIds.map(Number).filter(Boolean));
  const scores = new Map();   // id → {score, relation}
  for (const id of inPlay) {
    for (const nb of graphNeighbors(id, { limit: 24 })) {
      if (inPlay.has(nb.wordId)) continue;
      const cur = scores.get(nb.wordId) || { score: 0, relation: nb.relation };
      cur.score += nb.weight;
      if ((REL_WEIGHT[nb.relation] || 0) > (REL_WEIGHT[cur.relation] || 0)) cur.relation = nb.relation;
      scores.set(nb.wordId, cur);
    }
  }
  const rows = [];
  for (const [id, s] of scores) {
    const w = wordRow(id);
    if (!w) continue;
    const isKnown = known.has(id) || introduced.has(id);
    // comprehensible reuse gets a lift; frequency gently breaks ties.
    const comp = isKnown ? 0.8 : 0;
    const freq = 1 / Math.log10((w.freq_rank || 99999) + 10);
    rows.push({ ...w, relation: s.relation, adjacency: s.score, isKnown, score: s.score + comp + 0.4 * freq });
  }
  rows.sort((a, b) => b.score - a.score);
  return {
    reuse: rows.filter(r => r.isKnown).slice(0, limit),
    grow: rows.filter(r => !r.isKnown).slice(0, limit),
    top: rows.slice(0, limit),
  };
}

// A one-line hidden steer for the executor: the concept the conversation could naturally
// drift toward next, and why (which in-play word it hangs off). Never shown; the model
// decides whether to take it. Returns '' when the graph offers nothing apt.
export function graphSteer(inPlayIds = [], { known = new Set(), introduced = new Set() } = {}) {
  const { reuse, grow } = nextConcepts(inPlayIds, { known, introduced, limit: 3 });
  const pick = reuse[0] || grow[0];
  if (!pick) return '';
  const kind = pick.relation === 'topic' ? 'the same subject'
    : pick.relation === 'shares_char' ? 'a related word' : 'something that naturally comes up alongside it';
  return `If the moment invites it, you could let the chat drift toward "${pick.hanzi}" (${pick.gloss}) — it's ${kind}. Only if it flows; never force it.`;
}
