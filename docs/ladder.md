# The conversation ladder (beginner → free chat)

Free conversation is the **top** of a ladder, not the only rung. A true beginner cannot
converse into a language from zero, so guided, fully-decodable rungs sit underneath the
existing Director/blueprint free-conversation mode and fade automatically as the
learner's measured level rises.

## Rungs (`server/rung.js`)
| rung | name | generation | interlinear | new/turn | choices |
|------|------|-----------|-------------|----------|---------|
| 0 | guided | frames (`vocabguard`) | full (hanzi+pinyin+gloss) | 1 | always |
| 1 | semi | hybrid | partial (drop English gloss, keep pinyin) | 2 | offered |
| 2 | free | Director/executor (`converse.freeTurn`) | reveal (tap) | — | on request |

- **Driven by** `level.js` bands **and** a comprehension signal (`comprehensionSignal`)
  = scaffolded-choice accuracy + listen-vs-reveal behaviour, so a beginner who barely
  *produces* can still be measured and still climb.
- **Hysteresis**: at most one step per conversation; climbing requires comprehension
  holding (≥0.5); a level slip eases off immediately. `setRungOverride(0|1|2|null)` for
  tests/tuning.
- **Per-channel fade** (extra): English gloss fades before pinyin before audio.

## The hard vocabulary constraint (`server/vocabguard.js`)
- **allowed set** = known words (learner DB) ∪ this-session's introduced words ∪ a small
  rung-scaled core function-word whitelist (`CORE_RUNG0/1`).
- **Beginner generation** = controlled `FRAMES` (`这是[noun]吗？`, `我有[num]个[noun]`, …)
  whose slots are filled only from the allowed set. Deterministic, offline, immune to the
  local model garbling pinyin — Qwen is **not** on the rung-0 critical path.
- **Validation** (`validateTurn`) runs on every rung; rung-2 violations are logged
  (hidden) to watch free-chat drift.
- **Grounding** (`groundTokens`) turns any sentence into aligned per-word
  `{hanzi,pinyin,gloss,isNew}` tokens so the UI renders interlinear. A `CORE_PINYIN` floor
  guarantees grounding even when a word row lacks a reading.
- **Rung-0 word bias** (`beginnerNewWords`): noun-POS required; **picturable-first**
  (curated emoji map is the reliable signal — source concrete/topic tags are noisy);
  keeps verbs/prepositions/abstract nouns out.

## Never strand the learner (`server/intent.js`)
`classifyIntent` → `confused | stall | howdoisay | meta | normal`. Confusion re-grounds
(`regroundReply`: slow-down line + the last sentence broken word-by-word + simpler
choices) and still re-asks a frame — **always a next move, never "I don't know"**. This is
the goal-anchored / path-free / always-forward rule.

## Session arc (`server/converse.js` `guidedTurn`)
opening (micro-scene + **meet-the-words** + first frame) → frames rotating focus so each
word recurs (within-session spacing) → **recombination win** (say something new from
today's words) → wrap. Honest cross-session callback: the next session's opener reuses one
of yesterday's words (`last_session_words`), never an invented memory.

## No fabricated context (`director.js`, `qwen.js`)
Zero-profile opens from a concrete grounded scene; both the Director and the executor
carry explicit no-invented-history rules. Guarded by `test/nofabricate.test.js`.

## Tests
`test/vocabguard.test.js`, `test/ladder.test.js` (fresh-zero-user acceptance:
meet-before-use, 20-turn decodability, never-strand, rung knobs), `test/nofabricate.test.js`.

`TODO(ladder:)` — richer frame library per capability; rung-1 hybrid Qwen rephrase within
frames; smoother rung-transition telemetry.
