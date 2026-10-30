#!/usr/bin/env node
// Provider smoke test: exercise whatever LLM and TTS .env selects, without
// starting the browser. Prints timings and writes the generated WAV so you can
// listen to it.
//
//   node tools/smoke.mjs
//   node tools/smoke.mjs --llm "Tell me a joke." --out /tmp/reply.wav
//   node tools/smoke.mjs --json

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../server/load-env.mjs';
import { llmInfo, streamReply } from '../server/pipeline/llm.mjs';
import { speak, ttsInfo } from '../server/pipeline/tts.mjs';
import { transcribe, sttInfo } from '../server/pipeline/stt.mjs';
import { analyze } from '../server/pipeline/a2e.mjs';
import { readWav } from '../server/pipeline/wav.mjs';
import { deadline } from '../server/pipeline/http.mjs';

const envLoad = loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

if (has('--help') || has('-h')) {
  console.log(`usage: node tools/smoke.mjs [options]

  --llm <text>   prompt to send to the LLM
  --tts <text>   text to synthesise
  --out <path>   where to write the WAV (default: <tmp>/avatar-smoke.wav)
  --json         machine-readable output
  --no-llm       skip the LLM check
  --no-tts       skip the TTS check
  --no-stt       skip the speech-to-text check

The STT check feeds the TTS output back through the transcriber, so it only runs
when the TTS check produced audio.`);
  process.exit(0);
}

const llmText = flag('--llm', 'Say hello in one short, friendly sentence.');
const ttsText = flag('--tts', 'Hello from the avatar. This is a provider check.');
const outPath = flag('--out', join(tmpdir(), 'avatar-smoke.wav'));
const json = has('--json');

const report = {
  env: { loaded: envLoad.loaded, count: envLoad.count, path: envLoad.path },
  llm: llmInfo(),
  tts: ttsInfo(),
  stt: sttInfo(),
  llmResult: null,
  ttsResult: null,
  sttResult: null,
  errors: [],
};

const signal = deadline(null, 90_000);

if (!json) {
  console.log('avatar providers');
  console.log(`  llm  ${report.llm.provider} · ${report.llm.model}${report.llm.available ? '' : ' (no key)'}`);
  const voice = report.tts.voiceName || report.tts.voiceId || report.tts.voice || report.tts.model || '';
  console.log(`  tts  ${report.tts.provider}${voice ? ` · ${voice}` : ''}${report.tts.available ? '' : ' (unavailable)'}`);
  console.log(`  stt  ${report.stt.provider}${report.stt.model && report.stt.provider !== 'none' ? ` · ${report.stt.model}` : ''}${report.stt.available ? '' : ' (voice input off)'}`);
  console.log('');
}

async function checkLlm() {
  if (!report.llm.available) {
    throw new Error(`${report.llm.provider} has no usable key; check .env`);
  }
  const started = performance.now();
  let firstTokenMs = null;
  let text = '';
  for await (const token of streamReply(llmText, { signal })) {
    if (firstTokenMs === null) firstTokenMs = performance.now() - started;
    text += token;
  }
  const totalMs = performance.now() - started;
  if (!text.trim()) throw new Error('LLM returned no text');
  report.llmResult = {
    text: text.trim(),
    firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
    totalMs: Math.round(totalMs),
    standIn: report.llm.provider === 'stub',
  };
  if (!json) {
    console.log(`llm  ${report.llmResult.firstTokenMs} ms to first token, ${report.llmResult.totalMs} ms total`);
    console.log(`     "${report.llmResult.text.replace(/\s+/g, ' ').slice(0, 240)}"`);
  }
}

async function checkTts() {
  if (!report.tts.available) {
    throw new Error(`${report.tts.provider} is not usable; check .env`);
  }
  const started = performance.now();
  const speech = await speak(ttsText, { signal });
  if (!speech) throw new Error('TTS returned no audio');
  const ttsMs = performance.now() - started;
  ttsWav = speech.wav;

  const a2eStarted = performance.now();
  const { samples, sampleRate, duration } = readWav(speech.wav);
  const frames = analyze(samples, sampleRate);
  const a2eMs = performance.now() - a2eStarted;

  writeFileSync(outPath, speech.wav);
  report.ttsResult = {
    provider: speech.provider,
    model: speech.model || null,
    voice: speech.voiceId || speech.voice || null,
    cached: Boolean(speech.cached),
    sampleRate,
    duration: Number(duration.toFixed(3)),
    ttsMs: Math.round(ttsMs),
    a2eMs: Math.round(a2eMs),
    frames: frames.frames.length,
    out: outPath,
    standIn: speech.provider === 'none',
  };
  if (!json) {
    console.log(`tts  ${Math.round(ttsMs)} ms -> ${duration.toFixed(2)}s audio, ${frames.frames.length} frames (${Math.round(a2eMs)} ms analysis)`);
    console.log(`     ${outPath}`);
  }
}

// The STT check reuses the TTS audio: speak a known line, transcribe it, count
// how many words survived the round trip. It only runs when there is audio.
let ttsWav = null;

async function checkStt() {
  if (!report.stt.available) {
    throw new Error(`${report.stt.provider} is not usable; ${report.stt.hint || 'check .env'}`);
  }
  if (!ttsWav) throw new Error('no audio to transcribe; run the TTS check too');

  const started = performance.now();
  const result = await transcribe(ttsWav, { mime: 'audio/wav', signal });
  const ms = performance.now() - started;
  if (!result.text) throw new Error('speech-to-text returned nothing');

  // A cheap sanity check, not a WER benchmark: how many spoken words came back.
  const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const heard = new Set(words(result.text));
  const expected = words(ttsText);
  const found = expected.filter((w) => heard.has(w)).length;

  report.sttResult = {
    text: result.text,
    provider: result.provider,
    model: result.model,
    language: result.language || null,
    ms: Math.round(ms),
    words: `${found}/${expected.length}`,
    verified: expected.length > 0 && found / expected.length >= 0.6,
  };
  if (!json) {
    console.log(`stt  ${Math.round(ms)} ms, ${found}/${expected.length} words matched`);
    console.log(`     "${result.text.slice(0, 240)}"`);
  }
}

try {
  if (!has('--no-llm')) await checkLlm();
} catch (err) {
  report.errors.push(`llm: ${err.message}`);
  if (!json) console.error(`llm  FAILED: ${err.message}`);
}

try {
  if (!has('--no-tts')) await checkTts();
} catch (err) {
  report.errors.push(`tts: ${err.message}`);
  if (!json) console.error(`tts  FAILED: ${err.message}`);
}

try {
  if (!has('--no-stt')) await checkStt();
} catch (err) {
  report.errors.push(`stt: ${err.message}`);
  if (!json) console.error(`stt  FAILED: ${err.message}`);
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.errors.length) {
  console.error(`\n${report.errors.length} check(s) failed`);
} else {
  const standIns = [
    report.llmResult?.standIn ? 'stub LLM' : '',
    report.ttsResult?.standIn ? 'babble TTS' : '',
  ].filter(Boolean);
  console.log(`\nok${standIns.length ? ` (stand-ins: ${standIns.join(', ')})` : ''}`);
}

process.exitCode = report.errors.length ? 1 : 0;
