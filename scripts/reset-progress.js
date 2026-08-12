// Reset every local account to the STARTING POSITION.
//
// This is not `db:reset` (which deletes the whole database, content and all). It
// wipes only per-user LEARNER STATE — cards, reviews, mastery, the hidden model,
// profile facts, conversations, settings — across the primary user's app.db AND
// every secondary user's DB, while leaving the shared CONTENT (words, sentences,
// dictionary, units, graph, capabilities) completely untouched.
//
// After this every account is a true blank beginner: nothing known, nothing
// introduced, rung 0, no onboarding, no placement — so the entrance exam runs.
//
//   npm run reset:progress            # all users
//   npm run reset:progress -- me      # one user by slug
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DB_PATH, DIM_RETENTION } from '../server/db.js';
import { listUsers, primarySlug, USERS_DIR } from '../server/users.js';

// Per-user STATE tables. Everything NOT in this list is shared content and is
// never touched. Kept in sync with schema-user.sql.
const STATE_TABLES = [
  'reviews', 'review_dims', 'cards',
  'word_mastery', 'acquisition', 'learner_model',
  'pron_signals', 'capability_mastery', 'capability_unlocks',
  'personal_profile', 'conversation_sessions', 'conversation_metrics',
  'settings',
];

function tableExists(conn, name) {
  return !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function resetConn(conn, label) {
  const cleared = [];
  // FK enforcement can only be toggled OUTSIDE a transaction; reviews→cards would
  // otherwise block the wipe regardless of delete order.
  conn.pragma('foreign_keys = OFF');
  const tx = conn.transaction(() => {
    for (const t of STATE_TABLES) {
      if (!tableExists(conn, t)) continue;
      const n = conn.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      conn.prepare(`DELETE FROM ${t}`).run();
      if (n) cleared.push(`${t}:${n}`);
    }
    // Retention targets are configuration, not progress — restore the seeds.
    if (tableExists(conn, 'dim_retention')) {
      conn.prepare('DELETE FROM dim_retention').run();
      const seed = conn.prepare('INSERT INTO dim_retention(dimension,target) VALUES(?,?)');
      for (const [dim, t] of Object.entries(DIM_RETENTION)) seed.run(dim, t);
    }
  });
  tx();
  conn.pragma('foreign_keys = ON');
  console.log(`✓ ${label} → starting position` + (cleared.length ? `  (cleared ${cleared.join(' ')})` : ' (already empty)'));
}

const only = process.argv[2] || null;
const users = listUsers().filter(u => !only || u.slug === only);
if (!users.length) {
  console.error(only ? `No such user: ${only}` : 'No users registered.');
  process.exit(1);
}

for (const u of users) {
  const isPrimary = u.slug === primarySlug();
  const path = isPrimary ? DB_PATH : join(USERS_DIR, `${u.slug}.db`);
  if (!existsSync(path)) { console.log(`· ${u.displayName} (${u.slug}) — no database yet, nothing to reset`); continue; }
  const conn = new Database(path);
  conn.pragma('journal_mode = WAL');
  resetConn(conn, `${u.displayName} (${u.slug})${isPrimary ? ' [primary]' : ''}`);
  conn.close();
}

console.log('\nAll accounts reset. Shared content (words, sentences, graph, capabilities) untouched.');
