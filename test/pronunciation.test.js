import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { classifyTones } from '../src/lib/pitch.js';

// Isolated DB for the server-side analysis (it looks up hanzi→pinyin).
const dir = mkdtempSync(join(tmpdir(), 'pron-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');

const { db, initSchema } = await import('../server/db.js');
const { analyzeSpoken, splitSyllable, accuracyToRating } = await import('../server/pronunciation.js');
initSchema();
db().prepare("INSERT INTO words(hanzi,pinyin,tone_pattern) VALUES('你好','nǐ hǎo','3-3')").run();
db().prepare("INSERT INTO words(hanzi,pinyin,tone_pattern) VALUES('老西','lǎo xī','3-1')").run();

test('splitSyllable separates initial and final', () => {
  assert.deepEqual(splitSyllable('shī'), { initial: 'sh', final: 'i' });
  assert.deepEqual(splitSyllable('lǎo'), { initial: 'l', final: 'ao' });
  assert.deepEqual(splitSyllable('ān'), { initial: '', final: 'an' });
});

test('analyzeSpoken flags a tone error from the acoustic contour', () => {
  const r = analyzeSpoken({ targetHanzi: '你好', targetPinyin: 'nǐ hǎo',
    spoken: { transcript: '你好', heardTones: [3, 4], timing: { latencyMs: 500, speechMs: 700 } } });
  assert.equal(r.toneSource, 'acoustic');
  assert.deepEqual(r.toneErrors, [{ i: 1, target: 3, heard: 4 }]);
  assert.equal(r.contentMatch, true);
});

test('analyzeSpoken infers a likely initial confusion (sh↔x)', () => {
  const r = analyzeSpoken({ targetHanzi: '老师', targetPinyin: 'lǎo shī',
    spoken: { transcript: '老西', timing: {} } });
  assert.equal(r.contentMatch, false);
  assert.ok(r.initialErrors.some(e => e.target === 'sh' && e.heard === 'x' && e.likely));
});

test('analyzeSpoken works transcript-only (no acoustic pitch)', () => {
  const r = analyzeSpoken({ targetHanzi: '你好', targetPinyin: 'nǐ hǎo',
    spoken: { transcript: '你好' } });
  assert.equal(r.toneSource, 'transcript');
  assert.equal(r.heardTonePattern, '3-3');
  assert.equal(r.contentMatch, true);
});

test('accuracyToRating maps to the FSRS 1..4 scale', () => {
  assert.equal(accuracyToRating(0.95), 4);
  assert.equal(accuracyToRating(0.7), 3);
  assert.equal(accuracyToRating(0.5), 2);
  assert.equal(accuracyToRating(0.1), 1);
});

test('classifyTones reads a rising contour as tone 2', () => {
  // Synthetic single-syllable rising pitch: f0 climbs from 120→200 Hz.
  const contour = Array.from({ length: 20 }, (_, i) => ({ t: i * 20, f0: 120 + i * 4 }));
  const tones = classifyTones(contour, 1);
  assert.equal(tones[0], 2);
});

test('classifyTones reads a falling contour as tone 4', () => {
  const contour = Array.from({ length: 20 }, (_, i) => ({ t: i * 20, f0: 220 - i * 5 }));
  const tones = classifyTones(contour, 1);
  assert.equal(tones[0], 4);
});

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });
