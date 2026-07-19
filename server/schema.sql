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
