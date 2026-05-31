# Jarvis Architecture

Jarvis is a real-time voice assistant for frontline workers (field
technicians, on-site operators, emergency responders). It is built on
the OpenAI Realtime GA model (`gpt-realtime`), grounded by a small,
explicit tool surface, and backed by per-user SQLite memory so a
session that drops mid-conversation can resume where it left off.

This document is the in-repo architecture description. The polished,
diagram-heavy version lives at `website/index.html` and tracks the same
component boundaries. When this file changes, that file changes in the
same commit.

## Topology

```
                +-----------------------------+
                |        Web client           |
                |   (Vite, AudioWorklet)      |
                +--------------+--------------+
                               |
            wss://.../realtime |   24 kHz PCM16, jarvis.* events
                               v
                +-----------------------------+
                |       Jarvis Proxy          |
                |  src/index.ts + src/proxy   |
                |  - one client WS in         |
                |  - one upstream WS out      |
                |  - per-client tool dispatch |
                +---+----------+-----------+--+
                    |          |           |
                    |          |           +---> SQLite (data/jarvis.db)
                    |          |                 - users, turns,
                    |          |                   preferences, memory_summaries
                    |          |
                    |          +---> OpenAI Chat Completions
                    |                (gpt-4o-mini) — rolling summarizer
                    |
                    v
       wss://api.openai.com/v1/realtime?model=gpt-realtime
```

## Components

### 1. HTTP + WebSocket entry (`src/index.ts`)

Single Node 20 process. Hosts `GET /healthz` (capability dump) and a
WebSocketServer on `/realtime`. Per-connection lifecycle:

1. Read `X-User-Id` from the upgrade headers (UUID v4, case-insensitive)
   or mint a new one.
2. Open the SQLite handle in WAL mode (`src/db.ts`); fall back to
   memory-offline mode if the open fails so the voice loop still works.
3. Build the `userCtx` (rolling summary + last 20 turns + preferences).
4. Hand off to `runProxy(...)` (Section 2).
5. On each persisted assistant turn, fire-and-forget the rolling
   memory summarizer (Section 6) gated by a 20-new-turn threshold.

SIGINT/SIGTERM closes the WS server, the HTTP server, and the SQLite
handle in order, then exits.

### 2. OpenAI Realtime Proxy (`src/proxy.ts`)

For each downstream client, opens one upstream WebSocket to
`wss://api.openai.com/v1/realtime?model=gpt-realtime` and shuttles
events both ways. Hard rules baked in here (each one corresponds to a
real production lesson — see `constitution.md`):

| Lesson | Rule |
| ------ | ---- |
| Y / GA | No `OpenAI-Beta` header. URL carries `model=...`. |
| Y2     | `session.update` uses the FULLY NESTED `audio.input.format` shape. |
| Y      | Rename upstream `response.output_audio.delta` to the client-stable `response.audio.delta`. |
| F5     | The system prompt includes the literal "Always respond in English." sentence; GA Realtime ignores `language: "en"` hints. |
| F6     | Client buffers are coerced to UTF-8 strings — GA rejects binary frames. |
| Y1     | Events whose `type` starts with `jarvis.` are NEVER forwarded upstream. |

Function calls from the model run through the Tool Dispatcher
(Section 3). A `slowFiller` on the tool emits a `jarvis.filler`
event AND an upstream assistant message so the agent's spoken filler
reaches the user immediately (US-02).

Barge-in: receipt of `jarvis.barge_in` from the client triggers
`response.cancel` upstream within 300 ms (US-04, verified in
`tests/integration/barge-in-latency.test.ts`).

### 3. Tool Dispatcher (`src/tools/dispatcher.ts`)

The single seam between OpenAI function calls and the business code.
Provides:

- `register(def)` — installs a tool. Names must be unique.
- `capabilities(env)` — live availability list for the system prompt.
- `openaiToolsSpec(env)` — the `tools[]` payload for `session.update`.
- `dispatch(name, rawArgs, ctx)` — validates args via the tool's zod
  schema, runs the handler, wraps thrown errors as structured
  `tool_failed` / `tool_disabled` / `tool_not_found` / `tool_args_invalid`
  errors so the agent never sees a stack trace.

A hand-rolled `zodToJsonSchemaSafe` covers the shapes our tools use
(object/string/number/boolean/enum/optional/default). Extending it is
deliberate — adding a union, refinement, or array type means a written
test and a manual review of generated JSON Schema.

### 4. Tool surface (`src/tools/*`)

Five live tools, all return `{error: ...}` records on failure (never throw):

- `wttr_get(location)` — live wttr.in fetch, 60 s in-memory cache,
  `fetched_at_iso` on every response. Caller MUST treat the timestamp
  as the truth signal (no-mock-or-reused-data rule).
