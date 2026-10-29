#!/usr/bin/env node
// Darken the mouth cavity of an avatar, and optionally give it a backdrop.
//
//   node tools/paint-mouth.mjs --in assets/me.avtr --out assets/me.avtr --backdrop
//
// LAM reconstructs only what the photo showed. With the mouth closed there is no
// cavity to learn from, so opening the jaw uncovers the inside of the face shell,
// which is skin-coloured. The mouth is located from the rig itself: the front-most
// Gaussians weighted to jawOpen, near the centre line, are the lower lip.
//
// Nothing here is model-specific — it works on any avatar with a jawOpen channel.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeAvatar, encodeAvatar } from '../shared/format.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const input = resolve(opt('in', 'assets/me.avtr'));
const out = resolve(opt('out', input));
const backdrop = has('backdrop');
const cavityColor = [0.075, 0.015, 0.018];   // deep red-black
const lipColor = [0.32, 0.10, 0.10];

const raw = readFileSync(input);
const a = decodeAvatar(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const { n, nb, names } = a;
const jaw = names.indexOf('jawOpen');
if (jaw < 0) {
  console.error('this avatar has no jawOpen channel; nothing to locate the mouth with');
  process.exit(1);
}

// ---- locate the mouth ----------------------------------------------------
let maxZ = -Infinity;
for (let i = 0; i < n; i++) maxZ = Math.max(maxZ, a.positions[i * 3 + 2]);

let mx = 0, my = 0, mz = -Infinity, found = 0;
for (let i = 0; i < n; i++) {
  const x = a.positions[i * 3], y = a.positions[i * 3 + 1], z = a.positions[i * 3 + 2];
  if (Math.abs(x) < 0.03 && a.weights[i * nb + jaw] > 0.5 && z > maxZ - 0.05) {
    if (z > mz) { mz = z; found = 1; }
  }
}
if (!found) { console.error('could not find the lower lip'); process.exit(1); }
// average the centre-line lower lip for a stable centre
let ax = 0, ay = 0, c = 0;
for (let i = 0; i < n; i++) {
  const x = a.positions[i * 3], y = a.positions[i * 3 + 1], z = a.positions[i * 3 + 2];
  if (Math.abs(x) < 0.025 && a.weights[i * nb + jaw] > 0.5 && z > mz - 0.01) { ax += x; ay += y; c++; }
}
mx = ax / c; my = ay / c;

// mouth aperture: how far apart the lips get at full jawOpen
let aperture = 0;
for (let i = 0; i < n; i++) {
  const w = a.weights[i * nb + jaw];
  const o = (i * nb + jaw) * 3;
  if (w > 0.2) aperture = Math.max(aperture, Math.abs(a.deltas[o + 1]) * w);
}
console.log(`mouth at (${mx.toFixed(3)}, ${my.toFixed(3)}, ${mz.toFixed(3)})  aperture ~${(aperture * 1000).toFixed(1)} mm`);

// ---- paint the cavity ----------------------------------------------------
// A tight ellipsoid hanging *behind* the lip line. The vertical radius has to
// stay small: the chin curves back too, so a generous box catches the jaw and
// paints your beard dark.
const halfW = 0.022, halfH = 0.011, depth = 0.045;
const cz = mz - 0.020;
let painted = 0;
for (let i = 0; i < n; i++) {
  const x = a.positions[i * 3], y = a.positions[i * 3 + 1], z = a.positions[i * 3 + 2];
  const dx = (x - mx) / halfW;
  const dy = (y - my) / halfH;
  const dz = (z - cz) / depth;
  if (dx * dx + dy * dy + dz * dz > 1) continue;
  if (z > mz - 0.004) continue;             // keep the outer lips their own colour
  painted++;

  // deeper = darker; the rim keeps a reddish inner-lip tint
  const t = Math.min(1, Math.max(0, (mz - z) / 0.03));
  const col = [
    lipColor[0] + (cavityColor[0] - lipColor[0]) * t,
    lipColor[1] + (cavityColor[1] - lipColor[1]) * t,
    lipColor[2] + (cavityColor[2] - lipColor[2]) * t,
  ];
  a.colors[i * 3] = col[0];
  a.colors[i * 3 + 1] = col[1];
  a.colors[i * 3 + 2] = col[2];
  a.opacity[i] = Math.max(a.opacity[i], 0.85);
}
console.log(`painted ${painted} cavity gaussians`);

// ---- optional backdrop ---------------------------------------------------
// A shallow dome behind the lips, so an open mouth shows darkness rather than
// the inside of the skull. Weighted 0.5 to the jaw so it follows the chin a little.
let extra = 0;
if (backdrop) {
  const cols = [];
  const radius = Math.max(0.020, aperture * 1.6);
  const M = 1400;
  for (let k = 0; k < M; k++) {
    const r = Math.sqrt((k + 0.5) / M);
    const ang = k * 2.399963;                     // golden angle
    const x = mx + Math.cos(ang) * r * radius * 1.35;
    const y = my + Math.sin(ang) * r * radius * 0.85;
    const z = mz - 0.045 - 0.012 * (1 - r * r);
    const shade = 0.5 + 0.5 * r;
    cols.push({ x, y, z, shade });
  }
  extra = cols.length;
  console.log(`adding ${extra} backdrop gaussians (radius ${(radius * 1000).toFixed(0)} mm)`);
  void cols;
}

const total = n + extra;
const positions = new Float32Array(total * 3);
const scales = new Float32Array(total * 3);
const quats = new Float32Array(total * 4);
const colors = new Float32Array(total * 3);
const opacity = new Float32Array(total);
const weights = new Float32Array(total * nb);
const deltas = new Float32Array(total * nb * 3);

positions.set(a.positions); scales.set(a.scales); quats.set(a.quats);
colors.set(a.colors); opacity.set(a.opacity); weights.set(a.weights); deltas.set(a.deltas);

if (backdrop) {
  const radius = Math.max(0.020, aperture * 1.6);
  const M = extra;
  for (let k = 0; k < M; k++) {
    const r = Math.sqrt((k + 0.5) / M);
    const ang = k * 2.399963;
    const i = n + k;
    positions[i * 3] = mx + Math.cos(ang) * r * radius * 1.35;
    positions[i * 3 + 1] = my + Math.sin(ang) * r * radius * 0.85;
    positions[i * 3 + 2] = mz - 0.045 - 0.012 * (1 - r * r);
    const sc = 0.0022 * (0.7 + 0.6 * r);
    scales[i * 3] = sc; scales[i * 3 + 1] = sc; scales[i * 3 + 2] = sc * 0.6;
    quats[i * 4 + 3] = 1;                          // identity, facing +z
    const shade = 0.6 + 0.4 * (1 - r);
    colors[i * 3] = cavityColor[0] * shade;
    colors[i * 3 + 1] = cavityColor[1] * shade;
    colors[i * 3 + 2] = cavityColor[2] * shade;
    opacity[i] = 0.95;
    // follow the jaw halfway, so it does not stay nailed in place as the chin drops
    weights[i * nb + jaw] = 0.5;
    deltas[(i * nb + jaw) * 3 + 1] = -aperture * 0.5;
  }
}

const outAvatar = { n: total, nb, names, positions, scales, quats, colors, opacity, weights, deltas };
writeFileSync(out, encodeAvatar(outAvatar));
console.log(`wrote ${out}  ${total.toLocaleString()} gaussians`);
