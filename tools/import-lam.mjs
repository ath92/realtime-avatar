#!/usr/bin/env node
// Import a LAM avatar (FLAME-space Gaussians) as a .avtr rig.
//
//   node tools/import-lam.mjs --in out/me --out assets/me.avtr
//
// LAM gives you canonical Gaussians and a FLAME mesh; it does not give you a
// blendshape rig. This reconstructs one:
//
//  1. bind every Gaussian to its nearest triangle on the FLAME mesh
//     (barycentric weights),
//  2. for each ARKit expression, take the per-vertex displacement the caller
//     dumped from FLAME,
//  3. push it through the same barycentric weights to get a per-Gaussian delta.
//
// Step 1 is the part that is normally lost when a tool exports "just the .ply".

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { loadNpy } from './npy.mjs';
import { encodeAvatar, layout } from '../shared/format.mjs';
import { ARKIT_MAP, ARKIT_NAMES } from './arkit-map.mjs';
import { CHANNELS as RIG_CHANNELS } from './rig.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => args.includes(`--${n}`);

const dir = resolve(opt('in', '.'));
const output = resolve(opt('out', 'assets/head.avtr'));
const fitHeight = Number(opt('fit', 0.30));
const doCenter = !has('no-center');
const minWeight = Number(opt('min-weight', 1e-6));
// Positions are gs.xyz (the anchor). gs.offset, if present, is a displacement.
// LAM (and the 3DGS PLY convention) store rotation as (w, x, y, z); the renderer
// wants (x, y, z, w). Getting this wrong turns every splat on its side.
const rotOrder = (opt('rot-order', 'wxyz') || 'wxyz').toLowerCase();
// LAM's renderer scales splats at draw time via `scaling_modifier`; the stored
// values are not what you see. This exposes that factor.
const scaleMul = Number(opt('scale-mul', 1));

const basisPath = opt('basis', null);
const need = ['gaussians.npy', 'verts.npy', 'faces.npy'];
if (!basisPath) need.push('deltas.npy');
for (const f of need) {
  if (!existsSync(join(dir, f))) {
    console.error(`missing ${join(dir, f)}\nrun tools/lam/export_avatar.py on the GPU box first`);
    process.exit(1);
  }
}

const G = loadNpy(join(dir, 'gaussians.npy'));   // (N, 14)
const V = loadNpy(join(dir, 'verts.npy'));       // (V, 3)
const F = loadNpy(join(dir, 'faces.npy'));       // (F, 3)
const D = basisPath ? null : loadNpy(join(dir, 'deltas.npy'));  // (52, V, 3)

if (G.shape.length !== 2 || G.shape[1] < 11) {
  console.error(`gaussians.npy should be (N, >=11): xyz, scale, rot, rgb, opacity`);
  process.exit(1);
}
const stride = G.shape[1];
const n = G.shape[0];
const nv = V.shape[0];
const nf = F.shape[0];
if (D) {
  if (D.shape[0] !== ARKIT_NAMES.length) {
    console.warn(`warning: deltas has ${D.shape[0]} channels, expected ${ARKIT_NAMES.length}`);
  }
  if (D.shape[1] !== nv) {
    console.error(`deltas has ${D.shape[1]} vertices but verts.npy has ${nv} — mismatched dump`);
    process.exit(1);
  }
}

// ---- channel deltas ------------------------------------------------------
// A LAM avatar is driven by FLAME's 100-d expression basis, which has no names.
// Its *shape keys*, however, are ARKit's 52 and are identity-independent — the
// same basis for every face. Given a GLB that carries them (LAM's own avatar
// export, e.g. skin.glb), we can rig any identity by bending it through them.
const nb = RIG_CHANNELS.length;
const deltaTable = new Float32Array(nb * nv * 3);

