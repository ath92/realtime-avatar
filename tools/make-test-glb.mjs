#!/usr/bin/env node
// Builds a synthetic rigged head GLB, so the importer and the validator can be
// tested without anyone's face or a licensed avatar asset.
//
//   node tools/make-test-glb.mjs --out /tmp/test-head.glb
//
// It reuses the procedural head's surface so the result is recognisably the same
// character, with 16 ARKit morph targets and an embedded PNG base-colour texture.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { headPoint, headNormal } from './rig.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = resolve(opt('out', '/tmp/test-head.glb'));
const LON = Number(opt('lon', 44));
const LAT = Number(opt('lat', 26));

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const gauss = (d, s) => Math.exp(-(d * d) / (2 * s * s));

// ---- surface --------------------------------------------------------------
const verts = [];
const uvs = [];
for (let j = 0; j <= LAT; j++) {
  const theta = (j / LAT) * Math.PI;
  for (let i = 0; i <= LON; i++) {
    const phi = (i / LON) * Math.PI * 2;
    const d = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)];
    verts.push(headPoint(d));
    uvs.push([i / LON, j / LAT]);
  }
}
const idxOf = (j, i) => j * (LON + 1) + i;

const idx = [];
for (let j = 0; j < LAT; j++) {
  for (let i = 0; i < LON; i++) {
    const a = idxOf(j, i), b = idxOf(j, i + 1), c = idxOf(j + 1, i), d = idxOf(j + 1, i + 1);
    idx.push(a, c, b, b, c, d);
  }
}

