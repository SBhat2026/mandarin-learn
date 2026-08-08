// The hosted instance is a public URL holding real API keys, so the gate is the
// thing standing between a stranger and my credit. Worth pinning: it must be
// inert locally (no password set) and must reject anything but an exact match.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('gate is disabled when no password is configured', async () => {
  delete process.env.APP_PASSWORD;
  const m = await import('../server/auth.js?no-pass');
  assert.equal(m.accessRequired(), false);
  assert.equal(m.checkAccess(''), true, 'everything passes when the gate is off');
  assert.equal(m.checkAccess(undefined), true);
});

test('gate accepts only the exact passphrase', async () => {
  process.env.APP_PASSWORD = 'correct horse battery staple';
  const m = await import('../server/auth.js?with-pass');
  assert.equal(m.accessRequired(), true);
  assert.equal(m.checkAccess('correct horse battery staple'), true);
  assert.equal(m.checkAccess('wrong'), false);
  assert.equal(m.checkAccess(''), false, 'empty must not pass a live gate');
  assert.equal(m.checkAccess(undefined), false);
  assert.equal(m.checkAccess('correct horse battery stapl'), false, 'prefix must not pass');
  assert.equal(m.checkAccess('correct horse battery staple '), false, 'trailing space must not pass');
  delete process.env.APP_PASSWORD;
});

test('middleware lets health/auth through and blocks the rest', async () => {
  process.env.APP_PASSWORD = 'pw';
  const { requireAccess } = await import('../server/auth.js?mw');
  const run = (path, header) => new Promise(resolve => {
    let nexted = false;
    const req = { path, get: (h) => (h === 'x-access' ? header : undefined) };
    const res = { status: (c) => ({ json: (b) => resolve({ code: c, body: b }) }) };
    requireAccess(req, res, () => { nexted = true; resolve({ code: 200 }); });
    if (!nexted) { /* resolved via res */ }
  });
  // Paths are relative to the /api mount point.
  assert.equal((await run('/health')).code, 200, 'health stays reachable for probes');
  assert.equal((await run('/auth/check')).code, 200, 'the gate check itself is open');
  assert.equal((await run('/meta')).code, 401, 'everything else is guarded');
  assert.equal((await run('/meta', 'pw')).code, 200, 'a valid passphrase passes');
  delete process.env.APP_PASSWORD;
});
