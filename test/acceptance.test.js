// Acceptance checks (§14) that can be automated. The behavioral checklist that
// needs a live model + browser lives in docs/qa-checklist.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'mandarin-acc-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
// Prove the offline path. Set empty (not delete) so dotenv/config — which runs when
// anthropic.js is later imported — does not resurrect the real key from .env.
process.env.ANTHROPIC_API_KEY = '';

const { initSchema } = await import('../server/db.js');
initSchema();

// 1. No lesson-announcement language surfaces in the UI.
test('no banned announcement phrases in the user-facing UI', () => {
  const banned = [/Today's topic/i, /New concept/i, /Lesson complete/i, /target word/i, /Finish lesson/i];
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.jsx?$/.test(name)) files.push(p);
    }
  })(join(root, 'src'));
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of banned) if (re.test(src)) hits.push(`${f} :: ${re}`);
  }
  assert.deepEqual(hits, [], 'banned phrases found: ' + hits.join(', '));
});

// 2. Killing the Claude key still yields a coherent, valid blueprint.
test('offline Director produces a valid, personal blueprint with no key', async () => {
  const { buildBlueprint } = await import('../server/director.js');
  const plan = { capability: { id: 1, slug: 'talk_about_hobbies', name: 'talk about your hobbies', cefr_ish: 'B1' },
    objectives: [{ objective: 'talk about your hobbies', vocab: ['游戏'], pattern: null, priority: 1 }],
    focal: { hanzi: '游戏', pinyin: 'yóuxì', gloss: 'game' }, targetVocab: [{ hanzi: '游戏' }], reviewVocab: [], scriptLevel: 0.2 };
  const bp = await buildBlueprint(plan, {});
  assert.equal(bp._engine, 'local', 'no key → offline builder');
  assert.ok(bp.openingStrategy && bp.conversationGoal && bp.questionLadder.length);
  assert.ok(bp.budget.exchanges[1] >= bp.budget.exchanges[0]);
  assert.doesNotMatch(bp.openingStrategy.toLowerCase(), /what do you want to talk about/);
});

// 3 + 4. A fact harvested in one session personalizes the NEXT session's opening.
test('a harvested fact is referenced in a later opening (cross-session memory)', async () => {
  const { harvestFromTranscript, profileForPrompt } = await import('../server/profile.js');
  const { buildBlueprintLocal } = await import('../server/director.js');
  // Session 1: learner reveals an interest (heuristic mines the English self-statement).
  await harvestFromTranscript([{ role: 'user', english: 'I like rock climbing on weekends' }]);
  assert.match(profileForPrompt(), /rock climbing/i, 'fact persisted to the profile');
  // Session 2: a fresh blueprint opens from that fact.
  const bp = buildBlueprintLocal({ objectives: [], reviewVocab: [] }, {});
  const opensPersonally = /rock climbing/i.test(bp.openingStrategy)
    || bp.personalConnections.some(c => /rock climbing/i.test(c));
  assert.ok(opensPersonally, 'later opening references the harvested interest');
});