- `memory_write(key, value)` — durable note under `note:<key>`.
- `preference_set(key, value)` / `preference_clear(key)` — typed enum
  keys (`flag_author`, `never_mention`, etc.).
- `github_list_prs` / `github_list_issues` / `github_get_pr_comments` /
  `github_list_recent_merges` — Octokit-backed, structured per-error
  mapping (401 → `github_auth_failed`, 403 → `github_rate_limited`,
  404 → `github_not_found`).
- `github_open_pr_for_issue` — US-12 agentic flow. Creates a
  `jarvis/fix-<n>-<sha>` branch, commits a `JARVIS_FIX_<n>.md`
  placeholder, opens a DRAFT pull request, returns the URL. Verified
  end-to-end against `scott-lydon/jarvis-fixture` in
  `tests/smoke/github-agentic.test.ts`.

Slice 8 adds a deterministic post-call filter inside `github_list_prs`
and `github_list_recent_merges` that bubbles PRs from flagged authors
to the top with `flagged: true`. The flagged author list comes from
the per-user preference row keyed `flag_author` — so even if the model
forgets the prompt-level instruction, the result payload still has the
flagged PR at index 0.

### 5. Session Manager (`src/session.ts`)

Pure function. Composes the system prompt from eight blocks:

```
1. Identity
2. Capability block          (LIVE from the dispatcher; US-05)
3. Memory digest             (summary + last-N turns; US-03)
4. Preferences               (per-user; US-08, US-11)
5. Language directive        (F5)
6. Hallucination guard       (US-06; tested in tests/property)
7. Slow-tool filler reminder (US-02)
8. Barge-in reminder         (US-04)
```

Empty user contexts (first connection, or memory-offline) flow through
the same path; the prompt simply gets shorter.

### 6. Memory + Rolling Summarizer (`src/memory-summarizer.ts` + `src/db.ts`)

- SQLite WAL, 4 tables: `users`, `turns`, `preferences`,
  `memory_summaries` (+ `schema_version`).
- All read queries parameterise by `user_id` — US-11 isolation is a
  data-layer invariant, not a runtime check.
- After every assistant turn, `maybeRollSummary(db, userId, env)` is
  fired-and-forgotten. It SELECTs `turn_count` from the existing
  summary; if `current - prior >= 20` it fetches the recent 40 turns,
  prompts `gpt-4o-mini` to produce a 4-6 sentence summary, and upserts
  the row. Failures preserve the prior summary and log a `warn`.

### 7. Web client (`web/*`)

Vite + plain TypeScript. Single `JarvisClient` class:

- Mic capture: `getUserMedia` → 24 kHz `AudioContext` → `pcm-recorder.js`
  worklet → Float32 → Int16 → base64 → `input_audio_buffer.append`.
- Playback: `response.audio.delta` → Float32 → `pcm-player.js` worklet
  with sample-accurate scheduling; barge-in clears the queue in ~3 ms.
- 32-bar AnalyserNode visualizer.
- `?demo=<manifest>` URL handler + `window.__demoReady` /
  `window.__startDemo()` globals (Playwright-friendly headless demo).
- Mic permission denied modal (bounded height, sticky header close X,
  per the CLAUDE.md overlay-overflow rule).
- WebSocket auto-retry with 1 s backoff up to 3 attempts.

### 8. iOS client (`ios/Jarvis/*`)

Swift Package Manager layout. Three targets:

- `Jarvis` (library) — `AudioEngineCoordinator` (AVAudioEngine capture
  via `AVAudioConverter` to 24 kHz, AVAudioPlayerNode playback),
  `JarvisSocket` (URLSessionWebSocketTask + 1 s backoff x3 retries),
  `JarvisViewModel` (@MainActor, ObservableObject), `JarvisView` +
  `JarvisSettingsView` (SwiftUI), `JarvisConfig` (UserDefaults +
  Keychain extension augmentation).
- `JarvisApp` (executable, `@main`) — Info.plist with the mic
  permission string and a localhost-only ATS exception.
- `JarvisTests` — XCTest for the config seam.

### 9. Deployment

Render Web Service (Node 20) with a 1 GB persistent disk mounted at
`/data` for `jarvis.db`. Health probe is `/healthz` (returns the live
capability list so Render is only green when the tool surface is
actually loaded). Secrets (`OPENAI_API_KEY`, `GITHUB_TOKEN`) are
configured in the Render UI; `render.yaml` lists them with
`sync: false`.

## Data flow — single voice turn

```
mic chunk (50 ms)
   ↓ Float32 → Int16 LE
   ↓ base64
   ↓ {type:"input_audio_buffer.append", audio:"..."}
client WS → proxy → upstream WS
                       ↓
                  GA Realtime
                       ↓ response.output_audio.delta
                  upstream WS → proxy
                                  ↓ rename to response.audio.delta
                                  ↓ Float32 → AudioWorklet
                              client WS → speakers
```

