// macOS `say` + afconvert. Node-only: server/pipeline/tts.mjs registers this as
// the `say` provider, and the Worker never imports this file.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../env.mjs';

const run = promisify(execFile);
const SAMPLE_RATE = 22050;

export async function speakSay(text, opts = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('TTS_PROVIDER=say requires macOS; use elevenlabs or none');
  }
  const voice = opts.voice || env('TTS_VOICE', 'Samantha');
  const rate = opts.rate || env('TTS_RATE', '185');
  const dir = await mkdtemp(join(tmpdir(), 'avtr-'));
  const aiff = join(dir, 'out.aiff');
  const wav = join(dir, 'out.wav');
  try {
    await run('say', ['-v', voice, '-r', String(rate), '-o', aiff, text], {
      timeout: 30_000,
      signal: opts.signal,
    });
    await run('afconvert', ['-f', 'WAVE', '-d', `LEF32@${SAMPLE_RATE}`, aiff, wav], {
      timeout: 30_000,
      signal: opts.signal,
    });
    return {
      wav: await readFile(wav),
      sampleRate: SAMPLE_RATE,
      provider: 'say',
      voice,
      model: 'macOS say',
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
