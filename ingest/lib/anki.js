import Database from 'better-sqlite3';
import { readFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractZip } from './unzip.js';
import { clean } from '../../server/pinyin.js';

const FIELD_SEP = '\x1f';

// Open the .apkg, return { notes, models, media, cleanup }.
// notes: [{ mid, fields: [str], guid }]
// models: { [mid]: { name, fields: [fieldName] } }
// media: { [numberedFile]: realName }  (numberedFile is the on-disk name in the zip)
export async function openApkg(apkgPath) {
  const work = join(tmpdir(), 'mandarin-apkg-' + Math.abs(hash(apkgPath)));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  await extractZip(apkgPath, work);

  const dbFile = ['collection.anki21', 'collection.anki2']
    .map(f => join(work, f)).find(existsSync);
  if (!dbFile) throw new Error('No collection.anki2/anki21 found in ' + apkgPath);

  const adb = new Database(dbFile, { readonly: true });
  const col = adb.prepare('SELECT models FROM col LIMIT 1').get();
  const modelsRaw = JSON.parse(col.models);
  const models = {};
  for (const [mid, m] of Object.entries(modelsRaw)) {
    models[mid] = { name: m.name, fields: m.flds.map(f => f.name) };
  }

  const noteRows = adb.prepare('SELECT id, guid, mid, flds FROM notes').all();
  const notes = noteRows.map(r => ({
    id: r.id, guid: r.guid, mid: String(r.mid),
    fields: r.flds.split(FIELD_SEP),
  }));
  adb.close();

  // media map: JSON at zip root { "0": "abc.mp3", ... }. The on-disk file is "0".
  let media = {};
  const mediaJson = join(work, 'media');
  if (existsSync(mediaJson)) {
    try { media = JSON.parse(readFileSync(mediaJson, 'utf8')); } catch {}
  }

  return {
    notes, models, media, workDir: work,
    // Copy a referenced media filename (real name) into destDir; returns basename or null.
    copyMedia(realName, destDir) {
      const numbered = Object.keys(media).find(k => media[k] === realName);
      if (numbered == null) return null;
      const src = join(work, numbered);
      if (!existsSync(src)) return null;
      mkdirSync(destDir, { recursive: true });
      const out = join(destDir, realName);
      copyFileSync(src, out);
      return realName;
    },
    cleanup() { rmSync(work, { recursive: true, force: true }); },
  };
}

// Pull the first [sound:xxx] reference out of a field.
export function soundRef(field = '') {
  const m = String(field).match(/\[sound:([^\]]+)\]/);
  return m ? m[1] : null;
}

export function cleanField(f) { return clean(f); }

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
