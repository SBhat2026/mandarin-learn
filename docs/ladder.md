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

## Vocab-graph conversation continuity (`server/graphwalk.js`)
A real conversation drifts through related ideas. `graphNeighbors` / `nextConcepts` walk
the 83k-edge graph (sentence co-occurrence > collocation > topic > shared character) from
the words in play to the most natural next concept, preferring comprehensible *reuse* over
*growth*. Used three ways, all hidden:
- **Guided** — `connectedBeginnerCluster` seeds meet-words that are graph-connected (each
  reinforces the last) while staying picturable/decodable.
- **Free** — `graphSteer` gives the executor a soft "you could drift toward X" nudge;
  `conversationMemory` (what the learner actually said) lets Laoshi refer back.
- **Across sessions** — a new guided session grows OUTWARD from a graph-neighbour of last
  time's word (honest callback, real relationship).
`test/graphwalk.test.js`.

## Human-like Laoshi (`qwen.js` executor)
Backchannels (嗯、真的？、我也是), reacting to feeling not just words, not quizzing every
turn, letting topics wander — layered on the comprehensible-input rules. Model tiers:
FAST = Haiku, RICH = Sonnet (`claude-sonnet-5`), per-user toggle.

## No fabricated context (`director.js`, `qwen.js`)
Zero-profile opens from a concrete grounded scene; both the Director and the executor
carry explicit no-invented-history rules. Guarded by `test/nofabricate.test.js`.

## Tests
`test/vocabguard.test.js`, `test/ladder.test.js` (fresh-zero-user acceptance:
meet-before-use, 20-turn decodability, never-strand, rung knobs), `test/nofabricate.test.js`.

`TODO(ladder:)` — richer frame library per capability; rung-1 hybrid Qwen rephrase within
frames; smoother rung-transition telemetry.

---

## 2026-08-12 — the ARC, semantic frames, and an ending

Three related problems showed up in real use: a guided session talked about the same
one or two nouns for its whole length, some of what it said was nonsense ("how many
senior high schools do you have?", "how many suns do you have?"), and it never
really *finished* — it stopped when a turn counter ran out.

None of it was Qwen. At rungs 0/1 the model is not called at all: those turns are
built from `vocabguard` frames. The three causes were structural.

**1. Frames now have SEMANTICS (`vocabguard.js`).** Every noun gets a coarse
`nounCategory()` — object / creature / person / food / drink / place / nature /
plant / body — derived from the curated emoji-keyword map plus gloss keywords. Every
frame declares which categories it `fits`. Places get 去/在 frames, weather gets
今天有…吗, food gets 喜欢吃, and 有/几个 is restricted to things you can actually own
and count. `pickFrame` also excludes frames the session already used, so a word is
never asked about the same way twice.
Rung 0's core whitelist gained the everyday HSK-1 verbs (喜欢/在/去/吃/喝/看/想) —
without them rung 0 could only say 是/有/几个, which is what forced the repetition.

**2. A session is an ARC, not a carousel (`converse.js`).**
`meet → identify → relate → grow → use → combine → win → farewell`. The `grow` beat
introduces a NEW word mid-conversation (graph-connected, not a synonym and not
sharing a character with anything in play — `tooSimilar`), so the talk travels. A
detour (confusion, "how do I say…", English meta) does not consume a beat, but three
in a row advances anyway, so nobody gets stuck. **The arc reaching its end IS the
ending** — that is what makes the close feel earned rather than abrupt.

**3. Endings are guaranteed, and the learner can ask for one.**
- Guided: the `farewell` beat names what was actually met today and leaves one
  concrete thread for next time. Deterministic — no model needed.
- Free (rung 2): the final line is built in CODE (`freeFallbackTurn`/`freeFarewell`),
  not requested from the model, which used to answer "close for real" by opening a new
  topic. Plus a hard `FREE_CEILING` independent of the blueprint budget.
- Both: `forceWrap` on `/api/conversation/turn` — the "聊到这儿 · wrap up" button.

**Anti-fixation at the free rung.** What the teacher has already been about is tracked
per conversation (`topics:<id>`) and fed back as a "do not re-litigate these" directive
plus one adjacent concept from the graph. Exactly ONE regeneration slot per turn covers
both this and the comprehensible-input repair — stacking two retries is how a turn
ended up taking three minutes on a local model.

**Word/gloss quality.** `namableGloss` rejects dictionary definitions posing as words
("house with more than 1"), and `cleanShort` now picks the sense a LEARNER wants rather
than the first one CEDICT lists (城 → city, not "city walls"; 猪 → pig, not "hog").

**Backend robustness (`qwen.js`).** An empty completion is now treated as a failure and
falls through to the next backend instead of reaching the UI as a blank bubble. Ollama
gets `num_ctx` (its 4096 default truncated the executor prompt); OpenRouter is bounded
by a timeout, asks for `reasoning.exclude`, and reads `reasoning` if a thinking model
still answers there.

## The entrance exam (`server/placement.js`, `src/pages/Placement.jsx`)
Optional and skippable. It runs through the conversation surface — teacher bubbles,
interlinear grounding, tap-to-answer chips — escalating through six levels
(recognize → frame comprehension → sentence comprehension → open production) and
stopping after two consecutive misses, so nobody is marched through questions they
can't read. Probes are generated from real content (word/sentence tables + the same
frames the guided rung speaks), never a hand-written syllabus, and the answer key is
never serialized to the client. The result sets `rung_state`, seeds the level
estimates the planner reads, and marks the path already behind the learner —
replacing onboarding's old "how many units do you already know?" self-report.
Skipping is a first-class outcome: rung 0, nothing lost. `test/placement.test.js`.

## Home (`src/pages/Home.jsx`)
Two forward tracks — 说 Speak and 读 Read — each phrased as the next thing to do, with
the words a session will pick back up from. The numbered unit path is gone: showing a
ladder of levels made the first thing you saw every day be how far you still had to go.
