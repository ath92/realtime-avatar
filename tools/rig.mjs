// Procedural placeholder head rig.
//
// This exists so the whole pipeline runs with zero model downloads. It is a
// deliberately stylised mannequin — the point is to exercise the rig (16
// blendshape channels, gaussian splatting, gaze, blink) end to end, not to fool
// anyone. Swap in a LAM / Avat3r / UIKA asset later: the container format and
// the driving interface are what actually matter.
//
// Space: metres, y up, +z forward (the face looks down +z), origin at eye level.

export const CHANNELS = [
  'jawOpen',
  'mouthSmile_L', 'mouthSmile_R',
  'mouthFunnel', 'mouthPucker',
  'browInnerUp',
  'browOuterUp_L', 'browOuterUp_R',
  'browDown_L', 'browDown_R',
  'eyeBlink_L', 'eyeBlink_R',
  'eyeLookX', 'eyeLookY',
  'cheekPuff',
  'noseSneer',
];

const EYE = { x: 0.030, y: 0.014, z: 0.0605, r: 0.0112 };
const MOUTH = { x: 0.0, y: -0.050, z: 0.077, hw: 0.023, hh: 0.0105 };
const BROW_Y = 0.048;
const PIVOT_JAW = [0, -0.008, -0.035];
const HAIRLINE = 0.062;

const SKIN = [0.78, 0.565, 0.465];
const LIP = [0.60, 0.30, 0.29];
const HAIR = [0.085, 0.065, 0.055];
const BROW = [0.14, 0.10, 0.085];
const SCLERA = [0.83, 0.83, 0.85];
const IRIS = [0.20, 0.30, 0.36];
const SHIRT = [0.13, 0.15, 0.19];

// ---------------------------------------------------------------- utilities

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const gauss = (d, s) => Math.exp(-(d * d) / (2 * s * s));
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

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

function sphereDirs(n) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

