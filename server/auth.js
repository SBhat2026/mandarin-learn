// A single shared passphrase guarding the hosted instance. This is NOT user
// authentication — the "who's here?" picker still handles identity and per-user
// data isolation. This exists for one reason: the deployed URL carries my API
// keys, so a stranger who stumbles onto it must not be able to spend them.
//
// Disabled entirely when APP_PASSWORD is unset, so local development is unchanged.
import { timingSafeEqual, createHash } from 'node:crypto';

const PASSWORD = process.env.APP_PASSWORD || '';

export function accessRequired() { return Boolean(PASSWORD); }

// Constant-time compare over fixed-length hashes, so a wrong guess can't be
// distinguished by timing (and unequal lengths don't throw).
function matches(supplied) {
  if (!PASSWORD) return true;
  if (typeof supplied !== 'string' || !supplied) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(PASSWORD).digest();
  return timingSafeEqual(a, b);
}

export function checkAccess(supplied) { return matches(supplied); }

// Guard every API route except the few needed to render the gate itself.
// The client stores the passphrase locally and sends it as `x-access`.
// NOTE: mounted as app.use('/api', …), so req.path here is RELATIVE to /api.
// These routes are also registered before the guard, making this a belt-and-braces
// safeguard that stays correct if the ordering ever changes.
const OPEN_PATHS = new Set(['/health', '/auth/check']);

export function requireAccess(req, res, next) {
  if (!PASSWORD) return next();
  if (OPEN_PATHS.has(req.path)) return next();
  if (matches(req.get('x-access'))) return next();
  res.status(401).json({ error: 'access required', accessRequired: true });
}
