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
import { loadEnv } from './env.mjs';
import { speak, ttsInfo } from './pipeline/tts.mjs';
import { analyze, toJSON } from './pipeline/a2e.mjs';
import { readWav } from './pipeline/wav.mjs';
import { streamReply, sanitizeHistory, llmInfo } from './pipeline/llm.mjs';
import { isAbortError } from './pipeline/http.mjs';

const envLoad = loadEnv();

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

// Cut the reply into speakable segments as tokens arrive, so the first audio
// does not wait for the whole answer. Scan past abbreviations ("e.g. ") and cut
// at the first boundary that leaves enough text to sound like a phrase; a short
// opening sentence is fine and gets audio started sooner.
function findCut(buf) {
  const boundaries = /[.!?…]["')\]]?\s/g;
  let m;
  while ((m = boundaries.exec(buf))) {
    if (m.index >= 8) return m.index + m[0].length;
  }
  if (buf.length > 150) {
    const i = buf.lastIndexOf(' ', 150);
    if (i > 60) return i + 1;
  }
  return -1;
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

// ---- turn handler ---------------------------------------------------------
async function handleTurn(req, res) {
  const t0 = performance.now();

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    res.writeHead(err.status || 400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: err.message }));
    return;
  }

  const text = String(payload.text || '').trim().slice(0, 8000) || 'hello';
  const history = sanitizeHistory(payload.history);

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

  const send = (ev, data) => {
    if (closed) return;
    try { sseSend(res, ev, data); } catch { closed = true; }
  };

  sseSend(res, 'start', { t: 0, tts: ttsInfo(), llm: llmInfo() });

  let chain = Promise.resolve();
  let seq = 0;
  let firstAudioAt = null;
  let previousText = '';

  const emitSegment = (segText) => {
    chain = chain.then(async () => {
      if (closed) return;
      try {
        const tTts = performance.now();
        const speech = await speak(segText, {
          signal: controller.signal,
          previousText,
        });
        if (!speech || closed) return;
        const ttsMs = performance.now() - tTts;

        const tA2e = performance.now();
        const { samples, sampleRate, duration } = readWav(speech.wav);
        const a2e = analyze(samples, sampleRate);
        const a2eMs = performance.now() - tA2e;

        const id = putMedia({ wav: speech.wav, frames: toJSON(a2e) });
        const seqNo = seq++;
        if (firstAudioAt === null) firstAudioAt = performance.now() - t0;
        previousText = segText;

        send('segment', {
          seq: seqNo,
          text: segText,
          audio: `/media/${id}.wav`,
          frames: `/media/${id}.json`,
          duration,
          fps: a2e.fps,
          t: Math.round(performance.now() - t0),
          ttsMs: Math.round(ttsMs),
          a2eMs: Math.round(a2eMs),
          provider: speech.provider,
          voice: speech.voiceId || speech.voice || '',
          cached: Boolean(speech.cached),
          first: seqNo === 0,
        });
      } catch (err) {
        if (closed || isAbortError(err)) return;
        send('error', {
          stage: 'tts',
          message: String(err && err.message || err),
        });
      }
    });
  };

  try {
    let buf = '';
    for await (const tok of streamReply(text, { history, signal: controller.signal })) {
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
  } catch (err) {
    if (!closed && !isAbortError(err)) {
      send('error', {
        stage: 'llm',
        message: String(err && err.message || err),
      });
    }
  } finally {
    clearInterval(ping);
  }

  // Wait for any segment already queued before closing the stream.
  await chain.catch(() => {});
  if (!closed) {
    send('done', {
      t: Math.round(performance.now() - t0),
      firstAudioAt: firstAudioAt === null ? null : Math.round(firstAudioAt),
    });
  }
  res.end();
}

// ---- server ---------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/turn') return handleTurn(req, res);

  if (url.pathname === '/api/health') {
    const body = JSON.stringify({
      ok: true,
      tts: ttsInfo(),
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
    const llm = llmInfo();
    console.log(`avatar  http://${HOST}:${port}/client/`);
    console.log(`  llm  ${llm.provider} · ${llm.model}${llm.available ? '' : ' (no key)'}`);
    console.log(`  tts  ${tts.provider}${tts.model ? ` · ${tts.model}` : ''}${tts.available ? '' : ' (unavailable)'}`);
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