function quatFromZ(n) {
  if (n[2] < -0.99999) return [0, 1, 0, 0];
  const q = [-n[1], n[0], 0, 1 + n[2]];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

// ---------------------------------------------------------------- geometry

const P = [];
function push(pos, normal, color, opacity, scale, tag) {
  P.push({ pos, normal: norm(normal), color, opacity, scale, tag });
}

// A continuous head shell. One surface for cranium + face + jaw means no seams
// to tear when the jaw rotates.
export function headPoint(d) {
  let x = d[0] * 0.072;
  let y = d[1] * 0.096;
  let z = d[2] * 0.090;

  const down = clamp(-y / 0.096);            // 0 at eye line, 1 at chin
  const up = clamp(y / 0.096);

  // jaw: strong taper towards the chin, chin pulled forward
  const taper = 1 - 0.52 * Math.pow(down, 1.5);
  x *= taper;
  z *= taper;
  z += 0.016 * down * down * down;

  // flatten the face plane, round out the cranium
  if (z > 0) z *= 0.95 - 0.06 * up;
  // temples: narrow slightly above the eyes
  if (y > 0.03) x *= 1 - 0.12 * smooth(0.03, 0.09, y);

  // jaw hinge: the bottom of the skull curves in behind the ears
  if (z < -0.02) z *= 1 - 0.22 * down;

  // eye sockets: a shallow hollow so the eyeballs are not buried
  for (const sx of [-1, 1]) {
    const dx = (x - sx * EYE.x) / 0.019;
    const dy = (y - EYE.y - 0.002) / 0.014;
    const socket = Math.exp(-(dx * dx + dy * dy) * 0.5);
    if (z > 0.02) z -= 0.015 * socket;
  }

  return [x, y, z];
}

export function headNormal(d) {
  const e = 0.004;
  const p = headPoint(d);
  const tx = norm(sub(headPoint([d[0] + e, d[1], d[2]]), p));
  const ty = norm(sub(headPoint([d[0], d[1] + e, d[2]]), p));
  const n = [
    ty[1] * tx[2] - ty[2] * tx[1],
    ty[2] * tx[0] - ty[0] * tx[2],
    ty[0] * tx[1] - ty[1] * tx[0],
  ];
  const l = len(n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

// Is this surface point inside the mouth opening? Used to cut the hole.
function inMouthHole(p) {
  if (p[2] < 0.045) return false;
  const u = p[0] / (MOUTH.hw * 1.02);
  const v = (p[1] - MOUTH.y) / (MOUTH.hh * 1.02);
  return u * u + v * v < 1.0;
}

function hairMask(p) {
  const hairY = HAIRLINE - 0.080 * smooth(0.04, -0.06, p[2]);
  const band = smooth(hairY - 0.003, hairY + 0.007, p[1]);
  const sides = smooth(-0.045, -0.005, p[2] + 0.55 * Math.abs(p[0]));
  return band * sides;
}

function headColor(d, p) {
  const [x, y, z] = p;
  const ax = Math.abs(x);

  // --- lips: a band around the mouth opening
  const du = x / (MOUTH.hw * 1.28);
  const dv = (y - MOUTH.y) / (MOUTH.hh * 1.15);
  const lipRing = 1 - smooth(0.75, 1.0, Math.hypot(du, dv));
  const lip = lipRing * smooth(0.30, 0.55, z) * 0.95;

  // --- brows
  const bx = ax;
  const browArc = BROW_Y + 0.008 * Math.sin(clamp((bx - 0.008) / 0.040) * Math.PI) - 0.002;
  const brow = gauss(y - browArc, 0.0055) * smooth(0.075, 0.055, z)
    * smooth(0.006, 0.014, bx) * smooth(0.058, 0.044, bx);

  // --- hair: above the hairline, lower at the back
  const hair = hairMask(p);

  // --- cavity shading
  let k = 1;
  for (const sx of [-1, 1]) k -= 0.26 * gauss(len(sub(p, [sx * EYE.x, EYE.y + 0.004, EYE.z - 0.004])), 0.026);
  k -= 0.16 * gauss(len(sub(p, [0, -0.030, 0.072])), 0.022);       // under the nose
  k -= 0.22 * smooth(-0.05, -0.10, y);                              // under the jaw

  let c = SKIN.map((v) => v * clamp(k, 0.42, 1.06));
  c = mix3(c, BROW.map((v) => v * (0.85 + 0.3 * Math.random())), brow);
  c = mix3(c, LIP.map((v) => v * (0.88 + 0.24 * Math.random())), lip);
  c = mix3(c, HAIR.map((v) => v * (0.75 + 0.6 * Math.random())), hair);
  return c;
}

export function buildHead({ density = 1, seed = 7 } = {}) {
  Math.random = mulberry32(seed);
  P.length = 0;
  const D = density;
  const rnd = Math.random;

  // --- head shell (with the mouth cut out) -------------------------------
  const dirs = sphereDirs(Math.round(11000 * D));
  for (const d of dirs) {
    for (let s = 0; s < 2; s++) {
      const k = 1 - s * 0.035;
      const dp = [d[0] * k, d[1] * k, d[2] * k];
      const p = headPoint(dp);
      if (inMouthHole(p)) continue;
      const nrm = headNormal(d);
      push(p, nrm, headColor(d, p), s === 0 ? 0.92 : 0.4,
        [0.0024, 0.0024, 0.0013], 'head');
    }
  }

  // --- lips: two lobes that meet at the mouth line ----------------------
  // The opening is filled, so a closed mouth shows no cavity. Rotating the
  // lower lobe with the jaw reveals the dark interior behind it.
  const lipN = Math.round(1500 * D);
  for (let i = 0; i < lipN; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    const u = Math.cos(a) * r;
    const v = Math.sin(a) * r;
    // squash into an ellipse, then split at v = 0 into upper/lower lobes
    const x = u * MOUTH.hw * (1.0 + 0.16 * (1 - Math.abs(v)));
    const yy = MOUTH.y + v * MOUTH.hh * (v > 0 ? 1.05 : 1.0);
    const zz = MOUTH.z - 0.005 - 0.008 * u * u - 0.004 * v * v;
    const col = LIP.map((vv) => vv * (0.9 + rnd() * 0.2) * (0.85 + 0.15 * Math.abs(v)));
    push([x, yy, zz], [x * 6, v * 3, 1], col, 0.94,
      [0.0021, 0.0021, 0.0014], 'lip');
  }
  // the crease between the lobes
  for (let i = 0; i < Math.round(240 * D); i++) {
    const t = rnd() * 2 - 1;
    push([t * MOUTH.hw * 0.98, MOUTH.y - 0.0006, MOUTH.z - 0.0045],
      [0, 0, 1], [0.30, 0.13, 0.13], 0.9, [0.0014, 0.0010, 0.0010], 'lip');
  }

  // --- mouth cavity, tongue, teeth --------------------------------------
  const cavityN = Math.round(900 * D);
  for (let i = 0; i < cavityN; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    const x = Math.cos(a) * r * MOUTH.hw * 0.98;
    const yy = MOUTH.y + Math.sin(a) * r * MOUTH.hh * 0.98;
    push([x, yy, MOUTH.z - 0.016 - 0.010 * r * r], [0, 0, 1],
      [0.07, 0.025, 0.03], 0.95, [0.0018, 0.0018, 0.0018], 'cavity');
  }
  for (let i = 0; i < Math.round(320 * D); i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    push([Math.cos(a) * r * 0.016, MOUTH.y - 0.007 + Math.sin(a) * r * 0.006,
      MOUTH.z - 0.020], [0, 0, 1], [0.52, 0.24, 0.26], 0.9,
      [0.0018, 0.0018, 0.0018], 'tongue');
  }
  for (const [dy, ch] of [[0.0085, 1], [-0.0095, -1]]) {
    for (let i = 0; i < Math.round(200 * D); i++) {
      const t = (i / Math.round(200 * D)) * 2 - 1;
      push([t * MOUTH.hw * 0.9, MOUTH.y + dy * 0.9, MOUTH.z - 0.012 + ch * 0.001],
        [0, 0, 1], [0.86, 0.84, 0.79], 0.9, [0.0016, 0.0016, 0.0012], 'teeth');
    }
  }

  // --- nose --------------------------------------------------------------
  for (let i = 0; i < Math.round(900 * D); i++) {
    const t = rnd();
    const yy = 0.014 - t * 0.042;
    const w = 0.0032 + t * t * 0.011;
    const zz = 0.073 + t * 0.021;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    push([Math.cos(a) * r * w, yy + Math.sin(a) * r * 0.006, zz + Math.cos(a) * r * w * 0.5],
      [Math.cos(a), Math.sin(a) * 0.5, 0.8], SKIN.map((v) => v * (0.86 + rnd() * 0.14)), 0.9,
      [0.0018, 0.0018, 0.0016], 'nose');
  }

  // --- eyes, lids, ears --------------------------------------------------
  for (const sx of [-1, 1]) {
    const c = [sx * EYE.x, EYE.y, EYE.z];

    for (let i = 0; i < Math.round(1100 * D); i++) {
      const a = rnd() * Math.PI * 2;
      const b = Math.acos(2 * rnd() - 1);
      const d = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
      if (d[2] < -0.2) continue;
      push([c[0] + d[0] * EYE.r, c[1] + d[1] * EYE.r, c[2] + d[2] * EYE.r], d,
        SCLERA, 0.95, [0.0014, 0.0014, 0.0010], 'eye');
    }
    for (let i = 0; i < Math.round(260 * D); i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 0.0066;
      push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2] + EYE.r * 0.95],
        [0, 0, 1], IRIS, 0.96, [0.0011, 0.0011, 0.0008], 'iris');
    }
    for (let i = 0; i < Math.round(70 * D); i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 0.0029;
      push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2] + EYE.r * 0.99],
        [0, 0, 1], [0.015, 0.015, 0.02], 1, [0.001, 0.001, 0.0008], 'iris');
    }

    // upper lid: a thin skin cap sitting just above the eye
    // upper lid: a skin disc parked above the eye, sliding down to close it
    const lidZ = EYE.z + 0.013;
    for (let i = 0; i < Math.round(900 * D); i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      const px = c[0] + Math.cos(a) * r * 0.0145;
      const py = EYE.y + 0.0165 + Math.sin(a) * r * 0.0125;
      const edge = 1 - smooth(0.7, 1.0, r);
      push([px, py, lidZ - 0.002 * r * r], [Math.cos(a) * 0.5, Math.sin(a) * 0.5, 1],
        SKIN.map((v) => v * (0.80 + rnd() * 0.10)), 0.75 + 0.2 * edge,
        [0.0018, 0.0018, 0.0010], 'lidUpper');
    }
    for (let i = 0; i < Math.round(320 * D); i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      const px = c[0] + Math.cos(a) * r * 0.0135;
      const py = EYE.y - 0.0135 + Math.sin(a) * r * 0.0042;
      push([px, py, lidZ - 0.002], [0, -0.4, 1],
        SKIN.map((v) => v * (0.78 + rnd() * 0.10)), 0.9,
        [0.0018, 0.0015, 0.0010], 'lidLower');
    }

    // ear: a small flattened shell behind the jaw
    const ear = [sx * 0.070, 0.002, -0.014];
    for (let i = 0; i < Math.round(500 * D); i++) {
      const a = rnd() * Math.PI * 2;
      const b = Math.acos(2 * rnd() - 1);
      const d = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
      push([ear[0] + d[0] * 0.006, ear[1] + d[1] * 0.019, ear[2] + d[2] * 0.013],
        [d[0] * 3, d[1], d[2]], SKIN.map((v) => v * (0.84 + rnd() * 0.16)), 0.9,
        [0.0018, 0.0018, 0.0014], 'ear');
    }
  }

  // --- hair volume -------------------------------------------------------
  const hairN = Math.round(4200 * D);
  for (let i = 0; i < hairN; i++) {
    const a = rnd() * Math.PI * 2;
    const b = Math.acos(2 * rnd() - 1);
    const d = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
    const p = headPoint(d);
    if (hairMask(p) < 0.55) continue;
    const k = 1.02 + rnd() * 0.045;
    push([p[0] * k * 1.01, p[1] * k, p[2] * k * 1.01], headNormal(d),
      HAIR.map((v) => v * (0.7 + rnd() * 0.75)), 0.92, [0.0024, 0.0024, 0.0022], 'hair');
  }

  // --- neck + shoulders --------------------------------------------------
  for (let i = 0; i < Math.round(3400 * D); i++) {
    const y = -0.080 - rnd() * 0.062;
    const a = rnd() * Math.PI * 2;
    const r = 0.043 + 0.004 * Math.sin(a) - 0.006 * smooth(-0.10, -0.14, y) + 0.002 * rnd();
    const nrm = [Math.cos(a), 0.1, Math.sin(a)];
    push([Math.cos(a) * r, y, Math.sin(a) * r - 0.010], nrm,
      SKIN.map((v) => v * (0.70 + rnd() * 0.10)), 0.92, [0.0028, 0.0028, 0.0028], 'neck');
  }
  for (let i = 0; i < Math.round(3000 * D); i++) {
    const a = rnd() * Math.PI * 2;
    const t = Math.sqrt(rnd());
    const yy = -0.150 - t * 0.075;
    const rr = 0.075 + t * 0.105;
    push([Math.cos(a) * rr, yy, Math.sin(a) * rr * 0.45 - 0.020],
      [Math.cos(a), 0.15, Math.sin(a)], SHIRT.map((v) => v * (0.85 + rnd() * 0.3)),
      0.9, [0.0034, 0.0034, 0.0034], 'shirt');
  }

  return assemble();
}

