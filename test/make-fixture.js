// Build a tiny .apkg fixture (+ CC-CEDICT and frequency samples) for tests.
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, 'fixtures');

const FIELD_SEP = '\x1f';

const WORD_MODEL = {
  id: '1001', name: 'HSK Vocab',
  flds: [{ name: 'Hanzi' }, { name: 'Pinyin' }, { name: 'English' }, { name: 'Audio' }],
};
const SENT_MODEL = {
  id: '2002', name: 'Spoonfed Sentence',
  flds: [{ name: 'Hanzi' }, { name: 'Pinyin' }, { name: 'English' }],
};

const WORDS = [
  ['我', 'wǒ', 'I; me', '[sound:wo.mp3]'],
  ['你', 'nǐ', 'you', '[sound:ni.mp3]'],
  ['好', 'hǎo', 'good; well', '[sound:hao.mp3]'],
  ['是', 'shì', 'to be', ''],
  ['吃', 'chī', 'to eat', '[sound:chi.mp3]'],
  ['饭', 'fàn', 'rice; meal; food', ''],
  ['水', 'shuǐ', 'water', ''],
  ['茶', 'chá', 'tea', ''],
  ['家', 'jiā', 'home; family', ''],
  ['人', 'rén', 'person', ''],
];
const SENTENCES = [
  ['你好', 'nǐ hǎo', 'Hello.'],
  ['我吃饭', 'wǒ chī fàn', 'I eat food.'],
  ['你是好人', 'nǐ shì hǎo rén', 'You are a good person.'],
];

export function makeApkg(outPath) {
  const work = join(tmpdir(), 'mk-apkg-' + process.pid);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const adb = new Database(join(work, 'collection.anki21'));
  adb.exec(`CREATE TABLE col (models TEXT);
            CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, flds TEXT);`);
  const models = { [WORD_MODEL.id]: WORD_MODEL, [SENT_MODEL.id]: SENT_MODEL };
  adb.prepare('INSERT INTO col(models) VALUES(?)').run(JSON.stringify(models));

  const ins = adb.prepare('INSERT INTO notes(id, guid, mid, flds) VALUES(?,?,?,?)');
  let id = 1;
  for (const w of WORDS) ins.run(id, 'g' + id++, Number(WORD_MODEL.id), w.join(FIELD_SEP));
  for (const s of SENTENCES) ins.run(id, 'g' + id++, Number(SENT_MODEL.id), s.join(FIELD_SEP));
  adb.close();

  // media: numbered files + JSON map. Reference three audio files.
  const media = { '0': 'wo.mp3', '1': 'ni.mp3', '2': 'hao.mp3', '3': 'chi.mp3' };
  writeFileSync(join(work, 'media'), JSON.stringify(media));
  for (const [num, name] of Object.entries(media)) {
    writeFileSync(join(work, num), `FAKE_AUDIO:${name}`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(outPath, { force: true });
  const r = spawnSync('zip', ['-q', '-r', outPath, '.'], { cwd: work });
  if (r.status !== 0) throw new Error('zip failed: ' + r.stderr);
  rmSync(work, { recursive: true, force: true });
  return outPath;
}

const CEDICT_SAMPLE = `# CC-CEDICT sample
你 你 [ni3] /you (informal)/
好 好 [hao3] /good/well/proper/
你好 你好 [ni3 hao3] /hello/hi/
我 我 [wo3] /I/me/my/
吃 吃 [chi1] /to eat/to consume/
飯 饭 [fan4] /food/meal/(cooked) rice/
水 水 [shui3] /water/
茶 茶 [cha2] /tea/
`;

const FREQ_SAMPLE = `word,freq
的,100000
我,90000
你,85000
是,80000
好,70000
人,60000
吃,40000
家,30000
水,20000
饭,15000
茶,8000
`;

export function makeAll() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const apkg = join(FIXTURE_DIR, 'fixture.apkg');
  makeApkg(apkg);
  const cedict = join(FIXTURE_DIR, 'cedict-sample.u8');
  writeFileSync(cedict, CEDICT_SAMPLE);
  const freq = join(FIXTURE_DIR, 'freq-sample.csv');
  writeFileSync(freq, FREQ_SAMPLE);
  return { apkg, cedict, freq };
}

// Allow running directly to regenerate fixtures.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = makeAll();
  console.log('Fixtures:', out);
}
