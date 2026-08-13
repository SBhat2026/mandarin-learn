# OpenRouter path (wired but inert)

The Qwen chat layer (`server/qwen.js`) has an OpenAI-compatible **OpenRouter** backend
alongside local Ollama and Alibaba DashScope. It is **off by default** and never
called until you flip a flag — the resolution order stays **Ollama → DashScope**.

## How to turn it on

Set these in `.env`:

```
USE_OPENROUTER=true
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=qwen/qwen3-235b-a22b-2507    # MUST be an instruct model — see below
```

## ⚠️ Never point this at a reasoning model

This has cost hours twice. A reasoning/thinking model answers into `reasoning` and
leaves `content` empty **or fills it with junk** — asked for a teacher turn,
`qwen/qwen3-235b-a22b` has returned `"encoding=utf-8"` and bare runs of digits. Junk is
worse than empty: the empty-completion guard let it straight through, and it reached
the learner as a broken bubble.

Both defences now exist (`plausibleCompletion` rejects unusable text so the call falls
through to Ollama), but the real fix is picking the right model. On OpenRouter the
`-thinking`, `:thinking` and bare `qwen3-*` ids are reasoning models; `-instruct` and
`-2507` ids are not.

Benchmarked on a real Laoshi turn (the learner writes toneless pinyin
`wo you yi ge mao`; the teacher must recast with the right measure word), 3 runs each:

| model | latency | valid JSON | Mandarin |
| --- | --- | --- | --- |
| `qwen3-235b-a22b-2507` ✅ | 0.9–5.2s | 3/3 | correct 只, got 一 sandhi (`yì zhī`) right |
| `qwen3-235b-a22b` (reasoning) | 6.0–6.5s | junk under the app's own params | correct 只, sandhi wrong every run |
| `qwen3-next-80b-a3b-instruct` | 0.8s | ✅ | correct 只, sandhi wrong |
| `qwen3.5-122b-a10b` | 3.7s | ❌ a run of digits | — |
| `qwen3.5-35b-a3b` | 2.8s | ❌ empty content | — |

`qwen3-235b-a22b-2507` wins on every axis that matters — 4–6× faster than the model it
replaced, ~5× cheaper per token, 2× the context, and the only one that handled 一 tone
sandhi. It is now the default in both `.env` and `fly.toml`.

When `USE_OPENROUTER=true`, `chat()` tries OpenRouter first and still falls back to
Ollama/DashScope if the call fails, so a turn always completes. With the flag off (or
the key missing) OpenRouter code is never reached.

The activation seam is marked in code: `// TODO(openrouter): activate for remote hosting`.

## UX trade-offs vs local Ollama

- **Latency:** every turn is a network round-trip to a remote provider instead of
  local compute — expect added per-turn latency and slower first-token than a warm
  local model. In a live conversation this is felt directly.
- **Availability:** you now depend on a remote provider being up and on your account
  staying in good standing; local Ollama has no such dependency.
- **Streaming / first token:** first-token and streaming characteristics differ from
  local; if you later add token streaming, tune it against the remote path separately.
- **Cost:** you pay per token instead of using free local GPU/CPU. Fine for sharing a
  demo with a couple of testers, but it adds up under heavy use.

## When it's worth it

Mainly for **remote hosting** (no local Ollama on the serving box) or to borrow a
larger hosted Qwen than the local 9.7B for a specific test. For solo local
playtesting, local Ollama stays the better default.
