// Minimal WAV helpers. We standardise on 32-bit float mono, which is what
// `afconvert -d LEF32@22050` gives us and what WebAudio decodes natively.
//
// Deliberately Buffer-free: the same code runs in Node and in a Cloudflare
// Worker, where only Uint8Array/DataView exist.

function asBytes(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

export function readWav(buf) {
  const bytes = asBytes(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error('not a RIFF file');

  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= dv.byteLength) {
    const id = dv.getUint32(pos, false);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461) {
      data = { offset: body, size };
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data chunk');

  const n = data.size / (fmt.bits / 8) / fmt.channels;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = data.offset + (i * fmt.channels + c) * (fmt.bits / 8);
      acc += fmt.format === 3 ? dv.getFloat32(o, true)
        : fmt.bits === 16 ? dv.getInt16(o, true) / 32768
          : dv.getUint8(o) / 128 - 1;
    }
    out[i] = acc / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples: out, duration: n / fmt.sampleRate };
}

export function writeWavFloat32(samples, sampleRate) {
  const n = samples.length;
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + n * 4, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);        // IEEE float
  dv.setUint16(22, 1, true);        // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 32, true);
  ascii(36, 'data');
  dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, samples[i], true);
  return bytes;
}
