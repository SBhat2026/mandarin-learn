// Loader for `mandarin.md` — the Mandarin-specific half of Laoshi's prompt.
//
// It lives in a markdown file rather than in a string literal because it is the part
// a HUMAN tunes: whoever is teaching wants to add "两 not 二 before a measure word"
// without reading JavaScript. The file sits in `server/` (not `docs/`, which is
// dockerignored) so it ships with the image and is readable in production.
//
// The conversational rules stay in qwen.js. This file holds only what is true of
// teaching MANDARIN — tones, measure words, aspect, the errors English speakers make.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC = join(dirname(fileURLToPath(import.meta.url)), 'mandarin.md');

// Sections gated by measured level. `never` is documentation of rejected rules and is
// never sent; the prose preamble before the first `##` is documentation too.
const GATES = [
  { name: 'always', min: 0, max: Infinity },
  { name: 'beginner', min: 0, max: 0.35 },
  { name: 'intermediate', min: 0.35, max: 0.7 },
  { name: 'advanced', min: 0.7, max: Infinity },
];

let _sections = null;

// Parse `## heading` blocks into {name: [bullet, ...]}. Only top-level bullets are
// taken; tables and prose in the preamble are ignored, so the file can document
// itself without that documentation reaching the model.
export function sections() {
  if (_sections) return _sections;
  let text = '';
  try { text = readFileSync(DOC, 'utf8'); }
  catch { _sections = {}; return _sections; }

  const out = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) { current = h[1].toLowerCase(); out[current] = out[current] || []; continue; }
    if (!current) continue;
    const b = raw.match(/^[-*]\s+(.+)$/);
    if (b) { out[current].push(b[1].trim()); continue; }
    // A wrapped continuation line belongs to the bullet above it.
    if (/^\s{2,}\S/.test(raw) && out[current]?.length) {
      out[current][out[current].length - 1] += ' ' + raw.trim();
    }
  }
  _sections = out;
  return out;
}

// The doctrine for a learner at progression `t` ∈ [0,1] (level.js conversationProfile).
// Returns a single prompt block, or '' when the file is missing — Laoshi still works,
// just without the Mandarin-specific layer.
export function mandarinDoctrine(t = 0) {
  const s = sections();
  const picked = GATES.filter(g => t >= g.min && t < g.max)
    .flatMap(g => s[g.name] || []);
  if (!picked.length) return '';
  const band = t < 0.35 ? 'beginner' : t < 0.7 ? 'intermediate' : 'advanced';
  return [
    `TEACHING MANDARIN (this learner is at the ${band} band — these are non-negotiable):`,
    ...picked.map(p => `- ${p}`),
  ].join('\n');
}

// Test/tuning hook: re-read the file after an edit without restarting.
export function reloadDoctrine() { _sections = null; return sections(); }
