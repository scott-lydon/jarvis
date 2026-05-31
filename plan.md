# Jarvis Build Plan

How it gets built. Architecture, component breakdown, primary data flow, decisions, trade-offs, slice sequencing.

This file is the source for the architecture website's decision table (`website/index.html`) and the source for `ARCHITECTURE.md` (Slice 0). If those documents disagree with this file, THIS file wins.

---

## 1. High-level topology

```
┌──────────────┐                                ┌──────────────────────────┐
│  iPhone or   │   wss:// (PCM16 frames +       │  OpenAI Realtime GA      │
│  Browser     │◀──events, UTF-8 JSON)─────────▶│  wss://api.openai.com/   │
│              │                                │  v1/realtime             │
│  status +    │                                │  model: gpt-realtime     │
│  bar viz     │                                └──────────────────────────┘
└──────┬───────┘                                          ▲
       │ wss://                                            │
       ▼                                                   │
┌──────────────────────────────────────────────────────────┴───────────┐
│                  Jarvis Server  (Node 20 LTS / TypeScript)            │
│                                                                       │
│  ┌───────────────┐    ┌──────────────────────────────────────────┐    │
│  │  Session Mgr  │    │  Tool Dispatcher                          │    │
│  │  per-user     │───▶│  wttr_get | github_list_prs |             │    │
│  │  isolation    │    │  github_list_issues | github_get_pr_..   │    │
│  │  + memory ctx │    │  github_list_recent_merges |              │    │
│  └───────┬───────┘    │  github_open_pr_for_issue | memory_write  │    │
│          │            └──────────────────┬───────────────────────┘    │
│          ▼                               │                            │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │       OpenAI Realtime Proxy Layer  (proxy.ts)                  │   │
│  │   • forwards audio frames both ways                            │   │
│  │   • injects tool results as conversation.item.create           │   │
│  │   • relays speech_started → response.cancel for barge-in       │   │
│  │   • filters project-namespaced events (lesson F1/Y1)           │   │
│  └────────────────────────────────────────────────────────────────┘   │
└───────────┬─────────────────────────────────────────────────────┬─────┘
            │                                                     │
            ▼                                                     ▼
   ┌──────────────────┐                              ┌─────────────────────┐
   │ Persistence Layer│                              │ External Tools       │
   │ SQLite WAL       │                              │  • wttr.in (j1 JSON) │
   │ jarvis.db        │                              │  • GitHub REST v3    │
   │  users           │                              │    (Octokit)         │
   │  preferences     │                              └─────────────────────┘
   │  turns           │
   │  memory_summaries│
   └──────────────────┘
```

---

## 2. Per-component breakdown

### 2.1 OpenAI Realtime Proxy Layer (`src/proxy.ts`)

- **Responsibility.** Maintain one upstream WebSocket per client session to `wss://api.openai.com/v1/realtime` with model `gpt-realtime`. Forward client PCM16 frames upstream as UTF-8-coerced strings (lesson F6). Forward upstream audio deltas downstream. Translate event names where the client cares (`response.output_audio.delta` → `response.audio.delta`). Inject tool-call results.
- **Inputs.** Client WebSocket frames; Tool Dispatcher tool results.
- **Outputs.** Upstream-bound audio + control events; downstream-bound audio deltas + tool-call events.
- **Persistence.** None. Stateless relay; session state lives in the Realtime API session itself.
- **Failure modes.**
  - Upstream WebSocket closes → reconnect once with 500 millisecond backoff, then audibly notify user ("Reconnecting, one moment."), then close client session if second attempt fails. Error message must include the upstream close code and reason so debugging is one log line away.
  - Upstream rejects binary frame → coerce to UTF-8 string before forwarding (mandatory, not optional).
  - Upstream emits `error.beta_api_shape_disabled` → throw `BetaApiDeprecatedError` with a clear "model name must be `gpt-realtime`, header `OpenAI-Beta` must be absent" message.

### 2.2 Session Manager (`src/session.ts`)

