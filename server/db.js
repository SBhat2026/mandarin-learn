import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
// APP_DB_PATH lets tests point at an isolated database.
export const DB_PATH = process.env.APP_DB_PATH || join(ROOT, 'data', 'app.db');
export const MEDIA_DIR = process.env.APP_MEDIA_DIR || join(ROOT, 'data', 'media');

mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(MEDIA_DIR, { recursive: true });

let _db;
export function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

// Per-dimension seed retention targets (productive skills held higher).
export const DIM_RETENTION = {
  meaning: 0.84, reading: 0.85, listening: 0.88,
  pronunciation: 0.90, spoken: 0.90, sentence: 0.86,
};
export const DIMENSIONS = Object.keys(DIM_RETENTION);

function addColumn(table, col, decl) {
  const cols = db().prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db().exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

export function initSchema() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db().exec(sql);
  migrate();
}

// Idempotent migrations for databases created before the adaptive engine.
export function migrate() {
  addColumn('words', 'pos', 'TEXT');                 // JSON array of POS codes
  addColumn('words', 'gloss', 'TEXT');               // clean concise gloss (LLM/curated)
  addColumn('words', 'example_sentence_id', 'INTEGER');
  addColumn('words', 'concrete', 'INTEGER DEFAULT 0'); // concrete-first ranking flag
  addColumn('words', 'particle', 'INTEGER DEFAULT 0'); // bare grammar particle → teach in context only
  addColumn('cards', 'dimension', 'TEXT');           // last exercise dimension (hint)

  // Seed per-dimension retention targets once.
  const seed = db().prepare(
    'INSERT OR IGNORE INTO dim_retention(dimension, target) VALUES(?,?)');
  for (const [dim, t] of Object.entries(DIM_RETENTION)) seed.run(dim, t);

  // Collapse legacy per-type cards (listening/reading/speaking) into one memory
  // track per item, keeping the most-advanced FSRS state and repointing reviews.
  const legacy = db().prepare("SELECT 1 FROM cards WHERE card_type!='memory' LIMIT 1").get();
  if (legacy) collapseCards();
}

function collapseCards() {
  const d = db();
  const groups = d.prepare(
    'SELECT item_type, item_id FROM cards GROUP BY item_type, item_id').all();
  const tx = d.transaction(() => {
    for (const g of groups) {
      const rows = d.prepare(`SELECT * FROM cards WHERE item_type=? AND item_id=?
        ORDER BY state DESC, stability DESC, reps DESC`).all(g.item_type, g.item_id);
      const keep = rows[0];
      d.prepare("UPDATE cards SET card_type='memory' WHERE id=?").run(keep.id);
      for (const r of rows.slice(1)) {
        d.prepare('UPDATE reviews SET card_id=? WHERE card_id=?').run(keep.id, r.id);
        d.prepare('DELETE FROM cards WHERE id=?').run(r.id);
      }
    }
  });
  tx();
  console.log('✓ migrated legacy cards → single memory track');
}

export function getModel(key, fallback = null) {
  const row = db().prepare('SELECT value FROM learner_model WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setModel(key, value) {
  db().prepare(
    `INSERT INTO learner_model(key,value,updated) VALUES(?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated`
  ).run(key, JSON.stringify(value));
}

export function getSetting(key, fallback = null) {
  const row = db().prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  db().prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, JSON.stringify(value));
}
