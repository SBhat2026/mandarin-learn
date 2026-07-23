// Ladder M6 guard: a zero-profile user's opening must not invent personal history.
// The offline Director's cold-start opening steers to a concrete grounded scene and
// the executor system prompt carries an explicit no-fabrication rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-nofab-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');
process.env.ANTHROPIC_API_KEY = '';

const { initSchema } = await import('../server/db.js');
const { buildBlueprintLocal } = await import('../server/director.js');
initSchema();

const FABRICATION = /did you (go|have|visit)|how was your (weekend|trip|day at)|last time you|remember when you|你(去|上次)/i;

test('a zero-profile cold-start opening invents no personal history', () => {
  const plan = { capability: null, objectives: [], focal: null, targetVocab: [], reviewVocab: [], scriptLevel: 0 };
  const bp = buildBlueprintLocal(plan, { profileDigest: '' });
  assert.ok(!FABRICATION.test(bp.openingStrategy), `opening fabricated history: "${bp.openingStrategy}"`);
  assert.match(bp.openingStrategy, /concrete|grounded|here-and-now|everyday/i, 'opens from a grounded scene');
  assert.match(bp.openingStrategy, /not (invent|fabricate)|do not invent|never fabricate/i, 'explicitly forbids invention');
});
