// Conversation session manager + the ladder orchestrator. One row per conversation
// holds the capability-keyed plan and the Director's blueprint so turns don't re-plan.
// The RUNG (rung.js) decides how a turn is produced:
//   rung 0/1 — guided: fully-scaffolded, frame-built, code-validated, interlinear
//              turns with meet-the-words beats and scaffolded choices (vocabguard).
//   rung 2   — free: the existing Director/blueprint/Qwen-executor conversation.
// The guided rungs never strand the learner (intent.js) and always find a way forward.
import { db, getModel, setModel } from './db.js';
import { buildLessonPlan } from './neighborhood.js';
import { buildBlueprint, buildBlueprintLocal } from './director.js';
import { profileForPrompt } from './profile.js';
import { laoshiConverse, conversationStage } from './qwen.js';
import { knownWordIds, introducedWordIds } from './planner.js';
import { createCardsForWord } from './cards.js';
import { scriptDirective, scriptLevel, presentationBias } from './learner.js';
import { detectUsed } from './conversation.js';
import { capabilityMastery, pendingUnlock, markUnlockAcked } from './capabilities.js';
import { buildExercise, cleanGloss } from './exercises.js';
import { weakTone, buildToneDrill } from './tone.js';
import { liveCompletion, computeCalibration } from './momentum.js';
import { currentRung, rungKnobs } from './rung.js';
import { allowedSet, buildFrameTurn, groundTokens, beginnerNewWords, vocabToken, validateTurn, segment } from './vocabguard.js';
import { classifyIntent, regroundReply, expressionGapReply } from './intent.js';
import { graphNeighbors, graphSteer, nextConcepts } from './graphwalk.js';

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

// Seed a small, GRAPH-CONNECTED cluster of concrete/picturable words for a guided
// session — each word reinforces the last (shared topic/character/co-occurrence) so the
// set feels like one little world, not three random flashcards. Reuses ONE word from the
// previous session (honest spaced callback) and grows OUTWARD along the graph from it,
// so sessions chain like a real relationship. Cards are created so words enter scheduling.
function seedSessionWords(plan) {
  const introduced = introducedWordIds();
  const out = [], seen = new Set();
  const callback = getModel('last_session_words', []) || [];
  let anchorId = null;
  for (const h of callback.slice(0, 1)) {
    const row = db().prepare('SELECT id FROM words WHERE hanzi=?').get(h);
    const tk = row && vocabToken(row.id);
    if (tk && !seen.has(tk.hanzi)) { out.push({ ...tk, isNew: false, callback: true }); seen.add(tk.hanzi); anchorId = row.id; }
  }
  // Keep the set SMALL (≤3) so each new word recurs several times (within-session
  // spacing); prefer words graph-connected to the anchor (or to each other).
  for (const w of connectedBeginnerCluster(introduced, anchorId, 3 - out.length)) {
    if (seen.has(w.hanzi)) continue;
    out.push({ ...w, isNew: true }); seen.add(w.hanzi);
    if (out.length >= 3) break;
  }
  if (out.length < 2 && plan.focal?.wordId) {
    const tk = vocabToken(plan.focal.wordId);
    if (tk && !seen.has(tk.hanzi)) out.push({ ...tk, isNew: true });
  }
  const picked = out.slice(0, 3);
  for (const w of picked) if (w.wordId) createCardsForWord(w.wordId);
  return picked;
}

// A connected cluster of picturable beginner nouns: start from the best picturable word
// (or a picturable graph-neighbour of the anchor), then prefer further picturable words
// that are graph-connected to what's chosen. Falls back to top picturable when the graph
// offers no picturable neighbour, so decodability is never sacrificed for connectedness.
function connectedBeginnerCluster(introduced, anchorId, n = 3) {
  if (n <= 0) return [];
  const pool = beginnerNewWords(10, { introduced });          // picturable nouns, ranked
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

  const id = genId();

  if (rung < 2) {
    const sessionWords = seedSessionWords(plan);
    // The guided session teaches exactly the words it meets → align targetVocab so
    // post-hoc scheduling (conversation.js) reviews precisely those.
    plan.targetVocab = sessionWords.map(w => ({ wordId: w.wordId, hanzi: w.hanzi, pinyin: w.pinyin, gloss: w.gloss, role: 'focal' }));
    setLadder(id, {
      rung, turnIndex: 0,
      sessionWords, introducedHanzi: sessionWords.map(w => w.hanzi),
      microGoal: plan.capability?.name || 'name and count a few everyday things',
      lastTeacherHanzi: '',
    });
  }

  db().prepare(`INSERT INTO conversation_sessions(id,capability_id,plan_json,blueprint_json,stage,exchanges,created,updated)
    VALUES(?,?,?,?,?,0,datetime('now'),datetime('now'))`)
    .run(id, plan.capability?.id ?? null, JSON.stringify(plan), JSON.stringify(blueprint), rung < 2 ? 'guided' : 'opening');

  return { sessionId: id, scriptLevel: plan.scriptLevel, rung, guided: rung < 2, hasThread: hasOpenThread(), blueprintEngine: blueprint._engine };
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
  if (rung < 2 && ladder && ladder.sessionWords?.length) return guidedTurn({ id, s, ladder, userText, forceWrap });
  return freeTurn({ id, s, userText, history, forceWrap, extWrap });
}

