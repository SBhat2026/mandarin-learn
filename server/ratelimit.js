// A basic per-session request cap for the expensive AI endpoints. When the app is
// shared over a Cloudflare tunnel, everyone's turns hit MY Claude/DashScope keys and
// one shared local Qwen — so cap each session (and the whole instance) to keep costs
// and queueing sane. In-memory sliding window; resets on restart. Not security, just
// a friendly brake. Tunable via env.
import { currentUserSlug } from './db.js';

const WINDOW_MS = Number(process.env.AI_CAP_WINDOW_MS) || 10 * 60 * 1000;   // 10 min
const PER_USER = Number(process.env.AI_CAP_PER_USER) || 60;                 // AI calls / window / user
const GLOBAL = Number(process.env.AI_CAP_GLOBAL) || 300;                    // AI calls / window / instance

const hits = new Map();   // key → number[] (timestamps)

function record(key, now) {
  const arr = (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  return arr.length;
}
function count(key, now) {
  return (hits.get(key) || []).filter(t => now - t < WINDOW_MS).length;
}

// Express middleware guarding an expensive AI route. Counts per-user and globally.
export function aiRateLimit(req, res, next) {
  const now = Date.now();
  const user = currentUserSlug();
  const globalN = count('__global__', now);
  const userN = count(`u:${user}`, now);
  if (globalN >= GLOBAL || userN >= PER_USER) {
    const retryAfter = Math.ceil(WINDOW_MS / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: globalN >= GLOBAL
        ? 'This shared session is busy right now — give it a minute and try again.'
        : 'You’ve been chatting a lot! Take a short break and come back in a few minutes.',
      retryAfter,
    });
  }
  record('__global__', now);
  record(`u:${user}`, now);
  next();
}
