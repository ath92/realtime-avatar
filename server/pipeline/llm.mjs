// LLM reply source.
//
// Providers:
//   openai    - any OpenAI-compatible /chat/completions endpoint, streaming
//               (OpenAI, DeepSeek, Groq, Together, OpenRouter, Ollama, LM Studio)
//   anthropic - Anthropic Messages API, streaming
//   stub      - a canned reply, so the repo runs with no keys
//
// The contract is a plain async generator of string deltas. Conversation
// history is passed in and sanitised here, so the orchestration layer does not
// need to know which vendor is behind it.

import { env, envNum, envOptionalNum } from '../env.mjs';
import { deadline, fetchWithRetry, mapAbort, sseEvents, sleep } from './http.mjs';

const DEFAULT_SYSTEM = [
  'You are the face of a realtime avatar rendered in the user\'s browser.',
  'Speak like a person in a conversation, not like an assistant writing an essay.',
  'Reply in one to three short sentences of plain spoken English.',
  'Use contractions. No markdown, lists, headings, emoji, URLs, or stage directions.',
  'Do not mention being a language model. If you do not know something, say so briefly.',
].join(' ');

const STUB_LINES = [
  "I'm running without a model key right now, so this is a canned reply — but the pipeline around me is real.",
  'My voice is synthesised, my mouth is driven by that audio, and the face is about forty thousand gaussians being pushed around sixty times a second in your browser.',
  'Put an API key in .env and restart the server, and you can ask me something that actually needs a brain.',
];

function pick(list, seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return list[Math.abs(h) % list.length];
}

function isLocalBase(base) {
  try {
    const host = new URL(base).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
      || host === '::1' || host === '[::1]' || host === 'host.docker.internal';
  } catch {
    return false;
  }
}

export function llmProvider() {
  const explicit = env('LLM_PROVIDER').toLowerCase();
  if (explicit === 'openai-compatible' || explicit === 'openai_compatible') return 'openai';
  if (explicit) return explicit;
  if (env('OPENAI_API_KEY')) return 'openai';
  if (env('ANTHROPIC_API_KEY')) return 'anthropic';
  if (env('DEEPSEEK_API_KEY')) return 'deepseek';
  return 'stub';
}

export function llmInfo() {
  const provider = llmProvider();
  if (provider === 'openai') {
    const baseUrl = env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
    return {
      provider,
      available: Boolean(env('OPENAI_API_KEY')) || isLocalBase(baseUrl),
      model: env('LLM_MODEL', 'gpt-4o-mini'),
      baseUrl,
    };
  }
  if (provider === 'deepseek') {
    return {
      provider,
      available: Boolean(env('DEEPSEEK_API_KEY')),
      model: env('LLM_MODEL', 'deepseek-chat'),
      baseUrl: env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    };
  }
  if (provider === 'anthropic') {
    return {
      provider,
      available: Boolean(env('ANTHROPIC_API_KEY')),
      model: env('ANTHROPIC_MODEL', 'claude-haiku-4-5'),
    };
  }
  if (provider === 'stub') {
    return { provider, available: true, model: 'canned reply' };
  }
  return { provider, available: false, error: `unknown LLM_PROVIDER "${provider}"` };
}

function systemPrompt(opts = {}) {
  return opts.system !== undefined ? opts.system : env('LLM_SYSTEM', DEFAULT_SYSTEM);
}

