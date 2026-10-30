// Microphone capture for voice input.
//
// Browsers hand back a different container per platform (Opus/WebM in Chrome,
// AAC/MP4 in Safari). Rather than teach the speech-to-text adapters every
// container, the recording is decoded with WebAudio at 16 kHz, the silence is
// trimmed, and 16-bit PCM WAV goes on the wire: one format from every browser,
// ~32 kB/s, and Scribe can take it as raw PCM without a decode.
//
// Push-to-talk and hands-free use the same object: start() records, the level
// ticker watches for the end of the utterance, and stop() returns the bytes.
// PURE_HELPERS is the part that does not need a browser; it is unit-tested.

const TARGET_RATE = 16000;
const MIN_SPEECH_MS = 200;

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function micSupported() {
  return typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && typeof window !== 'undefined'
    && Boolean(window.MediaRecorder || typeof MediaRecorder !== 'undefined');
}

// ------------------------------------------------------------------ helpers --

export function encodeWav16(samples, sampleRate = TARGET_RATE) {
  const n = samples.length;
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);              // PCM
  dv.setUint16(22, 1, true);              // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

// Keep the spoken part and a little air either side. Providers charge by the
// minute and a long silent tail is also where hallucinated transcripts come from.
export function trimToSpeech(samples, sampleRate = TARGET_RATE, opts = {}) {
  const threshold = opts.threshold ?? 0.01;
  const padBefore = Math.round((opts.padBefore ?? 0.15) * sampleRate);
  const padAfter = Math.round((opts.padAfter ?? 0.25) * sampleRate);

  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) { first = i; break; }
  }
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) >= threshold) { last = i; break; }
  }
  if (first < 0 || last < first) {
    return { samples: samples.subarray(0, 0), speechMs: 0, durationMs: 0 };
  }

  const start = Math.max(0, first - padBefore);
  const end = Math.min(samples.length, last + 1 + padAfter);
  const out = samples.subarray(start, end);
  return {
    samples: out,
    speechMs: Math.round(((last - first + 1) / sampleRate) * 1000),
    durationMs: Math.round((out.length / sampleRate) * 1000),
  };
}

export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const x = i * ratio;
    const i0 = Math.min(samples.length - 1, Math.floor(x));
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const f = x - i0;
    out[i] = samples[i0] * (1 - f) + samples[i1] * f;
  }
  return out;
}

function permissionMessage(err) {
  if (!err) return 'could not open the microphone';
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
    return 'microphone permission was denied — allow it for this site and try again';
  }
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
    return 'no microphone was found — plug one in, or type instead';
  }
  if (err.name === 'NotReadableError' || err.name === 'AbortError') {
    return 'the microphone is busy in another app — close it and try again';
  }
  return err.message || String(err);
}

async function decodeMono(buffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) return null;

  let audio;
  try {
    audio = await new Offline(1, 1, TARGET_RATE).decodeAudioData(buffer);
  } catch {
    return null; // the caller falls back to the browser's own container
  }

  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / audio.numberOfChannels;
  }
  return audio.sampleRate === TARGET_RATE ? mono : resampleLinear(mono, audio.sampleRate, TARGET_RATE);
}

// ----------------------------------------------------------------- recorder --

export class VoiceRecorder {
  constructor(opts = {}) {
    this.silenceMs = opts.silenceMs ?? 1100;   // end of utterance → stop
    this.leadInMs = opts.leadInMs ?? 8000;     // nothing said at all → stop
    this.maxMs = opts.maxMs ?? 30_000;         // hard cap per utterance
    this.onLevel = opts.onLevel || (() => {});
    this.onAutoStop = opts.onAutoStop || (() => {});

    this.stream = null;
    this.recorder = null;
    this.ctx = null;
    this.analyser = null;
    this.timer = null;
    this.chunks = [];
    this.stopped = null;
    this.resolveStopped = null;
    this.cancelled = false;
  }

  get active() {
    return Boolean(this.recorder);
  }

