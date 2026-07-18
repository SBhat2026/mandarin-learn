import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { db, initSchema, MEDIA_DIR, getSetting } from './db.js';
import { buildSession, submitReview, currentUnit, unitProgress } from './session.js';
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

// ---- Session ----
app.get('/api/session', wrap((req, res) => res.json(buildSession({}))));

app.post('/api/review', wrap(async (req, res) => {
  const { cardId, rating, durationMs, targetTone, heardTone } = req.body || {};
  if (!cardId || !rating) return res.status(400).json({ error: 'cardId and rating required' });
  const result = await submitReview({ cardId, rating, durationMs, targetTone, heardTone });
  res.json(result);
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
