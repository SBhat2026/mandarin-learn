// Conversation session manager + the ladder orchestrator. One row per conversation
// holds the capability-keyed plan and the Director's blueprint so turns don't re-plan.
// The RUNG (rung.js) decides how a turn is produced:
//   rung 0/1 — guided: fully-scaffolded, frame-built, code-validated, interlinear
//              turns with meet-the-words beats and scaffolded choices (vocabguard).
//   rung 2   — free: the existing Director/blueprint/Qwen-executor conversation.
// The guided rungs never strand the learner (intent.js) and always find a way forward.
import { db, getModel, setModel, getSetting } from './db.js';
import { buildLessonPlan } from './neighborhood.js';
import { buildBlueprint, buildBlueprintLocal } from './director.js';
import { profileForPrompt, recordEngagement, interestAnchors } from './profile.js';
import { laoshiConverse, conversationStage, chat, available as qwenAvailable } from './qwen.js';
import { knownWordIds, introducedWordIds } from './planner.js';
import { createCardsForWord } from './cards.js';
import { scriptDirective, scriptLevel, presentationBias } from './learner.js';
import { detectUsed } from './conversation.js';
import { capabilityMastery, pendingUnlock, markUnlockAcked } from './capabilities.js';
import { buildExercise, cleanGloss } from './exercises.js';
import { weakTone, buildToneDrill } from './tone.js';
import { liveCompletion, computeCalibration } from './momentum.js';
import { currentRung, rungKnobs, recordProductionOutcome } from './rung.js';
import { evaluateProduction, recastLine, recastDirective, strictness } from './correction.js';
import { allowedSet, buildFrameTurn, groundTokens, beginnerNewWords, vocabToken, validateTurn, segment, coreSet, shortGloss, isNamable, knownHanzi, beginnerPrompt } from './vocabguard.js';
import { classifyIntent, regroundReply, expressionGapReply } from './intent.js';
import { graphNeighbors, graphSteer, nextConcepts } from './graphwalk.js';
import { conversationProfile } from './level.js';
import { pickMove, talkMoveDirective, performsMove } from './talkmoves.js';
import { pinyinForHanzi, glossForHanzi } from './pronunciation.js';

function genId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function knownStrings(limit = 400) {
  const known = [...knownWordIds()];
  return known.length
    ? db().prepare(`SELECT hanzi FROM words WHERE id IN (${known.map(() => '?').join(',')}) ORDER BY freq_rank LIMIT ${limit}`).all(...known).map(r => r.hanzi)
    : [];
}

// The word ids actually IN PLAY this conversation — segment every turn's Chinese and
// resolve to word ids, plus the plan's target vocab. Feeds the graph-walk continuity.
function inPlayWordIds(transcript = [], plan = {}) {
  const ids = new Set((plan.targetVocab || []).map(v => v.wordId).filter(Boolean));
  const lookup = db().prepare('SELECT id FROM words WHERE hanzi=?');
  for (const t of transcript) {
    const text = t.hanzi || t.content || '';
    for (const seg of segment(text)) { const w = lookup.get(seg); if (w) ids.add(w.id); }
  }
  return [...ids];
}

// A compact, human "what we've been talking about" — the content words the LEARNER
// produced — so Laoshi can refer back to something specific instead of sounding generic.
function conversationMemory(transcript = []) {
  const lookup = db().prepare("SELECT gloss, english FROM words WHERE hanzi=? AND (gloss IS NOT NULL OR english IS NOT NULL)");
  const seen = new Set(), bits = [];
  for (const t of transcript) {
    if (t.role !== 'user') continue;
    for (const seg of segment(t.hanzi || t.content || '')) {
      if (seg.length < 1 || seen.has(seg)) continue;
      const w = lookup.get(seg); if (!w) continue;
      seen.add(seg); bits.push(`${seg} (${cleanGloss(w)})`);
    }
  }
  return bits.slice(-6).join(', ');
}

// Per-conversation ladder state (rung, this session's introduced words, turn index)
// lives in the per-user KV store keyed by session id — no schema change, isolated
// per user. Cleared implicitly when a new conversation starts.
const ladderKey = (id) => `ladder:${id}`;
const getLadder = (id) => getModel(ladderKey(id), null);
const setLadder = (id, s) => setModel(ladderKey(id), s);
// What the free-rung teacher has already been ON about, per conversation.
const topicsKey = (id) => `topics:${id}`;
// Which talk moves this conversation has already used, so they rotate.
const movesKey = (id) => `moves:${id}`;

// Absolute exchange ceiling for a free conversation, whatever the blueprint budget
// says. Past this it is no longer a conversation, it is a treadmill.
const FREE_CEILING = 14;

// Seed a small, GRAPH-CONNECTED cluster of concrete/picturable words for a guided
// session — each word reinforces the last (shared topic/character/co-occurrence) so the
// set feels like one little world, not three random flashcards. Reuses ONE word from the
// previous session (honest spaced callback) and grows OUTWARD along the graph from it,
// so sessions chain like a real relationship. Cards are created so words enter scheduling.
function seedSessionWords(plan) {
  const introduced = introducedWordIds();
  const out = [], seen = new Set();
  // ROTATE the callback. Carrying the first word forward every time meant every
  // session opened on the same noun ("这是车。" three days running), which reads as
  // being stuck rather than as continuity.
  const callback = getModel('last_session_words', []) || [];
  const spin = getModel('callback_spin', 0) || 0;
  if (callback.length) setModel('callback_spin', (spin + 1) % Math.max(1, callback.length));
  const rejectedSeed = rejectedHanzi();
  const rotated = callback.length ? [callback[spin % callback.length]].filter(h => !rejectedSeed.has(h)) : [];
  let anchorId = null;
  for (const h of rotated) {
    const row = db().prepare('SELECT id FROM words WHERE hanzi=?').get(h);
    const tk = row && vocabToken(row.id);
    if (tk && !seen.has(tk.hanzi)) { out.push({ ...tk, isNew: false, callback: true }); seen.add(tk.hanzi); anchorId = row.id; }
  }
  // Start with TWO words, not three: the arc's `grow` beat brings a third in
  // mid-conversation (see growSessionWord), so the session opens small and then
  // visibly moves somewhere instead of circling a fixed set from the first turn.
  // Also guard against repeating YESTERDAY's meaning under a different word (钱 then
  // 金钱, both "money") — that reads as the app going in circles.
  const recent = recentlyTaught();
  const rejected = rejectedHanzi();
  for (const w of connectedBeginnerCluster(introduced, anchorId, 8)) {
    if (seen.has(w.hanzi)) continue;
    if (rejected.has(w.hanzi)) continue;                          // they said no to this once
    if (tooSimilar(w, out)) continue;                             // never 车 + 火车 in one sitting
    if (tooSimilar(w, recent, { chars: false })) continue;        // nor last week's meaning again
    out.push({ ...w, isNew: true }); seen.add(w.hanzi);
    if (out.length >= 2) break;
  }
  // Last resort: the plan's focal word — but never a function word. The planner's
  // focal can be a pronoun, and "这是你。/ 你有我吗？" is the kind of sentence that
  // makes the whole thing look broken.
  if (out.length < 2 && plan.focal?.wordId) {
    const tk = vocabToken(plan.focal.wordId);
    if (tk && !seen.has(tk.hanzi) && !coreSet(1).has(tk.hanzi)) out.push({ ...tk, isNew: true });
  }
  const picked = out.slice(0, 2);
  for (const w of picked) if (w.wordId) createCardsForWord(w.wordId);
  return picked;
}

// Words the learner has explicitly rejected ("something else", "boring"). A topic
// turned down once must not come back — not later in the session, and not as
// tomorrow's cross-session callback. This is the difference between a teacher who
// heard you and a lesson plan that happens to be running near you.
function rejectedHanzi() { return new Set(getModel('rejected_words', []) || []); }
function rejectWords(words = []) {
  const set = rejectedHanzi();
  for (const w of words) if (w?.hanzi) set.add(w.hanzi);
  setModel('rejected_words', [...set].slice(-40));
  // Drop them from the callback seed too, or tomorrow opens on the very thing they
  // asked to get away from — which is exactly how 高中 kept coming back.
  const callback = (getModel('last_session_words', []) || []).filter(h => !set.has(h));
  setModel('last_session_words', callback);
  return set;
}

