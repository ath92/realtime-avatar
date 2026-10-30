// Turn pipeline contract. No network: the reply and TTS are fakes, so this
// covers the event ordering and the raw media handoff that the Node server and
// the Worker each serialise differently.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnRunner, findCut } from '../server/pipeline/turn.mjs';
import { writeWavFloat32 } from '../server/pipeline/wav.mjs';

function toneWav(seconds = 0.2, sampleRate = 22050) {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.2;
  return writeWavFloat32(samples, sampleRate);
}

test('findCut waits for a phrase and has a long-text fallback', () => {
  assert.equal(findCut('Hi.'), -1);
  assert.equal(findCut('Hello there. How'), 13);
  assert.equal(findCut('e.g. this is still one clause. Yes'), 31);
  const long = `${'word '.repeat(40)}end`;
  const cut = findCut(long);
  assert.ok(cut > 60 && cut <= 151);
});

test('runTurn emits start, token, segment, done and hands over raw media', async () => {
  const events = [];
  const run = createTurnRunner({
    speak: async (text) => ({
      wav: toneWav(0.2),
      sampleRate: 22050,
      duration: 0.2,
      provider: 'fake',
      voiceId: `voice:${text.length}`,
    }),
    ttsInfo: () => ({ provider: 'fake', available: true }),
    llmInfoFn: () => ({ provider: 'fake', model: 'none' }),
    replyFn: async function* reply() {
      yield 'Hello';
      yield ' there.';
      yield ' How are you?';
    },
  });

  const result = await run({
    text: 'hi',
    history: [{ role: 'user', content: 'earlier' }],
    signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }),
  });

  assert.equal(events[0].event, 'start');
  assert.equal(events[0].data.llm.provider, 'fake');
  assert.equal(events.at(-1).event, 'done');
  assert.ok(events.some((e) => e.event === 'token'));

  const segments = events.filter((e) => e.event === 'segment');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].data.text, 'Hello there.');
  assert.equal(segments[0].data.seq, 0);
  assert.equal(segments[0].data.first, true);
  assert.ok(segments[0].data.wav instanceof Uint8Array);
  assert.equal(segments[0].data.frames.fps, 60);
  assert.ok(segments[0].data.frames.frames.length > 0);
  assert.equal(result.segments, 2);
  assert.ok(result.firstAudioAt !== null);
});

test('runTurn aborts cleanly when the client goes away', async () => {
  const controller = new AbortController();
  const events = [];
  const run = createTurnRunner({
    speak: async () => {
      throw new Error('should not speak after abort');
    },
    ttsInfo: () => ({ provider: 'fake' }),
    llmInfoFn: () => ({ provider: 'fake' }),
    replyFn: async function* reply() {
      yield 'Hello there. ';
      controller.abort();
      yield 'You should never see this. ';
    },
  });

  await run({
    text: 'hi',
    signal: controller.signal,
    emit: (event, data) => events.push({ event, data }),
  });

  assert.deepEqual(events.map((e) => e.event), ['start', 'token']);
});
