# Real providers

The scaffold runs with no keys. This page is about wiring it to a real LLM and a
real voice.

```bash
cp .env.example .env
$EDITOR .env
node server/server.mjs
npm run smoke
```

`.env` is loaded from the repo root at startup. Existing process env vars always
win, so `OPENAI_API_KEY=... node server/server.mjs` also works.

## How a provider is chosen

| | Automatic order | Override |
|---|---|---|
| LLM | `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → stub | `LLM_PROVIDER=openai\|anthropic\|stub` |
| TTS | `ELEVENLABS_API_KEY` → macOS `say` → babble | `TTS_PROVIDER=elevenlabs\|say\|none` |

An explicit `LLM_PROVIDER` or `TTS_PROVIDER` wins over detection. With both LLM
keys present, OpenAI-compatible is chosen — set `LLM_PROVIDER=anthropic` if you
want Claude. `GET /api/health` reports what was resolved:

```json
{
  "tts": { "provider": "elevenlabs", "voiceId": "21m00Tcm4TlvDq8ikWAM",
           "model": "eleven_turbo_v2_5", "format": "pcm_22050", "available": true },
  "llm": { "provider": "openai", "model": "gpt-4o-mini",
           "baseUrl": "https://api.openai.com/v1", "available": true }
}
```

## LLM

Both adapters stream over SSE and expose the same contract to the orchestrator:

```js
for await (const delta of streamReply(text, { history, signal })) { ... }
```

### OpenAI-compatible

`LLM_PROVIDER=openai` speaks `POST /chat/completions` with `stream: true`, so it
works with anything that implements that shape:

| Provider | `OPENAI_BASE_URL` | `LLM_MODEL` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Groq | `https://api.groq.com/openai/v1` | e.g. `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | any routed model |
| Ollama | `http://127.0.0.1:11434/v1` | e.g. `llama3.2` |
| LM Studio | `http://127.0.0.1:1234/v1` | the loaded model |

A key is optional only for localhost base URLs. `Authorization` is omitted when
`OPENAI_API_KEY` is empty.

### Anthropic

`LLM_PROVIDER=anthropic` uses `POST /v1/messages` with `anthropic-version:
2023-06-01`. `ANTHROPIC_MODEL` defaults to `claude-haiku-4-5` (a good
latency/quality trade for a talking head); switch to a larger model if you want
more reasoning and can accept the delay. `LLM_MAX_TOKENS` defaults to 400 here
because Anthropic requires the field.

### Prompt, history, sampling

- `LLM_SYSTEM` overrides the built-in spoken-word system prompt. The default asks
  for one to three short sentences, no markdown or emoji, and contractions.
- The browser keeps the last 16 messages and sends them with each turn; the
  server sanitises them again (string content only, 2,000 chars per message,
  adjacent same-role turns merged, leading assistant turns dropped). The ↺ button
  starts a fresh conversation.
- `LLM_TEMPERATURE` is only sent when set. Use `LLM_TEMPERATURE=none` to omit it
  for reasoning models that reject the parameter.
- `LLM_MAX_TOKENS` is only sent for OpenAI-compatible endpoints when set.
- `LLM_TIMEOUT_MS` bounds a whole stream (default 90 s). One retry is attempted
  for 429/5xx responses *before* any tokens are read, so a retry cannot duplicate
  half a reply.
- Closing the browser tab aborts the in-flight LLM request on the server.

## TTS

### ElevenLabs

```bash
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5
ELEVENLABS_OUTPUT_FORMAT=pcm_22050
```

`npm run voices` lists the voice IDs on your account with their names and
categories. The default voice is Rachel, a public library voice.

**Why PCM?** Node has no built-in MP3 decoder and this repo has no dependencies.
ElevenLabs can return raw 16-bit little-endian mono PCM (`pcm_16000`,
`pcm_22050`, `pcm_24000`, ...), which the server wraps in a WAV header and sends
to WebAudio. `pcm_44100` requires the Pro tier; `ELEVENLABS_OUTPUT_FORMAT` must be
a `pcm_*` value or the server refuses at startup of the first segment with a
clear error.

