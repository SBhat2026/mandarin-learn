// Users registry for the local multi-user split (max 5, no auth). Pure filesystem —
// it must NOT import db.js (db.js imports THIS to resolve the primary user), so keep
// it dependency-free. User #1 is `primary` and maps to the existing app.db directly,
// so the original single-user progress is preserved untouched. Secondary users get
// their own state DB (see db.js) with the shared content ATTACHed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
export const USERS_DIR = process.env.APP_USERS_DIR || join(ROOT, 'data', 'users');
const USERS_JSON = join(USERS_DIR, 'users.json');
export const MAX_USERS = 5;

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user';
}

let _cache = null;
function load() {
  if (_cache) return _cache;
  mkdirSync(USERS_DIR, { recursive: true });
  if (existsSync(USERS_JSON)) { _cache = JSON.parse(readFileSync(USERS_JSON, 'utf8')); return _cache; }
  // First run of the multi-user version: register user #1 = the existing app.db.
  // No data is moved; the primary user simply uses app.db directly (idempotent).
  _cache = { users: [{ id: 1, slug: 'me', displayName: 'Me', primary: true, createdAt: nowISO(), claudeModelPref: 'fast' }] };
  save();
  return _cache;
}
function save() { mkdirSync(USERS_DIR, { recursive: true }); writeFileSync(USERS_JSON, JSON.stringify(_cache, null, 2)); }
function nowISO() { return new Date().toISOString(); }

export function listUsers() {
  return load().users.map(u => ({ id: u.id, slug: u.slug, displayName: u.displayName, primary: !!u.primary, claudeModelPref: u.claudeModelPref || 'fast' }));
}
export function getUser(slug) { return load().users.find(u => u.slug === slug) || null; }
export function hasUser(slug) { return !!getUser(slug); }
export function primarySlug() {
  const s = load();
  return (s.users.find(u => u.primary) || s.users[0])?.slug || 'me';
}

export function addUser(displayName) {
  const s = load();
  if (s.users.length >= MAX_USERS) throw new Error(`This is a small local setup — up to ${MAX_USERS} people. Remove someone first.`);
  let base = slugify(displayName || `user${s.users.length + 1}`), slug = base, i = 2;
  while (s.users.some(u => u.slug === slug)) slug = `${base}-${i++}`;
  const id = Math.max(0, ...s.users.map(u => u.id)) + 1;
  const u = { id, slug, displayName: (displayName || '').trim() || slug, primary: false, createdAt: nowISO(), claudeModelPref: 'fast' };
  s.users.push(u); save();
  return u;
}

export function setUserPref(slug, pref) {
  const u = getUser(slug);
  if (u) { u.claudeModelPref = pref === 'rich' ? 'rich' : 'fast'; save(); }
  return u;
}
