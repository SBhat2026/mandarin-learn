// The microphone path, which a hands-free conversation leans on completely: if a
// transcript is wrong the learner is corrected for a sentence they never said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, isHallucination, confidenceOf } from '../server/stt.js';
import { toSimplified, looksTraditional } from '../server/zh.js';

test('traditional transcripts are converted, simplified ones are left alone', () => {
  assert.equal(toSimplified('這是貓'), '这是猫');
  assert.equal(toSimplified('我有一隻貓'), '我有一只猫');
  assert.equal(toSimplified('這是猫'), '这是猫');          // mixed script
  assert.equal(toSimplified('这是猫'), '这是猫');          // already simplified: untouched
  assert.equal(looksTraditional('这是猫'), false);
});

test('characters identical in both scripts are never rewritten', () => {
  // 面 and 后 exist in both scripts; a careless map turns 面条 into 麵条 or mangles 后.
  for (const s of ['面条', '后来', '我们在后面', '一个人']) assert.equal(toSimplified(s), s);
});

test('whisper subtitle boilerplate is rejected, not handed to the learner', () => {
  // These are what Whisper emits when it is fed silence or breath — the hands-free
  // loop records silence constantly, so this is the common case, not the edge case.
  for (const junk of [
    '字幕由Amara.org社群提供',
    '請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目',
    '谢谢观看',
    '嗯嗯嗯',
    '。。。',
    '好好好好好好好好好好好好',                              // repetition loop
  ]) assert.equal(isHallucination(junk), true, `should reject: ${junk}`);
});

test('real learner utterances survive the filter', () => {
  for (const real of ['猫', '这是猫', '我有一只猫', '我今天很累', '好', '我不知道']) {
    assert.equal(isHallucination(real), false, `should keep: ${real}`);
  }
});

test('clean() reports why it dropped something instead of returning a bare empty string', () => {
  const junk = clean('字幕由Amara.org社群提供', { engine: 'groq', confidence: 0.9 });
  assert.equal(junk.transcript, '');
  assert.equal(junk.rejected, 'hallucination');
  assert.equal(junk.heard, '字幕由Amara.org社群提供');    // still visible for debugging

  const ok = clean('這是貓。', { engine: 'groq', confidence: 0.8 });
  assert.equal(ok.transcript, '这是猫');                 // converted AND trailing 。 trimmed
  assert.equal(ok.converted, true);
  assert.equal(ok.confidence, 0.8);
});

test('a short genuine answer is not mistaken for a repetition loop', () => {
  // 好 and 谢谢 have low character diversity by construction; the degeneracy test must
  // not fire on them or every polite answer disappears.
  assert.equal(isHallucination('好'), false);
  assert.equal(isHallucination('谢谢'), false);
  assert.equal(isHallucination('对对'), false);
});

// Confidence is a gate on whether the learner's sentence gets sent unreviewed, so its
// calibration is behaviour, not a detail. The numbers below are MEASURED from real
// whisper output on this corpus, not invented.
test('confidence calibration matches observed whisper output', () => {
  // Clean synthesized 這是貓: avg_logprob −0.57, no_speech_prob 0.02. This must read as
  // confident — an earlier curve scored it 0.52 and would have made the app ask "did
  // you really say that?" after a perfectly clear sentence.
  const clear = confidenceOf([{ start: 0, end: 1, avg_logprob: -0.575, no_speech_prob: 0.02 }]);
  assert.ok(clear >= 0.6, `clean speech should be confident, got ${clear}`);

  // A genuinely marginal decode must fall under the send threshold (0.5).
  const marginal = confidenceOf([{ start: 0, end: 1, avg_logprob: -1.05, no_speech_prob: 0.3 }]);
  assert.ok(marginal < 0.5, `marginal speech should be held back, got ${marginal}`);

  // Confident tokens over audio the model thinks is not speech is the cough case.
  const cough = confidenceOf([{ start: 0, end: 1, avg_logprob: -0.4, no_speech_prob: 0.9 }]);
  assert.ok(cough < 0.5, `non-speech should be held back, got ${cough}`);

  // No segments means the backend told us nothing — that is unknown, NOT bad, and the
  // caller relies on null to keep voice mode working where confidence is unavailable.
  assert.equal(confidenceOf([]), null);
  assert.equal(confidenceOf(undefined), null);
});