// Swap the session onto a genuinely different set of words, mid-conversation. Used
// when the learner asks for something else: the arc restarts at `meet` with a new
// cluster rather than grinding on.
function reseedSessionWords(sessionWords) {
  const rejected = rejectWords(sessionWords);
  const introduced = introducedWordIds();
  const avoid = [...sessionWords, ...recentlyTaught()];
  const out = [];
  for (const cand of connectedBeginnerCluster(introduced, null, 24)) {
    if (rejected.has(cand.hanzi)) continue;
    if (tooSimilar(cand, avoid)) continue;
    if (tooSimilar(cand, out)) continue;
    if (cand.wordId) createCardsForWord(cand.wordId);
    out.push({ ...cand, isNew: true });
    if (out.length >= 2) break;
  }
  return out.length ? out : null;
}

// Mid-conversation growth: ONE further word, graph-connected to what's already in
// play and NOT already in the session. This is what makes a guided conversation
// travel — without it the whole arc is spent on the words chosen at turn zero.
function growSessionWord(sessionWords) {
  const introduced = introducedWordIds();
  const anchorId = sessionWords.find(w => w.wordId)?.wordId ?? null;
  const recent = recentlyTaught();
  const rejected = rejectedHanzi();
  for (const cand of connectedBeginnerCluster(introduced, anchorId, 10)) {
    if (rejected.has(cand.hanzi)) continue;
    if (tooSimilar(cand, sessionWords)) continue;
    if (tooSimilar(cand, recent, { chars: false })) continue;
    if (cand.wordId) createCardsForWord(cand.wordId);
    return { ...cand, isNew: true };
  }
  return null;
}

// Graph adjacency happily returns a near-synonym (车 → 汽车, both "car"), which
// makes the session look like it moved when it didn't — and teaching two words for
// one meaning in one sitting is actively confusing at this level. Reject anything
// that repeats a meaning or a character already in play.
// The words taught recently, as comparable tokens. The planner already refuses to
// re-introduce a word, but nothing stopped it teaching a SYNONYM of one (钱 on Monday,
// 金钱 on Wednesday), which reads as the app going in circles.
function recentlyTaught(limit = 30) {
  return db().prepare(`SELECT item_id FROM cards WHERE item_type='word'
    ORDER BY id DESC LIMIT ?`).all(limit)
    .map(r => vocabToken(r.item_id)).filter(Boolean);
}

