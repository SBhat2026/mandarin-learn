# Level-sweep diagnostics

```
npm run diagnose                  # all five levels
npm run diagnose -- --levels 0,4  # just those
npm run diagnose -- --turns 16    # longer sessions
npm run diagnose -- --json        # writes diagnostics.json
npm run diagnose -- --keep        # keep the scratch DBs to poke at
```

Exits non-zero if any `fail`-severity probe trips, so it works as a pre-deploy gate.

## Why a sweep and not a unit test

Nearly every bug this app has shipped was a **level** bug — behaviour that is correct
for one learner and broken for another, which is exactly what a fixed-fixture unit
test cannot see. The guided rung grinding the same two nouns was invisible to anyone
with 500 words. The free rung never ending was invisible to a beginner who never
reached it. The intro line shipping without pinyin was invisible to everyone except
the true beginner it was written for.

So the harness seeds five learners spanning true-beginner → advanced, drives a whole
session for each against the real engine, and runs the same probes across all of them.
A probe that passes at L3 and fails at L0 is the finding.

| level | solid words | expected rung | learner |
| --- | --- | --- | --- |
| 0 | 0 | 0 guided | never seen Chinese |
| 1 | 40 | 1 semi | recognises nouns, produces single words |
| 2 | 180 | 2 free | HSK1-ish, short sentences |
| 3 | 700 | 2 free | HSK3-ish, converses |
| 4 | 1600 | 2 free | HSK4/5-ish, opinions and abstractions |

Each level replies from its own script — deliberately imperfect, mixing languages and
stalling — and a confusion turn (`I don't understand`) is injected on turn 3 so the
never-strand path is always exercised.

Script lines are **tagged**, so the correction probes know what they are looking at:
`error:<kind>` is a planted mistake that must come back corrected (`我是好`,
`我有一个猫`, `二个人`), `toneless` is pinyin without tone marks, and `good` is
unambiguously correct and must never be "corrected". Testing only that errors get
caught is half a test — the other half is that nothing right gets touched.

**Isolation:** one scratch copy of `app.db` plus a scratch users dir; each level is a
secondary user with its own state DB. `data/app.db` is never written to.

## The probes are oracles, not mirrors

`scripts/lib/probes.js`. A probe that calls `vocabguard.validateTurn` to check that
`vocabguard` produced a valid turn proves nothing — it agrees with itself by
construction. So:

- **decodability** recomputes its own allowed set, and asks the app's *actual*
  promise: is every character either already known or shipped with a per-word
  pinyin+gloss token the interlinear can render?
- **semantic-sanity** carries hand-checked noun→category ground truth for the words
  that have actually broken before (太阳, 高中), and flags 有/几个 on an uncountable,
  去/在 on a non-place, 吃 on a non-food.

| probe | severity | what it protects |
| --- | --- | --- |
| no-choices | fail | no turn answers for the learner |
| model-answer | fail | a readable model sentence is always askable at guided rungs |
| correction | fail | planted errors are corrected AND correct sentences are not |
| strictness | fail | toneless pinyin is fine early and corrected late |
| blank-turns | fail | the worst failure mode: an empty teacher bubble |
| grounding | fail | every reply carries pinyin AND English |
| decodability | fail | nothing opaque on screen at a guided rung |
| semantic-sanity | fail | "how many suns do you have?" |
| arc-completion | fail | the session ends itself |
| never-strand | fail | confusion always gets a re-ground and a next move |
| rung-assignment | fail | the level lands on the right rung |
| passage-sanity | fail | ≤1 unmet char/sentence, ≥90% per passage |
| high-yield | fail | no untrustworthy phonetic key proposed |
| self-teach-honesty | fail | no prediction offered without evidence |
| mid-session-growth | warn | the session travels instead of grinding |
| fixation | warn | not one noun for the whole session |
| repetition | warn | no back-to-back repeats |
| latency | warn | a slow teacher is a teacher you leave |
| coverage | warn | reading profile matches the level |
| passage-climb | warn | passages reach the ~95% band, not only 100% |