// ── Guided rungs (0/1): frame-built, validated, interlinear, never-strand ────
function guidedTurn({ id, s, ladder, userText, forceWrap }) {
  const knobs = rungKnobs(ladder.rung);
  const { plan } = s;
  const sessionWords = ladder.sessionWords || [];
  const opening = !userText;
  const exchanges = s.exchanges + (opening ? 0 : 1);
  const intent = opening ? { kind: 'opening' } : classifyIntent(userText, { prevTeacherHanzi: ladder.lastTeacherHanzi });

  // Completion: a short, bounded guided arc. Wrap on a recombination "win" once the
  // learner has met and reused the words a few times (or a hard ceiling).
  const [minEx, maxEx] = [4, 7];
  const wrap = forceWrap || exchanges >= maxEx || (exchanges >= minEx && intent.kind === 'normal' && ladder.turnIndex >= minEx);

  let reply;
  if (wrap) {
    reply = recombinationWin(sessionWords, ladder);
    setModel('last_session_words', ladder.introducedHanzi.slice(0, 3));   // honest callback seed for next time
  } else if (opening) {
    const frame = buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: 0 });
    reply = {
      ...frame,
      intro: openingLine(sessionWords),
      newWords: sessionWords.map(meetWord),
    };
  } else if (intent.kind === 'confused' || intent.kind === 'stall') {
    reply = regroundReply({ prevTeacherHanzi: ladder.lastTeacherHanzi, sessionWords });
    // Still move forward: re-ask a simple frame after re-grounding.
    const frame = buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: ladder.turnIndex, prefer: 'this-is-q' });
    reply.followFrame = frame;
    reply.choices = frame.choices;
  } else if (intent.kind === 'howdoisay') {
    const gap = expressionGapReply(intent.phrase);
    // Offline: nudge circumlocution and offer a session word to try — never stranded.
    const target = sessionWords[0];
    reply = gap.tokens === null && gap.needsModel
      ? { hanzi: '用你会的词试试看，比如：', pinyin: 'Yòng nǐ huì de cí shì shi kàn, bǐrú:', english: 'Try with words you know, like:',
          tokens: groundTokens('用你会的词试试看。', {}), choices: [{ hanzi: `这是${target?.hanzi || '猫'}。`, pinyin: '', gloss: `This is ${target?.gloss || ''}.` }] }
      : { ...gap, tokens: gap.tokens || groundTokens(gap.hanzi, {}) };
  } else if (intent.kind === 'meta') {
    reply = { hanzi: '好问题！我们先用中文说说看。', pinyin: 'Hǎo wèntí! Wǒmen xiān yòng zhōngwén shuō shuo kàn.', english: "Good question! Let's try it in Chinese first.",
      tokens: groundTokens('我们用中文说说看。', {}) };
    const frame = buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: ladder.turnIndex });
    reply.followFrame = frame; reply.choices = frame.choices;
  } else {
    // Normal: advance with the next frame, rotating focus so every word recurs
    // (within-session spacing — extra #1).
    const focusHanzi = sessionWords.length ? sessionWords[(ladder.turnIndex) % sessionWords.length].hanzi : null;
    reply = buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: ladder.turnIndex + 1, focusHanzi });
  }

  // Ensure every teacher bubble is grounded word-by-word (§1.3), fade English per rung.
  reply.tokens = fadeTokens(reply.tokens || groundTokens(reply.hanzi, { newSet: new Set(sessionWords.filter(w => w.isNew).map(w => w.hanzi)) }), knobs);
  if (reply.followFrame) reply.followFrame.tokens = fadeTokens(reply.followFrame.tokens, knobs);

  const lastHanzi = (reply.followFrame?.hanzi) || reply.hanzi;
  setLadder(id, { ...ladder, turnIndex: ladder.turnIndex + 1, lastTeacherHanzi: lastHanzi });
  db().prepare(`UPDATE conversation_sessions SET stage='guided', exchanges=?, updated=datetime('now') WHERE id=?`).run(exchanges, id);

  const used = detectUsed({ hanzi: userText }, plan.targetVocab || []);
  return {
    ...reply,
    rung: ladder.rung, knobs, microGoal: ladder.microGoal,
    used, stage: 'guided', shouldWrap: !!wrap, wrapReason: wrap ? 'guided-complete' : null,
    guided: true, choices: knobs.choices ? (reply.choices || []) : [],
  };
}

