-- Per-user STATE schema (multi-user split). Secondary users get their own DB with
-- ONLY these tables; the shared read-only CONTENT tables (words, sentences, units,
-- dictionary, char_meta, graph_edges, capabilities, capability_requirements, …) are
-- ATTACHed from app.db as `content`, so unqualified reads resolve to shared content.
--
-- User #1 keeps using app.db directly (content + state in one file), so this file is
-- only ever applied to secondary users' databases. IMPORTANT: never create content
-- tables here — an empty local `words` would shadow the attached content copy.

CREATE TABLE IF NOT EXISTS cards (
  id           INTEGER PRIMARY KEY,
  item_type    TEXT NOT NULL,
  item_id      INTEGER NOT NULL,
  card_type    TEXT NOT NULL,
  due          TEXT,
  stability    REAL,
  difficulty   REAL,
  elapsed_days INTEGER DEFAULT 0,
  scheduled_days INTEGER DEFAULT 0,
  reps         INTEGER DEFAULT 0,
  lapses       INTEGER DEFAULT 0,
  state        INTEGER DEFAULT 0,
  last_review  TEXT,
  suspended    INTEGER DEFAULT 0,
  dimension    TEXT,
  UNIQUE(item_type, item_id, card_type)
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL,
  ts          TEXT NOT NULL,
  rating      INTEGER NOT NULL,
  duration_ms INTEGER,
  target_tone TEXT,
  heard_tone  TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_due   ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);
CREATE INDEX IF NOT EXISTS idx_reviews_ts  ON reviews(ts);

CREATE TABLE IF NOT EXISTS word_mastery (
  word_id    INTEGER NOT NULL,
  dimension  TEXT NOT NULL,
  score      REAL DEFAULT 0,
  alpha      REAL DEFAULT 1,
  beta       REAL DEFAULT 1,
  exposures  INTEGER DEFAULT 0,
  last_ts    TEXT,
  PRIMARY KEY(word_id, dimension)
);

CREATE TABLE IF NOT EXISTS acquisition (
  item_type TEXT NOT NULL,
  item_id   INTEGER NOT NULL,
  stage     INTEGER DEFAULT 0,
  updated   TEXT,
  PRIMARY KEY(item_type, item_id)
);

CREATE TABLE IF NOT EXISTS learner_model (
  key     TEXT PRIMARY KEY,
  value   TEXT,
  updated TEXT
);

CREATE TABLE IF NOT EXISTS dim_retention (
  dimension TEXT PRIMARY KEY,
  target    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS review_dims (
  review_id INTEGER PRIMARY KEY,
  dimension TEXT,
  exercise  TEXT,
  correct   INTEGER,
  latency_ms INTEGER,
  FOREIGN KEY(review_id) REFERENCES reviews(id)
);

CREATE TABLE IF NOT EXISTS pron_signals (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  word_id      INTEGER,
  source       TEXT,
  tone_source  TEXT,
  target_tone  TEXT,
  heard_tone   TEXT,
  initial_conf TEXT,
  final_conf   TEXT,
  fluency      REAL,
  hesitation   REAL,
  confidence   REAL,
  accuracy     REAL
);
CREATE INDEX IF NOT EXISTS idx_pron_ts ON pron_signals(ts);

-- capability_mastery references capabilities, which lives in the ATTACHed content
-- DB. SQLite cannot enforce a foreign key across databases, so the FK is omitted
-- here (it is an integrity hint only); capability_id is a plain column.
CREATE TABLE IF NOT EXISTS capability_mastery (
  capability_id  INTEGER PRIMARY KEY,
  score          REAL DEFAULT 0,
  demonstrations INTEGER DEFAULT 0,
  last_demo_at   TEXT
);

CREATE TABLE IF NOT EXISTS personal_profile (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  kind          TEXT DEFAULT 'fact',
  confidence    REAL DEFAULT 0.5,
  source        TEXT DEFAULT 'inferred',
  first_seen    TEXT,
  last_seen     TEXT,
  mention_count INTEGER DEFAULT 1,
  UNIQUE(key, value)
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id             TEXT PRIMARY KEY,
  capability_id  INTEGER,
  plan_json      TEXT,
  blueprint_json TEXT,
  stage          TEXT DEFAULT 'opening',
  exchanges      INTEGER DEFAULT 0,
  created        TEXT,
  updated        TEXT,
  ended_reason   TEXT
);

CREATE TABLE IF NOT EXISTS conversation_metrics (
  session_id                  TEXT PRIMARY KEY,
  learner_initiated_questions INTEGER DEFAULT 0,
  spontaneous_vocab           INTEGER DEFAULT 0,
  avg_learner_len             REAL DEFAULT 0,
  branches                    INTEGER DEFAULT 0,
  corrections                 INTEGER DEFAULT 0,
  capability_demos            INTEGER DEFAULT 0,
  exchanges                   INTEGER DEFAULT 0,
  max_question_rung           INTEGER DEFAULT 0,
  momentum                    REAL DEFAULT 1.0,
  ended_reason                TEXT,
  created                     TEXT
);

-- Capability unlock moments (Workstream G): fire the in-character "you can now…"
-- acknowledgement exactly once per capability, per user.
CREATE TABLE IF NOT EXISTS capability_unlocks (
  capability_id INTEGER PRIMARY KEY,
  unlocked_at   TEXT,
  acknowledged  INTEGER DEFAULT 0
);
