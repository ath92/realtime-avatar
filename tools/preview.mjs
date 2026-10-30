#!/usr/bin/env node
// Software renderer for the .avtr rig — no GPU, no browser.
//
// It implements the same projection and anisotropic-splat maths as the WebGL2
// path in client/splat.js, so it doubles as a reference for debugging the
// shader and as a way to eyeball the rig from CI.
//
//   node tools/preview.mjs --out preview.png --yaw 0.25 --expr jawOpen=0.5

import { readFileSync, writeFileSync } from 'node:fs';
import { decodeAvatar } from '../shared/format.mjs';
import { encodePNG } from './png.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const W = Number(opt('w', 768));
const H = Number(opt('h', 768));
const fovY = (Number(opt('fov', 30)) * Math.PI) / 180;
const yaw = Number(opt('yaw', 0));
const pitch = Number(opt('pitch', 0));
const camDist = Number(opt('dist', 0.62));
const bg = Number(opt('bg', 0.10));

const raw = readFileSync(opt('in', 'assets/me.avtr'));
const avatar = decodeAvatar(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const { n, nb, names } = avatar;

// ---- expression -----------------------------------------------------------
const expr = new Float32Array(nb);
for (let i = 0; i < args.length; i++) {
  const m = /^([A-Za-z_]+)=([-\d.]+)$/.exec(args[i]);
  if (m) {
    const k = names.indexOf(m[1]);
    if (k < 0) throw new Error(`unknown channel ${m[1]}`);
    expr[k] = Number(m[2]);
  }
}
// Convenience presets so previews are one flag.
const preset = opt('preset', null);
if (preset === 'smile') { expr[names.indexOf('mouthSmile_L')] = 1; expr[names.indexOf('mouthSmile_R')] = 1; }
if (preset === 'talk') { expr[names.indexOf('jawOpen')] = 0.55; expr[names.indexOf('mouthFunnel')] = 0.4; }
if (preset === 'blink') { expr[names.indexOf('eyeBlink_L')] = 1; expr[names.indexOf('eyeBlink_R')] = 1; }

// ---- camera ---------------------------------------------------------------
const eye = [0, 0.012, camDist];
const target = [0, -0.012, 0];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const fwd = nrm(sub3(target, eye));
const right = nrm(cross3(fwd, [0, 1, 0]));
const upv = cross3(right, fwd);
// world -> camera: rows are right/up/-fwd
const Rcam = [right, upv, [-fwd[0], -fwd[1], -fwd[2]]];

// head pose
const cy = Math.cos(yaw), sy = Math.sin(yaw);
const cp = Math.cos(pitch), sp = Math.sin(pitch);
const Ryaw = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
const Rpitch = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
const mm = (A, B) => {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  }
  return C;
};
const Rhead = mm(Rpitch, Ryaw);
const Wc = mm(Rcam, Rhead); // world->camera rotation composed with head rotation

const focal = (0.5 * H) / Math.tan(fovY / 2);
const zbuf = [];

// ---- per-gaussian ---------------------------------------------------------
const pos = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  let x = avatar.positions[i * 3], y = avatar.positions[i * 3 + 1], z = avatar.positions[i * 3 + 2];
  for (let b = 0; b < nb; b++) {
    const w = avatar.weights[i * nb + b] * expr[b];
    if (w === 0) continue;
    const o = (i * nb + b) * 3;
    x += avatar.deltas[o] * w; y += avatar.deltas[o + 1] * w; z += avatar.deltas[o + 2] * w;
  }
  pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
}

