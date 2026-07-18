import { db } from './db.js';
import { State } from './fsrs.js';
import { toneStats } from './tone.js';
import { evaluateThrottle, todayReviewStats, recentRetention } from './scheduler.js';

const STATE_NAMES = { 0: 'new', 1: 'learning', 2: 'review', 3: 'relearning' };

export function wordsByState() {
  const rows = db().prepare(`
    SELECT COALESCE(c.state, -1) st, COUNT(DISTINCT w.id) c
    FROM words w
    LEFT JOIN cards c ON c.item_type='word' AND c.item_id=w.id AND c.card_type='reading'
    GROUP BY st`).all();
  const out = { unseen: 0, new: 0, learning: 0, review: 0, relearning: 0 };
  for (const r of rows) {
    if (r.st === -1) out.unseen += r.c;
    else out[STATE_NAMES[r.st]] += r.c;
  }
  return out;
}

// Retention per ISO week (share of reps graded >= Good).
export function retentionCurve(weeks = 12) {
  return db().prepare(`
    SELECT strftime('%Y-%W', ts) week,
           SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) good,
           COUNT(*) total
    FROM reviews
    WHERE ts >= datetime('now', ?)
    GROUP BY week ORDER BY week`).all(`-${weeks * 7} days`)
    .map(r => ({ week: r.week, retention: r.total ? r.good / r.total : null, total: r.total }));
}

export function reviewsPerDay(days = 30) {
  return db().prepare(`
    SELECT date(ts,'localtime') day, COUNT(*) n, COALESCE(SUM(duration_ms),0)/60000.0 minutes
    FROM reviews WHERE ts >= datetime('now', ?)
    GROUP BY day ORDER BY day`).all(`-${days} days`);
}

// Weakest words: most lapses, then lowest stability.
export function weakestWords(limit = 15) {
  return db().prepare(`
    SELECT w.hanzi, w.pinyin, w.english, c.card_type, c.lapses, c.stability, c.state
    FROM cards c JOIN words w ON w.id=c.item_id
    WHERE c.item_type='word' AND c.reps > 0
    ORDER BY c.lapses DESC, c.stability ASC
    LIMIT ?`).all(limit);
}

export function fullStats() {
  return {
    wordsByState: wordsByState(),
    retentionCurve: retentionCurve(),
    reviewsPerDay: reviewsPerDay(),
    weakestWords: weakestWords(),
    tones: toneStats(),
    today: todayReviewStats(),
    retention14d: recentRetention(14),
    throttle: evaluateThrottle({ force: false }),  // read-only snapshot unless a week elapsed
  };
}
