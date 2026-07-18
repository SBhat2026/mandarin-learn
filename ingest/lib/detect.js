import readline from 'node:readline';
import { clean } from '../../server/pinyin.js';

const CJK = /[一-鿿㐀-䶿]/;
const PINYIN_MARK = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/i;
const HAS_SOUND = /\[sound:[^\]]+\]/;

function scoreField(samples) {
  let cjk = 0, pinyin = 0, latin = 0, sound = 0, len = 0;
  for (const raw of samples) {
    if (!raw) continue;
    if (HAS_SOUND.test(raw)) sound++;
    const t = clean(raw);
    if (!t) continue;
    len += t.length;
    const cjkChars = (t.match(/[一-鿿㐀-䶿]/g) || []).length;
    const latinChars = (t.match(/[a-z]/gi) || []).length;
    if (CJK.test(t)) cjk++;
    if (PINYIN_MARK.test(t) || /[a-zü]+[1-5]\b/i.test(t)) pinyin++;
    if (latinChars > cjkChars && latinChars > 2) latin++;
  }
  return { cjk, pinyin, latin, sound, avgLen: len / Math.max(1, samples.length) };
}

// Guess field roles from sampled note fields.
// Returns { hanzi, pinyin, english, audio } as field indexes (or null).
export function autoDetect(fieldNames, sampleNotes) {
  const n = fieldNames.length;
  const cols = Array.from({ length: n }, (_, i) => sampleNotes.map(f => f.fields[i]));
  const scores = cols.map(scoreField);
  const nameHint = (i, re) => re.test(fieldNames[i] || '');

  const pick = (scorer, taken) => {
    let best = -1, bestVal = -Infinity;
    for (let i = 0; i < n; i++) {
      if (taken.has(i)) continue;
      const v = scorer(scores[i], i);
      if (v > bestVal) { bestVal = v; best = i; }
    }
    return bestVal > 0 ? best : null;
  };

  const taken = new Set();
  const hanzi = pick((s, i) => s.cjk * 10 + (nameHint(i, /han|char|chinese|front|expression|simp/i) ? 5 : 0) - s.latin, taken);
  if (hanzi != null) taken.add(hanzi);
  const audio = pick((s, i) => s.sound * 10 + (nameHint(i, /audio|sound/i) ? 5 : 0), taken);
  if (audio != null) taken.add(audio);
  const pinyin = pick((s, i) => s.pinyin * 10 + (nameHint(i, /pin|reading|pron/i) ? 5 : 0) - s.cjk * 2, taken);
  if (pinyin != null) taken.add(pinyin);
  const english = pick((s, i) => s.latin * 10 + (nameHint(i, /eng|mean|def|translat|back/i) ? 5 : 0) - s.cjk * 3 - s.pinyin, taken);
  if (english != null) taken.add(english);

  return { hanzi, pinyin, english, audio };
}

// Interactive CLI mapping. Shows sample fields, asks the user to confirm/override.
export async function confirmMapping(modelName, fieldNames, sampleNotes, guess, opts = {}) {
  if (opts.yes) return guess;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  console.log(`\n=== Note type: ${modelName} ===`);
  fieldNames.forEach((fn, i) => {
    const sample = clean(sampleNotes[0]?.fields[i] || '').slice(0, 40);
    console.log(`  [${i}] ${fn.padEnd(14)} e.g. "${sample}"`);
  });
  console.log('Detected:', JSON.stringify(
    Object.fromEntries(Object.entries(guess).map(([k, v]) => [k, v == null ? '-' : fieldNames[v]]))));

  const roles = ['hanzi', 'pinyin', 'english', 'audio'];
  const map = { ...guess };
  for (const role of roles) {
    const cur = map[role] == null ? '-' : `${map[role]} (${fieldNames[map[role]]})`;
    const a = (await ask(`  ${role} field index [${cur}] (Enter to keep, 'x' for none): `)).trim();
    if (a === '') continue;
    if (a.toLowerCase() === 'x') { map[role] = null; continue; }
    const idx = Number(a);
    if (Number.isInteger(idx) && idx >= 0 && idx < fieldNames.length) map[role] = idx;
  }
  rl.close();
  return map;
}
