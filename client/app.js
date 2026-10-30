// App shell: load the rig, stream a reply, drive the face, draw it.

import { loadAvatar } from '../shared/format.mjs';
import { SplatRenderer, mat4 } from './splat.js';
import { Rig } from './rig.js';
import { Idle } from './idle.js';
import { Speaker } from './audio.js';

const $ = (sel) => document.querySelector(sel);

const canvas = $('#view');
const logEl = $('#transcript');
const inputEl = $('#input');
const sendEl = $('#send');
const resetEl = $('#reset');

const params = new URLSearchParams(location.search);
const STATIC = params.has('static');        // ?static=1 freezes the rig at rest
const ASSET = params.get('asset') || '/assets/me.avtr';     // ?asset=/path/to/other.avtr

const state = {
  avatar: null,
  rig: null,
  renderer: null,
  idle: new Idle(),
  speaker: new Speaker(),
  camera: { yaw: 0.0, pitch: 0.02, dist: 0.70, targetY: -0.035, fov: (32 * Math.PI) / 180 },
  last: performance.now(),
  drawMs: 0,
  visible: 0,
  pendingSegments: 0,
  turnAbort: null,
  turnGen: 0,
  history: [],
};

// ---------------------------------------------------------------- bootstrap

async function main() {
  const avatar = await loadAvatar(ASSET);
  state.avatar = avatar;

  state.renderer = new SplatRenderer(canvas);
  state.renderer.setAvatar(avatar);
  state.rig = new Rig(avatar);

  if (params.has('debug')) window.__avatar = state;
  requestAnimationFrame(loop);

  loadHealth();
  window.addEventListener('resize', () => state.renderer.resize());
}

// ---------------------------------------------------------------- providers

async function loadHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return;
    const health = await res.json();

    const llm = health.llm || {};
    const tts = health.tts || {};
    const voice = tts.voiceName || tts.voiceId || tts.voice || tts.model || '';
    const llmLabel = `${llm.provider || '?'}${llm.model ? ` · ${llm.model}` : ''}`;
    const ttsLabel = `${tts.provider || '?'}${voice ? ` · ${voice}` : ''}`;

    if (llm.provider === 'stub') {
      appendSystem(`No LLM key configured, so replies are canned. Set DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY in .env locally, or as a Worker secret when deployed. Voice: ${ttsLabel}.`);
    } else if (tts.provider === 'none' || tts.available === false) {
      appendSystem(`Voice: ${ttsLabel}${tts.available === false ? ' (not configured)' : ' (synthetic)'}. Set ELEVENLABS_API_KEY in .env locally or as a Worker secret for real speech. LLM: ${llmLabel}.`);
    }

    if (llm.available === false) {
      appendSystem(`warning: ${llm.provider} has no key — check .env or the Worker secrets before talking to it.`);
    }
  } catch {
    // Health is best-effort; the avatar still renders without it.
  }
}

// ---------------------------------------------------------------- rendering

const model = mat4.identity();

// The pointer only nudges the camera: enough parallax to feel alive, never
// enough to show the splats from the side.
const BASE_PITCH = 0.02;
const GAZE_YAW = 0.05;    // ~3° at the screen edges
const GAZE_PITCH = 0.03;
const gaze = { yaw: 0, pitch: BASE_PITCH };

function easeGaze(dt) {
  const k = 1 - Math.exp(-dt * 3);
  state.camera.yaw += (gaze.yaw - state.camera.yaw) * k;
  state.camera.pitch += (gaze.pitch - state.camera.pitch) * k;
}

