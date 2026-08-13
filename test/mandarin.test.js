// The Mandarin doctrine file is part of the prompt, so it needs the same guarantees
// as code: the right rules reach the right learner, and the rules explicitly marked
// as rejected never reach anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sections, mandarinDoctrine } = await import('../server/mandarin.js');

test('every gated section parses out of the markdown', () => {
  const s = sections();
  for (const name of ['always', 'beginner', 'intermediate', 'advanced', 'never']) {
    assert.ok(s[name]?.length >= 5, `${name} section has rules`);
  }
  // The documentation table above the first heading must not become prompt text.
  assert.ok(!Object.values(s).flat().some(r => r.includes('| section |')));
});

test('the doctrine is gated to the learner band, and always-rules always apply', () => {
  const beginner = mandarinDoctrine(0.1), mid = mandarinDoctrine(0.5), adv = mandarinDoctrine(0.9);

  assert.match(beginner, /beginner band/);
  assert.match(mid, /intermediate band/);
  assert.match(adv, /advanced band/);

  // Tones are non-negotiable at every level.
  for (const d of [beginner, mid, adv]) assert.match(d, /TONES ARE MEANING/);

  // 了-as-past-tense is the error a beginner must never be taught; 把/被 is the
  // construction a beginner must never be burdened with.
  assert.match(beginner, /Do NOT explain 了/);
  assert.ok(!beginner.includes('把门关上'), 'beginners are not given 把');
  assert.match(adv, /把/);
  assert.ok(!adv.includes('Do NOT explain 了'), 'the beginner-only rule stops applying');
});

test('the rejected-rules section is never sent to the model', () => {
  const rejected = sections().never;
  assert.ok(rejected.length, 'there are rejected rules on record');
  for (const t of [0, 0.2, 0.5, 0.8, 1]) {
    const d = mandarinDoctrine(t);
    for (const r of rejected) {
      assert.ok(!d.includes(r), `rejected rule leaked at t=${t}: ${r.slice(0, 40)}`);
    }
  }
});

test('the doctrine stays small enough to prepend to every turn', () => {
  for (const t of [0, 0.5, 1]) {
    assert.ok(mandarinDoctrine(t).length < 4000, `doctrine at t=${t} is prompt-sized`);
  }
});
