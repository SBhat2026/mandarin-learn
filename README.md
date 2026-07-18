# 学 · Mandarin Learn

A local-first Mandarin app for **speaking and reading only** — no handwriting, stroke
order, or typing characters. It doesn't author language content; it **imports** it.
Drop in existing Anki decks and open datasets, and the app repackages them into
topic-based units, an adaptive spaced-repetition schedule, and speech practice.

Everything lives in a single SQLite database (`./data/app.db`) — nothing in browser
storage — so the whole thing can later be wrapped in Tauri.

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

- Web (Vite): http://localhost:5173
- API (Express): http://localhost:5178 (proxied under `/api` and `/media`)

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
- **Session** — due reviews first, then new words from the current unit
  - *Listening:* audio → recall meaning → reveal → grade
  - *Reading:* hanzi → say aloud + recall → reveal + audio → self-grade
  - *Speaking:* English prompt → speak → transcript vs target; match pre-selects "Good"
  - Keyboard: <kbd>space</kbd> reveals, <kbd>1</kbd>–<kbd>4</kbd> grade
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

`words` · `sentences` · `units` · `cards` (FSRS fields) · `reviews` · `dictionary` ·
`frequency` · `settings` · `enrichment_cache`. See `server/schema.sql`.

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
