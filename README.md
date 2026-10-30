# realtime-avatar

A realtime, photoreal-*ish* head avatar that runs in a browser tab and talks back.
Text in → LLM reply → speech out → the face moves → everything renders client-side
as 3D Gaussians.

```
browser ──text──▶ server ──▶ LLM ──▶ TTS ──▶ audio → blendshapes ──▶ SSE
   ▲                                                                  │
   └──────────── WebGL2 gaussian splatting ◀── audio + 60 fps stream ──┘
```

![the avatar mid-sentence](docs/screenshot.png)

The avatar is a static asset (~6.25 MB here) plus ~50 floats per frame. The server
never renders anything; the GPU cost per user is the user's own. That is the whole
point of the design.

## Quickstart

```bash
node server/server.mjs          # or: npm start
open http://127.0.0.1:8787/client/
```

No dependencies, no build step for local development, and no API key is required for the demo. On macOS the voice comes from `say`;
elsewhere it falls back to a synthetic babble, and the LLM streams a canned reply
so the pipeline still runs.

For a real conversation, copy the example env file and fill in what you have:

```bash
cp .env.example .env
# ELEVENLABS_API_KEY=...                            real voice
# DEEPSEEK_API_KEY=... (or OPENAI_API_KEY / ANTHROPIC_API_KEY)  real replies
node server/server.mjs
npm run smoke                                  # checks both providers, no browser
npm run voices                                 # list ElevenLabs voice IDs
```

The server loads `.env` on every start, so there is nothing to `source` or
export before `npm start`. Keep the file private (`chmod 600 .env`); it is
gitignored.

Provider selection is automatic: with `ELEVENLABS_API_KEY` set the server uses
ElevenLabs, otherwise `say` on macOS. `DEEPSEEK_API_KEY` alone selects DeepSeek
with the right base URL and model; `OPENAI_API_KEY` uses any OpenAI-compatible
endpoint, and `ANTHROPIC_API_KEY` uses Anthropic. The full matrix, env vars, and
troubleshooting are in **[docs/PROVIDERS.md](docs/PROVIDERS.md)**.

```bash
node tools/make-avatar.mjs      # regenerate the procedural head (assets/head.avtr, ignored)
node tools/preview.mjs --out preview.png --yaw 0.3 --preset talk
node tools/check-avatar.mjs assets/me.avtr
npm test                        # provider + Worker tests, mocked (no keys/network)
```

## Deploy to Cloudflare

One Worker serves the built client and proxies `/api/*`, so provider keys stay
server-side. A push to `main` deploys through GitHub Actions.

```bash
gh secret set CF_API_TOKEN     # Workers Scripts: Edit
gh secret set CF_ACCOUNT_ID
gh secret set DEEPSEEK_API_KEY         # or OPENAI_API_KEY / ANTHROPIC_API_KEY
gh secret set ELEVENLABS_API_KEY
gh secret set ELEVENLABS_VOICE_ID      # optional; defaults to Rachel

git push origin main
```

The workflow tests, builds `dist/`, deploys the Worker, and pushes the provider
keys as Worker secrets. `say` is macOS-only, so the cloud voice is ElevenLabs
(or the synthetic fallback if no key is set). Setup, custom domains, and the
security checklist are in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## What is real, what is a stand-in

| Piece | State | Swap for |
|---|---|---|
| Gaussian rig + WebGL2 renderer | real | — |
| Sorting, deformation, idle motion | real | — |
| LLM (`server/pipeline/llm.mjs`) | real: DeepSeek, OpenAI-compatible, or Anthropic, streamed with history | — |
| TTS (`server/pipeline/tts.mjs`) | real: ElevenLabs raw PCM, cached and retried | Cartesia / CosyVoice behind the same `speak()` |
| Audio → blendshapes (`server/pipeline/a2e.mjs`) | classical DSP, works, not SOTA | LAM-A2E, or any streaming audio→expression model |
| Avatar asset (`assets/me.avtr`) | personal LAM capture, ~20k gaussians | replace with your own `.avtr` |

With no keys, the demo falls back to macOS `say` and a canned LLM; the table
above describes the wired configuration. The last row is the one that matters
for visual quality — everything above it is plumbing around a `.avtr` file whose
interface is: *N gaussians + a blendshape rig*.

## Replace the avatar

The default is a personal LAM capture in `assets/me.avtr` (~20k gaussians). It is
intentionally tracked in this public repo. To swap in a different face, you need
a **rigged head mesh** — any GLB with ARKit shape keys (a scan + Faceit in
Blender, or an avatar SDK export):

```bash
node tools/import-mesh.mjs --list --in me.glb
node tools/import-mesh.mjs --in me.glb --out assets/me.avtr --count 20000
node tools/check-avatar.mjs assets/me.avtr
npm run build:web
```

The client defaults to `/assets/me.avtr`; `?asset=/assets/<name>.avtr` still works
for assets you add locally. Channels are matched by name, morph targets become
per-Gaussian deltas, and the client keeps working.

Full walkthrough, including the channel mapping table: **[docs/ASSET.md](docs/ASSET.md)**.

### Or from one photo, with LAM

LAM reconstructs an animatable Gaussian head from a single image, but it needs an
NVIDIA GPU and returns FLAME-space Gaussians with no rig. `tools/import-lam.mjs`
reconstructs the rig: it binds every Gaussian to its nearest FLAME triangle and
pushes the 52 FLAME blendshape directions through those barycentric weights.

