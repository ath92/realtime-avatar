// .avtr — a dead-simple binary container for a blendshape-rigged Gaussian avatar.
//
//   "AVTR" | u32 version | u32 jsonLen | json | buffers...
//
// Layout (little-endian, all f32):
//   positions  [n*3]      xyz in metres, head-local space (y up, +z forward)
//   scales     [n*3]      per-axis sigma in metres
//   quats      [n*4]      xyzw
//   colors     [n*3]      linear RGB 0..1
//   opacity    [n]
//   weights    [n*nb]     blendshape weight 0..1 per gaussian
//   deltas     [n*nb*3]   displacement in metres applied when weight == 1
//
// Dense storage keeps the format trivial. It gzips to roughly 1/6 on the wire
// because most of the delta block is zeros.

const MAGIC = 0x41565452; // "AVTR"
const VERSION = 1;
export const DEFAULT_ORDER = [
  'positions', 'scales', 'quats', 'colors', 'opacity', 'weights', 'deltas',
];

export function layout(n, nb) {
  let off = 0;
  const put = (count) => { const o = off; off += count * 4; return o; };
  const map = {
    positions: { offset: put(n * 3), count: n * 3 },
    scales: { offset: put(n * 3), count: n * 3 },
    quats: { offset: put(n * 4), count: n * 4 },
    colors: { offset: put(n * 3), count: n * 3 },
    opacity: { offset: put(n), count: n },
    weights: { offset: put(n * nb), count: n * nb },
    deltas: { offset: put(n * nb * 3), count: n * nb * 3 },
  };
  return { map, bytes: off };
}

function pad4(n) { return (n + 3) & ~3; }

export function encodeAvatar(avatar) {
  const { n, nb, names } = avatar;
  const json = new TextEncoder().encode(JSON.stringify({
    n, nb, names, order: DEFAULT_ORDER, version: VERSION,
  }));
  const jsonPad = pad4(json.length);
  const body = layout(n, nb);
  const total = 12 + jsonPad + body.bytes;
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, json.length, true);
  u8.set(json, 12);

  const base = 12 + jsonPad;
  for (const key of DEFAULT_ORDER) {
    const { offset, count } = body.map[key];
    const src = avatar[key];
    if (!src || src.length !== count) {
      throw new Error(`buffer ${key} expected ${count} floats, got ${src ? src.length : 0}`);
    }
    new Float32Array(buf, base + offset, count).set(src);
  }
  return new Uint8Array(buf);
}

export function decodeAvatar(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not an .avtr file');
  const version = dv.getUint32(4, true);
  if (version !== VERSION) throw new Error(`unsupported .avtr version ${version}`);
  const jsonLen = dv.getUint32(8, true);
  const json = JSON.parse(new TextDecoder().decode(
    new Uint8Array(arrayBuffer, 12, jsonLen),
  ));
  const { n, nb, names } = json;
  const body = layout(n, nb);
  const base = 12 + pad4(jsonLen);

  const out = { n, nb, names, quats: null };
  for (const key of DEFAULT_ORDER) {
    const { offset, count } = body.map[key];
    // Copy so the browser does not pin the whole ArrayBuffer per view.
    out[key] = new Float32Array(arrayBuffer.slice(base + offset, base + offset + count * 4));
  }
  out.totalBytes = base + body.bytes;
  return out;
}

export async function loadAvatar(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`avatar fetch failed: ${res.status}`);
  return decodeAvatar(await res.arrayBuffer());
}
