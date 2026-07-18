// .apkg importer.
//   node ingest/import-apkg.js [file.apkg] [--type word|sentence|auto] [--source NAME] [--yes]
// With no file arg, imports every .apkg in ingest/sources/.
import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { db, initSchema, MEDIA_DIR, ROOT } from '../server/db.js';
import { openApkg, soundRef, cleanField } from './lib/anki.js';
import { autoDetect, confirmMapping } from './lib/detect.js';
import { tonePattern } from '../server/pinyin.js';

const SOURCES_DIR = join(ROOT, 'ingest', 'sources');

function parseArgs(argv) {
  const args = { files: [], type: 'auto', source: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') args.type = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--yes' || a === '-y') args.yes = true;
    else args.files.push(a);
  }
  return args;
}

// Decide word vs sentence from model name + sampled hanzi length.
function guessType(sampleHanzi, modelName = '') {
  if (/sentence|spoonfed|phrase|dialog/i.test(modelName)) return 'sentence';
  if (/vocab|word|hsk|character|hanzi/i.test(modelName)) return 'word';
  const lens = sampleHanzi.filter(Boolean).map(h => h.length);
  if (!lens.length) return 'word';
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  return avg >= 5 ? 'sentence' : 'word';
}

const upsertWord = () => db().prepare(`
  INSERT INTO words(hanzi, pinyin, tone_pattern, english, audio_path)
  VALUES(@hanzi, @pinyin, @tone_pattern, @english, @audio_path)
  ON CONFLICT(hanzi) DO UPDATE SET
    pinyin=COALESCE(NULLIF(excluded.pinyin,''), words.pinyin),
    tone_pattern=COALESCE(excluded.tone_pattern, words.tone_pattern),
    english=COALESCE(NULLIF(excluded.english,''), words.english),
    audio_path=COALESCE(excluded.audio_path, words.audio_path)`);

const upsertSentence = () => db().prepare(`
  INSERT INTO sentences(hanzi, pinyin, english, audio_path, source)
  VALUES(@hanzi, @pinyin, @english, @audio_path, @source)
  ON CONFLICT(hanzi) DO UPDATE SET
    pinyin=COALESCE(NULLIF(excluded.pinyin,''), sentences.pinyin),
    english=COALESCE(NULLIF(excluded.english,''), sentences.english),
    audio_path=COALESCE(excluded.audio_path, sentences.audio_path),
    source=excluded.source`);

async function importFile(path, args) {
  const deck = await openApkg(path);
  const wStmt = upsertWord();
  const sStmt = upsertSentence();
  let words = 0, sentences = 0, skipped = 0;
  const sourceName = args.source || basename(path).replace(/\.apkg$/i, '');

  // Group notes by model so we map fields once per note type.
  const byModel = new Map();
  for (const note of deck.notes) {
    if (!byModel.has(note.mid)) byModel.set(note.mid, []);
    byModel.get(note.mid).push(note);
  }

  for (const [mid, notes] of byModel) {
    const model = deck.models[mid] || { name: mid, fields: notes[0].fields.map((_, i) => 'field' + i) };
    const sample = notes.slice(0, 30);
    const guess = autoDetect(model.fields, sample);
    const map = await confirmMapping(model.name, model.fields, sample, guess, { yes: args.yes });
    if (map.hanzi == null) { console.log(`  skip note type ${model.name}: no hanzi field`); continue; }

    const sampleHanzi = sample.map(n => cleanField(n.fields[map.hanzi]));
    const type = args.type === 'auto' ? guessType(sampleHanzi, model.name) : args.type;
    console.log(`  ${model.name}: ${notes.length} notes -> ${type}`);

    const tx = db().transaction((rows) => {
      for (const note of rows) {
        const hanzi = cleanField(note.fields[map.hanzi]);
        if (!hanzi) { skipped++; continue; }
        const pinyin = map.pinyin != null ? cleanField(note.fields[map.pinyin]) : '';
        const english = map.english != null ? cleanField(note.fields[map.english]) : '';
        // audio may be in its own field or embedded in hanzi/pinyin fields
        let audioName = null;
        for (const idx of [map.audio, map.hanzi, map.pinyin, map.english]) {
          if (idx == null) continue;
          const ref = soundRef(note.fields[idx]);
          if (ref) { audioName = ref; break; }
        }
        const audio_path = audioName ? deck.copyMedia(audioName, MEDIA_DIR) : null;

        if (type === 'sentence') {
          sStmt.run({ hanzi, pinyin, english, audio_path: audio_path || null, source: sourceName });
          sentences++;
        } else {
          wStmt.run({ hanzi, pinyin, tone_pattern: tonePattern(pinyin), english, audio_path: audio_path || null });
          words++;
        }
      }
    });
    tx(notes);
  }

  deck.cleanup();
  console.log(`Imported ${basename(path)}: +${words} words, +${sentences} sentences (${skipped} skipped)`);
}

async function main() {
  initSchema();
  const args = parseArgs(process.argv.slice(2));
  let files = args.files;
  if (!files.length) {
    if (!existsSync(SOURCES_DIR)) { console.error('No sources dir'); process.exit(1); }
    files = readdirSync(SOURCES_DIR).filter(f => f.toLowerCase().endsWith('.apkg')).map(f => join(SOURCES_DIR, f));
  }
  if (!files.length) { console.log('No .apkg files found. Drop decks in ingest/sources/'); return; }
  for (const f of files) {
    console.log(`\n>>> ${f}`);
    await importFile(f, args);
  }
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
