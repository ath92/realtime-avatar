// Text -> speech.
//
// Providers:
//   elevenlabs - ElevenLabs streaming TTS, raw PCM (no MP3 decoder needed)
//   say        - macOS `say` + afconvert, the zero-key fallback
//   none       - synthetic babble, so CI and Linux still exercise the pipeline
//
// The contract is intentionally boring:
//
//   speak(text, { previousText, signal }) -> { wav, sampleRate, duration, ... }
//
// One call per sentence segment. ElevenLabs is asked for raw 16-bit PCM because
// Node has no built-in audio decoder; `writeWavFloat32` wraps it for WebAudio.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeWavFloat32 } from './wav.mjs';
import { env, envBool, envNum } from '../env.mjs';
import { deadline, fetchWithRetry, mapAbort, readErrorBody, httpError } from './http.mjs';

const run = promisify(execFile);

const SAMPLE_RATE = 22050;
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel, a public library voice
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';
const MAX_TEXT = 2000;
const MAX_PREVIOUS = 500;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function ttsProvider() {
  const explicit = env('TTS_PROVIDER').toLowerCase();
  if (explicit) return explicit === 'babble' ? 'none' : explicit;
  if (env('ELEVENLABS_API_KEY')) return 'elevenlabs';
  if (process.platform === 'darwin') return 'say';
  return 'none';
}

export function ttsAvailable() {
  const provider = ttsProvider();
  if (provider === 'elevenlabs') return Boolean(env('ELEVENLABS_API_KEY'));
  if (provider === 'say') return process.platform === 'darwin';
  if (provider === 'none') return true; // synthetic babble works everywhere
  return false;
}

export function ttsInfo() {
  const provider = ttsProvider();
  if (provider === 'elevenlabs') {
    return {
      provider,
      available: Boolean(env('ELEVENLABS_API_KEY')),
      voiceId: env('ELEVENLABS_VOICE_ID', DEFAULT_VOICE_ID),
      voiceName: env('ELEVENLABS_VOICE_NAME', ''),
      model: env('ELEVENLABS_MODEL_ID', DEFAULT_MODEL_ID),
      format: env('ELEVENLABS_OUTPUT_FORMAT', 'pcm_22050'),
    };
  }
  if (provider === 'say') {
    return {
      provider,
      available: process.platform === 'darwin',
      voice: env('TTS_VOICE', 'Samantha'),
      model: 'macOS say',
    };
  }
  if (provider === 'none') {
    return { provider, available: true, model: 'synthetic babble' };
  }
  return { provider, available: false, error: `unknown TTS_PROVIDER "${provider}"` };
}

function clean(text) {
  let out = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > MAX_TEXT) {
    const cut = out.lastIndexOf(' ', MAX_TEXT);
    out = out.slice(0, cut > MAX_TEXT * 0.6 ? cut : MAX_TEXT);
  }
  return out;
}

// ---------------------------------------------------------------- babble ----

// A synthetic fallback: one tone burst per syllable, rhythm driven by the text.
// It is not speech, but it does make the mouth move in a way that tracks audio.
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
        const envl = Math.min(1, t * 40) * Math.min(1, (dur - t) * 30);
        phase += (2 * Math.PI * f0) / SAMPLE_RATE;
        const v = Math.sin(phase) * 0.5
          + Math.sin(phase * (f1 / f0)) * 0.2
          + Math.sin(phase * 2) * 0.1;
        samples.push(v * envl * 0.25);
      }
      const gap = Math.round(0.03 * SAMPLE_RATE);
      for (let i = 0; i < gap; i++) samples.push(0);
    }
  }
  return Float32Array.from(samples);
}

// ------------------------------------------------------------- elevenlabs ---

function elevenConfig() {
  const apiKey = env('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is not set');

  const format = env('ELEVENLABS_OUTPUT_FORMAT', 'pcm_22050');
  const match = /^pcm_(\d+)$/.exec(format);
  if (!match) {
    throw new Error(
      `ELEVENLABS_OUTPUT_FORMAT must be raw PCM (pcm_16000, pcm_22050, pcm_24000, ...) `
      + `because the server has no MP3 decoder; got "${format}"`,
    );
  }

  return {
    apiKey,
    baseUrl: env('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io').replace(/\/+$/, ''),
    voiceId: env('ELEVENLABS_VOICE_ID', DEFAULT_VOICE_ID),
    modelId: env('ELEVENLABS_MODEL_ID', DEFAULT_MODEL_ID),
    format,
    sampleRate: Number(match[1]),
    languageCode: env('ELEVENLABS_LANGUAGE_CODE'),
    enableLogging: envBool('ELEVENLABS_ENABLE_LOGGING', true),
    stitching: envBool('ELEVENLABS_REQUEST_STITCHING', true),
    timeoutMs: envNum('ELEVENLABS_TIMEOUT_MS', 30_000),
    attempts: envNum('ELEVENLABS_RETRIES', 2) + 1,
  };
}

