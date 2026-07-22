# The Conversation Blueprint

The blueprint is the **contract** between the planner (which decides WHAT to teach)
and Laoshi (which decides the exact WORDS). The Conversation Director
(`server/director.js`) builds one blueprint per conversation from the
capability-keyed plan + the personal profile, and it is cached on the
`conversation_sessions` row so turns never re-plan.

```
Learner model + graph + profile   (state)
   → Adaptive planner              WHAT: capability, objectives, review, budget, exits
   → Conversation Director         HOW-plan: the blueprint below (Claude, or offline)
   → Laoshi executor (Qwen)        WORDS: speaks the blueprint turn-by-turn
```

Claude never talks to the learner; Qwen never decides curriculum. The educational
objectives inside the blueprint stay **hidden** — they are opportunities woven in
only when the conversation naturally invites them, never spoken as topics.

## Schema

`validateBlueprint()` coerces any Director output to exactly this shape, so the
executor and completion logic can trust it.

| Field | Type | Meaning |
| --- | --- | --- |
| `conversationGoal` | string | One plain-language aim, e.g. "chat about beautiful things in nature". Never shown. |
| `openingStrategy` | string | How Laoshi opens from a **personal hook** (a profile fact/thread). Never "what do you want to talk about?". |
| `personalConnections` | string[] | Specific hooks Laoshi may use ("you mentioned biology"). |
| `educationalOpportunities` | `{objective, vocab[], pattern, priority}[]` | **Hidden.** The educational moves; vocabulary woven in only when natural. |
| `reviewOpportunities` | string[] | Due items to resurface if the conversation allows. |
| `tone` | string | relaxed / curious / encouraging / … |
| `questionLadder` | string[] | Ordered subset of the question hierarchy (see below), preferred rungs first. |
| `steeringSuggestions` | string[] | Gentle pivots if the learner stalls. |
| `excursions` | `{kind, enterLine, exitBridge}[]` | Optional framed activities (`reading`/`tone_drill`/`rep_burst`) with in-character enter/exit lines. |
| `budget` | `{newConcepts, reviewTargets, exchanges:[min,max], learnerInitiatedQuestions}` | Soft limits that shape completion. |
| `exitStrategy` | string | How to wrap up **naturally** when conditions are met. |
| `desiredLearnerFeeling` | string | "I had an interesting conversation," not "I finished a lesson." |

## Question hierarchy (Workstream G)

`QUESTION_RUNGS = [recognition, recall, personal_experience, comparison, explanation, creation]`

The Director orders a subset into `questionLadder`; higher rungs are preferred as
capability mastery rises (`ladderForMastery`). The highest rung the learner actually
operated at is estimated post-hoc and stored in
`conversation_metrics.max_question_rung`, so planning can push toward richer
questions over time.

## Hidden lifecycle

Each turn advances an internal stage — never shown — via `conversationStage()`:

```
opening → personal_connection → explore → introduce → practice → confirm → wrap
```

The stage shifts Qwen's behavior (`executorSystem` in `server/qwen.js`): a personal
opening, then exploration, then weaving one educational opportunity, then inviting
production, then a natural close. A hidden **inline rep** may appear at the first
`practice` turn and a **framed excursion** at the first `confirm` turn.

## Completion

`liveCompletion()` (`server/momentum.js`) returns `shouldWrap` when either fires:

- **Educational** — budget exchanges met AND ≥1 spontaneous target-word use.
- **Conversational** — momentum decays below threshold, OR the exchange ceiling is
  hit, OR fatigue.

It prefers to satisfy education before wrapping, but never runs past the momentum/
budget ceiling. When `shouldWrap` fires the executor moves to the `wrap` stage and
Laoshi closes warmly — no "Lesson complete", no score.

## Offline

With no Claude key (or no credits), `buildBlueprintLocal` fills this **same** schema
deterministically from the plan + profile. See [offline-mode.md](./offline-mode.md).
