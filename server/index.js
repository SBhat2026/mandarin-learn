import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, initSchema, MEDIA_DIR, getSetting, setSetting, getModel, runAsUser, currentUserSlug, ROOT } from './db.js';
import { cleanGloss } from './exercises.js';
import { listUsers, addUser, getUser, primarySlug, setUserPref } from './users.js';
import { aiRateLimit } from './ratelimit.js';
import { buildSession, buildLesson, submitReview } from './session.js';
import { inferTraits, recordChannelSignal } from './learner.js';
import { imageFor } from './images.js';
import { recordChoiceOutcome } from './rung.js';
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
import { placementState, startPlacement, answerPlacement, skipPlacement } from './placement.js';
import { claudeModelPref, setClaudeModelPref, richModelAvailable } from './anthropic.js';
import { TOPICS } from './taxonomy.js';
import { State } from './fsrs.js';
import { nextFamily, recordFamilyOutcome } from './familylessons.js';
import { getStory, storyOutcome } from './stories.js';
import { convertPinyin } from './pinyinime.js';
import { synthesize } from './tts.js';
import { transcribe, sttAvailable, sttEngine } from './stt.js';
import { spendSummary } from './spend.js';
import { requireAccess, accessRequired, checkAccess } from './auth.js';

initSchema();
const app = express();
app.use(cors());
app.use(express.json());

// Route every request to the active user's databases. The client sends the chosen
// user slug in `x-user`; unknown/missing falls back to the primary user. The whole
// downstream handler runs inside this user's AsyncLocalStorage context, so db()
// resolves correctly without any per-call user plumbing.
app.use((req, res, next) => {
  const slug = req.get('x-user');
  const active = slug && getUser(slug) ? slug : primarySlug();
  runAsUser(active, () => next());
});

app.use('/media', express.static(MEDIA_DIR));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch(e => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });
};

app.get('/api/health', (req, res) => res.json({ ok: true, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) }));

// The access gate (hosted instances only; inert when APP_PASSWORD is unset).
// Declared before the guard so the client can discover whether a gate exists and
// verify a passphrase without already holding one.
app.get('/api/auth/check', (req, res) => res.json({
  required: accessRequired(),
  ok: !accessRequired() || checkAccess(req.get('x-access')),
}));
app.use('/api', requireAccess);

// Serving the app itself. In dev, Vite serves it on :5173 and proxies /api here. For
// SHARING (Cloudflare tunnel), it's simpler to expose ONE port: if a production build
// exists (dist/), the API server also serves the SPA, so tunnelling :5178 gives
// testers the whole app + api through a single origin. Otherwise, a bare hit to :5178
// bounces to the Vite dev server.
const DIST = join(ROOT, 'dist');
// Serve the SPA from here only when explicitly asked (SERVE_APP=1, set by the share
// script). In normal dev we redirect to Vite's live HMR app so a stale build can't
// shadow it.
const SERVE_APP = process.env.SERVE_APP === '1' && existsSync(join(DIST, 'index.html'));
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5173';
if (SERVE_APP) app.use(express.static(DIST));
else app.get('/', (req, res) => res.redirect(WEB_ORIGIN));

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

// ---- Home: two forward tracks (speak / read), not a ladder of levels ----
// The old payload was a numbered unit path, which made the home screen a picture of
// how far you still had to go. This one answers a different question: what is the
// next thing to do, on each of the two tracks, right now.
const STORY_MIN_WORDS = 8;                 // stories.js floor for having anything to build from

