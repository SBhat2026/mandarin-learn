# 学 · Mandarin Learn

**▶ Live demo:** https://sbhat2026.github.io/mandarin-learn/ — a read-only preview on
GitHub Pages (baked data snapshot, no backend; reviews don't persist, audio uses the
browser voice). The full app runs locally with the Node/SQLite backend below.

A local-first Mandarin app for **speaking and reading only** — no handwriting, stroke
order, or typing characters. It doesn't author language content; it **imports** it.
It is not a flashcard app: it is an **intelligent curriculum generator and adaptive
teacher**. It ingests existing Anki decks + open datasets and turns them into a
knowledge graph, then continuously infers a hidden learner model to decide what to
teach and test next — maximizing usable Mandarin per hour of study.

Everything lives in a single SQLite database (`./data/app.db`) — nothing in browser
storage — so the whole thing can later be wrapped in Tauri.

### The adaptive engine (how it thinks)

- **Knowledge graph, not isolated cards.** `ingest:graph` links words + characters by
  shared characters, radical families (semantic), phonetic series (sound), visual
  confusion, collocations, topics, and sentence dependencies. Teaching order, new-word
  selection, and family teaching all read these edges.
- **Six-dimensional mastery.** Each word tracks independent sub-scores for *meaning,
  reading, listening, pronunciation, spoken usage,* and *sentence comprehension*. A
  single FSRS "memory" card schedules **when** a word returns; the weakest unlocked
  dimension decides **which** exercise to show. Reviews are generated dynamically
  (recognition / listening / pronunciation / reading / cloze / production).
- **Continuous acquisition stages** (first-exposure → familiar → recall → functional →
  automatic), never a binary known/unknown.
- **Concrete-first, comprehensible input.** New words are ranked by frequency +
  concreteness + how many of their characters/families the learner already knows. Bare
  grammar particles (的, 了, 吗…) are taught **in context** (cloze), never as isolated
  cards. Character families (radical + phonetic series) are taught together so learning
  one character transfers to many.
- **Hidden learner model.** The learner never sees scores or diagnostics. `server/learner.js`
  silently infers ability per dimension, learning rate, forgetting rate, confidence
  calibration, tone tendencies, and modality preference from observed behavior.
- **Two models, clear roles.** *Laoshi* (Qwen, local via Ollama with a DashScope
  fallback) is the **visible teacher** — it converses within your known vocabulary,
  corrects gently, and keeps you talking. *Claude* is the **invisible engine**
  (`server/reasoner.js`): it analyzes behavior, generates comprehensible examples,
  flags misconceptions, and tunes scheduling to a time budget. The learner talks only
  to Laoshi.

### The conversational architecture (how it teaches)

A study session should feel like **continuing a relationship with a teacher**, not
starting a lesson. Educational objectives never surface — no "Today's topic", no
target-word chips, no scores. The pipeline that makes this work:

```
Learner model + graph + personal profile   (state)
   → Adaptive planner   (capabilities)   WHAT: an expressive capability + hidden objectives
   → Conversation Director  (Claude/offline)  HOW-plan: a hidden Conversation Blueprint
   → Laoshi executor  (Qwen)                   WORDS: speaks the blueprint turn-by-turn
   → Unified conversation surface  (React)     one thread; inline reps; framed excursions
   → Post-hoc inference  (extends conversation.js)  understanding, capability demos, profile, metrics
```

- **Capabilities, not word lists.** Lessons are planned around what the learner can
  *do* — "describe a living thing", "talk about a past action" (`server/capabilities.js`,
  `ingest/seed-capabilities.js`). Vocabulary is selected as the means to a capability.
- **A planning-to-conversation bridge.** The **Director** (`server/director.js`) turns
  the capability plan + a durable **personal profile** (`server/profile.js`) into a
  hidden [Conversation Blueprint](docs/conversation-blueprint.md): a personal opening
  hook, educational opportunities to weave in only when natural, a question ladder, a
  budget, and a natural exit. Qwen performs the blueprint; it never sees a raw vocab list.
- **One continuous surface.** The guided lesson and free chat are the same screen
  (`src/pages/Converse.jsx`). Light reps appear inline as chat bubbles; heavier
  activities open as in-character framed excursions.
- **Hidden lifecycle + natural completion.** Each conversation runs through hidden
  stages and ends when momentum decays or the budget/education is satisfied
  (`server/momentum.js`) — wrapping up warmly, never with "Lesson complete".
- **Remembers you across sessions.** Durable personal facts + open threads are harvested
  from conversation and used to personalize future openings and examples — all local.
