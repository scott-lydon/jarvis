# Defense Breakout Script — Jarvis (~4:30 spoken)

[Pace yourself; aim ~4:30 with 30 s slack for an opening pause.]

Jarvis is a voice-first assistant for frontline workers. The use case is
a field technician on a job site who wants their hands on a tool, not a
phone screen. They press to talk, ask a question, hear an answer, and
hear it from a real source — a live weather tool, a GitHub query, their
own saved preferences. Not from training data the model is guessing at.

The system has three moving parts.

First, the proxy. One Node process, one WebSocket in, one WebSocket out
to OpenAI Realtime GA. The proxy enforces the GA endpoint shape —
no Beta header, fully nested audio format, renamed audio delta — so
the client and the upstream never see each other's surface. It also
filters anything whose event type starts with `jarvis.` so my
local-control events never reach the model.

Second, the tool surface. Five tools — weather, four GitHub queries,
and a memory writer — all routed through one Tool Dispatcher. Every
call is zod-validated, every failure is wrapped as a structured error
object the model speaks honestly. The capability list the model sees
is rendered live from the dispatcher, so asking "what can you do?"
returns ground truth, not a hard-coded paragraph.

Third, the memory. Per-user SQLite in WAL mode. Every assistant turn
is appended; every twenty turns, a small gpt-4o-mini call rewrites a
4-6 sentence rolling summary. When a user reconnects after a crash or
a flight, the new session's system prompt carries the summary plus
the last 20 turns. Cross-session recall isn't a clever trick — it's
just what falls out of writing the data and re-reading it on connect.

Then there are two clients. The web client is Vite plus an
AudioWorklet that downsamples to 24 kHz PCM16. The iOS client is
SwiftUI with AVAudioEngine plus an AVAudioConverter that does the
same downsampling. Both talk the same WebSocket protocol so the
server doesn't care which one is on the other end.

[~2:00 mark]

A few decisions worth calling out.

One: I chose SQLite, not Postgres. The reason is small-data — per-user
rows are a few kilobytes — and the test suite gets to run against real
files in tmp paths instead of mocking a Postgres connection. The cost
is single-writer; at a few hundred concurrent users per node I'll need
to move to Turso, which speaks the same SQL surface.

Two: I chose to enforce zero-hallucination at the prompt level AND with
a deterministic post-call filter. The prompt has a sentence that names
tools, this prompt, and user memory as the only legitimate grounding
sources. A property test asserts that sentence cannot be silently
weakened across twenty representative prompt categories. For the
"always flag PRs from this author" preference, I added a sorter inside
the GitHub list-PRs handler that bubbles flagged authors to the top
with a `flagged: true` marker. The model can forget the prompt; the
sorter can't.

Three: I shipped the agentic flow. The `github_open_pr_for_issue`
tool creates a branch, commits a placeholder note, and opens a draft
pull request. I verified it end-to-end against a fixture repo I
created for that purpose — `scott-lydon/jarvis-fixture` — and the
smoke test prints the PR URL on every run so the audit trail is
inline.

Four: I treated the architecture website and the AI interview prep
doc as deliverables, not afterthoughts. The architecture website
explains every component with a Mermaid diagram, pros and cons
cards, a decisions table, and Chart.js cost projections. It updates
in the same commit as `ARCHITECTURE.md` so the two cannot drift.

[~3:30 mark]

Trade-offs I accept.

Echo cancellation rides on the browser's built-in
`echoCancellation: true` and on AVAudioSession's `voiceChat` mode. A
helmet-wearing technician with a bare mic would benefit from a custom
canceller. I'd prioritize that with one more week.

The proxy doesn't reconnect to the upstream on a drop; it closes the
client, the client reconnects, the upstream reopens fresh. A user in
a moving vehicle might prefer silent reconnection; the cost is risk
of speaking into a stale session state.

The rolling summarizer fires every 20 turns. That's tuned for a
typical session length of 10 to 40 turns. A very long session — a
multi-hour debug session — would re-summarize a couple of times.
Acceptable.

[~4:15 mark]

That's the build. Voice in, voice out, every claim grounded in a tool
result or honestly disclaimed, every user's memory isolated by a
user_id clause that's enforced at the data layer and proven by a load
test.