app.get('/api/home', wrap((req, res) => {
  const dueNow = db().prepare(`SELECT COUNT(*) c FROM cards WHERE state>0 AND suspended=0 AND due<=datetime('now')`).get().c;
  const known = knownWordIds().size;
  const met = db().prepare(`SELECT COUNT(DISTINCT item_id) c FROM cards WHERE item_type='word'`).get().c;
  const lastConversation = db().prepare(
    `SELECT updated FROM conversation_sessions ORDER BY updated DESC LIMIT 1`).get()?.updated || null;

  // What the speaking track picks up from — the honest callback the guided rung
  // itself uses, so the home screen and the teacher agree.
  const lastWords = (getModel('last_session_words', []) || []).slice(0, 3)
    .map(h => db().prepare('SELECT hanzi, pinyin, gloss, english FROM words WHERE hanzi=?').get(h))
    .filter(Boolean)
    .map(w => ({ hanzi: w.hanzi, pinyin: w.pinyin || '', gloss: cleanGloss(w) }));

  // Reading unlocks on CONTENT words the learner has actually met. stories.js can
  // technically build from the core function words alone, but a story made of 是/的
  // is not a reading experience — so the track opens once there is something to
  // read about.
  const readReady = met >= STORY_MIN_WORDS;
  const story = getModel('current_story', null);

  res.json({
    dueNow,
    streak: streak(),
    progress: { known, met },
    speak: {
      started: !!lastConversation,
      lastAt: lastConversation,
      pickUpFrom: lastWords,
      label: lastConversation ? 'Pick up where you left off' : 'Start your first conversation',
    },
    read: {
      ready: readReady,
      wordsToUnlock: Math.max(0, STORY_MIN_WORDS - met),
      hasStory: !!story && !story.completed,
      title: story && !story.completed ? story.title : null,
      label: !readReady ? 'Unlocks once you have met a few words'
        : story && !story.completed ? 'Continue your story' : 'A new story at your level',
    },
    placement: placementState(),
    onboarding: onboardingState(),
  });
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
// `forceWrap` is the learner asking to finish ("wrap up" in the UI): the teacher
// moves straight to its closing beat and says goodbye properly instead of the
// learner having to abandon the page.
app.post('/api/conversation/turn', aiRateLimit, wrap(async (req, res) => {
  const { sessionId, history = [], userText = '', shouldWrap = false, forceWrap = false } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  res.json(await conversationTurn({ id: sessionId, history, userText, shouldWrap, forceWrap }));
}));

// Finish: extended post-hoc inference (understanding, capability demos, profile
// harvest, metrics) against the stored plan.
app.post('/api/conversation/complete', wrap(async (req, res) => {
  const { sessionId, transcript = [], endedReason } = req.body || {};
  const plan = sessionId ? sessionPlan(sessionId) : req.body?.plan;
  if (!plan) return res.status(400).json({ error: 'unknown session' });
  const result = await scheduleFromConversation({ plan, transcript, sessionId, endedReason });
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
app.post('/api/lesson/turn', aiRateLimit, wrap(async (req, res) => {
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

app.post('/api/laoshi', aiRateLimit, wrap(async (req, res) => {
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

// ---- Image anchor for a concrete noun (emoji-first; 'none' otherwise) ----
app.get('/api/image', wrap((req, res) => res.json(imageFor(String(req.query.hanzi || '')))));

// ---- Invisible modality signal (audio-first reveal vs kept) ----
app.post('/api/signal/channel', wrap((req, res) => {
  const kind = req.body?.kind;
  if (kind !== 'reveal_text' && kind !== 'kept_audio') return res.status(400).json({ error: 'bad kind' });
  recordChannelSignal(kind);
  res.json({ ok: true });
}));

// ---- Invisible comprehension signal (scaffolded-choice / rep outcome) → rung climb ----
app.post('/api/signal/choice', wrap((req, res) => {
  recordChoiceOutcome(Boolean(req.body?.correct));
  res.json({ ok: true });
}));

// ---- Reading passages ----
app.get('/api/reading', wrap((req, res) => res.json({ passages: passages({}) })));

// ── Learner controls (hybrid agency): pace, today's topics, stretch ─────────
// Visible levers over an otherwise-invisible engine. Pace = daily new-word budget;
// topics = what today's conversations should lean toward; stretch = "push me".
app.get('/api/prefs', wrap((req, res) => {
  const unlocked = db().prepare('SELECT COUNT(*) c FROM capability_unlocks').get().c;
  const capsTotal = db().prepare('SELECT COUNT(*) c FROM capabilities').get().c;
  const readWords = db().prepare("SELECT COUNT(*) c FROM word_mastery WHERE dimension='reading' AND score>0.6 AND exposures>=2").get().c;
  res.json({
    pace: getSetting('daily_new', 10),
    topics: getSetting('chat_topics', []) || [],
    stretch: Boolean(getSetting('stretch_mode', false)),
    script: getSetting('script_pref', 'hanzi'),
    style: getSetting('learning_style', 'visual'),
    allTopics: TOPICS,
    progress: { capabilitiesUnlocked: unlocked, capabilitiesTotal: capsTotal, readWords,
      knownWords: knownWordIds().size },
  });
}));
app.post('/api/prefs', wrap((req, res) => {
  const { pace, topics, stretch, script, style } = req.body || {};
  if (style != null) setSetting('learning_style', ['visual', 'auditory', 'balanced'].includes(style) ? style : 'visual');
  if (pace != null) setSetting('daily_new', Math.max(3, Math.min(35, Number(pace) || 10)));
  if (Array.isArray(topics)) setSetting('chat_topics', topics.filter(t => TOPICS.includes(t)).slice(0, 3));
  if (stretch != null) setSetting('stretch_mode', Boolean(stretch));
  if (script != null) setSetting('script_pref', script === 'hanzi' ? 'hanzi' : 'auto');
  res.json({ pace: getSetting('daily_new', 10), topics: getSetting('chat_topics', []),
    stretch: Boolean(getSetting('stretch_mode', false)), script: getSetting('script_pref', 'hanzi'),
    style: getSetting('learning_style', 'visual') });
}));

// ── Metered spend (subtle footer readout) ───────────────────────────────────
app.get('/api/spend', wrap(async (req, res) => res.json(await spendSummary())));

// ── Local Whisper STT ───────────────────────────────────────────────────────
app.get('/api/stt/health', (req, res) => res.json({ available: sttAvailable(), engine: sttEngine() }));
app.post('/api/stt', express.raw({ type: () => true, limit: '15mb' }), wrap(async (req, res) => {
  const hint = String(req.query.hint || '');
  res.json(await transcribe(req.body, { hint, mime: req.get('content-type') || '' }));
}));

// ── Neural TTS (Edge voices, cached mp3) ────────────────────────────────────
app.get('/api/tts', wrap(async (req, res) => {
  try {
    const file = await synthesize(String(req.query.text || ''), { slow: req.query.slow === '1' });
    res.json({ url: '/media/' + file });
  } catch (e) {
    res.status(503).json({ error: e.message });   // client falls back to speechSynthesis
  }
}));

// ── Pinyin IME: typed toneless pinyin → hanzi (with autocorrect) ────────────
app.get('/api/pinyin/convert', wrap((req, res) => res.json(convertPinyin(String(req.query.q || '')))));

// ── Graded-reader stories ───────────────────────────────────────────────────
app.get('/api/reading/story', aiRateLimit, wrap(async (req, res) =>
  res.json({ story: await getStory({ fresh: req.query.fresh === '1' }) })));
app.post('/api/reading/story/outcome', wrap((req, res) => res.json(storyOutcome(req.body || {}))));

// ── Character-family curriculum ─────────────────────────────────────────────
app.get('/api/family/next', wrap((req, res) => res.json({ lesson: nextFamily() })));
app.post('/api/family/outcome', wrap((req, res) => {
  const { key, correct } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  res.json(recordFamilyOutcome(String(key), Boolean(correct)));
}));

// ---- Tone trainer ----
app.get('/api/tone', wrap((req, res) => {
  const stats = toneStats();
  const weak = weakTone();
  const drill = buildToneDrill(weak?.pair, Number(req.query.max) || 10);
  res.json({ stats, weak, drill });
}));

// ---- Entrance exam (placement) ----
// Optional and skippable. Running it seeds the rung + level estimates so the first
// conversation already speaks at the right level; skipping starts at the beginning.
app.get('/api/placement', wrap((req, res) => res.json(placementState())));
app.post('/api/placement/start', wrap((req, res) => res.json(startPlacement())));
app.post('/api/placement/answer', wrap((req, res) => {
  const r = answerPlacement({ answer: req.body?.answer ?? '' });
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));
app.post('/api/placement/skip', wrap((req, res) => res.json(skipPlacement())));

// ---- Onboarding / settings ----
app.get('/api/onboarding', wrap((req, res) => res.json(onboardingState())));
app.post('/api/onboarding', wrap((req, res) => res.json(saveOnboarding(req.body || {}))));

// ---- Multi-user (max 5, no auth): who's here + add a person ----
app.get('/api/users', wrap((req, res) => res.json({ users: listUsers(), current: currentUserSlug(), primary: primarySlug() })));
app.post('/api/users', wrap((req, res) => {
  const name = String(req.body?.displayName || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try { res.json({ user: addUser(name), users: listUsers() }); }
  catch (e) { res.status(409).json({ error: e.message }); }
}));

// ---- Playtesting: invisible-pass model tier (Haiku ⇄ Sonnet), per-user ----
app.get('/api/settings/model', wrap((req, res) => res.json({
  pref: claudeModelPref(),
  richAvailable: richModelAvailable(),
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
})));
app.post('/api/settings/model', wrap((req, res) => {
  const pref = setClaudeModelPref(req.body?.pref);   // per-user learner_model (authoritative)
  setUserPref(currentUserSlug(), pref);              // mirror to registry for the picker
  res.json({ pref, richAvailable: richModelAvailable() });
}));

// SPA fallback: any non-/api GET returns index.html so client-side routing works
// through the single shared origin (tunnel). Only when a build exists.
if (SERVE_APP) {
  app.get(/^(?!\/api|\/media).*/, (req, res) => res.sendFile(join(DIST, 'index.html')));
}

const PORT = process.env.PORT || 5178;
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}${SERVE_APP ? ' (serving app + api)' : ''}`));
