import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { tonePattern, tonesOf, normalizeHanzi, clean } from '../server/pinyin.js';
import { autoDetect } from '../ingest/lib/detect.js';
import { openApkg } from '../ingest/lib/anki.js';
import { makeAll } from './make-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

// --- pure helpers ---
test('tonePattern converts accented pinyin', () => {
  assert.equal(tonePattern('nǐ hǎo'), '3-3');
  assert.equal(tonePattern('wǒ'), '3');
  assert.deepEqual(tonesOf('chī fàn'), [1, 4]);
});

test('clean strips HTML and [sound:] refs', () => {
  assert.equal(clean('你好<br>[sound:a.mp3]'), '你好');
});

test('normalizeHanzi drops punctuation and spaces', () => {
  assert.equal(normalizeHanzi('你好，世界！'), '你好世界');
});

// --- field auto-detection ---
test('autoDetect maps HSK-style fields', () => {
  const names = ['Hanzi', 'Pinyin', 'English', 'Audio'];
  const notes = [
    { fields: ['我', 'wǒ', 'I; me', '[sound:wo.mp3]'] },
    { fields: ['吃', 'chī', 'to eat', '[sound:chi.mp3]'] },
  ];
  const map = autoDetect(names, notes);
  assert.equal(map.hanzi, 0);
  assert.equal(map.pinyin, 1);
  assert.equal(map.english, 2);
  assert.equal(map.audio, 3);
});

// --- apkg parse ---
test('openApkg parses notes, models and media', async () => {
  const { apkg } = makeAll();
  const deck = await openApkg(apkg);
  assert.ok(deck.notes.length >= 13);
  const modelNames = Object.values(deck.models).map(m => m.name);
  assert.ok(modelNames.includes('HSK Vocab'));
  assert.ok(modelNames.includes('Spoonfed Sentence'));
  const dest = mkdtempSync(join(tmpdir(), 'media-'));
  assert.equal(deck.copyMedia('wo.mp3', dest), 'wo.mp3');
  assert.ok(existsSync(join(dest, 'wo.mp3')));
  deck.cleanup();
  rmSync(dest, { recursive: true, force: true });
});

// --- full pipeline against a temp DB ---
test('ingest pipeline imports words, dictionary, frequency and builds units', () => {
  const { apkg, cedict, freq } = makeAll();
  const dir = mkdtempSync(join(tmpdir(), 'mandb-'));
  const env = { ...process.env, APP_DB_PATH: join(dir, 'app.db'), APP_MEDIA_DIR: join(dir, 'media') };
  const run = (script, args) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'ingest', script), ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${script} failed: ${r.stderr}`);
    return r;
  };

  run('import-apkg.js', [apkg, '--yes', '--source', 'fixture']);
  run('import-cedict.js', [cedict]);
  run('import-frequency.js', [freq]);
  run('build-units.js', ['--topics', 'food,drink']);

  const db = new Database(env.APP_DB_PATH, { readonly: true });
  const words = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  const sents = db.prepare('SELECT COUNT(*) c FROM sentences').get().c;
  const dict = db.prepare('SELECT COUNT(*) c FROM dictionary').get().c;
  const fr = db.prepare('SELECT COUNT(*) c FROM frequency').get().c;
  const units = db.prepare('SELECT COUNT(*) c FROM units').get().c;

  assert.equal(words, 10, 'ten words imported');
  assert.equal(sents, 3, 'three sentences imported');
  assert.ok(dict >= 8, 'dictionary populated');
  assert.ok(fr >= 10, 'frequency populated');
  assert.ok(units >= 1, 'at least one unit');

  // freq backfill: 我 should have a real rank (not the sentinel).
  const wo = db.prepare('SELECT freq_rank, audio_path FROM words WHERE hanzi=?').get('我');
  assert.ok(wo.freq_rank < 1000, 'ranked word');
  assert.equal(wo.audio_path, 'wo.mp3', 'audio copied');

  // segmentation: 你好 sentence should map to known words 你 and 好.
  const s = db.prepare('SELECT word_ids FROM sentences WHERE hanzi=?').get('你好');
  const ids = JSON.parse(s.word_ids);
  assert.equal(ids.length, 2, '你好 segments into two known words');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
