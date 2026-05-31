# Jarvis — Bug Prevention Checklist

Pre-seeded with the F1–F14 lessons from the archived Sivraj build
(`~/Documents/Claude/Projects/Gauntlet/demo-video-learnings.md` §3 Failure
Modes). Every new fix appends a row. Every new feature is checked against
the whole list before it ships.

The format is fixed: short title, one-line mechanism, where the
guard lives in code. The mechanism column is what makes the check
greppable from `scripts/vouch-grep-attacks.sh`.

| # | Title | Mechanism | Guard location |
|---|---|---|---|
| F1 | Fixed output filename for captures | UTC-microsecond stamp in every audio / video capture path. Pattern `<proj>-demo-<UTC-microsecond>.<ext>`. | (none yet — surfaces at Slice 13 demo composer) |
| F2 | Synthesized USER audio below VAD threshold | Render USER lines at `volume=6.0` with `9.0` fallback; pad 300 ms leading + 800 ms trailing silence. | demo composer |
| F3 | Multiple `response.audio.done` events; exit on first clips reply | Capture client uses idle-based exit (`IDLE_MS=4000`), accumulates all `response.audio.delta`. | capture client (Slice 13) |
| F4 | PCM chunk pacing too fast | Pace at 170 ms per 4096-sample chunk @ 24 kHz; not 50 ms. | `src/proxy.ts` upstream forwarder |
| F5 | GA Realtime silently coerces non-English audio | `buildSystemPrompt()` includes explicit "Always respond in English." | `src/session.ts` |
| F6 | GA Realtime rejects binary Buffer forwards | Client → server forwarder coerces Buffer to UTF-8 string. | `src/proxy.ts` |
| F7 | `ffmpeg drawtext` fails without `fontfile=` on macOS | Use solid-color freeze frames OR pass `fontfile=/System/Library/Fonts/Supplemental/Arial.ttf`. | demo composer |
| F8 | Per-clip Playwright recording leaves UI motionless | One continuous take; `?demo=<manifest>` URL; fire `window.__startDemo()`. | `web/main.ts` demo hook |
| F9 | Per-exchange WebSocket sessions cannot show real barge-in | Demo uses persistent capture client OR scripts barge-in as a sequence. | demo composer |
| F10 | Duplicated / dropped lines slip through without whisper-verify | Composer refuses to ship if `phase_14c_verify_demo.py` returns rc=2. | demo composer |
| F11 | Script-narrated "agent remembers X" can mismatch real reply | Prime memory for the demo `user_id` BEFORE rendering. | demo composer |
| F12 | `el_tts_render` is file-presence idempotent; leftover empties survive failed renders | `rm -f` the target before re-render. | demo composer |
| F13 | Acronym slurring ("USDC", "SOL") ruins intelligibility | Per-acronym word denylist with phonetic spellouts. | demo composer |
| F14 | Silence > 6 s without narration feels dead | Narration budgeted to cover tool-call wait time. | demo composer |
| Y1 | Project-namespaced events (jarvis.*) re-injected into upstream cause Realtime to fail | Upstream forwarder filters any event with `type` starting `jarvis.`. | `src/proxy.ts` (Slice 1) |
| Y2 | `session.update` audio.format must be fully nested | Use `audio.input.format = {type:"pcm16", rate:24000}`, not the flat shape. | `src/proxy.ts` (Slice 1) |

---

## How to add a new entry

When a slice or a Vouch report turns up a new failure mode:

1. Add a row to the table above with a short title, one-line mechanism,
   and the file path the guard lives in.
2. If the guard is greppable, add the grep to
   `scripts/vouch-grep-attacks.sh` so future Vouch runs catch the same
   shape automatically.
3. Reference the new row in the slice's commit message (e.g.,
   `bug-prevention: add F17 — mic permission popover overlap`).

---

## Anti-patterns this list prevents

- Re-discovering an issue we already paid for in a prior build.
- Letting a one-off fix decay into the codebase without a guard.
- Submit-gate passing on the same bug shape twice.
