import { db } from './db.js';

// Per-tone accuracy from speaking-card reviews that logged target/heard tones.
// Returns { perTone: {1:{correct,total,acc},...}, weakest: {tone, acc} | null,
//           weakPair: {a,b} | null }
export function toneStats() {
  const rows = db().prepare(`
    SELECT target_tone, heard_tone FROM reviews
    WHERE target_tone IS NOT NULL AND heard_tone IS NOT NULL`).all();

  const perTone = {};
  const confusion = {}; // "a->b" counts
  for (const r of rows) {
    const targets = String(r.target_tone).split('-');
    const heards = String(r.heard_tone).split('-');
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!/^[1-5]$/.test(t)) continue;
      perTone[t] ||= { correct: 0, total: 0 };
      perTone[t].total++;
      const h = heards[i];
      if (h === t) perTone[t].correct++;
      else if (/^[1-5]$/.test(h)) {
        const key = `${t}->${h}`;
        confusion[key] = (confusion[key] || 0) + 1;
      }
    }
  }
  for (const k of Object.keys(perTone)) {
    perTone[k].acc = perTone[k].total ? perTone[k].correct / perTone[k].total : null;
  }

  let weakest = null;
  for (const [tone, v] of Object.entries(perTone)) {
    if (v.total < 4) continue; // need signal
    if (!weakest || v.acc < weakest.acc) weakest = { tone: Number(tone), acc: v.acc, total: v.total };
  }

  let weakPair = null, worst = 0;
  for (const [key, n] of Object.entries(confusion)) {
    if (n > worst) { worst = n; const [a, b] = key.split('->'); weakPair = { a: Number(a), b: Number(b), count: n }; }
  }

  return { perTone, weakest, weakPair };
}

// A weak tone is "actionable" when accuracy < threshold with enough samples.
export function weakTone(threshold = 0.7) {
  const { weakest, weakPair } = toneStats();
  if (weakest && weakest.acc < threshold) return { tone: weakest.tone, pair: weakPair };
  return null;
}

// Build a ~2-minute minimal-pair drill: pick words that differ mainly by tone,
// preferring the weak tone pair, using imported audio where available.
export function buildToneDrill(pair, max = 8) {
  // Group single-syllable words by their base pinyin (accent-stripped), collect
  // ones that have audio and clear tone_pattern.
  const words = db().prepare(`
    SELECT hanzi, pinyin, english, tone_pattern, audio_path FROM words
    WHERE tone_pattern IS NOT NULL AND audio_path IS NOT NULL
      AND tone_pattern NOT LIKE '%-%'`).all();

  const base = (py) => (py || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[1-5]/g, '').replace(/\s+/g, '');

  const groups = new Map();
  for (const w of words) {
    const b = base(w.pinyin);
    if (!b) continue;
    (groups.get(b) || groups.set(b, []).get(b)).push(w);
  }

  const drills = [];
  for (const [b, ws] of groups) {
    const tones = new Set(ws.map(w => w.tone_pattern));
    if (tones.size < 2) continue;
    const wantA = pair ? ws.find(w => w.tone_pattern === String(pair.a)) : null;
    const wantB = pair ? ws.find(w => w.tone_pattern === String(pair.b)) : null;
    if (pair && wantA && wantB) drills.unshift({ base: b, pair: [wantA, wantB] });
    else drills.push({ base: b, pair: ws.slice(0, 2) });
    if (drills.length >= max) break;
  }
  return drills.slice(0, max);
}
