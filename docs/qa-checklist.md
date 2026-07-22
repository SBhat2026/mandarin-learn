# Manual QA checklist — conversational architecture

Automated coverage: `npm test` (schema/migration, capability scoring, Director
blueprint, profile, momentum/metrics, and the acceptance checks in
`test/acceptance.test.js`). The items below need a live Qwen (Ollama running) and a
browser, so verify them by hand.

## Setup
- [ ] `ollama serve` is running with a Qwen model (`ollama pull qwen3.5`).
- [ ] `npm run migrate` has been run on your `./data/app.db` (idempotent; preserves data).
- [ ] `npm run dev`, open the app, complete onboarding (pick a couple of interests).

## The §1 behavioral checklist
1. [ ] **No lesson announcements.** Nowhere in a session do you see "Today's topic",
   "New concept", target-word chips, objective lists, scores, stage names, or "Lesson
   complete".
2. [ ] **Personal opening.** Laoshi's first turn references something real about you
   (a stated interest / last thread), not "What do you want to talk about?".
3. [ ] **Vocabulary emerges.** Reading the transcript, you can't tell which words were
   "the lesson".
4. [ ] **One continuous surface.** Guided practice and free chat are the same screen
   (`/converse`). A light rep appears **inline** as a chat bubble; a heavier activity
   opens as a **framed excursion** sheet and returns with an in-character bridge line.
5. [ ] **Natural completion.** When momentum fades or the budget/education is met,
   Laoshi wraps warmly and the composer collapses to "聊到这儿 · 明天见" — no score screen.
6. [ ] **Roles hold.** Claude never addresses you; Qwen never announces curriculum.
7. [ ] **Capability-driven.** Over several sessions the conversations move through
   capabilities (greet → describe → narrate → opine); `npm run dump:plan` shows the
   current capability + hidden objectives.
8. [ ] **Remembers you.** Mention a durable fact (e.g. "我学生物" / "I study biology");
   a later session's opening or examples reflect it. (Rich extraction needs a funded
   Claude key; the offline heuristic mines English self-statements.)
9. [ ] **Better metrics (hidden).** After a conversation, `conversation_metrics` has a
   new row (`sqlite3 data/app.db "SELECT * FROM conversation_metrics ORDER BY created DESC LIMIT 1"`).
10. [ ] **Offline.** With `ANTHROPIC_API_KEY` unset (or unfunded), a full conversation
    still runs coherently via the offline Director + local Qwen.

## Word help
- [ ] Tapping a character in a teacher bubble opens a small popover (audio + gloss).
- [ ] Tapping a teacher bubble speaks the whole line.

## Regression guard
- [ ] `npm test` is green (ingest, pronunciation, and the new suites).
- [ ] Reading, Tones, and Progress screens still work and are reachable but secondary.
- [ ] With Ollama stopped, `/converse` falls back to the flashcard exercise flow.
