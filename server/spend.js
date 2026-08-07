// Metered-API spend tracking. One OpenRouter key funds the whole instance (including
// any testers on a shared tunnel), so spend is deliberately GLOBAL — it lives in a
// plain JSON file rather than the DB, which is routed per-user and would fragment it.
//
// Two sources, used for different jobs:
//   • local ledger  — every call's reported cost, bucketed per day. Drives the
//                     story-frequency throttle (needs today's number immediately).
//   • /api/v1/key   — OpenRouter's own usage/limit. Authoritative for the balance
//                     shown to the learner, so the footer can't drift from reality.
import 'dotenv/config';   // self-sufficient: don't depend on another module loading env first
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from './db.js';

const LEDGER = process.env.SPEND_LEDGER || join(ROOT, 'data', 'spend.json');
// Above this, story generation (the discretionary spend) throttles. Conversation is
// never throttled — it is the point of the app.
const SOFT_DAILY = Number(process.env.SPEND_SOFT_DAILY_USD) || 0.15;

const today = () => new Date().toISOString().slice(0, 10);

function load() {
  try { return JSON.parse(readFileSync(LEDGER, 'utf8')); }
  catch { return { days: {}, total: 0, calls: 0 }; }
}
function save(s) {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    writeFileSync(LEDGER, JSON.stringify(s));
  } catch { /* ledger is best-effort; never break a turn over it */ }
}

// Record one metered call. `cost` is USD as reported by the provider.
export function recordSpend(cost, { kind = 'conversation' } = {}) {
  const c = Number(cost);
  if (!Number.isFinite(c) || c <= 0) return;
  const s = load();
  const d = today();
  s.days[d] = s.days[d] || { total: 0, calls: 0, byKind: {} };
  s.days[d].total += c;
  s.days[d].calls += 1;
  s.days[d].byKind[kind] = (s.days[d].byKind[kind] || 0) + c;
  s.total = (s.total || 0) + c;
  s.calls = (s.calls || 0) + 1;
  // Keep the ledger bounded — 90 days is plenty for the trailing average.
  const keep = Object.keys(s.days).sort().slice(-90);
  s.days = Object.fromEntries(keep.map(k => [k, s.days[k]]));
  save(s);
}

export function todaySpend() {
  return load().days[today()]?.total || 0;
}

// Mean daily spend over prior days that had activity (excludes today, so a spike
// today is measured against the established norm rather than against itself).
export function baselineDaily() {
  const s = load();
  const prior = Object.entries(s.days).filter(([d]) => d !== today()).map(([, v]) => v.total);
  if (!prior.length) return null;
  return prior.reduce((a, b) => a + b, 0) / prior.length;
}

// Story generation is the discretionary cost. Throttle when today is running hot:
// either past the absolute soft cap, or well above the learner's own established
// daily norm. Conversation quality is never reduced — only story FREQUENCY.
export function storyThrottle() {
  const t = todaySpend();
  const base = baselineDaily();
  const overCap = t > SOFT_DAILY;
  const overNorm = base != null && base > 0.005 && t > base * 3;
  const on = overCap || overNorm;
  return {
    on,
    // When throttled, a fresh story is only generated every 6h; otherwise the
    // current one is reused. Nothing else about stories changes.
    minHoursBetween: on ? 6 : 0,
    reason: on ? (overCap ? 'daily-cap' : 'above-norm') : null,
    today: t, baseline: base, softCap: SOFT_DAILY,
  };
}

// OpenRouter's own accounting. /credits gives purchased-vs-used (the real balance);
// /key adds an authoritative usage_daily, which beats the local ledger for display
// since it survives restarts and counts calls made outside this process. Cached —
// this feeds a footer, not a hot path. Null when unavailable (no key / offline).
let _cache = { at: 0, data: null };
export async function remoteBalance({ maxAgeMs = 300000 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || process.env.USE_OPENROUTER !== 'true') return null;
  if (Date.now() - _cache.at < maxAgeMs) return _cache.data;
  const headers = { authorization: `Bearer ${key}` };
  try {
    const [credits, keyInfo] = await Promise.all([
      fetch('https://openrouter.ai/api/v1/credits', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('https://openrouter.ai/api/v1/key', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    const c = credits?.data || {};
    const k = keyInfo?.data || {};
    const total = Number(c.total_credits), used = Number(c.total_usage);
    _cache = { at: Date.now(), data: {
      usage: Number.isFinite(used) ? used : null,
      limit: Number.isFinite(total) ? total : null,
      remaining: Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : null,
      usageDaily: Number.isFinite(Number(k.usage_daily)) ? Number(k.usage_daily) : null,
    } };
  } catch { _cache = { at: Date.now(), data: null }; }
  return _cache.data;
}

export async function spendSummary() {
  const s = load();
  const remote = await remoteBalance();
  const throttle = storyThrottle();
  return {
    // Provider's daily figure wins when available; the local ledger is the fallback.
    today: Number((remote?.usageDaily ?? todaySpend()).toFixed(4)),
    total: Number((remote?.usage ?? s.total ?? 0).toFixed(4)),
    calls: s.calls || 0,
    remaining: remote?.remaining != null ? Number(remote.remaining.toFixed(2)) : null,
    limit: remote?.limit != null ? Number(remote.limit.toFixed(2)) : null,
    throttled: throttle.on,
    throttleReason: throttle.reason,
  };
}