// `chars: true` also rejects sharing a character (车 vs 火车) — right for words in
// the SAME sitting, too aggressive across weeks of history, where only a repeated
// MEANING is the problem.
function tooSimilar(cand, others, { chars = true } = {}) {
  const head = (g) => String(g || '').toLowerCase().split(/[;,(]/)[0].trim();
  for (const w of others) {
    if (!w) continue;
    if (w.hanzi === cand.hanzi) return true;
    if (head(w.gloss) && head(w.gloss) === head(cand.gloss)) return true;
    if (chars) for (const c of cand.hanzi) if (w.hanzi.includes(c)) return true;
  }
  return false;
}

// A connected cluster of picturable beginner nouns: start from the best picturable word
// (or a picturable graph-neighbour of the anchor), then prefer further picturable words
// that are graph-connected to what's chosen. Falls back to top picturable when the graph
// offers no picturable neighbour, so decodability is never sacrificed for connectedness.
function connectedBeginnerCluster(introduced, anchorId, n = 3) {
  if (n <= 0) return [];
  // A wide pool matters: the callers filter it hard (no synonyms, no shared
  // characters, nothing taught recently), and a thin pool made them fall through to
  // whatever the planner's focal happened to be.
  const pool = beginnerNewWords(30, { introduced });          // picturable nouns, ranked
  if (!pool.length) return [];
  const byId = new Map(pool.map(p => [p.id, p]));
  const chosen = [];
  // If we have a callback anchor, start from a picturable neighbour of it (grow outward).
  if (anchorId) {
    const nbr = graphNeighbors(anchorId, { limit: 60 }).find(x => byId.has(x.wordId));
    if (nbr) chosen.push(byId.get(nbr.wordId));
  }
  if (!chosen.length) chosen.push(pool[0]);
  while (chosen.length < n) {
    const have = new Set(chosen.map(c => c.id));
    // neighbours (in the picturable pool) of anything already chosen.
    let nextW = null;
    for (const c of chosen) {
      const nb = graphNeighbors(c.id, { limit: 60 }).find(x => byId.has(x.wordId) && !have.has(x.wordId));
      if (nb) { nextW = byId.get(nb.wordId); break; }
    }
    if (!nextW) nextW = pool.find(p => !have.has(p.id));      // fall back to top picturable
    if (!nextW) break;
    chosen.push(nextW);
  }
  return chosen.slice(0, n).map(p => vocabToken(p.id)).filter(Boolean);
}

// A warm, HONEST opening: reuse yesterday's words if we truly have them, else a
// concrete grounded micro-scene — never an invented personal memory (§7).
function openingLine(sessionWords) {
  const cb = sessionWords.find(w => w.callback);
  if (cb) return { hanzi: `上次我们说了${cb.hanzi}，今天再看看。`, pinyin: `Shàng cì wǒmen shuō le ${cb.pinyin}, jīntiān zài kàn kan.`, english: `Last time we did ${cb.gloss} — let's look again today.` };
  return { hanzi: '来，我们看几个东西。', pinyin: 'Lái, wǒmen kàn jǐ ge dōngxi.', english: "Come, let's look at a few things." };
}

// Start a conversation: pick the rung, build the plan; for guided rungs seed the
// session's words and store the ladder state. The blueprint is still built (local for
// guided rungs — avoids fabricated context and a needless cloud call).
export async function startConversation() {
  const rung = currentRung({ commit: true });   // one hysteresis step per conversation
  const knobs = rungKnobs(rung);
  const plan = buildLessonPlan();
  plan.scriptDirective = scriptDirective(plan.scriptLevel);

  let blueprint;
  if (rung >= 2) {
    const capMastery = plan.capability ? capabilityMastery(plan.capability.id).score : 0;
    blueprint = await buildBlueprint(plan, { capabilityMastery: capMastery, profileDigest: profileForPrompt() });
  } else {
    blueprint = buildBlueprintLocal(plan, {});   // grounded, no invented history
  }
  const unlock = pendingUnlock();
  if (unlock) { blueprint.capabilityUnlock = { name: unlock.name }; markUnlockAcked(unlock.id); }

  // Conversations grow with progression: the measured level scales the exchange
  // budget and new-concept allowance past the Director's conservative defaults.
  const prof = conversationProfile();
  blueprint.budget.exchanges = [
    Math.max(blueprint.budget.exchanges?.[0] || 4, prof.exchanges[0]),
    Math.max(blueprint.budget.exchanges?.[1] || 8, prof.exchanges[1]),
  ];
  blueprint.budget.newConcepts = Math.max(blueprint.budget.newConcepts || 1, prof.newConcepts);

  const id = genId();

  if (rung < 2) {
    const sessionWords = seedSessionWords(plan);
    // The guided session teaches exactly the words it meets → align targetVocab so
    // post-hoc scheduling (conversation.js) reviews precisely those.
    plan.targetVocab = sessionWords.map(w => ({ wordId: w.wordId, hanzi: w.hanzi, pinyin: w.pinyin, gloss: w.gloss, role: 'focal' }));
    setLadder(id, {
      rung, turnIndex: 0,
      beatIdx: 0, usedFrames: [], stuck: 0,
      sessionWords, introducedHanzi: sessionWords.map(w => w.hanzi),
      microGoal: plan.capability?.name || 'name and count a few everyday things',
      lastTeacherHanzi: '',
    });
  }

  db().prepare(`INSERT INTO conversation_sessions(id,capability_id,plan_json,blueprint_json,stage,exchanges,created,updated)
    VALUES(?,?,?,?,?,0,datetime('now'),datetime('now'))`)
    .run(id, plan.capability?.id ?? null, JSON.stringify(plan), JSON.stringify(blueprint), rung < 2 ? 'guided' : 'opening');

  return { sessionId: id, scriptLevel: plan.scriptLevel, scriptPref: getSetting('script_pref', 'hanzi'),
    rung, guided: rung < 2, hasThread: hasOpenThread(), blueprintEngine: blueprint._engine };
}

// The words this conversation is actually made of, as a recognition bias for the
// microphone. Whisper's language model resolves a learner's flat, hesitant syllable
// far more often when the words in play are in its initial prompt — and in this app we
// know exactly what those are, which a general-purpose recognizer never does. This is
// the concrete reason speaking here beats speaking to a generic chatbot.
export function sessionVocabHint(id) {
  const ladder = getLadder(id);
  const words = [
    ...(ladder?.sessionWords || []).map(w => w.hanzi),
    ...(ladder?.introducedHanzi || []),
    ladder?.lastTeacherHanzi || '',
  ].filter(Boolean);
  if (!words.length) return '';
  // Phrased as a sentence of context rather than a word list: Whisper's prompt is
  // conditioning text, not a lexicon, so prose primes it better than tokens.
  return `这是一节中文课。我们在说：${[...new Set(words)].join('、')}。`;
}

export function getSession(id) {
  const row = db().prepare('SELECT * FROM conversation_sessions WHERE id=?').get(id);
  if (!row) return null;
  return { id, capabilityId: row.capability_id, plan: safe(row.plan_json), blueprint: safe(row.blueprint_json),
    stage: row.stage, exchanges: row.exchanges, endedReason: row.ended_reason };
}
const safe = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

function hasOpenThread() {
  return !!db().prepare("SELECT 1 FROM personal_profile WHERE kind='thread' AND confidence>=0.4 LIMIT 1").get();
}

// One turn. Dispatches to the guided ladder (rung 0/1) or the free executor (rung 2).
export async function conversationTurn({ id, userText = '', history = [], forceWrap = false, shouldWrap: extWrap = false }) {
  const s = getSession(id);
  if (!s) throw new Error('conversation not found');
  const ladder = getLadder(id);
  const rung = ladder?.rung ?? currentRung();

  // Look at what the learner actually produced BEFORE deciding what to say back.
  // Every turn is now composed rather than tapped, so every turn is also a chance to
  // put a wrong tone or a missing measure word right — and the accept/repair verdict
  // is what feeds the ladder, replacing the tap-accuracy signal that choices gave.
  const correction = gradeProduction({ userText, ladder, rung });
  if (correction) recordProductionOutcome({ accepted: correction.accepted, aside: correction.aside });
  // What they reached for unprompted is the truest statement of what they care about,
  // and it is what steers which words they meet next.
  if (correction?.produced) {
    recordEngagement(segment(correction.produced).filter(w => !coreSet(2).has(w)));
  }

  const reply = (rung < 2 && ladder && ladder.sessionWords?.length)
    ? await guidedTurn({ id, s, ladder, userText, forceWrap, correction })
    : await freeTurn({ id, s, userText, history, forceWrap, extWrap, correction });
  return reply;
}

// ── Composed beginner turns ─────────────────────────────────────────────────
// The conversational beats of the arc now ask the model for a real turn instead of
// filling a template. Measured head-to-head (`npm run bakeoff`) the templates
// produced "你有X吗？" for five turns running while the model reacted to what the
// learner said and asked something back; Qwen matched Claude on this task at ~2.3×
// the speed and a fraction of the cost, so Qwen composes.
//
// Everything the templates guaranteed still holds: the turn is validated against the
// allowed set, gets ONE repair pass naming what leaked, and falls back to the frame
// if it drifts again or no backend is reachable.
// `combine` and the structural beats (meet/grow/win/farewell) stay deterministic:
// they carry guarantees — introduce a word, land the payoff, actually end — that a
// model must not be able to skip. These three are the conversational middle.
const COMPOSED_BEATS = new Set(['identify', 'relate', 'use']);
// What "invites a reply" means, in code — the same test the diagnostics probe uses.
const ASKS = /[？?]|吗|呢|什么|几|谁|哪|怎么样|为什么/;

// Which of today's words did the learner just reach for? That word is what the next
// turn should be about. Returns null when they named none of them (or when we have
// already followed the same word for two turns running — following the learner must
// not become grinding one noun, which is the failure `fixation` watches for).
function learnerFocus(userText, sessionWords, ladder = {}) {
  const said = String(userText || '');
  if (!said || !sessionWords?.length) return null;
  const hit = sessionWords.find(w => w.hanzi && said.includes(w.hanzi));
  if (!hit) return null;
  const streak = ladder.followedHanzi === hit.hanzi ? (ladder.followedStreak || 0) : 0;
  return streak >= 2 ? null : hit;
}

async function composeGuidedTurn({ goal, sessionWords, userText, rung, history, push, move, follow = null }) {
  if (!(await qwenAvailable())) return null;
  const allowed = allowedSet({ rung, sessionWords });
  const base = beginnerPrompt({ goal, allowed, sessionWords, userText, history, push, follow, move: talkMoveDirective(move) });
  let leaks = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply;
    try {
      reply = await laoshiCompose(attempt === 0 ? base
        : `${base}\n\nYour last attempt used words that are NOT on the list: ${leaks}. Rewrite using ONLY the list.`);
    } catch { return null; }
    if (!reply?.hanzi) return null;
    // A turn that asks nothing is the exact failure we replaced templates to escape,
    // so it is not worth keeping merely because a model wrote it. The frames always
    // ask; rejecting here means the fallback is strictly better than what we discard.
    if (!performsMove(reply.hanzi).ok) {
      if (attempt === 1) return null;
      leaks = '(that stated a fact and asked nothing — it MUST end by asking them something)';
      console.log('[guided] composed turn asked nothing — repairing');
      continue;
    }
    // Telling the model to stay on the learner's word is not enough on its own — a
    // small model drifts back to whatever is first on the vocabulary list. Checked,
    // not trusted.
    if (follow && !reply.hanzi.includes(follow.hanzi)) {
      if (attempt === 1) return null;
      leaks = `(that dropped ${follow.hanzi}, the word the learner just used — it MUST appear in your turn)`;
      console.log(`[guided] composed turn abandoned the learner's word ${follow.hanzi} — repairing`);
      continue;
    }
    const { ok, violations } = validateTurn(reply.hanzi, allowed);
    if (ok) return reply;
    if (attempt === 1) return null;                     // drifted twice → use the frame
    leaks = violations.join(' ');
    console.log(`[guided] composed turn leaked ${leaks} — repairing`);
  }
  return null;
}

