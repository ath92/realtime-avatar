#!/usr/bin/env node
// Import a rigged head mesh (GLB with ARKit shape keys) as a .avtr Gaussian rig.
//
//   node tools/import-mesh.mjs --in me.glb --out assets/me.avtr
//   node tools/import-mesh.mjs --in me.glb --list        # just show the shape keys
//
// How it works: sample points on the mesh surface (area-weighted), attach one
// Gaussian to each, then bake every morph target into a per-Gaussian delta via
// barycentric interpolation. A morph target in glTF is already a per-vertex
// displacement, so
//
//     delta[g][k] = b0*d[v0][k] + b1*d[v1][k] + b2*d[v2][k]
//
// is exact, not an approximation. The result is the same rig the procedural head
// uses, so the client and the renderer need no changes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseGLB, extractMesh, preparePrimitive, buildTexture, mat4 } from './glb.mjs';
import { encodeAvatar, layout } from '../shared/format.mjs';
import { CHANNELS as RIG_CHANNELS } from './rig.mjs';

// ---- ARKit -> rig channel mapping ----------------------------------------
// w is the sign, div normalises channels that are composed from several keys
// (the two eyes, or left+right sneer). Anything not listed here is dropped.
const MAP = [
  ['jawOpen', 'jawOpen', 1, 1],
  ['mouthSmileLeft', 'mouthSmile_L', 1, 1],
  ['mouthSmileRight', 'mouthSmile_R', 1, 1],
  ['mouthFunnel', 'mouthFunnel', 1, 1],
  ['mouthPucker', 'mouthPucker', 1, 1],
  ['browInnerUp', 'browInnerUp', 1, 1],
  ['browOuterUpLeft', 'browOuterUp_L', 1, 1],
  ['browOuterUpRight', 'browOuterUp_R', 1, 1],
  ['browDownLeft', 'browDown_L', 1, 1],
  ['browDownRight', 'browDown_R', 1, 1],
  ['eyeBlinkLeft', 'eyeBlink_L', 1, 1],
  ['eyeBlinkRight', 'eyeBlink_R', 1, 1],
  ['eyeLookOutLeft', 'eyeLookX', 1, 2],
  ['eyeLookOutRight', 'eyeLookX', 1, 2],
  ['eyeLookInLeft', 'eyeLookX', -1, 2],
  ['eyeLookInRight', 'eyeLookX', -1, 2],
  ['eyeLookUpLeft', 'eyeLookY', 1, 2],
  ['eyeLookUpRight', 'eyeLookY', 1, 2],
  ['eyeLookDownLeft', 'eyeLookY', -1, 2],
  ['eyeLookDownRight', 'eyeLookY', -1, 2],
  ['cheekPuff', 'cheekPuff', 1, 1],
  ['noseSneerLeft', 'noseSneer', 1, 2],
  ['noseSneerRight', 'noseSneer', 1, 2],
];

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => args.includes(`--${n}`);

const input = opt('in');
if (!input || input === true) {
  console.error('usage: node tools/import-mesh.mjs --in <file.glb> [--out assets/me.avtr] [--count 40000]');
  process.exit(1);
}
const output = resolve(opt('out', 'assets/head.avtr'));
const wantCount = Number(opt('count', 40000));
const fitHeight = Number(opt('fit', 0.30));   // metres; 0 disables rescaling
const doCenter = !has('no-center');

// ---- parse ----------------------------------------------------------------
const buf = readFileSync(resolve(input));
const { json, bin } = parseGLB(buf);
const { prims } = extractMesh(json, bin);
if (!prims.length) throw new Error('no triangle primitives found in the GLB');

// Which shape keys does this file actually have, and in what order per primitive?
const firstNames = prims[0].names || [];
const allNames = new Set();
for (const p of prims) for (const n of p.names) allNames.add(n);

if (has('list')) {
  console.log(`${allNames.size} shape keys:`);
  for (const n of allNames) {
    const m = MAP.find(([arkit]) => arkit === n);
    console.log(`  ${n}${m ? `  -> ${m[1]}` : '  (not mapped)'}`);
  }
  process.exit(0);
}
if (!allNames.size) {
  console.error('this GLB has no morph targets — it is not a rigged avatar.\n' +
    'Expected a mesh with ARKit shape keys (jawOpen, eyeBlinkLeft, …).');
  process.exit(1);
}

// ---- gather triangles -----------------------------------------------------
const tris = [];
let totalArea = 0;
const prepared = [];
for (const entry of prims) {
  const p = preparePrimitive(json, bin, entry);
  if (!p) continue;
  const tex = buildTexture(json, bin, p.material);
  p.targetIdx = new Map((p.targets || []).map((t, i) => [t.name, i]));
  prepared.push({ ...p, tex });
}