- **Degrades gracefully offline.** With no Claude key (or no credits) the Director,
  profile harvest, and understanding refinement all use working fallbacks; Laoshi still
  runs on local Qwen. See [docs/offline-mode.md](docs/offline-mode.md).

---

## Stack

- **Frontend:** React + Vite + Tailwind CSS
- **Backend:** Node + Express, SQLite via `better-sqlite3`
- **Scheduling:** `ts-fsrs` (FSRS, desired retention 0.88)
- **Speech:** Web Speech API — `speechSynthesis` (`zh-CN`) for TTS fallback,
  `SpeechRecognition` (`lang: "zh-CN"`) for speaking checks, with graceful
  listen-and-repeat + self-grade fallback when unsupported
- **Anthropic API:** used *sparingly* for content enrichment (topic tagging, grammar
  patterns, leech examples). **Never required for the core review flow** — the pipeline
  falls back to an offline keyword tagger when no key is set.

---

## Setup

```bash
npm install
cp .env.example .env        # optional: add ANTHROPIC_API_KEY for enrichment
npm run db:init             # create the SQLite schema
```

### Browser requirements

Speaking cards use `SpeechRecognition`, which today means **Chrome or Edge**. In other
browsers speaking cards degrade to *listen-and-repeat + self-grade* automatically, and
TTS (`speechSynthesis`) still works. Native imported audio is preferred everywhere; TTS
is only a fallback.

### API key

The Anthropic key is read from `.env` (`ANTHROPIC_API_KEY`). It is only used by:
- the enrichment pass (topic tags + sentence grammar patterns),
- leech handling (fresh example sentences after 4+ lapses).

Without a key, topic tags come from a built-in keyword tagger and leech/pattern steps
are skipped — the app is fully usable offline.

---

## Quick start with open data (recommended)

The fastest way to a fully-populated app uses only openly-licensed datasets — no
manual deck hunting:

```bash
npm run db:init
npm run data:fetch        # downloads CC-CEDICT + HSK vocab + Tatoeba sentences, packages decks
npm run ingest:all        # import → dictionary → frequency → enrich → build units
npm run dev
```

