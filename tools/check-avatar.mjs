#!/usr/bin/env node
// Validate a .avtr rig before you ship it.
//
//   node tools/check-avatar.mjs assets/me.avtr
//
// Catches the failure modes that are silent at runtime: non-finite data,
// channels nothing drives, channels the audio pipeline emits but the asset does
// not have, a rig that moves the wrong part of the head, and assets in the wrong
// units (a 1.7 m head in a 0.3 m frame, or vice versa).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeAvatar } from '../shared/format.mjs';
import { CHANNELS as RIG_CHANNELS } from './rig.mjs';

// What the audio pipeline and the idle layer actually drive.
const DRIVERS = [
  'jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthSmile_L', 'mouthSmile_R',
  'browInnerUp', 'browOuterUp_L', 'browOuterUp_R',
  'eyeBlink_L', 'eyeBlink_R', 'eyeLookX', 'eyeLookY', 'cheekPuff',
];

// Roughly where each channel is allowed to live, in head-local metres.
// Generous boxes: these catch a swapped or mirrored rig, not millimetre drift.
const REGION = {
  jawOpen: { y: [-0.25, 0.02], label: 'lower face' },
  mouthSmile_L: { x: [0.0, 0.2], y: [-0.15, 0.0], label: 'left mouth corner' },
  mouthSmile_R: { x: [-0.2, 0.0], y: [-0.15, 0.0], label: 'right mouth corner' },
  mouthFunnel: { y: [-0.15, 0.02], label: 'mouth' },
  mouthPucker: { y: [-0.15, 0.02], label: 'mouth' },
  browInnerUp: { y: [0.0, 0.25], label: 'brow' },
  browOuterUp_L: { x: [0.0, 0.2], y: [0.0, 0.25], label: 'left brow' },
  browOuterUp_R: { x: [-0.2, 0.0], y: [0.0, 0.25], label: 'right brow' },
  browDown_L: { x: [0.0, 0.2], y: [0.0, 0.25], label: 'left brow' },
  browDown_R: { x: [-0.2, 0.0], y: [0.0, 0.25], label: 'right brow' },
  eyeBlink_L: { x: [0.0, 0.2], y: [-0.05, 0.2], label: 'left eye' },
  eyeBlink_R: { x: [-0.2, 0.0], y: [-0.05, 0.2], label: 'right eye' },
  eyeLookX: { y: [-0.1, 0.2], label: 'eyes' },
  eyeLookY: { y: [-0.1, 0.2], label: 'eyes' },
  cheekPuff: { y: [-0.2, 0.1], label: 'cheeks' },
  noseSneer: { y: [-0.1, 0.1], label: 'nose' },
};

const path = resolve(process.argv[2] || 'assets/me.avtr');
const errors = [];
const warnings = [];

