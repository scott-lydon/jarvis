// Unit tests for the SPOT (single point of truth) Whisper-artifact +
// stop-command matchers. These two matchers are the only thing standing
// between Whisper's near-silence hallucinations and the user-visible
// transcript bubble, so they MUST be exact + case- + punctuation-
// insensitive in a predictable way.
//
// Reason this test exists (the bug it guards against): on 2026-06-01
// the user said "Hey how are you", Whisper returned "I'll see you next
// time", the UI rendered it as a USER turn while the system prompt
// told the model to IGNORE that phrase — two contradictory sources of
// truth. The proxy now centralizes the filter via these matchers, and
// these tests pin down the matching contract.

import { describe, expect, it } from 'vitest';

import {
  STOP_COMMANDS,
  WHISPER_ARTIFACTS,
  formatArtifactListForPrompt,
  formatStopCommandsForPrompt,
  isStopCommand,
  isWhisperArtifact,
} from '../../src/audio-artifacts.js';

describe('isWhisperArtifact (Bug-I SPOT)', () => {
  it('matches the exact phrase the user encountered ("I\'ll see you next time")', () => {
    // This is the literal transcript Whisper returned on 2026-06-01
    // when the user said "Hey how are you" on macOS Safari. It must
    // match — that's the entire point of this filter.
    expect(isWhisperArtifact("I'll see you next time")).toBe(true);
    expect(isWhisperArtifact("I'll see you next time.")).toBe(true);
  });

  it('matches every entry in WHISPER_ARTIFACTS regardless of trailing punctuation', () => {
    for (const phrase of WHISPER_ARTIFACTS) {
      expect(isWhisperArtifact(phrase), `bare: ${phrase}`).toBe(true);
      expect(isWhisperArtifact(`${phrase}.`), `dot: ${phrase}.`).toBe(true);
      expect(isWhisperArtifact(`${phrase}!`), `bang: ${phrase}!`).toBe(true);
      expect(isWhisperArtifact(`${phrase}?`), `quest: ${phrase}?`).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isWhisperArtifact('THANKS FOR WATCHING')).toBe(true);
    expect(isWhisperArtifact('Thanks For Watching!')).toBe(true);
    expect(isWhisperArtifact('thanks for watching')).toBe(true);
  });

  it('ignores leading and trailing whitespace', () => {
    expect(isWhisperArtifact('  see you next time  ')).toBe(true);
    expect(isWhisperArtifact('\tlike and subscribe\n')).toBe(true);
  });

  it('does NOT match unrelated phrases (counter-test)', () => {
    expect(isWhisperArtifact('hello how are you')).toBe(false);
    expect(isWhisperArtifact('what is the weather in austin')).toBe(false);
    // Substrings of artifacts must NOT match — only exact equality.
    expect(isWhisperArtifact('watching the news')).toBe(false);
    expect(isWhisperArtifact('see you')).toBe(false);
    // Empty / null / non-string inputs must return false (not throw).
    expect(isWhisperArtifact('')).toBe(false);
    expect(isWhisperArtifact(null as unknown as string)).toBe(false);
    expect(isWhisperArtifact(undefined as unknown as string)).toBe(false);
    expect(isWhisperArtifact(123 as unknown as string)).toBe(false);
  });
});

describe('isStopCommand (Bug-J)', () => {
  it('matches every entry in STOP_COMMANDS regardless of trailing punctuation', () => {
    for (const cmd of STOP_COMMANDS) {
      expect(isStopCommand(cmd), `bare: ${cmd}`).toBe(true);
      expect(isStopCommand(`${cmd}.`), `dot: ${cmd}.`).toBe(true);
      expect(isStopCommand(`${cmd}!`), `bang: ${cmd}!`).toBe(true);
    }
  });

  it('matches the literal phrase the user tested ("Quiet now")', () => {
    // Specifically called out in the user's 2026-06-01 bug report.
    expect(isStopCommand('Quiet now')).toBe(true);
    expect(isStopCommand('quiet now')).toBe(true);
    expect(isStopCommand('quiet now.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isStopCommand('STOP')).toBe(true);
    expect(isStopCommand('Shut Up')).toBe(true);
  });

  it('does NOT match conversational uses of the same words', () => {
    // The matcher is exact-equality on the trimmed normalized form, so
    // a stop-word embedded in a longer sentence does NOT trip the
    // filter — e.g. "wait that's not what I meant" is a real reply,
    // not a "be quiet" command.
    expect(isStopCommand("wait that's not what I meant")).toBe(false);
    expect(isStopCommand('stop the car')).toBe(false);
    expect(isStopCommand("hold on a second I'm thinking")).toBe(false);
  });
});

describe('prompt formatting helpers', () => {
  it('formatArtifactListForPrompt produces a quoted comma-separated string', () => {
    const out = formatArtifactListForPrompt();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain(',');
    expect(out).toMatch(/^".+"/);
    // Spot-check: must contain at least one canonical artifact.
    expect(out.toLowerCase()).toContain('thanks for watching');
  });

  it('formatStopCommandsForPrompt produces a quoted comma-separated string', () => {
    const out = formatStopCommandsForPrompt();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain(',');
    expect(out).toMatch(/^".+"/);
    expect(out.toLowerCase()).toContain('quiet');
  });
});