```bash
# on a rented GPU box
python tools/lam/export_avatar.py --lam-root /workspace/LAM \
  --model model_zoo/.../step_045500 --image me.jpg \
  --motion assets/sample_motion/export/Look_In_My_Eyes --out /workspace/me-export

# back on your machine
node tools/import-lam.mjs --in ~/Downloads/me-export --out assets/me.avtr
```

Or run the whole thing on a rented GPU without a shell — [Modal](https://modal.com)
builds the image, grabs the GPU and hands the export back:

```bash
uvx modal token new                  # no install: uvx runs it from a temp env
uvx modal run tools/lam/modal_app.py --photo me.jpg
```

Docker is there too (`tools/lam/Dockerfile`). Step-by-step for both:
**[docs/RUNBOOK-LAM.md](docs/RUNBOOK-LAM.md)**.

## Measured on this machine

| Stage | Time |
|---|---|
| First audio out (stub LLM, `say`) | **1.4 s** |
| TTS per sentence (`say`) | ~520 ms |
| Audio → blendshape frames (4 s of speech) | 12 ms |
| Deform 20k gaussians (CPU) | ~1 ms |
| Splat + sort | renderer-side, see `docs/ARCHITECTURE.md` |

Well under 16 ms of avatar work per frame. The latency you feel is LLM + TTS, not
the face. Provider latency varies by model, region, and load; `npm run smoke`
prints the first-token and TTS timings for your setup.

## Layout

```
client/        app shell, WebGL2 splatter, rig, idle motion, audio clock
worker/        Cloudflare Worker entry (API proxy + static assets)
server/        local static host + SSE orchestrator
server/env.mjs     typed env readers (Node + Worker)
server/load-env.mjs  .env loader (Node only)
server/pipeline/   llm · tts · audio→blendshapes · wav · http · turn
shared/format.mjs  the .avtr container
test/          provider, turn, and Worker routing/SSE tests (no keys/network)
tools/
  rig.mjs            procedural character generator
  build-web.mjs      copy the client + default avatar into dist/ for Workers
  import-mesh.mjs    GLB with ARKit shape keys -> .avtr
  import-lam.mjs     LAM FLAME-space Gaussians -> .avtr (re-binds the rig)
  arkit-map.mjs      ARKit 52 -> rig 16 channel mapping, shared by both
  lam/export_avatar.py   runs on the GPU box, dumps what the importer needs
  lam/modal_app.py       one-command GPU run, no SSH
  lam/Dockerfile         same thing without Modal
  glb.mjs            dependency-free glTF reader + PNG decoder
  check-avatar.mjs   rig validator (CI-friendly)
  preview.mjs        software renderer, no GPU
  make-test-glb.mjs  synthetic rigged fixture for tests
  smoke.mjs          provider smoke test: LLM + TTS, no browser
  voices.mjs         list ElevenLabs voices
assets/        me.avtr (tracked default)
docs/          architecture, asset pipeline, provider setup, deployment
wrangler.toml  Worker + static assets config
```

## Known gaps

- **Segment seams.** Each sentence is synthesised as it streams in, so if TTS is
  slower than playback there is a silence gap where the mouth snaps shut. Fix:
  clause-level chunking plus a small pre-synthesis buffer.
- **TTS is per-segment, not true streaming.** The server waits for a full
  sentence of PCM before analysing it. First audio is therefore one sentence
  behind the model. Real streaming would run the audio→expression model on
  partial chunks and serve frames incrementally.
- **ElevenLabs is billed per character.** Segments are cached by text, voice,
  model, and settings (`TTS_CACHE_SIZE`), which helps greetings and fillers but
  not novel replies.
- **No visemes worth the name.** The DSP mapper tracks loudness and spectral
  centroid. It looks plausible; it is not lip-accurate.
- **Flat lighting.** Colours are baked SH-less; no relighting, no shadows.
- **20k gaussians at 6.25 MB.** Fine on desktop, heavier on mobile. Quantise and
  prune (see CVPR'26 mobile avatar work) before shipping.
- **The importer is verified against a synthetic fixture**, not against every
  commercial GLB. `--list` plus `check-avatar` localises most surprises.
- **Gaze is shared between the eyes** — one `eyeLookX`, so no vergence. Split the
  channel in `tools/rig.mjs` if you need it.
- **`?static=1`** freezes the rig at rest — useful when you are debugging the asset.

## What leaves the machine

With a cloud LLM and ElevenLabs configured, the user's text and the model's
reply are sent to those APIs, and generated audio comes back from ElevenLabs.
Nothing else leaves: the avatar asset, the blendshape track, and all rendering
stay in the browser. With the stub LLM and `say`, no text leaves the machine.

ElevenLabs logs requests by default; zero-retention mode
(`ELEVENLABS_ENABLE_LOGGING=false`) is an enterprise feature. The server holds
your API keys — do not expose it publicly without auth and rate limits, or
strangers will spend your credits. The Cloudflare Worker adds a same-origin check
and a best-effort per-isolate rate limit, but that is not authentication; put the
deployed site behind Cloudflare Access (see **[docs/DEPLOY.md](docs/DEPLOY.md#security-and-cost)**).

## License

Scaffold code: do what you like. The avatar asset in `assets/me.avtr` is a
personal capture and is **not** licensed for reuse; replace it with your own
asset if you redistribute the repo.
