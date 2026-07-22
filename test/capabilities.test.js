// Milestone 1 guard: the capability layer seeds cleanly on an isolated db, the
// migration preserves existing data, and capability scoring/resolution behaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the db before importing anything that touches it.
const dir = mkdtempSync(join(tmpdir(), 'mandarin-cap-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');

const { db, initSchema } = await import('../server/db.js');
const { seedCatalog, CATALOG } = await import('../ingest/seed-capabilities.js');
const { createCardsForWord } = await import('../server/cards.js');
const { State } = await import('../server/fsrs.js');

initSchema();

// Seed a small, realistic word pool (topics + POS so refs resolve).
const words = [
  { hanzi: '你好', pinyin: 'nǐ hǎo', english: 'hello', topics: ['greetings'], pos: ['l'], freq: 30, concrete: 0 },
  { hanzi: '你', pinyin: 'nǐ', english: 'you', topics: ['greetings'], pos: ['r'], freq: 5, concrete: 0 },
  { hanzi: '是', pinyin: 'shì', english: 'to be', topics: [], pos: ['v'], freq: 3, concrete: 0 },
  { hanzi: '不', pinyin: 'bù', english: 'not', topics: [], pos: ['d'], freq: 8, concrete: 0 },
  { hanzi: '对', pinyin: 'duì', english: 'correct', topics: [], pos: ['a'], freq: 40, concrete: 0 },
  { hanzi: '猫', pinyin: 'māo', english: 'cat', topics: ['animals'], pos: ['n'], freq: 900, concrete: 1 },
  { hanzi: '狗', pinyin: 'gǒu', english: 'dog', topics: ['animals'], pos: ['n'], freq: 950, concrete: 1 },
  { hanzi: '大', pinyin: 'dà', english: 'big', topics: [], pos: ['a'], freq: 60, concrete: 0 },
  { hanzi: '小', pinyin: 'xiǎo', english: 'small', topics: [], pos: ['a'], freq: 70, concrete: 0 },
  { hanzi: '树', pinyin: 'shù', english: 'tree', topics: ['nature'], pos: ['n'], freq: 1200, concrete: 1 },
];
const ins = db().prepare(`INSERT INTO words(hanzi,pinyin,english,topics,pos,freq_rank,concrete) VALUES(?,?,?,?,?,?,?)`);
for (const w of words) ins.run(w.hanzi, w.pinyin, w.english, JSON.stringify(w.topics), JSON.stringify(w.pos), w.freq, w.concrete);

test('seedCatalog populates capabilities + requirements idempotently', () => {
  const n1 = seedCatalog();
  const n2 = seedCatalog();                       // rerun must not duplicate
  assert.equal(n1, CATALOG.length);
  assert.equal(n2, CATALOG.length);
  const caps = db().prepare('SELECT COUNT(*) c FROM capabilities').get().c;
  assert.equal(caps, CATALOG.length);
  const dupReq = db().prepare(`SELECT capability_id, kind, ref, COUNT(*) n
    FROM capability_requirements GROUP BY capability_id, kind, ref HAVING n > 1`).all();
  assert.equal(dupReq.length, 0, 'requirements must not duplicate on reseed');
});

test('every requirement ref is well-formed and resolvable-shaped', () => {
  const refs = db().prepare('SELECT kind, ref FROM capability_requirements').all();
  for (const r of refs) {
    if (r.kind === 'vocab') assert.match(r.ref, /^(pos:|topic:|word:)/, `bad vocab ref ${r.ref}`);
    if (r.kind === 'pattern') assert.ok(r.ref.length > 0);
  }
});

test('pickCapability returns a capability with resolved focal vocab', async () => {
  const { pickCapability } = await import('../server/capabilities.js');
  const pick = pickCapability();
  assert.ok(pick, 'a capability should be picked');
  assert.ok(pick.capability.slug, 'has a slug');
  // Early on (no prereqs held), an order-1 survival capability should win.
  assert.ok(pick.signals.readiness >= 0.6, 'picked capability is prerequisite-ready');
});

test('resolveVocab selects words that actually serve the capability', async () => {
  const { db } = await import('../server/db.js');
  const { getCapability, resolveVocab, requirementsFor } = await import('../server/capabilities.js');
  const cap = getCapability('describe_a_living_thing');
  const v = resolveVocab(cap, { known: new Set(), introduced: new Set(), dueSet: new Set() });
  assert.ok(v.focal, 'a focal word resolves');
  // The real invariant: the focal word satisfies at least one of the capability's
  // vocab requirement refs (an adjective, or an animals/nature noun) — not a
  // hard-coded list, which frequency ranking can legitimately reorder.
  const w = db().prepare('SELECT pos, topics FROM words WHERE hanzi=?').get(v.focal.hanzi);
  const pos = JSON.parse(w.pos || '[]'), topics = JSON.parse(w.topics || '[]');
  const serves = requirementsFor(cap.id).filter(r => r.kind === 'vocab').some(r => {
    const [k, val] = r.ref.split(':');
    return (k === 'pos' && pos.includes(val)) || (k === 'topic' && topics.includes(val)) || (k === 'word' && v.focal.hanzi === val);
  });
  assert.ok(serves, `focal ${v.focal.hanzi} (pos ${w.pos}) serves a requirement of ${cap.slug}`);
});

test('recordCapabilityDemonstration raises mastery and counts demos', async () => {
  const { getCapability, capabilityMastery, recordCapabilityDemonstration } = await import('../server/capabilities.js');
  const cap = getCapability('greet_someone');
  const before = capabilityMastery(cap.id);
  recordCapabilityDemonstration(cap.id, 0.9);
  const after = capabilityMastery(cap.id);
  assert.ok(after.score > before.score, 'mastery increases');
  assert.equal(after.demonstrations, before.demonstrations + 1);
});

test('prerequisite readiness gates advanced capabilities before basics are held', async () => {
  const { getCapability, prerequisiteReadiness } = await import('../server/capabilities.js');
  const advanced = getCapability('explain_a_reason');   // deep prereq chain
  const survival = getCapability('greet_someone');       // no prereqs
  assert.equal(prerequisiteReadiness(survival), 1);
  assert.ok(prerequisiteReadiness(advanced) < 1, 'advanced capability not fully ready at cold start');
});
