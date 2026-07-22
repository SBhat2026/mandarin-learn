// Persistent, local memory of the PERSON. Laoshi uses this to open with a personal
// hook, choose examples the learner cares about, and steer gently — it is NEVER
// surfaced to the learner as data. Everything lives in ./data/app.db; nothing
// leaves the machine. Degrades to a heuristic harvester with no API key.
import { db } from './db.js';
import { hasApiKey, completeJson } from './anthropic.js';

const now = () => new Date().toISOString();

export function getProfile() {
  return db().prepare('SELECT * FROM personal_profile ORDER BY confidence DESC, last_seen DESC').all();
}

// Insert or reinforce a durable fact. Repeated mentions raise confidence toward 1
// and bump mention_count; a 'stated' source is sticky (never downgraded to inferred).
export function upsertFact({ key, value, kind = 'fact', confidence = 0.6, source = 'inferred' }) {
  if (!key || !value) return;
  const k = String(key).trim().slice(0, 60), v = String(value).trim().slice(0, 200);
  if (!k || !v) return;
  const existing = db().prepare('SELECT * FROM personal_profile WHERE key=? AND value=?').get(k, v);
  if (existing) {
    // Reinforce: move confidence toward 1, keep the strongest source.
    const conf = Math.min(1, existing.confidence + 0.2 * (1 - existing.confidence) + 0.1 * confidence);
    const src = existing.source === 'stated' || source === 'stated' ? 'stated' : 'inferred';
    db().prepare(`UPDATE personal_profile SET confidence=?, source=?, kind=?, last_seen=?,
      mention_count=mention_count+1 WHERE id=?`).run(conf, src, kind, now(), existing.id);
  } else {
    db().prepare(`INSERT INTO personal_profile(key,value,kind,confidence,source,first_seen,last_seen,mention_count)
      VALUES(?,?,?,?,?,?,?,1)`).run(k, v, kind, Math.min(1, confidence), source, now(), now());
  }
}

// Open conversational threads worth picking back up ("planning a trip to Chengdu").
export function recentThreads(limit = 3) {
  return db().prepare(`SELECT * FROM personal_profile WHERE kind='thread'
    ORDER BY last_seen DESC, confidence DESC LIMIT ?`).all(limit);
}

// A compact, teacher-facing digest of who the learner is. Confidence- and
// recency-ranked; trimmed to a rough token budget. Shapes the teacher's behavior,
// never shown as data.
export function profileForPrompt(maxTokens = 220) {
  const rows = getProfile().filter(r => r.confidence >= 0.35);
  if (!rows.length) return '';
  const byKind = (k) => rows.filter(r => r.kind === k);
  const facts = [...byKind('fact'), ...byKind('preference')].slice(0, 8).map(r => `${r.key}: ${r.value}`);
  const interests = byKind('interest').slice(0, 6).map(r => r.value);
  const threads = byKind('thread').slice(0, 3).map(r => r.value);
  const parts = [];
  if (facts.length) parts.push(`Facts — ${facts.join('; ')}.`);
  if (interests.length) parts.push(`Enjoys — ${interests.join(', ')}.`);
  if (threads.length) parts.push(`Open threads — ${threads.join('; ')}.`);
  // Rough token clamp (~4 chars/token).
  const digest = parts.join(' ');
  return digest.length > maxTokens * 4 ? digest.slice(0, maxTokens * 4) + '…' : digest;
}

// Extract durable personal facts + open threads from a finished conversation and
// upsert them. Claude when available (nuanced), heuristic otherwise. Only the
// LEARNER's own statements are mined; inferred facts get decayed confidence.
export async function harvestFromTranscript(transcript = []) {
  const learner = transcript.filter(t => t.role === 'user').map(t => t.english || t.content || t.hanzi || '').filter(Boolean);
  if (!learner.length) return { harvested: 0 };
  let harvested = 0;

  if (hasApiKey()) {
    const convo = transcript.map(t => `${t.role === 'user' ? 'Learner' : 'Laoshi'}: ${t.english || t.hanzi || t.content || ''}`).join('\n');
    try {
      const out = await completeJson({
        system: 'You maintain a private profile of a language learner to help their teacher personalize future conversations. From the dialogue, extract ONLY durable personal facts the LEARNER revealed about themselves (job/study, hobbies, family, places, pets, plans) and open threads worth following up. Do not invent anything not supported by the learner\'s words. Output JSON {facts:[{key,value,kind}], threads:[value]} where kind ∈ fact|interest|preference. Keep values short.',
        messages: [{ role: 'user', content: convo }],
        max_tokens: 500,
      });
      for (const f of out?.facts || []) { upsertFact({ key: f.key, value: f.value, kind: f.kind || 'fact', confidence: 0.7, source: 'inferred' }); harvested++; }
      for (const th of out?.threads || []) { upsertFact({ key: 'open_thread', value: th, kind: 'thread', confidence: 0.6, source: 'inferred' }); harvested++; }
      return { harvested };
    } catch { /* fall through to heuristic */ }
  }

  // Heuristic fallback: mine simple English self-statements from the learner turns.
  for (const line of learner) harvested += heuristicHarvest(line);
  return { harvested };
}

// TODO(offline:) richer local extraction (e.g. a small Qwen pass). For now, catch
// the highest-signal English patterns the learner is likely to type.
const PATTERNS = [
  [/\bi (?:study|studied|major(?:ed)? in)\s+([a-z ]{3,30})/i, 'study', 'fact'],
  [/\bi (?:work|worked) (?:as|at|in)\s+([a-z ]{3,30})/i, 'work', 'fact'],
  [/\bi (?:like|love|enjoy)\s+([a-z ]{3,30})/i, 'like', 'interest'],
  [/\bi (?:have|has|got) (?:a |an )?(cat|dog|pet|sister|brother|kid|child|son|daughter)\b/i, 'has', 'fact'],
  [/\bi(?:'m| am) (?:planning|going) (?:to|a)\s+([a-z ]{3,40})/i, 'open_thread', 'thread'],
  [/\bi live in\s+([a-z ]{3,30})/i, 'location', 'fact'],
];
function heuristicHarvest(line) {
  let n = 0;
  for (const [re, key, kind] of PATTERNS) {
    const m = line.match(re);
    if (m) {
      // Trim the captured span at a clause boundary so "hiking and I study X" →
      // "hiking" rather than swallowing the next clause.
      const value = (m[1] || m[0]).split(/\s+(?:and|but|because|so|,|;)\s+/i)[0].trim();
      if (value.length >= 2) { upsertFact({ key, value, kind, confidence: 0.5, source: 'inferred' }); n++; }
    }
  }
  return n;
}