for (const p of prepared) {
  const { pos, world, idx } = p;
  const n = idx.length / 3;
  for (let t = 0; t < n; t++) {
    const i0 = idx[t * 3] | 0;
    const i1 = idx[t * 3 + 1] | 0;
    const i2 = idx[t * 3 + 2] | 0;
    const a = mat4.point(world, pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]);
    const b = mat4.point(world, pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]);
    const c = mat4.point(world, pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const area = 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
    if (!(area > 0)) continue;
    totalArea += area;
    tris.push({ p, i0, i1, i2, area, cum: totalArea });
  }
}
if (!tris.length) throw new Error('no non-degenerate triangles');
if (!(totalArea > 0)) throw new Error('degenerate geometry');

// ---- sample ---------------------------------------------------------------
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
const rnd = mulberry32(0x5eed);

const n = wantCount;
const positions = new Float32Array(n * 3);
const scales = new Float32Array(n * 3);
const quats = new Float32Array(n * 4);
const colors = new Float32Array(n * 3);
const opacity = new Float32Array(n);
const nb = RIG_CHANNELS.length;
const deltas = new Float32Array(n * nb * 3);
const weights = new Float32Array(n * nb);

const spacing = Math.sqrt(totalArea / n);
const sigma = spacing * 0.62;

const targetIndexFor = (p, name) => (p.targetIdx.has(name) ? p.targetIdx.get(name) : -1);

const quatFromZ = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  const nz = v[2] / l;
  if (nz < -0.99999) return [0, 1, 0, 0];
  const q = [-v[1] / l, v[0] / l, 0, 1 + nz];
  const ql = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
};

let cursor = 0;
for (let s = 0; s < n; s++) {
  // Stratified sample: one jittered point per 1/n of total area. Monotone, so a
  // single forward sweep replaces a binary search per sample.
  const r = ((s + rnd()) / n) * totalArea;
  while (cursor < tris.length - 1 && tris[cursor].cum < r) cursor++;
  const tri = tris[cursor];
  const { p, i0, i1, i2 } = tri;

  const u = Math.sqrt(rnd());
  const v = rnd();
  const b0 = 1 - u;
  const b1 = u * (1 - v);
  const b2 = u * v;

  const { pos, nrm, uv, col, world, tex } = p;
  const q = (arr, i, k) => arr[i * 3 + k];

  const gx = b0 * q(pos, i0, 0) + b1 * q(pos, i1, 0) + b2 * q(pos, i2, 0);
  const gy = b0 * q(pos, i0, 1) + b1 * q(pos, i1, 1) + b2 * q(pos, i2, 1);
  const gz = b0 * q(pos, i0, 2) + b1 * q(pos, i1, 2) + b2 * q(pos, i2, 2);
  const wp = mat4.point(world, gx, gy, gz);
  positions[s * 3] = wp[0];
  positions[s * 3 + 1] = wp[1];
  positions[s * 3 + 2] = wp[2];

  // normal
  let nx = 0, ny = 0, nz = 1;
  if (nrm) {
    nx = b0 * q(nrm, i0, 0) + b1 * q(nrm, i1, 0) + b2 * q(nrm, i2, 0);
    ny = b0 * q(nrm, i0, 1) + b1 * q(nrm, i1, 1) + b2 * q(nrm, i2, 1);
    nz = b0 * q(nrm, i0, 2) + b1 * q(nrm, i1, 2) + b2 * q(nrm, i2, 2);
  }
  const wd = mat4.dir(world, nx, ny, nz);
  const wl = Math.hypot(wd[0], wd[1], wd[2]) || 1;
  const qq = quatFromZ([wd[0] / wl, wd[1] / wl, wd[2] / wl]);
  quats.set(qq, s * 4);

  scales[s * 3] = sigma;
  scales[s * 3 + 1] = sigma;
  scales[s * 3 + 2] = sigma * 0.45;
  opacity[s] = 0.92;

  // colour
  let cr = 0.78, cg = 0.6, cb = 0.5;
  if (tex && tex.width) {
    if (uv) {
      const tu = b0 * uv[i0 * 2] + b1 * uv[i1 * 2] + b2 * uv[i2 * 2];
      const tv = b0 * uv[i0 * 2 + 1] + b1 * uv[i1 * 2 + 1] + b2 * uv[i2 * 2 + 1];
      [cr, cg, cb] = tex.sample(tu, tv);
    }
  } else if (col) {
    cr = b0 * col[i0 * 3] + b1 * col[i1 * 3] + b2 * col[i2 * 3];
    cg = b0 * col[i0 * 3 + 1] + b1 * col[i1 * 3 + 1] + b2 * col[i2 * 3 + 1];
    cb = b0 * col[i0 * 3 + 2] + b1 * col[i1 * 3 + 2] + b2 * col[i2 * 3 + 2];
  } else if (tex) {
    [cr, cg, cb] = tex.factor.slice(0, 3);
  }
  // texture samples are sRGB; the shader tonemaps, so hand it linear
  colors[s * 3] = Math.pow(clamp01(cr), 2.2);
  colors[s * 3 + 1] = Math.pow(clamp01(cg), 2.2);
  colors[s * 3 + 2] = Math.pow(clamp01(cb), 2.2);

  // deltas
  for (const [arkit, channel, sign, div] of MAP) {
    const ti = targetIndexFor(p, arkit);
    if (ti < 0) continue;
    const disp = p.targets[ti].pos;
    if (!disp) continue;
    const c = RIG_CHANNELS.indexOf(channel);
    if (c < 0) continue;
    const o = (s * nb + c) * 3;
    const dx = (b0 * q(disp, i0, 0) + b1 * q(disp, i1, 0) + b2 * q(disp, i2, 0)) * sign / div;
    const dy = (b0 * q(disp, i0, 1) + b1 * q(disp, i1, 1) + b2 * q(disp, i2, 1)) * sign / div;
    const dz = (b0 * q(disp, i0, 2) + b1 * q(disp, i1, 2) + b2 * q(disp, i2, 2)) * sign / div;
    // transform the displacement into world space
    const w3 = mat4.dir(world, dx, dy, dz);
    deltas[o] += w3[0];
    deltas[o + 1] += w3[1];
    deltas[o + 2] += w3[2];
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ---- normalise ------------------------------------------------------------
// FLAME exports are often z-up; detect it rather than trusting the node graph.
let extZ = 0, extY = 0;
{
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i * 3 + c];
      if (v < a[c]) a[c] = v;
      if (v > b[c]) b[c] = v;
    }
  }
  extY = b[1] - a[1];
  extZ = b[2] - a[2];
}
if (extZ > extY * 1.15) {
  // z-up -> y-up: (x, y, z) -> (x, z, -y)
  for (let i = 0; i < n; i++) {
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    positions[i * 3 + 1] = z;
    positions[i * 3 + 2] = -y;
    const dy = deltas[i * nb * 3 + 1], dz = deltas[i * nb * 3 + 2];
    void dy; void dz;
  }
  // rotate the deltas the same way
  for (let i = 0; i < n * nb; i++) {
    const y = deltas[i * 3 + 1];
    const z = deltas[i * 3 + 2];
    deltas[i * 3 + 1] = z;
    deltas[i * 3 + 2] = -y;
  }
  console.log('  rotated  z-up -> y-up');
}

