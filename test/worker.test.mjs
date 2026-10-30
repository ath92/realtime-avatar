// Worker routing + SSE integration. Runs the real Worker module in Node with a
// fake ASSETS binding and the key-free stub LLM / synthetic TTS, so it catches
// platform mistakes (Buffer, node: imports, missing headers) without credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/index.mjs';
import { setEnvSource } from '../server/env.mjs';

function bindings(extra = {}) {
  return {
    LLM_PROVIDER: 'stub',
    TTS_PROVIDER: 'none',
    TTS_CACHE_SIZE: '0',
    RATE_LIMIT_PER_MINUTE: '0',
    ASSETS: {
      fetch: async () => new Response('<!doctype html><title>avatar</title>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    },
    ...extra,
  };
}

function context() {
  const pending = [];
  return { pending, waitUntil(promise) { pending.push(promise); } };
}

test('health reports the resolved key-free providers', async () => {
  const res = await worker.fetch(
    new Request('https://avatar.test/api/health'),
    bindings(),
    context(),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.llm.provider, 'stub');
  assert.equal(body.tts.provider, 'none');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('unknown API routes are JSON 404s, not the SPA', async () => {
  const res = await worker.fetch(
    new Request('https://avatar.test/api/nope'),
    bindings(),
    context(),
  );
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
});

test('a cross-origin browser POST is rejected', async () => {
  const res = await worker.fetch(
    new Request('https://avatar.test/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
      body: JSON.stringify({ text: 'hi' }),
    }),
    bindings(),
    context(),
  );
  assert.equal(res.status, 403);
});

test('static requests are forwarded to the ASSETS binding', async () => {
  const res = await worker.fetch(
    new Request('https://avatar.test/'),
    bindings(),
    context(),
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /avatar/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('POST /api/turn streams inline audio and frames, then done', async () => {
  const ctx = context();
  const res = await worker.fetch(
    new Request('https://avatar.test/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://avatar.test' },
      body: JSON.stringify({ text: 'hi', history: [] }),
    }),
    bindings(),
    ctx,
  );

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const wire = await res.text();
  await Promise.all(ctx.pending);

  assert.match(wire, /event: start/);
  assert.match(wire, /event: token/);
  assert.match(wire, /event: segment/);
  assert.match(wire, /"audioBase64":"/);
  assert.match(wire, /"framesData":\{/);
  assert.match(wire, /event: done/);

  setEnvSource(null);
});
