# Jarvis Specification

What we are building and why. User stories with explicit acceptance criteria. Out-of-scope list. Rubric mapping. 60-second demo script.

PRD source of record: Gauntlet portal partner project "Jarvis", Frontier Audio, Silver tier, last updated 2026-03-16 (local copy at `Jarviswp.webarchive`).

---

## 1. Problem statement

Frontline workers (field technicians, on-site operators, emergency responders) need accurate, reliable, instantaneous cross-team information while their hands are busy. They cannot stop to type, scroll, or read. The cost of latency or wrong data is operational; the cost of a fabricated answer is reputational and can be physical.

Today's voice assistants either (a) sound natural but make things up, or (b) ground answers in real data but feel like a slow, awkward phone tree. Jarvis closes that gap: a voice-first agent that grounds every factual claim in a real tool response, says "I don't know" when it cannot, remembers the user across sessions, can be interrupted mid-sentence, and answers a question about a real GitHub repository or current weather in roughly the time it would take a coworker on a radio.

**Success looks like:** A user opens Jarvis on a phone or browser, says "What's the weather in Austin and what are the open pull requests on `openemr/openemr`?", and gets a real spoken answer in under three seconds of perceived latency, with no hallucinated numbers, and can interrupt mid-answer to redirect.

---

## 2. User stories — Minimum Viable Product (MVP)

Each story is anchored to a PRD Functional Requirement number ("PRD #N"). The acceptance criteria below are the gate the Vouch sub-agent replays in its fresh context.

### US-01 — Daily-usable voice loop (PRD #1)

**As a** frontline worker
**I want** a voice loop that feels like talking to a coworker, not a phone tree
**So that** I will actually use it on the job

**Acceptance criteria:**
- Given the user has opened Jarvis and granted microphone permission, when the user speaks any sentence, then the agent begins responding (audio frame received by the client) within 1.5 seconds of end-of-user-speech on a healthy network.
- Given the agent is mid-response, when the user begins speaking, then the agent's playback is cut off within 200 milliseconds (see US-04).
- The user interface contains a static status indicator (one of: `listening`, `thinking`, `speaking`, `error`) and an audio-reactive bar visualizer. There is no scrolling transcript ticker on screen during normal use.

### US-02 — Natural conversation cadence (PRD #2)

**As a** user
**I want** the agent to never leave me wondering if it is still working
**So that** I do not repeat myself or hang up

**Acceptance criteria:**
- Given the agent has invoked a tool that will take more than 1 second (any `github_*` call, any `wttr_*` call), when the tool call begins, then the agent emits an audible filler within 1 second (one of: "One moment, pulling that now.", "Checking GitHub.", "Looking up the weather.").
- Given the network or the upstream model has stalled, when 5 seconds pass without audio output, then the agent emits a status filler ("Still working on that…").

### US-03 — Conversation memory across sessions (PRD #3)

**As a** returning user
**I want** Jarvis to remember what we discussed yesterday
**So that** I do not have to re-explain context every connection

**Acceptance criteria:**
- Given user `U` has had a conversation in session `S1` where they asked about repository `R`, when user `U` connects in session `S2` and says "Yesterday I asked about a repo, which one was it?", then the agent answers `R` correctly.
- Memory is durable across a full process restart of the server (verified by killing the Node process between `S1` and `S2`).
- The Persistence Layer uses a real on-disk store (SQLite). An in-memory `Map` does not satisfy this story.

### US-04 — Interruptibility (PRD #4)

**As a** user
**I want** to interrupt the agent mid-sentence
**So that** I do not waste 20 seconds listening to the wrong answer

**Acceptance criteria:**
- Given the agent is mid-playback of a response, when the user says "Quiet, Jarvis" (or any utterance crossing the VAD threshold), then:
  - the client flushes its local audio queue within 200 milliseconds,
  - the server emits `response.cancel` to the OpenAI Realtime upstream within 300 milliseconds,
  - the agent does not emit further audio for that response.

### US-05 — Self-awareness (PRD #5)

**As a** user encountering Jarvis for the first time
**I want** to be able to ask what it can do
**So that** I learn the capability surface without reading documentation

**Acceptance criteria:**
- Given the user asks "What can you do?" (or any of: "What are you able to help with?", "What tools do you have?"), when the agent responds, then the response enumerates the LIVE tool surface at that moment (not a hardcoded list).
- If a tool is disabled at runtime (for example, `GITHUB_TOKEN` is missing), the agent omits it from the answer and explains why ("GitHub access is not configured right now.").