function loop(now) {
  const dt = Math.min(0.05, (now - state.last) / 1000);
  state.last = now;

  if (!STATIC) easeGaze(dt);

  const speech = state.speaker.sample();
  state.idle.update(dt, speech.energy);
  const idleCh = state.idle.channels();

  const merged = STATIC ? {} : Object.assign({}, speech.values, idleCh);
  state.rig.set(merged);
  state.rig.update();

  const pose = STATIC ? { yaw: 0, pitch: 0, roll: 0, y: 0 } : state.idle.pose();
  mat4.headPose(model, pose.yaw, pose.pitch, pose.roll, 0, pose.y, 0);

  const r = state.renderer.draw(state.rig.positions, model, state.camera);
  state.drawMs = r.ms;
  state.visible = r.visible;

  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- transport

const HISTORY_MAX = 16;
let turnReply = '';
let turnError = false;
let currentLine = null;

async function postTurn(text, signal, gen) {
  state.pendingSegments = 0;

  const res = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, history: state.history.slice(-HISTORY_MAX) }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`server ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const handle = (ev, data) => {
    if (ev === 'token') {
      if (gen !== state.turnGen) return;
      turnReply += data.text;
      appendToken(data.text);
    } else if (ev === 'segment') {
      if (gen !== state.turnGen) return;
      state.pendingSegments++;
      loadSegment(data, gen, signal).finally(() => {
        state.pendingSegments = Math.max(0, state.pendingSegments - 1);
      });
    } else if (ev === 'error') {
      if (gen !== state.turnGen) return;
      turnError = true;
      appendSystem(`error (${data.stage || 'server'}): ${data.message}`);
    } else if (ev === 'done') {
      finishTurn(text, gen);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let ev = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { handle(ev, JSON.parse(data)); } catch { /* ignore malformed frame */ }
    }
  }
}

async function loadSegment(seg, gen, signal) {
  if (gen !== state.turnGen) return;
  try {
    await state.speaker.enqueue({
      audioUrl: seg.audio,
      framesUrl: seg.frames,
      audioBase64: seg.audioBase64,
      framesData: seg.framesData,
      signal,
      isCurrent: () => gen === state.turnGen,
    });
  } catch (err) {
    if (err.name !== 'AbortError' && gen === state.turnGen) {
      appendSystem(`audio failed: ${err.message}`);
    }
  }
}

function appendToken(text) {
  if (!currentLine) {
    currentLine = document.createElement('div');
    currentLine.className = 'line avatar';
    logEl.appendChild(currentLine);
    logEl.scrollTop = logEl.scrollHeight;
  }
  currentLine.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function finishTurn(text, gen) {
  if (gen !== state.turnGen) return;

  // Only commit complete, error-free turns to the model's conversation history.
  if (!turnError && turnReply.trim()) {
    state.history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: turnReply.trim() },
    );
    if (state.history.length > HISTORY_MAX) {
      state.history.splice(0, state.history.length - HISTORY_MAX);
    }
  }
  currentLine = null;
  turnReply = '';
  turnError = false;
}

function appendSystem(text) {
  const d = document.createElement('div');
  d.className = 'line system';
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function appendUser(text) {
  const d = document.createElement('div');
  d.className = 'line user';
  d.textContent = text;
  logEl.appendChild(d);
  currentLine = null;
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------------------------------------------------------------- interaction

async function submit() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  appendUser(text);
  state.speaker.ensure();
  state.speaker.reset();
  state.idle.reset?.();

  // A new turn interrupts the previous one: stop its audio, abort its SSE
  // stream (the server aborts the provider calls when the socket closes), and
  // ignore any segment that was already in flight.
  if (state.turnAbort) state.turnAbort.abort();
  const controller = new AbortController();
  state.turnAbort = controller;
  const gen = ++state.turnGen;
  turnReply = '';
  turnError = false;

  try {
    await postTurn(text, controller.signal, gen);
  } catch (err) {
    if (err.name !== 'AbortError' && gen === state.turnGen) {
      appendSystem(`request failed: ${err.message}`);
    }
  } finally {
    if (state.turnAbort === controller) state.turnAbort = null;
  }
}

function newConversation() {
  if (state.turnAbort) state.turnAbort.abort();
  state.turnAbort = null;
  state.turnGen++;
  state.speaker.reset();
  state.history.length = 0;
  turnReply = '';
  turnError = false;
  currentLine = null;
  state.pendingSegments = 0;
  logEl.innerHTML = '<div class="line system">New conversation. History cleared.</div>';
}

sendEl.addEventListener('click', submit);
resetEl.addEventListener('click', newConversation);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});

// The camera drifts a few degrees toward the cursor. Drag-to-orbit is gone on
// purpose: gaussian splats fall apart in profile.
function trackPointer(e) {
  if (e.pointerType === 'touch') return;
  const nx = (e.clientX / window.innerWidth) * 2 - 1;
  const ny = (e.clientY / window.innerHeight) * 2 - 1;
  gaze.yaw = -nx * GAZE_YAW;
  gaze.pitch = BASE_PITCH + ny * GAZE_PITCH;
}

function resetGaze() {
  gaze.yaw = 0;
  gaze.pitch = BASE_PITCH;
}

if (!STATIC) {
  window.addEventListener('pointermove', trackPointer, { passive: true });
  window.addEventListener('pointerleave', resetGaze);
  window.addEventListener('blur', resetGaze);
}

window.addEventListener('error', (e) => {
  appendSystem(`${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  appendSystem(String(e.reason && e.reason.message || e.reason));
});

main().catch((err) => {
  appendSystem(err.message);
  console.error(err);
});
