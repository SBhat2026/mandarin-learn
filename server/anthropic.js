// Minimal Anthropic client (fetch-based, no SDK dep). Never required for the core
// review flow — callers must handle the null/disabled case gracefully.
import 'dotenv/config';
import { getModel, setModel } from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

// Two invisible-pass tiers, both selectable per-user for playtesting:
//   FAST  — cheap default (Haiku). Used unless a user opts into 'rich'.
//   RICH  — richer planner (Sonnet). Its exact model id is intentionally BLANK
//           until the correct current Sonnet string is confirmed from the console.
// CLAUDE_MODEL_RICH stays empty by design; when a user asks for 'rich' but no rich
// id is configured, we transparently fall back to FAST (logged once) so nothing
// breaks. Set CLAUDE_MODEL_RICH in .env once the Sonnet id is known.
export const CLAUDE_MODEL_FAST = process.env.CLAUDE_MODEL_FAST || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
export const CLAUDE_MODEL_RICH = process.env.CLAUDE_MODEL_RICH || '';   // TODO(sonnet): set once id confirmed
// Back-compat alias for existing callers (enrichment pass).
export const ENRICH_MODEL = CLAUDE_MODEL_FAST;

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Is a richer (Sonnet) model actually available to switch to? The UI reads this so
// the toggle can explain itself when the id hasn't been provided yet.
export function richModelAvailable() {
  return Boolean(CLAUDE_MODEL_RICH);
}

// The current user's preferred invisible-pass tier ('fast' | 'rich'). Stored in the
// hidden learner_model (which becomes per-user under the multi-user split), so this
// naturally follows the active user. Defaults to the cheap/fast model.
export function claudeModelPref() {
  try { return getModel('claude_model_pref', 'fast') === 'rich' ? 'rich' : 'fast'; }
  catch { return 'fast'; }
}
export function setClaudeModelPref(pref) {
  const v = pref === 'rich' ? 'rich' : 'fast';
  try { setModel('claude_model_pref', v); } catch {}
  return v;
}

let _warnedRich = false;
// Resolve a tier ('fast'|'rich'|undefined→user pref) to a concrete model id, degrading
// rich→fast when no rich id is configured.
export function resolveModel(tier) {
  const want = tier || claudeModelPref();
  if (want === 'rich') {
    if (CLAUDE_MODEL_RICH) return CLAUDE_MODEL_RICH;
    if (!_warnedRich) { console.warn('[anthropic] rich model requested but CLAUDE_MODEL_RICH is blank — using fast'); _warnedRich = true; }
    return CLAUDE_MODEL_FAST;
  }
  return CLAUDE_MODEL_FAST;
}

// Normalize `system` into content blocks and mark the leading static block for
// prompt caching when requested. Accepts a plain string, or {static, dynamic} so
// callers (the Director) can cache the invariant design-principles block and vary
// only the per-conversation tail — cutting repeated input cost.
function buildSystem(system) {
  if (system && typeof system === 'object' && ('static' in system || 'dynamic' in system)) {
    const blocks = [];
    if (system.static) blocks.push({ type: 'text', text: String(system.static), cache_control: { type: 'ephemeral' } });
    if (system.dynamic) blocks.push({ type: 'text', text: String(system.dynamic) });
    return blocks;
  }
  return system;   // plain string — unchanged
}

// Returns assistant text, or throws. Caller decides fallback. `model` may be a
// concrete id or a tier alias ('fast'|'rich'); `tier` is a convenience alias.
export async function complete({ system, messages, model, tier, max_tokens = 1024 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const resolved = model && model.includes('-') ? model : resolveModel(tier || model);
  const sys = buildSystem(system);
  const cached = Array.isArray(sys) && sys.some(b => b.cache_control);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...(cached ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
    },
    body: JSON.stringify({ model: resolved, max_tokens, system: sys, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// Ask for JSON and parse it, tolerating markdown fences.
export async function completeJson(opts) {
  const text = await complete(opts);
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.search(/[[{]/);
  return JSON.parse(start >= 0 ? cleaned.slice(start) : cleaned);
}