if (basisPath) {
  const { parseGLB, extractMesh, preparePrimitive } = await import('./glb.mjs');
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(resolve(basisPath));
  const { json, bin } = parseGLB(Buffer.from(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
  const { prims } = extractMesh(json, bin);
  const prim = preparePrimitive(json, bin, prims[0]);
  if (!prim || !prim.targets.length) throw new Error(`${basisPath} has no morph targets`);
  if (prim.pos.length / 3 !== nv) {
    console.error(`basis mesh has ${prim.pos.length / 3} verts but verts.npy has ${nv}`);
    process.exit(1);
  }
  const byName = new Map(prim.targets.map((t, i) => [t.name, i]));
  let found = 0;
  for (const [arkit, channel, sign, div] of ARKIT_MAP) {
    const ti = byName.get(arkit);
    if (ti === undefined) continue;
    found++;
    const c = RIG_CHANNELS.indexOf(channel);
    if (c < 0) continue;
    const src = prim.targets[ti].pos;
    for (let v = 0; v < nv; v++) {
      const o = (c * nv + v) * 3;
      deltaTable[o] += (src[v * 3] * sign) / div;
      deltaTable[o + 1] += (src[v * 3 + 1] * sign) / div;
      deltaTable[o + 2] += (src[v * 3 + 2] * sign) / div;
    }
  }
  console.log(`basis     ${found}/${ARKIT_MAP.length} ARKit keys found in ${basisPath}`);
} else {
  const D52 = D.data;
  for (const [arkit, channel, sign, div] of ARKIT_MAP) {
    const k = ARKIT_NAMES.indexOf(arkit);
    const c = RIG_CHANNELS.indexOf(channel);
    if (k < 0 || c < 0 || k >= D.shape[0]) continue;
    for (let v = 0; v < nv; v++) {
      const o = (c * nv + v) * 3;
      const src = (k * nv + v) * 3;
      deltaTable[o] += (D52[src] * sign) / div;
      deltaTable[o + 1] += (D52[src + 1] * sign) / div;
      deltaTable[o + 2] += (D52[src + 2] * sign) / div;
    }
  }
}

// ---- triangle acceleration structure -------------------------------------
const verts = V.data;
const faces = F.data;

function tri(i) {
  const a = faces[i * 3] | 0, b = faces[i * 3 + 1] | 0, c = faces[i * 3 + 2] | 0;
  return [a, b, c];
}

// mean edge length -> grid cell size
let edgeSum = 0;
for (let i = 0; i < nf; i++) {
  const [a, b, c] = tri(i);
  edgeSum += Math.hypot(verts[a * 3] - verts[b * 3], verts[a * 3 + 1] - verts[b * 3 + 1], verts[a * 3 + 2] - verts[b * 3 + 2]);
}
const cell = Math.max(1e-4, (edgeSum / nf) * 2.0);

let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < nv; i++) {
  minX = Math.min(minX, verts[i * 3]); maxX = Math.max(maxX, verts[i * 3]);
  minY = Math.min(minY, verts[i * 3 + 1]); maxY = Math.max(maxY, verts[i * 3 + 1]);
  minZ = Math.min(minZ, verts[i * 3 + 2]); maxZ = Math.max(maxZ, verts[i * 3 + 2]);
}
const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);

const grid = new Map();
const cellKey = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
for (let i = 0; i < nf; i++) {
  const [a, b, c] = tri(i);
  const lo = [
    Math.floor((Math.min(verts[a * 3], verts[b * 3], verts[c * 3]) - minX) / cell),
    Math.floor((Math.min(verts[a * 3 + 1], verts[b * 3 + 1], verts[c * 3 + 1]) - minY) / cell),
    Math.floor((Math.min(verts[a * 3 + 2], verts[b * 3 + 2], verts[c * 3 + 2]) - minZ) / cell),
  ];
  const hi = [
    Math.floor((Math.max(verts[a * 3], verts[b * 3], verts[c * 3]) - minX) / cell),
    Math.floor((Math.max(verts[a * 3 + 1], verts[b * 3 + 1], verts[c * 3 + 1]) - minY) / cell),
    Math.floor((Math.max(verts[a * 3 + 2], verts[b * 3 + 2], verts[c * 3 + 2]) - minZ) / cell),
  ];
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        const k = cellKey(x, y, z);
        let list = grid.get(k);
        if (!list) { list = []; grid.set(k, list); }
        list.push(i);
      }
    }
  }
}