async function laoshiCompose(prompt) {
  const r = await chat([
    { role: 'system', content: 'You write short beginner Mandarin conversation turns. Output strict JSON only.' },
    { role: 'user', content: prompt },
  ], { temperature: 0.7, max_tokens: 260, json: true, kind: 'guided' });
  const body = String(r.text || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try {
    const o = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
    if (!o?.hanzi) return null;
    return { hanzi: String(o.hanzi), pinyin: String(o.pinyin || '') || pinyinForHanzi(String(o.hanzi)), english: String(o.english || '') };
  } catch { return null; }
}

// The session's aim, in one plain line. Shown to the learner (a soft aim, not a task)
// because a conversation you can see the point of is one you can steer toward — the
// old sessions had a hidden arc and read as a sequence of unrelated facts.
function sessionGoal(sessionWords, plan) {
  // Include a word grown mid-session: the aim should describe where the conversation
  // actually went, not only where it started.
  const names = sessionWords.filter(w => w.gloss).map(w => shortGloss(w.gloss)).slice(0, 3);
  if (!names.length) return { en: 'have a short chat in Chinese', zh: '聊聊天' };
  return {
    en: `talk about ${names.join(' and ')}`,
    zh: `聊聊${sessionWords.slice(0, 3).map(w => w.hanzi).join('、')}`,
    capability: plan?.capability?.name || null,
  };
}

// The free rung has no frames to swap, so steering reaches it as a directive. The
// blueprint is a plan, not a contract with the learner — when they ask for something
// else, the plan is what gives way.
function steerDirective(userText) {
  const kind = classifyIntent(String(userText || '')).kind;
  if (kind === 'redirect') {
    return 'The learner has just asked to talk about something ELSE. Acknowledge it warmly in one short '
      + 'line and then genuinely change the subject — a different topic, not a rephrasing of the same one. '
      + 'Do not return to what you were discussing.';
  }
  if (kind === 'toohard') {
    return 'The learner says this is too hard or too fast. Slow down: shorter sentences, simpler words, '
      + 'and one idea per turn. Say something reassuring first.';
  }
  if (kind === 'tooeasy') {
    return 'The learner says this is too easy. Step up: longer turns, a less common word or two, and a '
      + 'question that needs a real answer rather than a yes/no.';
  }
  return '';
}

// Grade one learner turn against the sentence the previous teacher turn invited.
// Returns null for the opening turn (nothing was produced yet).
function gradeProduction({ userText, ladder, rung }) {
  if (!String(userText || '').trim()) return null;
  const t = conversationProfile().t;
  const evaluated = evaluateProduction({
    text: userText,
    // What they were invited to say — required for any claim about TONES, since
    // without a target a different tone is a different word, not an error.
    expected: ladder?.lastTeacherHanzi || null,
    t, rung,
    knownHanzi: new Set(knownHanzi()),
  });
  return { ...evaluated, recast: recastLine(evaluated) };
}

// ── Guided rungs (0/1): frame-built, validated, interlinear, never-strand ────
// A guided session follows an ARC, not a frame carousel. Each beat has a different
// job, and one beat (`grow`) brings in a brand-new word mid-conversation, so the
// talk travels instead of grinding the same two nouns through every template until
// a turn counter runs out. The arc reaching its end IS the ending — that's what
// makes the close feel earned rather than abrupt.
const ARC = ['meet', 'identify', 'relate', 'grow', 'use', 'combine', 'win', 'farewell'];
const HARD_CEILING = 10;                    // absolute backstop, arc normally ends first

async function guidedTurn({ id, s, ladder, userText, forceWrap, correction = null }) {
  const knobs = rungKnobs(ladder.rung);
  const { plan } = s;
  const prof = conversationProfile();
  let sessionWords = ladder.sessionWords || [];
  const opening = !userText;
  const exchanges = s.exchanges + (opening ? 0 : 1);
  const intent = opening ? { kind: 'opening' } : classifyIntent(userText, { prevTeacherHanzi: ladder.lastTeacherHanzi });

  // Where we are in the arc. A detour (confusion / "how do I say" / English meta)
  // does NOT consume a beat — but repeating the same beat three times does, so a
  // learner who keeps stalling still moves forward rather than looping forever.
  let beatIdx = ladder.beatIdx ?? 0;
  let stuck = ladder.stuck ?? 0;
  const detour = !opening && intent.kind !== 'normal';
  if (detour) stuck += 1; else stuck = 0;

  // ── The learner steering ────────────────────────────────────────────────
  // "I want to do something different" used to classify as `normal`, so the arc
  // absorbed it as an answer and carried on with the same nouns. Someone said it
  // twice and got drilled on 高中 both times. A steer is not a detour to be
  // waited out: it changes what the session IS.
  let steered = null;
  if (intent.kind === 'redirect') {
    const fresh = reseedSessionWords(sessionWords);
    if (fresh) {
      sessionWords = fresh;
      beatIdx = ARC.indexOf('meet');            // a new topic starts at the beginning
      stuck = 0;
      steered = 'redirect';
    } else {
      // Nothing else to offer is still worth SAYING, rather than pretending the
      // request was never made.
      steered = 'redirect-exhausted';
    }
  } else if (intent.kind === 'tooeasy') {
    // Bored is a real signal about difficulty. Bring the new word in NOW instead of
    // waiting for the `grow` beat, and let the ladder know they are under-stretched.
    beatIdx = Math.max(beatIdx, ARC.indexOf('grow'));
    steered = 'tooeasy';
  } else if (intent.kind === 'toohard') {
    beatIdx = Math.max(0, Math.min(beatIdx, ARC.indexOf('identify')));
    steered = 'toohard';
  }

  // The learner asked to stop → say goodbye now, properly. The arc's remaining
  // beats are not worth trapping someone in.
  if (forceWrap) beatIdx = ARC.indexOf('farewell');
  if (exchanges >= HARD_CEILING) beatIdx = Math.max(beatIdx, ARC.indexOf('win'));
  const beat = ARC[Math.min(beatIdx, ARC.length - 1)];
  const usedFrames = ladder.usedFrames || [];
  const wrap = beat === 'farewell';
  // The session's aim, recomputed after any steer so a redirected session gets a new
  // one rather than advertising the topic the learner just turned down.
  const goal = sessionGoal(sessionWords, plan);

  let reply, newWord = null, followed = null;
  const frameArgs = { rung: ladder.rung, sessionWords, exclude: usedFrames };

  if (beat === 'farewell') {
    reply = guidedFarewell(sessionWords, ladder);
    setModel('last_session_words', (ladder.introducedHanzi || []).slice(0, 3));   // honest callback seed
  } else if (beat === 'win') {
    reply = recombinationWin(sessionWords, ladder);
  } else if (detour && intent.kind === 'howdoisay') {
    const gap = expressionGapReply(intent.phrase);
    const target = sessionWords[0];
    reply = gap.tokens === null && gap.needsModel
      ? { hanzi: '用你会的词试试看，比如：', pinyin: 'Yòng nǐ huì de cí shì shi kàn, bǐrú:', english: 'Try with words you know, like:',
          tokens: groundTokens('用你会的词试试看。', {}), choices: [{ hanzi: `这是${target?.hanzi || '猫'}。`, pinyin: '', gloss: `This is ${target?.gloss || ''}.` }] }
      : { ...gap, tokens: gap.tokens || groundTokens(gap.hanzi, {}) };
    reply.followFrame = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex });
    reply.choices = reply.followFrame?.choices || reply.choices;
  } else if (detour && intent.kind === 'meta') {
    reply = { hanzi: '好问题！我们先用中文说说看。', pinyin: 'Hǎo wèntí! Wǒmen xiān yòng zhōngwén shuō shuo kàn.', english: "Good question! Let's try it in Chinese first.",
      tokens: groundTokens('我们用中文说说看。', {}) };
    reply.followFrame = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex });
    reply.choices = reply.followFrame?.choices || [];
  } else if (steered === 'redirect') {
    // Say yes, out loud, and then actually be somewhere else. The acknowledgement
    // matters as much as the swap: being redirected in silence still reads as not
    // having been heard.
    reply = {
      ...buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: 0, prefer: 'this-is', exclude: [] }),
      intro: { hanzi: '好，那我们说别的。', pinyin: 'Hǎo, nà wǒmen shuō biéde.', english: "Sure — let's talk about something else." },
      newWords: sessionWords.map(meetWord),
    };
  } else if (steered === 'redirect-exhausted') {
    reply = { hanzi: '好，我们换个说法。', pinyin: 'Hǎo, wǒmen huàn ge shuōfa.', english: "OK — let's come at it a different way.",
      tokens: groundTokens('好，我们换个说法。', {}) };
    reply.followFrame = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex + 3 });
  } else if (steered === 'toohard') {
    reply = regroundReply({ prevTeacherHanzi: ladder.lastTeacherHanzi, sessionWords });
    reply.intro = { hanzi: '好，我们慢一点。', pinyin: 'Hǎo, wǒmen màn yìdiǎn.', english: "OK — let's take it slower." };
    reply.followFrame = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex, prefer: 'this-is-q' });
  } else if (detour && intent.kind !== 'tooeasy') {   // confused / stall
    reply = regroundReply({ prevTeacherHanzi: ladder.lastTeacherHanzi, sessionWords });
    const frame = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex, prefer: 'this-is-q' });
    reply.followFrame = frame;
    reply.choices = frame?.choices || reply.choices;
  } else if (beat === 'meet') {
    reply = {
      ...buildFrameTurn({ ...frameArgs, turnIndex: 0, prefer: 'this-is' }),
      intro: openingLine(sessionWords),
      newWords: sessionWords.map(meetWord),
    };
  } else if (beat === 'grow') {
    // The turn that moves the conversation somewhere new.
    newWord = growSessionWord(sessionWords);
    if (newWord) {
      sessionWords = [...sessionWords, newWord];
      reply = {
        ...buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: 0, focusHanzi: newWord.hanzi, prefer: 'this-is', exclude: [] }),
        intro: steered === 'tooeasy'
          ? { hanzi: '好，那来个新的。', pinyin: 'Hǎo, nà lái ge xīn de.', english: "OK — here's a new one then." }
          : { hanzi: '还有一个词。', pinyin: 'Hái yǒu yí ge cí.', english: "Here's one more." },
        newWords: [meetWord(newWord)],
      };
    } else {
      reply = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex + 1 });
    }
  } else if (beat === 'combine') {
    // Two of today's words in one sentence — the first thing that sounds like a
    // real sentence rather than a drill.
    reply = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex + 1, pair: true })
      || buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex + 1 });
  } else {
    // identify / use / relate: the CONVERSATIONAL beats. The model composes a turn
    // that reacts to what the learner just said and asks something back; the frame is
    // the fallback, not the default.
    //
    // Focus used to rotate purely on the beat index, which is why a learner who said
    // 车 got asked "这是钱吗？" — the teacher moved to the next word on its list
    // regardless of the one they had just chosen. Rotation is the FALLBACK now: if the
    // learner named one of today's words, that word is the topic, because picking it up
    // is the whole difference between a conversation and a checklist being read aloud.
    followed = learnerFocus(userText, sessionWords, ladder);
    const focus = followed || (sessionWords.length ? sessionWords[(beatIdx + 1) % sessionWords.length] : null);
    let frame = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex + 1, focusHanzi: focus?.hanzi });
    const composed = COMPOSED_BEATS.has(beat)
      ? await composeGuidedTurn({ goal: goal.en, sessionWords, userText, rung: ladder.rung,
          history: ladder.history || [], push: strictness(prof.t, ladder.rung).band, follow: followed,
          move: pickMove({ history: ladder.history || [], userText, usedMoves: ladder.usedMoves || [], turnIndex: beatIdx }) })
      : null;
    // The fallback has to clear the same bar as the thing it replaces. Half the frames
    // are statements ("我有钱。"), and falling back to one turned a conversational beat
    // back into the broadcast we are trying to get rid of — so on these beats, insist
    // the frame asks something too.
    if (!composed && frame && !ASKS.test(frame.hanzi)) {
      frame = buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex + 1, focusHanzi: focus?.hanzi, prefer: 'this-is-q' })
        || buildFrameTurn({ ...frameArgs, turnIndex: ladder.turnIndex, prefer: 'do-you-like-q' })
        || frame;
    }
    // Keep the frame's choices/frameId bookkeeping even when the model wrote the
    // words, so within-session frame rotation and the model answer still work.
    //
    // `tokens` must NOT be inherited: they describe the frame's sentence, and at the
    // guided rungs the interlinear IS the sentence the learner reads. Keeping them
    // rendered one sentence word-by-word while `hanzi` (and the audio) said a
    // different one — most visibly when the composed turn reached for a word the
    // frame never used (你有多少钱？ shown with no gloss for 多少). Dropping them here
    // makes the grounding pass below re-derive them from the sentence actually sent.
    reply = composed ? { ...frame, ...composed, tokens: null, composed: true } : frame;
  }

  // A detour reply is TWO sentences: the human one ("没关系，我们慢慢来。" / "好问题！")
  // and the frame that keeps the conversation moving. The guided UI renders the
  // follow-up frame as the bubble's interlinear, which meant the human half — the
  // reassurance a confused beginner most needs — was computed, returned, and never
  // shown. Promote it to the lead-in slot, where it is rendered and grounded.
  // The comfort line MOVES rather than being copied: leaving it in `hanzi` too meant
  // the payload carried the same sentence twice, and any consumer rendering both
  // (including the diagnostics harness) saw it doubled.
  if (reply.followFrame && reply.hanzi && !reply.intro) {
    reply.intro = { hanzi: reply.hanzi, pinyin: reply.pinyin, english: reply.english };
    // `hanzi` and `tokens` must describe the SAME sentence, or a consumer that reads
    // one and renders the other shows a mismatch. The frame is now the main line.
    reply.hanzi = reply.followFrame.hanzi;
    reply.pinyin = reply.followFrame.pinyin;
    reply.english = reply.followFrame.english;
    reply.tokens = reply.followFrame.tokens;
  }

  // Ensure every teacher bubble is grounded word-by-word (§1.3), fade English per rung.
  reply.tokens = fadeTokens(reply.tokens || groundTokens(reply.hanzi, { newSet: new Set(sessionWords.filter(w => w.isNew).map(w => w.hanzi)) }), knobs);
  if (reply.followFrame) reply.followFrame.tokens = fadeTokens(reply.followFrame.tokens, knobs);
  // The lead-in and the goodbye are Chinese sentences too. They were the only text in
  // a guided turn shipped WITHOUT grounding — which meant the very first line of a
  // beginner's first session (来，我们看几个东西。) and the last line of every session
  // were unreadable to the one learner rung 0 exists for.
  for (const k of ['intro', 'outro']) {
    if (reply[k]?.hanzi) reply[k] = { ...reply[k], tokens: fadeTokens(groundTokens(reply[k].hanzi, {}), knobs) };
  }

  const lastHanzi = (reply.followFrame?.hanzi) || reply.hanzi;
  const spentFrame = reply.frameId || reply.followFrame?.frameId;
  // The frames still compute a well-formed answer to their own question; it just stops
  // being a button. Held back as the on-request model sentence the learner can ask to
  // see and then has to type themselves.
  const modelChoice = (reply.followFrame?.choices || reply.choices || [])[0]
    || (sessionWords[0] ? { hanzi: `这是${sessionWords[0].hanzi}。`, gloss: `This is ${sessionWords[0].gloss || ''}.` } : null);
  const modelHanzi = modelChoice?.hanzi || '';
  // Advance the arc unless this was a detour we're absorbing (3 detours in a row
  // advances anyway — never stuck on one beat).
  // A steer already moved the arc deliberately, so it must not also be treated as a
  // detour to absorb. Redirect and "too easy" move forward from where they landed;
  // "too hard" holds position so the easier beat actually gets a turn.
  const advance = steered
    ? (steered === 'redirect' || steered === 'tooeasy')
    : (!detour || stuck >= 3);
  setLadder(id, {
    ...ladder,
    sessionWords,
    introducedHanzi: newWord ? [...(ladder.introducedHanzi || []), newWord.hanzi] : ladder.introducedHanzi,
    turnIndex: ladder.turnIndex + 1,
    beatIdx: advance ? Math.min(beatIdx + 1, ARC.length - 1) : beatIdx,
    stuck: advance ? 0 : stuck,
    usedFrames: spentFrame ? [...usedFrames, spentFrame].slice(-8) : usedFrames,
    lastTeacherHanzi: lastHanzi,
    // How long we have been following the learner onto the same word, so that
    // responsiveness has a ceiling and cannot turn into fixation.
    followedHanzi: followed?.hanzi || null,
    followedStreak: followed ? (ladder.followedHanzi === followed.hanzi ? (ladder.followedStreak || 0) + 1 : 1) : 0,
    // A short rolling transcript so a composed turn can refer to what was actually
    // said rather than restarting the conversation every turn.
    history: [...(ladder.history || []),
      ...(userText ? [{ role: 'user', content: userText }] : []),
      ...(lastHanzi ? [{ role: 'assistant', content: lastHanzi }] : [])].slice(-8),
  });
  // A word introduced mid-arc must join the plan's targetVocab, or post-hoc
  // scheduling (conversation.js) would never review the word we just taught.
  if (newWord?.wordId) {
    plan.targetVocab = [...(plan.targetVocab || []),
      { wordId: newWord.wordId, hanzi: newWord.hanzi, pinyin: newWord.pinyin, gloss: newWord.gloss, role: 'focal' }];
    db().prepare('UPDATE conversation_sessions SET plan_json=? WHERE id=?').run(JSON.stringify(plan), id);
  }
  db().prepare(`UPDATE conversation_sessions SET stage='guided', exchanges=?, updated=datetime('now') WHERE id=?`).run(exchanges, id);

  const used = detectUsed({ hanzi: userText }, plan.targetVocab || []);
  return {
    ...reply,
    rung: ladder.rung, knobs, microGoal: ladder.microGoal,
    used, stage: 'guided', shouldWrap: !!wrap, wrapReason: wrap ? 'arc-complete' : null,
    closing: !wrap && beat === 'win',
    beat,
    guided: true, choices: [], steered,
    // Shown to the learner as a soft aim — a conversation you can see the point of is
    // one you can steer toward.
    goal,
    // What they said, and the version of it that is right — rendered under their own
    // bubble, not as a verdict on the turn.
    correction: correction?.recast || null,
    // The sentence this turn invites, kept back until the learner asks for it. It is
    // the never-strand guarantee without being a button that answers for them.
    modelAnswer: knobs.modelAnswer === 'on-request' && !wrap && modelHanzi
      ? { hanzi: modelHanzi,
          // Never show the model sentence without a reading — a sentence a beginner
          // cannot pronounce is not a model of anything. groundTokens carries the
          // CORE_PINYIN floor, so it produces one where the dictionary alone may not.
          pinyin: modelChoice?.pinyin || pinyinForHanzi(modelHanzi)
            || groundTokens(modelHanzi, {}).map(t => t.pinyin).filter(Boolean).join(' '),
          english: modelChoice?.gloss || reply.followFrame?.english || reply.english || '',
          tokens: groundTokens(modelHanzi, {}) }
      : null,
  };
}

