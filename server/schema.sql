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
