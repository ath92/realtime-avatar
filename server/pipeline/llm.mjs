// LLM reply source.
//
// Two providers:
//   stub   - streams a canned response with realistic inter-token timing so you
//            can measure the pipeline without an API key (the default)
//   openai - any OpenAI-compatible /chat/completions endpoint, streaming
//
// The contract is a plain async generator of string deltas, which is what the
// orchestration layer wants regardless of vendor.

const STUB_LINES = [
  "Hey, good to see you. I'm running entirely in your browser right now — the face you're looking at is about forty thousand little gaussians being pushed around sixty times a second.",
  'The voice comes from the machine, the mouth comes from the audio, and the only thing leaving your device is text. No video, no camera, no upload.',
  'Ask me anything. If this were wired to a real model you would already be talking to it.',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(list, seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return list[Math.abs(h) % list.length];
}

export async function* stubReply(userText) {
  const base = pick(STUB_LINES, userText || 'hello');
  const words = base.split(' ');
  // ~2 tokens/sec of "thinking" up front, then chat-speed deltas
  await sleep(220 + Math.random() * 180);
  for (let i = 0; i < words.length; i++) {
    yield words[i] + (i === words.length - 1 ? '' : ' ');
    await sleep(18 + Math.random() * 26);
  }
}

export async function* openaiReply(userText, opts = {}) {
  const base = (opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = opts.model || process.env.LLM_MODEL || 'gpt-4o-mini';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: opts.system || 'You are a friendly, concise conversational partner. Reply in two or three short sentences of plain spoken English. No markdown, no lists.' },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta?.content;
        if (d) yield d;
      } catch { /* partial frame, ignore */ }
    }
  }
}

export function streamReply(text) {
  const provider = process.env.LLM_PROVIDER || 'stub';
  if (provider === 'openai' && process.env.OPENAI_API_KEY) return openaiReply(text);
  return stubReply(text);
}
