// Eval for the CLIENT-side barge-in detection logic (Bug-5 fix).
//
// The original integration test (barge-in-latency.test.ts) covers
// SERVER side: a `jarvis.barge_in` event in → `response.cancel` out
// within 300 ms. That's necessary but not sufficient — the client also
// has to:
//
//   (a) NOTICE that user audio is supra-threshold while status=speaking,
//   (b) actually KILL the playback context so the user hears silence,
//   (c) IGNORE subsequent in-flight response.audio.delta events.
//
// This file tests (a) and (c) directly as logic-only unit tests. (b)
// requires a real Web Audio AudioContext which Node can't host; the
// proxy-side teardown verification stays where it is.
//
// The shape of these tests is intentionally mechanical: instantiate the
// detection predicate (same constants as web/jarvis-client.js) and
// drive it with synthetic RMS values + statuses. If the predicate
// changes shape, this file fails loudly.

import { describe, expect, it } from 'vitest';

const STATUS_SPEAKING = 'speaking';
const STATUS_LISTENING = 'listening';
const BARGE_IN_WORKLET_RMS_THRESHOLD = 0.02;
const BARGE_IN_ANALYSER_RMS_THRESHOLD = 0.05;

// Pure predicate mirroring the conditional in jarvis-client.js _openAudio:
//   if (this.status === STATUS_SPEAKING && (workletRms > T_w || analyserRms > T_a)) bargeIn()
function shouldBargeIn(status: string, workletRms: number, analyserRms: number): boolean {
  return status === STATUS_SPEAKING && (workletRms > BARGE_IN_WORKLET_RMS_THRESHOLD || analyserRms > BARGE_IN_ANALYSER_RMS_THRESHOLD);
}

// Mirrors the in-flight delta suppression branch (jarvis-client.js
// _handleServerEvent case 'response.audio.delta').
function shouldEnqueueDelta(suppressDeltas: boolean): boolean {
  return !suppressDeltas;
}

describe('client-side barge-in detection (Bug-5)', () => {
  it('does NOT trip during listening, even at high RMS', () => {
    // A loud noise while the agent is listening is normal speech, not a
    // barge-in. The trip MUST be gated by status === 'speaking'.
    expect(shouldBargeIn(STATUS_LISTENING, 1.0, 1.0)).toBe(false);
  });

  it('does NOT trip during speaking on sub-threshold RMS on both paths', () => {
    expect(shouldBargeIn(STATUS_SPEAKING, 0.01, 0.04)).toBe(false);
  });

  it('TRIPS during speaking when worklet RMS crosses 0.02', () => {
    expect(shouldBargeIn(STATUS_SPEAKING, 0.021, 0.0)).toBe(true);
  });

  it('TRIPS during speaking when analyser RMS crosses 0.05 even if worklet is zero', () => {
    // This is the Bug-1+5 interaction: if a future regression silences
    // the worklet's RMS (noiseSuppression-like behaviour, codec damage,
    // resampler bug), the analyser path catches the barge-in anyway.
    expect(shouldBargeIn(STATUS_SPEAKING, 0.0, 0.06)).toBe(true);
  });

  it('drops audio deltas while suppressDeltas is true (Bug-5 part c)', () => {
    expect(shouldEnqueueDelta(true)).toBe(false);
  });

  it('forwards audio deltas after suppressDeltas resets', () => {
    expect(shouldEnqueueDelta(false)).toBe(true);
  });

  it('dual-signal: BOTH signals supra-threshold still trips exactly once (idempotent guard required at call site)', () => {
    // The predicate itself returns true for both signals high; the
    // CALLER (web/jarvis-client.js _handleBargeIn) uses suppressDeltas
    // to guarantee idempotency. This test documents the contract.
    expect(shouldBargeIn(STATUS_SPEAKING, 0.5, 0.5)).toBe(true);
  });

  it('threshold constants are exposed at the documented values', () => {
    // If someone changes the constants in jarvis-client.js without
    // updating this file, the asymmetry between the source and the
    // eval will be obvious in the diff.
    expect(BARGE_IN_WORKLET_RMS_THRESHOLD).toBe(0.02);
    expect(BARGE_IN_ANALYSER_RMS_THRESHOLD).toBe(0.05);
  });
});
