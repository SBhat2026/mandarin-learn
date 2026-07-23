-- Mandarin Learn schema. Everything lives in SQLite so the app can later wrap in Tauri.

CREATE TABLE IF NOT EXISTS words (
  id          INTEGER PRIMARY KEY,
  hanzi       TEXT NOT NULL,
  pinyin      TEXT,
  tone_pattern TEXT,           -- e.g. "3-1" tone numbers per syllable
  english     TEXT,
  hsk_level   INTEGER,
  freq_rank   INTEGER,
  topics      TEXT,            -- JSON array of topic tags
  audio_path  TEXT,
  UNIQUE(hanzi)
);

CREATE TABLE IF NOT EXISTS sentences (
  id          INTEGER PRIMARY KEY,
  hanzi       TEXT NOT NULL,
  pinyin      TEXT,
  english     TEXT,
  word_ids    TEXT,            -- JSON array of word ids contained
  pattern_tag TEXT,            -- grammar pattern demonstrated
  audio_path  TEXT,
  source      TEXT,
  UNIQUE(hanzi)
);

CREATE TABLE IF NOT EXISTS units (
  id        INTEGER PRIMARY KEY,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  topic     TEXT,
  word_ids  TEXT                -- JSON array
);

-- One card per (item, card_type). FSRS fields stored inline.
CREATE TABLE IF NOT EXISTS cards (
  id           INTEGER PRIMARY KEY,
  item_type    TEXT NOT NULL,   -- 'word' | 'sentence'
  item_id      INTEGER NOT NULL,
  card_type    TEXT NOT NULL,   -- 'listening' | 'reading' | 'speaking'
  -- FSRS state
  due          TEXT,
  stability    REAL,
  difficulty   REAL,
  elapsed_days INTEGER DEFAULT 0,
  scheduled_days INTEGER DEFAULT 0,
  reps         INTEGER DEFAULT 0,
  lapses       INTEGER DEFAULT 0,
  state        INTEGER DEFAULT 0,   -- 0 New 1 Learning 2 Review 3 Relearning
  last_review  TEXT,
  suspended    INTEGER DEFAULT 0,
  UNIQUE(item_type, item_id, card_type)
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL,
  ts          TEXT NOT NULL,
  rating      INTEGER NOT NULL,
  duration_ms INTEGER,
  -- speaking-card telemetry for tone analysis
  target_tone TEXT,
  heard_tone  TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);

CREATE TABLE IF NOT EXISTS dictionary (
  id          INTEGER PRIMARY KEY,
  traditional TEXT,
  simplified  TEXT,
  pinyin      TEXT,
  definitions TEXT               -- JSON array
);
CREATE INDEX IF NOT EXISTS idx_dict_simplified ON dictionary(simplified);
CREATE INDEX IF NOT EXISTS idx_dict_traditional ON dictionary(traditional);

