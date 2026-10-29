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


def prepare_photo(image_path, out_dir, mask_path=None, no_mask=False):
    """Return a JPG path with a matching `.png` mask beside it.

    LAM's preprocess_image() uses the image's alpha if it has one, else the mask
    file, else rembg (not installed). We take the third option off the table by
    always producing a mask: a supplied one, or a GrabCut matte seeded by the
    face box. OpenCV is already a hard dependency of LAM, so this adds nothing.
    """
    import cv2
    import numpy as np

    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(image_path))[0]
    out_jpg = os.path.join(out_dir, stem + '.jpg')
    out_png = os.path.join(out_dir, stem + '.png')

    rgb = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if rgb is None:
        raise SystemExit(f'cannot read image: {image_path}')
    cv2.imwrite(out_jpg, rgb, [cv2.IMWRITE_JPEG_QUALITY, 95])

    if no_mask:
        cv2.imwrite(out_png, np.full(rgb.shape[:2], 255, np.uint8))
        return out_jpg

    if mask_path:
        m = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
        if m is None:
            raise SystemExit(f'cannot read mask: {mask_path}')
        if m.shape != rgb.shape[:2]:
            m = cv2.resize(m, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(out_png, (m > 127).astype(np.uint8) * 255)
        return out_jpg

    h, w = rgb.shape[:2]
    # work at a sane resolution: GrabCut is O(pixels) and this only produces a matte
    scale = min(1.0, 768.0 / max(h, w))
    small = cv2.resize(rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    sh, sw = small.shape[:2]

    rect = None
    try:
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        cascade = cv2.CascadeClassifier(
            os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'))
        faces = cascade.detectMultiScale(gray, 1.1, 5,
                                         minSize=(max(24, int(min(sh, sw) * 0.10)),) * 2)
        if len(faces):
            fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            # expand to head + shoulders, clamped
            side = int(max(fw, fh) * 2.6)
            cx, cy = fx + fw // 2, fy + fh // 2 + int(fh * 0.35)
            x0 = max(0, cx - side // 2); y0 = max(0, cy - side // 2)
            x1 = min(sw, cx + side // 2); y1 = min(sh, cy + side // 2)
            if x1 - x0 > 20 and y1 - y0 > 20:
                rect = (x0, y0, x1 - x0, y1 - y0)
        print(f'[mask] face box {"found" if rect else "not found"}', flush=True)
    except Exception as exc:  # noqa: BLE001 - any cv2 failure falls back to a rect
        print(f'[mask] detection failed ({exc}); using a centred rect', flush=True)

    if rect is None:
        side = int(min(sh, sw) * 0.86)
        rect = ((sw - side) // 2, max(0, int(sh * 0.04)), side, min(side, sh - 4))

    # GrabCut initialised from a rect needs definite-background pixels *outside*
    # it; if the face box expands to the frame edge there are none, and OpenCV
    # fails with `!bgdSamples.empty() && !fgdSamples.empty()`. Shrink to 80% and
    # keep a 2 px border.
    x, y, rw, rh = rect
    rw = min(rw, int(sw * 0.80))
    rh = min(rh, int(sh * 0.80))
    x = max(1, min(x + (rect[2] - rw) // 2, sw - rw - 2))
    y = max(1, min(y + (rect[3] - rh) // 2, sh - rh - 2))
    rect = (x, y, rw, rh)

    alpha = None
    try:
        gc = np.zeros((sh, sw), np.uint8)
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(small, gc, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
        alpha = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
        frac = float((alpha > 0).mean())
        print(f'[mask] grabcut kept {frac * 100:.0f}% of the frame', flush=True)
        if frac < 0.03 or frac > 0.97:
            alpha = None
    except Exception as exc:  # noqa: BLE001
        print(f'[mask] grabcut failed ({exc})', flush=True)

    if alpha is None:
        alpha = np.zeros((sh, sw), np.uint8)
        cv2.ellipse(alpha, (sw // 2, int(sh * 0.52)),
                    (int(sw * 0.42), int(sh * 0.46)), 0, 0, 360, 255, -1)

    alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=max(2.0, min(sh, sw) / 200.0))
    if scale < 1.0:
        alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LINEAR)
    cv2.imwrite(out_png, alpha)
    return out_jpg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lam-root', required=True, help='path to the LAM checkout')
    ap.add_argument('--config', default='configs/inference/lam-20k-8gpu.yaml')
    ap.add_argument('--model', required=True, help='checkpoint dir (…/step_045500)')
    ap.add_argument('--image', required=True, help='your photo')
    ap.add_argument('--motion', required=True, help='a motion sequence dir, e.g. assets/sample_motion/export/Look_In_My_Eyes')
    ap.add_argument('--out', required=True, help='output directory')
    ap.add_argument('--mask', default=None, help='foreground mask (white = face); generated if omitted')
    ap.add_argument('--no-mask', action='store_true', help='skip masking entirely')
    args = ap.parse_args()

    lam_root = os.path.abspath(args.lam_root)
    os.chdir(lam_root)
    sys.path.insert(0, lam_root)
    os.environ['PYTHONPATH'] = lam_root + ':' + os.environ.get('PYTHONPATH', '')
    os.environ.setdefault('APP_ENABLED', '')

    # LAM wants a foreground mask next to the photo. If it finds none it imports
    # rembg, which is not in its requirements. So we always hand it a JPG plus a
    # same-named PNG mask, which is the path its loader derives:
    #   mask_path = image_path.replace('/images/', '/fg_masks/').replace('.jpg', '.png')
    work = os.path.join(tempfile.mkdtemp(prefix='lam-photo-'), '')
    photo = prepare_photo(args.image, work, args.mask, args.no_mask)

    # LAM's runner reads its configuration from the command line.
    sys.argv = [
        'lam.launch', 'infer.lam',
        '--config', args.config,
        f'model_name={args.model}',
        f'image_input={photo}',
        # parse_configs asserts that at least one of these is set; the canonical
        # Gaussians do not depend on either, so keep the cheapest one on.
        'export_video=True', 'export_mesh=False',
        'motion_img_dir=null',
        # [default] keys in parse_configs that inference.sh passes explicitly and
        # that are absent from the yaml
        'render_fps=30', 'render_views=1',
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
            photo,
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
    # vertices are upsampled (20 018 for subdivide=1), so the basis must be too
    shapedirs = getattr(fm, 'shapedirs_up', None)
    if shapedirs is None:
        shapedirs = fm.shapedirs
    if shapedirs.shape[0] != verts.shape[0]:
        raise RuntimeError(
            f'basis has {shapedirs.shape[0]} verts but the mesh has {verts.shape[0]}; '
            'FLAME tessellation mismatch')
    basis = shapedirs[:, :, n_shape:n_shape + 52]
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