  async start() {
    if (this.recorder) return;
    if (!micSupported()) {
      throw new Error('this browser cannot record audio (needs getUserMedia and MediaRecorder, over https or localhost)');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      throw new Error(permissionMessage(err));
    }

    this.cancelled = false;
    this.chunks = [];

    const type = MIME_CANDIDATES.find((candidate) => {
      try { return MediaRecorder.isTypeSupported(candidate); } catch { return false; }
    }) || '';
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.mimeType = this.recorder.mimeType || type || 'audio/webm';
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.chunks.push(event.data);
    };
    this.stopped = new Promise((resolve) => { this.resolveStopped = resolve; });
    this.recorder.onstop = () => this.resolveStopped?.();
    this.recorder.onerror = () => this.resolveStopped?.();

    try {
      this.recorder.start(200);
    } catch (err) {
      this.teardown();
      throw new Error(`could not start recording: ${err.message || err}`);
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    try {
      this.ctx = new AudioCtx();
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch { /* capture still works */ }
      }
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.5;
      this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    } catch (err) {
      this.teardown();
      throw new Error(`could not open the microphone: ${err.message || err}`);
    }
    this.buf = new Float32Array(this.analyser.fftSize);

    this.startedAt = performance.now();
    this.spokeAt = 0;
    this.lastVoiceAt = 0;
    this.autoStopped = false;
    // A decaying minimum: it learns the room during the pause before speech and
    // never creeps up while someone is talking, which would deafen the VAD.
    this.floor = 0.004;
    this.timer = setInterval(() => this.tick(), 50);
  }

  tick() {
    if (!this.analyser || !this.recorder) return;
    const now = performance.now();
    this.analyser.getFloatTimeDomainData(this.buf);

    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);

    const threshold = Math.max(0.006, this.floor * 3);
    const speaking = rms >= threshold;
    if (rms < this.floor) this.floor = Math.max(0.0015, this.floor * 0.6 + rms * 0.4);

    if (speaking) {
      if (!this.spokeAt) this.spokeAt = now;
      this.lastVoiceAt = now;
    }

    this.onLevel(Math.min(1, rms / 0.08), speaking);

    if (this.autoStopped) return;
    if (!this.spokeAt && now - this.startedAt > this.leadInMs) return this.autoStop('no-speech');
    if (this.spokeAt && now - this.lastVoiceAt > this.silenceMs) return this.autoStop('silence');
    if (now - this.startedAt > this.maxMs) return this.autoStop('max');
  }

  autoStop(reason) {
    this.autoStopped = true;
    this.onAutoStop(reason);
  }

  async stop() {
    const recorder = this.recorder;
    if (!recorder) return null;
    const durationMs = Math.round(performance.now() - this.startedAt);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.onLevel(0, false);

    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch { /* already stopped */ }
    await this.stopped;

    const blob = new Blob(this.chunks, { type: this.mimeType });
    this.teardown();
    if (this.cancelled) return null;

    const buffer = await blob.arrayBuffer();
    const mono = await decodeMono(buffer);
    if (!mono) {
      // decodeAudioData failed (unusual): send the container the browser chose.
      // Both providers accept WebM and MP4.
      return {
        bytes: new Uint8Array(buffer),
        mime: blob.type || 'audio/webm',
        durationMs,
        empty: false,
      };
    }

    const trimmed = trimToSpeech(mono, TARGET_RATE);
    if (trimmed.speechMs < MIN_SPEECH_MS) {
      return { empty: true, reason: 'silence', durationMs };
    }
    return {
      bytes: encodeWav16(trimmed.samples, TARGET_RATE),
      mime: 'audio/wav',
      durationMs: trimmed.durationMs,
      empty: false,
    };
  }

  cancel() {
    this.cancelled = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch { /* already stopped */ }
    this.resolveStopped?.();
    this.teardown();
    this.onLevel(0, false);
  }

  teardown() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    }
    this.stream = null;
    this.recorder = null;
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* already closed */ }
    }
    this.ctx = null;
    this.analyser = null;
  }
}
