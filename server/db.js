import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { primarySlug, hasUser, USERS_DIR } from './users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
// APP_DB_PATH lets tests point at an isolated database. This is the SHARED CONTENT
// database (words, sentences, graph, capabilities, …) AND the primary user's state.
export const DB_PATH = process.env.APP_DB_PATH || join(ROOT, 'data', 'app.db');
export const MEDIA_DIR = process.env.APP_MEDIA_DIR || join(ROOT, 'data', 'media');

mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(MEDIA_DIR, { recursive: true });

// ── Multi-user routing ──────────────────────────────────────────────────────
// One process serves up to 5 local users. The active user for the current request
// is carried in AsyncLocalStorage, so db() resolves to the right connection without
// threading a user id through every query. Connections are cached per user.
//   • primary user  → app.db directly (content + state in one file; original data).
//   • secondary user → data/users/<slug>.db with app.db ATTACHed AS content, so
//     unqualified reads of content tables resolve to the shared copy.
const als = new AsyncLocalStorage();
const conns = new Map();

export function runAsUser(slug, fn) { return als.run(slug, fn); }
export function currentUserSlug() {
  const s = als.getStore();
  return (s && hasUser(s)) ? s : primarySlug();
}

function openConn(slug) {
  if (conns.has(slug)) return conns.get(slug);
  let d;
  if (slug === primarySlug()) {
    // Primary: the existing app.db, full schema (content + state). Unchanged behavior.
    d = new Database(DB_PATH);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    applyPrimarySchema(d);
  } else {
    // Secondary: isolated state DB, shared content attached read-through.
    mkdirSync(USERS_DIR, { recursive: true });
    d = new Database(join(USERS_DIR, `${slug}.db`));
    d.pragma('journal_mode = WAL');
    d.exec(`ATTACH DATABASE '${DB_PATH.replace(/'/g, "''")}' AS content`);
    d.pragma('foreign_keys = ON');
    applyUserSchema(d);
  }
  conns.set(slug, d);
  return d;
}

// The active connection for the current request's user (or the primary user).
export function db() { return openConn(currentUserSlug()); }

// ── Schema + migrations (per connection) ────────────────────────────────────
function addColumn(conn, table, col, decl) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

// Full schema for the primary/app database (content + state), then migrations.
function applyPrimarySchema(conn) {
  conn.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  contentMigrate(conn);
  userMigrate(conn);
}

// State-only schema for a secondary user (content lives in the ATTACHed app.db).
function applyUserSchema(conn) {
  conn.exec(readFileSync(join(__dirname, 'schema-user.sql'), 'utf8'));
  userMigrate(conn);
}

// Content-side column backfills (only meaningful on the app.db, which owns `words`).
function contentMigrate(conn) {
  addColumn(conn, 'words', 'pos', 'TEXT');
  addColumn(conn, 'words', 'gloss', 'TEXT');
  addColumn(conn, 'words', 'example_sentence_id', 'INTEGER');
  addColumn(conn, 'words', 'concrete', 'INTEGER DEFAULT 0');
  addColumn(conn, 'words', 'particle', 'INTEGER DEFAULT 0');
  // Re-enrichment pass (Claude): 'spoken' | 'written' | 'both', and a sub-band for
  // the collapsed HSK 7-9 level (7|8|9, derived from frequency terciles).
  addColumn(conn, 'words', 'register', 'TEXT');
  addColumn(conn, 'words', 'hsk_band', 'INTEGER');
}

// Per-user state migrations: card hint column, seed retention targets, collapse any
// legacy per-type cards into one memory track.
function userMigrate(conn) {
  addColumn(conn, 'cards', 'dimension', 'TEXT');
  const seed = conn.prepare('INSERT OR IGNORE INTO dim_retention(dimension, target) VALUES(?,?)');
  for (const [dim, t] of Object.entries(DIM_RETENTION)) seed.run(dim, t);
  const legacy = conn.prepare("SELECT 1 FROM cards WHERE card_type!='memory' LIMIT 1").get();
  if (legacy) collapseCards(conn);
}

function collapseCards(conn) {
  const groups = conn.prepare('SELECT item_type, item_id FROM cards GROUP BY item_type, item_id').all();
  const tx = conn.transaction(() => {
    for (const g of groups) {
      const rows = conn.prepare(`SELECT * FROM cards WHERE item_type=? AND item_id=?
        ORDER BY state DESC, stability DESC, reps DESC`).all(g.item_type, g.item_id);
      const keep = rows[0];
      conn.prepare("UPDATE cards SET card_type='memory' WHERE id=?").run(keep.id);
      for (const r of rows.slice(1)) {
        conn.prepare('UPDATE reviews SET card_id=? WHERE card_id=?').run(keep.id, r.id);
        conn.prepare('DELETE FROM cards WHERE id=?').run(r.id);
      }
    }
  });
  tx();
  console.log('✓ migrated legacy cards → single memory track');
}

// Per-dimension seed retention targets (productive skills held higher).
export const DIM_RETENTION = {
  meaning: 0.84, reading: 0.85, listening: 0.88,
  pronunciation: 0.90, spoken: 0.90, sentence: 0.86,
};
export const DIMENSIONS = Object.keys(DIM_RETENTION);

// Boot hook: ensure the primary (app.db) is initialized. Secondary users initialize
// lazily on first request. Kept as the public entry the server + scripts call.
export function initSchema() { openConn(primarySlug()); }

// Back-compat: some callers/tests still import migrate(); run the primary migrations.
export function migrate() { const conn = openConn(primarySlug()); contentMigrate(conn); userMigrate(conn); }

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
