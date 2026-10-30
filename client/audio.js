// Audio playback + expression timeline.
//
// The audio clock is the master clock. Every segment is scheduled on the
// AudioContext timeline, and the blendshape stream is sampled by asking "how far
// into segment N are we right now?" — so lip sync cannot drift, no matter how
// jittery the network or the render loop is.

export class Speaker {
  constructor() {
    this.ctx = null;
    this.segments = [];
    this.endAt = 0;
    this.gain = null;
    this.turnStart = 0;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1.0;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get time() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  reset() {
    for (const s of this.segments) {
      try { s.source && s.source.stop(); } catch { /* already stopped */ }
    }
    this.segments.length = 0;
    this.endAt = 0;
  }

  async enqueue({ audioUrl, framesUrl, audioBase64, framesData, signal, isCurrent, onLoaded }) {
    const ctx = this.ensure();

    // The local Node server sends URLs into a small in-memory store. The
    // Cloudflare Worker has no shared memory between isolates, so it inlines
    // the WAV (base64) and the frames object in the SSE segment instead.
    const [buf, frames] = await Promise.all([
      audioBase64
        ? Promise.resolve(base64ToArrayBuffer(audioBase64))
        : fetch(audioUrl, { signal }).then((r) => r.arrayBuffer()),
      framesData
        ? Promise.resolve(framesData)
        : fetch(framesUrl, { signal }).then((r) => r.json()),
    ]);

    // A newer turn may have started while these were in flight.
    if (signal?.aborted || (isCurrent && !isCurrent())) return null;

    const audio = await ctx.decodeAudioData(buf);
    if (signal?.aborted || (isCurrent && !isCurrent())) return null;

    const names = frames.names;
    const columns = Object.fromEntries(names.map((n, i) => [n, i]));
    const data = frames.frames.map((f) => Float32Array.from(f));

    const startAt = Math.max(ctx.currentTime + 0.06, this.endAt || 0);
    const source = ctx.createBufferSource();
    source.buffer = audio;
    source.connect(this.gain);
    source.start(startAt);

    const seg = {
      startAt,
      duration: audio.duration,
      fps: frames.fps,
      columns,
      data,
      source,
    };
    seg.endAt = startAt + audio.duration;
    this.segments.push(seg);
    this.endAt = seg.endAt;
    if (this.segments.length === 1) this.turnStart = startAt;
    if (onLoaded) onLoaded(seg);
    return seg;
  }

  // Returns { values, energy, active } for the current instant.
  sample() {
    if (!this.ctx) return { values: {}, energy: 0, active: false };

    const now = this.ctx.currentTime;
    // drop finished segments
    while (this.segments.length && this.segments[0].endAt < now - 0.5) this.segments.shift();

    const seg = this.segments.find((s) => now >= s.startAt && now < s.endAt);
    if (!seg) return { values: {}, energy: 0, active: false };

    const t = now - seg.startAt;
    const x = t * seg.fps;
    const i0 = Math.min(seg.data.length - 1, Math.max(0, Math.floor(x)));
    const i1 = Math.min(seg.data.length - 1, i0 + 1);
    const f = x - i0;

    const values = {};
    let energy = 0;
    for (const [name, col] of Object.entries(seg.columns)) {
      const a = seg.data[i0][col];
      const b = seg.data[i1][col];
      const v = a + (b - a) * f;
      values[name] = v;
      if (name === 'jawOpen') energy = v;
    }
    return { values, energy, active: true, t };
  }

  get speaking() {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    return this.segments.some((s) => now >= s.startAt - 0.02 && now < s.endAt);
  }

  get queued() {
    return this.segments.length;
  }
}

export function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
