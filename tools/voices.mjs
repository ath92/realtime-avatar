#!/usr/bin/env node
// List the ElevenLabs voices available to your key, so you can pick one for
// ELEVENLABS_VOICE_ID.
//
//   node tools/voices.mjs
//   node tools/voices.mjs --json

import { loadEnv } from '../server/load-env.mjs';
import { listVoices } from '../server/pipeline/tts.mjs';

loadEnv();

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node tools/voices.mjs [--json]');
  process.exit(0);
}

try {
  const voices = await listVoices();
  if (args.includes('--json')) {
    console.log(JSON.stringify(voices, null, 2));
  } else if (!voices.length) {
    console.log('No voices returned. Check the key and the account.');
  } else {
    console.log(`${voices.length} voices:\n`);
    console.log('  id'.padEnd(28), 'name'.padEnd(24), 'category');
    for (const voice of voices) {
      const labels = Object.entries(voice.labels || {}).map(([k, v]) => `${k}=${v}`).join(', ');
      console.log(
        `  ${voice.id.padEnd(26)}`,
        `${(voice.name || '').slice(0, 22).padEnd(22)}`,
        `${voice.category || ''}${labels ? `  (${labels})` : ''}`,
      );
    }
    console.log('\nSet one with: ELEVENLABS_VOICE_ID=<id>');
  }
} catch (err) {
  console.error(`voices: ${err.message}`);
  process.exitCode = 1;
}
