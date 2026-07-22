import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { db, initSchema, MEDIA_DIR, getSetting } from './db.js';
import { buildSession, buildLesson, submitReview, currentUnit, unitProgress } from './session.js';
import { inferTraits } from './learner.js';
import { knownWordIds } from './planner.js';
import { runBackground } from './reasoner.js';
import { laoshiReply, laoshiLesson, available as laoshiAvailable } from './qwen.js';
import { buildLessonPlan } from './neighborhood.js';
import { scheduleFromConversation, detectUsed, observePronunciation } from './conversation.js';
import { startConversation, conversationTurn, sessionPlan, markEnded } from './converse.js';
import { scriptDirective, personaDirective, scriptLevel } from './learner.js';
import { fullStats } from './stats.js';
import { evaluateThrottle } from './scheduler.js';
import { lookup } from './dictionary.js';
import { passages } from './reading.js';
import { buildToneDrill, toneStats, weakTone } from './tone.js';
import { saveOnboarding, onboardingState } from './onboarding.js';
import { TOPICS } from './taxonomy.js';
import { State } from './fsrs.js';

initSchema();
const app = express();
app.use(cors());
app.use(express.json());
app.use('/media', express.static(MEDIA_DIR));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch(e => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });
};

app.get('/api/health', (req, res) => res.json({ ok: true, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) }));

app.get('/api/meta', (req, res) => res.json({
  topics: TOPICS,
  counts: {
    words: db().prepare('SELECT COUNT(*) c FROM words').get().c,
    sentences: db().prepare('SELECT COUNT(*) c FROM sentences').get().c,
    units: db().prepare('SELECT COUNT(*) c FROM units').get().c,
    dictionary: db().prepare('SELECT COUNT(*) c FROM dictionary').get().c,
  },
  onboarding: onboardingState(),
}));

// ---- Home: unit path, counts, streak ----
app.get('/api/home', wrap((req, res) => {
  const units = db().prepare('SELECT * FROM units ORDER BY position').all().map(u => {
    const prog = unitProgress(u);
    return { id: u.id, position: u.position, name: u.name, topic: u.topic,
             wordCount: JSON.parse(u.word_ids || '[]').length, progress: prog, completed: prog.ratio >= 0.8 };
  });
  const cur = currentUnit();
  const dueNow = db().prepare(`SELECT COUNT(*) c FROM cards WHERE state>0 AND suspended=0 AND due<=datetime('now')`).get().c;
  res.json({ units, currentUnitId: cur?.id ?? null, dueNow, streak: streak(), onboarding: onboardingState() });
}));

