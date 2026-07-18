import { db, getSetting, setSetting } from './db.js';
import { State } from './fsrs.js';

export const DEFAULT_DAILY_NEW = 10;
export const NEW_CAP = 35;
export const NEW_FLOOR = 4;

export function dailyNew() {
  return getSetting('daily_new', DEFAULT_DAILY_NEW);
}

// New WORDS whose first review happened today (local time).
export function newWordsStartedToday() {
  const row = db().prepare(`
    SELECT COUNT(*) c FROM (
      SELECT c.item_id, MIN(r.ts) firstTs
      FROM reviews r JOIN cards c ON c.id = r.card_id
      WHERE c.item_type='word'
      GROUP BY c.item_id
    ) WHERE date(firstTs,'localtime') = date('now','localtime')`).get();
  return row.c;
}

// Reviews done today and total review time (ms).
export function todayReviewStats() {
  const row = db().prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(duration_ms),0) ms
    FROM reviews WHERE date(ts,'localtime') = date('now','localtime')`).get();
  return { count: row.n, minutes: (row.ms || 0) / 60000 };
}

// Rolling retention over the last `days`: share of review-state reps graded >=Good (Hard counts as pass).
export function recentRetention(days = 14) {
  const row = db().prepare(`
    SELECT
      SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) good,
      COUNT(*) total
    FROM reviews r
    WHERE r.ts >= datetime('now', ?)
      AND EXISTS (SELECT 1 FROM cards c WHERE c.id=r.card_id)`).get(`-${days} days`);
  if (!row.total) return null;
  return row.good / row.total;
}

// Average daily review minutes over the last `days` (only days with activity).
export function avgDailyReviewMinutes(days = 7) {
  const row = db().prepare(`
    SELECT COALESCE(SUM(duration_ms),0) ms,
           COUNT(DISTINCT date(ts,'localtime')) d
    FROM reviews WHERE ts >= datetime('now', ?)`).get(`-${days} days`);
  if (!row.d) return 0;
  return (row.ms / 60000) / row.d;
}

export function backlogRatio() {
  const due = db().prepare(
    `SELECT COUNT(*) c FROM cards WHERE state>0 AND suspended=0 AND due <= datetime('now')`).get().c;
  const avg = avgReviewsPerActiveDay();
  if (!avg) return due > 0 ? 2 : 0;
  return due / avg;
}

function avgReviewsPerActiveDay(days = 14) {
  const row = db().prepare(`
    SELECT COUNT(*) n, COUNT(DISTINCT date(ts,'localtime')) d
    FROM reviews WHERE ts >= datetime('now', ?)`).get(`-${days} days`);
  return row.d ? row.n / row.d : 0;
}

// Adaptive weekly throttle. Returns the decision + new value, and persists it.
// Called at most once/week (guarded by last_throttle_at).
export function evaluateThrottle({ force = false } = {}) {
  const last = getSetting('last_throttle_at', null);
  const current = dailyNew();
  const retention = recentRetention(14);
  const avgMin = avgDailyReviewMinutes(7);
  const backlog = backlogRatio();

  const weekMs = 7 * 24 * 3600 * 1000;
  const dueForEval = force || !last || (Date.now() - new Date(last).getTime()) >= weekMs;

  let decision = 'hold', reason, next = current;
  if (retention == null) {
    decision = 'hold';
    reason = 'Not enough review history yet — holding at the starting rate.';
  } else if (retention >= 0.90 && avgMin < 15) {
    decision = 'increase';
    next = Math.min(NEW_CAP, Math.round(current * 1.2));
    reason = `Retention ${(retention * 100).toFixed(0)}% ≥ 90% and ${avgMin.toFixed(0)} min/day < 15 → +20%.`;
  } else if (retention < 0.84 || backlog > 1.5) {
    decision = 'decrease';
    next = Math.max(NEW_FLOOR, Math.round(current * 0.7));
    reason = retention < 0.84
      ? `Retention ${(retention * 100).toFixed(0)}% < 84% → −30%.`
      : `Backlog ${backlog.toFixed(1)}× daily average > 1.5× → −30%.`;
  } else {
    decision = 'hold';
    reason = `Retention ${(retention * 100).toFixed(0)}% in the 84–90% comfort band → hold.`;
  }

  if (dueForEval && next !== current) {
    setSetting('daily_new', next);
    setSetting('last_throttle_at', new Date().toISOString());
  } else if (dueForEval) {
    setSetting('last_throttle_at', new Date().toISOString());
  }

  return {
    decision, reason,
    previous: current,
    current: dueForEval ? next : current,
    metrics: { retention, avgDailyMinutes: avgMin, backlogRatio: backlog },
    appliedNow: dueForEval && next !== current,
    nextEvalDue: last && !dueForEval ? new Date(new Date(last).getTime() + weekMs).toISOString() : null,
  };
}