const normals = verts.map((p) => {
  // finite-difference normal from the analytic surface
  const d = [p[0], p[1], p[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return headNormal([d[0] / l, d[1] / l, d[2] / l]);
});

// ---- morph targets --------------------------------------------------------
const MOUTH = { y: -0.050, z: 0.077, hw: 0.023 };
const EYE = { x: 0.030, y: 0.014 };

// gaze moves the iris, not the whole head: confine it to a disc per eye
function iris(x, y, side) {
  return gauss(Math.hypot(x - side * EYE.x, y - EYE.y), 0.007);
}

function field(name, p) {
  const [x, y, z] = p;
  const ax = Math.abs(x);
  const front = smooth(-0.03, 0.05, z);
  const jaw = smooth(-0.022, -0.070, y) * front;
  const mouthD = Math.hypot((ax - MOUTH.hw) * 0.8, (y - MOUTH.y) * 1.5);
  const lip = gauss(mouthD, 0.012) * front;
  const brow = gauss(y - 0.048, 0.013) * front * smooth(0.075, 0.050, ax);

  switch (name) {
    case 'jawOpen': {
      const k = 0.34 * jaw;
      const ry = y + 0.008, rz = z + 0.035;
      return [0, -rz * k, ry * k];
    }
    case 'mouthSmileLeft': {
      const w = gauss(Math.hypot(x - MOUTH.hw, y - MOUTH.y), 0.016) * front;
      return [0.005 * w, 0.008 * w, 0.001 * w];
    }
    case 'mouthSmileRight': {
      const w = gauss(Math.hypot(x + MOUTH.hw, y - MOUTH.y), 0.016) * front;
      return [-0.005 * w, 0.008 * w, 0.001 * w];
    }
    case 'mouthFunnel': return [-x * 0.12 * lip, 0, 0.008 * lip];
    case 'mouthPucker': return [-x * 0.26 * lip, 0, 0.012 * lip];
    case 'browInnerUp': { const w = brow * smooth(0.048, 0.014, ax); return [0, 0.008 * w, 0]; }
    case 'browOuterUpLeft': { const w = brow * smooth(0.008, 0.042, ax) * clamp(x / 0.05); return [0, 0.007 * w, 0]; }
    case 'browOuterUpRight': { const w = brow * smooth(0.008, 0.042, ax) * clamp(-x / 0.05); return [0, 0.007 * w, 0]; }
    case 'browDownLeft': { const w = brow * clamp(x / 0.05); return [0, -0.006 * w, 0]; }
    case 'browDownRight': { const w = brow * clamp(-x / 0.05); return [0, -0.006 * w, 0]; }
    case 'eyeBlinkLeft': {
      const w = x > 0 ? 1 - smooth(0.010, 0.020, Math.hypot(x - EYE.x, y - EYE.y)) : 0;
      return [0, -0.010 * w, 0];
    }
    case 'eyeBlinkRight': {
      const w = x < 0 ? 1 - smooth(0.010, 0.020, Math.hypot(x + EYE.x, y - EYE.y)) : 0;
      return [0, -0.010 * w, 0];
    }
    case 'eyeLookOutLeft': return [0.003 * iris(x, y, 1), 0, 0];
    case 'eyeLookOutRight': return [-0.003 * iris(x, y, -1), 0, 0];
    case 'eyeLookInLeft': return [-0.003 * iris(x, y, 1), 0, 0];
    case 'eyeLookInRight': return [0.003 * iris(x, y, -1), 0, 0];
    case 'eyeLookUpLeft': return [0, 0.0025 * iris(x, y, 1), 0];
    case 'eyeLookUpRight': return [0, 0.0025 * iris(x, y, -1), 0];
    case 'eyeLookDownLeft': return [0, -0.0025 * iris(x, y, 1), 0];
    case 'eyeLookDownRight': return [0, -0.0025 * iris(x, y, -1), 0];
    case 'cheekPuff': {
      const w = gauss(Math.hypot(x - Math.sign(x) * 0.040, y + 0.032), 0.020);
      return [Math.sign(x) * 0.006 * w, 0, 0.004 * w];
    }
    case 'noseSneerLeft':
    case 'noseSneerRight': {
      const w = gauss(Math.hypot(x, y + 0.010), 0.014);
      return [0, 0.004 * w * 0.5, -0.002 * w * 0.5];
    }
    default: return [0, 0, 0];
  }
}

const TARGETS = [
  'jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFunnel', 'mouthPucker',
  'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'browDownLeft', 'browDownRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeLookDownLeft',
  'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeLookDownRight',
  'cheekPuff', 'noseSneerLeft', 'noseSneerRight',
];

// ---- texture (64x64 skin gradient, PNG) -----------------------------------
function png(width, height, rgba) {
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TW = 64, TH = 64;
const tex = new Uint8Array(TW * TH * 4);
for (let y = 0; y < TH; y++) {
  for (let x = 0; x < TW; x++) {
    const o = (y * TW + x) * 4;
    const shade = 1 - 0.22 * (y / TH);
    tex[o] = Math.round(198 * shade);
    tex[o + 1] = Math.round(150 * shade);
    tex[o + 2] = Math.round(124 * shade);
    tex[o + 3] = 255;
  }
}
const pngBytes = png(TW, TH, tex);

// ---- pack ----------------------------------------------------------------
const chunks = [];
const views = [];
let binLen = 0;
function addView(buf, target) {
  while (binLen % 4) { chunks.push(Buffer.alloc(1)); binLen++; }
  const offset = binLen;
  chunks.push(buf);
  binLen += buf.length;
  const v = { buffer: 0, byteOffset: offset, byteLength: buf.length };
  if (target) v.target = target;
  views.push(v);
  return views.length - 1;
}

const posBuf = Buffer.alloc(verts.length * 12);
verts.forEach((p, i) => { posBuf.writeFloatLE(p[0], i * 12); posBuf.writeFloatLE(p[1], i * 12 + 4); posBuf.writeFloatLE(p[2], i * 12 + 8); });
const nrmBuf = Buffer.alloc(normals.length * 12);
normals.forEach((p, i) => { nrmBuf.writeFloatLE(p[0], i * 12); nrmBuf.writeFloatLE(p[1], i * 12 + 4); nrmBuf.writeFloatLE(p[2], i * 12 + 8); });
const uvBuf = Buffer.alloc(uvs.length * 8);
uvs.forEach((p, i) => { uvBuf.writeFloatLE(p[0], i * 8); uvBuf.writeFloatLE(p[1], i * 8 + 4); });
const idxBuf = Buffer.alloc(idx.length * 4);
idx.forEach((v, i) => idxBuf.writeUInt32LE(v, i * 4));

const vPos = addView(posBuf, 34962);
const vNrm = addView(nrmBuf, 34962);
const vUv = addView(uvBuf, 34962);
const vIdx = addView(idxBuf, 34963);
const vImg = addView(pngBytes);

const accessors = [];
const pushAcc = (view, componentType, count, type, min, max) => {
  const a = { bufferView: view, componentType, count, type };
  if (min) a.min = min;
  if (max) a.max = max;
  accessors.push(a);
  return accessors.length - 1;
};

const xs = verts.map((p) => p[0]), ys = verts.map((p) => p[1]), zs = verts.map((p) => p[2]);
const aPos = pushAcc(vPos, 5126, verts.length, 'VEC3', [Math.min(...xs), Math.min(...ys), Math.min(...zs)], [Math.max(...xs), Math.max(...ys), Math.max(...zs)]);
const aNrm = pushAcc(vNrm, 5126, normals.length, 'VEC3');
const aUv = pushAcc(vUv, 5126, uvs.length, 'VEC2');
const aIdx = pushAcc(vIdx, 5125, idx.length, 'SCALAR');

const targets = [];
for (const name of TARGETS) {
  const buf = Buffer.alloc(verts.length * 12);
  verts.forEach((p, i) => {
    const d = field(name, p);
    buf.writeFloatLE(d[0], i * 12);
    buf.writeFloatLE(d[1], i * 12 + 4);
    buf.writeFloatLE(d[2], i * 12 + 8);
  });
  const view = addView(buf, 34962);
  targets.push({ POSITION: pushAcc(view, 5126, verts.length, 'VEC3') });
}

const gltf = {
  asset: { version: '2.0', generator: 'avatar-tools/make-test-glb' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'head' }],
  meshes: [{
    name: 'head',
    primitives: [{
      attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv },
      indices: aIdx,
      targets,
      material: 0,
    }],
    extras: { targetNames: TARGETS },
  }],
  materials: [{
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0 },
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
  }],
  textures: [{ source: 0 }],
  images: [{ bufferView: vImg, mimeType: 'image/png' }],
  samplers: [{ magFilter: 9728, minFilter: 9728 }],
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: binLen }],
};

const bin = Buffer.concat(chunks, binLen);
let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
const binPad = (4 - (bin.length % 4)) % 4;
const binPadded = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;

const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
const outBuf = Buffer.alloc(total);
outBuf.writeUInt32LE(0x46546c67, 0);
outBuf.writeUInt32LE(2, 4);
outBuf.writeUInt32LE(total, 8);
outBuf.writeUInt32LE(jsonBuf.length, 12);
outBuf.writeUInt32LE(0x4e4f534a, 16);
jsonBuf.copy(outBuf, 20);
outBuf.writeUInt32LE(binPadded.length, 20 + jsonBuf.length);
outBuf.writeUInt32LE(0x004e4942, 24 + jsonBuf.length);
binPadded.copy(outBuf, 28 + jsonBuf.length);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, outBuf);
console.log(`wrote ${out}  ${(outBuf.length / 1024).toFixed(0)} KB  ` +
  `${verts.length} verts, ${idx.length / 3} tris, ${TARGETS.length} morph targets`);
