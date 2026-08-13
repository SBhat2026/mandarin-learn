// Accountable Talk moves for Laoshi.
//
// "Ask a question more often" was the wrong fix for the free rung, and it only got us
// from 15% to ~40%. The dialogic-tutoring literature names the actual failure modes,
// and they describe our transcripts exactly:
//
//   • MONOLOGIC DELIVERY — the tutor supplies a complete turn that bypasses the
//     cognitive work the learner should do. Ours: "你有一只可爱的猫，真好。"
//   • ASYMMETRICAL DIALOGUE — the tutor controls the flow instead of responding to
//     what the learner actually contributed.
//   • INSUFFICIENT RESPONSIVENESS — failing to build on learner ideas across turns,
//     so nothing accumulates.
//
// The remedy in that literature is not "more questions" but a small set of named
// TALK MOVES (the Accountable Talk / TalkMoves taxonomy: revoicing, pressing for
// reasoning, eliciting, probing, adding-on). We pick the move in CODE and hand the
// model one instruction, because a model told to "vary your turns" does not vary
// them — it settles into whichever move is easiest, which for a warm persona is the
// closed compliment.
//
// Sources: Accountable Talk / TalkMoves (revoicing, press-for-reasoning, eliciting,
// probing, adding-on); dialogic-pedagogy critiques of LLM tutors (Vygotsky ZPD,
// Mercer's exploratory talk); scaffolding contingency-and-fading.

// Each move carries the instruction the model receives and a test for whether the
// resulting turn actually performed it.
export const MOVES = {
  revoice: {
    // The single highest-value move and the one most missing from our transcripts:
    // say their idea back in slightly fuller Chinese. It confirms they were heard AND
    // models the better sentence without correcting them.
    instruct: 'REVOICE: say their idea back in your own slightly fuller words first ("你是说…"), so they hear a better version of their own sentence, then continue.',
    weight: 3,
  },
  press: {
    instruct: 'PRESS FOR REASONING: ask WHY or HOW about the thing they just said (为什么 / 怎么 / 什么时候). Do not change the subject to do it.',
    weight: 3,
  },
  probe: {
    instruct: 'PROBE: ask for one more concrete detail about what they just said — 什么样的 / 谁 / 几个 / 在哪儿. Stay on their topic.',
    weight: 3,
  },
  addOn: {
    instruct: 'ADD ON: connect what they just said to something said EARLIER in this conversation, then ask how the two fit together.',
    weight: 2,
  },
  elicit: {
    instruct: 'ELICIT: get them to produce the language rather than producing it for them — invite them to say it, guess it, or try it. Do not supply the answer.',
    weight: 2,
  },
  share: {
    // Not from the taxonomy — added because a tutor that only interrogates is not a
    // conversation either. Kept low-weight and always paired with a hand-back.
    instruct: 'SHARE THEN HAND BACK: tell them one small true thing about yourself, then ask whether it is the same for them. Never end on the statement.',
    weight: 2,
  },
};

const ORDER = Object.keys(MOVES);

// Which moves have already been used, and what the learner is doing, decide the next.
// Deterministic (no randomness — the workflow/runtime forbids it, and a reproducible
// move sequence is also easier to debug from a transcript).
export function pickMove({ history = [], userText = '', usedMoves = [], turnIndex = 0 } = {}) {
  const said = String(userText || '').trim();
  const zh = (said.match(/[一-鿿]/g) || []).length;

  // A learner who produced almost nothing cannot be pressed for reasoning — that is
  // the contingency half of scaffolding: the move has to fit what they can currently
  // do, or it becomes an obstacle rather than support.
  if (zh > 0 && zh <= 2) return withInstruction('elicit');
  // Nothing to revoice or probe on the opening turn.
  if (!said) return withInstruction('share');

  // Prefer a move not used recently, weighted, so the conversation does not settle
  // into one shape — the failure the literature calls asymmetrical dialogue.
  const recent = new Set(usedMoves.slice(-3));
  const pool = ORDER.filter(m => !recent.has(m));
  const candidates = (pool.length ? pool : ORDER);
  // Rotate deterministically through the candidate list by turn, biased by weight.
  const expanded = candidates.flatMap(m => Array(MOVES[m].weight).fill(m));
  return withInstruction(expanded[turnIndex % expanded.length]);
}

function withInstruction(name) {
  return { name, instruct: MOVES[name].instruct };
}

// The block handed to the executor. One move, named, with the anti-patterns the
// transcripts actually produced spelled out — a generic "be conversational" does not
// survive contact with a warm persona.
export function talkMoveDirective(move) {
  if (!move) return '';
  return [
    `THIS TURN'S MOVE — ${move.name.toUpperCase()}. ${move.instruct}`,
    'Whatever the move, the turn must leave them something to say back. Ending on a closed '
      + 'compliment (“真好。” “你很好。” “不错。”) ends the conversation — it is the single most '
      + 'common way this goes wrong.',
    'Do NOT deliver a complete explanation they could have worked out. Ask, then let them think.',
  ].join('\n');
}

// Did the turn actually perform a move, or did it just land? Used by diagnostics and
// by the guided composer's accept/reject gate.
export function performsMove(hanzi = '') {
  const h = String(hanzi);
  const asks = /[？?]|吗|呢|什么|几|谁|哪|怎么|为什么|多少/.test(h);
  const closedCompliment = /(真好|很好|不错|真棒|太好了)[。！!]?$/.test(h.trim());
  return { asks, closedCompliment, ok: asks && !closedCompliment };
}