- **Responsibility.** On client connect, read `X-User-Id` header. If absent, generate a new UUID v4 and send it back to the client to persist locally. Look up or insert the user record. Load the rolling memory summary plus the last 20 turns. Build the system prompt:
  1. Identity ("You are Jarvis…")
  2. Capability list (rendered from the LIVE Tool Dispatcher registry, satisfying US-05)
  3. Memory digest (latest summary + last 20 turn highlights)
  4. Preferences ("Never mention X.", "Always flag Y.")
  5. Language directive ("Always respond in English.", lesson F5)
  6. Hallucination guard ("If you cannot ground a factual claim in a tool response or this prompt, say 'I don't know.'")
- **Inputs.** Client handshake; Persistence Layer.
- **Outputs.** Configured Realtime session via `session.update`; user context object handed to the Tool Dispatcher.
- **Persistence.** Reads `users`, `preferences`, `turns`, `memory_summaries`. Writes new user rows.
- **Failure modes.**
  - DB unreachable → proceed without memory, log structured error `{event: "session.memory_unavailable", user_id, cause}`. Agent's system prompt notes "Memory is offline for this session."
  - Memory summary stale (> 24 hours) → trigger background re-summarisation, do not block the session open.

### 2.3 Tool Dispatcher (`src/tools/dispatcher.ts`)

- **Responsibility.** Receive `response.function_call` events from the Realtime proxy. Route to the registered handler by `name`. Validate arguments against a `zod` schema. Call the handler. Return the JSON result string as a `conversation.item.create` followed by `response.create`. On every tool call exceeding 1 second, emit a "filler" audio cue upstream (satisfying US-02).
- **Inputs.** Function name + JSON arguments from the model; user context from Session Manager.
- **Outputs.** JSON result fed back into the Realtime session.
- **Persistence.** None directly; `memory_write` delegates to Persistence Layer.
- **Failure modes.**
  - Unknown tool name → return `{"error": "tool_not_found", "tool": name}`. System prompt instructs the model to apologize honestly.
  - Validation failure → return `{"error": "tool_args_invalid", "issues": [...]}`. Error message names the offending field.
  - Handler throw → wrap with `cause: e`, return `{"error": "tool_failed", "tool": name, "message": "<generic user-facing>"}`. Full exception logged server-side; never forwarded to the model.

### 2.4 Weather Tool (`src/tools/weather.ts`)

- **Responsibility.** Fetch current weather from `${WTTR_BASE_URL}/{location}?format=j1`, parse, return a terse JSON `{location, condition, temp_f, feels_like_f, humidity, wind_mph, fetched_at_iso}`.
- **Inputs.** `location: string`.
- **Outputs.** Above JSON shape.
- **Persistence.** In-memory 60-second cache keyed by lowercased location. Cache entries carry `fetched_at_iso` so consumers can verify freshness (satisfies the "no reused-as-fresh data" rule).
- **Failure modes.** 5xx or timeout → `{"error": "weather_service_unavailable", "location": location}`. Agent says "I couldn't reach the weather service right now."

### 2.5 GitHub Tool (`src/tools/github.ts`)

- **Responsibility.** Wraps `@octokit/rest` authenticated by `GITHUB_TOKEN`. Five handlers:
  - `github_list_prs(owner, repo, state="open", limit=5)`
  - `github_list_issues(owner, repo, state="open", limit=5)`
  - `github_get_pr_comments(owner, repo, pull_number, limit=10)`
  - `github_list_recent_merges(owner, repo, limit=5)`
  - `github_open_pr_for_issue(owner, repo, issue_number)` — bonus US-12. Generates patch via the model with the issue body as context, creates `jarvis/fix-<issue_number>-<short-sha>` branch, commits, opens pull request, returns URL.
- **Inputs.** Owner + repo + tool-specific args.
- **Outputs.** Structured JSON. Each item carries the canonical GitHub URL so the agent can read URLs aloud when asked.
- **Persistence.** None (GitHub is the system of record).
- **Failure modes.**
  - 401 → `{"error": "github_auth_failed", "hint": "GITHUB_TOKEN missing or expired"}`. Loud server log.
  - 403 rate limit → `{"error": "github_rate_limited", "reset_at_iso": <timestamp>}`. Agent speaks the reset time.
  - 404 → `{"error": "github_not_found", "owner": owner, "repo": repo}`. Agent says the repository is not accessible.

### 2.6 Persistence Layer (`src/db.ts`)

