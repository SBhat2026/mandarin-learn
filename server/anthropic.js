// Minimal Anthropic client (fetch-based, no SDK dep). Never required for the core
// review flow — callers must handle the null/disabled case gracefully.
import 'dotenv/config';

const API_URL = 'https://api.anthropic.com/v1/messages';
export const ENRICH_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Returns assistant text, or throws. Caller decides fallback.
export async function complete({ system, messages, model = ENRICH_MODEL, max_tokens = 1024 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens, system, messages }),
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
