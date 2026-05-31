# Jarvis Constitution

The rules. Anything below is a hard constraint unless an explicit, committed amendment to this file says otherwise. The implementing agent reads this file BEFORE every slice and refuses any change that violates it.

PRD source of record: Gauntlet portal partner project "Jarvis: A real-time voice assistant powered by cutting-edge LLMs for seamless, intelligent communication and task handling" — Frontier Audio, Silver tier, last updated 2026-03-16. Captured locally as `Jarviswp.webarchive` in the session uploads.

---

## 1. Tech stack — fixed decisions

| Concern | Choice | Why this and not the alternative |
|---|---|---|
| Voice loop | OpenAI Realtime General Availability API (`gpt-realtime`) over one bidirectional WebSocket | Single provider, native server-side Voice Activity Detection (VAD), native barge-in. Chained Speech-to-Text + Large Language Model + Text-to-Speech adds 400 to 900 milliseconds per hop and forfeits native interrupt. PRD requirement: near-zero latency, natural cadence, interruptibility. |
| Realtime model name | `gpt-realtime` (GA), NOT `gpt-4o-realtime-preview` (Beta) | Beta was deprecated 2026-05-12. The prior build (Sivraj) shipped on Beta and had to be hot-migrated mid-demo. Never start a new build on the deprecated endpoint. |
| Audio format | Pulse Code Modulation 16-bit (PCM16), 24 kilohertz, mono, both directions | What `gpt-realtime` accepts and emits. No re-encoding in the proxy. |
| Backend language / runtime | TypeScript on Node.js 20 Long Term Support (LTS) | Best WebSocket ecosystem (`ws`), tight integration with the OpenAI Node SDK, fast iteration. |
| Web frontend | Plain HyperText Markup Language (HTML) + TypeScript + Vite. NO Next.js. | PRD explicitly forbids Next.js without written justification. None justified. |
| Mobile (bonus) | SwiftUI iOS client as a thin layer over the same server WebSocket | User's preferred language is Swift. PRD bonus #1 allows Kotlin or Swift. |
| Persistent memory | Self-hosted Structured Query Language (SQL): SQLite with Write-Ahead Log (WAL) mode for Slices 1 to 8; Postgres swap-in only when concurrent user count exceeds eight | Zero infrastructure cost at Minimum Viable Product (MVP) scale, durable across process restart, single-file backup. The Persistence Layer is the only module that knows the database; the swap is one file. |
| Weather feed (PRD requirement #8) | `wttr.in` JavaScript Object Notation (JSON) endpoint `https://wttr.in/{location}?format=j1` | No Application Programming Interface (API) key, no rate-limit ceiling at development scale, deterministic JSON schema. Environment variable `WTTR_BASE_URL` overrides for tests. |
| GitHub integration (PRD requirement #7 and bonus #4) | GitHub Representational State Transfer (REST) API v3 via `@octokit/rest`, authenticated by `GITHUB_TOKEN` (scopes: `repo`, `workflow`, `read:org`) | Server-side keeps the token off the client. Synchronous and auditable. |
| Deployment | Render.com OR Fly.io. Explicitly NOT Vercel. | PRD explicitly forbids Vercel without written justification. None justified. Vercel serverless cannot host long-lived WebSocket servers anyway. |
| Repository visibility | Private. `git@github.com:scott-lydon/jarvis.git` (to be created) plus the Gauntlet GitLab mirror at `git@labs.gauntletai.com:scottlydon/jarvis.git` using the dual-push origin trick. | PRD requirement: "Repository must be private." The Gauntlet GitLab mirror is the per-cohort grading remote. |

Any change to the table above is an amendment to this constitution and requires a commit that touches THIS file.

---

## 2. Voice user-experience non-negotiables (direct from PRD)

These are PRD line items (Functional Requirements 1 through 8 plus Impact Metrics). They are quality gates, not preferences. A slice that breaks one of these is not done.

1. **User Experience over User Interface (PRD req #1).** The voice loop must feel daily-usable. UI surface is allowed to stay minimal; UX latency and clarity are not allowed to slip.
2. **No long silence (PRD req #2).** If any backend action will take more than 1 second, the assistant must emit an audible filler ("One moment, pulling that now…") BEFORE the wait begins. Silent waits are a defect.
3. **Persistent memory across sessions (PRD req #3).** Per-user conversation summaries plus the last 20 raw turns are recallable on the next connection. In-memory `Map` is not durable and is forbidden.
4. **Interruptibility (PRD req #4).** "Quiet, Jarvis" (or any user speech during agent playback) must immediately stop playback and cancel the in-flight response upstream. Path: client `speech_started` event → flush local audio queue → emit `response.cancel` to OpenAI.
5. **Self-awareness (PRD req #5).** A `what_can_you_do` system-prompt block enumerates the live tool surface. When asked, the agent describes its real capability list, not a hardcoded brag sheet.
6. **Zero hallucinations (PRD req #6).** Factual claims must be grounded in a real tool response (weather, GitHub, memory) or the agent says "I don't know." No fabricated commit hashes, no invented pull request numbers, no plausible-sounding fake weather. Enforced in the system prompt AND by tool-only data paths.
7. **GitHub integration (PRD req #7).** Ingest any public GitHub URL. Answer about open pull requests, issues, pull request comments, last merges. Tool surface: `github_list_prs`, `github_list_issues`, `github_get_pr_comments`, `github_list_recent_merges`, and (bonus) `github_open_pr_for_issue`.
8. **API data handling (PRD req #8).** Live weather feed (`wttr.in`) is the chosen real-time API. No cached-as-fresh data; cache time-to-live is 60 seconds and the response is timestamped.

---

## 3. Code quality gates (default ON, every slice)

- TypeScript `"strict": true`. No `any` without an inline `// reason:` comment. No `// @ts-ignore` ever.
- `eslint .` passes at zero errors. Pre-existing warnings allowed only with a tracked issue.
- Every catch block does ONE of: (a) re-throw, (b) wrap-and-re-throw with `cause: e`, (c) return a structured error to the tool dispatcher so the agent can speak the failure honestly. **`catch (e) { console.log(e); continue; }` is forbidden** and the Vouch sub-agent will flag it.
- Every public function has a docstring naming inputs, outputs, and failure modes. Every place that could throw a wrong type, a wrong shape, or a stale value gets a specific error message clear enough to diagnose without re-reading the function.
- Strict types on all module boundaries. Internal helpers can infer.
- No `mocks/` or `fixtures/` outside `*.test.ts` / `*.spec.ts`. Production paths hit real endpoints. (Mirrors the global HARD RULE: NO MOCK / STUB / FAKE / REUSED DATA.)
- Persistent state writes are durable across process restart. An in-memory `Map` is NEVER the durable store.

---

## 4. What the implementing agent must never do

- Introduce Next.js or Vercel (PRD forbids both without justification; none is justified).
- Commit a `.env` file or any token-bearing file. Pre-commit hook installed in Slice 0 enforces this.
- Push the repo to a public remote.
- Use `gpt-4o-realtime-preview` (the deprecated Beta) — only `gpt-realtime` (GA).
- Forward client WebSocket frames as binary Buffers upstream — OpenAI GA rejects binary. Force UTF-8 coerce. (Lesson F6 from the prior build.)
- Send emails to `wduffy@frontieraudio.com` or `pmoeckel@frontieraudio.com` without explicit human confirmation in the same conversation turn.
- Mark a slice green while any ESLint error, TypeScript error, or failing test exists.
- Mark a slice green without invoking the Vouch sub-agent in a fresh context (per `~/Desktop/Clutter/iOS/openemr/CLAUDE.md` and `~/Documents/Claude/Projects/Gauntlet/CLAUDE.md`).
- Present any output as "fresh" that was reconstructed, replayed, cached, or regenerated — without unprompted up-front disclosure. (Direct lift from the global HARD RULE; this is the rule that fired on the 2026-05-28 Sivraj reused-demo-audio incident.)

---

## 5. Lift-and-shift from the archived Sivraj build (do NOT repeat these failures)

Sourced from `~/Documents/Claude/Projects/Gauntlet/demo-video-learnings.md` §3 Failure Modes (F1 through F14). These are baked in as upstream constraints, not discovered the hard way again:

| # | Constraint | Mechanism |
|---|---|---|
| F1 | Never reuse a fixed output filename for video or audio captures | Every render writes `<proj>-demo-<UTC-microsecond>.mp4`; `.conveyor/14-demo-latest.json` is the pointer. |
| F2 | Synthesized USER audio at default ElevenLabs volume falls below the agent's VAD threshold | Render USER lines at `volume=6.0` with a `9.0` fallback; pad 300 milliseconds leading + 800 milliseconds trailing silence. |
| F3 | Tool-call replies arrive as two `response.audio.done` events; exiting on the first clips the answer | Capture client uses idle-based exit: `IDLE_MS=4000`, accumulating all `response.audio.delta` chunks. |
| F4 | PCM chunk pacing faster than realtime drops the agent's leading words | Pace at 170 milliseconds (true realtime for 4096-sample chunks at 24 kHz), not 50 milliseconds. |
| F5 | GA Realtime API silently coerces to non-English on borderline audio | `buildSystemPrompt()` includes an explicit "Always respond in English." directive. |
| F6 | GA Realtime rejects binary Buffer forwards from the `ws` library | Client → server forwarder converts to UTF-8 string before forwarding. |
| F7 | macOS ffmpeg `drawtext` filter fails without `fontfile=` | Use solid-color freeze frames OR pass `fontfile=/System/Library/Fonts/Supplemental/Arial.ttf` explicitly. |
| F8 | Per-clip Playwright recording leaves the demo UI motionless | One continuous take, page opens with `?demo=<manifest>`, fire `window.__startDemo()`, trim pre-roll by duration math. |
| F9 | Per-exchange WebSocket sessions cannot show a true mid-reply barge-in | Demo script either uses a persistent capture client OR shows barge-in as a SEQUENCE with narration. |
| F10 | Composer may ship duplicated or dropped lines if whisper-verification is skipped | Composer refuses to ship if `phase_14c_verify_demo.py` returns rc=2. |
| F11 | Script-narrated "the agent remembers X" can silently mismatch the real agent reply | Prime memory for the demo `user_id` BEFORE rendering, OR add a stripped-pre-roll USER exchange. |
| F12 | `el_tts_render` is file-presence idempotent; leftover empty files survive failed renders | `rm -f` the target before re-render. |
| F13 | Acronym slurring ("USDC", "SOL") ruins demo intelligibility | Per-acronym word denylist with phonetic spellouts. |
| F14 | Silence longer than ~6 seconds without narration feels dead | Narration is budgeted to cover tool-call wait time. |

---

## 6. Environment variables

### Required before Slice 1

- `OPENAI_API_KEY` — OpenAI Realtime GA endpoint. Must be a fresh-rotated key, not a hand-me-down from the Sivraj build. Format `sk-…` or `sk-proj-…`.

### Required before Slice 9 (Render deploy)

- `GITHUB_TOKEN` — GitHub REST API for the Octokit client at runtime. Fine-grained personal access token with permissions:
  - **Contents:** Read and write (branch + commit + push for the agentic pull request flow, US-12).
  - **Issues:** Read (US-07 list, US-12 read issue body).
  - **Pull requests:** Read and write (US-07 list, US-07 read comments, US-12 create PR).
  - **Metadata:** Read (auto-granted, mandatory).
  - Workflows, Account permissions, and other Repository permissions: **No access**.
- Earlier classic-scope notation (`repo`, `workflow`, `read:org`) was over-specified; the fine-grained permissions above are the actual minimum needed by the tool surface in `src/tools/github.ts`.

### Local-dev shortcut (avoids generating a token until Slice 9)

For local development Slices 5–8, reuse the existing `gh` CLI auth instead of generating a separate token:

```bash
GITHUB_TOKEN=$(gh auth token) npm run dev
```

Verified working on this Mac: `gh auth status` reports token scopes `gist`, `read:org`, `repo`, `workflow` — superset of what Octokit needs. The token is in the macOS keyring, not in any committed file.

### Optional config (with defaults)

- `WTTR_BASE_URL` — defaults to `https://wttr.in`. Set to a local stub server in tests.
- `JARVIS_DB_PATH` — defaults to `./data/jarvis.db`.
- `PORT` — defaults to `3000`.

### Secret handling rules

`.env` is `.gitignore`'d. `.env.example` is committed with empty values and inline comments. Secrets are entered via the macOS `osascript` hidden-answer dialog (mirror of `~/.local/bin/conveyor-secret-gui`), never typed into a terminal command line and never hand-edited into `.env`.

---

## 7. Quality gates per assignment-level CLAUDE.md

These two run-by-default mechanisms are in scope for THIS project:

- **vouch (Quality Assurance) gate.** After every code add/modify/create, the Vouch sub-agent runs in a fresh context BEFORE the slice is reported done. See `~/.claude/agents/vouch.md`. Project-specific attack surface is in `QA_ADVERSARY.md`.
- **submit-gate.** At the END of every assignment-touching response, read `~/.claude/skills/submit-gate/SKILL.md` and run its checklist. Either the response ends with `Submit-gate: PASS.` plus evidence, or `Submit-gate: FAIL on <line(s)>.` followed by continued work in the same turn until PASS.

---

## 8. Submission checklist (PRD-mandated; checked at Slice 13)

1. Repository is and remains private (verify on `https://github.com/scott-lydon/jarvis/settings`).
2. Source code zipped and emailed to `wduffy@frontieraudio.com` and `pmoeckel@frontieraudio.com`.
3. 5 to 10 minute video or audio walkthrough (Artificial Intelligence (AI) methodology, tool choices, OpenAI Realtime GA rationale, wttr.in rationale, key architectural decisions) sent to the same emails.
4. Gauntlet portal weekly submission filed at `https://gauntlet-portal.web.app/projects`.
5. The Gauntlet portal `/profile` page is NOT updated with this project's title, repo link, or description (partner-confidential per `~/Documents/Claude/Projects/Gauntlet/CLAUDE.md`).
6. AI video interview prep doc (`docs/AI_INTERVIEW_PREP.md`) is current as of the submission commit hash.

---

## 9. Amendment process

This file is a living document. Real architectural reality wins over a stale rule. If a slice discovers that a constraint here is wrong or no longer needed, the implementing agent edits THIS file in the same commit that changes the code, and writes a one-line note in the commit message explaining the amendment.
