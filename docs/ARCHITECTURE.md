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
POST /api/turn {text}
  ← event: start    {t, tts}
  ← event: token    {text, t}                    … many, as the LLM streams
  ← event: segment  {seq, audio, frames, duration, fps, ttsMs, a2eMs}
  ← event: done     {t, firstAudioAt}
```

The server cuts the token stream into sentences (`findCut` in `server.mjs`) and
pipes each through TTS → analysis → media store *as it arrives*, in order, on a
promise chain. So audio for sentence 1 starts playing while sentence 3 is still
being synthesised.

`segment.audio` and `segment.frames` are plain GETs under `/media/<id>`. Media
lives in a bounded in-memory map (96 entries, FIFO) — swap for object storage
when you have more than one process.

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

265k multiply-adds per frame at 38k gaussians × ~7 active channels, ~1 ms in JS.
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
  38k) and the instance buffer is rebuilt in sorted order.

That last point is the main bandwidth cost: ~2 MB of `bufferSubData` per frame.
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

## Scaling notes

- **Per-user GPU cost is zero on the server.** Six figures of concurrent users is
  a CDN problem, not a render-farm problem.
- The bottleneck becomes TTS: one `say`/ElevenLabs call per sentence. Batch and
  cache aggressively; greetings and filler are highly repetitive.
- `Media` is in-process memory. With more than one server you need shared storage
  or a signed-URL scheme.
- WebGPU is not required. WebGL2 is universal (iOS included) and fast enough for
  ~40k gaussians; move to WebGPU when you want compute sorting or 100k+ primitives.
