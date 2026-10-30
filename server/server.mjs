// Zero-dependency server: static assets + one SSE endpoint that turns a line of
// text into a stream of (audio, blendshape) segments.
//
//   node server/server.mjs            # http://127.0.0.1:8787
//
// Provider selection lives in server/pipeline/{llm,tts}.mjs and is driven by
// .env (see .env.example). With no keys it still runs on the stub LLM and
// macOS `say`, which is what keeps the quickstart dependency-free.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, extname, resolve, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';
import { speak, ttsInfo } from './pipeline/tts.mjs';
import { transcribe, sttInfo, sttMaxAudioBytes } from './pipeline/stt.mjs';
import { llmInfo } from './pipeline/llm.mjs';
import { createTurnRunner } from './pipeline/turn.mjs';

const envLoad = loadEnv();

// Same orchestration the Worker runs; this entry point stores media in-process
// and serves it from /media/<id>.
const runTurn = createTurnRunner({ speak, ttsInfo });

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.avtr': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const ASSETS = (() => {
  try {
    return readdirSync(join(ROOT, 'assets'))
      .filter((name) => name.endsWith('.avtr'))
      .sort()
      .map((name) => `/assets/${name}`);
  } catch {
    return [];
  }
})();

// ---- in-memory media store (audio + frames per segment) -------------------
const media = new Map();
let mediaSeq = 0;
const MEDIA_LIMIT = 96;

function putMedia(entry) {
  const id = (mediaSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
  media.set(id, entry);
  while (media.size > MEDIA_LIMIT) media.delete(media.keys().next().value);
  return id;
}

// ---- static ---------------------------------------------------------------
const gzipCache = new Map();

async function serveStatic(req, res, urlPath) {
  // Serve the app from /client/ so that relative URLs in the HTML and relative
  // module imports both resolve the way the browser expects.
  if (urlPath === '/') {
    res.writeHead(302, { Location: '/client/' }).end();
    return;
  }
  const rel = urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath;
  const path = normalize(join(ROOT, rel));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const info = await stat(path);
    if (!info.isFile()) { res.writeHead(404).end('not found'); return; }
    const ext = extname(path);
    const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }

    let body = await readFile(path);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Avatars are rebuilt constantly during iteration; a stale .avtr in the
      // browser cache looks exactly like a rendering bug.
      'Cache-Control': ext === '.wav' ? 'public, max-age=3600' : 'no-cache',
      ETag: etag,
    };

    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024
      && /^(text|application\/(javascript|json)|image\/svg)/.test(headers['Content-Type']);
    if (wantsGzip) {
      const key = `${path}:${info.mtimeMs}`;
      let gz = gzipCache.get(key);
      if (!gz) { gz = gzipSync(body); gzipCache.set(key, gz); }
      body = gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

// ---- SSE helpers ----------------------------------------------------------
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function sendJson(res, status, body, extra = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(json),
    ...extra,
  }).end(json);
}

// Voice input is one audio blob per utterance, so it gets its own (much larger)
// limit instead of reusing the 64 kB JSON one.
async function readAudioBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error(`audio too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---- speech to text -------------------------------------------------------
// The browser records one utterance and POSTs it as raw bytes with its own
// Content-Type. The reply is JSON, not SSE: transcription happens before the
// turn starts, and the client shows the text it is about to send.
async function handleTranscribe(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  if (mime && !mime.startsWith('audio/') && mime !== 'application/octet-stream') {
    sendJson(res, 415, { error: `unsupported content type "${mime}" (send audio/*)` });
    return;
  }

  // Stop paying for a transcription nobody will read if the tab goes away.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const audio = await readAudioBody(req, sttMaxAudioBytes());
    if (!audio.length) {
      sendJson(res, 400, { error: 'empty audio', code: 'STT_EMPTY' });
      return;
    }
    const result = await transcribe(audio, {
      mime: mime || 'audio/wav',
      language: url.searchParams.get('language') || '',
      signal: controller.signal,
    });
    sendJson(res, 200, result);
  } catch (err) {
    if (res.writableEnded) return;
    const status = [400, 413, 429, 503].includes(err.status) ? err.status : 502;
    sendJson(res, status, {
      error: String(err && err.message || err),
      code: err.code || 'STT_FAILED',
      hint: status === 503 ? sttInfo().hint : undefined,
    });
  }
}

// ---- turn handler ---------------------------------------------------------
async function handleTurn(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    res.writeHead(err.status || 400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: err.message }));
    return;
  }

  sseInit(res);
  let closed = false;
  const controller = new AbortController();
  res.on('close', () => {
    closed = true;
    controller.abort();
  });

  const ping = setInterval(() => {
    if (!closed) { try { res.write(': ping\n\n'); } catch { /* closed */ } }
  }, 15_000);

  // The runner hands us raw wav/frames; this entry point is the one that turns
  // them into short-lived URLs. The Worker inlines them instead.
  const emit = (event, data) => {
    if (closed) return;
    if (event === 'segment') {
      const { wav, frames, ...rest } = data;
      const id = putMedia({ wav, frames });
      sseSend(res, event, { ...rest, audio: `/media/${id}.wav`, frames: `/media/${id}.json` });
      return;
    }
    sseSend(res, event, data);
  };

  try {
    await runTurn({
      text: payload.text,
      history: payload.history,
      signal: controller.signal,
      emit,
    });
  } catch (err) {
    if (!closed) {
      try {
        sseSend(res, 'error', {
          stage: 'server',
          message: String(err && err.message || err),
        });
      } catch { /* client is gone */ }
    }
  } finally {
    clearInterval(ping);
  }

  if (!closed) res.end();
}

// ---- server ---------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/turn') return handleTurn(req, res);
  if (req.method === 'POST' && url.pathname === '/api/transcribe') return handleTranscribe(req, res);

  if (url.pathname === '/api/health') {
    const body = JSON.stringify({
      ok: true,
      tts: ttsInfo(),
      stt: sttInfo(),
      llm: llmInfo(),
      assets: ASSETS,
    });
    return res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }).end(body);
  }

  const m = /^\/media\/([a-z0-9]+)\.(wav|json)$/.exec(url.pathname);
  if (m) {
    const entry = media.get(m[1]);
    if (!entry) { res.writeHead(404).end('expired'); return; }
    if (m[2] === 'wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': entry.wav.length }).end(entry.wav);
    } else {
      const json = JSON.stringify(entry.frames);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }).end(json);
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
  res.writeHead(405).end('method not allowed');
});

function listen(port, attempts = 0) {
  server.listen(port, HOST, () => {
    const tts = ttsInfo();
    const stt = sttInfo();
    const llm = llmInfo();
    console.log(`avatar  http://${HOST}:${port}/client/`);
    console.log(`  llm  ${llm.provider} · ${llm.model}${llm.available ? '' : ' (no key)'}`);
    console.log(`  tts  ${tts.provider}${tts.model ? ` · ${tts.model}` : ''}${tts.available ? '' : ' (unavailable)'}`);
    console.log(`  stt  ${stt.provider}${stt.model && stt.provider !== 'none' ? ` · ${stt.model}` : ''}${stt.available ? '' : ' (voice input off)'}`);
    if (envLoad.loaded) console.log(`  env  ${envLoad.path} (${envLoad.count} vars loaded)`);
  });
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < 10) {
      console.log(`port ${port} busy, trying ${port + 1}`);
      listen(port + 1, attempts + 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
}

listen(PORT);