// Keep history vendor-neutral: only user/assistant strings, adjacent same-role
// messages merged (Anthropic requires alternating turns), bounded in length.
export function sanitizeHistory(history, opts = {}) {
  const maxMessages = opts.maxMessages ?? 16;
  const maxChars = opts.maxChars ?? 2000;
  if (!Array.isArray(history)) return [];

  const out = [];
  for (const item of history) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : '';
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!role || !content) continue;

    const text = content.slice(0, maxChars);
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n${text}`.slice(0, maxChars);
    } else {
      out.push({ role, content: text });
    }
  }

  // A conversation may not start with the assistant, including after the
  // window is capped to an odd number of messages.
  const capped = out.slice(-maxMessages);
  while (capped.length && capped[0].role === 'assistant') capped.shift();
  return capped;
}

function messageList(history, userText) {
  const messages = sanitizeHistory(history);
  const text = String(userText || '').trim().slice(0, 8000);
  if (text) messages.push({ role: 'user', content: text });
  return messages;
}

// ------------------------------------------------------------------ stub ----

export async function* stubReply(userText, opts = {}) {
  const base = pick(STUB_LINES, userText || 'hello');
  const words = base.split(' ');
  await sleep(220 + Math.random() * 180, opts.signal);
  for (let i = 0; i < words.length; i++) {
    if (opts.signal?.aborted) return;
    yield words[i] + (i === words.length - 1 ? '' : ' ');
    await sleep(18 + Math.random() * 26, opts.signal);
  }
}

// ---------------------------------------------------------------- openai ----

function openaiConfig(opts) {
  return {
    baseUrl: (opts.baseUrl || env('OPENAI_BASE_URL', 'https://api.openai.com/v1')).replace(/\/+$/, ''),
    apiKey: opts.apiKey || env('OPENAI_API_KEY'),
    model: opts.model || env('LLM_MODEL', 'gpt-4o-mini'),
    system: systemPrompt(opts),
    temperature: envOptionalNum('LLM_TEMPERATURE'),
    maxTokens: envNum('LLM_MAX_TOKENS', 0) || undefined,
    timeoutMs: envNum('LLM_TIMEOUT_MS', 90_000),
    label: opts.label || 'openai',
    name: opts.name || 'OpenAI',
    keyName: opts.keyName || 'OPENAI_API_KEY',
  };
}

export async function* openaiReply(userText, opts = {}) {
  const cfg = openaiConfig(opts);
  if (!cfg.apiKey && !isLocalBase(cfg.baseUrl)) {
    throw new Error(`LLM_PROVIDER=${cfg.label} but ${cfg.keyName} is not set`);
  }

  const body = {
    model: cfg.model,
    stream: true,
    messages: [
      ...(cfg.system ? [{ role: 'system', content: cfg.system }] : []),
      ...messageList(opts.history, userText),
    ],
  };
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  if (cfg.maxTokens !== undefined) body.max_tokens = cfg.maxTokens;

  const signal = deadline(opts.signal, cfg.timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  try {
    const res = await fetchWithRetry(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, { attempts: 2, label: cfg.label, signal });

    for await (const ev of sseEvents(res)) {
      if (ev.data.trim() === '[DONE]') return;
      let json;
      try { json = JSON.parse(ev.data); } catch { continue; }
      if (json.error) {
        throw new Error(`${cfg.label} stream: ${json.error.message || JSON.stringify(json.error).slice(0, 200)}`);
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.text ?? choice?.message?.content;
      if (typeof delta === 'string' && delta) yield delta;
    }
  } catch (err) {
    throw mapAbort(err, cfg.name, cfg.timeoutMs);
  }
}

// ------------------------------------------------------------- anthropic ----

function anthropicConfig(opts) {
  return {
    baseUrl: (opts.baseUrl || env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')).replace(/\/+$/, ''),
    apiKey: opts.apiKey || env('ANTHROPIC_API_KEY'),
    model: opts.model || env('ANTHROPIC_MODEL', 'claude-haiku-4-5'),
    version: env('ANTHROPIC_VERSION', '2023-06-01'),
    system: systemPrompt(opts),
    temperature: envOptionalNum('LLM_TEMPERATURE'),
    maxTokens: Math.max(1, envNum('LLM_MAX_TOKENS', 400)),
    timeoutMs: envNum('LLM_TIMEOUT_MS', 90_000),
  };
}

export async function* anthropicReply(userText, opts = {}) {
  const cfg = anthropicConfig(opts);
  if (!cfg.apiKey) throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');

  const messages = messageList(opts.history, userText);
  if (!messages.length) messages.push({ role: 'user', content: 'hello' });

  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    stream: true,
    messages,
  };
  if (cfg.system) body.system = cfg.system;
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;

  const signal = deadline(opts.signal, cfg.timeoutMs);
  try {
    const res = await fetchWithRetry(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': cfg.version,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    }, { attempts: 2, label: 'anthropic', signal });

    for await (const ev of sseEvents(res)) {
      let json;
      try { json = JSON.parse(ev.data); } catch { continue; }

      if (json.type === 'error' || ev.event === 'error') {
        throw new Error(`anthropic stream: ${json.error?.message || JSON.stringify(json).slice(0, 200)}`);
      }
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        const text = json.delta.text;
        if (text) yield text;
      }
      if (json.type === 'message_stop') return;
    }
  } catch (err) {
    throw mapAbort(err, 'Anthropic', cfg.timeoutMs);
  }
}

// DeepSeek is wire-compatible with OpenAI chat completions, but it deserves
// first-class treatment: one DEEPSEEK_API_KEY is enough to select it, with the
// correct base URL and model, instead of making everyone remember the preset.
export function deepseekReply(userText, opts = {}) {
  return openaiReply(userText, {
    ...opts,
    baseUrl: opts.baseUrl || env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
    apiKey: opts.apiKey || env('DEEPSEEK_API_KEY'),
    model: opts.model || env('LLM_MODEL', 'deepseek-chat'),
    label: 'deepseek',
    name: 'DeepSeek',
    keyName: 'DEEPSEEK_API_KEY',
  });
}

// ----------------------------------------------------------------- entry ----

export function streamReply(text, opts = {}) {
  const provider = (opts.provider || llmProvider()).toLowerCase();
  if (provider === 'openai' || provider === 'openai-compatible') return openaiReply(text, opts);
  if (provider === 'deepseek') return deepseekReply(text, opts);
  if (provider === 'anthropic') return anthropicReply(text, opts);
  if (provider === 'stub') return stubReply(text, opts);
  return (async function* unknown() {
    throw new Error(`unknown LLM_PROVIDER "${provider}" (use openai, deepseek, anthropic, or stub)`);
  })();
}
