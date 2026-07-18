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

export function initSchema() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db().exec(sql);
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