const list = [];
for (let i = 0; i < n; i++) {
  const lx = pos[i * 3], ly = pos[i * 3 + 1], lz = pos[i * 3 + 2];
  const px = Rhead[0][0] * lx + Rhead[0][1] * ly + Rhead[0][2] * lz;
  const py = Rhead[1][0] * lx + Rhead[1][1] * ly + Rhead[1][2] * lz;
  const pz = Rhead[2][0] * lx + Rhead[2][1] * ly + Rhead[2][2] * lz;
  const t = [
    Rcam[0][0] * px + Rcam[0][1] * py + Rcam[0][2] * pz - dot3(Rcam[0], eye),
    Rcam[1][0] * px + Rcam[1][1] * py + Rcam[1][2] * pz - dot3(Rcam[1], eye),
    Rcam[2][0] * px + Rcam[2][1] * py + Rcam[2][2] * pz - dot3(Rcam[2], eye),
  ];
  const zc = -t[2];
  if (zc < 0.05) continue;

  // A = J * Wc * Rg * S   (3x3); cov2 = (A * A^T)[0:2][0:2]
  const qx = avatar.quats[i * 4], qy = avatar.quats[i * 4 + 1];
  const qz = avatar.quats[i * 4 + 2], qw = avatar.quats[i * 4 + 3];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const Rg = [
    [1 - 2 * (yy + zz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (xx + zz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (xx + yy)],
  ];
  const sx = avatar.scales[i * 3], sy2 = avatar.scales[i * 3 + 1], sz = avatar.scales[i * 3 + 2];
  const M = mm(Wc, mm(Rg, [[sx, 0, 0], [0, sy2, 0], [0, 0, sz]]));
  const J = [
    [focal / zc, 0, (-focal * t[0]) / (zc * zc)],
    [0, focal / zc, (-focal * t[1]) / (zc * zc)],
    [0, 0, 0],
  ];
  const A = mm(J, M);
  let a = 0, b2 = 0, c = 0;
  for (let k = 0; k < 3; k++) {
    a += A[0][k] * A[0][k];
    b2 += A[0][k] * A[1][k];
    c += A[1][k] * A[1][k];
  }
  a += 0.3; c += 0.3;

  const mid = 0.5 * (a + c);
  const diff = Math.sqrt(Math.max(0, 0.25 * (a - c) * (a - c) + b2 * b2));
  const l1 = mid + diff, l2 = Math.max(1e-8, mid - diff);
  const rad = 3 * Math.sqrt(l1);
  const cx = W / 2 + (focal * t[0]) / zc;
  const cyy = H / 2 - (focal * t[1]) / zc;
  list.push({ i, zc, cx, cyy, rad, a, b: b2, c, l1, l2 });
}

list.sort((p, q) => q.zc - p.zc); // far -> near

// ---- rasterise ------------------------------------------------------------
const buf = new Float32Array(W * H * 3);
for (let i = 0; i < W * H; i++) { buf[i * 3] = bg; buf[i * 3 + 1] = bg * 1.05; buf[i * 3 + 2] = bg * 1.2; }

for (const g of list) {
  const i = g.i;
  const r = avatar.colors[i * 3], gr = avatar.colors[i * 3 + 1], bl = avatar.colors[i * 3 + 2];
  const op = avatar.opacity[i];
  const det = Math.max(1e-9, g.a * g.c - g.b * g.b);
  const ia = g.c / det, ib = -g.b / det, ic = g.a / det;
  const x0 = Math.max(0, Math.floor(g.cx - g.rad)), x1 = Math.min(W - 1, Math.ceil(g.cx + g.rad));
  const y0 = Math.max(0, Math.floor(g.cyy - g.rad)), y1 = Math.min(H - 1, Math.ceil(g.cyy + g.rad));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - g.cyy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - g.cx;
      const p = ia * dx * dx + 2 * ib * dx * dy + ic * dy * dy;
      if (p > 4.5) continue;
      const al = op * Math.exp(-0.5 * p);
      if (al < 0.004) continue;
      const o = (y * W + x) * 3;
      const k = 1 - al;
      buf[o] = buf[o] * k + r * al;
      buf[o + 1] = buf[o + 1] * k + gr * al;
      buf[o + 2] = buf[o + 2] * k + bl * al;
    }
  }
}

// ---- tonemap + output -----------------------------------------------------
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  for (let c = 0; c < 3; c++) {
    const v = buf[i * 3 + c];
    const s = v / (1 + v);
    rgba[i * 4 + c] = Math.round(255 * Math.pow(Math.min(1, s), 1 / 2.2));
  }
  rgba[i * 4 + 3] = 255;
}

const out = opt('out', 'preview.png');
writeFileSync(out, encodePNG(W, H, rgba));
console.log(`${out}  ${W}x${H}  ${list.length}/${n} gaussians visible`);