let avatar;
try {
  const raw = readFileSync(path);
  avatar = decodeAvatar(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
} catch (e) {
  console.error(`✗ ${path}: ${e.message}`);
  process.exit(1);
}

const { n, nb, names } = avatar;
const MAXD = 0.25; // metres; a single shape key moving a gaussian further is suspect

const finite = (arr) => {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
};

// ---- structural ----------------------------------------------------------
for (const key of ['positions', 'scales', 'quats', 'colors', 'opacity', 'weights', 'deltas']) {
  if (!avatar[key]) { errors.push(`missing buffer: ${key}`); continue; }
  if (!finite(avatar[key])) {
    const bad = [...avatar[key]].filter((v) => !Number.isFinite(v)).length;
    errors.push(`${key}: ${bad} non-finite values`);
  }
}
if (errors.length) {
  console.log(`file      ${path}`);
  console.log(`gaussians ${n.toLocaleString()}   channels ${nb}`);
  for (const e of errors) console.log(`✗  ${e}`);
  process.exit(1);
}

let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
let badOpacity = 0, badQuat = 0, badWeight = 0;
for (let i = 0; i < n; i++) {
  const x = avatar.positions[i * 3], y = avatar.positions[i * 3 + 1];
  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  const o = avatar.opacity[i];
  if (!(o >= 0 && o <= 1)) badOpacity++;
  const ql = Math.hypot(avatar.quats[i * 4], avatar.quats[i * 4 + 1], avatar.quats[i * 4 + 2], avatar.quats[i * 4 + 3]);
  if (Math.abs(ql - 1) > 0.05) badQuat++;
  for (let b = 0; b < nb; b++) {
    const w = avatar.weights[i * nb + b];
    if (!(w >= 0 && w <= 1)) badWeight++;
  }
}
if (badOpacity) errors.push(`${badOpacity} opacities outside [0,1]`);
if (badWeight) errors.push(`${badWeight} rig weights outside [0,1]`);
if (badQuat) warnings.push(`${badQuat} quaternions not unit length`);

const height = maxY - minY;
if (height > 2.5) errors.push(`model is ${height.toFixed(2)} m tall — it is in metres of a full body, not a head`);
if (height < 0.08) warnings.push(`model is only ${(height * 100).toFixed(1)} cm tall — check the units`);
if (height > 0.9) warnings.push(`model is ${height.toFixed(2)} m tall — likely includes shoulders; check camera framing`);

// ---- per channel ---------------------------------------------------------
const rows = [];
for (let b = 0; b < nb; b++) {
  const name = names[b];
  let count = 0, maxD = 0, sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    if (avatar.weights[i * nb + b] === 0) continue;
    const o = (i * nb + b) * 3;
    const d = Math.hypot(avatar.deltas[o], avatar.deltas[o + 1], avatar.deltas[o + 2]);
    if (d <= 1e-7) continue;
    count++;
    maxD = Math.max(maxD, d);
    sumX += avatar.positions[i * 3];
    sumY += avatar.positions[i * 3 + 1];
  }
  const cx = count ? sumX / count : 0;
  const cy = count ? sumY / count : 0;
  rows.push({ name, count, maxD, cx, cy });

  if (count === 0) warnings.push(`channel "${name}" moves nothing`);
  if (maxD > MAXD) errors.push(`channel "${name}" displaces a gaussian ${(maxD * 100).toFixed(1)} cm — wrong units?`);

  const box = REGION[name];
  if (box && count) {
    if (box.y && (cy < box.y[0] || cy > box.y[1])) {
      warnings.push(`"${name}" acts around y=${cy.toFixed(3)} — expected ${box.label}`);
    }
    if (box.x && (cx < box.x[0] || cx > box.x[1])) {
      warnings.push(`"${name}" acts around x=${cx.toFixed(3)} — expected ${box.label} (mirrored rig?)`);
    }
  }
}

// ---- coverage ------------------------------------------------------------
const present = new Set(names);
const undriven = DRIVERS.filter((d) => present.has(d) && rows.find((r) => r.name === d)?.count === 0);
const unreachable = DRIVERS.filter((d) => !present.has(d));
if (unreachable.length) {
  warnings.push(`the pipeline will drive ${unreachable.length} channel(s) this asset does not have: ${unreachable.join(', ')}`);
}
if (undriven.length) warnings.push(`driven channel(s) with no geometry: ${undriven.join(', ')}`);

// ---- print ---------------------------------------------------------------
function report() {
  if (avatar) {
    console.log(`file      ${path}`);
    console.log(`gaussians ${n.toLocaleString()}   channels ${nb}`);
    console.log(`height    ${(height * 100).toFixed(1)} cm   width ${((maxX - minX) * 100).toFixed(1)} cm   ` +
      `payload ${(avatar.totalBytes / 1e6).toFixed(2)} MB`);
    console.log('');
    console.log('channel            gaussians   max move   centroid');
    for (const r of rows) {
      const mark = r.count === 0 ? '  !' : '';
      console.log(`  ${r.name.padEnd(16)} ${String(r.count).padStart(8)}  ${(r.maxD * 1000).toFixed(1).padStart(6)} mm  ` +
        `x ${r.cx.toFixed(3)} y ${r.cy.toFixed(3)}${mark}`);
    }
    console.log('');
  }
  for (const w of warnings) console.log(`⚠  ${w}`);
  for (const e of errors) console.log(`✗  ${e}`);
  if (!errors.length && !warnings.length) console.log('✓  avatar looks consistent');
}

report();
process.exit(errors.length ? 1 : 0);
