// Node TTS entry point: the runtime-neutral providers plus macOS `say`.
//
// Everything that does not need a local process lives in tts-core.mjs, which is
// also what the Cloudflare Worker imports.

export * from './tts-core.mjs';

import { registerSayHandler } from './tts-core.mjs';
import { speakSay } from './tts-say.mjs';

registerSayHandler(speakSay);

export { speakSay };
