# The Read track — orthographic acceleration

Speaking got the ladder, the arc, and an ending. Reading had a story generator and a
dictionary popover, and nothing underneath them: characters were treated as a few
thousand unrelated pictures, and "how am I doing" was answered in words-met. This is
the engine that closes that gap (`server/orthography.js`).

Everything here is derived from data already in the DB — `char_meta`'s
decomposition / radical / phonetic plus the word list. Nothing is hand-authored, in
keeping with the rest of the app.

## The claims it is built on

- **Consistency beats regularity.** What predicts whether a learner can guess a new
  character's reading is not "does this character sound like its phonetic component"
  but "do the characters sharing this component agree with each other" (Lee et al.;
  Ho & Bryant). Only ~38% of characters are strictly regular, so the nominal
  `phonetic` field is a weak signal. We **measure** consistency instead: 方 → fāng
  holds for 仿妨房放纺肪芳访防 (9/9, consistency 1.0), while 一 as a "phonetic"
  predicts nothing and is therefore never taught as a rule.
- **Self-teaching.** A learner who predicts a reading and then has it confirmed
  acquires the character far faster than one who is told (Shu et al.). So the move is
  *predict, then check* — never "here is a fact".
- **Semantic radicals let meaning be inferred** for unseen characters in context
  (Wang et al.). Explicit radical instruction *hurts* 1–3 day retention and *helps*
  at 4+ days, so radicals are offered as an inference, never judged on immediate
  recall.
- **Coverage governs comprehension** — ~95% of tokens known for reasonable
  comprehension, ~98% for comfortable (Laufer; Hu & Nation). In Chinese the top 1,000
  characters cover ~90% of running text. Coverage, not a syllabus position, is what
  decides whether a page is readable.

## What it powers

**Tap a character (`/api/reading/char` → `characterInsight`).** The sound question is
asked **before** it is answered: "you already know 房、放 — what do you think this
sounds like?" → reveal → the family, the measured consistency, and whether the
prediction held here. A prediction is only offered when the learner has met something
in the series; with nothing to reason from, the popover degrades to the plain
dictionary rather than inventing a mnemonic. The semantic radical is shown as a
narrowing ("氵 means water, so this is likely something to do with that") alongside
the family members already met.

**An honest readout (`/api/reading/profile` → `readingProfile`).** Characters met,
estimated coverage of everyday text, the band it falls in, and how many more
characters it would take to read freely. Surfaced on Reading and on Home's 读 card.
Not a level, not a percentage of a syllabus.

**High-yield characters (`highYieldCharacters`).** Not "the next most frequent
character" but the one that makes the **most** other characters guessable. Learning 方
buys nine characters' worth of reading; an equally frequent isolated character buys
one. Value = unlocks × consistency, tempered by how soon the key itself is met. Keys
the learner already holds are excluded.

**Coverage-graded passages (`server/reading.js`).** The old gate demanded every word
be in review state — a word-level gate on a character-level skill, which rejected
exactly the sentences worth reading. Now: a sentence is admitted on *at most one
character you haven't met*, and the 90% floor applies to the **passage**, because
coverage is a running-text measure (one unknown character in a four-character
sentence scores 75% while being a perfectly good line to read). Passages open with a
fully-known warm-up group and then deliberately climb into the ~95% band, where
characters are actually acquired from context. Unmet characters are marked with a
dotted underline — the signal to read *past* them.

**Story stretch words (`server/stories.js`).** Among candidates the planner considers
roughly equivalent, prefer the one that pays orthographically (`orthographicYield`).
The planner's comprehensibility ranking still dominates — this only breaks near-ties.
Generated stories are graded (`gradeStory`) against known characters ∪ the story's own
glossed new words, so `coverage` / `band` describe whether the *rest* of it is
readable.

## Tests
`test/orthography.test.js` — measured-vs-assumed consistency, prediction only with
evidence, radical sense and family, coverage banding, insight ordering, high-yield
ranking, toneless folding.

`TODO(reading:)` — feed high-yield keys back into `planner.newCandidates` (currently
only story stretch words see them); track predictions the learner actually got right
as a self-teaching signal; some source sentences carry stray spaces around characters
(content-data noise, visible in passage output).
