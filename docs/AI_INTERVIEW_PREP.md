# AI Interview Prep — Jarvis

[AI video interview portal](https://portal.gauntletai.com/video-interview)
([mirror](https://gauntlet-portal.web.app/video-interview))

The AI interview asks four questions in five minutes. You don't know which
four. Below is a broad bench of prepared answers so any reasonable Q lands
on one you've already rehearsed. Each block is ~150 words and reads ~60
seconds. Substance first. No meta about format. Spell out an acronym only
once per block.

## 60-second elevator pitch

Jarvis is a voice-first assistant for frontline workers. Pick it up like a
walkie-talkie, ask a question, get a real-time spoken answer grounded in
live tools. Two things make it work. First, a server-side proxy in front
of OpenAI Realtime GA. The proxy enforces the GA endpoint shape, mediates
function calls, and keeps `jarvis.*` events local so the upstream model
never sees them. Second, a tight tool surface that always returns
structured results, never throws, and ships a "say I don't know"
hallucination guard inside the system prompt. Memory is per-user SQLite
with WAL. Every assistant turn fires a rolling gpt-4o-mini summary so a
session that drops mid-conversation resumes where it left off. Web and
iOS clients both talk the same PCM16 24 kHz protocol. Trade-off: SQLite
single-writer caps us at a few hundred concurrent users per node before
a Turso migration becomes the next step.

## Always-asked: walk me through the data flow

A user taps the mic button on the web client. `getUserMedia` grants
permission, the page opens a 24 kHz AudioContext, and a pcm-recorder
worklet emits 50 ms chunks of Int16 PCM. Those chunks become base64
strings inside `input_audio_buffer.append` events sent over the
`/realtime` WebSocket to my Node proxy. The proxy forwards them upstream
to `wss://api.openai.com/v1/realtime?model=gpt-realtime` with no
`OpenAI-Beta` header — that header silently breaks GA audio. When the
model answers, it sends `response.output_audio.delta` upstream; the
proxy renames it to `response.audio.delta` so the client sees the
stable name. The client decodes base64 back to Int16, then to Float32,
and queues into a pcm-player worklet. If the model calls a function, the
proxy collects the streamed arguments, dispatches the tool, and posts
`function_call_output` back upstream so the model can speak the result.

## Always-asked: what would you do differently with more time

Two things. First, swap SQLite for Turso once the single-writer
bottleneck shows up. The data layer is already user-scoped, and
`better-sqlite3` and `libsql` speak the same surface, so the migration
is a connection-string change plus a load test. Second, add a
deployed-UI red-team agent. Right now the QA agent runs against the
diff in a fresh context, which is great for catching new-code bugs.
A separate agent driving Playwright against the live web client would
catch the gap between "the diff is fine" and "the deployed page is
broken." I'd also push the iOS client a bit further: AirPods H2 echo
cancellation needs a hardware soak, and the current capture path
relies on `voiceChat` mode which masks worse hardware. With more time
I'd capture raw mic input and run a smaller echo-cancel pass myself.

## Always-asked: what was challenging

The OpenAI Realtime GA migration. The Beta and GA endpoints look identical
from the outside but diverge in subtle places. Mixing the `OpenAI-Beta`
header with GA produces audio that plays back but at the wrong rate. The
`session.update` payload uses a fully nested `audio.input.format` shape;
the flat `audio_input` form silently fails. The upstream audio delta event
got renamed from `response.audio.delta` to `response.output_audio.delta`,
so every web client that wasn't updated had silent playback. I solved it
by writing the rules down inside `src/proxy.ts` as named lessons (Y, Y1,
Y2, F5, F6) and asserting the prompt-level contract in a property test
so a future refactor can't quietly unwire any of them.

## Pillar — Architecture

The boundary I'm proudest of is the Tool Dispatcher. Every model function
call goes through one seam: `dispatch(name, rawArgs, ctx)`. The seam
zod-validates the args, gates by `available(env)`, runs the handler, and
wraps thrown errors as one of `tool_not_found`, `tool_args_invalid`,
`tool_disabled`, or `tool_failed`. No tool handler ever speaks to
OpenAI directly. No tool handler swallows an error. That means the
"no hallucination" contract has a single enforcement point: if a tool
fails, the model sees a JSON object with `error: "..."`, and the
prompt instructs it to say so honestly. The capability list the model
sees at session start is rendered live from the same dispatcher, so
adding a tool to the registry automatically updates "what can you do?"
without a prompt edit. See `src/tools/dispatcher.ts:109-187`.

## Pillar — Scalability

The per-turn write path is a single SQLite INSERT in WAL mode under a
parameterised `user_id`. At Render's Starter plan I measured ten
concurrent WebSocket clients with distinct user IDs reaching
`jarvis.session_ready` and exchanging events without crashing the
proxy or leaking memory between users; the load test lives at
`tests/load/concurrent-users.test.ts`. The next scaling step is
horizontal: each node owns its own SQLite, and a future Turso swap
moves the writes to a single replicated store. The Realtime upstream
is one WebSocket per user, which is the OpenAI billable unit, so
scaling cost is roughly linear in active mic time, not in active
sessions. The rolling summarizer is the only non-linear cost; gating
it to a 20-turn threshold caps `gpt-4o-mini` spend at about one call
per ten minutes per active user.

## Pillar — Security

`OPENAI_API_KEY` and `GITHUB_TOKEN` live server-side only and never
appear in any client payload. The structured logger redacts `sk-*`,
`sk-proj-*`, `ghp_*`, and `github_pat_*` from every log line so a
test screenshot can't leak them either. Per-user isolation is a
data-layer invariant, not a runtime check: every `SELECT` and every
`UPDATE` has a `WHERE user_id = @user_id` clause. The load test
asserts ten distinct users cannot see one another's preferences or
turns. The iOS client stores its `userId` in Keychain under
`com.frontieraudio.jarvis` with `kSecAttrAccessibleAfterFirstUnlock`,
so a stolen phone with a known passcode is the threshold for access.
ATS exceptions are scoped to `localhost` and `127.0.0.1` only;
production traffic is HTTPS to the Render deploy.

## Pillar — Testing

Three layers. Unit tests for pure functions like the dispatcher, the
session-prompt builder, and the database wrapper, each running against
real fixtures (no mocks; the DB tests open real tmp files). Integration
tests for the proxy seam — a fake upstream WebSocket lets me measure
`jarvis.barge_in` to `response.cancel` latency at the network shape,
which I assert is under 300 milliseconds. Property tests for the
hallucination guard — twenty representative un-groundable prompt
categories each assert the system prompt carries the "say I don't
know" directive and names the only legitimate grounding sources. Load
tests for ten concurrent users on the same proxy and SQLite handle.
And the agentic GitHub flow is verified live against a fixture repo;
running `npm run smoke:slice11` opens a real draft pull request and
asserts the response shape.

## Anticipated follow-ups

**"What happens if the SQLite file disappears mid-session?"**
The server detects the missing DB on open, runs migrations to recreate
it, and re-opens. For a session already in flight, the `db` handle in
`src/index.ts` is kept; new turns will fail to persist, the proxy
flips the user context to `memoryAvailable: false`, and the prompt
says memory is offline. Cross-session recall is gone for that user
until the next reconnect; the voice loop itself continues.

**"You say zero-hallucination, but the model can still ignore your prompt. How is that zero?"**
You're right that the prompt is necessary but not sufficient. That's why
Slice 8 also adds a deterministic post-call filter for flagged authors:
the model can forget the instruction, but the result payload still has
the flagged PR at index 0 with `flagged: true`. For the broader
hallucination case, the contract is "honest about what we can verify,"
not "never wrong." Tool errors are structured, tool absence is named in
the capability block, and the property test guarantees the directive
text cannot be silently weakened.

**"Why no echo cancellation if you're voice-first?"**
The web client relies on the browser's built-in `echoCancellation: true`
plus `noiseSuppression: true` in `getUserMedia`, which is what Chrome
and Safari ship out of the box. On iOS we lean on AVAudioSession's
`.voiceChat` mode for the same effect. Both are good enough for normal
headsets; AirPods H2 are noticeably better. A custom echo canceller is
on the roadmap for the bare-mic case (frontline workers wearing helmets).

## Backup bench

**"What does it cost to run?"**
At idle: roughly $7/month for the Render Starter plan plus the disk.
Per active minute: about $0.08 of OpenAI Realtime audio plus a few cents
of `gpt-4o-mini` when the summarizer triggers. A typical 5-minute
session costs around $0.40 of OpenAI usage.

**"How did you decide what tools to ship first?"**
Weather and GitHub. Weather is the dead-simple grounded-fact tool
(returns a number with a freshness timestamp), so it stresses the
"surface the timestamp" contract. GitHub is the agentic surface
(read issues, open PRs); the draft-PR opener is the proof that the
function-call flow can mutate the world, not just read from it.
Everything else (memory_write, preference_set) is bookkeeping that
exists because the cross-session memory story needs explicit user
control.

**"Walk me through the deployment."**
Single Render Web Service from `render.yaml`. Node 20, persistent 1 GB
disk mounted at `/data` for `jarvis.db`. Health probe is `/healthz`
which dumps the live capability list, so Render shows green only
when the tool surface is loaded. Secrets are configured in the Render
UI; the YAML lists them with `sync: false` so a Blueprint apply doesn't
prompt.

**"What's the single biggest risk in production?"**
A stale GitHub token. The Octokit handler returns
`github_auth_failed` and the model speaks that phrase honestly, so
the user sees the failure mode. But until the token is rotated, every
agentic call fails. The next step is a per-request token-health probe
on the `/healthz` path so the dashboard goes amber instead of green
when the token is about to expire.

**"How would you handle accessibility?"**
The visible UI is voice-first, so reduced-motion users get the same
experience as a typical user. The status pill and modal use ARIA
roles (`role="status"`, `role="dialog"`, `aria-live="polite"`,
`aria-modal="true"`). The mic button has `aria-pressed`. The
capability chip is `aria-live="polite"` so a screen reader hears the
tool surface come online. The modal close has `aria-label="Close"`.
Keyboard: Escape dismisses the modal. The next step is captions on
the assistant turns rendered live underneath the visualizer.

**"You mentioned the architecture website. Why ship that?"**
The audit trail. When a reviewer or a teammate asks "why SQLite,"
the website's decision table answers in one glance with the
alternative considered and the reason. The same content lives in
`ARCHITECTURE.md` for in-repo grep-ability and in the website for
the live demo audience. Both are updated in the same commit when
architecture changes, so they cannot drift.

## Escalation block

If a re-ask hammers on cost: quote the `render.yaml` plan line plus
the Realtime audio rate from the OpenAI pricing page. Show the math
inline. Cost is the question hardest to hand-wave on, so the answer
should be specific.

If a re-ask hammers on the per-user isolation claim: cite
`tests/load/concurrent-users.test.ts` by name and quote the assertion
that ten distinct users see only their own preferences. Then point at
the parameterised query in `src/db.ts:74-76`.

If a re-ask hammers on hallucination: cite the property test by name
(`tests/property/hallucination-guard.test.ts`) and acknowledge the
prompt is necessary but not sufficient. Slide to the
post-call-filter point for the preference case.

## Moment of truth

If asked "what did the model decide versus what did you decide" — the
model decided phrasing of the assistant turns and the order in which to
call tools. I decided the tool boundaries, the error surface, the
prompt structure (including the hallucination guard), the storage
schema, the deploy shape, and the no-mock-no-stub data policy. Commit
hashes for the architecture-shaping decisions:

- Tool Dispatcher seam: `549ace3` (initial), this commit (Slice 8 post-filter).
- Cross-session recall wired: this commit (`maybeRollSummary` in `src/index.ts`).
- Barge-in latency budget proven: this commit
  (`tests/integration/barge-in-latency.test.ts`).
- Live GitHub agentic flow proven: this commit
  (`tests/smoke/github-agentic.test.ts`) — PR `#2` on `jarvis-fixture`.

## Things to NOT say

- "The AI decided X." Say "I asked the model to X" or "the model
  produced X under this prompt."
- "I didn't really test that." Either you tested it (cite the file)
  or you didn't (own that, name the gap, say what would close it).
- "Reasonable people disagree." That's a hedge. State the trade-off.
- "It's just a placeholder." On the agentic flow, the PR is a real
  draft PR with a real placeholder note; "real but human-takeover-
  required" is more honest than "just a placeholder."
- "I would have done X if I had time." This is the always-asked
  question — answer with what you'd do, not with regret.
