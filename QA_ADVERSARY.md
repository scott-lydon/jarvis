# Jarvis — Vouch Adversary Brief

This is the project-specific override on the global Vouch sub-agent prompt at `~/.claude/agents/vouch.md`. When Vouch runs in a fresh context, it reads THIS file first and treats it as the authoritative project anchor. If this file is the verbatim `qa-pipeline-kit` template, Vouch silently runs the generic playbook — which is exactly the failure mode that bit Meridian on 2026-05-21. Populated; not a placeholder.

---

## 1. Project at a glance

- **Repo:** `git@github.com:scott-lydon/jarvis.git` (private) + GitLab mirror `git@labs.gauntletai.com:scottlydon/jarvis.git` via dual-push.
- **Stack:** TypeScript 5.5, Node 20 LTS, `ws`, `@octokit/rest`, `better-sqlite3`, `zod`, Vitest 2, ESLint with `@typescript-eslint/strict-type-checked`, plain HTML/TS frontend with Vite, SwiftUI iOS (Slice 9+).
- **Primary domains:** WebSocket relay to OpenAI Realtime GA, tool-call dispatch (weather + GitHub + memory), per-user SQLite memory, audio round-trip.
- **What it does:** Hands-free voice assistant for frontline workers — grounded in real tool data, zero hallucinations, interruptible, cross-session memory.

---

## 2. Base branch + diff range

- Base branch: `main`.
- Working branch convention: `slice-<NN>-<short-noun>` (for example `slice-03-weather-tool`).
- Default Vouch diff: `git diff origin/main...HEAD` on the working branch.
- For ad-hoc audits, pass an explicit range: `git diff <baseline>..HEAD`.

---

## 3. Test runner commands (canonical)

Run all of these from the repo root:

```bash
# Unit + integration (Vitest)
npm test

# Lint (ESLint, must be zero errors)
npm run lint

# Type-check (must be zero errors)
npm run typecheck

# Property tests (US-06 zero-hallucination, US-11 isolation)
npm run test:property

# Load test (US-11)
npm run test:load

# Live smoke test against deployed server
npm run smoke:deployed
```

A passing Vouch run requires all six to exit zero against the diff under review.

---

## 4. Harness file paths (where the tests live)

- `tests/unit/` — pure unit tests, one file per source module.
- `tests/integration/` — Vitest integration tests with the SQLite file (uses a temp file per test).
- `tests/property/zero-hallucination.test.ts` — 20 known-unanswerable prompts. Assertion: response must contain none of the prompt's named entities NOT also present in any tool response, and must match the "no-fabrication" template.
- `tests/property/user-isolation.test.ts` — 10 simulated concurrent users. Assertion: user `A`'s `memory_summaries` row never appears in user `B`'s system prompt; `preferences` queries are parameterised by `user_id`.
- `tests/load/concurrent-users.test.ts` — opens 10 client WebSockets, runs interleaved conversations, asserts no cross-contamination and p99 first-audio latency under 1.5 seconds.
- `tests/smoke/` — hits live external endpoints. `wttr.test.ts` against the real `wttr.in`. `openai-realtime.test.ts` against a real `gpt-realtime` session (uses a rate-limited test key).
- `tests/contract/` — OpenAI Realtime event-shape contract tests; pinned to GA event names (`response.output_audio.delta`, NOT `response.audio.delta` upstream).

---

## 5. Named bug categories (Vouch's attack surface)

Vouch attacks the diff with these categories in priority order. The category names appear verbatim in the Adversary Report so I can grep across runs.

### J-CAT-1 — Realtime API regression
The single highest-risk failure mode (the prior build shipped on the deprecated Beta endpoint). Vouch verifies:
- Model name in `proxy.ts` is `gpt-realtime`, NOT `gpt-4o-realtime-preview`.
- No `OpenAI-Beta: realtime=v1` header anywhere.
- `session.update` payload nests `audio.input.format` and `audio.output.format` fully with explicit `rate: 24000`.
- Upstream forwarder filters project-namespaced events (matches `jarvis.*`) — lesson Y1.

### J-CAT-2 — Binary frame forwarding
Per lesson F6: `clientWs.on('message')` MUST coerce Buffer to UTF-8 string before forwarding. Vouch greps `proxy.ts` for any direct Buffer forwarding and runs a Vitest test that feeds a Buffer and asserts the upstream payload is a string.

### J-CAT-3 — Catch-log-continue
Forbidden pattern (constitution §3). Vouch greps for `catch ` blocks whose body contains a logger call AND a `continue` / no rethrow / no structured-error return. Each finding is a blocker.

### J-CAT-4 — In-memory state masquerading as durable
US-03 requires durability across process restart. Vouch greps for `new Map(` in `src/session.ts`, `src/db.ts`, `src/tools/*` and verifies any such map is a cache (with a `cache_only` comment), not the source of truth.

### J-CAT-5 — Token leak
Logging middleware must redact `sk-…` (OpenAI) and `ghp_…` / `github_pat_…` (GitHub) patterns. Vouch runs a synthetic request that injects a fake `sk-test-redact-me` and asserts the structured log substitutes `<REDACTED>`.

### J-CAT-6 — Per-user isolation leak
Every SQL query touching `users`, `preferences`, `turns`, `memory_summaries` MUST parameterise by `user_id`. Vouch greps for `FROM (preferences|turns|memory_summaries)` and verifies a `WHERE user_id` (or `JOIN ... ON user_id`) clause appears in the same query.

