// Speech -> text. The mirror image of tts-core.mjs: one provider-neutral
// contract, vendor code isolated behind it, and errors that name the env var
// (and, for keys, the permission) a human has to fix.
//
//   transcribe(bytes, { mime, language, signal }) -> { text, provider, model, ms }
//
// Providers:
//   elevenlabs - Scribe (POST /v1/speech-to-text); the same key as the voice
//   openai     - Whisper or gpt-4o-transcribe (POST /audio/transcriptions)
//   none       - not configured; voice input is unavailable, with a hint
//
// The browser uploads 16 kHz mono 16-bit WAV, so both providers get multipart
// form data they already understand. Scribe additionally accepts that payload as
// headerless PCM, which shaves its decode step; see scribeFile().

import { env, envBool, envNum } from '../env.mjs';
import { deadline, fetchWithRetry, mapAbort } from './http.mjs';

const ELEVEN_MODEL = 'scribe_v2';
const OPENAI_MODEL = 'whisper-1';
const DEFAULT_MAX_MB = 8;      // ~8 minutes of 16 kHz PCM; a spoken turn is ~40 kB/s
const MIN_AUDIO_BYTES = 3200;  // 100 ms of 16 kHz mono 16-bit, Scribe's minimum

const MIME_EXT = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
};

function isLocalBase(base) {
  try {
    const host = new URL(base).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
      || host === '::1' || host === '[::1]' || host === 'host.docker.internal';
  } catch {
    return false;
  }
}

