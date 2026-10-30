// Client-side decoding contract: the Worker sends base64 WAV bytes, and the
// browser audio path (or this Node stand-in) must reconstruct the exact bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { base64ToArrayBuffer } from '../client/audio.js';

test('client decodes the Worker base64 payload byte-for-byte', () => {
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255, 82, 73, 70, 70]);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  const decoded = new Uint8Array(base64ToArrayBuffer(btoa(binary)));
  assert.deepEqual(decoded, bytes);
});
