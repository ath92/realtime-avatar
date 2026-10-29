# Runbook: one photo → `.avtr` via LAM

LAM is the only open model that turns a single photo into an animatable Gaussian
head. It needs an NVIDIA GPU, which is the whole problem. Two ways to borrow one
without learning a cloud console, plus the manual route if you prefer.

**Licence:** LAM *code* is Apache-2.0, LAM *weights* are CC BY-NC 4.0, FLAME is
non-commercial research only. Fine for a demo or anything personal. Not for a
product — the exported avatar is a derivative of all three.

---

## Option A — Modal (no SSH, ~3 commands)

[Modal](https://modal.com) runs a function on a rented GPU and hands the result
back to your laptop. First run builds the image (~40 min, cached after). Assets
download once into a persistent volume.

Nothing needs installing — `uvx` runs the Modal client from a throwaway
environment and caches it:

```bash
uvx modal token new                  # one browser click, once ever
uvx modal run tools/lam/modal_app.py --photo me.jpg
node tools/import-lam.mjs --in ./me-export --out assets/me.avtr
```

(No `uv`? `brew install uv`, or use a venv: `python3 -m venv .venv &&
. .venv/bin/activate && pip install modal`. Pin the client with `uvx modal@1.6.3`
if you want reproducibility.)

Add `--gpu a100` if the 24 GB card runs out of memory. Cost is GPU-minutes: a few
cents per avatar once the image is cached, plus the one-time build.

**What works without touching anything:** image build, GPU provisioning, asset
download, export, and the tar coming back to `./me-export`.

**What is untested:** all of it — it needs a Modal account and a GPU. If the image
build dies, the failing log line is usually enough for a one-line fix; send me
`modal app logs lam-avatar` and I'll turn it around.

---

## Option B — Docker (any GPU box, or RunPod "custom image")

```bash
docker build -f tools/lam/Dockerfile -t lam-avatar .        # ~30-45 min, once

docker run --gpus all -v "$PWD":/work -v lam-assets:/assets \
  lam-avatar me.jpg
```

Writes `./me-export/`. The `lam-assets` volume caches the 1.2 GB of FLAME assets
and weights, so the second run starts in seconds.

On RunPod: push the image to a registry, then create a pod from it with a network
volume mounted at `/assets` and your photo in `/work`. The entrypoint takes over
from there — no shell needed.

The image is pinned to LAM commit `3395736`, which is the revision the exporter was
written against. LAM's API moves; if you bump the pin, expect to fix the
`infer_single` call.

---

## Option C — manual, if you want to watch it happen

```bash
git clone https://github.com/aigc3d/LAM && cd LAM
sh ./scripts/install/install_cu121.sh
huggingface-cli download 3DAIGC/LAM-assets --local-dir ./tmp
tar -xf ./tmp/LAM_assets.tar && tar -xf ./tmp/LAM_human_model.tar
huggingface-cli download 3DAIGC/LAM-20K --local-dir ./model_zoo/lam_models/releases/lam/lam-20k

python tools/lam/export_avatar.py \
  --lam-root $PWD \
  --model model_zoo/lam_models/releases/lam/lam-20k/step_045500 \
  --image /workspace/me.jpg \
  --motion assets/sample_motion/export/Look_In_My_Eyes \
  --out /workspace/me-export
```

---

## Then, on your Mac

```bash
node tools/import-lam.mjs --in ./me-export --out assets/me.avtr
node tools/check-avatar.mjs assets/me.avtr
open 'http://127.0.0.1:8787/client/?asset=/assets/me.avtr'
```

You want the exporter to report roughly:

```
gaussians  ~100,000
mesh       ~50,000 verts, ~100,000 tris
deltas     (52, V, 3)  max ~20.0 mm
```

The importer binds every Gaussian to its nearest FLAME triangle, pushes the 52
FLAME blendshape directions through those barycentric weights, folds them into the
rig's 16 channels, and writes a normal `.avtr`. If the framing is off, scroll to
zoom and hard-code `camera.dist` in `client/app.js`.

## Picking a photo

LAM is a prior, so the photo matters more than the GPU:

- front-facing, eyes open, mouth closed, neutral expression
- even light, no hard shadow across the face, no direct sun
- glasses off, hair off the forehead if you can
- 1024 px on the long edge is plenty; LAM crops to the head anyway
- it will invent the back of your head and your hair — one photo cannot know

## If it breaks

`export_avatar.py` prints a traceback and keeps going where it can. Send back:

1. the full traceback,
2. `git -C /opt/LAM rev-parse --short HEAD` (or `git -C LAM …`),
3. `ls -la me-export/`.

The two things most likely to have moved between LAM versions are the
`infer_single` signature and the name of the canonical Gaussian list on the result
dict. Both are one-line fixes.