// The score-free "win": present a slightly bigger sentence built from TODAY's words
// and invite the learner to say it — something they couldn't at the start (extra #5).
// A PAIR frame is the real payoff: two words they met today in one sentence.
function recombinationWin(sessionWords, ladder) {
  // Centre it on the word they met most recently and avoid the frame the `combine`
  // beat just used, so the payoff is a NEW bigger sentence rather than an echo. Not
  // every word can carry a two-word sentence (you don't "like" a body part), so try
  // each word as the focus until one actually yields a pair frame.
  const args = { rung: ladder.rung, sessionWords, turnIndex: 1, exclude: ladder.usedFrames || [] };
  const order = [...sessionWords].reverse();
  let frame = null;
  for (const w of order) {
    const f = buildFrameTurn({ ...args, focusHanzi: w.hanzi, pair: true });
    if (f?.frameId && f.hanzi.includes(w.hanzi) && /and|or/.test(f.english || '')) { frame = f; break; }
  }
  frame = frame
    || buildFrameTurn({ ...args, focusHanzi: order[0]?.hanzi })
    || buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: 0, prefer: 'i-like' });
  // The payoff must not be the sentence they just heard.
  if (frame && frame.hanzi === ladder.lastTeacherHanzi) {
    frame = buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: 0, focusHanzi: order[0]?.hanzi, prefer: 'i-like' }) || frame;
  }
  return {
    ...frame,
    intro: { hanzi: '你看，你现在能说了！', pinyin: 'Nǐ kàn, nǐ xiànzài néng shuō le!', english: 'Look — you can say it now!' },
    // No outro here: the goodbye is a SEPARATE beat, after they've had their turn.
    invite: true,
  };
}