// ---------------------------------------------------------------- rig weights

function rotDelta(p, pivot, axis, angle) {
  const r = sub(p, pivot);
  const a = norm(axis);
  return [
    (a[1] * r[2] - a[2] * r[1]) * angle,
    (a[2] * r[0] - a[0] * r[2]) * angle,
    (a[0] * r[1] - a[1] * r[0]) * angle,
  ];
}

function rigAt(p, tag, out) {
  const [x, y, z] = p;
  const ax = Math.abs(x);
  const front = smooth(-0.03, 0.05, z);

  // Fade out below the jawline and never touch the neck/shirt: a jaw rotation
  // applied to a gaussian 20 cm below the pivot produces metres of motion.
  const jawGeo = smooth(-0.022, -0.070, y) * front * smooth(-0.150, -0.100, y);
  const jawTag = tag === 'lip' || tag === 'cavity' || tag === 'tongue' || tag === 'teeth';
  const jaw = jawTag ? Math.max(jawGeo, y < MOUTH.y ? 1 : 0) : jawGeo;

  const mouthD = Math.hypot((ax - MOUTH.hw) * 0.8, (y - MOUTH.y) * 1.5);
  const lipRing = tag === 'lip' ? 1 : gauss(mouthD, 0.012) * front * 0.55;
  const cornerL = gauss(Math.hypot(x - MOUTH.hw, y - MOUTH.y), 0.016) * front;
  const cornerR = gauss(Math.hypot(x + MOUTH.hw, y - MOUTH.y), 0.016) * front;

  const browD = gauss(y - BROW_Y, 0.013) * front * smooth(0.075, 0.050, ax);
  const browInner = browD * smooth(0.048, 0.014, ax);
  const browOuter = browD * smooth(0.008, 0.042, ax);

  const lidUp = tag === 'lidUpper' ? 1 : 0;
  const lidLo = tag === 'lidLower' ? 1 : 0;
  const iris = tag === 'iris' ? 1 : 0;

  const cheekW = gauss(len(sub(p, [Math.sign(x) * 0.040, -0.032, 0.052])), 0.020);
  const noseW = gauss(len(sub(p, [0, -0.010, 0.080])), 0.014);

  out.w.fill(0); out.d.fill(0);
  const D = (i, v) => { out.d[i * 3] = v[0]; out.d[i * 3 + 1] = v[1]; out.d[i * 3 + 2] = v[2]; };

  out.w[0] = clamp(jaw);
  D(0, rotDelta(p, PIVOT_JAW, [1, 0, 0], 0.26));

  out.w[1] = clamp(cornerL * (tag === 'lip' ? 1 : 0.75));
  D(1, [0.005, 0.008, 0.001]);
  out.w[2] = clamp(cornerR * (tag === 'lip' ? 1 : 0.75));
  D(2, [-0.005, 0.008, 0.001]);

  out.w[3] = clamp(lipRing);
  D(3, [-x * 0.12, 0, 0.008]);

  out.w[4] = clamp(lipRing * 0.9);
  D(4, [-x * 0.26, 0, 0.012]);

  out.w[5] = clamp(browInner * (tag === 'head' ? 1 : 0.6));
  D(5, [0, 0.008, 0.001]);

  out.w[6] = clamp(browOuter * clamp(x / 0.05) * 1.1);
  D(6, [0.001, 0.007, 0]);
  out.w[7] = clamp(browOuter * clamp(-x / 0.05) * 1.1);
  D(7, [-0.001, 0.007, 0]);

  out.w[8] = clamp(browD * clamp(x / 0.05) * 0.9);
  D(8, [0, -0.006, -0.001]);
  out.w[9] = clamp(browD * clamp(-x / 0.05) * 0.9);
  D(9, [0, -0.006, -0.001]);

  out.w[10] = clamp(x > 0 ? lidUp + lidLo * 0.55 : 0);
  D(10, [0, -0.0185, -0.002]);
  out.w[11] = clamp(x < 0 ? lidUp + lidLo * 0.55 : 0);
  D(11, [0, -0.0185, -0.002]);

  out.w[12] = iris; D(12, [0.0045, 0, 0]);
  out.w[13] = iris; D(13, [0, 0.0040, 0]);

  out.w[14] = clamp(cheekW * (tag === 'head' ? 1 : 0.4));
  D(14, [Math.sign(x) * 0.006, 0.001, 0.004]);

  out.w[15] = clamp(noseW);
  D(15, [0, 0.004, -0.002]);
}

