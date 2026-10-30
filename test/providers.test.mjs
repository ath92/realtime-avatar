// Provider contract tests. No network and no API keys: a local mock speaks the
// ElevenLabs, OpenAI, and Anthropic wire formats, including SSE frames split
// across chunk boundaries and a 429 that must be retried.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv, parseEnv } from '../server/load-env.mjs';
import { speak, listVoices } from '../server/pipeline/tts.mjs';
import { transcribe, sttProvider, sttInfo } from '../server/pipeline/stt.mjs';
import { streamReply, sanitizeHistory, llmProvider } from '../server/pipeline/llm.mjs';
import { readWav } from '../server/pipeline/wav.mjs';
import { encodeWav16 } from '../client/mic.js';

const ENV_KEYS = [
  'LLM_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'LLM_MODEL',
  'LLM_SYSTEM', 'LLM_TEMPERATURE', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_VERSION',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  'TTS_PROVIDER', 'ELEVENLABS_API_KEY', 'ELEVENLABS_BASE_URL', 'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_MODEL_ID', 'ELEVENLABS_OUTPUT_FORMAT', 'ELEVENLABS_STABILITY',
  'ELEVENLABS_SIMILARITY', 'ELEVENLABS_STYLE', 'ELEVENLABS_SPEED',
  'ELEVENLABS_SPEAKER_BOOST', 'ELEVENLABS_LANGUAGE_CODE', 'ELEVENLABS_RETRIES',
  'ELEVENLABS_TIMEOUT_MS', 'ELEVENLABS_REQUEST_STITCHING', 'ELEVENLABS_ENABLE_LOGGING',
  'TTS_CACHE_SIZE', 'TTS_VOICE', 'TTS_RATE',
  'STT_PROVIDER', 'STT_LANGUAGE', 'STT_TIMEOUT_MS', 'STT_RETRIES', 'STT_MAX_AUDIO_MB',
  'ELEVENLABS_STT_MODEL', 'ELEVENLABS_STT_PCM', 'OPENAI_STT_MODEL', 'OPENAI_STT_BASE_URL',
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
    const raw = Buffer.concat(chunks);
    const body = raw.toString('utf8');
    requests.push({ url: req.url, method: req.method, headers: req.headers, body, raw });
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

    if (path === '/v1/speech-to-text') {
      if (req.headers['xi-api-key'] === 'bad-permission') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          detail: {
            type: 'authentication_error',
            message: 'The API key you used is missing the permission speech_to_text to execute this operation.',
            status: 'missing_permissions',
          },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        language_code: 'eng',
        language_probability: 0.98,
        text: '  Hello   there. ',
      }));
      return;
    }

    if (path === '/v1/audio/transcriptions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: ' hello from whisper ' }));
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

test('default system prompt carries the persona and its boundaries', async () => {
  setEnv({
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: `${base}/v1`,
  });

  await collect(streamReply('Hi'));
  const body = JSON.parse(requests.at(-1).body);
  const system = body.messages[0].content;

  assert.equal(body.messages[0].role, 'system');
  assert.match(system, /realtime avatar/);
  assert.match(system, /helpful/i);
  assert.match(system, /software engineering and web development/);
  assert.match(system, /Dutch/);
  assert.match(system, /Netherlands/);
  assert.match(system, /drums/);
  // Speech-friendly delivery and the sensitive-topic refusal stay in place.
  assert.match(system, /one to three short sentences/);
  assert.match(system, /sensitive topics/);
  assert.match(system, /politely/);
  // A configured override still wins over the built-in persona.
  assert.equal(process.env.LLM_SYSTEM, undefined);
});

test('LLM_SYSTEM overrides the built-in persona', async () => {
  setEnv({
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: `${base}/v1`,
    LLM_SYSTEM: 'You are a terse pirate.',
  });

  await collect(streamReply('Hi'));
  const body = JSON.parse(requests.at(-1).body);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are a terse pirate.' });
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

test('DeepSeek: one key selects the right endpoint and model', async () => {
  setEnv({
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `${base}/v1`,
  });

  assert.equal(llmProvider(), 'deepseek');
  const text = await collect(streamReply('Hi'));
  assert.equal(text, 'Hello there.');

  const req = requests.find((r) => r.url === '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.messages.at(-1).content, 'Hi');
});

test('DeepSeek: explicit provider wins over an OpenAI key', async () => {
  setEnv({
    LLM_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'deepseek-key',
    DEEPSEEK_BASE_URL: `${base}/v1`,
    OPENAI_API_KEY: 'openai-key',
  });

  assert.equal(llmProvider(), 'deepseek');
  await collect(streamReply('Hi'));
  const req = requests.find((r) => r.url === '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer deepseek-key');
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

  delete process.env.OPENAI_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'x';
  assert.equal(llmProvider(), 'deepseek');

  process.env.LLM_PROVIDER = 'anthropic';
  assert.equal(llmProvider(), 'anthropic');

  process.env.LLM_PROVIDER = 'openai-compatible';
  assert.equal(llmProvider(), 'openai');

  process.env.LLM_PROVIDER = 'deepseek';
  assert.equal(llmProvider(), 'deepseek');
});

// ------------------------------------------------------------------ stt ----

function sttWav(seconds = 0.5, sampleRate = 16000) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
  return encodeWav16(samples, sampleRate);
}

test('ElevenLabs: posts Scribe form data and returns the transcript', async () => {
  setEnv({
    STT_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'test-key',
    ELEVENLABS_BASE_URL: base,
  });

  const result = await transcribe(sttWav(0.5, 16000), { mime: 'audio/wav' });

  assert.equal(result.provider, 'elevenlabs');
  assert.equal(result.model, 'scribe_v2');
  assert.equal(result.text, 'Hello there.');
  assert.equal(result.language, 'eng');

  const req = requests.find((r) => r.url.startsWith('/v1/speech-to-text'));
  assert.equal(req.headers['xi-api-key'], 'test-key');
  assert.match(req.url, /enable_logging=true/);
  assert.match(req.body, /name="model_id"\r\n\r\nscribe_v2/);
  assert.match(req.body, /name="tag_audio_events"\r\n\r\nfalse/);
  // 16 kHz mono 16-bit WAV is sent as headerless PCM, which Scribe prefers.
  assert.match(req.body, /name="file_format"\r\n\r\npcm_s16le_16/);
  assert.equal(req.raw.includes(Buffer.from('RIFF')), false);
});

test('ElevenLabs: other sample rates keep the WAV container', async () => {
  setEnv({
    STT_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'test-key',
    ELEVENLABS_BASE_URL: base,
  });

  await transcribe(sttWav(0.5, 22050), { mime: 'audio/wav' });

  const req = requests.find((r) => r.url.startsWith('/v1/speech-to-text'));
  assert.match(req.body, /filename="speech.wav"/);
  assert.equal(/name="file_format"/.test(req.body), false);
  assert.equal(req.raw.includes(Buffer.from('RIFF')), true);
});

test('ElevenLabs: sends the configured model and language', async () => {
  setEnv({
    STT_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'test-key',
    ELEVENLABS_BASE_URL: base,
    ELEVENLABS_STT_MODEL: 'scribe_v2_medical',
    STT_LANGUAGE: 'eng',
  });

  await transcribe(sttWav(), { mime: 'audio/wav' });

  const req = requests.find((r) => r.url.startsWith('/v1/speech-to-text'));
  assert.match(req.body, /name="model_id"\r\n\r\nscribe_v2_medical/);
  assert.match(req.body, /name="language_code"\r\n\r\neng/);
});

test('ElevenLabs: a key without speech_to_text says exactly that', async () => {
  setEnv({
    STT_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'bad-permission',
    ELEVENLABS_BASE_URL: base,
    STT_RETRIES: '0',
  });

  await assert.rejects(
    () => transcribe(sttWav(), { mime: 'audio/wav' }),
    (err) => {
      assert.match(err.message, /missing the permission speech_to_text/);
      assert.match(err.message, /ELEVENLABS_API_KEY/);
      assert.equal(err.code, 'STT_PERMISSION');
      return true;
    },
  );
});

test('OpenAI: posts a WAV to /audio/transcriptions', async () => {
  setEnv({
    STT_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: `${base}/v1`,
  });

  const result = await transcribe(sttWav(), { mime: 'audio/wav' });

  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'whisper-1');
  assert.equal(result.text, 'hello from whisper');

  const req = requests.find((r) => r.url === '/v1/audio/transcriptions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.match(req.body, /name="model"\r\n\r\nwhisper-1/);
  assert.match(req.body, /filename="speech.wav"/);
  assert.equal(req.raw.includes(Buffer.from('RIFF')), true);
});

test('no key: voice input reports itself unavailable and refuses to record', async () => {
  const info = sttInfo();
  assert.equal(info.provider, 'none');
  assert.equal(info.available, false);
  assert.match(info.hint, /ELEVENLABS_API_KEY/);

  await assert.rejects(() => transcribe(sttWav(), {}), /not configured/);
});

test('STT: empty audio is rejected before any request', async () => {
  setEnv({
    STT_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'test-key',
    ELEVENLABS_BASE_URL: base,
  });

  await assert.rejects(() => transcribe(new Uint8Array(0), {}), /empty audio/);
  assert.equal(requests.length, 0);
});

test('sttProvider follows explicit env, then available keys', () => {
  assert.equal(sttProvider(), 'none');
  process.env.ELEVENLABS_API_KEY = 'x';
  assert.equal(sttProvider(), 'elevenlabs');
  delete process.env.ELEVENLABS_API_KEY;
  process.env.OPENAI_API_KEY = 'x';
  assert.equal(sttProvider(), 'openai');
  process.env.STT_PROVIDER = 'none';
  assert.equal(sttProvider(), 'none');
});