// Closest point on a triangle, returning barycentric coordinates.
function closestBary(px, py, pz, a, b, c) {
  const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
  const bx = verts[b * 3], by = verts[b * 3 + 1], bz = verts[b * 3 + 2];
  const cx = verts[c * 3], cy = verts[c * 3 + 1], cz = verts[c * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0, apx * apx + apy * apy + apz * apz];

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0, bpx * bpx + bpy * bpy + bpz * bpz];

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + abx * v - px, qy = ay + aby * v - py, qz = az + abz * v - pz;
    return [1 - v, v, 0, qx * qx + qy * qy + qz * qz];
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1, cpx * cpx + cpy * cpy + cpz * cpz];

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + acx * w - px, qy = ay + acy * w - py, qz = az + acz * w - pz;
    return [1 - w, 0, w, qx * qx + qy * qy + qz * qz];
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + (cx - bx) * w - px, qy = by + (cy - by) * w - py, qz = bz + (cz - bz) * w - pz;
    return [0, 1 - w, w, qx * qx + qy * qy + qz * qz];
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = ax + abx * v + acx * w - px;
  const qy = ay + aby * v + acy * w - py;
  const qz = az + abz * v + acz * w - pz;
  return [1 - v - w, v, w, qx * qx + qy * qy + qz * qz];
}

function nearestBary(px, py, pz) {
  const gx = Math.floor((px - minX) / cell);
  const gy = Math.floor((py - minY) / cell);
  const gz = Math.floor((pz - minZ) / cell);

  let best = { b: [1, 0, 0], dist: Infinity, tri: -1 };
  for (let r = 0; r <= 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const list = grid.get(cellKey(gx + dx, gy + dy, gz + dz));
          if (!list) continue;
          for (let t = 0; t < list.length; t++) {
            const [a, b, c] = tri(list[t]);
            const res = closestBary(px, py, pz, a, b, c);
            if (res[3] < best.dist) best = { b: [res[0], res[1], res[2]], dist: res[3], tri: list[t] };
          }
        }
      }
    }
    // a hit in ring r is only trustworthy once we have searched ring r+1
    if (best.dist < Infinity && r >= 1) break;
  }
  return best;
}

// ---- bind ----------------------------------------------------------------
const positions = new Float32Array(n * 3);
const scales = new Float32Array(n * 3);
const quats = new Float32Array(n * 4);
const colors = new Float32Array(n * 3);
const opacity = new Float32Array(n);
const weights = new Float32Array(n * nb);
const deltas = new Float32Array(n * nb * 3);

