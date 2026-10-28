// Just enough glTF 2.0 to read a rigged head asset:
// geometry, morph targets, node transforms, and a base-colour texture.
//
// No dependencies. JPEG decoding shells out to `sips` (macOS) because writing a
// JPEG decoder is not a good use of anyone's afternoon; PNG is decoded in-process.

import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const MAGIC = 0x46546c67;

const COMPONENT = {
  5120: { size: 1, get: (dv, o) => dv.getInt8(o), norm: 127 },
  5121: { size: 1, get: (dv, o) => dv.getUint8(o), norm: 255 },
  5122: { size: 2, get: (dv, o) => dv.getInt16(o, true), norm: 32767 },
  5123: { size: 2, get: (dv, o) => dv.getUint16(o, true), norm: 65535 },
  5125: { size: 4, get: (dv, o) => dv.getUint32(o, true), norm: 1 },
  5126: { size: 4, get: (dv, o) => dv.getFloat32(o, true), norm: 1 },
};

const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function parseGLB(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a GLB file');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);

  const total = Math.min(dv.getUint32(8, true), buf.byteLength);
  let off = 12;
  let json = null;
  let bin = null;

  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = buf.byteOffset + off + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf.buffer, start, len)));
    } else if (type === CHUNK_BIN) {
      bin = buf.subarray(off + 8, off + 8 + len);
    }
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  const n = NCOMP[acc.type];
  const comp = COMPONENT[acc.componentType];
  if (!comp) throw new Error(`unsupported componentType ${acc.componentType}`);
  const out = new Float32Array(acc.count * n);

  if (acc.bufferView === undefined) return out; // sparse-only / zero-filled

  const bv = gltf.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || n * comp.size;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  for (let i = 0; i < acc.count; i++) {
    const row = base + i * stride;
    for (let c = 0; c < n; c++) {
      const v = comp.get(dv, row + c * comp.size);
      out[i * n + c] = acc.normalized ? v / comp.norm : v;
    }
  }
  return out;
}

// ---- image decoding -------------------------------------------------------