- **Responsibility.** SQLite via `better-sqlite3`, WAL mode. Tables:
  - `users(id TEXT PRIMARY KEY, created_at TEXT)`
  - `preferences(user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key))`
  - `turns(id INTEGER PRIMARY KEY, user_id TEXT, role TEXT, content TEXT, ts TEXT)`
  - `memory_summaries(user_id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT)`
- **Inputs.** Completed conversation turns; model-requested `memory_write` calls; preference upserts.
- **Outputs.** Memory digest string at session open; preference map.
- **Persistence.** SQLite file at `JARVIS_DB_PATH` (default `./data/jarvis.db`).
- **Failure modes.**
  - Write error → structured log `{event: "db.write_failed", table, cause}`; turn is dropped from memory but the session continues (memory is best-effort for MVP).
  - DB file missing on startup → create schema via Doctrine-style migration script in `src/db/migrations/`.

### 2.7 Web Frontend (`web/` — Vite + plain TypeScript)

- **Responsibility.** Capture microphone via `getUserMedia`, encode to PCM16 24 kHz mono, stream over WebSocket to the server. Receive audio frames, decode, play via Web Audio API. Render status indicator + 32-bar audio-reactive footer driven by `AnalyserNode` (lesson F8 baseline).
- **Inputs.** Microphone; server WebSocket.
- **Outputs.** Speaker; on-screen status + bars.
- **Persistence.** `localStorage` for `userId` (so the same browser sees the same memory across reloads).
- **Failure modes.** Mic permission denied → modal explaining; WebSocket disconnect → red status indicator + auto-retry with 1 second backoff up to 3 attempts.

### 2.8 iOS Client (`ios/Jarvis/`, Slice 9 — bonus)

- **Responsibility.** Thin Swift / SwiftUI client. `AVAudioEngine` mic capture, WebSocket via `URLSessionWebSocketTask`, `AVAudioPlayerNode` for playback, status indicator, audio-reactive visualizer.
- **Inputs.** Microphone; server WebSocket.
- **Outputs.** Speaker; SwiftUI state.
- **Persistence.** `Keychain` for `userId`; `UserDefaults` for server URL override.
- **Failure modes.** Same as web client; passive mode (US-10) handled by a wake-word check on the client side before forwarding audio.

---

## 3. Primary data flow: "What's the weather in Austin?"

1. Browser captures microphone audio. `MediaRecorder` → PCM16 frames → WebSocket text frames (base64-encoded delta payloads inside `input_audio_buffer.append` events).
2. `proxy.ts` receives the WebSocket frame. Forwards UTF-8 string upstream to OpenAI Realtime. (NOT binary — lesson F6.)
3. OpenAI Realtime detects intent, emits `response.function_call` `{name: "wttr_get", arguments: "{\"location\":\"Austin\"}"}`.
4. `proxy.ts` routes the event to `tools/dispatcher.ts`.
5. Dispatcher emits a filler audio cue ("Looking up the weather.") upstream via `conversation.item.create` because the tool will take more than 1 second. (US-02.)
6. Dispatcher calls `tools/weather.ts → wttr_get("Austin")`. Tool checks 60-second cache. On miss, calls `https://wttr.in/Austin?format=j1`. Parses. Caches. Returns `{location:"Austin", condition:"Partly cloudy", temp_f:78, ...}`.
7. Dispatcher feeds result back as `conversation.item.create` + `response.create` to OpenAI.
8. OpenAI synthesises speech ("It's seventy-eight degrees and partly cloudy in Austin right now."), streams `response.audio.delta` events.
9. `proxy.ts` translates `response.output_audio.delta` → `response.audio.delta` and forwards to browser.
10. Browser decodes PCM16, plays via `AudioWorklet`, drives the bar visualizer with `AnalyserNode`.
11. After `response.done`, Session Manager persists the turn to `turns` table. Background job summarises if turn count crossed a threshold.

Total perceived latency budget (US-01 target): less than 1.5 seconds from end-of-user-speech to first agent audio frame.

---

## 4. Decisions table

This is the single source for the architecture website's decision panel and for the AI Interview Prep doc's "decisions table" anchor.

