# Deploy to Cloudflare

The deployment is one Cloudflare Worker with Static Assets:

```
                    https://avatar.example.com
                              │
              ┌───────────────┴────────────────┐
              │                                │
        GET /* (assets)              POST /api/turn · /api/transcribe
              │                                │
      dist/ (client + .avtr)     Worker: (STT) → LLM → TTS → audio→frames
                                               │
                                        SSE (tokens + inlined WAV)
                                               │
                                         browser renders
```

There is no build server, no database, and no R2/KV bucket. The Worker holds the
provider keys; the browser gets only text, audio, and blendshape frames. The
`/api/turn` response is SSE; each `segment` event carries `audioBase64` and
`framesData` instead of `/media/<id>` URLs because isolates do not share memory.
`/api/transcribe` is a plain JSON endpoint: one recorded utterance in, text out.

Workers Static Assets is used instead of Cloudflare Pages: Cloudflare now
recommends Workers for new full-stack projects, and a Worker + assets binding is
one deploy target with the same static-site behaviour and a real backend.

## One-time setup

### 1. Cloudflare API token and account ID

In the Cloudflare dashboard:

1. **My Profile → API Tokens → Create Token**.
2. Start from the **Edit Cloudflare Workers** template.
3. Permissions:
   - Account → **Workers Scripts: Edit** (required)
   - Account → **Account Settings: Read** (required by Wrangler)
   - Zone → **Workers Routes: Edit** and Zone → **DNS: Edit** only if you use a
     custom domain in `wrangler.toml`.
4. Scope it to the one account (and zone, if any).
5. Copy the token and the **Account ID** from the dashboard sidebar.

Set both in GitHub:

```bash
gh secret set CF_API_TOKEN
gh secret set CF_ACCOUNT_ID
```

`CF_API_TOKEN` and `CF_ACCOUNT_ID` are the only secrets the
workflow requires. It fails early with a clear message if either is missing.
The workflow maps them to the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` environment variables that Wrangler reads.

### 2. Provider keys

Set the keys for the providers you actually use. Any that are unset are skipped;
the app falls back to the stub LLM / synthetic babble, so the first deploy still
works without them.

```bash
gh secret set DEEPSEEK_API_KEY
gh secret set ELEVENLABS_API_KEY
gh secret set ELEVENLABS_VOICE_ID      # optional; defaults to Rachel

# Or, instead of DeepSeek:
# gh secret set OPENAI_API_KEY
# gh secret set ANTHROPIC_API_KEY
```

| GitHub secret | Worker secret | Used for |
|---|---|---|
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | DeepSeek chat |
| `OPENAI_API_KEY` | `OPENAI_API_KEY` | OpenAI or any compatible endpoint |
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Anthropic Messages |
| `ELEVENLABS_API_KEY` | `ELEVENLABS_API_KEY` | ElevenLabs TTS **and speech-to-text** |
| `ELEVENLABS_VOICE_ID` | `ELEVENLABS_VOICE_ID` | choosing a voice |
| `CF_API_TOKEN` | — | deploying |
| `CF_ACCOUNT_ID` | — | deploying |

`ELEVENLABS_API_KEY` powers both directions, but the key needs both permissions:
`text_to_speech` for the avatar's voice and **`speech_to_text`** for the
microphone. A key created for TTS only is enough to make the avatar talk and not
enough to make it listen; the first recording returns a 401 naming the missing
permission. Enable it on the existing key, or use `OPENAI_API_KEY` for voice input
(`STT_PROVIDER=openai`) and keep the ElevenLabs key for TTS.

Provider selection on the Worker is the same as local: an explicit
`LLM_PROVIDER` / `STT_PROVIDER` / `TTS_PROVIDER` wins, otherwise the first
available key selects the provider. On Linux/Workers there is no macOS `say`, so
no ElevenLabs key means synthetic babble.

### 3. Optional non-secret configuration

These are GitHub **variables**, not secrets:

```bash
gh variable set LLM_PROVIDER --body deepseek
gh variable set LLM_MODEL --body deepseek-chat
gh variable set TTS_PROVIDER --body elevenlabs
gh variable set ELEVENLABS_MODEL_ID --body eleven_multilingual_v2
gh variable set ELEVENLABS_OUTPUT_FORMAT --body pcm_22050
gh variable set TTS_CACHE_SIZE --body 32

