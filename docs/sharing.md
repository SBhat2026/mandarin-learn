# Sharing your local app with a couple of testers

No domain, no hosting bill, no account: a **Cloudflare quick tunnel** exposes your
locally-running app as a temporary HTTPS `*.trycloudflare.com` URL. Good for handing
the app to 1–2 people to try; not a production deployment.

## One command

```bash
npm run share
```

That script (`scripts/tunnel.sh`):
1. builds the frontend,
2. starts a single-origin server on `:8787` that serves **both the app and the API**
   (so the tunnel only needs one port),
3. opens `cloudflared tunnel --url http://localhost:8787` and prints a public URL.

Send the printed `https://…trycloudflare.com` link to your tester. Ctrl-C stops the
tunnel and the shared server. Your normal `npm run dev` (ports 5173/5178) is
untouched — the share server runs on its own port.

### Prerequisite

```bash
brew install cloudflared        # macOS; see docs for other platforms
```

## What testers do

- Open the link → the **"Who's here?"** picker appears.
- They **add their own name** (up to 5 people). Everyone's progress, profile, level,
  and reviews are fully isolated per user; your own progress stays under user #1.

## Things to know (share responsibly)

- **Keep the machine awake** and `ollama serve` running — the tunnel forwards to your
  laptop; if it sleeps, the app goes down.
- **One shared Qwen**: all testers hit the same local model, so simultaneous turns
  **queue** — expect a wait if two people talk at once.
- **Your keys serve everyone**: Claude/DashScope calls bill to your keys. A basic
  **per-session cap** (`server/ratelimit.js`) limits AI calls per user and per
  instance so a tester can't run up the bill. Tune via env: `AI_CAP_PER_USER`,
  `AI_CAP_GLOBAL`, `AI_CAP_WINDOW_MS`.
- **Temporary URL**: quick-tunnel URLs change every run and aren't meant to be
  long-lived or indexed.

## Alternatives

- **ngrok** — `ngrok http 8787` (free tier gives a random HTTPS URL; needs a free account).
- **Tailscale Funnel** — if you already run Tailscale, `tailscale funnel 8787` shares
  over your tailnet-backed public URL.

## Not set up (by design)

No Railway/Render/Vercel/public cloud hosting yet — local + tunnel only for now. A
real hosted deployment (persistent URL, remote Qwen via the OpenRouter path in
`docs/openrouter.md`) is a later step. `// TODO(remote-hosting)`.