// `OPENAI_STT_BASE_URL` exists because the LLM often points OPENAI_BASE_URL at a
// chat-only endpoint (Groq, OpenRouter, a local llama), while Whisper might live
// somewhere else — a whisper.cpp box on the LAN, say.
function openaiBase() {
  const base = env('OPENAI_STT_BASE_URL') || env('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  return base.replace(/\/+$/, '');
}

// ---------------------------------------------------------------- selection --

export function sttProvider() {
  const explicit = env('STT_PROVIDER').toLowerCase();
  if (explicit === 'off' || explicit === 'disabled') return 'none';
  if (explicit) return explicit;
  if (env('ELEVENLABS_API_KEY')) return 'elevenlabs';
  if (env('OPENAI_API_KEY')) return 'openai';
  return 'none';
}

export function sttMaxAudioBytes() {
  const mb = envNum('STT_MAX_AUDIO_MB', DEFAULT_MAX_MB);
  return Math.max(1, Math.round(mb)) * 1024 * 1024;
}

export const STT_SETUP =
  'set ELEVENLABS_API_KEY (Scribe) or OPENAI_API_KEY (Whisper), then restart — '
  + 'in .env locally, or as a Worker secret when deployed';

export function sttInfo() {
  const provider = sttProvider();
  const shared = {
    provider,
    language: env('STT_LANGUAGE') || 'auto',
    maxAudioBytes: sttMaxAudioBytes(),
  };

  if (provider === 'elevenlabs') {
    const available = Boolean(env('ELEVENLABS_API_KEY'));
    return {
      ...shared,
      available,
      model: env('ELEVENLABS_STT_MODEL', ELEVEN_MODEL),
      ...(available ? {} : { hint: STT_SETUP }),
    };
  }
  if (provider === 'openai') {
    const baseUrl = openaiBase();
    const available = Boolean(env('OPENAI_API_KEY')) || isLocalBase(baseUrl);
    return {
      ...shared,
      available,
      model: env('OPENAI_STT_MODEL', OPENAI_MODEL),
      baseUrl,
      ...(available ? {} : { hint: STT_SETUP }),
    };
  }
  if (provider === 'none') {
    return { ...shared, available: false, model: 'none', hint: STT_SETUP };
  }
  return {
    ...shared,
    available: false,
    model: 'unknown',
    error: `unknown STT_PROVIDER "${provider}"`,
    hint: 'use elevenlabs, openai, or none',
  };
}

// ------------------------------------------------------------------ helpers --

function unavailable() {
  const err = new Error(`speech-to-text is not configured: ${STT_SETUP}`);
  err.status = 503;
  err.code = 'STT_UNAVAILABLE';
  return err;
}

async function toBytes(audio) {
  if (audio == null) return new Uint8Array(0);
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (ArrayBuffer.isView(audio)) {
    return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  if (typeof Blob !== 'undefined' && audio instanceof Blob) return new Uint8Array(await audio.arrayBuffer());
  throw new Error('transcribe: audio must be a Uint8Array, ArrayBuffer, or Blob');
}

function cleanTranscript(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function readJson(res, label) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned a non-JSON response: ${raw.slice(0, 200)}`);
  }
}

// A scoped API key is the most common reason voice input silently cannot work:
// TTS needs text_to_speech, Scribe needs speech_to_text. Say so instead of
// leaving "401 unauthorized" to the reader.
function explain(err, provider) {
  if (provider === 'elevenlabs' && err?.status === 401 && /permission|scope/i.test(err.message)) {
    err.message += ' — enable the speech_to_text permission on ELEVENLABS_API_KEY '
      + '(ElevenLabs → profile → API keys); keys are scoped per permission';
    err.code = 'STT_PERMISSION';
  }
  return err;
}

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Up to WAV 16 kHz mono 16-bit -> headerless PCM, which is exactly what Scribe's
// `pcm_s16le_16` file_format wants. Anything else is passed through untouched.
function asRawPcm16k(bytes) {
  if (bytes.length < 44 + MIN_AUDIO_BYTES) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) return null; // RIFF
  if (dv.getUint32(8, false) !== 0x57415645) return null; // WAVE

  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= dv.byteLength) {
    const id = dv.getUint32(pos, false);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420 && size >= 16) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461) {
      data = { offset: body, size: Math.min(size, Math.max(0, dv.byteLength - body)) };
    }
    pos = body + size + (size & 1);
  }

  if (!fmt || !data) return null;
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) return null;
  if (data.size < MIN_AUDIO_BYTES) return null;
  return bytes.subarray(data.offset, data.offset + data.size);
}

function scribeFile(bytes, mime) {
  if (envBool('ELEVENLABS_STT_PCM', true)) {
    const pcm = asRawPcm16k(bytes);
    if (pcm) {
      return { bytes: pcm, name: 'speech.pcm', type: 'application/octet-stream', format: 'pcm_s16le_16' };
    }
  }
  const ext = MIME_EXT[mime] || 'wav';
  return { bytes, name: `speech.${ext}`, type: mime || 'audio/wav' };
}

function plainFile(bytes, mime) {
  const ext = MIME_EXT[mime] || 'wav';
  return { bytes, name: `speech.${ext}`, type: mime || 'audio/wav' };
}

function appendAudio(form, file) {
  form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
}

// -------------------------------------------------------------- elevenlabs --

function elevenConfig() {
  const apiKey = env('ELEVENLABS_API_KEY');
  if (!apiKey) throw unavailable();
  return {
    apiKey,
    baseUrl: env('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io').replace(/\/+$/, ''),
    model: env('ELEVENLABS_STT_MODEL', ELEVEN_MODEL),
    language: env('STT_LANGUAGE'),
    enableLogging: envBool('ELEVENLABS_ENABLE_LOGGING', true),
    timeoutMs: envNum('STT_TIMEOUT_MS', 30_000),
    attempts: envNum('STT_RETRIES', 1) + 1,
  };
}

async function transcribeElevenLabs(bytes, opts) {
  const cfg = elevenConfig();
  const file = scribeFile(bytes, opts.mime);
  const language = opts.language || cfg.language;

  const form = new FormData();
  appendAudio(form, file);
  form.append('model_id', cfg.model);
  form.append('tag_audio_events', 'false');   // (laughter) tags are noise to an LLM
  if (file.format) form.append('file_format', file.format);
  if (language) form.append('language_code', language);

  const query = new URLSearchParams({ enable_logging: String(cfg.enableLogging) });
  const url = `${cfg.baseUrl}/v1/speech-to-text?${query}`;
  const signal = deadline(opts.signal, cfg.timeoutMs);

  let res;
  try {
    res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey },
      body: form,
      signal,
    }, { attempts: cfg.attempts, label: 'elevenlabs', signal });
  } catch (err) {
    throw explain(mapAbort(err, 'ElevenLabs speech-to-text', cfg.timeoutMs), 'elevenlabs');
  }

  const data = await readJson(res, 'elevenlabs');
  return {
    text: cleanTranscript(data.text),
    provider: 'elevenlabs',
    model: cfg.model,
    language: data.language_code || language || '',
  };
}

// ------------------------------------------------------------------- openai --

function openaiConfig() {
  const baseUrl = openaiBase();
  const apiKey = env('OPENAI_API_KEY');
  if (!apiKey && !isLocalBase(baseUrl)) throw unavailable();
  return {
    apiKey,
    baseUrl,
    model: env('OPENAI_STT_MODEL', OPENAI_MODEL),
    language: env('STT_LANGUAGE'),
    timeoutMs: envNum('STT_TIMEOUT_MS', 30_000),
    attempts: envNum('STT_RETRIES', 1) + 1,
  };
}

async function transcribeOpenAI(bytes, opts) {
  const cfg = openaiConfig();
  const file = plainFile(bytes, opts.mime);
  const language = opts.language || cfg.language;

  const form = new FormData();
  appendAudio(form, file);
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const signal = deadline(opts.signal, cfg.timeoutMs);
  let res;
  try {
    res = await fetchWithRetry(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal,
    }, { attempts: cfg.attempts, label: 'openai', signal });
  } catch (err) {
    throw mapAbort(err, 'OpenAI speech-to-text', cfg.timeoutMs);
  }

  const data = await readJson(res, 'openai');
  return {
    text: cleanTranscript(data.text),
    provider: 'openai',
    model: cfg.model,
    language: data.language || language || '',
  };
}

// -------------------------------------------------------------------- entry --

export async function transcribe(audio, opts = {}) {
  const provider = String(opts.provider || sttProvider()).toLowerCase();
  if (provider === 'none') throw unavailable();

  const bytes = await toBytes(audio);
  if (!bytes.length) throw badRequest('empty audio');
  const max = sttMaxAudioBytes();
  if (bytes.length > max) {
    throw badRequest(`audio too large (${(bytes.length / 1024 / 1024).toFixed(1)} MB, max ${max / 1024 / 1024} MB)`, 413);
  }

  const mime = String(opts.mime || 'audio/wav').split(';')[0].trim().toLowerCase();
  const started = performance.now();

  let result;
  if (provider === 'elevenlabs') result = await transcribeElevenLabs(bytes, { ...opts, mime });
  else if (provider === 'openai') result = await transcribeOpenAI(bytes, { ...opts, mime });
  else {
    const err = new Error(`unknown STT_PROVIDER "${provider}" (use elevenlabs, openai, or none)`);
    err.status = 503;
    throw err;
  }

  return { ...result, audioBytes: bytes.length, ms: Math.round(performance.now() - started) };
}