### US-06 — Zero hallucinations (PRD #6)

**As a** decision-maker relying on the answer
**I want** the agent to refuse to fabricate
**So that** I do not act on a made-up number

**Acceptance criteria:**
- Given the user asks a factual question outside the agent's tool surface (for example "What was Apple's stock price at close yesterday?"), when the agent responds, then the response is "I don't have reliable information on that. I can tell you about weather, or anything on a public GitHub repository." or equivalent. The response does NOT contain a fabricated number.
- Given the user asks a question the agent CAN answer via a tool, when the tool errors, then the agent surfaces the error honestly ("I tried to reach GitHub but the request timed out.") rather than guessing.
- Vouch verifies this with a property test: for a set of 20 known-unanswerable prompts, the response must match the "no-fabrication" template and must NOT contain any numeric value, repo name, or pull request number not in the tool output.

### US-07 — GitHub integration (PRD #7)

**As a** developer
**I want** to ask the agent about any public GitHub repository
**So that** I learn the state without opening a browser

**Acceptance criteria:**
- Given the user provides a GitHub URL (`https://github.com/owner/repo`) or a slug (`owner/repo`), when the user asks "List the open pull requests", then the agent calls `github_list_prs(owner, repo)` and speaks the top 5 by number, title, and author.
- Given the user asks "What issues are open on `owner/repo`?", when the tool returns, then the agent speaks the top 5 by number, title, and label.
- Given the user asks "What were the comments on pull request 1234 in `owner/repo`?", when the tool returns, then the agent speaks each comment author and a short summary of the comment body.
- Given the user asks "What were the most recent merges?", when the tool returns, then the agent speaks the top 5 merged pull requests with their merge timestamp.
- Every spoken value is grounded in the tool response. No fabrication.

### US-08 — Real-time API data handling (PRD #8)

**As a** field worker
**I want** to ask current weather and get a real, current answer
**So that** I plan around real conditions

**Acceptance criteria:**
- Given the user asks "What's the weather in `<location>`?", when the agent calls `wttr_get(location)`, then the response is sourced from `https://wttr.in/{location}?format=j1` (verified by the integration test that mocks `WTTR_BASE_URL` to a recording server).
- Cache time-to-live is 60 seconds; the response is annotated with the upstream fetch timestamp so a Vouch property test can verify "fresh" means fresh.
- If `wttr.in` returns a 5xx or times out, the agent says "I couldn't reach the weather service right now." rather than guessing.

---

## 3. User stories — bonus (PRD bonus features)

### US-09 — Mobile compatibility (PRD bonus #1)

**As a** field user
**I want** Jarvis on my iPhone
**So that** I use it where I actually work

**Acceptance criteria:**
- A SwiftUI iOS client at `ios/Jarvis/` connects to the same server WebSocket, streams microphone PCM16 frames, plays back PCM16 frames received from the server.
- Status indicator and audio-reactive visualizer match the web client's behavior.

### US-10 — Passive mode (PRD bonus #2)

**As a** user with the app open
**I want** the agent to stay quiet until I address it
**So that** my phone does not respond to every nearby word

**Acceptance criteria:**
- Given the app is in passive mode, when the user says any utterance NOT prefixed with the wake phrase "Hey Jarvis", then the agent does not respond.
- Given the same passive mode, when the user says "Hey Jarvis, …", then the agent activates and answers the rest of the utterance.

### US-11 — Scalability and personalization (PRD bonus #3)

**As a** team deploying Jarvis
**I want** 10 simultaneous users with data isolation and per-user preferences
**So that** one person's memory or preferences never leak to another

**Acceptance criteria:**
- A load test (`tests/load/concurrent-users.test.ts`) opens 10 concurrent client WebSockets with distinct `X-User-Id` headers; each conversation's memory and preferences remain scoped to its own user identifier.
- A user can say "Never mention `<topic>` again" and the next session honors that preference (stored in `preferences` table).
- A user can say "Always flag any pull request from `<author>`" and the agent flags subsequent matching pull requests.

### US-12 — End-to-end agentic GitHub flow (PRD bonus #4)

**As a** repository maintainer
**I want** Jarvis to open a pull request that attempts to fix an issue
**So that** routine issues get a first-draft fix without me typing