# Voice input, all optional:
gh variable set STT_PROVIDER --body elevenlabs   # or openai, or none
gh variable set STT_LANGUAGE --body en           # unset = auto-detect
gh variable set ELEVENLABS_STT_MODEL --body scribe_v2
```

`ELEVENLABS_OUTPUT_FORMAT` must be raw PCM (`pcm_16000`, `pcm_22050`,
`pcm_24000`, …); there is no MP3 decoder in the pipeline. `LLM_PROVIDER` is
worth setting if the account has more than one LLM key: without it, OpenAI is
chosen before DeepSeek.

The workflow pushes these as Worker secrets too. Removing a GitHub variable does
not delete an existing Worker secret; remove it explicitly with:

```bash
npx wrangler secret delete NAME
```

### 4. Deploy

```bash
git push origin main
```

The workflow `.github/workflows/deploy.yml`:

1. checks that the two Cloudflare secrets exist,
2. runs `npm test` (provider contracts + turn pipeline + Worker routing/SSE),
3. runs `npm run build:web` to create `dist/`,
4. installs Wrangler at a pinned version and runs `wrangler deploy`,
5. pushes the configured provider keys and variables with `wrangler secret put`.

You can also run it manually from **Actions → Deploy to Cloudflare → Run
workflow** (`workflow_dispatch`).

The Worker name is `realtime-avatar` in `wrangler.toml`; change it first if that
name is already taken in the account. The deploy prints the URL, normally:

```
https://realtime-avatar.<your-subdomain>.workers.dev
```

If the account has no `workers.dev` subdomain yet, register one under
**Workers & Pages → Your Worker → Settings → Domains & Routes**, or use a custom
domain instead.

## Verify

```bash
curl -s https://realtime-avatar.<your-subdomain>.workers.dev/api/health | jq
```

The response includes the resolved providers but never the keys:

```json
{
  "ok": true,
  "tts": { "provider": "elevenlabs", "available": true, "voiceId": "..." },
  "stt": { "provider": "elevenlabs", "available": true, "model": "scribe_v2" },
  "llm": { "provider": "deepseek", "available": true, "model": "deepseek-chat" }
}
```

If `available` is `false`, the key did not reach the Worker or the explicit
provider does not match it. Then open the site and send a message.

## Custom domain

The simplest route is the dashboard: **Workers & Pages → realtime-avatar →
Settings → Domains & Routes → Add → Custom domain**. Cloudflare creates the DNS
record and certificate.

If you prefer configuration as code, uncomment the `routes` block in
`wrangler.toml`:

```toml
routes = [{ pattern = "avatar.example.com", custom_domain = true }]
```

and give the API token **Zone → Workers Routes: Edit**, **Zone → DNS: Edit**, and
**Zone → Zone: Read** for that zone. The zone must already be in the same
Cloudflare account.

## Local preview

Wrangler runs the real Worker locally, including static assets and SSE:

```bash
npm run build:web
npx wrangler dev
# http://127.0.0.1:8787
```

Put local-only keys in `.dev.vars` (gitignored); Wrangler loads it automatically:

```bash
DEEPSEEK_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
# optional: voice input
STT_PROVIDER=elevenlabs
ELEVENLABS_STT_MODEL=scribe_v2
```

You can also deploy manually:

```bash
npm run build:web
npx wrangler deploy
```

`npx wrangler deploy --dry-run` validates the bundle and bindings without
touching the account, which is what CI does implicitly via the real deploy.

## Security and cost

This endpoint spends your credits. The repo's local server has no auth, and the
Worker adds only best-effort protections:

- a same-origin check on `POST /api/turn` and `POST /api/transcribe` (browsers
  send `Origin`; this stops another site from driving your endpoint through a
  visitor's browser),
- an in-memory per-IP limit (`RATE_LIMIT_PER_MINUTE`, default 20, per isolate),
  counted per bucket so transcription cannot crowd out turns,
- request-body caps: 64 KB for a turn, `STT_MAX_AUDIO_MB` (default 8 MB) for audio,
- `X-Robots-Tag: noindex` and `robots.txt` to keep the page out of search.

Those are not a security boundary. For a personal deployment, put the whole site
behind **Cloudflare Access** (Zero Trust → Access → Applications), with an email
or SSO policy. Access sits in front of both the page and `/api/*`, so a stranger
cannot spend your keys. A custom domain is the cleanest way to do this. You can
also add a WAF rate-limiting rule for `POST /api/turn` at the edge, which is
shared across isolates unlike the in-code limiter.

Operational notes:

- **Use Workers Paid ($5/month).** The audio→blendshape DSP and base64 encoding
  are real CPU work. The Free plan's per-request CPU budget can terminate longer
  turns; Paid raises it substantially. Waiting on the LLM/TTS network calls does
  not count as CPU.
- `say` is not available on Workers. ElevenLabs or `none` only.
- Speech-to-text is billed per audio minute as well as per request. The browser
  trims silence and caps an utterance at 30 s, and the Worker caps the upload, but
  the endpoint is still worth keeping behind Access like the rest of `/api/*`.
- Microphones only record on a secure origin. The Worker is https, so this works
  out of the box; a plain-http host would show the mic disabled with an explanation.
- The TTS LRU and the rate-limit buckets are per isolate and disappear on
  eviction/restart. They are caches, not state.
- The avatar asset is ~6.25 MB. It is served with `Cache-Control:
  max-age=0, must-revalidate`, so repeat visits revalidate with an ETag instead
  of downloading it again. First load is still a noticeable download; the
  README's "20k gaussians at 6.25 MB" note is the relevant follow-up.
- The build copies `assets/me.avtr` only. That file is intentionally tracked in
  this public repo, so the deployed site serves your face. Other personal
  captures matching `assets/me*.avtr` stay gitignored and are not copied; if you
  replace the default, run `npm run build:web` and redeploy.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `CF_API_TOKEN is not set` | add the repository secret; the workflow checks before deploying |
| `Authentication error` / `10000` | token is wrong, expired, or lacks **Workers Scripts: Edit** |
| `dist` not found during deploy | run `npm run build:web`; the workflow does this before deploying |
| `workers.dev` deploy asks for a subdomain | register one in the dashboard, or use a custom domain |
| Health shows `stub` / `none` | no provider key reached the Worker; check `wrangler secret list` and the workflow log |
| `elevenlabs 401 ... speech_to_text` | the ElevenLabs key lacks that permission; enable it on the key, or set `STT_PROVIDER=openai` with an OpenAI key |
| Mic is disabled, transcript says voice is off | `/api/health` reports `stt.available: false`; no speech-to-text key reached the Worker |
| Mic asks for permission and gets nothing | browser blocked the microphone for the site; allow it, and confirm the page is https |
| 415 on `/api/transcribe` | the request body was not `audio/*` |
| `TTS_PROVIDER=say ...` error | set `TTS_PROVIDER=elevenlabs` (or leave it unset); `say` is local-only |
| `ELEVENLABS_OUTPUT_FORMAT must be raw PCM` | use `pcm_22050`, not an `mp3_*` format |
| 403 on `/api/turn` | the request came from another origin; the API is same-origin only, so use the site itself |
| 429 | per-isolate rate limit; wait, raise `RATE_LIMIT_PER_MINUTE`, or add edge rate limiting |
| 413 | request body over the cap; turns are limited to 64 KB, audio to `STT_MAX_AUDIO_MB` (8 MB) |
| SSE stalls, no tokens | run `npx wrangler tail` and check the Worker logs; a provider 401/402 arrives as an `error` event |
| First load is slow | the 6.25 MB avatar; verify the ETag/304 on the second load, and consider a smaller/quantised asset |

## What changed for the cloud

- `server/env.mjs` is now runtime-neutral; the Node `.env` loader moved to
  `server/load-env.mjs`.
- `server/pipeline/tts-core.mjs` holds the portable TTS providers;
  `server/pipeline/tts.mjs` adds macOS `say` for local use.
- `server/pipeline/stt.mjs` is the portable speech-to-text adapter, shared by both
  entry points; it only uses `fetch`, `FormData`, and `Blob`.
- `server/pipeline/turn.mjs` is the shared turn orchestration. The Node server
  stores media in memory and serves `/media/<id>`; the Worker inlines it.
- `server/pipeline/wav.mjs` uses `Uint8Array`/`DataView` instead of `Buffer`.
- `worker/index.mjs` is the Worker entry; `tools/build-web.mjs` builds `dist/`.
