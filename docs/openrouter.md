# OpenRouter path (wired but inert)

The Qwen chat layer (`server/qwen.js`) has an OpenAI-compatible **OpenRouter** backend
alongside local Ollama and Alibaba DashScope. It is **off by default** and never
called until you flip a flag — the resolution order stays **Ollama → DashScope**.

## How to turn it on

Set these in `.env`:

```
USE_OPENROUTER=true
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=qwen/qwen-2.5-72b-instruct   # any OpenRouter-hosted model id
```

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
