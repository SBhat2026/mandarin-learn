import { fsrs, createEmptyCard, Rating, State } from 'ts-fsrs';

export { Rating, State };

const DESIRED_RETENTION = 0.88;
const scheduler = fsrs({ request_retention: DESIRED_RETENTION });

// Map a DB card row -> ts-fsrs Card object.
export function toFsrsCard(row) {
  if (!row || row.state === 0 || row.due == null) {
    return createEmptyCard();
  }
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

// Given a DB row + rating (1..4), return the updated FSRS fields to persist.
export function applyRating(row, rating, now = new Date()) {
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

export { DESIRED_RETENTION };