### J-CAT-7 — Filler-on-slow-tool missing (US-02)
For any tool handler in `src/tools/*`, Vouch verifies the dispatcher emits a filler audio cue if the call exceeds 1 second. Vouch runs a fake handler that sleeps 1.5 seconds and asserts a `conversation.item.create` with a filler payload appears in the upstream forwarder.

### J-CAT-8 — Hallucination smoke (US-06)
The property test `tests/property/zero-hallucination.test.ts` runs as part of every Vouch invocation. Any failure is a blocker.

### J-CAT-9 — Frontend overlay scroll trap
Per global rule "Scroll overflow on lengthy modal / popup / drawer / overlay content". Vouch greps `web/` and `ios/Jarvis/` for any element using `position: fixed`, `position: absolute`, `role="dialog"`, `role="menu"`, hand-rolled overlay positioning, or SwiftUI `.fullScreenCover` / `.sheet` / `.popover` / `.alert`, and verifies bounded-height + scroll-affordance + sticky close path.

### J-CAT-10 — Stub / mock data in a production path
HARD RULE. Vouch greps production paths for `mock`, `stub`, `fixture`, `dummy`, `placeholder`, `fake`, `sample`. Any hit outside `*.test.ts` / `*.spec.ts` / `tests/**` is a blocker.

### J-CAT-11 — Fixed output filename (lesson F1)
For any code that writes audio or video captures, Vouch verifies the filename includes a UTC-microsecond stamp (the `new_unique_video_path` pattern). A fixed `output.mp4` or `agent-reply.mp3` is a blocker.

### J-CAT-12 — Missing error specificity
Constitution §3 requires every place that could throw to surface a clear, comprehensive, specific error. Vouch greps for generic `throw new Error('failed')`, `throw new Error('error')`, `Error('oops')` and similar non-diagnostic strings; flags each.

---

## 6. Hot files (touched in recent commits — extra attention)

Vouch refreshes this list each run via `git diff --name-only HEAD~15..HEAD`. Pre-Slice-0 seed:

- `src/proxy.ts` — Realtime relay; J-CAT-1, J-CAT-2 magnets.
- `src/session.ts` — Session Manager, system prompt assembly; J-CAT-4, J-CAT-6.
- `src/tools/dispatcher.ts` — tool call routing; J-CAT-3, J-CAT-7, J-CAT-12.
- `src/tools/github.ts` — Octokit wrapper; J-CAT-5.
- `src/tools/weather.ts` — wttr.in client; freshness annotation per the "no reused-as-fresh" rule.
- `src/db.ts` and `src/db/migrations/*.sql` — Persistence Layer; J-CAT-4, J-CAT-6.
- `web/main.ts` and `web/index.html` — audio capture, playback, visualizer; J-CAT-9.

---

## 7. Convention for failing tests

When Vouch surfaces a bug, it writes a FAILING Vitest in the matching `tests/` subtree, not a patch. The test:

- Reproduces the bug deterministically (seeded RNG, fixed clock via injectable `ClockInterface`, fixed temp DB path).
- Uses the J-CAT category in its `describe(…)` title (e.g. `describe('J-CAT-1 Realtime API regression', …)`).
- Asserts the expected post-fix behavior, so it stays as a regression test after the fix lands.

---

## 8. Ignored paths

Vouch skips:

- `node_modules/`
- `dist/` and `build/`
- `coverage/` and `.nyc_output/`
- `.conveyor/voice-cache/`, `.conveyor/capture-cache/`, `.conveyor/*.mp4`, `.conveyor/*.mp3`, `.conveyor/*.webm`
- `data/*.db`, `data/*.db-wal`, `data/*.db-shm`
- `*.lock`, `package-lock.json`
- `docs/AI_INTERVIEW_PREP.md`, `docs/DEFENSE_BREAKOUT_SCRIPT.md`, `website/index.html` (these are docs, not code; the spec / plan / tasks / constitution are the authoritative inputs)

---

## 9. End-to-end Vouch pipeline command

```bash
cd /Users/scottlydon/Desktop/Clutter/iOS/jarvis && \
  git fetch origin && \
  npm ci && \
  npm run lint && \
  npm run typecheck && \
  npm test && \
  npm run test:property && \
  npm run smoke:wttr && \
  npm run smoke:openai && \
  ./scripts/vouch-grep-attacks.sh   # runs J-CAT-1..J-CAT-12 grep checks
```

Vouch report lands in `RUN_REPORT.md` at the repo root (per `~/.claude/agents/vouch.md` convention). The report's verdict is one of `PASS`, `FAIL`, or `INCONCLUSIVE`; only `PASS` clears the gate.

---

## 10. Where Vouch writes its report

`/Users/scottlydon/Desktop/Clutter/iOS/jarvis/RUN_REPORT.md` (overwritten each run; the prior run's artifact moves to `.vouch-history/<UTC-microsecond>.md` for audit).

---

## 11. Non-negotiables Vouch enforces verbatim from `constitution.md`

- TypeScript strict; no `any` without inline reason; no `@ts-ignore`.
- ESLint zero errors.
- No catch-log-continue.
- No in-memory `Map` as durable store.
- No `gpt-4o-realtime-preview` model name (only `gpt-realtime`).
- No binary frame forwarding upstream.
- No mocks / fixtures in production paths.
- No fixed output filenames for audio/video captures.
- No secret-pattern strings appearing un-redacted in any log line.
- No frontend overlay without bounded-height + scroll-affordance + sticky close path.
- Always-respond-in-English directive present in `buildSystemPrompt()`.