CREATE TABLE IF NOT EXISTS frequency (
  word TEXT PRIMARY KEY,
  rank INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Enrichment cache so the tagging pass is resumable and never re-runs.
CREATE TABLE IF NOT EXISTS enrichment_cache (
  hanzi   TEXT PRIMARY KEY,
  topics  TEXT,
  updated TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_due   ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);
CREATE INDEX IF NOT EXISTS idx_reviews_ts  ON reviews(ts);

-- ============================================================================
-- Adaptive learning engine (knowledge graph + hidden learner model)
-- ============================================================================

-- Character-level metadata (from makemeahanzi). Powers character families:
-- radical (semantic) grouping, phonetic series, component construction.
CREATE TABLE IF NOT EXISTS char_meta (
  hanzi         TEXT PRIMARY KEY,   -- single character
  pinyin        TEXT,               -- JSON array of readings
  radical       TEXT,               -- the semantic/index radical
  components    TEXT,               -- JSON array of direct sub-components
  decomposition TEXT,               -- IDS string, e.g. "⿰忄青"
  phonetic      TEXT,               -- component that carries the sound (phonetic series key)
  semantic      TEXT,               -- component that carries the meaning (usually the radical)
  definition    TEXT
);

-- The knowledge graph. Every teaching/review/planning decision reads these edges.
-- rel ∈ semantic | shares_char | phonetic_series | radical_family |
--       visual_confusion | grammar_pattern | collocation | topic | sentence_dep | component
CREATE TABLE IF NOT EXISTS graph_edges (
  src_type TEXT NOT NULL,           -- 'word' | 'char' | 'sentence' | 'pattern' | 'topic'
  src      TEXT NOT NULL,           -- id or literal (hanzi / tag)
  rel      TEXT NOT NULL,
  dst_type TEXT NOT NULL,
  dst      TEXT NOT NULL,
  weight   REAL DEFAULT 1.0,
  PRIMARY KEY(src_type, src, rel, dst_type, dst)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON graph_edges(src_type, src, rel);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON graph_edges(dst_type, dst, rel);

-- Multi-dimensional mastery. One FSRS "memory" card per item schedules WHEN to
-- review; these six per-word sub-scores decide WHICH exercise to show (weakest).
-- dimension ∈ meaning | reading | listening | pronunciation | spoken | sentence
CREATE TABLE IF NOT EXISTS word_mastery (
  word_id    INTEGER NOT NULL,
  dimension  TEXT NOT NULL,
  score      REAL DEFAULT 0,        -- 0..1 smoothed mastery estimate (EWMA of graded outcomes)
  alpha      REAL DEFAULT 1,        -- beta-posterior successes (for uncertainty)
  beta       REAL DEFAULT 1,        -- beta-posterior failures
  exposures  INTEGER DEFAULT 0,
  last_ts    TEXT,
  PRIMARY KEY(word_id, dimension)
);

-- Continuous acquisition stage per item (not binary known/unknown).
-- stage: 0 first-exposure · 1 familiar · 2 recall · 3 functional · 4 automatic
CREATE TABLE IF NOT EXISTS acquisition (
  item_type TEXT NOT NULL,
  item_id   INTEGER NOT NULL,
  stage     INTEGER DEFAULT 0,
  updated   TEXT,
  PRIMARY KEY(item_type, item_id)
);

-- The hidden learner model: inferred, never shown to the learner. JSON values.
CREATE TABLE IF NOT EXISTS learner_model (
  key     TEXT PRIMARY KEY,
  value   TEXT,
  updated TEXT
);

-- Per-dimension desired retention for FSRS. Seeded, then adapted per-learner.
CREATE TABLE IF NOT EXISTS dim_retention (
  dimension TEXT PRIMARY KEY,
  target    REAL NOT NULL
);

-- Per-review dimension telemetry (which skill was tested, outcome, latency).
CREATE TABLE IF NOT EXISTS review_dims (
  review_id INTEGER PRIMARY KEY,
  dimension TEXT,
  exercise  TEXT,
  correct   INTEGER,
  latency_ms INTEGER,
  FOREIGN KEY(review_id) REFERENCES reviews(id)
);

-- Invisible pronunciation telemetry. One row per spoken attempt that produced
-- an acoustic/transcript signal. Feeds the hidden learner model (tone, initial &
-- final confusion matrices, fluency/hesitation/confidence). Never surfaced.
CREATE TABLE IF NOT EXISTS pron_signals (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  word_id      INTEGER,
  source       TEXT,               -- 'exercise' | 'conversation'
  tone_source  TEXT,               -- 'acoustic' | 'transcript' | 'none'
  target_tone  TEXT,
  heard_tone   TEXT,
  initial_conf TEXT,               -- JSON array of {target,heard,likely}
  final_conf   TEXT,               -- JSON array of {target,heard,likely}
  fluency      REAL,
  hesitation   REAL,
  confidence   REAL,
  accuracy     REAL
);
CREATE INDEX IF NOT EXISTS idx_pron_ts ON pron_signals(ts);

-- ============================================================================
-- Conversational architecture (capabilities + personal profile + blueprint)
-- ============================================================================

-- Capabilities are the TOP planning unit: an expressive thing the learner can do
-- ("describe a living thing"). Vocabulary and grammar patterns are the MEANS to a
-- capability, resolved at plan time. This decouples curriculum ("what they can
-- say") from raw vocabulary lists ("which words").
CREATE TABLE IF NOT EXISTS capabilities (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,       -- teacher-facing aim, e.g. "describe a living thing"
  description        TEXT,
  cefr_ish           TEXT,                -- rough band: A0 | A1 | A2 | B1 | B2
  ordering           INTEGER DEFAULT 0,   -- survival → descriptive → narrative → opinion
  prerequisites_json TEXT                 -- JSON array of prerequisite capability slugs
);

-- What a capability draws on. `kind` is 'vocab' | 'pattern' | 'capability'.
-- `ref` is a resolvable token, not a hard word id:
--   vocab:  "pos:a" (POS role), "topic:animals", or "word:好" (rare literal)
--   pattern: a grammar pattern_tag, e.g. "de-attributive", "le-completion"
--   capability: a sub-capability slug
CREATE TABLE IF NOT EXISTS capability_requirements (
  capability_id INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  ref           TEXT NOT NULL,
  weight        REAL DEFAULT 1.0,
  FOREIGN KEY(capability_id) REFERENCES capabilities(id)
);
CREATE INDEX IF NOT EXISTS idx_cap_req ON capability_requirements(capability_id);

-- Hidden per-learner capability mastery, analogous to word_mastery. A
-- demonstration is an inferred instance of the learner actually expressing the
-- capability in conversation.
CREATE TABLE IF NOT EXISTS capability_mastery (
  capability_id  INTEGER PRIMARY KEY,
  score          REAL DEFAULT 0,        -- 0..1 EWMA of demonstrations
  demonstrations INTEGER DEFAULT 0,
  last_demo_at   TEXT,
  FOREIGN KEY(capability_id) REFERENCES capabilities(id)
);

-- Durable, local memory of the PERSON (never shown as data; only shapes teaching).
-- kind: 'fact' | 'interest' | 'preference' | 'thread'.
CREATE TABLE IF NOT EXISTS personal_profile (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL,          -- e.g. 'major', 'hobby', 'open_thread'
  value         TEXT NOT NULL,          -- e.g. 'biology', 'hiking', 'planning a Chengdu trip'
  kind          TEXT DEFAULT 'fact',
  confidence    REAL DEFAULT 0.5,
  source        TEXT DEFAULT 'inferred', -- 'stated' | 'inferred'
  first_seen    TEXT,
  last_seen     TEXT,
  mention_count INTEGER DEFAULT 1,
  UNIQUE(key, value)
);

-- One row per conversation. Holds the capability-keyed plan and the Director's
-- blueprint so turns don't re-plan, plus the hidden lifecycle stage. This is the
-- "session" the metrics attach to.
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id             TEXT PRIMARY KEY,       -- generated session id
  capability_id  INTEGER,
  plan_json      TEXT,
  blueprint_json TEXT,
  stage          TEXT DEFAULT 'opening', -- opening→personal_connection→explore→introduce→practice→confirm→wrap
  exchanges      INTEGER DEFAULT 0,
  created        TEXT,
  updated        TEXT,
  ended_reason   TEXT
);

-- Capability unlock moments (Workstream G): fire the in-character "you can now…"
-- acknowledgement exactly once per capability.
CREATE TABLE IF NOT EXISTS capability_unlocks (
  capability_id INTEGER PRIMARY KEY,
  unlocked_at   TEXT,
  acknowledged  INTEGER DEFAULT 0
);

-- Hidden per-conversation metrics. Feed planning; never surfaced.
CREATE TABLE IF NOT EXISTS conversation_metrics (
  session_id                  TEXT PRIMARY KEY,
  learner_initiated_questions INTEGER DEFAULT 0,
  spontaneous_vocab           INTEGER DEFAULT 0,   -- target words used unprompted
  avg_learner_len             REAL DEFAULT 0,
  branches                    INTEGER DEFAULT 0,   -- learner-introduced topic pivots
  corrections                 INTEGER DEFAULT 0,
  capability_demos            INTEGER DEFAULT 0,
  exchanges                   INTEGER DEFAULT 0,
  max_question_rung           INTEGER DEFAULT 0,   -- highest question ladder rung reached
  momentum                    REAL DEFAULT 1.0,
  ended_reason                TEXT,                -- 'educational' | 'momentum' | 'budget' | 'fatigue'
  created                     TEXT
);