Model choice:

| `ELEVENLABS_MODEL_ID` | Use |
|---|---|
| `eleven_flash_v2_5` | lowest latency, good for realtime; slightly less expressive |
| `eleven_turbo_v2_5` | default; balanced latency and quality |
| `eleven_multilingual_v2` | highest quality, slower; best for non-English |

Voice shape is controllable with `ELEVENLABS_STABILITY` (default `0.45`),
`ELEVENLABS_SIMILARITY` (`0.75`), `ELEVENLABS_STYLE` (`0`),
`ELEVENLABS_SPEED` (unset = provider default), and
`ELEVENLABS_SPEAKER_BOOST` (`true`). `ELEVENLABS_LANGUAGE_CODE` is optional and
only sent when set; it is not supported by `eleven_multilingual_v2`.

The server splits the reply into sentence segments and calls TTS once per
segment, passing the previous segment as `previous_text` so ElevenLabs can keep
prosody continuous across the joins (`ELEVENLABS_REQUEST_STITCHING=false`
disables this). Each segment request is retried up to `ELEVENLABS_RETRIES` times
(default 2) on 429/5xx.

Generated segments are cached in a small in-memory LRU keyed by text, voice,
model, format, settings, language, and stitching context (`TTS_CACHE_SIZE`,
default 32; `0` disables). TTS is billed per character, so repeated greetings and
fillers are free after the first hit. The cache is per process and is lost on
restart.

`ELEVENLABS_ENABLE_LOGGING` defaults to `true`, matching the API. Setting it to
`false` requests zero-retention mode, which ElevenLabs documents as an enterprise
feature; on other plans the request can fail.

### macOS `say`

`TTS_PROVIDER=say` (or no ElevenLabs key on macOS) shells out to `say` and
`afconvert`. `TTS_VOICE` defaults to `Samantha`, `TTS_RATE` to `185`. On
non-macOS hosts, `say` is unavailable; the automatic fallback there is synthetic
babble (`TTS_PROVIDER=none`), which still drives the mouth.

## Checking it

```bash
npm run smoke                 # LLM reply + TTS audio, prints timings, writes a WAV
npm run smoke -- --json       # machine-readable
npm run smoke -- --no-tts     # LLM only
npm run voices                # ElevenLabs voices
npm test                      # mocked provider contracts; no keys or network
```

`npm run smoke` exits non-zero if a configured provider is unusable, so it works
as a preflight in a deploy script.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `elevenlabs 401 ... check ELEVENLABS_API_KEY` | wrong/expired key, or the key lacks TTS permission |
| `elevenlabs 402` | plan out of credits |
| `elevenlabs 422 ... check ELEVENLABS_VOICE_ID` | voice ID not on this account, or a setting the model rejects |
| `elevenlabs 429` | rate limit or quota; the server retries with backoff first |
| `ELEVENLABS_OUTPUT_FORMAT must be raw PCM` | an `mp3_*`/`opus_*` format is configured |
| `openai 404 ... check OPENAI_BASE_URL and LLM_MODEL` | base URL missing `/v1`, or model name not available |
| `anthropic 404 ... check ANTHROPIC_MODEL` | model ID not enabled for the key |
| No audio in the browser | autoplay policy: the first click on **↵** unlocks the AudioContext |
| Replies are canned | no LLM key was resolved; check `/api/health` and `.env` |
| Health says `available: false` | the provider was configured explicitly but its key is missing |

## Data flow

With cloud providers, each turn sends the user's text and recent history to the
LLM, then sends the reply's sentence segments to ElevenLabs. ElevenLabs returns
audio; the server derives blendshape frames and both travel to the browser.
Rendering, the avatar asset, and the frame track stay local. API keys never leave
the server — but the server has no auth, so keep it on localhost or put it behind
auth and rate limits before exposing it.
