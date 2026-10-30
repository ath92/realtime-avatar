// Cloudflare Worker entry point.
//
// Routing is deliberately tiny: /api/* is the backend, everything else is a
// static asset from ./dist (Workers Static Assets). The turn pipeline is shared
// with the local Node server via server/pipeline/turn.mjs.
//
// Media is inlined into the SSE segment instead of being stored under
// /media/<id>: Workers isolates have no shared memory, and KV's eventual
// consistency is the wrong guarantee for audio the browser is about to play.

import { setEnvSource, envNum } from '../server/env.mjs';
import { llmInfo } from '../server/pipeline/llm.mjs';
import { speak, ttsInfo } from '../server/pipeline/tts-core.mjs';
import { transcribe, sttInfo, sttMaxAudioBytes } from '../server/pipeline/stt.mjs';
import { createTurnRunner } from '../server/pipeline/turn.mjs';

const MAX_BODY = 64 * 1024;
const RATE_WINDOW_MS = 60_000;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Robots-Tag': 'noindex, nofollow',
};

const runTurn = createTurnRunner({ speak, ttsInfo });

// Best-effort per-isolate limiter. It is not a substitute for Cloudflare WAF
// rate limiting or Access, but it stops a single tab from hammering the API.
const buckets = new Map();

function overLimit(key, limit) {
  if (!limit || limit <= 0) return false;
  const now = Date.now();
  if (buckets.size > 5_000) {
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) {
    buckets.set(key, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count++;
  return bucket.count > limit;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

function withSecurity(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isAllowedOrigin(origin, requestUrl) {
  // Non-browser clients omit Origin; they are not subject to CSRF. Browsers
  // always send it on a cross-origin POST, which is the case we reject. The
  // site and API intentionally share one origin.
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function handleHealth(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }
  const body = JSON.stringify({ ok: true, tts: ttsInfo(), stt: sttInfo(), llm: llmInfo() });
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

async function handleTranscribe(request) {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  }
  if (!isAllowedOrigin(request.headers.get('origin'), request.url)) {
    return json({ error: 'origin not allowed' }, 403);
  }

  // Transcription is billed per audio minute, so it has its own rate-limit
  // bucket rather than sharing the turn budget.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (overLimit(`${ip}:stt`, envNum('RATE_LIMIT_PER_MINUTE', 20))) {
    return json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
  }

  const mime = String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (mime && !mime.startsWith('audio/') && mime !== 'application/octet-stream') {
    return json({ error: `unsupported content type "${mime}" (send audio/*)` }, 415);
  }

  const max = sttMaxAudioBytes();
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max) {
    return json({ error: `audio too large (max ${Math.round(max / 1024 / 1024)} MB)` }, 413);
  }

  let audio;
  try {
    audio = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ error: 'could not read audio body' }, 400);
  }
  if (audio.length > max) {
    return json({ error: `audio too large (max ${Math.round(max / 1024 / 1024)} MB)` }, 413);
  }
  if (!audio.length) return json({ error: 'empty audio', code: 'STT_EMPTY' }, 400);

  const language = new URL(request.url).searchParams.get('language') || '';
  try {
    const result = await transcribe(audio, { mime: mime || 'audio/wav', language, signal: request.signal });
    return json(result);
  } catch (err) {
    const status = [400, 413, 429, 503].includes(err.status) ? err.status : 502;
    return json({
      error: String(err && err.message || err),
      code: err.code || 'STT_FAILED',
      ...(status === 503 ? { hint: sttInfo().hint } : {}),
    }, status);
  }
}

async function handleTurn(request, ctx) {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  }
  if (!isAllowedOrigin(request.headers.get('origin'), request.url)) {
    return json({ error: 'origin not allowed' }, 403);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (overLimit(ip, envNum('RATE_LIMIT_PER_MINUTE', 20))) {
    return json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json({ error: 'request body too large' }, 413);

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'request body too large' }, 413);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  let closed = false;
  let streamController;

  const onAbort = () => {
    closed = true;
    abort.abort();
  };

  if (request.signal?.aborted) onAbort();
  request.signal?.addEventListener('abort', onAbort, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      onAbort();
    },
  });

  const write = (text) => {
    if (closed) return;
    try {
      streamController.enqueue(encoder.encode(text));
    } catch {
      onAbort();
    }
  };
  const writeFrame = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const emit = (event, data) => {
    if (closed) return;
    if (event !== 'segment') {
      writeFrame(event, data);
      return;
    }
    // The pipeline gives us raw WAV + frames; put them on the wire. Base64 is
    // ~33% larger than the WAV, but it keeps the Worker stateless and avoids a
    // second request per sentence.
    const { wav, frames, ...rest } = data;
    writeFrame('segment', {
      ...rest,
      audioBase64: bytesToBase64(wav),
      framesData: frames,
    });
  };

  const ping = setInterval(() => write(': ping\n\n'), 15_000);

  ctx.waitUntil((async () => {
    try {
      await runTurn({
        text: payload.text,
        history: payload.history,
        signal: abort.signal,
        emit,
      });
    } catch (err) {
      if (!closed) {
        emit('error', { stage: 'server', message: String(err && err.message || err) });
      }
    } finally {
      clearInterval(ping);
      request.signal?.removeEventListener('abort', onAbort);
      if (!closed) {
        closed = true;
        try { streamController.close(); } catch { /* already closed */ }
      }
    }
  })());

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
    },
  });
}

export default {
  async fetch(request, bindings, ctx) {
    // Point the shared env readers at this request's bindings. Bindings are
    // identical for every request in an isolate, so this is cheap and safe.
    setEnvSource(bindings);

    const url = new URL(request.url);

    if (url.pathname === '/api/health') return handleHealth(request);
    if (url.pathname === '/api/turn') return handleTurn(request, ctx);
    if (url.pathname === '/api/transcribe') return handleTranscribe(request);
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not found' }, 404);
    }
    if (url.pathname.startsWith('/media/')) {
      return json({ error: 'media is inlined in the stream' }, 404);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: SECURITY_HEADERS });
    }
    if (!bindings.ASSETS) {
      return new Response('static assets binding missing', {
        status: 500,
        headers: SECURITY_HEADERS,
      });
    }

    return withSecurity(await bindings.ASSETS.fetch(request));
  },
};
