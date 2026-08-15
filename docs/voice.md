# Voice mode

Speaking is the point of the app, and until now speaking meant tapping a microphone
button, waiting, and reading the result into a text box. That is a transcription tool
with a conversation attached. Voice mode inverts it: the teacher speaks, the microphone
arms itself, and the learner never touches the keyboard.

The obvious objection is the right one — *why not just talk to a general chatbot?* The
answer has to be something a general assistant cannot do, and there are three:

1. **It knows what you are trying to learn.** Every recognition request is primed with
   the words this session has actually taught (`sessionVocabHint`). A learner's flat,
   hesitant 钱 is ambiguous audio; it stops being ambiguous when the recognizer has
   been told 钱 is on the table. No general assistant has that context.
2. **The text stays on screen.** Voice mode changes the input, not the lesson. The
   interlinear — hanzi over pinyin over gloss, each word tappable — is still there. A
   voice-only Mandarin app is a podcast; you cannot learn characters from audio.
3. **It corrects you.** The correction ladder still runs on what you said out loud.

## The loop

```
teacher speaks ──▶ mic arms ──▶ learner talks ──▶ silence ends the turn
      ▲                                                    │
      └──────────────── reply ◀── transcribe ◀─────────────┘
```

`speakAwait()` resolves when the audio actually finishes, and the microphone opens on
that promise. The previous code fired the second sentence on a fixed 900ms timer, which
either clipped the first line or left dead air — and as the trigger for opening a
microphone it would have had the teacher recording itself.

Endpointing is the existing acoustic VAD (`recordUtterance`), with hands-free timings:
1.1s of silence to end a turn (vs 700ms push-to-talk), a 12s ceiling, and `noSpeechMs`
to close the microphone quietly after 6s of nobody talking. A beginner composing a
sentence out loud pauses far longer than someone dictating a text message.

**Barge-in** is why `stopSpeaking()` exists: tapping the mic cuts the teacher off
mid-sentence. Without it every turn is a lecture you have to wait out.

## Why the transcript is not always sent

A misheard sentence is worse here than in a general voice assistant. The learner gets
*corrected* for words they never said, and concludes their pronunciation is wrong when
the microphone was. So confidence gates it:

| confidence | what happens |
| --- | --- |
| ≥ 0.5 | sent automatically — the loop continues, hands-free |
| < 0.5 | shown with 再说一次 / 对·send |
| `null` | sent — the backend gave us no signal, which is **unknown, not bad** |

That last row matters: the Web Speech fallback reports no confidence at all, and
treating unknown as low would disable voice mode entirely on those browsers.

Confidence comes from Whisper's per-segment `avg_logprob` (discounted by
`no_speech_prob`, which is what catches a cough decoded as fluent Chinese). The curve is
calibrated against measurement, not intuition: a **clean** synthesized 這是貓 scores
`avg_logprob −0.57`. An English-derived intuition that treats −0.5 as marginal would
flag perfect audio as doubtful. Short Chinese clips simply sit lower. See
`test/stt.test.js`.

## What the microphone path had to fix first

Three things were wrong in ways that only a hands-free loop exposes.

**Whisper returns traditional characters.** Asked for `zh`, it transcribed 这是猫 as
`這是貓`. Everything downstream compares characters — the correction ladder, the
vocabulary guard, the known-character set — so an unconverted transcript does not
"differ slightly", it matches *nothing*: the learner says the right sentence and is told
they used words outside the lesson. `server/zh.js` converts using the traditional and
simplified columns already in the bundled CC-CEDICT, so there is no new dependency.
Characters identical in both scripts (面, 后) are excluded by construction and cannot be
mangled.

**Whisper invents text when fed silence.** Chinese training audio is largely subtitled
video, so silence decodes to subtitle boilerplate — 字幕由…提供, 請訂閱, 谢谢观看 — and to
repetition loops. Push-to-talk rarely records silence. A loop that re-arms after every
teacher turn records it constantly, so this is the common case, not the edge case. See
`HALLUCINATIONS` and `degenerate()`.

**The model was reloaded on every utterance.** Measured: four clips through one process
took 10.4s against 5.3s for one, i.e. ~3.5s of fixed Python startup and model load per
utterance against ~1.7s of real work. `whisperd.py` keeps the model resident.

A related trap: warming the resident worker on *silence* is not enough. Silence makes
the decoder emit end-of-transcript immediately, so its kernels never compile and the
first genuine sentence still paid ~15s. Warming on one bundled second of real Mandarin
(`server/assets/warm.mp3`) exercises encoder and decoder both, and took the first
request from **15.5s to 2.1s**.

The model also changed: `large-v3-turbo` measured *faster* than `medium` (4.67s vs
5.65s) while being a stronger model — the old choice was made when the only comparison
was against `small`.

## Measured

Round-tripping app TTS back through the app's own STT, all four correct:

| said | heard | confidence | latency |
| --- | --- | --- | --- |
| 这是猫 | 这是猫 | 1.00 | 2.1s (first) |
| 我有一只猫 | 我有一只猫 | 1.00 | 1.9s |
| 你有多少钱 | 你有多少钱 | 0.76 | 1.7s |
| 我今天很累 | 我今天很累 | 0.96 | 1.8s |

Reproduce by POSTing an mp3 to `/api/stt`.

## Hosted

Fly runs Linux, where MLX cannot run, so `sttAvailable()` selects Groq
(`whisper-large-v3-turbo`, ~$0.04/audio-hour) and the resident worker is unused. Groq is
asked for `verbose_json` to get the same segment statistics; if it ever refuses that
format the code retries with plain `json` and simply loses confidence gating, rather
than losing the microphone.