| Decision | What I chose | Alternative considered | Why |
|---|---|---|---|
| Voice stack | OpenAI Realtime GA (`gpt-realtime`) over one bidirectional WebSocket | Chained Whisper Speech-to-Text → GPT-4o text → ElevenLabs Text-to-Speech | Single provider eliminates inter-service hops (each hop is 400 to 900 milliseconds); native server-side VAD; native barge-in; no audio re-encoding. PRD requires near-zero latency. |
| Realtime API version | GA (`gpt-realtime`) | Beta (`gpt-4o-realtime-preview`) | Beta was deprecated 2026-05-12. Prior build's mid-demo migration is the cautionary tale. |
| Backend language | TypeScript on Node 20 LTS | Python with FastAPI, Go with `gorilla/websocket` | TypeScript has the most mature WebSocket + OpenAI SDK story; user productivity is highest in TypeScript at this scale; type system catches the shape-error class of Realtime API bugs at compile time. |
| Realtime data feed | `wttr.in` (no auth) | OpenWeatherMap, Tomorrow.io | Zero credential overhead, deterministic JSON schema, fast enough. Behind a one-function abstraction so the swap is one file when SLA matters. |
| Persistence | SQLite WAL (Slices 1 to 11), Postgres swap at concurrency > 8 | Postgres from day one, Redis, Firestore | SQLite is zero-infrastructure for MVP scale and durable across restart (the in-memory `Map` is the explicit anti-pattern). The Session Manager + Persistence Layer are the only two files that change in the Postgres swap. |
| Mobile platform | SwiftUI iOS (Slice 9) | Kotlin/Android, React Native | User's preferred language is Swift; PRD bonus #1 allows either; web-first proves the loop before adding native complexity. |
| Hallucination guard | System-prompt constraint + tool-only data paths + property-test verification | Fine-tuning, retrieval-scoring | The Realtime GA endpoint does not expose token-level log probabilities; post-hoc filtering is not available. Constraining the model to tool outputs is the only available lever. Vouch's property test on 20 known-unanswerable prompts is the verification gate. |
| Agentic pull-request flow (US-12) | Server-side Node, GitHub REST via Octokit, branch + commit + open pull request | GitHub Copilot API, `gh` CLI subprocess | REST is synchronous and auditable; server-side keeps the GitHub token off the client; no subprocess injection risk. |
| Authentication | `X-User-Id` UUID v4 header | OAuth, Firebase Auth, magic links | MVP timeline. Header UUID gives per-user memory isolation. OAuth can replace it in the scalability hardening slice if Frontier Audio asks. |
| Deployment | Render.com | Vercel | PRD forbids Vercel without justification (and Vercel serverless cannot host long-lived WebSocket servers anyway). Render supports persistent WebSockets and long-lived Node processes. |
| Repo flow | GitHub `scott-lydon/jarvis` PRIVATE + GitLab `scottlydon/jarvis` mirror via dual-push origin trick | Single GitHub remote | Gauntlet evaluators grade off the GitLab mirror; the dual-push trick keeps both in sync from a single `git push origin <branch>`. (See `~/Documents/Claude/Projects/Gauntlet/CLAUDE.md` "Gauntlet gitflow".) |

---

## 5. Trade-offs

Each trade-off is a decision we accept WITH a stated trigger that would revisit it.

**OpenAI Realtime lock-in.** The whole voice loop depends on one provider's WebSocket API. If OpenAI changes pricing or degrades the endpoint, no drop-in replacement exists. *Mitigation:* `proxy.ts` is the only layer that knows about OpenAI; swapping providers (e.g., to a future Anthropic Realtime endpoint) touches one file. *Revisit trigger:* OpenAI raises Realtime pricing more than 50% OR an alternative provider ships with parity barge-in.

**SQLite concurrency ceiling.** WAL mode handles ~10 concurrent writers safely. US-11 wants 10+. *Mitigation:* Postgres swap path is documented; touches only `db.ts` and `session.ts`. *Revisit trigger:* the load test in US-11 hits sustained > 8 concurrent sessions OR p99 write latency crosses 100 milliseconds.

**`wttr.in` reliability.** Unofficial volunteer service, no SLA. *Mitigation:* `tools/weather.ts` is a single abstraction. *Revisit trigger:* `wttr.in` 5xx rate > 1% over a 24-hour window in production, OR Frontier Audio asks for a contracted feed.

