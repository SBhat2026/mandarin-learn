// Workstream I/J guard: image anchors resolve emoji for concrete nouns only, and
// automatic modality bias converges from behavior with no setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-pres-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');

const { initSchema, db, setModel } = await import('../server/db.js');
const { imageFor } = await import('../server/images.js');
const { presentationBias, recordChannelSignal } = await import('../server/learner.js');
initSchema();

// Seed a concrete noun, an abstract noun-less word, and a verb.
db().prepare('INSERT INTO words(id,hanzi,pinyin,english,pos,concrete) VALUES(?,?,?,?,?,?)')
  .run(1, '猫', 'māo', 'cat', '["n"]', 2);
db().prepare('INSERT INTO words(id,hanzi,pinyin,english,pos,concrete) VALUES(?,?,?,?,?,?)')
  .run(2, '思想', 'sīxiǎng', 'thought; ideology', '["n"]', 0);
db().prepare('INSERT INTO words(id,hanzi,pinyin,english,pos,concrete) VALUES(?,?,?,?,?,?)')
  .run(3, '跑', 'pǎo', 'to run', '["v"]', 0);

test('image anchor: concrete noun → emoji, verb/no-match → none', () => {
  assert.deepEqual(imageFor('猫').kind, 'emoji', 'cat gets an emoji');
  assert.equal(imageFor('猫').value, '🐱');
  assert.equal(imageFor('跑').kind, 'none', 'a verb is not a concrete noun');
  assert.equal(imageFor('思想').kind, 'none', 'abstract noun has no emoji match');
  assert.equal(imageFor('不存在').kind, 'none', 'unknown word → none');
});

test('modality bias is neutral without signal and leans from behavior', () => {
  const neutral = presentationBias();
  assert.equal(neutral.channel, 'balanced');
  assert.equal(neutral.audioFirstProb, 0, 'no audio-first until there is signal');

  // Repeatedly handling audio without revealing text → auditory lean.
  for (let i = 0; i < 6; i++) recordChannelSignal('kept_audio');
  const auditory = presentationBias();
  assert.equal(auditory.channel, 'auditory');
  assert.ok(auditory.audioFirstProb > 0, 'auditory learners can get audio-first turns');

  // Now a text-reliant learner (fresh signal) → visual, audio-first off.
  setModel('channel_obs', { reveal_text: 0, kept_audio: 0 });
  for (let i = 0; i < 8; i++) recordChannelSignal('reveal_text');
  const visual = presentationBias();
  assert.equal(visual.channel, 'visual');
  assert.equal(visual.audioFirstProb, 0, 'visual learners are never hidden-text-first');
  assert.equal(visual.images, true, 'visual learners get image anchors');
});
