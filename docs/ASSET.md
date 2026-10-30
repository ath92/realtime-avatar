# Replacing the avatar with your own face

The default avatar is a personal LAM capture in `assets/me.avtr`, committed
intentionally so the deployed site is not the procedural mannequin. This is how
to swap in a different face.

## Where a rigged avatar comes from

| Route | Source | Effort | Licence |
|---|---|---|---|
| **A. Rigged mesh → Gaussians** | any GLB with 52 ARKit shape keys: a scan + Faceit (Blender add-on), or an avatar SDK export | an afternoon, no GPU | yours |
| **B. FLAME reconstruction** | [LAM](https://github.com/aigc3d/LAM) (1 photo), [Avat3r](https://openaccess.thecvf.com/content/ICCV2025/papers/Kirschstein_Avat3r_Large_Animatable_Gaussian_Reconstruction_Model_for_High-fidelity_3D_Head_ICCV_2025_paper.pdf) (4 images), [GaussianAvatars](https://github.com/ShenhanQian/GaussianAvatars) (video) | hours, GPU | FLAME is non-commercial |
| **C. Capture first** | 60–90 s of video, or 8 stills around the head | — | — |

Route A is what `tools/import-mesh.mjs` implements. Route B outputs
FLAME-bound Gaussians, which animate through linear blend skinning on the FLAME
mesh rather than through blendshape deltas — bringing one in means baking FLAME
vertex displacements through the same barycentric path (see *Under the hood*).

## Route A, end to end

```bash
node tools/import-mesh.mjs --list --in me.glb          # what shape keys does it have?
node tools/import-mesh.mjs --in me.glb --out assets/me.avtr --count 20000
node tools/check-avatar.mjs assets/me.avtr             # sanity-check the rig
```

The client defaults to `/assets/me.avtr`, so replacing that file is enough for
the deployed site (run `npm run build:web`). The local server can also serve any
other asset under `assets/`:

```
http://127.0.0.1:8787/client/?asset=/assets/other.avtr
```

`?static=1` freezes the rig if you want to inspect the rest pose.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--count` | 40000 | Gaussians to sample. 20k is fine for stylised, 80k+ for detailed scans |
| `--fit` | 0.30 | Rescale so the model is this tall, in metres. `0` keeps the source scale |
| `--no-center` | off | Keep the source origin instead of centring the bounding box |
| `--list` | — | Print the shape keys and exit |

Expect to adjust the camera afterwards. `client/app.js` starts at
`dist: 0.70`, tuned for the default capture; a differently sized head may sit a little
tight or loose. Scroll to zoom, then hard-code the value you like.

## Under the hood

Points are sampled on the mesh surface, area-weighted and stratified (one jittered
sample per equal-area slice), so density is uniform regardless of how the mesh is
tessellated. Each sample becomes one Gaussian, oriented to the interpolated
normal and flattened along it.

The rig comes from the morph targets. A glTF morph target is already a per-vertex
*displacement*, so for a Gaussian at barycentric `(b0,b1,b2)` on a triangle:

```
delta[g][k] = b0*d[v0][k] + b1*d[v1][k] + b2*d[v2][k]
```

That is exact — no fitting, no approximation. Colour comes from the base-colour
texture at the interpolated UV (PNG decoded in-process, JPEG via `sips`), or from
`COLOR_0` if the mesh is vertex-coloured.

## Channel mapping

ARKit's 52 keys do not line up with the 16 channels this rig drives, so the
importer remaps and drops the rest:

| ARKit | rig | |
|---|---|---|
| `jawOpen` | `jawOpen` | |
| `mouthSmileLeft` / `Right` | `mouthSmile_L` / `_R` | |
| `mouthFunnel`, `mouthPucker` | same | |
| `browInnerUp` | `browInnerUp` | |
| `browOuterUpLeft/Right` | `browOuterUp_L/_R` | |
| `browDownLeft/Right` | `browDown_L/_R` | |
| `eyeBlinkLeft/Right` | `eyeBlink_L/_R` | |
| `eyeLookOut/In/Up/Down` × 2 | `eyeLookX`, `eyeLookY` | composed: (out − in)/2, (up − down)/2 |
| `cheekPuff` | `cheekPuff` | |
| `noseSneerLeft/Right` | `noseSneer` | averaged |

The gaze composition is lossy: one shared `eyeLookX` for both eyes means you
lose vergence. If you need it, split the channel in `tools/rig.mjs` and add the
per-eye keys to the map.

## Checking the result

```
$ node tools/check-avatar.mjs assets/me.avtr
file      assets/me.avtr
gaussians 20,018   channels 16
height    30.0 cm   width 32.7 cm   payload 6.25 MB

channel            gaussians   max move   centroid
  jawOpen              3256    46.5 mm  x 0.007 y -0.034
  mouthSmile_L         2058     5.6 mm  x 0.014 y -0.017
  eyeBlink_L           2439     9.4 mm  x 0.036 y 0.039
  …

✓  avatar looks consistent
```

It catches the failures that are silent at runtime:

- non-finite numbers (a NaN Gaussian disappears; a NaN *position* kills the sort)
- channels that move nothing, or move everything
- a mirrored rig — `mouthSmile_L` acting at negative x
- wrong units — a 1.7 m full-body scan dropped into a 0.3 m frame
- channels the audio pipeline drives that the asset does not have

Exit code is non-zero on errors, so it drops straight into CI.

## Format

`.avtr` is a header plus flat `Float32Array`s: positions, scales, quaternions,
colours, opacity, per-Gaussian rig weights, and per-Gaussian deltas. Dense on
purpose — gzip handles the mostly-zero delta block. `shared/format.mjs` is the
entire implementation, ~96 lines; read it before writing your own exporter.

## Limits worth knowing

- **Count.** Past ~100k Gaussians the CPU deform and the ~2 MB/frame instance
  upload both need the GPU-side path described in `ARCHITECTURE.md`.
- **Lighting.** No SH, no shadows. Colours are baked; the shader tonemaps.
- **Test coverage.** The importer is verified against the synthetic fixture in
  `tools/make-test-glb.mjs`, not against every commercial GLB in existence. If a
  file trips it, `--list` plus the validator output usually localises the reason.