// The end of the arc: name what they actually did today (the words they met — not a
// score, not a summary), then leave one concrete thread for next time. Deterministic,
// so a conversation always has an ending even when no model is reachable.
function guidedFarewell(sessionWords, ladder = {}) {
  const met = sessionWords.filter(w => w.isNew);
  const w = met[met.length - 1] || sessionWords[0];
  const list = met.slice(0, 3).map(x => x.gloss).filter(Boolean).join(', ');
  return {
    // Built only from core whitelist words, so every token is glossable whatever
    // the learner's vocabulary state.
    hanzi: '说得好！明天再见。',
    pinyin: 'Shuō de hǎo! Míngtiān zàijiàn.',
    english: list ? `Nicely said — today you can say ${list}. See you tomorrow.` : 'Nicely said! See you tomorrow.',
    outro: w ? {
      hanzi: `下次我们再说说${w.hanzi}。`,
      pinyin: `Xià cì wǒmen zài shuō shuo ${w.pinyin}.`,
      english: `Next time let's talk more about ${w.gloss}.`,
    } : null,
  };
}

function meetWord(w) {
  return { hanzi: w.hanzi, pinyin: w.pinyin, gloss: w.gloss, audioRef: w.audioRef || null, imageRef: w.imageRef || null, isNew: w.isNew !== false };
}

// Per-channel interlinear fade (extra #4): rung 0 shows gloss; rung 1 drops the
// English gloss (keeps pinyin); rung 2 uses reveal (handled on the free path).
function fadeTokens(tokens, knobs) {
  if (!tokens) return tokens;
  if (knobs.interlinear !== 'partial') return tokens;
  // The fade is meant to wean the learner off ENGLISH for words they already have —
  // not to blank the gloss on every word that merely isn't new this session. Keyed on
  // `isNew` alone it stripped the meaning from exactly the words that needed one: the
  // teacher's own scaffolding vocabulary (东西, 关系), which is neither known nor
  // introduced, so a rung-1 learner met it with no English at all.
  const known = new Set(knownHanzi());
  return tokens.map(t => (t.isNew || !known.has(t.hanzi)) ? t : { ...t, gloss: '' });
}

// Content words (non function-word segments) in a teacher turn — the rough "what
// this turn was ABOUT". Used to notice the model circling the same subject.
function contentWords(hanzi) {
  const core = coreSet(2);
  return segment(hanzi || '').filter(seg => seg.length >= 1 && !core.has(seg) && !/[。，？！、：；·]/.test(seg));
}

