# Offline mode

Mandarin Learn is **local-first**. Every AI-assisted feature degrades to a working
non-AI path, so the whole app runs with **no Anthropic key** and only a local Qwen
model (Ollama) — or, for the invisible planning passes, no model at all.

The invisible reasoner (Claude) is optional. When `ANTHROPIC_API_KEY` is unset —
**or the key has no credits / the API is unreachable** — these features silently use
their fallbacks:

| Feature | With Claude | Offline fallback |
| --- | --- | --- |
| Conversation Director (`director.js`) | `buildBlueprintClaude` — a nuanced, profile-aware blueprint | `buildBlueprintLocal` — deterministic template fill from plan + profile + capability |
| Profile harvest (`profile.js`) | LLM extraction of durable facts/threads | heuristic regex mining of the learner's English self-statements |
| Understanding refinement (`reasoner.js`) | per-word 0..1 estimate | heuristic signals from the transcript only |
| Capability enrichment (`seed-capabilities.js`) | Claude proposes extra topic refs | hand-curated deterministic catalog |
| Comprehensible examples, misconception analysis | generated | skipped (no regression to core review) |

The **teacher (Laoshi) always runs on local Qwen** via Ollama (`qwen3.5:latest`),
falling back to Alibaba DashScope only if Ollama is down and `DASHSCOPE_API_KEY` is
set. Claude never speaks to the learner, so a missing/credit-less Claude key never
changes what the learner hears — only how richly the hidden plan is authored.

## What the offline Director does today

`buildBlueprintLocal(plan, ctx)` fills the **same** blueprint schema as the Claude
path (validated by `validateBlueprint`). It:

- opens from a **personal hook** — an open thread, else a stated interest, else a
  warm everyday opener (never "what do you want to talk about?");
- carries the capability's hidden educational opportunities forward verbatim;
- orders the question ladder by capability mastery;
- sets a conservative budget (1 new concept, a couple of reviews, 4–8 exchanges);
- keeps to pure conversation (no framed excursions) for predictability.

## What a fuller offline Director would add

`TODO(offline:)` — richen `buildBlueprintLocal` with a **local Qwen planning pass**:
have Qwen (not Claude) draft the opening line and steering pivots from the profile,
propose one optional excursion when the capability warrants it (e.g. a short reading
for a narrative capability), and vary tone/goal phrasing so repeated offline sessions
feel less templated. The seam is already there: `buildBlueprint` dispatches on
`hasApiKey()`, and the local builder is a pure function of `(plan, ctx)` — a Qwen
pass can slot in behind the same signature.
