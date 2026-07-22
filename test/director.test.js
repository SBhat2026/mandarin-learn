// Milestone 3 guard: personal profile persistence + harvesting, and the Director's
// blueprint (offline path fully; schema validation for both paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-dir-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
delete process.env.ANTHROPIC_API_KEY;   // force the offline paths deterministically

const { initSchema } = await import('../server/db.js');
const profile = await import('../server/profile.js');
const director = await import('../server/director.js');
initSchema();

test('upsertFact inserts, reinforces, and keeps stated source sticky', () => {
  profile.upsertFact({ key: 'study', value: 'biology', kind: 'fact', confidence: 0.6, source: 'inferred' });
  profile.upsertFact({ key: 'study', value: 'biology', kind: 'fact', confidence: 0.6, source: 'stated' });
  const rows = profile.getProfile().filter(r => r.key === 'study');
  assert.equal(rows.length, 1, 'no duplicate rows for same key+value');
  assert.equal(rows[0].source, 'stated', 'stated source sticks');
  assert.equal(rows[0].mention_count, 2);
  assert.ok(rows[0].confidence > 0.6, 'reinforcement raises confidence');
});

test('profileForPrompt produces a compact teacher digest', () => {
  profile.upsertFact({ key: 'interest', value: 'hiking', kind: 'interest', confidence: 0.8, source: 'stated' });
  profile.upsertFact({ key: 'open_thread', value: 'planning a trip to Chengdu', kind: 'thread', confidence: 0.7, source: 'inferred' });
  const digest = profile.profileForPrompt();
  assert.match(digest, /biology/);
  assert.match(digest, /hiking/);
  assert.match(digest, /Chengdu/);
});

test('heuristic harvest mines self-statements with no API key', async () => {
  const transcript = [
    { role: 'user', english: 'I like hiking and I study computer science' },
    { role: 'assistant', hanzi: '很好' },
    { role: 'user', english: "I'm planning to visit Chengdu next month" },
  ];
  const before = profile.getProfile().length;
  const res = await profile.harvestFromTranscript(transcript);
  assert.ok(res.harvested >= 1, 'at least one fact harvested');
  assert.ok(profile.getProfile().length >= before);
});

test('buildBlueprintLocal fills a valid schema and personalizes the opening', async () => {
  const plan = {
    capability: { id: 1, slug: 'talk_about_hobbies', name: 'talk about your hobbies', cefr_ish: 'B1' },
    objectives: [{ objective: 'talk about your hobbies', vocab: ['游戏', '喜欢'], pattern: null, priority: 1 }],
    focal: { hanzi: '游戏', pinyin: 'yóuxì', gloss: 'game' },
    targetVocab: [{ hanzi: '游戏' }, { hanzi: '喜欢' }],
    reviewVocab: [{ hanzi: '好' }],
    scriptLevel: 0.2,
  };
  const bp = await director.buildBlueprint(plan, {});
  // offline (no key) → local engine
  assert.equal(bp._engine, 'local');
  assert.ok(bp.conversationGoal.length > 0);
  assert.ok(Array.isArray(bp.educationalOpportunities) && bp.educationalOpportunities.length >= 1);
  assert.ok(Array.isArray(bp.questionLadder) && bp.questionLadder.length > 0);
  assert.ok(bp.budget.exchanges[1] >= bp.budget.exchanges[0]);
  // opening must be personal, never the banned menu-open
  assert.doesNotMatch(bp.openingStrategy.toLowerCase(), /what do you want to talk about/);
  // profile from prior tests (hiking) should surface as a hook
  assert.ok(bp.personalConnections.some(c => /hiking/i.test(c)) || /hiking/i.test(bp.openingStrategy), 'uses a real interest hook');
});

test('validateBlueprint coerces malformed input to the contract', () => {
  const bp = director.validateBlueprint({ conversationGoal: 'x', questionLadder: ['bogus', 'recall'], budget: { exchanges: [9, 3] } });
  assert.equal(bp.tone.length > 0, true);
  assert.deepEqual(bp.questionLadder, ['recall'], 'drops invalid rungs');
  assert.ok(bp.budget.exchanges[1] >= bp.budget.exchanges[0], 'exchange bounds ordered');
  assert.ok(Array.isArray(bp.excursions));
});

test('question ladder rises with capability mastery', () => {
  const low = director.buildBlueprintLocal({ objectives: [], reviewVocab: [] }, { capabilityMastery: 0 });
  const high = director.buildBlueprintLocal({ objectives: [], reviewVocab: [] }, { capabilityMastery: 0.8 });
  assert.equal(low.questionLadder[0], 'recognition');
  assert.notEqual(high.questionLadder[0], 'recognition', 'high mastery starts higher on the ladder');
});
