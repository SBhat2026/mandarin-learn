// Workstream F/G guard: live difficulty calibration signal + one-shot capability
// unlock moments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-cal-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db } = await import('../server/db.js');
const { computeCalibration } = await import('../server/momentum.js');
const caps = await import('../server/capabilities.js');
initSchema();

test('calibration reads struggle as negative, ease as positive', () => {
  const struggling = computeCalibration([
    { role: 'assistant', hanzi: '你喜欢什么？' },
    { role: 'user', content: 'um how do I say this' },
    { role: 'user', hanzi: '对' },
  ]);
  assert.ok(struggling < 0, `struggling should be negative, got ${struggling}`);

  const breezing = computeCalibration([
    { role: 'assistant', hanzi: '你喜欢中文吗？' },
    { role: 'user', hanzi: '我觉得中文很有意思，因为可以认识很多新朋友。' },
  ]);
  assert.ok(breezing > 0, `breezing should be positive, got ${breezing}`);
});

test('capability unlock fires once after enough demonstrations', () => {
  db().prepare(`INSERT INTO capabilities(id,slug,name,cefr_ish,ordering) VALUES(1,'talk_animals','chat about animals','A2',2)`).run();
  assert.equal(caps.pendingUnlock(), null, 'no unlock before demonstrations');

  for (let i = 0; i < 5; i++) caps.recordCapabilityDemonstration(1, 0.9);
  const m = caps.capabilityMastery(1);
  assert.ok(m.score >= 0.7 && m.demonstrations >= 3, `mastery crossed threshold: ${JSON.stringify(m)}`);

  const pending = caps.pendingUnlock();
  assert.ok(pending && pending.id === 1, 'unlock is pending after crossing threshold');

  caps.markUnlockAcked(1);
  assert.equal(caps.pendingUnlock(), null, 'acknowledged unlock does not re-fire');

  // Further demonstrations must not create a second unlock row.
  caps.recordCapabilityDemonstration(1, 0.9);
  const rows = db().prepare('SELECT COUNT(*) c FROM capability_unlocks').get().c;
  assert.equal(rows, 1, 'exactly one unlock row, ever');
});
