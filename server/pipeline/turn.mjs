// Turn orchestration shared by the Node server and the Cloudflare Worker.
//
// The transport is injected as `emit(event, data)`. The Node server writes SSE
// and stores media under /media/<id>; the Worker writes SSE and inlines the
// audio/frames because isolates have no shared memory. Both paths run the exact
// same cutting → TTS → audio→blendshape pipeline.

import { analyze, toJSON } from './a2e.mjs';
import { readWav } from './wav.mjs';
import { streamReply, sanitizeHistory, llmInfo } from './llm.mjs';
import { isAbortError } from './http.mjs';

// Cut the reply into speakable segments as tokens arrive, so the first audio
// does not wait for the whole answer. Scan past abbreviations ("e.g. ") and cut
// at the first boundary that leaves enough text to sound like a phrase; a short
// opening sentence is fine and gets audio started sooner.
export function findCut(buf) {
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

// `speak` and `ttsInfo` come from the platform-specific TTS entry (Node adds
// macOS `say`; the Worker has ElevenLabs + babble). The reply/info functions are
// injectable so the turn pipeline can be tested without a network.
export function createTurnRunner({
  speak,
  ttsInfo,
  replyFn = streamReply,
  llmInfoFn = llmInfo,
} = {}) {
  if (typeof speak !== 'function') throw new Error('createTurnRunner: speak is required');
  if (typeof ttsInfo !== 'function') throw new Error('createTurnRunner: ttsInfo is required');

  return async function runTurn({ text, history, signal, emit } = {}) {
    if (typeof emit !== 'function') throw new Error('runTurn: emit is required');

    const t0 = performance.now();
    const input = String(text || '').trim().slice(0, 8000) || 'hello';
    const messages = sanitizeHistory(history);

    let closed = Boolean(signal?.aborted);
    const send = (event, data) => {
      if (closed || signal?.aborted) return;
      try {
        emit(event, data);
      } catch {
        closed = true;
      }
    };

    send('start', { t: 0, tts: ttsInfo(), llm: llmInfoFn() });

    let chain = Promise.resolve();
    let seq = 0;
    let firstAudioAt = null;
    let previousText = '';

    const emitSegment = (segmentText) => {
      chain = chain.then(async () => {
        if (closed || signal?.aborted) return;
        try {
          const tTts = performance.now();
          const speech = await speak(segmentText, { signal, previousText });
          if (!speech || closed || signal?.aborted) return;
          const ttsMs = performance.now() - tTts;

          const tA2e = performance.now();
          const { samples, sampleRate, duration } = readWav(speech.wav);
          const a2e = analyze(samples, sampleRate);
          const frames = toJSON(a2e);
          const a2eMs = performance.now() - tA2e;

          const seqNo = seq++;
          if (firstAudioAt === null) firstAudioAt = performance.now() - t0;
          previousText = segmentText;

          send('segment', {
            seq: seqNo,
            text: segmentText,
            duration,
            fps: frames.fps,
            t: Math.round(performance.now() - t0),
            ttsMs: Math.round(ttsMs),
            a2eMs: Math.round(a2eMs),
            provider: speech.provider,
            voice: speech.voiceId || speech.voice || '',
            cached: Boolean(speech.cached),
            first: seqNo === 0,
            // Transport payloads: the caller either stores these behind URLs or
            // serialises them into the event. They are not sent to the browser
            // as-is.
            wav: speech.wav,
            frames,
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
      for await (const token of replyFn(input, { history: messages, signal })) {
        if (closed || signal?.aborted) break;
        buf += token;
        send('token', { text: token, t: Math.round(performance.now() - t0) });
        let cut;
        while ((cut = findCut(buf)) > 0) {
          const segmentText = buf.slice(0, cut).trim();
          buf = buf.slice(cut);
          if (segmentText) emitSegment(segmentText);
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
    }

    // Wait for any segment already queued before closing the stream.
    await chain.catch(() => {});
    if (!closed && !signal?.aborted) {
      send('done', {
        t: Math.round(performance.now() - t0),
        firstAudioAt: firstAudioAt === null ? null : Math.round(firstAudioAt),
      });
    }

    return { segments: seq, firstAudioAt, closed };
  };
}