function assemble() {
  const n = P.length;
  const nb = CHANNELS.length;
  const positions = new Float32Array(n * 3);
  const scales = new Float32Array(n * 3);
  const quats = new Float32Array(n * 4);
  const colors = new Float32Array(n * 3);
  const opacity = new Float32Array(n);
  const weights = new Float32Array(n * nb);
  const deltas = new Float32Array(n * nb * 3);
  const scratch = { w: new Float32Array(nb), d: new Float32Array(nb * 3) };

  for (let i = 0; i < n; i++) {
    const g = P[i];
    positions.set(g.pos, i * 3);
    scales.set(g.scale, i * 3);
    quats.set(quatFromZ(g.normal), i * 4);
    colors.set(g.color, i * 3);
    opacity[i] = g.opacity;

    rigAt(g.pos, g.tag, scratch);
    for (let b = 0; b < nb; b++) {
      const w = scratch.w[b];
      if (!(w > 2e-3)) continue;   // below this the displacement is sub-micron
      weights[i * nb + b] = w;
      deltas[(i * nb + b) * 3] = scratch.d[b * 3];
      deltas[(i * nb + b) * 3 + 1] = scratch.d[b * 3 + 1];
      deltas[(i * nb + b) * 3 + 2] = scratch.d[b * 3 + 2];
    }
  }

  return { n, nb, names: CHANNELS, positions, scales, quats, colors, opacity, weights, deltas };
}
