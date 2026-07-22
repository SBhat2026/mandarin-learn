// Conversation session manager. One row per conversation holds the capability-keyed
// plan and the Director's blueprint so turns don't re-plan, plus the hidden stage.
// Turns advance the stage, run the Qwen executor, and occasionally attach a light
// inline rep or a framed excursion — the surface the UI renders as one thread.
import { db } from './db.js';
import { buildLessonPlan } from './neighborhood.js';
import { buildBlueprint } from './director.js';
import { profileForPrompt } from './profile.js';
import { laoshiConverse, conversationStage } from './qwen.js';
import { knownWordIds, refreshStage } from './planner.js';
import { scriptDirective, scriptLevel } from './learner.js';
import { detectUsed } from './conversation.js';
import { capabilityMastery } from './capabilities.js';
import { buildExercise, cleanGloss } from './exercises.js';
import { createCardsForWord } from './cards.js';
import { weakTone, buildToneDrill } from './tone.js';
import { liveCompletion } from './momentum.js';

function genId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function knownStrings(limit = 400) {
  const known = [...knownWordIds()];
  return known.length
    ? db().prepare(`SELECT hanzi FROM words WHERE id IN (${known.map(() => '?').join(',')}) ORDER BY freq_rank LIMIT ${limit}`).all(...known).map(r => r.hanzi)
    : [];
}

// Start a conversation: build the capability-keyed plan + blueprint once and store.
export async function startConversation() {
  const plan = buildLessonPlan();
  plan.scriptDirective = scriptDirective(plan.scriptLevel);
  const capMastery = plan.capability ? capabilityMastery(plan.capability.id).score : 0;
  const blueprint = await buildBlueprint(plan, { capabilityMastery: capMastery, profileDigest: profileForPrompt() });
  const id = genId();
  db().prepare(`INSERT INTO conversation_sessions(id,capability_id,plan_json,blueprint_json,stage,exchanges,created,updated)
    VALUES(?,?,?,?,?,0,datetime('now'),datetime('now'))`)
    .run(id, plan.capability?.id ?? null, JSON.stringify(plan), JSON.stringify(blueprint), 'opening');
  // The UI needs almost nothing from the plan (no target chips, no objectives) —
  // just enough to drive script rendering and to send back on complete.
  return { sessionId: id, scriptLevel: plan.scriptLevel, hasThread: hasOpenThread(), blueprintEngine: blueprint._engine };
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

// One turn: advance the hidden stage, run the executor, decide inline rep / excursion.
// `momentum`/`shouldWrap` come from Workstream F (completion); here we honor an
// explicit forceWrap and the budget ceiling so the flow is complete without it.
export async function conversationTurn({ id, userText = '', history = [], forceWrap = false, shouldWrap: extWrap = false }) {
  const s = getSession(id);
  if (!s) throw new Error('conversation not found');
  const { plan, blueprint } = s;
  const prevStage = s.stage;
  const exchanges = s.exchanges + (userText ? 1 : 0);

  // Completion is driven by momentum + education, not a fixed turn count. Build the
  // transcript so far (history + this learner turn) to evaluate live signals.
  const soFar = [...history];
  if (userText && !history.some(m => m.role === 'user' && (m.content === userText || m.hanzi === userText))) soFar.push({ role: 'user', content: userText });
  const completion = liveCompletion(soFar, blueprint, plan, exchanges);   // authoritative exchange count
  const shouldWrap = forceWrap || extWrap || completion.shouldWrap;
  const stage = conversationStage({ exchanges, budget: blueprint.budget, shouldWrap });

  const reply = await laoshiConverse({
    blueprint, stage, history, userText,
    knownWords: knownStrings(), profileDigest: profileForPrompt(), scriptDirective: plan.scriptDirective,
  });
  const used = detectUsed(reply, plan.targetVocab || []);

  db().prepare(`UPDATE conversation_sessions SET stage=?, exchanges=?, updated=datetime('now') WHERE id=?`)
    .run(stage, exchanges, id);

  // Light inline rep at the first 'practice' turn; a framed excursion at the first
  // 'confirm' turn (once each per conversation, keyed off the stage transition).
  const inlineRep = (stage === 'practice' && prevStage !== 'practice') ? buildInlineRep(plan) : null;
  const excursion = (stage === 'confirm' && prevStage !== 'confirm') ? buildExcursion(plan, blueprint) : null;

  return { ...reply, used, stage, shouldWrap, wrapReason: completion.reason, inlineRep, excursion };
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
  // Three gloss options (the answer + two distractors from other target words).
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
// Deterministic-ish jitter without Math.random dependence on call-site ordering.
function pseudo(seed) { const v = Math.sin((seed + 1) * 999) * 10000; return v - Math.floor(v); }

// A framed heavy excursion: a short tone-drill run when a weak tone exists (always
// available offline). Entered with a diegetic line, returned with a bridge sentence.
// TODO(capability:) a reading-passage excursion for narrative capabilities.
function buildExcursion(plan, blueprint) {
  // Prefer an excursion the Director explicitly planned; otherwise offer a short
  // tone-drill run — targeted at the weakest tone when known, else a general set of
  // minimal pairs (always useful for a beginner ear).
  const planned = (blueprint.excursions || [])[0];
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

// Post-hoc inference lives in conversation.js (extended in Workstream F). This thin
// wrapper resolves the stored plan so the /complete endpoint stays plan-agnostic.
export function sessionPlan(id) {
  const s = getSession(id);
  return s?.plan || null;
}

export function markEnded(id, reason) {
  db().prepare(`UPDATE conversation_sessions SET ended_reason=?, updated=datetime('now') WHERE id=?`).run(reason || 'complete', id);
}