let bindErrors = 0;
for (let i = 0; i < n; i++) {
  const o = i * stride;
  const px = G.data[o], py = G.data[o + 1], pz = G.data[o + 2];
  positions[i * 3] = px;
  positions[i * 3 + 1] = py;
  positions[i * 3 + 2] = pz;
  scales[i * 3] = G.data[o + 3];
  scales[i * 3 + 1] = G.data[o + 4];
  scales[i * 3 + 2] = G.data[o + 5];
  if (rotOrder === 'wxyz') {
    quats[i * 4] = G.data[o + 7];
    quats[i * 4 + 1] = G.data[o + 8];
    quats[i * 4 + 2] = G.data[o + 9];
    quats[i * 4 + 3] = G.data[o + 6];
  } else {
    quats[i * 4] = G.data[o + 6];
    quats[i * 4 + 1] = G.data[o + 7];
    quats[i * 4 + 2] = G.data[o + 8];
    quats[i * 4 + 3] = G.data[o + 9];
  }
  colors[i * 3] = G.data[o + 10];
  colors[i * 3 + 1] = G.data[o + 11];
  colors[i * 3 + 2] = G.data[o + 12];
  opacity[i] = G.data[o + 13];

  const hit = nearestBary(px, py, pz);
  if (!Number.isFinite(hit.dist) || hit.tri < 0) { bindErrors++; continue; }
  const [b0, b1, b2] = hit.b;
  const [ia, ib, ic] = tri(hit.tri);

  for (let c = 0; c < nb; c++) {
    const base = c * nv * 3;
    const dx = b0 * deltaTable[base + ia * 3] + b1 * deltaTable[base + ib * 3] + b2 * deltaTable[base + ic * 3];
    const dy = b0 * deltaTable[base + ia * 3 + 1] + b1 * deltaTable[base + ib * 3 + 1] + b2 * deltaTable[base + ic * 3 + 1];
    const dz = b0 * deltaTable[base + ia * 3 + 2] + b1 * deltaTable[base + ib * 3 + 2] + b2 * deltaTable[base + ic * 3 + 2];
    if (dx === 0 && dy === 0 && dz === 0) continue;
    const oo = (i * nb + c) * 3;
    deltas[oo] = dx;
    deltas[oo + 1] = dy;
    deltas[oo + 2] = dz;
  }
}

// ---- normalise ------------------------------------------------------------
let loY = Infinity, hiY = -Infinity;
let loX = Infinity, hiX = -Infinity;
let loZ = Infinity, hiZ = -Infinity;
for (let i = 0; i < n; i++) {
  loX = Math.min(loX, positions[i * 3]); hiX = Math.max(hiX, positions[i * 3]);
  loY = Math.min(loY, positions[i * 3 + 1]); hiY = Math.max(hiY, positions[i * 3 + 1]);
  loZ = Math.min(loZ, positions[i * 3 + 2]); hiZ = Math.max(hiZ, positions[i * 3 + 2]);
}
const height = hiY - loY || 1;
const scale = fitHeight > 0 ? fitHeight / height : 1;
const cx = (loX + hiX) / 2, cy = (loY + hiY) / 2, cz = (loZ + hiZ) / 2;

for (let i = 0; i < n; i++) {
  positions[i * 3] = (positions[i * 3] - (doCenter ? cx : 0)) * scale;
  positions[i * 3 + 1] = (positions[i * 3 + 1] - (doCenter ? cy : 0)) * scale;
  positions[i * 3 + 2] = (positions[i * 3 + 2] - (doCenter ? cz : 0)) * scale;
  scales[i * 3] *= scale * scaleMul;
  scales[i * 3 + 1] *= scale * scaleMul;
  scales[i * 3 + 2] *= scale * scaleMul;
}
for (let i = 0; i < deltas.length; i++) deltas[i] *= scale;

let moving = 0;
for (let i = 0; i < n; i++) {
  for (let b = 0; b < nb; b++) {
    const o = (i * nb + b) * 3;
    const m = Math.hypot(deltas[o], deltas[o + 1], deltas[o + 2]);
    if (m > minWeight) { weights[i * nb + b] = 1; moving++; }
  }
}

// ---- write ----------------------------------------------------------------
const avatar = { n, nb, names: RIG_CHANNELS, positions, scales, quats, colors, opacity, weights, deltas };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, encodeAvatar(avatar));

console.log(`gaussians  ${n.toLocaleString()}`);
console.log(`mesh       ${nv.toLocaleString()} verts, ${nf.toLocaleString()} tris`);
console.log(`bound      ${(n - bindErrors).toLocaleString()}${bindErrors ? `  (${bindErrors} failed)` : ''}`);
console.log(`height     ${(height * 100).toFixed(1)} cm -> ${(height * scale * 100).toFixed(1)} cm`);
console.log(`moves      ${moving.toLocaleString()} channel-gaussians (${((moving / (n * nb)) * 100).toFixed(1)}%)`);
console.log(`payload    ${(layout(n, nb).bytes / 1e6).toFixed(2)} MB`);
console.log(`written    ${output}`);