let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < n; i++) {
  minX = Math.min(minX, positions[i * 3]); maxX = Math.max(maxX, positions[i * 3]);
  minY = Math.min(minY, positions[i * 3 + 1]); maxY = Math.max(maxY, positions[i * 3 + 1]);
  minZ = Math.min(minZ, positions[i * 3 + 2]); maxZ = Math.max(maxZ, positions[i * 3 + 2]);
}
const height = maxY - minY || 1;
const scale = fitHeight > 0 ? fitHeight / height : 1;
const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
const cz = (minZ + maxZ) / 2;

for (let i = 0; i < n; i++) {
  positions[i * 3] = (positions[i * 3] - (doCenter ? cx : 0)) * scale;
  positions[i * 3 + 1] = (positions[i * 3 + 1] - (doCenter ? cy : 0)) * scale;
  positions[i * 3 + 2] = (positions[i * 3 + 2] - (doCenter ? cz : 0)) * scale;
  scales[i * 3] *= scale;
  scales[i * 3 + 1] *= scale;
  scales[i * 3 + 2] *= scale;
}
for (let i = 0; i < deltas.length; i++) deltas[i] *= scale;

// weights: 1 where the channel actually moves this Gaussian, else 0
let moving = 0;
for (let i = 0; i < n; i++) {
  for (let b = 0; b < nb; b++) {
    const o = (i * nb + b) * 3;
    const m = Math.hypot(deltas[o], deltas[o + 1], deltas[o + 2]);
    if (m > 1e-7) { weights[i * nb + b] = 1; moving++; }
  }
}

// ---- write ----------------------------------------------------------------
const avatar = { n, nb, names: RIG_CHANNELS, positions, scales, quats, colors, opacity, weights, deltas };
const bytes = encodeAvatar(avatar);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, bytes);

const found = MAP.filter(([arkit]) => allNames.has(arkit)).map(([, c]) => c);
const foundSet = [...new Set(found)];
const missing = RIG_CHANNELS.filter((c) => !foundSet.includes(c));

console.log(`triangles  ${tris.length.toLocaleString()}`);
console.log(`surface    ${totalArea.toFixed(4)} m²  (spacing ${(spacing * 1000).toFixed(1)} mm)`);
console.log(`gaussians  ${n.toLocaleString()}`);
console.log(`scale      ${scale.toFixed(3)}  (height ${(height * 100).toFixed(1)} cm -> ${(height * scale * 100).toFixed(1)} cm)`);
console.log(`channels   ${foundSet.length}/${nb} driven by this file`);
if (missing.length) console.log(`  missing  ${missing.join(', ')}`);
console.log(`moves      ${moving.toLocaleString()} channel-gaussians (${((moving / (n * nb)) * 100).toFixed(1)}%)`);
console.log(`payload    ${(layout(n, nb).bytes / 1e6).toFixed(2)} MB`);
console.log(`written    ${output}`);
