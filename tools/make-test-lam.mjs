#!/usr/bin/env node
// Synthetic stand-in for a LAM export, so tools/import-lam.mjs can be tested
// without a GPU, a FLAME licence, or anyone's face.
//
//   node tools/make-test-lam.mjs --out /tmp/lam-test
//   node tools/import-lam.mjs --in /tmp/lam-test --out /tmp/lam-test.avtr
//
// Produces the exact directory layout tools/lam/export_avatar.py writes:
//   verts.npy (V,3)  faces.npy (F,3)  gaussians.npy (N,14)  deltas.npy (52,V,3)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodeNpy } from './npy.mjs';
import { ARKIT_NAMES } from './arkit-map.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = resolve(opt('out', '/tmp/lam-test'));
const LON = 40, LAT = 24;
const NGAUSS = Number(opt('count', 8000));

// ---- a head-ish ellipsoid ------------------------------------------------
const verts = [];
const uvs = [];
for (let j = 0; j <= LAT; j++) {
  const th = (j / LAT) * Math.PI;
  for (let i = 0; i <= LON; i++) {
    const ph = (i / LON) * Math.PI * 2;
    const d = [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)];
    // squash into a head: taller than wide, jaw taper, flatten the back
    let x = d[0] * 0.075, y = d[1] * 0.10, z = d[2] * 0.088;
    const down = Math.max(0, -y / 0.10);
    const taper = 1 - 0.45 * down * down;
    x *= taper; z *= taper;
    if (z < 0) z *= 0.9;
    verts.push(x, y, z);
    uvs.push(i / LON, j / LAT);
  }
}
const idxOf = (j, i) => j * (LON + 1) + i;
const faces = [];
for (let j = 0; j < LAT; j++) {
  for (let i = 0; i < LON; i++) {
    const a = idxOf(j, i), b = idxOf(j, i + 1), c = idxOf(j + 1, i), d = idxOf(j + 1, i + 1);
    faces.push(a, c, b, b, c, d);
  }
}
const nv = verts.length / 3;

// ---- per-channel vertex displacements ------------------------------------
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const gauss = (d, s) => Math.exp(-(d * d) / (2 * s * s));

function field(name, x, y, z) {
  const ax = Math.abs(x);
  const front = smooth(-0.03, 0.04, z);
  const jaw = smooth(-0.02, -0.06, y) * front;
  const mouth = gauss(Math.hypot(ax - 0.02, y + 0.045), 0.012);
  const brow = gauss(y - 0.042, 0.012) * front;
  const eye = gauss(Math.hypot(ax - 0.028, y - 0.012), 0.010);
  switch (name) {
    case 'jawOpen': return [0, -0.020 * jaw, 0.004 * jaw];
    case 'mouthSmileLeft': return [0.004 * mouth * (x > 0), 0.005 * mouth * (x > 0), 0];
    case 'mouthSmileRight': return [-0.004 * mouth * (x < 0), 0.005 * mouth * (x < 0), 0];
    case 'mouthFunnel': return [-x * 0.08 * mouth, 0, 0.006 * mouth];
    case 'mouthPucker': return [-x * 0.18 * mouth, 0, 0.010 * mouth];
    case 'browInnerUp': return [0, 0.006 * brow, 0];
    case 'browOuterUpLeft': return [0, 0.005 * brow * (x > 0), 0];
    case 'browOuterUpRight': return [0, 0.005 * brow * (x < 0), 0];
    case 'browDownLeft': return [0, -0.004 * brow * (x > 0), 0];
    case 'browDownRight': return [0, -0.004 * brow * (x < 0), 0];
    case 'eyeBlinkLeft': return [0, -0.008 * eye * (x > 0), 0];
    case 'eyeBlinkRight': return [0, -0.008 * eye * (x < 0), 0];
    case 'eyeLookOutLeft': return [0.002 * eye * (x > 0), 0, 0];
    case 'eyeLookOutRight': return [-0.002 * eye * (x < 0), 0, 0];
    case 'eyeLookInLeft': return [-0.002 * eye * (x > 0), 0, 0];
    case 'eyeLookInRight': return [0.002 * eye * (x < 0), 0, 0];
    case 'eyeLookUpLeft': return [0, 0.002 * eye * (x > 0), 0];
    case 'eyeLookUpRight': return [0, 0.002 * eye * (x < 0), 0];
    case 'eyeLookDownLeft': return [0, -0.002 * eye * (x > 0), 0];
    case 'eyeLookDownRight': return [0, -0.002 * eye * (x < 0), 0];
    case 'cheekPuff': return [Math.sign(x) * 0.004 * gauss(Math.hypot(ax - 0.04, y + 0.03), 0.02), 0, 0.003 * gauss(Math.hypot(ax - 0.04, y + 0.03), 0.02)];
    case 'noseSneerLeft': return [0, 0.002 * gauss(Math.hypot(x, y + 0.005), 0.012), 0];
    case 'noseSneerRight': return [0, 0.002 * gauss(Math.hypot(x, y + 0.005), 0.012), 0];
    default: return [0, 0, 0];
  }
}