function voiceSettings() {
  const settings = {
    stability: clamp(envNum('ELEVENLABS_STABILITY', 0.45), 0, 1),
    similarity_boost: clamp(envNum('ELEVENLABS_SIMILARITY', 0.75), 0, 1),
    style: clamp(envNum('ELEVENLABS_STYLE', 0), 0, 1),
    use_speaker_boost: envBool('ELEVENLABS_SPEAKER_BOOST', true),
  };
  if (env('ELEVENLABS_SPEED')) {
    settings.speed = clamp(envNum('ELEVENLABS_SPEED', 1), 0.7, 1.2);
  }
  return settings;
}

function pcm16ToFloat32(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

// Small LRU: repeated greetings and filler are common, and TTS is billed per
// character. Keyed on everything that affects the bytes.
const cache = new Map();

function cacheKey(cfg, text, previousText) {
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    provider: 'elevenlabs',
    base: cfg.baseUrl,
    voice: cfg.voiceId,
    model: cfg.modelId,
    format: cfg.format,
    language: cfg.languageCode,
    settings: voiceSettings(),
    previousText: previousText || '',
    text,
  })).digest('hex');
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  const max = Math.floor(envNum('TTS_CACHE_SIZE', 32));
  if (max <= 0) return;
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

async function speakElevenLabs(text, opts) {
  const cfg = elevenConfig();
  const previousText = opts.previousText && cfg.stitching
    ? String(opts.previousText).slice(-MAX_PREVIOUS)
    : '';
  const key = cacheKey(cfg, text, previousText);
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const body = {
    text,
    model_id: cfg.modelId,
    voice_settings: voiceSettings(),
  };
  if (cfg.languageCode) body.language_code = cfg.languageCode;
  if (previousText) body.previous_text = previousText;

  const query = new URLSearchParams({
    output_format: cfg.format,
    enable_logging: String(cfg.enableLogging),
  });
  const url = `${cfg.baseUrl}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream?${query}`;
  const signal = deadline(opts.signal, cfg.timeoutMs);

  try {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'xi-api-key': cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    }, { attempts: cfg.attempts, label: 'elevenlabs', signal });

    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      throw httpError('elevenlabs', res.status, await readErrorBody(res));
    }

    const samples = pcm16ToFloat32(await res.arrayBuffer());
    if (!samples.length) throw new Error('ElevenLabs returned empty audio');

    const result = {
      wav: writeWavFloat32(samples, cfg.sampleRate),
      sampleRate: cfg.sampleRate,
      duration: samples.length / cfg.sampleRate,
      provider: 'elevenlabs',
      voiceId: cfg.voiceId,
      model: cfg.modelId,
    };
    cacheSet(key, result);
    return result;
  } catch (err) {
    throw mapAbort(err, 'ElevenLabs TTS', cfg.timeoutMs);
  }
}

export async function listVoices(opts = {}) {
  const apiKey = opts.apiKey || env('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const base = env('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs || 15_000;
  const signal = deadline(opts.signal, timeoutMs);
  const res = await fetchWithRetry(`${base}/v1/voices`, {
    headers: { 'xi-api-key': apiKey },
    signal,
  }, { attempts: 2, label: 'elevenlabs', signal });
  const json = await res.json();
  return (json.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels || {},
    description: v.description || '',
    preview: v.preview_url || '',
  }));
}

// --------------------------------------------------------------------- say ---

async function speakSay(text, opts) {
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

// ------------------------------------------------------------------- entry ---

export async function speak(text, opts = {}) {
  const cleanText = clean(text);
  if (!cleanText) return null;

  const provider = (opts.provider || ttsProvider()).toLowerCase();
  if (provider === 'elevenlabs') return speakElevenLabs(cleanText, opts);
  if (provider === 'say') return speakSay(cleanText, opts);
  if (provider === 'none' || provider === 'babble') {
    const samples = babble(cleanText);
    return {
      wav: writeWavFloat32(samples, SAMPLE_RATE),
      sampleRate: SAMPLE_RATE,
      duration: samples.length / SAMPLE_RATE,
      provider: 'none',
      model: 'synthetic babble',
    };
  }
  throw new Error(`unknown TTS_PROVIDER "${provider}" (use elevenlabs, say, or none)`);
}
