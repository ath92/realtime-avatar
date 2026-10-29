#!/usr/bin/env node
// Build a mouth cavity inside an avatar.
//
//   node tools/mouth-cavity.mjs --in assets/me.avtr --out /tmp/with-cavity.avtr
//
// LAM's Gaussians sit on a FLAME surface, which closes at the lips — there is no
// palate, throat, tongue or teeth anywhere in the data. Opening the jaw therefore
// reveals the inside of the head, which is skin.
//
// This inserts the missing anatomy: an open-fronted cup (palate/back wall/floor),
// two rows of teeth and a tongue, sized from the rig's own aperture and weighted
// so the lower half travels with the jaw.
//
// STATUS: works, but not useful yet — read this before spending time on it.
//
// A static cup is always visible through the closed lips: they are translucent
// (~0.2 opacity) and too sparse to occlude anything behind them. Parking the cup
// inside the skull and pulling it forward with jawOpen fixes the rest pose, but
// the rig is linear, so at speech-range jaw values (0.3-0.8) the cup is still
// mostly inside the head and smears across the mouth. It only looks right at
// jawOpen ~= 1, which is not how anyone talks.
//
// Conclusion: a fake cavity cannot be driven by a single linear channel. This is
// kept as a starting point for someone building a real one (non-linear reveal, or
// geometry modelled against the actual lip outline in Blender).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeAvatar, encodeAvatar } from '../shared/format.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const input = resolve(opt('in', 'assets/me.avtr'));
const out = resolve(opt('out', input));
const density = Number(opt('density', 1));

const raw = readFileSync(input);
const a = decodeAvatar(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const { n, nb, names } = a;
const jaw = names.indexOf('jawOpen');
if (jaw < 0) { console.error('no jawOpen channel'); process.exit(1); }

// ---- locate the mouth ----------------------------------------------------
let maxZ = -Infinity;
for (let i = 0; i < n; i++) maxZ = Math.max(maxZ, a.positions[i * 3 + 2]);

let mz = -Infinity;
for (let i = 0; i < n; i++) {
  const x = a.positions[i * 3], z = a.positions[i * 3 + 2];
  if (Math.abs(x) < 0.03 && a.weights[i * nb + jaw] > 0.5 && z > maxZ - 0.05 && z > mz) mz = z;
}
let mx = 0, my = 0, c = 0;
for (let i = 0; i < n; i++) {
  const x = a.positions[i * 3], y = a.positions[i * 3 + 1], z = a.positions[i * 3 + 2];
  if (Math.abs(x) < 0.025 && a.weights[i * nb + jaw] > 0.5 && z > mz - 0.01) { mx += x; my += y; c++; }
}
mx /= c; my /= c;

let aperture = 0;
for (let i = 0; i < n; i++) {
  const w = a.weights[i * nb + jaw];
  if (w > 0.2) aperture = Math.max(aperture, Math.abs(a.deltas[(i * nb + jaw) * 3 + 1]) * w);
}
console.log(`mouth (${mx.toFixed(3)}, ${my.toFixed(3)}, ${mz.toFixed(3)})  aperture ${(aperture * 1000).toFixed(1)} mm`);

// ---- proportions ---------------------------------------------------------
const A = Number(opt('aw', 0.0135));   // half width of the opening
const B = Number(opt('ah', 0.013));    // half height
const DEPTH = Number(opt('depth', 0.032));
const Y0 = my + Number(opt('yoff', 0.004));
const RIM = mz - Number(opt('rim', 0.0085));  // behind the lip plane, hidden at rest

const add = [];
const push = (x, y, z, col, sc, op, jw) => add.push({ x, y, z, col, sc, op, jw });

// ---- cup: open-fronted ellipsoid shell -----------------------------------
// Sample the back half of an ellipsoid, so the opening faces +z toward the lips.
const NC = Math.round(9000 * density);
for (let k = 0; k < NC; k++) {
  // uniform on the sphere, keep the back
  const u = 1 - 2 * ((k + 0.5) / NC);
  const r = Math.sqrt(Math.max(0, 1 - u * u));
  const th = k * 2.399963;
  let dx = Math.cos(th) * r, dy = u, dz = Math.sin(th) * r;
  if (dz > 0.15) continue;                    // cut the front open
  const shell = 1 - 0.06 * ((k % 3) === 0 ? 1 : 0);
  const x = mx + dx * A * shell;
  const y = Y0 + dy * B * shell * 1.15;
  const z = RIM + dz * DEPTH * 0.55 - 0.004;
  // darker deeper in the throat; warmer near the lips
  const t = Math.min(1, Math.max(0, (RIM - z) / DEPTH));
  const col = [0.055 - 0.02 * t, 0.014 - 0.005 * t, 0.016 - 0.005 * t];
  push(x, y, z, col, 0.0013, 0.98, y < Y0 ? 1 : 0);
}

// ---- teeth: two arcs, upper static, lower follows the jaw ----------------
function arc(y, z, colour, jw, count) {
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * 2 - 1;
    const x = mx + t * A * 0.82;
    const yy = y + Math.abs(t) * 0.0012;
    const zz = z - (t * t) * 0.003;
    push(x, yy, zz, colour, 0.0016, 1.0, jw);
    push(x, yy + 0.0016, zz, colour, 0.0014, 1.0, jw);
  }
}
const TOOTH = [0.80, 0.78, 0.72];
arc(Y0 + B * 0.52, RIM - 0.004, TOOTH, 0, Math.round(9 * density));
arc(Y0 - B * 0.52, RIM - 0.004, TOOTH.map((v) => v * 0.95), 1, Math.round(9 * density));