// The score-free "win": present a slightly bigger sentence built from TODAY's words
// and invite the learner to say it — something they couldn't at the start (extra #5).
function recombinationWin(sessionWords, ladder) {
  const frame = buildFrameTurn({ rung: ladder.rung, sessionWords, turnIndex: 0, prefer: ladder.rung >= 1 ? 'i-like' : 'i-have-num', num: 2 });
  return {
    ...frame,
    intro: { hanzi: '你看，你现在能说了！', pinyin: 'Nǐ kàn, nǐ xiànzài néng shuō le!', english: 'Look — you can say it now!' },
    outro: { hanzi: '很好，明天再聊。', pinyin: 'Hěn hǎo, míngtiān zài liáo.', english: 'Great — talk tomorrow.' },
    invite: true,
  };
}

function meetWord(w) {
  return { hanzi: w.hanzi, pinyin: w.pinyin, gloss: w.gloss, audioRef: w.audioRef || null, imageRef: w.imageRef || null, isNew: w.isNew !== false };
}

// Per-channel interlinear fade (extra #4): rung 0 shows gloss; rung 1 drops the
// English gloss (keeps pinyin); rung 2 uses reveal (handled on the free path).
function fadeTokens(tokens, knobs) {
  if (!tokens) return tokens;
  if (knobs.interlinear === 'partial') return tokens.map(t => ({ ...t, gloss: t.isNew ? t.gloss : '' }));
  return tokens;
}

// ── Free rung (2): the existing Director-driven executor conversation ────────
async function freeTurn({ id, s, userText, history, forceWrap, extWrap }) {
  const { plan, blueprint } = s;
  const prevStage = s.stage;
  const exchanges = s.exchanges + (userText ? 1 : 0);

  const soFar = [...history];
  if (userText && !history.some(m => m.role === 'user' && (m.content === userText || m.hanzi === userText))) soFar.push({ role: 'user', content: userText });
  const completion = liveCompletion(soFar, blueprint, plan, exchanges);
  const shouldWrap = forceWrap || extWrap || completion.shouldWrap;

  const calibration = computeCalibration(soFar);
  blueprint._calibration = calibration;
  let stage = conversationStage({ exchanges, budget: blueprint.budget, shouldWrap });
  if (!shouldWrap) {
    if (stage === 'introduce' && calibration <= -0.4) stage = 'explore';
    else if (stage === 'explore' && calibration >= 0.5 && exchanges >= 2) stage = 'introduce';
  }

  // Vocab-graph continuity: from the words actually in play this conversation, pick the
  // most natural adjacent concept and offer it to the executor as a soft steer, so the
  // chat drifts through RELATED ideas (like a real conversation) instead of a fixed list.
  const inPlay = inPlayWordIds(soFar, plan);
  const steer = graphSteer(inPlay, { known: knownWordIds(), introduced: introducedWordIds() });
  const memory = conversationMemory(soFar);

  const reply = await laoshiConverse({
    blueprint, stage, history, userText, graphSteer: steer, conversationMemory: memory,
    knownWords: knownStrings(), profileDigest: profileForPrompt(), scriptDirective: plan.scriptDirective,
  });
  const used = detectUsed(reply, plan.targetVocab || []);

  // Interlinear (reveal mode) still grounds the sentence word-by-word so a tap reveals
  // aligned pinyin+gloss; validation is logged (hidden) to watch free-rung drift.
  const newSet = new Set((plan.targetVocab || []).map(v => v.hanzi));
  const tokens = reply.hanzi ? groundTokens(reply.hanzi, { newSet }) : [];
  if (reply.hanzi) {
    const { ok, violations } = validateTurn(reply.hanzi, allowedSet({ rung: 2, sessionWords: plan.targetVocab || [] }));
    if (!ok) console.log(`[vocabguard] rung2 out-of-set: ${violations.join(' ')} in "${reply.hanzi}"`);
  }

  db().prepare(`UPDATE conversation_sessions SET stage=?, exchanges=?, updated=datetime('now') WHERE id=?`).run(stage, exchanges, id);

  const inlineRep = (stage === 'practice' && prevStage !== 'practice') ? buildInlineRep(plan) : null;
  const excursion = (stage === 'confirm' && prevStage !== 'confirm') ? buildExcursion(plan, blueprint) : null;

  const pres = presentationBias();
  const midConversation = stage === 'explore' || stage === 'introduce' || stage === 'practice';
  const audioFirst = !!reply.hanzi && midConversation && calibration > -0.2
    && pres.audioFirstProb > 0 && Math.random() < pres.audioFirstProb;

  return { ...reply, tokens, rung: 2, knobs: rungKnobs(2), used, stage, shouldWrap, wrapReason: completion.reason, inlineRep, excursion, audioFirst };
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
