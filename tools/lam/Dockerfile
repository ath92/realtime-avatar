# LAM + our exporter, in one image.
#
#   docker build -f tools/lam/Dockerfile -t lam-avatar .
#   docker run --gpus all -v "$PWD":/work -v lam-assets:/assets lam-avatar me.jpg
#
# Build is slow the first time (~30-45 min) because pytorch3d and the
# gaussian rasteriser compile from source. Nothing in here needs a GPU to
# *build*, only to run.
#
# Assets (FLAME template, sample motions, weights) are downloaded at run time
# into /assets so you can mount a volume and pay that cost once.

FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0" \
    PYTHONPATH=/opt/LAM

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3.10-dev python3.10-distutils python3-pip \
      git wget curl build-essential cmake ninja-build pkg-config \
      ffmpeg libgl1 libglib2.0-0 libsm6 libxext6 libgomp1 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.10 \
    && rm -rf /var/lib/apt/lists/*

# ---- LAM, pinned --------------------------------------------------------
# Pinned to the revision the exporter was written against: LAM's API moves.
ARG LAM_COMMIT=339573649dd93df4cba8093a964e85a80d1b61f3
RUN git clone https://github.com/aigc3d/LAM /opt/LAM \
    && cd /opt/LAM && git checkout ${LAM_COMMIT}

# ---- python deps --------------------------------------------------------
RUN pip install torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0 \
      --index-url https://download.pytorch.org/whl/cu121 \
    && pip install xformers==0.0.26.post1 \
      --index-url https://download.pytorch.org/whl/cu121

# requirements.txt builds pytorch3d / diff-gaussian-rasterization / nvdiffrast /
# simple-knn from git. This is the 30 minute step.
RUN cd /opt/LAM && pip install -r requirements.txt

# FaceBoxes CUDA extension used by LAM's face tracker
RUN cd /opt/LAM/external/landmark_detection/FaceBoxesV2/utils && sh make.sh

COPY tools/lam/export_avatar.py /opt/avatarhq/export_avatar.py
COPY tools/lam/docker-entry.sh /opt/avatarhq/entry.sh
RUN chmod +x /opt/avatarhq/entry.sh

WORKDIR /opt/LAM
ENTRYPOINT ["/opt/avatarhq/entry.sh"]