function decodePNG(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let w = 0, h = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null;
  const idat = [];

  while (off < bytes.length) {
    const len = dv.getUint32(off, false);
    const type = dv.getUint32(off + 4, false);
    const body = off + 8;
    if (type === 0x49484452) {
      w = dv.getUint32(body, false);
      h = dv.getUint32(body + 4, false);
      depth = dv.getUint8(body + 8);
      colorType = dv.getUint8(body + 9);
      interlace = dv.getUint8(body + 12);
    } else if (type === 0x504c5445) {
      palette = new Uint8Array(bytes.buffer, bytes.byteOffset + body, len * 3);
    } else if (type === 0x49444154) {
      idat.push(new Uint8Array(bytes.buffer, bytes.byteOffset + body, len));
    } else if (type === 0x49454e44) break;
    off = body + len + 4;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} unsupported`);
  if (interlace) throw new Error('interlaced PNG unsupported');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG colour type ${colorType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = new Uint8Array(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const src = raw.subarray(pos, pos + stride);
    pos += stride;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = y > 0 && x >= channels ? px[prev + x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = v & 0xff;
    }
  }

  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    else if (colorType === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (colorType === 0) { r = g = b = px[i]; }
    else if (colorType === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else { const k = px[i] * 3; r = palette[k]; g = palette[k + 1]; b = palette[k + 2]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width: w, height: h, data: rgba };
}

function decodeImage(bytes, mime) {
  try {
    if (mime === 'image/png') return decodePNG(bytes);
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
      // Shell out rather than reimplement a JPEG decoder.
      const dir = mkdtempSync(join(tmpdir(), 'glb-tex-'));
      try {
        const src = join(dir, 'in.jpg');
        const dst = join(dir, 'out.png');
        writeFileSync(src, bytes);
        execFileSync('sips', ['-s', 'format', 'png', src, '--out', dst], { stdio: 'ignore' });
        return decodePNG(new Uint8Array(readFileSync(dst)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---- scene traversal ------------------------------------------------------

const mat4 = {
  identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
          + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
  fromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
    const [x, y, z, w] = q;
    const m = new Float32Array(16);
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
    m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
    m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
    return m;
  },
  point(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
  },
  dir(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    ];
  },
};

// Collects every triangle in the file, in world space, with its morph deltas.
export function extractMesh(gltf, bin) {
  const nodes = gltf.nodes || [];
  const meshes = gltf.meshes || [];
  const scene = gltf.scenes?.[gltf.scene ?? 0] || gltf.scenes?.[0];
  const roots = scene ? scene.nodes : nodes.map((_, i) => i);

  const prims = [];
  const targetNames = new Set();

  const visit = (nodeIndex, parent) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    let local;
    if (node.matrix) local = Float32Array.from(node.matrix);
    else local = mat4.fromTRS(node.translation, node.rotation, node.scale);
    const world = mat4.multiply(parent, local);

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      const names = mesh.extras?.targetNames || node.extras?.targetNames || [];
      for (const prim of mesh.primitives) {
        if ((prim.mode ?? 4) !== 4) continue; // triangles only
        const targetDefs = prim.targets || [];
        prims.push({ prim, world, names, mesh });
        for (let i = 0; i < targetDefs.length; i++) targetNames.add(names[i] || `target_${i}`);
      }
    }
    for (const child of node.children || []) visit(child, world);
  };
  for (const r of roots) visit(r, mat4.identity());

  return { prims, targetNames: [...targetNames] };
}

// Turns one primitive into flat arrays ready for sampling.
export function preparePrimitive(gltf, bin, entry) {
  const { prim, world } = entry;
  const attrs = prim.attributes;
  if (attrs.POSITION === undefined) return null;

  const pos = readAccessor(gltf, bin, attrs.POSITION);
  const nrm = attrs.NORMAL !== undefined ? readAccessor(gltf, bin, attrs.NORMAL) : null;
  const uv = attrs.TEXCOORD_0 !== undefined ? readAccessor(gltf, bin, attrs.TEXCOORD_0) : null;
  const col = attrs.COLOR_0 !== undefined ? readAccessor(gltf, bin, attrs.COLOR_0) : null;

  let idx;
  if (prim.indices !== undefined) {
    idx = readAccessor(gltf, bin, prim.indices);
  } else {
    idx = new Float32Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
  }

  // glTF morph targets hold displacements, not absolute positions.
  const targets = (prim.targets || []).map((t, i) => ({
    name: entry.names[i] || `target_${i}`,
    pos: readAccessor(gltf, bin, t.POSITION),
  }));

  return { pos, nrm, uv, col, idx, targets, world, material: prim.material };
}

export function buildTexture(gltf, bin, materialIndex) {
  const mat = gltf.materials?.[materialIndex];
  const pbr = mat?.pbrMetallicRoughness || {};
  const factor = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];
  const texRef = pbr.baseColorTexture;
  if (!texRef) return { sample: () => factor.slice(0, 3), factor, width: 0, height: 0 };

  const tex = gltf.textures?.[texRef.index];
  const img = gltf.images?.[tex.source];
  if (!img) return { sample: () => factor.slice(0, 3), factor, width: 0, height: 0 };

  let bytes;
  if (img.bufferView !== undefined) {
    const bv = gltf.bufferViews[img.bufferView];
    bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  } else if (img.uri?.startsWith('data:')) {
    bytes = Buffer.from(img.uri.split(',')[1], 'base64');
  } else {
    return { sample: () => factor.slice(0, 3), factor, width: 0, height: 0 };
  }

  const decoded = decodeImage(bytes, img.mimeType);
  if (!decoded) {
    console.warn(`  ! could not decode ${img.mimeType} texture; using flat material colour`);
    return { sample: () => factor.slice(0, 3), factor, width: 0, height: 0 };
  }

  const { width, height, data } = decoded;
  const sample = (u, v) => {
    // glTF UV origin is top-left.
    let x = Math.floor(((u % 1) + 1) % 1 * width);
    let y = Math.floor(((v % 1) + 1) % 1 * height);
    if (x >= width) x = width - 1;
    if (y >= height) y = height - 1;
    const o = (y * width + x) * 4;
    return [
      (data[o] / 255) * factor[0],
      (data[o + 1] / 255) * factor[1],
      (data[o + 2] / 255) * factor[2],
    ];
  };
  return { sample, factor, width, height };
}

export { readAccessor, mat4 };
