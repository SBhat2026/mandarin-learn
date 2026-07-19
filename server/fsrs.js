import { fsrs, createEmptyCard, Rating, State } from 'ts-fsrs';
import { db, DIM_RETENTION } from './db.js';

export { Rating, State };

// Legacy single-target retention (still exported for the Stats "why").
export const DESIRED_RETENTION = 0.88;

// One scheduler per distinct retention target, built lazily and cached.
const schedulers = new Map();
function schedulerForTarget(target) {
  const key = target.toFixed(3);
  if (!schedulers.has(key)) schedulers.set(key, fsrs({ request_retention: target }));
  return schedulers.get(key);
}

// Live per-dimension target (adaptable — read from dim_retention, seeded fallback).
export function dimTarget(dimension) {
  try {
    const row = db().prepare('SELECT target FROM dim_retention WHERE dimension=?').get(dimension);
    if (row) return row.target;
  } catch {}
  return DIM_RETENTION[dimension] ?? DESIRED_RETENTION;
}

export function toFsrsCard(row) {
  if (!row || row.state === 0 || row.due == null) return createEmptyCard();
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

// Advance the shared memory card. The interval reflects the dimension just
// tested: productive skills (0.90) come back sooner than receptive ones (0.84).
export function applyRating(row, rating, dimension = null, now = new Date()) {
  const target = dimension ? dimTarget(dimension) : DESIRED_RETENTION;
  const scheduler = schedulerForTarget(target);
  const card = toFsrsCard(row);
  const scheduled = scheduler.repeat(card, now);
  const next = scheduled[rating].card;
  return {
    due: next.due.toISOString(),
    stability: next.stability,
    difficulty: next.difficulty,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    reps: next.reps,
    lapses: next.lapses,
    state: next.state,
    last_review: (next.last_review ?? now).toISOString(),
  };
}
