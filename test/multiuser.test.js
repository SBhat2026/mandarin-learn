// Workstream A guard: two local users must have fully independent state (models,
// settings, profiles, cards/due queues, capability mastery), with the primary user
// mapping to the existing app.db. No content is duplicated — content is shared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mandarin-mu-'));
process.env.APP_DB_PATH = join(dir, 'app.db');
process.env.APP_MEDIA_DIR = join(dir, 'media');
process.env.APP_USERS_DIR = join(dir, 'users');   // isolate the registry from the repo

const { initSchema, db, runAsUser, setModel, getModel, setSetting, getSetting } = await import('../server/db.js');
const { addUser, primarySlug, listUsers } = await import('../server/users.js');
initSchema();

test('registry starts with a single primary user', () => {
  const users = listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].primary, true);
});

test('learner_model and settings are isolated per user', () => {
  const p = primarySlug();
  const u2 = addUser('Tester');

  runAsUser(p, () => { setModel('level', 7); setSetting('onboarded', true); });
  runAsUser(u2.slug, () => { setModel('level', 99); setSetting('onboarded', false); });

  runAsUser(p, () => {
    assert.equal(getModel('level'), 7, 'primary keeps its own model value');
    assert.equal(getSetting('onboarded'), true);
  });
  runAsUser(u2.slug, () => {
    assert.equal(getModel('level'), 99, 'secondary has an independent model value');
    assert.equal(getSetting('onboarded'), false);
  });
});

test('cards / due queues are independent', () => {
  const p = primarySlug();
  const u2 = addUser('Tester2');

  runAsUser(u2.slug, () => {
    db().prepare(`INSERT INTO cards(item_type,item_id,card_type,state,suspended,due)
      VALUES('word',1,'memory',2,0,datetime('now','-1 day'))`).run();
  });

  const dueOf = (slug) => runAsUser(slug, () =>
    db().prepare(`SELECT COUNT(*) c FROM cards WHERE state>0 AND suspended=0 AND due<=datetime('now')`).get().c);

  assert.equal(dueOf(u2.slug), 1, 'secondary sees its own due card');
  assert.equal(dueOf(p), 0, 'primary due queue is untouched by the secondary');
});

test('capability mastery is independent', () => {
  const p = primarySlug();
  const u2 = addUser('Tester3');
  runAsUser(u2.slug, () => {
    db().prepare(`INSERT INTO capability_mastery(capability_id,score,demonstrations) VALUES(1,0.8,3)`).run();
  });
  const scoreOf = (slug) => runAsUser(slug, () =>
    db().prepare('SELECT score FROM capability_mastery WHERE capability_id=1').get()?.score ?? null);
  assert.equal(scoreOf(u2.slug), 0.8);
  assert.equal(scoreOf(p), null, 'primary has no mastery row from the secondary');
});
