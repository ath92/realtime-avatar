#!/usr/bin/env python3
"""Dump a LAM avatar in the form tools/import-lam.mjs expects.

Run this on the GPU box, inside the LAM environment, after `scripts/inference.sh`
has worked at least once. It drives LAM's own runner and then writes the pieces
that LAM normally keeps in memory:

    verts.npy       (V,3)      FLAME canonical vertices for this identity
    faces.npy       (F,3)      FLAME topology (upsampled)
    gaussians.npy   (N,14)     xyz, scale3, quat4, rgb3, opacity
    deltas.npy      (52,V,3)   per-vertex displacement of each ARKit channel
    meta.json                  column names + provenance

The deltas come straight out of FLAME's blendshape basis, so they are exact:
channel k's displacement at weight 1 is a column of `flame_model.shapedirs`.

    python tools/lam/export_avatar.py \
        --lam-root /workspace/LAM \
        --config configs/inference/lam-20k-8gpu.yaml \
        --model model_zoo/lam_models/releases/lam/lam-20k/step_045500 \
        --image /workspace/me.jpg \
        --motion assets/sample_motion/export/Look_In_My_Eyes \
        --out /workspace/me-export
"""

import argparse
import json
import os
import sys
import tempfile
import traceback

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lam-root', required=True, help='path to the LAM checkout')
    ap.add_argument('--config', default='configs/inference/lam-20k-8gpu.yaml')
    ap.add_argument('--model', required=True, help='checkpoint dir (…/step_045500)')
    ap.add_argument('--image', required=True, help='your photo')
    ap.add_argument('--motion', required=True, help='a motion sequence dir, e.g. assets/sample_motion/export/Look_In_My_Eyes')
    ap.add_argument('--out', required=True, help='output directory')
    args = ap.parse_args()

    lam_root = os.path.abspath(args.lam_root)
    os.chdir(lam_root)
    sys.path.insert(0, lam_root)
    os.environ['PYTHONPATH'] = lam_root + ':' + os.environ.get('PYTHONPATH', '')
    os.environ.setdefault('APP_ENABLED', '')

    # LAM's runner reads its configuration from the command line.
    sys.argv = [
        'lam.launch', 'infer.lam',
        '--config', args.config,
        f'model_name={args.model}',
        f'image_input={os.path.abspath(args.image)}',
        'export_video=False', 'export_mesh=False',
        f'motion_seqs_dir={os.path.abspath(args.motion)}',
        'save_ply=False', 'save_img=False',
        'vis_motion=False', 'motion_img_need_mask=False',
    ]

    from lam.runners.infer.lam import LAMInferrer
    import torch

    inferrer = LAMInferrer()

    captured = {}
    original = inferrer.model.infer_single_view

    def hooked(*a, **kw):
        out = original(*a, **kw)
        captured['res'] = out
        captured['flame_params'] = kw.get('flame_params')
        return out

    inferrer.model.infer_single_view = hooked

    tmp = tempfile.mkdtemp(prefix='lam-export-')
    try:
        inferrer.infer_single(
            os.path.abspath(args.image),
            motion_seqs_dir=os.path.abspath(args.motion),
            motion_img_dir=None,
            motion_video_read_fps=30,
            export_video=False,
            export_mesh=False,
            dump_tmp_dir=tmp,
            dump_image_dir=None,
            dump_video_path=os.path.join(tmp, 'out.mp4'),
            dump_mesh_path=os.path.join(tmp, 'mesh.ply'),
            gaga_track_type='',
        )
    except Exception:
        traceback.print_exc()
        print('\n[export] LAM itself failed; nothing to dump.')
        return 1
    finally:
        inferrer.model.infer_single_view = original

    res = captured.get('res')
    if res is None or 'cano_gs_lst' not in res:
        print('[export] could not capture cano_gs_lst — the LAM API moved. Send me this log.')
        return 1

    gs = res['cano_gs_lst'][0]
    fm = inferrer.model.renderer.flame_model
    betas = captured['flame_params']['betas']

    os.makedirs(args.out, exist_ok=True)

    # --- gaussians ---------------------------------------------------------
    def np_(t):
        return t.detach().float().cpu().numpy()

    xyz = np_(gs.offset) if getattr(gs, 'offset', None) is not None else np_(gs.xyz)
    scale = np_(gs.scaling)
    rot = np_(gs.rotation)
    opacity = np_(gs.opacity).reshape(-1)
    shs = np_(gs.shs)
    rgb = shs[:, :3] if shs.ndim == 2 else shs[:, 0, :3]

    # rotation may be stored as a raw quaternion or as (w,x,y,z); normalise and
    # emit xyzw, which is what glTF and the renderer expect.
    q = rot.copy()
    if np.abs(np.linalg.norm(q, axis=1) - 1).mean() > 0.2:
        q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-8)
    if np.abs(rot[:, 3]).mean() > 0.9 and np.abs(rot[:, 0]).mean() < 0.3:
        q = rot[:, [1, 2, 3, 0]]  # wxyz -> xyzw

    gaussians = np.concatenate([
        xyz.astype(np.float32),
        scale.astype(np.float32),
        q.astype(np.float32),
        rgb.astype(np.float32),
        opacity.astype(np.float32)[:, None],
    ], axis=1)

    np.save(os.path.join(args.out, 'gaussians.npy'), gaussians)

    # --- FLAME mesh + basis ------------------------------------------------
    with torch.no_grad():
        verts = fm.get_cano_verts(shape_params=betas)[0]
    verts = np_(verts)
    faces = fm.faces.detach().cpu().numpy().astype(np.uint32)

    np.save(os.path.join(args.out, 'verts.npy'), verts.astype(np.float32))
    np.save(os.path.join(args.out, 'faces.npy'), faces)

    # ARKit basis lives right after the identity basis in shapedirs
    n_shape = int(fm.n_shape_params)
    basis = fm.shapedirs[:, :, n_shape:n_shape + 52]
    deltas = basis.permute(2, 0, 1).detach().float().cpu().numpy()  # (52, V, 3)
    np.save(os.path.join(args.out, 'deltas.npy'), deltas.astype(np.float32))

    arkit = [
        'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
        'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight',
        'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
        'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
        'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
        'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft',
        'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft',
        'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight',
        'mouthPucker', 'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower',
        'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft',
        'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft',
        'noseSneerRight', 'tongueOut',
    ]

    with open(os.path.join(args.out, 'meta.json'), 'w') as f:
        json.dump({
            'source': 'LAM',
            'image': os.path.abspath(args.image),
            'channels': arkit,
            'gaussianColumns': ['x', 'y', 'z', 's0', 's1', 's2', 'qx', 'qy', 'qz', 'qw', 'r', 'g', 'b', 'opacity'],
            'verts': int(verts.shape[0]),
            'faces': int(faces.shape[0]),
            'gaussians': int(gaussians.shape[0]),
            'note': 'deltas are FLAME blendshape directions, weight-1 displacements',
        }, f, indent=2)

    print()
    print(f'gaussians {gaussians.shape[0]:,}')
    print(f'mesh      {verts.shape[0]:,} verts, {faces.shape[0]:,} tris')
    print(f'deltas    {deltas.shape}  max {np.abs(deltas).max() * 1000:.1f} mm')
    print(f'written   {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
