# Jarvis Tasks

Actionable slices. Top of file is the current slice. The implementing agent picks the topmost unchecked item, finishes it, runs Vouch in fresh context, checks the box, commits the check WITH the code in the same commit. Every task names its `spec.md` user story, its `plan.md` component, and a done-criterion the Vouch can replay.

---

## Current slice — Slice 0: Scaffold

- [ ] Create GitHub private repo `scott-lydon/jarvis` (verify `private: true` via API).
  - Spec: foundational; Plan: §6 Security; Done-when: `gh api repos/scott-lydon/jarvis --jq .private` returns `true`.
- [ ] Add `package.json` with scripts (`dev`, `build`, `start`, `test`, `lint`, `typecheck`), pinned versions of `ws`, `@octokit/rest`, `better-sqlite3`, `zod`, `vitest`, `typescript@5.5`, `eslint`.
  - Plan: §2.1–2.6; Done-when: `npm install` completes with zero peer warnings.
- [ ] `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, target `ES2022`, module `NodeNext`.
- [ ] `.eslintrc.cjs` with `@typescript-eslint/strict-type-checked` + `no-console: warn` (production paths use a real logger).
- [ ] `.env.example` with `OPENAI_API_KEY=`, `GITHUB_TOKEN=`, `WTTR_BASE_URL=https://wttr.in`, `JARVIS_DB_PATH=./data/jarvis.db`, `PORT=3000`.
- [ ] `src/db/migrations/0001_init.sql` creating `users`, `preferences`, `turns`, `memory_summaries`. Migration runner in `src/db/migrate.ts`.
  - Plan: §2.6; Done-when: `npm run db:migrate` against a fresh `data/jarvis.db` creates all four tables (verified by `sqlite3 data/jarvis.db ".schema"`).
- [ ] `tests/smoke/wttr.test.ts` hits real `wttr.in/Austin?format=j1` and asserts the response contains `current_condition[0].temp_F` as a numeric string.
  - Spec: US-08; Plan: §2.4; Done-when: `npm test smoke/wttr` passes against the live endpoint.
- [ ] GitLab mirror set up per the Gauntlet gitflow dual-push trick. `git remote -v` shows two push URLs on `origin`.
- [ ] `prek install` (pre-commit hooks) installed; hooks run ESLint and a `.env`-leakage check.
- [ ] Bug-prevention checklist (`docs/BUG_PREVENTION.md`) seeded with the F1–F14 entries from `~/Documents/Claude/Projects/Gauntlet/demo-video-learnings.md` §3.
- [ ] Populated placeholder-grep passes (from `~/Documents/Claude/Projects/Gauntlet/CLAUDE.md`):
  ```bash
  for f in constitution.md spec.md plan.md tasks.md QA_ADVERSARY.md; do
    if grep -qE '<[A-Z][A-Z _|/-]*>|<PROJECT NAME>|<e\.g\.' "$f" 2>/dev/null; then
      echo "FAIL: $f still has template placeholders"
    fi
  done
  ```
  Done-when: the loop prints nothing.

---

## Next slice — Slice 1: Voice loop (audio round-trip)

- [ ] `src/proxy.ts`: per-client WebSocket server. On client connect, open one upstream WebSocket to `wss://api.openai.com/v1/realtime?model=gpt-realtime` with `Authorization: Bearer ${OPENAI_API_KEY}` (NO `OpenAI-Beta` header — lesson Y).
  - Spec: US-01; Plan: §2.1; Done-when: a browser microphone capture round-trips as `gpt-realtime` voice.
- [ ] Coerce client `ws.on('message')` Buffers to UTF-8 string before forwarding upstream.
  - Reason: lesson F6.
- [ ] Translate upstream `response.output_audio.delta` events to `response.audio.delta` for the client.
- [ ] `session.update` payload sets `audio.input.format = {type:"pcm16", rate:24000}` and `audio.output.format = {type:"pcm16", rate:24000}` nested fully (lesson Y2).
- [ ] System prompt builder (`src/session.ts → buildSystemPrompt`) includes the explicit "Always respond in English." line (lesson F5).
- [ ] Minimal `web/index.html` with a record button, the bar visualizer placeholder, and the WebSocket client.
- [ ] Vouch sub-agent invoked in fresh context with the slice diff. Adversary report attached to the slice commit.

