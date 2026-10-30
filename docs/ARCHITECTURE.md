# Architecture

## The three clocks

Most realtime avatar projects fail on clock handling, not rendering. There are
three timelines and they must not be allowed to drift:

1. **Turn clock** (server, `performance.now()` from request start) — used only
   for the latency HUD.
2. **Audio clock** (`AudioContext.currentTime`) — the master. Every segment is
   scheduled on it with `source.start(startAt)`.
3. **Render clock** (`requestAnimationFrame`) — asks the audio clock "how far into
   segment N are we?" and samples the blendshape track there.

Because the face is sampled *from* the audio clock rather than advanced by frame
deltas, lip sync cannot drift even if the render loop stalls or the network
jitters. If you take one thing from this repo, take this.

## Turn lifecycle

```
POST /api/turn {text, history[]}
  ← event: start    {t, tts, llm}                 resolved providers + model
  ← event: token    {text, t}                     … many, as the LLM streams
  ← event: segment  {seq, audio, frames, duration, fps, ttsMs, a2eMs,
                     provider, voice, cached, first}
  ← event: error    {stage, message}              llm or tts failure
  ← event: done     {t, firstAudioAt}
```

The server cuts the token stream into sentences (`findCut` in `server.mjs`) and
pipes each through TTS → analysis → media store *as it arrives*, in order, on a
promise chain. So audio for sentence 1 starts playing while sentence 3 is still
being synthesised. `findCut` scans past short abbreviations and cuts at the first
boundary that leaves a phrase, so a brief opener like "Hello there." gets audio
started immediately instead of waiting for the whole reply.

Conversation history arrives with the turn (the browser keeps the last 16
messages), is sanitised in `pipeline/llm.mjs`, and is not stored server-side. The
client aborts the previous turn when a new one starts; the server aborts the
in-flight LLM request and any queued TTS calls when the SSE socket closes, so a
cancelled turn stops costing tokens and characters.

`segment.audio` and `segment.frames` are plain GETs under `/media/<id>` in the
local Node server. Media lives in a bounded in-memory map (96 entries, FIFO).
The Cloudflare Worker has no shared memory between isolates, so it inlines
`audioBase64` and `framesData` in the same SSE event instead; see
**[DEPLOY.md](DEPLOY.md)**.

### Provider adapters

`pipeline/llm.mjs` and `pipeline/tts.mjs` are the only vendor-aware code. Each
exposes one async contract:

```js
streamReply(text, { history, signal }) -> AsyncIterable<string>
speak(text, { previousText, signal }) -> { wav, sampleRate, duration, ... }
```

OpenAI-compatible and Anthropic streaming share the SSE reader in
`pipeline/http.mjs`; ElevenLabs returns raw PCM, which is wrapped as a 32-bit
float WAV for WebAudio. Retries, timeouts, LRU caching, and error hints live in
the adapters. See **[PROVIDERS.md](PROVIDERS.md)** for configuration.

### frames format

```json
{ "fps": 60,
  "names": ["jawOpen", "mouthFunnel", "..."],
  "frames": [[0.12, 0.0, ...], ...] }
```

One row per 1/60 s, values 0..1, rounded to 3 dp. Named channels — not channel
indices — so the renderer can ignore what it does not have. This is deliberately
ARKit-shaped: every audio→expression model and every face tracker emits
something close to this, and unlike FLAME's 50-d basis it is not tied to one
identity model.

## Client render loop

```
speaker.sample()        → { values, energy }      // audio-clock driven
idle.update(dt, energy) → blinks, saccades, sway  // overrides blink/gaze only
rig.set(merged) → rig.update()                    // CPU linear blend shapes
renderer.draw(positions, poseMatrix, camera)
```

### Deformation

`positions[i] = base[i] + Σ_b w[i][b] · value[b] · delta[i][b]`

~140k multiply-adds per frame at 20k gaussians × ~7 active channels, ~1 ms in JS.
Only channels with a non-zero value are visited. Above ~100k gaussians move this
into the vertex shader with a delta texture and a `weights` texel fetch.

### Splatting

Instanced quads, one per Gaussian, 14 floats of instance data.

- Vertex shader builds the 3D covariance `Σ = R S Sᵀ Rᵀ`, pushes it to 2D with the
  perspective Jacobian `J`, adds 0.3 px of anti-aliasing, eigen-decomposes the 2×2,
  and sizes the quad to 3σ along each principal axis.
- Fragment shader is `exp(-0.5 r²)` in σ units, with alpha blending.
- **Back-to-front order is required** for correct compositing, so Gaussians are
  depth-sorted every frame with a 65 536-bucket counting sort (O(n), ~0.3 ms at
  20k) and the instance buffer is rebuilt in sorted order.

That last point is the main bandwidth cost: ~1 MB of `bufferSubData` per frame.
Acceptable on desktop, questionable on mobile. The upgrade path is a compute-pass
sort plus texture-sampled attributes indexed by a sorted index buffer — same math,
one tenth the upload.

## `.avtr` container

```
"AVTR" | u32 version | u32 jsonLen | json | f32 buffers…
positions [n*3]   scales [n*3]   quats [n*4]   colors [n*3]   opacity [n]
weights   [n*nb]  deltas [n*nb*3]
```

Dense and stupid on purpose; gzip does the compressing (mostly-zero delta block).
`shared/format.mjs` is the only reader/writer. Ship it as glTF + extensions if you
need interoperability; nothing else depends on the format.

## Deployment topology

```
Cloudflare Worker (realtime-avatar)
  ├─ /api/turn    POST → SSE, runs the same turn pipeline as server.mjs
  ├─ /api/health  GET  → resolved providers
  └─ /*           GET  → Cloudflare asset router → dist/ (client + .avtr)
```

`server/pipeline/turn.mjs` is the shared orchestration; the transport is an
injected `emit(event, data)`. The local entry writes SSE and stores media in
memory. The Worker writes SSE and base64-inlines the WAV plus the frames object,
so it stays stateless and horizontal scaling is just more isolates. The cost is
wire size (base64 is ~33% larger than the WAV) and CPU for the DSP per sentence;
use Workers Paid rather than the Free plan's 10 ms CPU budget.

Deploy with `wrangler` on push to `main`; provider keys are Worker secrets. See
**[DEPLOY.md](DEPLOY.md)** for setup, security, and limits, and
**[ARCHITECTURE-BEFORE-AFTER.md](ARCHITECTURE-BEFORE-AFTER.md)** for the
side-by-side diagrams.

## Scaling notes

- **Per-user GPU cost is zero on the server.** Six figures of concurrent users is
  a CDN problem, not a render-farm problem.
- The bottleneck becomes TTS: one `say`/ElevenLabs call per sentence. Batch and
  cache aggressively; greetings and filler are highly repetitive.
- `Media` is in-process memory. With more than one server you need shared storage
  or a signed-URL scheme.
- WebGPU is not required. WebGL2 is universal (iOS included) and fast enough for
  ~40k gaussians; move to WebGPU when you want compute sorting or 100k+ primitives.
