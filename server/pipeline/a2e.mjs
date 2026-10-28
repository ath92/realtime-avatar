// audio -> blendshape frames.
//
// This is the swappable half of the demo. A production system replaces it with
// a learned streaming model (LAM-A2E and friends, ~20 ms/chunk on a GPU). The
// contract stays the same:
//
//   analyze(samples, sampleRate) -> { fps, names, frames: Float32Array[] }
//
// The implementation here is classical DSP — spectrum + loudness per frame,
// mapped onto a handful of visemes. It will not win a lip-sync benchmark, but
// it is deterministic, dependency-free, and good enough to judge the rig.

const NAMES = [
  'jawOpen',
  'mouthFunnel',
  'mouthPucker',
  'mouthSmile_L',
  'mouthSmile_R',
  'browInnerUp',
  'browOuterUp_L',
  'browOuterUp_R',
];

const FPS = 60;
const FFT_SIZE = 1024;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// One-pole envelope follower with separate attack/release so the mouth does not
// chatter on every consonant.
function follower(attack, release) {
  let v = 0;
  return (target) => {
    const k = target > v ? attack : release;
    v += (target - v) * k;
    return v;
  };
}

export function analyze(samples, sampleRate, opts = {}) {
  const fps = opts.fps ?? FPS;
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const nFrames = Math.max(1, Math.ceil(samples.length / hop));

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

  const binHz = sampleRate / FFT_SIZE;
  const band = (f0, f1) => [
    Math.max(1, Math.round(f0 / binHz)),
    Math.min(FFT_SIZE / 2 - 1, Math.round(f1 / binHz)),
  ];
  const [loA, loB] = band(80, 500);
  const [midA, midB] = band(500, 2000);
  const [hiA, hiB] = band(2000, 7000);
  const [f1A, f1B] = band(300, 900);
  const [f2A, f2B] = band(900, 2400);

  // --- pass 1: per-frame spectral features ------------------------------
  const rmsArr = new Float32Array(nFrames);
  const loRArr = new Float32Array(nFrames);
  const hiRArr = new Float32Array(nFrames);
  const f1Arr = new Float32Array(nFrames);
  const f2Arr = new Float32Array(nFrames);
  const fluxArr = new Float32Array(nFrames);
  let prevSpec = new Float32Array(FFT_SIZE / 2);

  for (let f = 0; f < nFrames; f++) {
    const start = f * hop - (FFT_SIZE >> 1);
    let rms = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      const s = idx >= 0 && idx < samples.length ? samples[idx] : 0;
      re[i] = s * win[i];
      im[i] = 0;
      rms += s * s;
    }
    rmsArr[f] = Math.sqrt(rms / FFT_SIZE);
    fft(re, im);

    let lo = 0, hi = 0, total = 0, f1 = 0, f1w = 0, f2 = 0, f2w = 0, flux = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const hz = k * binHz;
      total += p;
      const mag = Math.sqrt(p);
      flux += Math.max(0, mag - prevSpec[k]);
      prevSpec[k] = mag;
      if (k >= loA && k <= loB) lo += p;
      else if (k >= hiA && k <= hiB) hi += p;
      if (k >= f1A && k <= f1B) { f1 += p; f1w += p * hz; }
      if (k >= f2A && k <= f2B) { f2 += p; f2w += p * hz; }
    }
    const eps = 1e-9;
    loRArr[f] = lo / (total + eps);
    hiRArr[f] = hi / (total + eps);
    f1Arr[f] = f1 > eps ? f1w / f1 : 0;
    f2Arr[f] = f2 > eps ? f2w / f2 : 0;
    fluxArr[f] = flux / (FFT_SIZE / 2);
  }

  // --- normalise loudness against this clip, not against a fixed constant ---
  // TTS output varies hugely between voices, so an absolute threshold makes
  // one voice gape and another mumble.
  const sorted = Float32Array.from(rmsArr).sort();
  const peak = sorted[Math.floor(sorted.length * 0.92)] || 1e-6;
  const floor = peak * 0.16;

  const rmsEnv = follower(0.60, 0.30);
  const tensEnv = follower(0.25, 0.10);

  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const r = rmsArr[f];
    const loud = Math.max(0, Math.min(1, (r - floor) / (peak - floor + 1e-9)));
    const open = rmsEnv(Math.pow(loud, 0.85));

    const tense = tensEnv(Math.min(1, hiRArr[f] * 2.0 + fluxArr[f] * 0.6));
    const F2 = f2Arr[f];
    const loR = loRArr[f];

    // crude viseme from F2: low F2 => rounded (o/u), high F2 => spread (i/e)
    const round = Math.max(0, Math.min(1, 1 - (F2 - 750) / 850)) * open;
    const spread = Math.max(0, Math.min(1, (F2 - 1500) / 800)) * open;

    const jaw = Math.min(0.9, open * 0.70);
    const funnel = Math.min(1, round * 0.85);
    const pucker = Math.min(1, round * 0.5 * (1 - spread));
    const smile = Math.min(0.5, spread * 0.45 + 0.06);
    const brow = Math.min(0.55, tense * 0.4 + Math.max(0, open - 0.65) * 0.5);

    const out = new Float32Array(NAMES.length);
    out[0] = jaw;
    out[1] = funnel;
    out[2] = pucker;
    out[3] = smile;
    out[4] = smile;
    out[5] = brow * 0.5;
    out[6] = brow * 0.6;
    out[7] = brow * 0.6;
    frames.push(out);
  }

  return { fps, names: NAMES, frames };
}

// Compact wire form: rounded to 3 dp, which is well below visual threshold and
// roughly halves the JSON size.
export function toJSON({ fps, names, frames }) {
  return {
    fps,
    names,
    frames: frames.map((f) => Array.from(f, (v) => Math.round(v * 1000) / 1000)),
  };
}