## Findings from the first full sweep (2026-08-12)

Four real bugs, every one of them invisible at some levels and obvious at others —
which is the entire argument for sweeping instead of testing one fixture.

1. **The lead-in and goodbye lines shipped without pinyin or grounding.** (L0 only.)
   `IntroLine` rendered hanzi + English, so the very first line of a beginner's first
   session (`来，我们看几个东西。`) and the last line of every session were the only
   text on screen a rung-0 learner could not read. Now grounded server-side and
   rendered interlinear at the guided rungs.
2. **The reassurance line was computed, returned, and never displayed.** (L0, L1.) On
   a detour turn the guided UI renders `followFrame` as the bubble's interlinear, so
   `没关系，我们慢慢来。` — the single line a confused beginner most needs — never
   reached the screen. Detour replies now move their human half into the lead-in slot
   (move, not copy: copying left the same sentence in the payload twice).
3. **The rung-1 English fade blanked the glosses that mattered most.** (L1 only.)
   `fadeTokens` dropped the gloss for every token not marked `isNew`, which is right
   for a word the learner knows and wrong for the teacher's own scaffolding vocabulary
   (东西, 关系) — neither known nor introduced, and now met with no English at all. The
   fade is keyed on the known-word set instead.
4. **Production was pointed at a reasoning model.** (L2–L4.) `.env` *and* `fly.toml`
   both set `OPENROUTER_MODEL=qwen/qwen3-235b-a22b`, which answers into `reasoning` and
   returns junk in `content` — `"encoding=utf-8"`, runs of digits. Non-empty junk sailed
   past the empty-completion guard and reached the learner. Fixed twice over: a
   `plausibleCompletion` gate that falls through to Ollama, and a benchmarked switch to
   `qwen3-235b-a22b-2507` (4–6× faster, ~5× cheaper, and the only candidate that got 一
   tone sandhi right). See [openrouter.md](./openrouter.md).

After the fixes, all probes are green across all five levels. One warning remains
and is real:

**Free-rung latency.** p50 6–11s per turn, worst case 30–50s (the first turn of a
session is worst — it builds the blueprint *and* takes a model round-trip). The
guided rungs are 0–1ms because they never call a model at all. 8s is the budget and
the free rung does not meet it. Nothing here is a regression — the instruct-model
switch made it several times faster than it was — but a conversation that pauses ten
seconds before each reply is a conversation people leave. The levers, unexplored:
trim `max_tokens` (currently 400–800), cache the system prompt, or accept a smaller
model at rung 2.

Recorded, not bugs:

- Hysteresis means an advanced learner's **first** session still opens on a guided rung
  and takes 2–3 sessions to settle. The harness reports `firstRung` and
  `settleSessions` so this stays visible rather than being rediscovered.
- Beginner word selection surfaces 钱 ("money") and 好友 ("close friend", where 朋友 is
  the ordinary word). Both pass the picturable/namable filters but neither is what a
  human would teach in week one. Not fixed here — it is a `beginnerNewWords` ranking
  question, not a bug.

## Sweep 2 (2026-08-13) — after choices were removed

Four probes were added with the switch from selection to production (`no-choices`,
`model-answer`, `correction`, `strictness`), and one more bug surfaced immediately:

5. **Pinyin was classified as a stall.** (L0, L1.) `classifyIntent` treated any short
   latin string with no Chinese as a shrug, so a beginner typing `mao` — a correct
   answer, and the only input they have without an IME — was re-grounded ("let's slow
   down") and the arc did not advance. Invisible while chips existed, because nobody
   typed. `convertPinyin` now distinguishes `mao` from `ok`.

All 20 probes green across all five levels. The corrections read the way they should:
`二个人在这儿` → `两个朋友在这儿…`, `我有一个书` → `你有一本书啊，真好！`, toneless
`wo xihuan kan shu` echoed back as `我喜欢看书` — recast inside the conversation, no
grading, no rule named.
