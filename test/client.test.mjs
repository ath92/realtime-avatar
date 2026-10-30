// Client-side contracts: the Worker sends base64 WAV bytes that the browser must
// reconstruct exactly, and the microphone path must produce audio the server (and
// therefore both speech-to-text providers) can read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { base64ToArrayBuffer } from '../client/audio.js';
import { encodeWav16, trimToSpeech, resampleLinear } from '../client/mic.js';
import { readWav } from '../server/pipeline/wav.mjs';

test('client decodes the Worker base64 payload byte-for-byte', () => {
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255, 82, 73, 70, 70]);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  const decoded = new Uint8Array(base64ToArrayBuffer(btoa(binary)));
  assert.deepEqual(decoded, bytes);
});

test('client encodes 16-bit WAV that the server reads back sample for sample', () => {
  const rate = 16000;
  const input = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25]);
  const wav = encodeWav16(input, rate);

  assert.equal(wav.length, 44 + input.length * 2);
  const parsed = readWav(wav);
  assert.equal(parsed.sampleRate, rate);
  assert.equal(parsed.samples.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(parsed.samples[i] - input[i]) < 1e-4, `sample ${i}`);
  }
});

test('client trims the silence but keeps a little air around the speech', () => {
  const rate = 16000;
  const samples = new Float32Array(rate * 3);
  for (let i = rate; i < rate * 2; i++) samples[i] = 0.2; // one second of "speech"

  const trimmed = trimToSpeech(samples, rate, { padBefore: 0.1, padAfter: 0.1 });
  assert.ok(trimmed.speechMs >= 990 && trimmed.speechMs <= 1010);
  assert.ok(trimmed.samples.length > rate * 0.9);
  assert.ok(trimmed.samples.length < rate * 1.3);
});

test('client reports an empty utterance when nothing crosses the threshold', () => {
  const trimmed = trimToSpeech(new Float32Array(8000), 16000);
  assert.equal(trimmed.speechMs, 0);
  assert.equal(trimmed.samples.length, 0);
});

test('client resamples when a decoder ignores the target rate', () => {
  const out = resampleLinear(new Float32Array(48000).fill(0.5), 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[0] - 0.5) < 1e-6);
});
