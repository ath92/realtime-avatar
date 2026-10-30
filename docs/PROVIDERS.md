# Real providers

The scaffold runs with no keys. This page is about wiring it to a real LLM and a
real voice.

```bash
cp .env.example .env
$EDITOR .env
node server/server.mjs
npm run smoke
```

`.env` is loaded from the repo root at startup — `npm start`, `node server/server.mjs`,
and `npm run smoke` all pick it up with no `source`/`export` step. Existing
process env vars always win, so `DEEPSEEK_API_KEY=... node server/server.mjs` also
works. Keep the file private (`chmod 600 .env`); it is gitignored.

## How a provider is chosen

| | Automatic order | Override |
|---|---|---|
| LLM | `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `DEEPSEEK_API_KEY` → stub | `LLM_PROVIDER=openai\|deepseek\|anthropic\|stub` |
| STT | `ELEVENLABS_API_KEY` → `OPENAI_API_KEY` → off | `STT_PROVIDER=elevenlabs\|openai\|none` |
| TTS | `ELEVENLABS_API_KEY` → macOS `say` → babble | `TTS_PROVIDER=elevenlabs\|say\|none` |

An explicit `LLM_PROVIDER`, `STT_PROVIDER` or `TTS_PROVIDER` wins over detection.
With several LLM keys present, the order above decides; set `LLM_PROVIDER`
explicitly if you want a specific one. `GET /api/health` reports what was
resolved:

```json
{
  "tts": { "provider": "elevenlabs", "voiceId": "21m00Tcm4TlvDq8ikWAM",
           "model": "eleven_turbo_v2_5", "format": "pcm_22050", "available": true },
  "stt": { "provider": "elevenlabs", "model": "scribe_v2", "language": "auto",
           "available": true, "maxAudioBytes": 8388608 },
  "llm": { "provider": "deepseek", "model": "deepseek-chat",
           "baseUrl": "https://api.deepseek.com/v1", "available": true }
}
```

## LLM

All three adapters stream over SSE and expose the same contract to the
orchestrator:

```js
for await (const delta of streamReply(text, { history, signal })) { ... }
```

### DeepSeek

`DEEPSEEK_API_KEY` is enough. The server selects DeepSeek automatically, points
at `https://api.deepseek.com/v1`, and uses `deepseek-chat`:

```bash
DEEPSEEK_API_KEY=sk-...
```

Overrides, all optional:

| Variable | Default |
|---|---|
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | `deepseek-chat` |
| `LLM_PROVIDER` | `deepseek` (only needed to beat another key's auto-detection) |

If you already have `OPENAI_API_KEY` in your shell, setting `LLM_PROVIDER=deepseek`
makes the choice unambiguous. `deepseek-reasoner` works as `LLM_MODEL` if you
want reasoning, at the cost of latency.

### OpenAI-compatible

`LLM_PROVIDER=openai` speaks `POST /chat/completions` with `stream: true`, so it
works with anything that implements that shape:

| Provider | `OPENAI_BASE_URL` | `LLM_MODEL` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1` | e.g. `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | any routed model |
| Ollama | `http://127.0.0.1:11434/v1` | e.g. `llama3.2` |
| LM Studio | `http://127.0.0.1:1234/v1` | the loaded model |

DeepSeek is also reachable this way, but the dedicated provider above avoids
repeating the base URL and model.

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

## Speech to text (voice input)

The microphone button records one utterance and uploads 16 kHz mono 16-bit WAV;
the transcript then takes the same path as typed text. The provider is chosen the
same way as the other stages (see the table above).

```js
transcribe(bytes, { mime, language, signal }) -> { text, provider, model, ms }
```

The audio is not written to disk and is not kept after the request. The client
stops the recording itself — ~1.1 s after you pause, or after 30 s — and Esc
cancels a recording or a transcription in flight.

### ElevenLabs (Scribe)

`ELEVENLABS_API_KEY` is enough — it is the same key as the voice — **but the key
must have the `speech_to_text` permission**. ElevenLabs API keys are scoped per
permission, and a key created for TTS only (which is all the avatar's own voice
needs) returns:

```
elevenlabs 401: The API key you used is missing the permission speech_to_text to
execute this operation.
```

Enable **Speech to Text** on the key under **profile → API keys** (or create a
second key with it), then restart the server. The pipeline appends that
instruction to the error, so it shows up in the transcript too.

| Variable | Default | Notes |
|---|---|---|
| `ELEVENLABS_STT_MODEL` | `scribe_v2` | `scribe_v2_medical` for clinical audio |
| `STT_LANGUAGE` | unset (auto-detect) | ISO 639-1 or 639-3, e.g. `en` / `eng` |
| `ELEVENLABS_STT_PCM` | `true` | 16 kHz WAV is sent as headerless `pcm_s16le_16`, skipping Scribe's decode step; `false` always uploads a container |

The adapter calls `POST /v1/speech-to-text` with `file`, `model_id`, and
`tag_audio_events=false`, so `(laughter)`-style tags never reach the LLM.
`ELEVENLABS_ENABLE_LOGGING` maps to the endpoint's `enable_logging` flag, exactly
as it does for TTS.

### OpenAI (Whisper)

With only `OPENAI_API_KEY` set — or `STT_PROVIDER=openai` — the adapter calls
`POST /audio/transcriptions` with `response_format=json`, so any compatible
endpoint works, including a local whisper.cpp server on
`OPENAI_STT_BASE_URL=http://127.0.0.1:...` with no key.

| Variable | Default |
|---|---|
| `OPENAI_STT_MODEL` | `whisper-1` (`gpt-4o-mini-transcribe` is faster where available) |
| `OPENAI_STT_BASE_URL` | `OPENAI_BASE_URL` |
| `STT_LANGUAGE` | unset (auto-detect) |

`OPENAI_STT_BASE_URL` exists because the LLM often points `OPENAI_BASE_URL` at a
chat-only endpoint (Groq, OpenRouter, a local llama); give the microphone its own
base when Whisper runs elsewhere.

### What the microphone uploads

`client/mic.js` records with `MediaRecorder` (Opus/WebM in Chrome, AAC/MP4 in
Safari), decodes the result with WebAudio at 16 kHz, trims the silence either
side of the speech, and uploads 16-bit PCM WAV. That gives every browser one
format, ~32 kB/s, and no transcoder on the server. `STT_MAX_AUDIO_MB` (default 8)
caps the upload — a spoken turn is a few hundred kB; `STT_TIMEOUT_MS` (30 s) and
`STT_RETRIES` (1) bound and retry the provider call.

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

### Accent and identity drift

There is no accent parameter in the TTS API. The accent comes from the cloned
voice and the model that renders it, so an American clone can still come out
sounding British or Australian if the model drifts. The usual levers:

- `eleven_turbo_v2_5` and `eleven_flash_v2_5` optimise for latency and can drift
  toward the model's generic English. `eleven_multilingual_v2` is slower but
  tends to hold the clone's accent and identity better.
- `similarity_boost` is the anchor to the source voice: `0.75` is moderate,
  `0.9–1.0` sticks closer (occasionally with more artifacts).
- Low `stability` allows more variation in pronunciation; `0.6–0.7` is more
  consistent, at the cost of some expressiveness.
- Instant clones (`category: "cloned"`) preserve accent less reliably than
  Professional Voice Clones. If settings and model changes do not recover it,
  re-clone with more clean audio rather than fighting the request.

`ELEVENLABS_LANGUAGE_CODE` is ISO 639-1 (`en`), not a regional tag, so it cannot
select `en-US` versus `en-GB`; do not treat it as an accent control.

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

### Cloudflare Workers

The Worker runs the portable half of the pipeline: ElevenLabs or babble for TTS,
and any of the LLM adapters. There is no macOS `say`; selecting `TTS_PROVIDER=say`
returns a clear error. Configure the same env names as Worker secrets (or push
them from GitHub Actions) — see **[DEPLOY.md](DEPLOY.md)**. Provider selection is
unchanged: explicit `LLM_PROVIDER` / `TTS_PROVIDER`, then the first available
key.

## Checking it

```bash
npm run smoke                 # LLM reply + TTS audio + transcribe it back, prints timings
npm run smoke -- --json       # machine-readable
npm run smoke -- --no-tts     # LLM only
npm run smoke -- --no-stt     # skip the speech-to-text leg
npm run voices                # ElevenLabs voices
npm test                      # mocked provider contracts; no keys or network
```

`npm run smoke` exits non-zero if a configured provider is unusable, so it works
as a preflight in a deploy script. The speech-to-text leg reuses the TTS output
(it speaks a known sentence and transcribes it back), which makes it a real
end-to-end check of the voice loop — including the key permission above.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `elevenlabs 401 ... missing the permission speech_to_text` | the key is scoped to TTS only; enable **Speech to Text** on it, then restart |
| `Voice input is off` in the transcript | no speech-to-text key was resolved; set `ELEVENLABS_API_KEY` or `OPENAI_API_KEY` |
| `voice: microphone permission was denied` | the browser blocked the mic for this site; allow it in site settings |
| `voice: this browser cannot record audio` | no `getUserMedia`/`MediaRecorder`, or the page is not https/localhost |
| `Didn't catch any speech` | the recording was trimmed to nothing: mic muted, too quiet, or ended before 200 ms |
| `voice: unsupported content type` | `/api/transcribe` takes `audio/*` bodies only |
| `elevenlabs 401 ... check ELEVENLABS_API_KEY` | wrong/expired key, or the key lacks TTS permission |
| `elevenlabs 402` | plan out of credits |
| `elevenlabs 422 ... check ELEVENLABS_VOICE_ID` | voice ID not on this account, or a setting the model rejects |
| `elevenlabs 429` | rate limit or quota; the server retries with backoff first |
| `ELEVENLABS_OUTPUT_FORMAT must be raw PCM` | an `mp3_*`/`opus_*` format is configured |
| `deepseek 401 ... check DEEPSEEK_API_KEY` | wrong/expired key |
| `deepseek 402` | the DeepSeek account balance is exhausted |
| `deepseek 404 ... check DEEPSEEK_BASE_URL and LLM_MODEL` | wrong base URL, or model name not available |
| `openai 404 ... check OPENAI_BASE_URL and LLM_MODEL` | base URL missing `/v1`, or model name not available |
| `anthropic 404 ... check ANTHROPIC_MODEL` | model ID not enabled for the key |
| No audio in the browser | autoplay policy: the first click on **↵** unlocks the AudioContext |
| Replies are canned | no LLM key was resolved; check `/api/health` and `.env` |
| Health says `available: false` | the provider was configured explicitly but its key is missing |

## Data flow

With cloud providers, each turn sends the user's text and recent history to the
LLM, then sends the reply's sentence segments to ElevenLabs. ElevenLabs returns
audio; the server derives blendshape frames and both travel to the browser.
Rendering, the avatar asset, and the frame track stay local. A voice turn adds one
step in front: the recorded utterance goes to the speech-to-text provider and only
the resulting text continues. API keys never
leave the server — but the local server has no auth, and the public Worker has
only same-origin and best-effort rate limits. Keep the local server on localhost,
and put the deployed site behind Cloudflare Access (or an equivalent auth layer)
before sharing it; see **[DEPLOY.md](DEPLOY.md#security-and-cost)**.