// ── Free rung (2): the existing Director-driven executor conversation ────────
async function freeTurn({ id, s, userText, history, forceWrap, extWrap, correction = null }) {
  const { plan, blueprint } = s;
  const prevStage = s.stage;
  const exchanges = s.exchanges + (userText ? 1 : 0);

  const soFar = [...history];
  if (userText && !history.some(m => m.role === 'user' && (m.content === userText || m.hanzi === userText))) soFar.push({ role: 'user', content: userText });
  const completion = liveCompletion(soFar, blueprint, plan, exchanges);
  // An absolute ceiling independent of the blueprint budget: measured level scales
  // the budget upward, and a conversation that has run this long has stopped being
  // a conversation. Without it, a drifting chat had no guaranteed end.
  const overrun = exchanges >= FREE_CEILING;
  const wantsWrap = forceWrap || extWrap || overrun || completion.shouldWrap;
  // Two-beat close: the first wrap turn winds down but leaves the learner a reply;
  // only the turn AFTER that actually ends the conversation.
  const alreadyClosing = prevStage === 'closing';
  const shouldWrap = alreadyClosing;

  // The final beat is built in CODE, not asked of the model. A small local model
  // asked to "close for real" would often open a new topic instead, which is why
  // conversations never actually ended. This one always does, and it names
  // something they really said.
  if (alreadyClosing || forceWrap) {
    const reply = freeFarewell(soFar, plan);
    db().prepare(`UPDATE conversation_sessions SET stage='wrap', exchanges=?, updated=datetime('now') WHERE id=?`).run(exchanges, id);
    return { ...reply, tokens: groundTokens(reply.hanzi, {}), rung: 2, knobs: rungKnobs(2),
      used: detectUsed(reply, plan.targetVocab || []), stage: 'farewell', shouldWrap: true,
      closing: false, wrapReason: completion.reason || 'closed', inlineRep: null, excursion: null,
      audioFirst: false, newWords: [] };
  }

  const calibration = computeCalibration(soFar);
  blueprint._calibration = calibration;
  let stage = conversationStage({ exchanges, budget: blueprint.budget, shouldWrap: wantsWrap });
  if (alreadyClosing) stage = 'farewell';
  if (!wantsWrap) {
    if (stage === 'introduce' && calibration <= -0.4) stage = 'explore';
    else if (stage === 'explore' && calibration >= 0.5 && exchanges >= 2) stage = 'introduce';
  }

  // Vocab-graph continuity: from the words actually in play this conversation, pick the
  // most natural adjacent concept and offer it to the executor as a soft steer, so the
  // chat drifts through RELATED ideas (like a real conversation) instead of a fixed list.
  const inPlay = inPlayWordIds(soFar, plan);
  const steer = graphSteer(inPlay, { known: knownWordIds(), introduced: introducedWordIds() });
  const memory = conversationMemory(soFar);

  // ANTI-FIXATION. A 9.7B model given a short vocabulary and a "stay on the
  // learner's level" instruction will happily ask about the same two nouns for
  // fifteen turns. So we track what the teacher has already been ON about this
  // conversation and tell it, explicitly, what not to re-litigate — plus one
  // concrete adjacent concept to move toward.
  const spent = getModel(topicsKey(id), []) || [];
  const ideas = nextConcepts(inPlay, { known: knownWordIds(), introduced: introducedWordIds(), limit: 4 });
  const freshIdea = [...(ideas.reuse || []), ...(ideas.grow || [])].find(c => !spent.includes(c.hanzi));
  const antiRepeat = spent.length
    ? `ALREADY COVERED this conversation: ${spent.slice(-8).join(' ')}. Do NOT ask about these again and do NOT build this turn around them — you have already made that point. Move on to something adjacent.`
    : '';

  const prof = conversationProfile();
  // One named talk move per turn, rotated in code and never repeating within three
  // turns, so the conversation cannot settle into a single shape.
  const usedMoves = getModel(movesKey(id), []) || [];
  const move = pickMove({ history: soFar, userText, usedMoves, turnIndex: exchanges });
  const converseArgs = {
    blueprint, stage, history, userText, graphSteer: steer, conversationMemory: memory,
    knownWords: knownStrings(), profileDigest: profileForPrompt(), scriptDirective: plan.scriptDirective,
    profile: prof,
    extraDirective: [antiRepeat,
      freshIdea ? `A natural next thing to bring up (only if it fits): ${freshIdea.hanzi} (${freshIdea.gloss || ''}).` : '',
      // Naming the exact error beats asking the model to "correct naturally" — told
      // only the latter, it invents a different mistake to fix, or fixes nothing.
      recastDirective(correction),
      // The learner steering the lesson outranks the blueprint. Without this the
      // executor keeps serving the plan's topic at someone who just said they want
      // a different one.
      steerDirective(userText),
      // ONE named Accountable-Talk move per turn, chosen in code. Asking the model to
      // "vary its turns" does not work — it settles on the easiest move, which for a
      // warm persona is the closed compliment that ends the conversation.
      talkMoveDirective(move),
    ].filter(Boolean).join('\n'),
  };
  let reply = await laoshiConverse(converseArgs);

  // Comprehensible input with SLACK. Every free-rung turn is shown with full pinyin
  // and an English translation, so a couple of unfamiliar words are readable — and
  // demanding a purely known-word vocabulary made the teacher sound stilted. So we
  // tolerate a small number of unknown content words and only regenerate when a turn
  // is genuinely dense with them (past that, it stops being comprehensible input).
  const allowed = allowedSet({ rung: 2, sessionWords: plan.targetVocab || [] });
  const UNKNOWN_TOLERANCE = 2;
  let unknown = reply.hanzi ? validateTurn(reply.hanzi, allowed).violations : [];

  // ONE regeneration slot per turn, whatever is wrong with the draft — too many
  // unmet words, or the same subject as the last few turns. A local 9.7B takes
  // ~30s a call, so stacking a second retry on top of the repair pass is how a
  // turn ends up taking three minutes.
  const said = contentWords(reply.hanzi);
  const recycled = said.length > 0 && said.every(w => spent.includes(w));
  const tooDense = unknown.length > UNKNOWN_TOLERANCE;
  // A turn that hands nothing back is a dead end, however warm it sounds. This is
  // the measured failure: "你有一只可爱的猫，真好。" — reacts, closes, and the learner
  // has nothing to answer.
  const perf = performsMove(reply.hanzi);
  // A two-character non-answer ("猫", "是很好") is a degenerate generation, not a
  // laconic turn — it appeared only when the prompt overran the local model's context.
  const degenerate = [...String(reply.hanzi || '')].filter(c => /[一-鿿]/.test(c)).length < 4;
  const deadEnd = !wantsWrap && (!perf.ok || degenerate);
  if (!wantsWrap && (recycled || tooDense || deadEnd)) {
    const why = [
      degenerate ? 'Your draft was too short to be a turn. Write a complete 1-2 sentence reply that reacts to what they said and asks them something.' : '',
      deadEnd && !degenerate ? (perf.closedCompliment
        ? 'Your draft ended on a closed compliment, which stops the conversation dead. Rewrite so it hands the turn back — perform the move you were given.'
        : 'Your draft gave them nothing to reply to. Rewrite so it ends by asking them something about what THEY said.') : '',
      tooDense ? `Your draft leaned on too many words this learner has not met (${unknown.join(' ')}). Say the same thing more simply — keep at most one or two of them.` : '',
      recycled ? `Your draft was about ${said.join(' ')} again — the same subject as your last turns. Change what you are talking about: react to what they just said and go somewhere new${freshIdea ? ` (e.g. ${freshIdea.hanzi})` : ''}.` : '',
    ].filter(Boolean).join(' ');
    const retry = await laoshiConverse({ ...converseArgs, extraDirective: `${converseArgs.extraDirective}\nREVISE: ${why} Stay natural; do not write a robotic sentence.` });
    if (retry.hanzi) {
      const v2 = validateTurn(retry.hanzi, allowed);
      const stillRecycled = contentWords(retry.hanzi).every(w => spent.includes(w));
      if (v2.violations.length <= unknown.length && !(recycled && stillRecycled)) { reply = retry; unknown = v2.violations; }
    }
    if (unknown.length > UNKNOWN_TOLERANCE) console.log(`[vocabguard] rung2 still dense: ${unknown.join(' ')} in "${reply.hanzi}"`);
  }

  // NEVER STRAND: a model that returns nothing (context overrun, timeout, a bad
  // JSON turn) must not surface as an empty bubble the learner can only stare at.
  // Fall back to a grounded frame turn built from the plan — the same machinery the
  // guided rung uses — so the conversation always has a next line.
  if (!reply.hanzi) {
    const fallback = freeFallbackTurn(plan);
    if (fallback) { reply = { ...fallback, note: '' }; unknown = []; }
  }
  // Surface whatever IS unfamiliar as glossed chips, so the slack above stays
  // comprehensible: the learner meets the new word instead of hitting a wall.
  const newWords = unknown.slice(0, 3).map(h => vocabToken(
    db().prepare('SELECT id FROM words WHERE hanzi=?').get(h)?.id) || {
      hanzi: h, pinyin: pinyinForHanzi(h), gloss: cleanGloss({ gloss: glossForHanzi(h) }), isNew: true })
    .filter(Boolean).map(w => ({ ...w, isNew: true }));
  const used = detectUsed(reply, plan.targetVocab || []);

  // Interlinear (reveal mode) still grounds the sentence word-by-word so a tap reveals
  // aligned pinyin+gloss.
  const newSet = new Set((plan.targetVocab || []).map(v => v.hanzi));
  const tokens = reply.hanzi ? groundTokens(reply.hanzi, { newSet }) : [];

  // Persist 'closing' (not 'wrap') so the next turn knows to deliver the farewell.
  const persistStage = shouldWrap ? 'wrap' : (wantsWrap ? 'closing' : stage);
  db().prepare(`UPDATE conversation_sessions SET stage=?, exchanges=?, updated=datetime('now') WHERE id=?`).run(persistStage, exchanges, id);

  const inlineRep = (stage === 'practice' && prevStage !== 'practice') ? buildInlineRep(plan) : null;
  const excursion = (stage === 'confirm' && prevStage !== 'confirm') ? buildExcursion(plan, blueprint) : null;

  const pres = presentationBias();
  const midConversation = stage === 'explore' || stage === 'introduce' || stage === 'practice';
  const audioFirst = !!reply.hanzi && midConversation && calibration > -0.2
    && pres.audioFirstProb > 0 && Math.random() < pres.audioFirstProb;

  if (reply.hanzi) setModel(topicsKey(id), [...spent, ...contentWords(reply.hanzi)].slice(-16));

  setModel(movesKey(id), [...usedMoves, move.name].slice(-8));
  return { ...reply, tokens, rung: 2, knobs: rungKnobs(2), used, stage, shouldWrap, move: move.name,
    closing: !shouldWrap && wantsWrap,
    // The model recasts inside its own line; this is the explicit before/after the
    // learner can look at afterwards. Both, because the recast alone is easy to miss.
    correction: correction?.recast || null,
    wrapReason: shouldWrap ? completion.reason : null, inlineRep, excursion, audioFirst, newWords };
}