// ---- tongue --------------------------------------------------------------
const NT = Math.round(1400 * density);
for (let k = 0; k < NT; k++) {
  const u = 2 * Math.random() - 1, v = 2 * Math.random() - 1, w = 2 * Math.random() - 1;
  if (u * u + v * v + w * w > 1) continue;
  const x = mx + u * A * 0.62;
  const y = Y0 - B * 0.48 + v * 0.0035;
  const z = RIM - 0.016 + w * 0.010;
  push(x, y, z, [0.42, 0.15, 0.17], 0.0015, 0.97, 1);
}

// ---- merge ---------------------------------------------------------------
const m = add.length;
const total = n + m;
const positions = new Float32Array(total * 3);
const scales = new Float32Array(total * 3);
const quats = new Float32Array(total * 4);
const colors = new Float32Array(total * 3);
const opacity = new Float32Array(total);
const weights = new Float32Array(total * nb);
const deltas = new Float32Array(total * nb * 3);
positions.set(a.positions); scales.set(a.scales); quats.set(a.quats);
colors.set(a.colors); opacity.set(a.opacity); weights.set(a.weights); deltas.set(a.deltas);

// Hide the cup at rest by parking it deep inside the head, and let the jawOpen
// channel carry it forward into place. A static cavity cannot be hidden behind
// translucent lips; a moving one can be hidden behind the back of the skull.
const HIDDEN = Number(opt('hidden', 0.10));

for (let k = 0; k < m; k++) {
  const g = add[k];
  const i = n + k;
  // authored at the mouth, but stored parked inside the skull; jawOpen pulls it in
  positions[i * 3] = g.x; positions[i * 3 + 1] = g.y; positions[i * 3 + 2] = g.z - HIDDEN;
  const sc = g.sc;
  scales[i * 3] = sc; scales[i * 3 + 1] = sc; scales[i * 3 + 2] = sc;
  quats[i * 4 + 3] = 1;
  colors[i * 3] = g.col[0]; colors[i * 3 + 1] = g.col[1]; colors[i * 3 + 2] = g.col[2];
  opacity[i] = g.op;
  // full jaw weight so the reveal is driven by jawOpen alone
  weights[i * nb + jaw] = 1;
  // rigid travel: forward out of the skull, and down with the jaw so the cup stays
  // centred in the opening
  deltas[(i * nb + jaw) * 3 + 2] = HIDDEN;
  deltas[(i * nb + jaw) * 3 + 1] = -aperture * Number(opt('ydown', 0.1));
}

writeFileSync(out, encodeAvatar({ n: total, nb, names, positions, scales, quats, colors, opacity, weights, deltas }));
console.log(`wrote ${out}  ${total.toLocaleString()} gaussians  (+${m.toLocaleString()})`);