**Acceptance criteria:**
- Given the user says "Look at issue 42 in `owner/repo` and open a pull request to fix it", when the agent runs, then:
  - it calls `github_get_issue(owner, repo, 42)`,
  - it generates a patch via the Large Language Model with the issue body as context,
  - it creates a branch `jarvis/fix-42-<short-sha>`, commits the patch, pushes, and opens a pull request via `github_open_pr_for_issue`,
  - it speaks the new pull request URL.
- The pull request is real and visible on `https://github.com/owner/repo/pulls`.

---

## 4. Out of scope (deliberately, this build)

| Out | Why |
|---|---|
| iOS background passive mode using a true low-power wake-word engine | Bonus US-10 covers foreground passive mode; background wake-word needs Apple's `SpeechRecognizer` continuous mode plus a foreground service. Time budget does not support it cleanly; deferred. |
| Non-English language support | PRD does not require it; the system prompt locks responses to English to prevent the F5 silent-coercion failure. |
| Persistent multi-turn agent loops beyond US-12 (multi-step plans, retries, subagents) | US-12 is a single tool-call chain. A general agent loop is out of scope for this MVP. |
| OAuth-based authentication | MVP uses an `X-User-Id` header (UUID) for per-user isolation. OAuth replaces it only if Frontier Audio asks. |
| Web push notifications, SMS, email integrations | Not in the PRD. |
| Voice cloning / custom TTS voice | Out of scope; the GA `gpt-realtime` default voice is used. |

---

## 5. Rubric-pillar mapping

The Gauntlet weekly rubric grades on Architecture, Scalability, Security, and Testing. The mapping below is the source `docs/AI_INTERVIEW_PREP.md` cites in its rubric anchor answers.

| Rubric pillar | User stories that satisfy it | Plan components |
|---|---|---|
| Architecture | US-01, US-02, US-04, US-05 | OpenAI Realtime Proxy, Session Manager, Tool Dispatcher (plan.md §2.1–2.3) |
| Scalability | US-11 | Session Manager (per-user isolation), Persistence Layer SQLite-to-Postgres swap path (plan.md §2.2, §2.6, §4) |
| Security | US-06, US-11, plus constitution §4 forbidden list | Server-side tool dispatch (tokens never reach client), `.env` discipline, repo-private gate, no token in logs (plan.md §2.3, §6) |
| Testing | US-06, US-08, all US-* acceptance criteria | Vouch property tests in `tests/`, integration tests with recorded fixtures, load test for US-11 (QA_ADVERSARY.md §3) |

---

## 6. Demo script — the 60-second happy path

Used by the AI video interviewer and by the Conveyor demo composer (`phase_14a_multivoice.py`). Each line maps to a `covers` array of user-story IDs. Strict rule from the prior build: every NARRATOR line traces to THIS spec or to an explicitly-justified meta exchange.

```
[00:00] NARRATOR: "This is Jarvis. A voice-first agent for frontline work, grounded in real data."
[00:05] USER:     "What's the weather in Austin?"           covers: [US-01, US-02, US-08]
[00:10] AGENT:    "It's seventy-eight degrees and partly cloudy in Austin right now."
[00:16] USER:     "How many pull requests are open on openemr slash openemr?"  covers: [US-01, US-07]
[00:22] AGENT:    "One moment, pulling that now."
[00:24] AGENT:    "There are forty-three open pull requests. The top three are..."
[00:34] NARRATOR: "It remembers across sessions, too."       covers: [US-03]
[00:37] USER:     "What did I ask about yesterday?"
[00:40] AGENT:    "Yesterday you asked about the weather in Austin and the open pull requests on openemr slash openemr."
[00:48] NARRATOR: "And you can cut it off."                  covers: [US-04]
[00:51] USER:     "Quiet, Jarvis."
[00:52] AGENT:    "Got it."
[00:54] NARRATOR: "Jarvis. Real answers. Real fast. Real grounded."
[00:60] (end)
```

The demo composer's `spec-coverage gate` checks that every required US-XX appears in some exchange's `covers` array. US-05, US-06, US-09, US-10, US-11, US-12 are listed in `excluded_stories` of the 60-second script with one-line reasons (US-05 is structural and covered by US-07; US-06 is verified by tests not demoable in 60s; US-09–US-12 are bonus surface not in the headline demo). A second longer-form video covers the excluded set.