function streak() {
  const days = db().prepare(`SELECT DISTINCT date(ts,'localtime') d FROM reviews ORDER BY d DESC LIMIT 400`).all().map(r => r.d);
  if (!days.length) return 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmt = (d) => d.toISOString().slice(0, 10);
  let n = 0, cursor = new Date(today);
  const set = new Set(days);
  // Allow streak to count from today or yesterday.
  if (!set.has(fmt(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (set.has(fmt(cursor))) { n++; cursor.setDate(cursor.getDate() - 1); }
  return n;
}

// ---- Adaptive lesson (primary) ----
app.get('/api/lesson', wrap((req, res) => res.json(buildLesson({ size: Number(req.query.size) || 16 }))));
// Legacy unit-based session kept for compatibility.
app.get('/api/session', wrap((req, res) => res.json(buildSession({}))));

app.post('/api/review', wrap(async (req, res) => {
  const { cardId, rating, durationMs, targetTone, heardTone, dimension, exercise, spoken } = req.body || {};
  if (!cardId || !rating) return res.status(400).json({ error: 'cardId and rating required' });
  const result = await submitReview({ cardId, rating, durationMs, targetTone, heardTone, dimension, exercise, spoken });
  res.json(result);
}));

// ---- Conversation-driven neighborhood lesson (primary Practice flow) ----
function knownWordStrings() {
  const known = [...knownWordIds()];
  return known.length
    ? db().prepare(`SELECT hanzi FROM words WHERE id IN (${known.map(() => '?').join(',')}) ORDER BY freq_rank LIMIT 400`).all(...known).map(r => r.hanzi)
    : [];
}

// ==== Unified conversation surface (primary) ================================
// Start a conversation: build the capability-keyed plan + Director blueprint once,
// attach them to a session id. Returns only what the UI needs — never objectives,
// target chips, capability names, or scores.
app.get('/api/conversation/plan', wrap(async (req, res) => res.json(await startConversation())));

// One executor turn: advances the hidden stage, may attach an inline rep or a framed
// excursion, and signals shouldWrap when completion conditions fire (Workstream F).
app.post('/api/conversation/turn', wrap(async (req, res) => {
  const { sessionId, history = [], userText = '', shouldWrap = false } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  res.json(await conversationTurn({ id: sessionId, history, userText, shouldWrap }));
}));

// Finish: extended post-hoc inference (understanding, capability demos, profile
// harvest, metrics) against the stored plan.
app.post('/api/conversation/complete', wrap(async (req, res) => {
  const { sessionId, transcript = [], endedReason } = req.body || {};
  const plan = sessionId ? sessionPlan(sessionId) : req.body?.plan;
  if (!plan) return res.status(400).json({ error: 'unknown session' });
  const result = await scheduleFromConversation({ plan, transcript, sessionId });
  if (sessionId) markEnded(sessionId, endedReason);
  runBackground().catch(() => {});
  res.json(result);
}));

// ==== Legacy shims (delegating to the new surface / executor) ================
// legacy shim: the old plan endpoint still returns a capability-keyed plan.
app.get('/api/lesson/plan', wrap((req, res) => {
  const plan = buildLessonPlan();
  plan.scriptDirective = scriptDirective(plan.scriptLevel);
  res.json(plan);
}));

// legacy shim: one turn from a client-held plan, routed through the blueprint executor.
app.post('/api/lesson/turn', wrap(async (req, res) => {
  const { plan, history = [], userText = '' } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan required' });
  const reply = await laoshiLesson({ plan, history, userText, knownWords: knownWordStrings(), persona: personaDirective().directive });
  const used = detectUsed(reply, plan.targetVocab || []);
  res.json({ ...reply, used });
}));

// Invisible pronunciation capture from a spoken conversation turn. Matches any
// target/known words the learner said, analyzes each, and records hidden
// telemetry + pronunciation mastery. Fire-and-forget from the client.
app.post('/api/pron/observe', wrap((req, res) => {
  const { spoken, targetVocab = [], source = 'conversation' } = req.body || {};
  if (!spoken?.transcript && !spoken?.heardTones) return res.json({ observed: 0 });
  res.json(observePronunciation({ spoken, targetVocab, source }));
}));

// Finish the lesson: infer understanding from the dialogue, schedule review,
// and capture the conversation as each concept's examples.
app.post('/api/lesson/complete', wrap(async (req, res) => {
  const { plan, transcript = [] } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan required' });
  const result = await scheduleFromConversation({ plan, transcript });
  runBackground().catch(() => {});   // refresh the hidden model in the background
  res.json(result);
}));

// Refresh the hidden learner model (invisible; no scores are ever returned to the UI).
app.post('/api/model/refresh', wrap((req, res) => { inferTraits(); res.json({ ok: true }); }));
app.post('/api/model/background', wrap(async (req, res) => res.json(await runBackground())));

// ---- Laoshi (Qwen conversational teacher) ----
app.get('/api/laoshi/status', wrap(async (req, res) => res.json({ available: await laoshiAvailable(), scriptLevel: scriptLevel() })));

app.post('/api/laoshi', wrap(async (req, res) => {
  const { history = [], userText = '', focus = [], scene } = req.body || {};
  // Constrain the teacher to what the learner knows (comprehensible input).
  const known = [...knownWordIds()];
  const knownWords = known.length
    ? db().prepare(`SELECT hanzi FROM words WHERE id IN (${known.map(() => '?').join(',')}) ORDER BY freq_rank LIMIT 400`).all(...known).map(r => r.hanzi)
    : [];
  const reply = await laoshiReply({ history, userText, context: { knownWords, focusWords: focus, scene: scene || 'friendly practice chat', persona: personaDirective().directive } });
  res.json(reply);
}));

// ---- Stats + throttle ----
app.get('/api/stats', wrap((req, res) => res.json(fullStats())));
app.post('/api/throttle/evaluate', wrap((req, res) => res.json(evaluateThrottle({ force: Boolean(req.body?.force) }))));

// ---- Dictionary ----
app.get('/api/lookup', wrap((req, res) => res.json({ term: req.query.term, results: lookup(req.query.term) })));

// ---- Reading passages ----
app.get('/api/reading', wrap((req, res) => res.json({ passages: passages({}) })));

// ---- Tone trainer ----
app.get('/api/tone', wrap((req, res) => {
  const stats = toneStats();
  const weak = weakTone();
  const drill = buildToneDrill(weak?.pair, Number(req.query.max) || 10);
  res.json({ stats, weak, drill });
}));

// ---- Onboarding / settings ----
app.get('/api/onboarding', wrap((req, res) => res.json(onboardingState())));
app.post('/api/onboarding', wrap((req, res) => res.json(saveOnboarding(req.body || {}))));

const PORT = process.env.PORT || 5178;
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