const deltas = new Float32Array(ARKIT_NAMES.length * nv * 3);
for (let k = 0; k < ARKIT_NAMES.length; k++) {
  for (let v = 0; v < nv; v++) {
    const d = field(ARKIT_NAMES[k], verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
    const o = (k * nv + v) * 3;
    deltas[o] = d[0]; deltas[o + 1] = d[1]; deltas[o + 2] = d[2];
  }
}

// ---- gaussians scattered on the surface ----------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(1234);
const nf = faces.length / 3;

const areas = new Float32Array(nf);
let total = 0;
for (let f = 0; f < nf; f++) {
  const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
  const e1 = [verts[b * 3] - verts[a * 3], verts[b * 3 + 1] - verts[a * 3 + 1], verts[b * 3 + 2] - verts[a * 3 + 2]];
  const e2 = [verts[c * 3] - verts[a * 3], verts[c * 3 + 1] - verts[a * 3 + 1], verts[c * 3 + 2] - verts[a * 3 + 2]];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  areas[f] = 0.5 * Math.hypot(...cr);
  total += areas[f];
}

const G = new Float32Array(NGAUSS * 14);
let cursor = 0;
let cum = 0;
for (let s = 0; s < NGAUSS; s++) {
  const r = ((s + rnd()) / NGAUSS) * total;
  while (cursor < nf - 1 && cum + areas[cursor] < r) { cum += areas[cursor]; cursor++; }
  const a = faces[cursor * 3], b = faces[cursor * 3 + 1], c = faces[cursor * 3 + 2];
  const u = Math.sqrt(rnd()), v = rnd();
  const b0 = 1 - u, b1 = u * (1 - v), b2 = u * v;
  const o = s * 14;
  for (let k = 0; k < 3; k++) {
    G[o + k] = b0 * verts[a * 3 + k] + b1 * verts[b * 3 + k] + b2 * verts[c * 3 + k];
  }
  G[o + 3] = 0.0016; G[o + 4] = 0.0016; G[o + 5] = 0.0009;
  // orient each splat to the face normal so they do not render edge-on
  const e1 = [verts[b * 3] - verts[a * 3], verts[b * 3 + 1] - verts[a * 3 + 1], verts[b * 3 + 2] - verts[a * 3 + 2]];
  const e2 = [verts[c * 3] - verts[a * 3], verts[c * 3 + 1] - verts[a * 3 + 1], verts[c * 3 + 2] - verts[a * 3 + 2]];
  let nx = e1[1] * e2[2] - e1[2] * e2[1];
  let ny = e1[2] * e2[0] - e1[0] * e2[2];
  let nz = e1[0] * e2[1] - e1[1] * e2[0];
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (nz < -0.99999) { G[o + 6] = 0; G[o + 7] = 1; G[o + 8] = 0; G[o + 9] = 0; }
  else {
    const ql = Math.hypot(-ny, nx, 0, 1 + nz);
    G[o + 6] = -ny / ql; G[o + 7] = nx / ql; G[o + 8] = 0; G[o + 9] = (1 + nz) / ql;
  }
  G[o + 10] = 0.62; G[o + 11] = 0.42; G[o + 12] = 0.34;
  G[o + 13] = 0.9;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'verts.npy'), encodeNpy(Float32Array.from(verts), [nv, 3]));
writeFileSync(join(out, 'faces.npy'), encodeNpy(Uint32Array.from(faces).map ? Float32Array.from(faces) : Float32Array.from(faces), [nf, 3]));
writeFileSync(join(out, 'gaussians.npy'), encodeNpy(G, [NGAUSS, 14]));
writeFileSync(join(out, 'deltas.npy'), encodeNpy(deltas, [ARKIT_NAMES.length, nv, 3]));
writeFileSync(join(out, 'meta.json'), JSON.stringify({
  source: 'synthetic fixture (tools/make-test-lam.mjs)',
  channels: ARKIT_NAMES,
  gaussianColumns: ['x', 'y', 'z', 's0', 's1', 's2', 'qx', 'qy', 'qz', 'qw', 'r', 'g', 'b', 'opacity'],
}, null, 2));

console.log(`wrote ${out}: ${nv} verts, ${nf} tris, ${NGAUSS} gaussians, ${ARKIT_NAMES.length} channels`);
