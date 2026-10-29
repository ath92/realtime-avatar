#!/usr/bin/env bash
# Container entrypoint: make sure the assets exist, then export one avatar.
#
#   docker run --gpus all -v "$PWD":/work -v lam-assets:/assets lam-avatar me.jpg
#
# Writes /work/me-export/{verts,faces,gaussians,deltas}.npy + meta.json
set -euo pipefail

PHOTO="${1:?usage: <photo.jpg> [out-dir]}"
OUT="${2:-/work/$(basename "${PHOTO%.*}")-export}"
CACHE=/assets
mkdir -p "$CACHE" "$OUT"

# ---- assets, downloaded once into the mounted volume --------------------
if [ ! -f "$CACHE/.ready" ]; then
  echo "[assets] downloading (one time, ~1.2 GB)"
  pip install -q huggingface_hub
  python - <<'PY'
from huggingface_hub import hf_hub_download
import os, tarfile
cache = os.environ.get("CACHE", "/assets")
for repo, fname in [("3DAIGC/LAM-assets", "LAM_assets.tar"),
                    ("3DAIGC/LAM-assets", "LAM_human_model.tar")]:
    p = hf_hub_download(repo_id=repo, filename=fname, cache_dir="/tmp/hf")
    with tarfile.open(p) as t:
        t.extractall(cache)
    print("extracted", fname)
PY
  touch "$CACHE/.ready"
fi

# LAM expects assets relative to its own root
ln -sfn "$CACHE/assets" /opt/LAM/assets 2>/dev/null || true
ln -sfn "$CACHE" /opt/LAM/model_zoo 2>/dev/null || true

MODEL="$CACHE/model_zoo/lam_models/releases/lam/lam-20k/step_045500"
if [ ! -d "$MODEL" ]; then
  echo "[weights] downloading LAM-20K (one time)"
  python - <<PY
from huggingface_hub import snapshot_download
snapshot_download("3DAIGC/LAM-20K", local_dir="$CACHE/model_zoo/lam_models/releases/lam/lam-20k")
PY
fi

MOTION="${MOTION:-$CACHE/assets/sample_motion/export/Look_In_My_Eyes}"

echo "[export] $PHOTO -> $OUT"
python /opt/avatarhq/export_avatar.py \
  --lam-root /opt/LAM \
  --config configs/inference/lam-20k-8gpu.yaml \
  --model "$MODEL" \
  --image "$PHOTO" \
  --motion "$MOTION" \
  --out "$OUT"

echo "[export] done. files:"
ls -la "$OUT"
