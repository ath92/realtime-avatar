// Minimal WAV helpers. We standardise on 32-bit float mono, which is what
// `afconvert -d LEF32@22050` gives us and what WebAudio decodes natively.

export function readWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);        // IEEE float
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) buf.writeFloatLE(samples[i], 44 + i * 4);
  return buf;
}
