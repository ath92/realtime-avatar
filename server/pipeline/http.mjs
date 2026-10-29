// Small HTTP helpers shared by the provider adapters: abort-aware sleep, a
// timeout signal, retry/backoff for rate limits, and error messages that say
// which env var to check instead of dumping a JSON blob.

export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ac = new AbortController();
  for (const signal of list) {
    if (signal.aborted) { ac.abort(signal.reason); break; }
    signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  }
  return ac.signal;
}

// A caller signal plus a wall-clock deadline. Generous defaults: a chat turn
// should not hang forever, but a cold model can take a few seconds to start.
export function deadline(signal, timeoutMs) {
  const timer = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? anySignal([signal, timer]) : timer;
}

export function timeoutError(label, timeoutMs) {
  return new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export function mapAbort(err, label, timeoutMs) {
  if (err?.name === 'TimeoutError') return timeoutError(label, timeoutMs);
  return err;
}

export async function readErrorBody(res) {
  try {
    return (await res.text()).slice(0, 1200);
  } catch {
    return '';
  }
}

const HINTS = {
  elevenlabs: {
    401: 'check ELEVENLABS_API_KEY',
    402: 'the ElevenLabs plan has no remaining credits',
    422: 'check ELEVENLABS_VOICE_ID and the voice settings',
    429: 'rate limited or out of credits',
  },
  openai: {
    401: 'check OPENAI_API_KEY',
    403: 'the key is not allowed to use this model',
    404: 'check OPENAI_BASE_URL and LLM_MODEL',
    429: 'rate limited; retry or use a smaller model',
  },
  deepseek: {
    401: 'check DEEPSEEK_API_KEY',
    402: 'the DeepSeek account has no remaining balance',
    404: 'check DEEPSEEK_BASE_URL and LLM_MODEL',
    429: 'rate limited; retry or use deepseek-chat',
  },
  anthropic: {
    401: 'check ANTHROPIC_API_KEY',
    404: 'check ANTHROPIC_MODEL',
    429: 'rate limited; retry or use a smaller model',
  },
};

function detailFromBody(body) {
  try {
    const json = JSON.parse(body);
    const detail = json.detail ?? json.error?.message ?? json.error ?? json.message;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') {
      return detail.message || detail.status || JSON.stringify(detail).slice(0, 300);
    }
  } catch { /* not JSON */ }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function httpError(provider, status, body) {
  const detail = detailFromBody(body) || 'no response body';
  const hint = HINTS[provider]?.[status];
  const err = new Error(`${provider} ${status}: ${detail}${hint ? ` (${hint})` : ''}`);
  err.status = status;
  err.provider = provider;
  return err;
}

function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(0, seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(10_000, Math.max(0, date - Date.now()));
  return undefined;
}

// Retries only before a response body is handed to the caller, so streaming a
// partial reply can never be duplicated. 4xx errors (other than 429) are final.
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const { attempts = 1, label = 'request', signal } = opts;
  const tries = Math.max(1, attempts);
  let delay = 350;
  let lastErr;

  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(delay, signal);
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err;
      const detail = err?.cause?.message || err?.message || String(err);
      lastErr = new Error(`${label} request failed: ${detail}`);
      delay = Math.min(8000, delay * 2) + Math.random() * 200;
      continue;
    }
    if (res.ok) return res;

    const body = await readErrorBody(res);
    const err = httpError(label, res.status, body);
    if (res.status !== 429 && res.status < 500) throw err;
    lastErr = err;
    delay = Math.min(8000, retryAfterMs(res) ?? delay * 2) + Math.random() * 200;
  }
  throw lastErr;
}

// Async generator over Server-Sent Events. Handles CRLF, multi-line data, and
// events split across network chunks — all three happen in the wild.
export async function* sseEvents(res) {
  if (!res.body) throw new Error('response has no body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const data = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
    // A final event without the trailing blank line.
    const tail = buf.trim();
    if (tail) {
      let event = 'message';
      const data = [];
      for (const line of tail.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
}
