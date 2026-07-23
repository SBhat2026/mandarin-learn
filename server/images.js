// Image anchors (Workstream I) — subtle comprehensible-input support for CONCRETE
// nouns actually in play. NOT a picture-guessing game: at most a small illustrative
// glyph on a word's popover/bubble so meaning can land without English.
//
// Emoji/pictograph first: instant, offline, zero-dependency, and enough for the
// common concrete nouns a beginner meets. An open-image-API fetch (Openverse) is
// wired but INERT behind USE_IMAGE_FETCH (default off) so playtesting stays fast and
// offline; when enabled, results cache under data/media/img.
// TODO(images): enable USE_IMAGE_FETCH for richer anchors on a hosted deployment.
import { db, MEDIA_DIR } from './db.js';
import { cleanGloss } from './exercises.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const USE_IMAGE_FETCH = process.env.USE_IMAGE_FETCH === 'true';

// Content POS that can be a namable concrete thing (nouns). Adjectives excluded —
// you can't reliably picture "beautiful". Mirrors the capability content-POS guard.
const NOUN_POS = new Set(['n', 'ns', 'nr', 'nz', 'nt']);

// Curated English-keyword → emoji map for common concrete nouns. Keyword match is a
// whole-word contains against the gloss/english, longest keyword winning.
const EMOJI = [
  ['cat', '🐱'], ['dog', '🐶'], ['bird', '🐦'], ['fish', '🐟'], ['horse', '🐴'], ['pig', '🐷'],
  ['cow', '🐮'], ['sheep', '🐑'], ['chicken', '🐔'], ['rabbit', '🐰'], ['tiger', '🐯'], ['panda', '🐼'],
  ['mouse', '🐭'], ['snake', '🐍'], ['dragon', '🐲'], ['monkey', '🐵'], ['bear', '🐻'], ['elephant', '🐘'],
  ['water', '💧'], ['rain', '🌧️'], ['snow', '❄️'], ['sun', '☀️'], ['moon', '🌙'], ['star', '⭐'],
  ['cloud', '☁️'], ['wind', '💨'], ['fire', '🔥'], ['mountain', '⛰️'], ['tree', '🌳'], ['flower', '🌸'],
  ['grass', '🌿'], ['leaf', '🍃'], ['sea', '🌊'], ['river', '🏞️'],
  ['rice', '🍚'], ['noodle', '🍜'], ['bread', '🍞'], ['egg', '🥚'], ['meat', '🍖'], ['tea', '🍵'],
  ['coffee', '☕'], ['milk', '🥛'], ['apple', '🍎'], ['banana', '🍌'], ['fruit', '🍎'], ['vegetable', '🥬'],
  ['dumpling', '🥟'], ['cake', '🍰'], ['soup', '🍲'], ['wine', '🍷'], ['beer', '🍺'], ['food', '🍚'],
  ['car', '🚗'], ['bus', '🚌'], ['train', '🚆'], ['plane', '✈️'], ['boat', '⛵'], ['bike', '🚲'],
  ['house', '🏠'], ['home', '🏠'], ['school', '🏫'], ['hospital', '🏥'], ['shop', '🏬'], ['store', '🏬'],
  ['restaurant', '🍽️'], ['road', '🛣️'], ['door', '🚪'], ['window', '🪟'], ['bed', '🛏️'], ['chair', '🪑'],
  ['table', '🪑'], ['book', '📖'], ['phone', '📱'], ['computer', '💻'], ['money', '💰'], ['clock', '🕐'],
  ['clothes', '👕'], ['shoe', '👟'], ['hat', '🎩'], ['bag', '👜'], ['umbrella', '☂️'], ['key', '🔑'],
  ['hand', '✋'], ['eye', '👁️'], ['heart', '❤️'], ['foot', '🦶'], ['face', '🙂'], ['baby', '👶'],
  ['teacher', '🧑‍🏫'], ['student', '🧑‍🎓'], ['doctor', '🧑‍⚕️'], ['friend', '🧑‍🤝‍🧑'],
  ['music', '🎵'], ['ball', '⚽'], ['gift', '🎁'], ['sky', '🌌'], ['road', '🛣️'], ['city', '🏙️'],
];

function emojiFor(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ')} `;
  let best = null;
  for (const [kw, glyph] of EMOJI) {
    if (s.includes(` ${kw} `) || s.includes(` ${kw}s `)) {
      if (!best || kw.length > best.kw.length) best = { kw, glyph };
    }
  }
  return best?.glyph || null;
}

function isConcreteNoun(w) {
  if (w.concrete === 2) return true;                     // strongest concreteness bucket
  try { if (JSON.parse(w.pos || '[]').some(p => NOUN_POS.has(p))) return true; } catch {}
  return false;
}

// Resolve a small image anchor for a word (by hanzi). Returns one of:
//   { kind:'emoji', value:'🐱' } | { kind:'url', value:'/media/img/…' } | { kind:'none' }
export function imageFor(hanzi) {
  const w = db().prepare('SELECT id, hanzi, english, gloss, pos, concrete FROM words WHERE hanzi=?').get(hanzi);
  if (!w) return { kind: 'none' };
  if (!isConcreteNoun(w)) return { kind: 'none' };        // concrete nouns only
  const gloss = cleanGloss(w) || w.english || '';
  const glyph = emojiFor(gloss);
  if (glyph) return { kind: 'emoji', value: glyph, label: gloss };

  // Cached network image (if fetch was ever enabled) — serve without re-fetching.
  for (const ext of ['jpg', 'png', 'webp']) {
    const rel = join('img', `${w.id}.${ext}`);
    if (existsSync(join(MEDIA_DIR, rel))) return { kind: 'url', value: `/media/${rel}` };
  }
  // Optional live fetch is inert by default (see header). Not awaited on the hot path.
  if (USE_IMAGE_FETCH) fetchAndCache(w, gloss).catch(() => {});
  return { kind: 'none' };
}

// Best-effort Openverse thumbnail fetch + cache. Only runs when USE_IMAGE_FETCH=true.
async function fetchAndCache(w, gloss) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(gloss)}&license_type=commercial&mature=false&page_size=1`;
  const res = await fetch(url, { headers: { 'user-agent': 'mandarin-learn/1.0' } });
  if (!res.ok) return;
  const data = await res.json();
  const thumb = data?.results?.[0]?.thumbnail;
  if (!thumb) return;
  const img = await fetch(thumb);
  if (!img.ok) return;
  const buf = Buffer.from(await img.arrayBuffer());
  await mkdir(join(MEDIA_DIR, 'img'), { recursive: true });
  await writeFile(join(MEDIA_DIR, 'img', `${w.id}.jpg`), buf);
}
