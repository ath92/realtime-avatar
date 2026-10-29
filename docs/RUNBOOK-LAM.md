# Runbook: one photo → `.avtr` via LAM

LAM is the only open model that turns a single photo into an animatable Gaussian
head. It needs an NVIDIA GPU, so this is a ~90 minute detour through a rented
machine. Everything else — the binding, the rig bake — runs on your Mac in
seconds once you have the files.

**Licence:** LAM *code* is Apache-2.0, LAM *weights* are CC BY-NC 4.0, and FLAME is
non-commercial research only. Fine for a demo or anything personal. Not fine for
a product. The exported avatar is a derivative of all three.

## 1. Rent a GPU (~10 min)

Any of RunPod / Vast.ai / Lambda. Pick:

- **GPU:** RTX 4090 (24 GB) or A100. LAM reports 1.4 s reconstruction on an A100.
- **Image:** PyTorch 2.1+ / CUDA 12.1 template — the installer wants CUDA 12.1 or 11.8 specifically.
- **Disk:** 60 GB (the weights and assets are ~3 GB, plus headroom).
- **Cost:** roughly $0.40–1.00/hr. You will use an hour or two.

Open a terminal on the pod.

## 2. Install LAM (~30 min, mostly downloading)

```bash
cd /workspace
git clone https://github.com/aigc3d/LAM.git
cd LAM
sh ./scripts/install/install_cu121.sh          # CUDA 12.1; use install_cu118.sh for 11.8
```

Then the assets and weights:

```bash
# LAM assets (FLAME template + sample motions)
huggingface-cli download 3DAIGC/LAM-assets --local-dir ./tmp
tar -xf ./tmp/LAM_assets.tar && rm ./tmp/LAM_assets.tar

# human model (FLAME)
huggingface-cli download 3DAIGC/LAM-assets --include "LAM_human_model.tar" --local-dir ./tmp
tar -xf ./tmp/LAM_human_model.tar && rm ./tmp/LAM_human_model.tar

# avatar weights (~LAM-20K)
huggingface-cli download 3DAIGC/LAM-20K --local-dir ./model_zoo/lam_models/releases/lam/lam-20k
```

Check it works before doing anything clever:

```bash
sh ./scripts/inference.sh configs/inference/lam-20k-8gpu.yaml \
  model_zoo/lam_models/releases/lam/lam-20k/step_045500/ \
  assets/sample_input/status.png \
  assets/sample_motion/export/Look_In_My_Eyes/
```

You should get an `exps/.../*.mp4`. If that fails, stop here — nothing downstream
will work.

## 3. Export your avatar (~5 min)

Copy your photo onto the pod (the photo should be a clear, front-facing, evenly
lit shot; glasses off; mouth closed; neutral expression).

```bash
python tools/lam/export_avatar.py \
  --lam-root /workspace/LAM \
  --config configs/inference/lam-20k-8gpu.yaml \
  --model model_zoo/lam_models/releases/lam/lam-20k/step_045500 \
  --image /workspace/me.jpg \
  --motion assets/sample_motion/export/Look_In_My_Eyes \
  --out /workspace/me-export
```

`--motion` is only there because LAM's runner insists on a driving sequence; the
canonical avatar does not depend on it. Any of the shipped sequences will do.

You want to see:

```
gaussians  ~100,000
mesh       ~50,000 verts, ~100,000 tris
deltas     (52, V, 3)  max ~20.0 mm
```

Then download the folder:

```bash
tar -czf me-export.tar.gz -C /workspace me-export
# scp / RunPod's file browser / `python -m http.server` and curl it
```

## 4. Import locally (~10 sec)

```bash
node tools/import-lam.mjs --in ~/Downloads/me-export --out assets/me.avtr
node tools/check-avatar.mjs assets/me.avtr
open 'http://127.0.0.1:8787/client/?asset=/assets/me.avtr'
```

The importer binds every Gaussian to its nearest FLAME triangle, pushes the 52
FLAME blendshape directions through those barycentric weights, folds them into the
rig's 16 channels, and writes a normal `.avtr`. If the framing is off, scroll to
zoom and hard-code `camera.dist` in `client/app.js`.

## If it breaks

`export_avatar.py` prints a traceback and keeps going where it can. Send back:

1. the full traceback,
2. the output of `python -c "import lam; print(lam.__file__)"` and
   `git -C /workspace/LAM rev-parse --short HEAD`,
3. whatever landed in `me-export/` (`ls -la`).

The two things most likely to have moved between LAM versions are the
`infer_single` signature and the name of the canonical Gaussian list on the
result dict. Both are one-line fixes.