---

## Backlog (slices 2 to 13)

Each slice carries its own done-when when the slice is started. Acceptance criteria below are the spec-level gate; per-slice tasks get spelled out at the top of `tasks.md` when the slice becomes current.

- [ ] **Slice 2 — Session Manager (US-05).** User ID from `X-User-Id`; durable user row; capability list from the live Tool Dispatcher registry; system prompt assembly. Done-when: ask "What can you do?" and the response enumerates exactly the registered tools.
- [ ] **Slice 3 — Weather Tool (US-08).** `tools/weather.ts` with 60-second cache and freshness annotation. Done-when: "Weather in Austin?" returns real data spoken aloud and the `fetched_at_iso` field appears in the structured log.
- [ ] **Slice 4 — Memory (US-03).** Turns persisted; rolling summary; cross-session recall. Done-when: kill server, restart, ask "What did I ask about last time?" and the agent answers correctly.
- [ ] **Slice 5 — GitHub Read (US-07).** All four read handlers (`list_prs`, `list_issues`, `get_pr_comments`, `list_recent_merges`). Done-when: each handler returns real data spoken aloud from a known public repository.
- [ ] **Slice 6 — Barge-in (US-04).** Client `speech_started` → flush local audio queue (≤200 ms) → `response.cancel` upstream (≤300 ms). Done-when: a Vitest integration test asserts the cancel event is emitted within the budget.
- [ ] **Slice 7 — Filler-on-slow-tool + zero-hallucination (US-02, US-06).** Filler audio cue emitted on every >1-second tool call. Property test on 20 known-unanswerable prompts asserts the "no-fabrication" template.
- [ ] **Slice 8 — Preferences + self-awareness polish.** "Never mention X" / "Always flag Y" persisted to `preferences`; system prompt re-renders the LIVE capability list every session open.
- [ ] **Slice 9 — Web frontend polish.** 32-bar audio-reactive footer driven by `AnalyserNode`; `?demo=<manifest>` playback mode for the Conveyor composer (lesson F8); `window.__demoReady` and `window.__startDemo()` hooks.
- [ ] **Slice 10 — iOS client (US-09).** SwiftUI app, `AVAudioEngine` capture, `URLSessionWebSocketTask`, status indicator + visualizer. Done-when: the iOS app round-trips a real query against the deployed server.
- [ ] **Slice 11 — Agentic pull-request flow (US-12).** `github_open_pr_for_issue`. Done-when: a real pull request appears on `https://github.com/scott-lydon/jarvis-fixture/pulls`.
- [ ] **Slice 12 — Scalability hardening (US-11).** Load test for 10 concurrent users with cross-user isolation assertions. Done-when: `tests/load/concurrent-users.test.ts` is green.
- [ ] **Slice 13 — Submission.** Demo video via the multi-voice composer (`phase_14a_multivoice.py`), zip the source, email to both Frontier Audio addresses with explicit human confirmation, file the Gauntlet portal submission at `https://gauntlet-portal.web.app/projects`. Refresh `docs/AI_INTERVIEW_PREP.md` against the submission commit hash.

---

## Working agreements (applies to every slice)

- Vouch runs in fresh context BEFORE the slice is marked done. (See `QA_ADVERSARY.md`.)
- Submit-gate runs at the END of every assignment-touching response. (See `~/.claude/skills/submit-gate/SKILL.md`.)
- Update the bug-prevention checklist (`docs/BUG_PREVENTION.md`) AFTER every fix, BEFORE the next feature.
- Architecture website (`website/index.html`) and `ARCHITECTURE.md` get updated in the SAME commit as any architectural change (per the global "Architecture website maintenance" rule).
- Every slice commit uses Conventional Commits format and includes the `Assisted-by: Claude` trailer when applicable.
