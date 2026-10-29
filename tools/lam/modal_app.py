"""Run the LAM export on a rented GPU without touching a shell.

    pip install modal
    modal token new                     # one browser click, once ever
    modal run tools/lam/modal_app.py --photo me.jpg

Modal builds the image (once, ~40 min, cached after), provisions a GPU,
downloads the LAM assets into a persistent Volume (once), runs the export, and
writes ./me-export back to your machine. Then:

    node tools/import-lam.mjs --in ./me-export --out assets/me.avtr

Cost is the GPU minutes only — a few cents per avatar once the image is cached.

Nothing here is exercised by the repo's tests: it needs a GPU and a Modal
account. If the image build fails, the log line that failed is usually enough
for a one-line fix.
"""

from __future__ import annotations

import io
import os
import subprocess
import tarfile
from pathlib import Path

import modal

HERE = Path(__file__).parent
LAM_COMMIT = "339573649dd93df4cba8093a964e85a80d1b61f3"  # pinned: LAM's API moves

app = modal.App("lam-avatar")

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04", add_python="3.10"
    )
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
    .pip_install(
        "torch==2.3.0", "torchvision==0.18.0", "torchaudio==2.3.0",
        index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install("xformers==0.0.26.post1", index_url="https://download.pytorch.org/whl/cu121")
    # pytorch3d + diff-gaussian-rasterization + nvdiffrast + simple-knn: the slow layer
    .run_commands("cd /opt/LAM && pip install -r requirements.txt")
    .run_commands("cd /opt/LAM/external/landmark_detection/FaceBoxesV2/utils && sh make.sh")
    .add_local_file(HERE / "export_avatar.py", "/opt/avatarhq/export_avatar.py")
)

cache = modal.Volume.from_name("lam-assets", create_if_missing=True)
HF = {"HF_HOME": "/cache/hf"}


def _ensure_assets() -> str:
    """Download the FLAME template, sample motions and weights into the volume."""
    marker = Path("/cache/.ready")
    if not marker.exists():
        subprocess.run(
            ["python", "-c", """
from huggingface_hub import hf_hub_download
import tarfile, huggingface_hub
for fname in ("LAM_assets.tar", "LAM_human_model.tar"):
    p = hf_hub_download("3DAIGC/LAM-assets", fname)
    with tarfile.open(p) as t:
        t.extractall("/cache")
    print("extracted", fname, flush=True)
"""],
            check=True,
        )
        marker.touch()

    model_dir = Path("/cache/model_zoo/lam_models/releases/lam/lam-20k/step_045500")
    if not model_dir.exists():
        subprocess.run(
            ["python", "-c", """
from huggingface_hub import snapshot_download
snapshot_download("3DAIGC/LAM-20K",
                  local_dir="/cache/model_zoo/lam_models/releases/lam/lam-20k")
"""],
            check=True,
        )
    return str(model_dir)


def _run(photo: bytes, name: str, gpu_minutes: int) -> bytes:
    model_dir = _ensure_assets()

    work = Path("/tmp/work")
    work.mkdir(parents=True, exist_ok=True)
    photo_path = work / (name or "me.jpg")
    photo_path.write_bytes(photo)
    out = work / "export"
    out.mkdir(exist_ok=True)

    # LAM expects its assets next to its own tree
    for src, dst in [("/cache/assets", "/opt/LAM/assets"), ("/cache", "/opt/LAM/model_zoo")]:
        p = Path(dst)
        if p.is_symlink() or p.exists():
            if p.is_symlink():
                p.unlink()
        p.symlink_to(src)

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


@app.function(image=image, volumes={"/cache": cache}, timeout=3 * 60 * 60)
def export_a10g(photo: bytes, name: str) -> bytes:
    return _run(photo, name, 0)


@app.function(image=image, gpu="A100-40GB", volumes={"/cache": cache}, timeout=3 * 60 * 60)
def export_a100(photo: bytes, name: str) -> bytes:
    return _run(photo, name, 0)


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