**Memory summarisation lag.** Summaries are generated off the hot path by the LLM. If the summarisation call fails, the user loses cross-session recall for that turn set. *Mitigation:* raw turns are always persisted; summaries can be regenerated on demand. *Revisit trigger:* user-reported "Jarvis forgot what we discussed" exceeds 1% of returning sessions.

**No OAuth in MVP.** A header UUID is trivially spoofable. *Mitigation:* PRD's "data isolation per user" requirement is satisfied at the application layer; spoofing is a server-trust issue, not a memory-isolation issue. *Revisit trigger:* Frontier Audio asks for production deployment or any external user can reach the server.

---

## 6. Security posture

(Anchors the Security pillar in `docs/AI_INTERVIEW_PREP.md`.)

- **Token surface.** `OPENAI_API_KEY` and `GITHUB_TOKEN` live in environment variables only. `.env` is `.gitignore`'d. `.env.example` is committed with empty values. The client never receives any secret; the proxy holds them server-side.
- **No secret in logs.** Logging middleware redacts any value matching the `sk-…` (OpenAI) or `ghp_…` / `github_pat_…` (GitHub) patterns before any structured log fires.
- **Repo private.** Verified by a `slice-0` smoke test that hits `GET /repos/scott-lydon/jarvis` and asserts `private: true`.
- **Tool dispatcher input validation.** Every tool argument is parsed by a `zod` schema. Malformed input returns a structured error, never throws into the WebSocket relay.
- **Per-user data isolation.** Every database query is parameterised by `user_id`. A Vouch property test feeds 10 concurrent sessions and asserts that no row from user A surfaces in user B's memory digest.
- **PRD-mandated repo privacy gate.** Submission slice (13) refuses to email the zip if the GitHub API reports `private: false`.

---

## 7. Slicing sequence

The implementing agent picks slices off `tasks.md` in this order. Each slice is small enough for one Vouch run.

| Slice | Deliverable | Done-when |
|---|---|---|
| 0 | Repo scaffold; GitHub + GitLab dual-push; `.env.example`; `package.json`; ESLint + tsc; SQLite migration runner; `wttr.in` smoke test | `npm test` green; `git push origin main` lands on both remotes; `wttr.in/Austin` returns parsed JSON in test |
| 1 | OpenAI Realtime Proxy: WebSocket relay, audio round-trip, no tools | Browser microphone audio echoes back as `gpt-realtime` voice |
| 2 | Session Manager: user ID extraction, system prompt injection, capability list | Agent answers "What can you do?" correctly (US-05) |
| 3 | Weather Tool end-to-end | "What's the weather in Austin?" returns real data spoken aloud (US-08) |
| 4 | Persistence Layer: turns + memory digest | "Yesterday I asked about X" recall works across a full process restart (US-03) |
| 5 | GitHub Tool: read (pull requests, issues, comments, recent merges) | "List open pull requests on `openemr/openemr`" returns real list (US-07) |
| 6 | Barge-in / interruption handling | "Quiet, Jarvis" mid-response stops playback in under 200 milliseconds (US-04) |
| 7 | Filler-on-slow-tool (US-02) and zero-hallucination guard verification (US-06) | Audible filler emitted on every >1-second tool call; property test on 20 unanswerable prompts passes |
| 8 | User preferences and self-awareness polish | "Never mention X" persists across sessions; capability list is rendered live |
| 9 | Web frontend (Vite, audio-reactive bars, status indicator) | One continuous demo take through the page reaches `window.__demoReady` |
| 10 | SwiftUI iOS client | Native app connects, voice loop works on device (US-09) |
| 11 | GitHub agentic flow: open pull request to fix issue (US-12) | A real pull request appears on `https://github.com/scott-lydon/jarvis-fixture/pulls` |
| 12 | Scalability hardening: 10 concurrent users load test (US-11) | `tests/load/concurrent-users.test.ts` passes with isolation assertions |
| 13 | Demo video + zip + dual submission (PRD code-quality expectations) | Email to `wduffy@…` and `pmoeckel@…` confirmed; Gauntlet portal submission confirmed |
