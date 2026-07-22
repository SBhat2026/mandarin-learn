// Idempotent migration for the conversational-architecture upgrade. Applies the
// new tables (capabilities, personal_profile, conversation_sessions/metrics) and
// seeds the capability catalog on an EXISTING ./data/app.db WITHOUT wiping learner
// data. Safe to run repeatedly.
//
//   npm run migrate            # apply schema + seed capabilities
//   npm run migrate -- --enrich # + optional Claude requirement enrichment
import 'dotenv/config';
import { db, initSchema } from '../server/db.js';
import { seedCatalog } from '../ingest/seed-capabilities.js';

function has(table) {
  return !!db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

async function main() {
  const before = {
    words: has('words') ? db().prepare('SELECT COUNT(*) c FROM words').get().c : 0,
    cards: has('cards') ? db().prepare('SELECT COUNT(*) c FROM cards').get().c : 0,
    reviews: has('reviews') ? db().prepare('SELECT COUNT(*) c FROM reviews').get().c : 0,
  };

  // initSchema is itself idempotent (CREATE TABLE IF NOT EXISTS + additive column
  // migrations). It creates the new conversational tables alongside the old ones.
  initSchema();

  const created = ['capabilities', 'capability_requirements', 'capability_mastery',
    'personal_profile', 'conversation_sessions', 'conversation_metrics'].filter(has);

  const n = seedCatalog();

  const after = {
    words: db().prepare('SELECT COUNT(*) c FROM words').get().c,
    cards: db().prepare('SELECT COUNT(*) c FROM cards').get().c,
    reviews: db().prepare('SELECT COUNT(*) c FROM reviews').get().c,
  };

  // Guard: learner data must be preserved, never wiped.
  for (const k of Object.keys(before)) {
    if (after[k] < before[k]) throw new Error(`migration REGRESSED ${k}: ${before[k]} → ${after[k]}`);
  }

  console.log('✓ conversational tables present:', created.join(', '));
  console.log(`✓ seeded ${n} capabilities`);
  console.log(`✓ learner data preserved — words:${after.words} cards:${after.cards} reviews:${after.reviews}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('✗ migration failed:', e.message); process.exit(1); });
