// Minimal .npy reader. numpy's format is a magic string, a dict header, then a
// raw little-endian buffer — no compression, no chunking, no zip.
//
// We use it so the Python side (which already has numpy) can dump tensors
// without us agreeing on a bespoke container.

import { readFileSync } from 'node:fs';

const MAGIC = 0x93;

export function parseNpy(buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8[0] !== MAGIC || u8[1] !== 0x4e || u8[2] !== 0x55 || u8[3] !== 0x4d) {
    throw new Error('not a .npy file');
  }
  const major = u8[6];
  let headerLen;
  let headerStart;
  if (major === 1) {
    headerLen = u8[8] | (u8[9] << 8);
    headerStart = 10;
  } else {
    headerLen = u8[8] | (u8[9] << 8) | (u8[10] << 16) | (u8[11] << 24);
    headerStart = 12;
  }
  const header = new TextDecoder().decode(u8.subarray(headerStart, headerStart + headerLen));

  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1] === 'True';
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] || '';
  const shape = shapeStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);

  if (fortran) throw new Error('fortran-ordered arrays are not supported');

  const dataStart = headerStart + headerLen;
  const data = buffer.slice(dataStart);
  const count = shape.reduce((a, b) => a * b, 1);

  let arr;
  switch (descr) {
    case '<f4': arr = new Float32Array(data); break;
    case '<f8': arr = new Float64Array(data); break;
    case '<i4': arr = new Int32Array(data); break;
    case '<i8': arr = new BigInt64Array(data); break;
    case '<u4': arr = new Uint32Array(data); break;
    case '<u1': arr = new Uint8Array(data); break;
    case '|u1': arr = new Uint8Array(data); break;
    case '<i2': arr = new Int16Array(data); break;
    default: throw new Error(`unsupported dtype ${descr}`);
  }
  if (arr.length !== count) {
    throw new Error(`expected ${count} values, buffer holds ${arr.length}`);
  }
  return { data: arr, shape, dtype: descr };
}

export function loadNpy(path) {
  const buf = readFileSync(path);
  return parseNpy(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// Writer, used only by the synthetic fixture generator.
export function encodeNpy(data, shape) {
  if (!(data instanceof Float32Array)) throw new Error('encodeNpy only writes float32');
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  const preamble = 10;
  const total = preamble + header.length + 1;
  const pad = (64 - (total % 64)) % 64;
  header = header + ' '.repeat(pad) + '\n';

  const out = Buffer.alloc(preamble + header.length + data.length * 4);
  out[0] = 0x93;
  out.write('NUMPY', 1, 'ascii');
  out[6] = 1; // major
  out[7] = 0; // minor
  out.writeUInt16LE(header.length, 8);
  out.write(header, 10, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, preamble + header.length);
  return out;
}
