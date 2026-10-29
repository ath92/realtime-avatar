// Provider contract tests. No network and no API keys: a local mock speaks the
// ElevenLabs, OpenAI, and Anthropic wire formats, including SSE frames split
// across chunk boundaries and a 429 that must be retried.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv, parseEnv } from '../server/env.mjs';
import { speak, listVoices } from '../server/pipeline/tts.mjs';
import { streamReply, sanitizeHistory, llmProvider } from '../server/pipeline/llm.mjs';
import { readWav } from '../server/pipeline/wav.mjs';

const ENV_KEYS = [
  'LLM_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'LLM_MODEL',
  'LLM_SYSTEM', 'LLM_TEMPERATURE', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_VERSION',
  'TTS_PROVIDER', 'ELEVENLABS_API_KEY', 'ELEVENLABS_BASE_URL', 'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_MODEL_ID', 'ELEVENLABS_OUTPUT_FORMAT', 'ELEVENLABS_STABILITY',
  'ELEVENLABS_SIMILARITY', 'ELEVENLABS_STYLE', 'ELEVENLABS_SPEED',
  'ELEVENLABS_SPEAKER_BOOST', 'ELEVENLABS_LANGUAGE_CODE', 'ELEVENLABS_RETRIES',
  'ELEVENLABS_TIMEOUT_MS', 'ELEVENLABS_REQUEST_STITCHING', 'ELEVENLABS_ENABLE_LOGGING',
  'TTS_CACHE_SIZE', 'TTS_VOICE', 'TTS_RATE',
];
const ORIGINAL = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

let server;
let base;
const requests = [];

function pcm(samples = 800) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(6000 * Math.sin(i / 8)), i * 2);
  }
  return buf;
}

function streamSse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  let i = 0;
  const next = () => {
    if (i >= chunks.length) { res.end(); return; }
    const chunk = chunks[i++];
    const mid = Math.max(1, Math.floor(chunk.length / 2));
    res.write(chunk.slice(0, mid));
    setTimeout(() => {
      res.write(chunk.slice(mid));
      setTimeout(next, 1);
    }, 1);
  };
  next();
}

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    const path = new URL(req.url, 'http://mock').pathname;

    if (path.startsWith('/v1/text-to-speech/')) {
      const voice = decodeURIComponent(path.split('/')[3] || '');
      if (voice === 'bad-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: { status: 'unauthorized', message: 'invalid api key' } }));
        return;
      }
      if (voice.startsWith('retry')) {
        const seen = requests.filter((r) => r.url.includes(voice)).length;
        if (seen === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          res.end(JSON.stringify({ detail: { message: 'rate limited' } }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'audio/pcm' });
      res.end(pcm());
      return;
    }

    if (path === '/v1/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        voices: [
          { voice_id: 'voice-1', name: 'Rachel', category: 'premade', labels: { accent: 'american' } },
          { voice_id: 'voice-2', name: 'Adam', category: 'premade', labels: {} },
        ],
      }));
      return;
    }

    if (path === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}');
      if (parsed.model === 'fail-model') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'incorrect api key' } }));
        return;
      }
      streamSse(res, [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there."}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      return;
    }

    if (path === '/v1/messages') {
      const parsed = JSON.parse(body || '{}');
      if (parsed.model === 'fail-model') {
        streamSse(res, [
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        ]);
        return;
      }
      streamSse(res, [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" from Claude."}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  clearEnv();
  requests.length = 0;
});

after(async () => {
  for (const [key, value] of ORIGINAL) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

async function collect(stream) {
  let text = '';
  for await (const token of stream) text += token;
  return text;
}

// ------------------------------------------------------------------- env ----

test('parseEnv handles quotes, escapes, comments, and export', () => {
  const parsed = parseEnv([
    'A=1',
    '# comment',
    'B="two words" # trailing',
    "C='x y'",
    'export D=4 # hi',
    'E=value # comment',
    'F="line\\nnext"',
    'BAD LINE',
    'G=',
  ].join('\n'));

  assert.deepEqual(parsed, {
    A: '1',
    B: 'two words',
    C: 'x y',
    D: '4',
    E: 'value',
    F: 'line\nnext',
    G: '',
  });
});

test('loadEnv fills gaps but never overrides process env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avtr-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'TEST_AVATAR_KEEP=changed\nTEST_AVATAR_NEW="hello world" # c\n');
  process.env.TEST_AVATAR_KEEP = 'original';

  try {
    const result = loadEnv(file);
    assert.equal(result.loaded, true);
    assert.equal(result.count, 1);
    assert.equal(process.env.TEST_AVATAR_KEEP, 'original');
    assert.equal(process.env.TEST_AVATAR_NEW, 'hello world');
  } finally {
    delete process.env.TEST_AVATAR_KEEP;
    delete process.env.TEST_AVATAR_NEW;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- tts ----

function elevenEnv(extra = {}) {
  setEnv({
    TTS_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'test-key',
    ELEVENLABS_BASE_URL: base,
    ELEVENLABS_VOICE_ID: 'voice-1',
    ELEVENLABS_OUTPUT_FORMAT: 'pcm_22050',
    TTS_CACHE_SIZE: '0',
    ...extra,
  });
}

test('ElevenLabs: sends PCM request and returns a playable WAV', async () => {
  elevenEnv();
  const result = await speak('Hello there.', {});

  assert.equal(result.provider, 'elevenlabs');
  assert.equal(result.sampleRate, 22050);

  const wav = readWav(result.wav);
  assert.equal(wav.sampleRate, 22050);
  assert.ok(Math.abs(wav.duration - 800 / 22050) < 1e-6);

  const req = requests.find((r) => r.url.includes('/v1/text-to-speech/'));
  assert.ok(req.url.includes('/v1/text-to-speech/voice-1/stream'));
  assert.ok(req.url.includes('output_format=pcm_22050'));
  assert.equal(req.headers['xi-api-key'], 'test-key');

  const body = JSON.parse(req.body);
  assert.equal(body.text, 'Hello there.');
  assert.equal(body.model_id, 'eleven_turbo_v2_5');
  assert.equal(body.voice_settings.stability, 0.45);
});

test('ElevenLabs: caches identical text, but not different text', async () => {
  elevenEnv({ TTS_CACHE_SIZE: '8', ELEVENLABS_VOICE_ID: 'cache-voice' });

  await speak('cache me', {});
  await speak('cache me', {});
  let count = requests.filter((r) => r.url.includes('/v1/text-to-speech/cache-voice')).length;
  assert.equal(count, 1);

  await speak('cache me too', {});
  count = requests.filter((r) => r.url.includes('/v1/text-to-speech/cache-voice')).length;
  assert.equal(count, 2);
});

test('ElevenLabs: retries a 429 before giving up', async () => {
  elevenEnv({ ELEVENLABS_VOICE_ID: 'retry-voice', ELEVENLABS_RETRIES: '1' });

  const result = await speak('retry me', {});
  assert.equal(result.provider, 'elevenlabs');

  const count = requests.filter((r) => r.url.includes('/v1/text-to-speech/retry-voice')).length;
  assert.equal(count, 2);
});

test('ElevenLabs: 401 explains which env var to check', async () => {
  elevenEnv({ ELEVENLABS_VOICE_ID: 'bad-key' });

  await assert.rejects(
    () => speak('nope', {}),
    (err) => /elevenlabs 401/.test(err.message) && /ELEVENLABS_API_KEY/.test(err.message),
  );
});

test('ElevenLabs: refuses non-PCM output formats clearly', async () => {
  elevenEnv({ ELEVENLABS_OUTPUT_FORMAT: 'mp3_44100_128' });

  await assert.rejects(
    () => speak('nope', {}),
    /raw PCM/,
  );
});

test('ElevenLabs: voice listing maps the API response', async () => {
  setEnv({ ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_BASE_URL: base });
  const voices = await listVoices();

  assert.equal(voices.length, 2);
  assert.deepEqual(voices[0], {
    id: 'voice-1',
    name: 'Rachel',
    category: 'premade',
    labels: { accent: 'american' },
    description: '',
    preview: '',
  });
});

// ------------------------------------------------------------------ llm ----

test('OpenAI: streams deltas and sends system + history + user', async () => {
  setEnv({
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: `${base}/v1`,
  });

  const text = await collect(streamReply('Hi', {
    history: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ],
  }));

  assert.equal(text, 'Hello there.');

  const req = requests.find((r) => r.url === '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(req.body);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.messages.slice(1), [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Hi' },
  ]);
  assert.equal('temperature' in body, false);
  assert.equal('max_tokens' in body, false);
});

test('OpenAI: maps HTTP errors to a useful message', async () => {
  setEnv({
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'bad',
    OPENAI_BASE_URL: `${base}/v1`,
    LLM_MODEL: 'fail-model',
  });

  await assert.rejects(
    () => collect(streamReply('Hi')),
    (err) => /openai 401/.test(err.message) && /OPENAI_API_KEY/.test(err.message),
  );
});

test('Anthropic: streams deltas with system separate from messages', async () => {
  setEnv({
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: base,
  });

  const text = await collect(streamReply('Hi', {
    history: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Ok' }],
  }));

  assert.equal(text, 'Hi from Claude.');

  const req = requests.find((r) => r.url === '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'test-key');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');

  const body = JSON.parse(req.body);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 400);
  assert.ok(body.system.includes('realtime avatar'));
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'Earlier' },
    { role: 'assistant', content: 'Ok' },
    { role: 'user', content: 'Hi' },
  ]);
});

