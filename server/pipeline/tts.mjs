// Text -> speech.
//
// Default provider shells out to macOS `say` (free, local, surprisingly good)
// and converts to 32-bit float WAV. Swap in ElevenLabs / Cartesia / CosyVoice
// by implementing the same `speak(text) -> { wav, sampleRate }` contract; keep
// the streaming boundary roughly the same (one call per segment) and the rest
// of the pipeline does not change.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWavFloat32 } from './wav.mjs';

const run = promisify(execFile);

const SAMPLE_RATE = 22050;

export function ttsAvailable() {
  return process.platform === 'darwin';
}

// A synthetic fallback so the pipeline still runs on Linux CI: one tone burst
// per syllable, rhythm driven by the text. It is not speech, but it does make
// the mouth move in a way that tracks the audio.
function babble(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const samples = [];
  let phase = 0;
  for (const w of words) {
    const syllables = Math.max(1, Math.round(w.length / 3));
    for (let s = 0; s < syllables; s++) {
      const dur = 0.11 + (w.length % 5) * 0.012;
      const n = Math.round(dur * SAMPLE_RATE);
      const f0 = 110 + ((w.charCodeAt(s % w.length) * 7) % 60);
      const f1 = 700 + ((w.charCodeAt(s % w.length) * 13) % 500);
      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.min(1, t * 40) * Math.min(1, (dur - t) * 30);
        phase += (2 * Math.PI * f0) / SAMPLE_RATE;
        const v = Math.sin(phase) * 0.5
          + Math.sin(phase * (f1 / f0)) * 0.2
          + Math.sin(phase * 2) * 0.1;
        samples.push(v * env * 0.25);
      }
      const gap = Math.round(0.03 * SAMPLE_RATE);
      for (let i = 0; i < gap; i++) samples.push(0);
    }
  }
  return Float32Array.from(samples);
}

export async function speak(text, opts = {}) {
  const voice = opts.voice || process.env.TTS_VOICE || 'Samantha';
  const rate = opts.rate || process.env.TTS_RATE || '185';
  const clean = text.replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  if (process.env.TTS_PROVIDER === 'none' || !ttsAvailable()) {
    const samples = babble(clean);
    return { wav: writeWavFloat32(samples, SAMPLE_RATE), sampleRate: SAMPLE_RATE };
  }

  const dir = await mkdtemp(join(tmpdir(), 'avtr-'));
  const aiff = join(dir, 'out.aiff');
  const wav = join(dir, 'out.wav');
  try {
    await run('say', ['-v', voice, '-r', String(rate), '-o', aiff, clean], { timeout: 30000 });
    await run('afconvert', ['-f', 'WAVE', `-d`, `LEF32@${SAMPLE_RATE}`, aiff, wav], { timeout: 30000 });
    const buf = await readFile(wav);
    return { wav: buf, sampleRate: SAMPLE_RATE };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
