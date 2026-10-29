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
const statusEl = $('#status');
const statsEl = $('#stats');

const params = new URLSearchParams(location.search);
const STATIC = params.has('static');        // ?static=1 freezes the rig at rest
const ASSET = params.get('asset') || '/assets/head.avtr';   // ?asset=/path/to/other.avtr

const state = {
  avatar: null,
  rig: null,
  renderer: null,
  idle: new Idle(),
  speaker: new Speaker(),
  camera: { yaw: 0.0, pitch: 0.02, dist: 0.70, targetY: -0.035, fov: (32 * Math.PI) / 180 },
  dragging: false,
  last: performance.now(),
  fps: 0,
  frames: 0,
  fpsAt: performance.now(),
  drawMs: 0,
  visible: 0,
  turnSentAt: 0,
  firstAudioMs: null,
  pendingSegments: 0,
  turnAbort: null,
  turnGen: 0,
  history: [],
  health: null,
};

// ---------------------------------------------------------------- bootstrap

async function main() {
  statusEl.textContent = 'loading rig…';
  const avatar = await loadAvatar(ASSET);
  state.avatar = avatar;

  state.renderer = new SplatRenderer(canvas);
  state.renderer.setAvatar(avatar);
  state.rig = new Rig(avatar);

  if (params.has('debug')) window.__avatar = state;
  statusEl.textContent = 'ready';
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
    state.health = health;

    const llm = health.llm || {};
    const tts = health.tts || {};
    const voice = tts.voiceName || tts.voiceId || tts.voice || tts.model || '';
    const llmLabel = `${llm.provider || '?'}${llm.model ? ` · ${llm.model}` : ''}`;
    const ttsLabel = `${tts.provider || '?'}${voice ? ` · ${voice}` : ''}`;

    if (llm.provider === 'stub') {
      appendSystem(`No LLM key configured, so replies are canned. Put OPENAI_API_KEY or ANTHROPIC_API_KEY in .env and restart. Voice: ${ttsLabel}.`);
    } else if (tts.provider === 'none' || tts.available === false) {
      appendSystem(`Voice: ${ttsLabel}${tts.available === false ? ' (not configured)' : ' (synthetic)'}. Set ELEVENLABS_API_KEY in .env for real speech. LLM: ${llmLabel}.`);
    } else {
      appendSystem(`LLM: ${llmLabel} · voice: ${ttsLabel}`);
    }

    if (llm.available === false) {
      appendSystem(`warning: ${llm.provider} has no key — check .env before talking to it.`);
    }
  } catch {
    // Health is best-effort; the avatar still renders without it.
  }
}

// ---------------------------------------------------------------- rendering

const model = mat4.identity();

function loop(now) {
  const dt = Math.min(0.05, (now - state.last) / 1000);
  state.last = now;

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

  state.frames++;
  if (now - state.fpsAt > 500) {
    state.fps = (state.frames * 1000) / (now - state.fpsAt);
    state.frames = 0;
    state.fpsAt = now;
    updateHud(speech, idleCh);
  }

  const status = speech.active ? 'speaking'
    : state.pendingSegments > 0 ? 'thinking…'
      : 'idle';
  if (statusEl.textContent !== status) statusEl.textContent = status;
  document.body.dataset.speaking = speech.active ? '1' : '0';

  requestAnimationFrame(loop);
}

function updateHud() {
  const first = state.firstAudioMs === null ? '—' : `${Math.round(state.firstAudioMs)} ms`;
  statsEl.innerHTML = `
    <div><span>fps</span><b>${state.fps.toFixed(0)}</b></div>
    <div><span>gaussians</span><b>${state.visible.toLocaleString()}</b></div>
    <div><span>draw</span><b>${state.drawMs.toFixed(2)} ms</b></div>
    <div><span>first audio</span><b>${first}</b></div>
    <div><span>segments</span><b>${state.speaker.queued}</b></div>
  `;
}

// ---------------------------------------------------------------- transport

const HISTORY_MAX = 16;
let turnReply = '';
let turnError = false;
let currentLine = null;

async function postTurn(text, signal, gen) {
  state.turnSentAt = performance.now();
  state.firstAudioMs = null;
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
      if (state.firstAudioMs === null) state.firstAudioMs = performance.now() - state.turnSentAt;
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

// orbit
canvas.addEventListener('pointerdown', (e) => {
  state.dragging = true;
  canvas.setPointerCapture(e.pointerId);
  state.dragX = e.clientX;
  state.dragY = e.clientY;
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.dragging) return;
  state.camera.yaw -= (e.clientX - state.dragX) * 0.006;
  state.camera.pitch = Math.max(-0.6, Math.min(0.6,
    state.camera.pitch + (e.clientY - state.dragY) * 0.005));
  state.dragX = e.clientX;
  state.dragY = e.clientY;
});
canvas.addEventListener('pointerup', () => { state.dragging = false; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.camera.dist = Math.max(0.25, Math.min(1.1, state.camera.dist + e.deltaY * 0.0004));
}, { passive: false });

window.addEventListener('error', (e) => {
  statusEl.textContent = 'error';
  appendSystem(`${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  statusEl.textContent = 'error';
  appendSystem(String(e.reason && e.reason.message || e.reason));
});

main().catch((err) => {
  statusEl.textContent = 'failed';
  appendSystem(err.message);
  console.error(err);
});