test('Anthropic: surfaces an in-stream error event', async () => {
  setEnv({
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_MODEL: 'fail-model',
  });

  await assert.rejects(
    () => collect(streamReply('Hi')),
    /anthropic stream: Overloaded/,
  );
});

test('sanitizeHistory merges same-role turns and drops leading assistant', () => {
  const out = sanitizeHistory([
    { role: 'assistant', content: 'drop me' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'system', content: 'not a chat role' },
    { role: 'user', content: '   ' },
  ]);

  assert.deepEqual(out, [
    { role: 'user', content: 'a\nb' },
    { role: 'assistant', content: 'c' },
  ]);
});

test('sanitizeHistory caps the window at a user turn', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
  }));

  const out = sanitizeHistory(history, { maxMessages: 4 });
  assert.equal(out.length, 4);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'm26');
  assert.equal(out[3].content, 'm29');
});

test('sanitizeHistory drops a leading assistant after capping', () => {
  const history = Array.from({ length: 17 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
  }));

  const out = sanitizeHistory(history, { maxMessages: 4 });
  assert.equal(out[0].role, 'user');
  assert.equal(out.length, 3);
  assert.equal(out[0].content, 'm14');
  assert.equal(out[2].content, 'm16');
});

test('provider detection follows explicit env, then available keys', () => {
  clearEnv();
  assert.equal(llmProvider(), 'stub');

  process.env.OPENAI_API_KEY = 'x';
  assert.equal(llmProvider(), 'openai');

  process.env.LLM_PROVIDER = 'anthropic';
  assert.equal(llmProvider(), 'anthropic');

  process.env.LLM_PROVIDER = 'openai-compatible';
  assert.equal(llmProvider(), 'openai');
});