If the model calls a function:

```
upstream emits response.function_call_arguments.done
   ↓
proxy parses arguments → dispatcher.dispatch(name, args, ctx)
   ↓
tool result (real, live)
   ↓ optional jarvis.filler emitted FIRST (slow-tool cue)
proxy posts conversation.item.create(function_call_output) upstream
proxy posts response.create upstream
   ↓
model speaks the result honestly (zero-hallucination guard in prompt)
```

## Decisions table

| Decision                       | What I chose                                | Alternative              | Why |
| ------------------------------ | ------------------------------------------- | ------------------------ | --- |
| Realtime endpoint shape        | OpenAI Realtime GA, no Beta header          | Beta endpoint            | Beta is being deprecated; lesson Y showed Beta+GA mixed mode silently breaks audio. |
| Audio format                   | PCM16 LE 24 kHz mono                        | Opus over WebRTC         | Realtime GA only accepts PCM16; WebRTC adds an opaque transport layer that's hard to debug from the proxy seam. |
| Memory store                   | SQLite WAL on a persistent disk             | Postgres / Redis         | Per-user data is small (≤ a few MB); SQLite removes a deploy dependency and lets the test suite use real DBs on tmp paths instead of mocks. |
| Tool argument validation       | zod schemas at the dispatcher seam          | hand-rolled checks       | One place for parsing, one place for `tool_args_invalid` errors, plus a JSON Schema generator the proxy ships to OpenAI. |
| Cross-session summarizer       | gpt-4o-mini, gated by 20-turn threshold     | summarize every turn     | Cost; the threshold keeps OpenAI Chat usage minimal while still cheap enough to be a non-event vs. the Realtime spend. |
| Hallucination guard            | Prompt-level + property test                | Per-tool refusal         | The model has to choose to refuse; we make the contract auditable by asserting the prompt contains the directive. |
| Preferences flag-author bubble | Deterministic post-call filter              | Pure prompt instruction  | The model is fallible; the filter guarantees the flagged PR appears at index 0 of the result payload regardless of what the model says. |
| iOS audio engine               | AVAudioEngine + AVAudioConverter            | AVAudioRecorder          | Recorder writes a file; we need an in-process stream at a specific rate. Converter handles whatever the hardware delivers. |
| iOS userId persistence         | Keychain (generic-password, after-first-unlock) | UserDefaults            | UserDefaults disappears on iCloud restore + app reinstall; Keychain survives both, preserving cross-session memory. |
| Deploy platform                | Render Web Service + persistent disk        | Fly / DO App / EC2       | Render Blueprint maps cleanly to one YAML, persistent disk for SQLite is a first-class feature, no Dockerfile needed. |

## Trade-offs

- **SQLite single-writer** — Acceptable at MVP scale. When concurrent
  users on one node cross a couple hundred, the write fan-out from the
  per-turn append will saturate WAL; the migration target is
  `libsql` (Turso) which speaks the same SQL surface.
- **In-memory weather cache** — Per-process. A multi-region deploy
  would see 60 s of cache invalidation skew; acceptable for the
  current single-region Render plan.
- **No retry on upstream OpenAI WS drops** — The proxy closes the
  client connection if the upstream drops; the client's auto-retry
  ladders back up. Cleaner than a stale partial session, less smart
  than reconnecting the upstream silently.
- **`zodToJsonSchemaSafe` hand-rolled** — Smaller surface than the
  full `zod-to-json-schema` package and one fewer dependency to audit.
  Cost: each new zod shape we want to use in a tool needs a deliberate
  extension here.

## Trust boundaries

```
[ user voice ] -- (HTTPS WS) --> [ Jarvis proxy ] -- (HTTPS WS) --> [ OpenAI Realtime ]
                                       |
                                       +--> [ SQLite (local, user-scoped rows) ]
                                       |
                                       +--> [ Octokit -> GitHub API ] (OAuth token, server-side)
                                       |
                                       +--> [ wttr.in ] (public, no creds)
                                       |
                                       +--> [ OpenAI Chat (gpt-4o-mini) ] (summary)
```

- `OPENAI_API_KEY` and `GITHUB_TOKEN` live only on the server. They are
  never echoed back to the client. The structured logger redacts
  `sk-*`, `sk-proj-*`, `ghp_*`, `github_pat_*` from every log line.
- `userId` is treated as a public-knowledge identifier — it's a UUID v4
  that the client persists in localStorage / Keychain. A leaked userId
  unlocks one user's memory but no secrets.
- Per-user SQL is enforced at the data-layer: every query has a
  `WHERE user_id = @user_id` clause. The load test
  (`tests/load/concurrent-users.test.ts`) holds the line by asserting
  10 users see only their own preferences and turns.