// The free rung's safety net when the model gives us nothing: a real, grounded
// question built from the plan's own vocabulary. Deliberately simple — its job is to
// keep the conversation alive, not to be clever.
function freeFallbackTurn(plan) {
  const words = (plan.targetVocab || [])
    .map(v => (v.wordId ? vocabToken(v.wordId) : null))
    .filter(Boolean);
  const frame = words.length ? buildFrameTurn({ rung: 1, sessionWords: words, turnIndex: 1 }) : null;
  if (frame) return frame;
  return { hanzi: '今天怎么样？', pinyin: 'Jīntiān zěnmeyàng?', english: 'How was today?',
    tokens: groundTokens('今天怎么样？', {}) };
}

// The free rung's final line, built in code. It closes on something the learner
// actually said this conversation, so it reads as an ending to THIS talk rather
// than a generic sign-off — and it can never wander into a new topic.
function freeFarewell(transcript = [], plan = {}) {
  const lookup = db().prepare('SELECT hanzi, gloss, english FROM words WHERE hanzi=?');
  let thread = null;
  for (let i = transcript.length - 1; i >= 0 && !thread; i--) {
    const t = transcript[i];
    if (t.role !== 'user') continue;
    for (const seg of segment(t.hanzi || t.content || '')) {
      const w = lookup.get(seg);
      if (!w || coreSet(2).has(seg)) continue;
      const gloss = shortGloss(w.gloss || w.english);
      if (!isNamable(gloss)) continue;          // don't promise to discuss "to count as"
      thread = { hanzi: seg, gloss };
      break;
    }
  }
  if (!thread) {
    const tv = (plan.targetVocab || []).find(v => v.hanzi && isNamable(v.gloss));
    if (tv) thread = { hanzi: tv.hanzi, gloss: tv.gloss };
  }
  return thread
    ? { hanzi: `好，今天就聊到这儿。下次再说说${thread.hanzi}。明天见！`,
        pinyin: `Hǎo, jīntiān jiù liáo dào zhèr. Xià cì zài shuō shuo ${pinyinForHanzi(thread.hanzi) || ''}. Míngtiān jiàn!`,
        english: `OK — let's stop here today. Next time let's talk more about ${thread.gloss || thread.hanzi}. See you tomorrow!`, note: '' }
    : { hanzi: '好，今天就聊到这儿。明天见！', pinyin: 'Hǎo, jīntiān jiù liáo dào zhèr. Míngtiān jiàn!',
        english: "OK — let's stop here today. See you tomorrow!", note: '' };
}

// A single recognition rep on a focal/target word, wired to the real scheduler via
// the existing buildExercise/submitReview engines. Rendered inline as a chat bubble.
function buildInlineRep(plan) {
  const target = (plan.targetVocab || []).find(v => v.role === 'focal') || (plan.targetVocab || [])[0];
  if (!target?.wordId) return null;
  createCardsForWord(target.wordId);
  const card = db().prepare(`SELECT * FROM cards WHERE item_type='word' AND item_id=? AND card_type='memory'`).get(target.wordId);
  if (!card) return null;
  const ex = buildExercise({ card, dimension: 'meaning', knownWordIds: knownWordIds(), isNew: false });
  if (!ex) return null;
  const distractors = (plan.targetVocab || [])
    .filter(v => v.wordId !== target.wordId && v.gloss).slice(0, 2).map(v => v.gloss);
  const options = shuffle([ex.gloss, ...distractors, ...fallbackDistractors(2 - distractors.length)].filter(Boolean).slice(0, 3));
  return { kind: 'recognition', cardId: ex.cardId, wordId: target.wordId,
    hanzi: ex.hanzi, pinyin: ex.pinyin, gloss: ex.gloss, audio: ex.audio, options };
}

function fallbackDistractors(n) {
  if (n <= 0) return [];
  return db().prepare(`SELECT english, gloss FROM words WHERE gloss IS NOT NULL OR english IS NOT NULL
    ORDER BY RANDOM() LIMIT ?`).all(n).map(w => cleanGloss(w)).filter(Boolean);
}
function shuffle(a) { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor((i + 1) * pseudo(i)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
function pseudo(seed) { const v = Math.sin((seed + 1) * 999) * 10000; return v - Math.floor(v); }

function buildExcursion(plan, blueprint) {
  const planned = (blueprint.excursions || [])[0];
  const shadow = buildShadowing(plan);
  if (shadow.length >= 2 && planned?.kind !== 'reading') {
    return {
      kind: 'shadowing',
      enterLine: (planned?.kind === 'shadowing' && planned.enterLine) || { hanzi: '来，跟我念一遍。', pinyin: 'Lái, gēn wǒ niàn yí biàn.', english: 'Here, say these after me.' },
      exitBridge: (planned?.kind === 'shadowing' && planned.exitBridge) || { hanzi: '念得挺好！我们接着聊。', pinyin: 'Niàn de tǐng hǎo! Wǒmen jiēzhe liáo.', english: 'Nicely said! Let\'s keep chatting.' },
      shadow: { items: shadow, targetVocab: (plan.targetVocab || []).map(v => ({ wordId: v.wordId, hanzi: v.hanzi, pinyin: v.pinyin })) },
    };
  }
  const weak = weakTone();
  if (planned?.kind !== 'reading') {
    const drill = buildToneDrill(weak?.pair, 6);
    if (!drill?.length) return null;
    return {
      kind: 'tone_drill',
      enterLine: planned?.enterLine || { hanzi: '来，跟我念几个词。', pinyin: 'Lái, gēn wǒ niàn jǐ gè cí.', english: "Here, read a few words after me." },
      exitBridge: planned?.exitBridge || { hanzi: '念得不错！我们接着聊。', pinyin: 'Niàn de búcuò! Wǒmen jiēzhe liáo.', english: "Nicely read! Let's keep chatting." },
      drill: { tone: weak?.tone ?? null, pair: weak?.pair ?? null, items: drill },
    };
  }
  return null;
}

function buildShadowing(plan) {
  const targets = (plan.targetVocab || []).filter(v => v.wordId);
  if (!targets.length) return [];
  const out = [];
  const seen = new Set();
  for (const v of targets) {
    const rows = db().prepare(`SELECT hanzi, pinyin, english FROM sentences
      WHERE word_ids LIKE ? AND length(hanzi) BETWEEN 3 AND 14 ORDER BY length(hanzi) ASC LIMIT 2`)
      .all(`%${v.wordId}%`);
    for (const r of rows) {
      if (seen.has(r.hanzi)) continue;
      seen.add(r.hanzi);
      out.push({ hanzi: r.hanzi, pinyin: r.pinyin || '', english: r.english || '' });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

export function sessionPlan(id) {
  const s = getSession(id);
  return s?.plan || null;
}

export function markEnded(id, reason) {
  db().prepare(`UPDATE conversation_sessions SET ended_reason=?, updated=datetime('now') WHERE id=?`).run(reason || 'complete', id);
}