`data:fetch` pulls:
- **CC-CEDICT** (CC BY-SA 4.0, MDBG) → `cedict_ts.u8`
- **complete-hsk-vocabulary** (MIT, [drkameleon](https://github.com/drkameleon/complete-hsk-vocabulary)) → packaged into `hsk-vocab.apkg` (11k+ words with pinyin, meanings, frequency)
- **Tatoeba cmn-eng sentence pairs** (CC BY 2.0 FR, via manythings.org) → packaged into `tatoeba-sentences.apkg` (6k beginner-first sentences)
- a frequency CSV derived from the HSK corpus ranks

The packaging step (`ingest/tools/build-open-decks.js`) builds real `.apkg` files
from the raw datasets, so the standard import pipeline is exercised exactly as it
would be on decks you download yourself.

> These datasets are downloaded at build time and are **gitignored** — they are not
> redistributed with this repository. Respect each source's license and attribution.

## Or: bring your own decks

### 1. Download decks yourself and drop them in `./ingest/sources/`

Recommended:
- **Spoonfed Chinese** (sentences) — for the reading passages and sentence cards
- an **HSK 1–6 vocabulary** deck (words)

Also place, in `./ingest/sources/`:
- **CC-CEDICT** dictionary file (`cedict_ts.u8`) — for tap-to-lookup
- a **SUBTLEX-CH**–style frequency CSV/TSV (a `word` column + a frequency/count column)

> ⚠️ **Personal use only.** Shared Anki decks and CC-CEDICT are for your own study.
> Don't redistribute them bundled with this app. `ingest/sources/` and `data/` are
> gitignored for this reason.

### 2. Run the ingest pipeline

```bash
npm run ingest:all -- --topics food,travel,family
```

That runs, in order:

| step | script | what it does |
|------|--------|--------------|
| 1 | `ingest:apkg`   | parse every `.apkg`, auto-detect field layouts, extract hanzi/pinyin/English/audio, copy audio into `./data/media`, normalize into `words`/`sentences` |
| 2 | `ingest:cedict` | parse CC-CEDICT into the `dictionary` table |
| 3 | `ingest:freq`   | load frequency data into `frequency(word, rank)` |
| 4 | `ingest:enrich` | tag each word with 1–2 topics from a fixed 25-topic taxonomy (Anthropic, cached + resumable) and flag Spoonfed sentences with a grammar pattern |
| 5 | `ingest:units`  | build ~20-word Duolingo-style units: frequency-first, boosted for your interest topics, named after each unit's dominant topic; attach sentences to units |

Run steps individually if you prefer, e.g.:

```bash
npm run ingest:apkg                      # or: node ingest/import-apkg.js path/to/deck.apkg --type sentence --source Spoonfed
npm run ingest:cedict
npm run ingest:freq
npm run ingest:enrich -- --sentences
npm run ingest:units -- --topics food,travel
npm run dump:units                       # CLI sanity dump of the built units
```

**Field mapping:** the `.apkg` importer auto-detects which field is hanzi / pinyin /
English / audio and prints its guess. When it can't tell, it drops into a small
interactive prompt so you can map fields by index. Pass `--yes` to accept all guesses
non-interactively.

---

## Running the app

```bash
npm run dev
```

- **Web (Vite): http://localhost:5173** ← open this
- API (Express): http://localhost:5178 (proxied under `/api` and `/media`; opening it in a
  browser just redirects to the app)

On load you pick a **user** ("who's here?" — up to 5 people, no auth; each has fully
isolated progress). A header **gear** toggles the invisible-pass model (Haiku ⇄ Sonnet) for
playtesting; a **chip** switches person.

### Checking it still teaches — the level sweep

```bash
npm run diagnose            # drives a whole session as 5 learners, beginner → advanced
npm run diagnose -- --levels 0,4
```

Nearly every bug this app has shipped was a **level** bug: correct for one learner and
broken for another. The sweep seeds five learners, drives a real session for each, and
runs the same probes across all of them — decodability, semantic sanity, arc
completion, never-strand, reading coverage. Non-zero exit on any failure, so it works
as a pre-deploy gate. See [docs/diagnostics.md](docs/diagnostics.md).

### The learner produces; Laoshi corrects

There are no tap-to-answer choices. Picking `这是猫` from three glossed chips is
recognition wearing production's clothes — a learner could finish a whole session
without composing a sentence. Instead they type or speak (pinyin, characters, or the
pinyin IME), a model sentence is available only on request, and every turn is graded by
`server/correction.js`: tones, script, measure words, `是`+adjective, `二` vs `两`.

Strictness rises with level — that is the point. A beginner typing `mao` has done
something real and is left alone; at the top band the same answer is corrected to 猫,
because letting it pass is how someone ends up fluent in pinyin and illiterate in
Chinese. See the strictness table in [docs/ladder.md](docs/ladder.md).

### Tuning how Laoshi teaches Mandarin

`server/mandarin.md` is the editable half of Laoshi's prompt: tones, measure words,
aspect particles, and the errors English speakers make — gated by the learner's
measured band and read at runtime. The conversational rules (who Laoshi is, turn shape,
the JSON contract) stay in `server/qwen.js`. Edit the markdown, not the JavaScript.

### Sharing with a couple of testers

```bash
npm run share      # builds, serves app+api on one port, opens a Cloudflare quick tunnel
```

Prints a public `https://…trycloudflare.com` URL. See [docs/sharing.md](docs/sharing.md)
(needs `cloudflared`; a per-session cap protects your keys; testers pick their own user).

First launch sends you through **onboarding**: pick 2–3 interest topics, do a mic check,
and choose a starting point (true beginner → Unit 1, or "I know some" → mark the first N
units' words as known). Finishing onboarding **rebuilds the unit path server-side** so
your interest topics immediately reshape the ordering — no CLI step needed. (You can still
rebuild manually any time with `npm run ingest:units -- --topics food,travel`.)

Units with no clear theme — typically the highest-frequency function words — are named
**Essentials / Core N** rather than forcing a noisy topic label onto them.

---

## Screens

- **Home** — Duolingo-style vertical unit map, due/new counts, streak
- **Practice** — a conversation-driven concept-acquisition loop, not a flashcard queue:
  1. **Meet** one focal concept — pronunciation + meaning + pinyin first, hanzi secondary.
  2. **See how it connects** — instructional character families: what the shared *radical
     means* (semantic), what the *phonetic component sounds like*, and look-alikes to keep
     apart. Transferable patterns, not metadata.
  3. **Talk with Laoshi** — the focal word and its graph neighborhood (collocations, due
     reviews, related characters) are woven into a live conversation; target words light up
     as they're used.
  4. **Connections formed** — understanding is *inferred from the dialogue* (no grade
     buttons), review is scheduled, and the conversation's own sentences become that word's
     examples. Script emphasis (pinyin↔hanzi) adapts continuously to reading level, per word.

  Falls back to the flashcard/teach-then-test exercise flow when no teacher model is available.
- **Laoshi** — free-form conversational practice with the Qwen teacher, constrained to your
  known vocabulary (comprehensible input), tone-colored replies, audio, gentle corrections.
- **Tone trainer** — minimal-pair drills from imported audio, per-tone stats
- **Reading** — sentences from your completed units as read-aloud passages; tap a word
  for a CC-CEDICT popover, tap a sentence to hear it
- **Stats** — retention curve, current adaptive rate + *why*, words by state, weakest
  words, per-tone accuracy

---

## The adaptive scheduler

- **FSRS** with desired retention **0.88**.
- **New-card throttle**, re-evaluated weekly and shown transparently on Stats:
  - retention ≥ 90% **and** avg daily review time < 15 min → **+20%** (cap 35)
  - retention 84–90% → **hold**
  - retention < 84% **or** backlog > 1.5× daily average → **−30%** (floor 4)
  - starting value **10/day**
- **Leech handling:** a card lapsing 4+ times triggers 2 fresh example sentences built
  only from already-learned vocabulary (new context instead of brute repetition).
- **Weak-tone injection:** if per-tone accuracy from speaking cards shows a weak tone, a
  2-minute minimal-pair drill is prepended to the next session.
- **Unit flow:** a unit completes at 80% of its words in FSRS "review" state, which
  unlocks the next unit. Sentence cards unlock once all their words reach "review".

---

## Data model (SQLite)

`words` · `sentences` · `units` · `cards` (single FSRS "memory" track per item) ·
`reviews` · `review_dims` · `dictionary` · `frequency` · `settings` ·
`enrichment_cache`. Adaptive engine tables: `char_meta` (decomposition, radical,
phonetic) · `graph_edges` (knowledge graph) · `word_mastery` (6 dimensions) ·
`acquisition` (stage) · `learner_model` (hidden, inferred) · `dim_retention`
(per-dimension FSRS targets). See `server/schema.sql`.

**Qwen / Laoshi setup.** Laoshi uses a local Qwen model via [Ollama](https://ollama.com):
`ollama pull qwen3.5` (override with `QWEN_MODEL`, default `qwen3.5:latest`). With no
local model it falls back to Alibaba DashScope if `DASHSCOPE_API_KEY` is set. The core
review flow never needs either.

---

## Tests

```bash
npm test
```

Unit + integration tests for the ingest pipeline run against a generated fixture deck
(`test/make-fixture.js`) — a tiny `.apkg`, a CC-CEDICT sample, and a frequency CSV — in
an isolated temp database. They cover pinyin/tone conversion, field auto-detection,
`.apkg` parsing + media extraction, and the full import → dictionary → frequency →
unit-build path including sentence segmentation.

---

## Project layout

```
ingest/            CLI import pipeline (apkg, cedict, frequency, enrich, build-units)
  sources/         ← downloaded decks + datasets go here (gitignored)
  tools/           open-data fetch + .apkg packaging (fetch-open-data.sh, build-open-decks.js)
server/            Express API, SQLite, FSRS, scheduler, units, tone/leech/stats logic
src/               React app (pages: Home, Session, ToneTrainer, Reading, Stats, Onboarding)
data/              app.db + extracted media (gitignored)
scripts/           db:init / db:reset
test/              fixtures + tests
```

---

## Deploying the demo (GitHub Pages)

The Pages build is a **static, read-only** snapshot — Pages can't run the Express/SQLite
backend. With a populated `data/app.db`:

```bash
npm run deploy:pages     # exports a JSON snapshot, builds with base=/mandarin-learn/,
                         # pushes dist/ to the gh-pages branch
```

`scripts/export-static.js` bakes the snapshot (`public/demo/*.json`); the client
(`src/lib/api.js`) reads it when built with `VITE_STATIC=1` and treats reviews as local
no-ops. Enable Pages once (Settings → Pages → branch `gh-pages`).

---

## Credits & licenses

The app code is MIT-licensed. Content is **not** bundled; it is downloaded at build
time from these sources, each under its own license — attribute accordingly:

- **CC-CEDICT** — Chinese-English dictionary, © MDBG, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- **complete-hsk-vocabulary** — HSK 1–7 word lists, © Yanis Zafirópulos, MIT
- **Tatoeba** — example sentences, [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/); sentence pairs repackaged by [manythings.org/anki](https://www.manythings.org/anki/)

Shared/commercial Anki decks (e.g. paid Spoonfed Chinese) are for personal study and
should not be redistributed with the app.

The `.apkg` format handling was informed by the [Anki](https://github.com/ankitects/anki)
package format (SQLite `collection.anki2/anki21` + `\x1f`-separated note fields + a JSON
`media` map). This importer targets that classic/genanki layout.
