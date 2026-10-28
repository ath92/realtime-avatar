// Zero-dependency server: static assets + one SSE endpoint that turns a line of
// text into a stream of (audio, blendshape) segments.
//
//   node server/server.mjs            # http://127.0.0.1:8787
//
// Deliberately dependency-free so the scaffold runs on a clean machine. The
// only thing that needs replacing for production is the pipeline modules.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { speak, ttsAvailable } from './pipeline/tts.mjs';
import { analyze, toJSON } from './pipeline/a2e.mjs';
import { readWav } from './pipeline/wav.mjs';
import { streamReply } from './pipeline/llm.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

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
      'Cache-Control': ext === '.avtr' || ext === '.wav' ? 'public, max-age=3600' : 'no-cache',
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

// Cut the reply into speakable segments as tokens arrive, so the first audio
// does not wait for the whole answer.
function findCut(buf) {
  const m = /[.!?…]["')\]]?\s/.exec(buf);
  if (m && m.index > 24) return m.index + m[0].length;
  if (buf.length > 150) {
    const i = buf.lastIndexOf(' ', 150);
    if (i > 60) return i + 1;
  }
  return -1;
}

// ---- turn handler ---------------------------------------------------------
async function handleTurn(req, res) {
  const t0 = performance.now();
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) break;
  }
  let text = 'hello';
  try { text = (JSON.parse(body || '{}').text || '').trim() || 'hello'; } catch { /* ignore */ }

  sseInit(res);
  let closed = false;
  res.on('close', () => { closed = true; });

  const send = (ev, data) => {
    if (closed) return;
    try { sseSend(res, ev, data); } catch { closed = true; }
  };

  sseSend(res, 'start', { t: 0, tts: ttsAvailable() });

  let chain = Promise.resolve();
  let seq = 0;
  let firstAudioAt = null;

  const emitSegment = (segText) => {
    chain = chain.then(async () => {
      if (closed) return;
      const tTts = performance.now();
      const speech = await speak(segText);
      if (!speech) return;
      const ttsMs = performance.now() - tTts;

      const tA2e = performance.now();
      const { samples, sampleRate, duration } = readWav(speech.wav);
      const a2e = analyze(samples, sampleRate);
      const a2eMs = performance.now() - tA2e;

      const id = putMedia({ wav: speech.wav, frames: toJSON(a2e) });
      if (firstAudioAt === null) firstAudioAt = performance.now() - t0;
      send('segment', {
        seq: seq++,
        text: segText,
        audio: `/media/${id}.wav`,
        frames: `/media/${id}.json`,
        duration,
        fps: a2e.fps,
        t: Math.round(performance.now() - t0),
        ttsMs: Math.round(ttsMs),
        a2eMs: Math.round(a2eMs),
        first: firstAudioAt !== null && seq === 1,
      });
    }).catch((err) => {
      send('error', { message: String(err && err.message || err) });
    });
  };

  try {
    let buf = '';
    for await (const tok of streamReply(text)) {
      if (closed) break;
      buf += tok;
      send('token', { text: tok, t: Math.round(performance.now() - t0) });
      let cut;
      while ((cut = findCut(buf)) > 0) {
        const seg = buf.slice(0, cut).trim();
        buf = buf.slice(cut);
        if (seg) emitSegment(seg);
      }
    }
    if (buf.trim()) emitSegment(buf.trim());
    await chain;
    send('done', { t: Math.round(performance.now() - t0), firstAudioAt: firstAudioAt && Math.round(firstAudioAt) });
  } catch (err) {
    send('error', { message: String(err && err.message || err) });
  }
  res.end();
}

// ---- server ---------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/turn') return handleTurn(req, res);

  if (url.pathname === '/api/health') {
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      ok: true,
      tts: ttsAvailable() ? 'say' : 'babble',
      llm: process.env.LLM_PROVIDER || 'stub',
      assets: ['/assets/head.avtr'],
    }));
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
    console.log(`avatar  http://${HOST}:${port}/client/`);
    console.log(`  tts  ${ttsAvailable() ? 'macOS say' : 'synthetic babble (install a real TTS)'}`);
    console.log(`  llm  ${process.env.LLM_PROVIDER || 'stub'}${process.env.OPENAI_API_KEY ? ' (key present)' : ''}`);
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
