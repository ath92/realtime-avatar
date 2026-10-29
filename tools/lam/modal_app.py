"""Run the LAM export on a rented GPU without touching a shell.

    uvx modal token new                      # once, one browser click
    uvx modal run tools/lam/modal_app.py --photo me.jpg

Modal builds the image (once, ~40 min, cached after), provisions a GPU, downloads
the LAM assets into a persistent Volume (once, ~1.5 GB), runs the export, and
writes ./me-export back to your machine. Then:

    node tools/import-lam.mjs --in ./me-export --out assets/me.avtr

Requires an Image Builder Version that still supports Python 3.10 — LAM's deps are
3.10-era and the 2026.10 builder rejects them at deploy time. Set it in
modal.com -> workspace settings -> Image Builder Version.

Nothing here is exercised by the repo's tests: it needs a GPU and a Modal
account. If a run fails, the failing log line is usually enough for a one-line fix.
"""

from __future__ import annotations

import io
import subprocess
import tarfile
from pathlib import Path

import modal

HERE = Path(__file__).parent
LAM_COMMIT = "339573649dd93df4cba8093a964e85a80d1b61f3"  # pinned: LAM's API moves

app = modal.App("lam-avatar")

# LAM pins a Python 3.10-era stack (numpy 1.23, tensorflow 2.12, chumpy), so the
# image has to be 3.10, which is why the workspace's Image Builder Version must
# still support it. The base below is the official PyTorch image: Python 3.10 plus
# the exact torch/CUDA pair LAM's installer would have produced anyway.
image = (
    modal.Image.from_registry("pytorch/pytorch:2.3.0-cuda12.1-cudnn8-devel")
    .apt_install(
        "git", "wget", "curl", "build-essential", "cmake", "ninja-build",
        "pkg-config", "ffmpeg", "libgl1", "libglib2.0-0", "libsm6", "libxext6",
        "libgomp1",
    )
    .env({"TORCH_CUDA_ARCH_LIST": "8.0;8.6;8.9;9.0", "PYTHONPATH": "/opt/LAM"})
    .run_commands(
        "git clone https://github.com/aigc3d/LAM /opt/LAM",
        f"cd /opt/LAM && git checkout {LAM_COMMIT}",
    )
    .pip_install("xformers==0.0.26.post1", index_url="https://download.pytorch.org/whl/cu121")
    # pytorch3d + diff-gaussian-rasterization + nvdiffrast + simple-knn: the slow layer
    .run_commands("cd /opt/LAM && pip install -r requirements.txt")
    .run_commands("cd /opt/LAM/external/landmark_detection/FaceBoxesV2/utils && sh make.sh")
    .add_local_file(HERE / "export_avatar.py", "/opt/avatarhq/export_avatar.py")
)

cache = modal.Volume.from_name("lam-assets", create_if_missing=True)

# LAM's README unpacks LAM_assets.tar then thirdparty_models.tar. The human model
# tarball carries the FLAME template.
TARBALLS = ("LAM_assets.tar", "LAM_human_model.tar", "thirdparty_models.tar")
MODEL_DIR = "/cache/model_zoo/lam_models/releases/lam/lam-20k/step_045500"


def _ensure_assets() -> str:
    """Download and unpack everything into the volume. Runs once per workspace."""
    marker = Path("/cache/.ready-v2")
    if not marker.exists():
        subprocess.run(
            ["python", "-c", f"""
from huggingface_hub import hf_hub_download
import os, tarfile
for fname in {TARBALLS!r}:
    p = hf_hub_download("3DAIGC/LAM-assets", fname)
    with tarfile.open(p) as t:
        t.extractall("/cache")
    os.remove(p)
    print("extracted", fname, flush=True)
"""],
            check=True,
        )
        marker.touch()

    if not Path(MODEL_DIR).exists():
        subprocess.run(
            ["python", "-c", f"""
from huggingface_hub import snapshot_download
snapshot_download("3DAIGC/LAM-20K", local_dir="{MODEL_DIR}")
"""],
            check=True,
        )
    return MODEL_DIR


def _link_tree(src: str, dst: str) -> None:
    """Expose `src` at `dst` without copying, merging into an existing tree.

    Both /opt/LAM/assets and /opt/LAM/model_zoo already exist in the repo, so we
    cannot simply symlink the directory — link the children instead and recurse
    where both sides are directories.
    """
    s, d = Path(src), Path(dst)
    if not s.exists():
        return
    d.mkdir(parents=True, exist_ok=True)
    for child in s.iterdir():
        target = d / child.name
        if child.is_dir():
            _link_tree(str(child), str(target))
        else:
            if target.is_symlink():
                target.unlink()
            elif target.exists():
                continue
            target.symlink_to(child)


def _run(photo: bytes, name: str) -> bytes:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError(
            "no GPU in the container. The NGC base image always prints "
            "'NVIDIA Driver was not detected' at boot, so this check is the "
            "reliable one — it means the function really did not get a GPU."
        )
    print(f"[gpu] {torch.cuda.get_device_name(0)}", flush=True)

    model_dir = _ensure_assets()
    _link_tree("/cache/assets", "/opt/LAM/assets")
    _link_tree("/cache/model_zoo", "/opt/LAM/model_zoo")

    work = Path("/tmp/work")
    work.mkdir(parents=True, exist_ok=True)
    photo_path = work / (name or "me.jpg")
    photo_path.write_bytes(photo)
    out = work / "export"
    out.mkdir(exist_ok=True)

    cmd = [
        "python", "/opt/avatarhq/export_avatar.py",
        "--lam-root", "/opt/LAM",
        "--config", "configs/inference/lam-20k-8gpu.yaml",
        "--model", model_dir,
        "--image", str(photo_path),
        "--motion", "/cache/assets/sample_motion/export/Look_In_My_Eyes",
        "--out", str(out),
    ]
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd="/opt/LAM")

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for f in sorted(out.iterdir()):
            tar.add(f, arcname=f.name)
    return buf.getvalue()


@app.function(image=image, gpu="A10G", volumes={"/cache": cache}, timeout=3 * 60 * 60)
def export_a10g(photo: bytes, name: str) -> bytes:
    return _run(photo, name)


@app.function(image=image, gpu="A100-40GB", volumes={"/cache": cache}, timeout=3 * 60 * 60)
def export_a100(photo: bytes, name: str) -> bytes:
    return _run(photo, name)


@app.local_entrypoint()
def main(photo: str, out: str = "me-export", gpu: str = "a10g"):
    src = Path(photo)
    if not src.exists():
        raise SystemExit(f"no such photo: {photo}")

    fn = export_a100 if gpu.lower().startswith("a100") else export_a10g
    print(f"[modal] uploading {src.name}, gpu={gpu}", flush=True)
    blob = fn.remote(src.read_bytes(), src.name)

    dest = Path(out)
    dest.mkdir(parents=True, exist_ok=True)
    tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz").extractall(dest)

    print(f"[modal] wrote {dest}/")
    for f in sorted(dest.iterdir()):
        print(f"  {f.name}  {f.stat().st_size / 1e6:.1f} MB")
    print(f"\nnext: node tools/import-lam.mjs --in {dest} --out assets/me.avtr")
