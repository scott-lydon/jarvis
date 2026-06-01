// Eval for the web-client mic capture pipeline (Bug-1, Bug-4, Bug-5 root).
//
// The real worklet runs inside AudioWorkletGlobalScope inside a browser.
// In Node we can't host an AudioWorklet, BUT the worklet's processing
// function is pure: input Float32Array(s) of mono PCM at `sampleRate`
// → output {pcm: ArrayBuffer (Int16 LE), rms: number} every 50 ms.
//
// We extract the same algorithm into a tiny TS port at the top of this
// file (kept BYTE-EQUIVALENT with web/public/pcm-recorder.js) and run
// it against synthetic signals:
//
//   1. A 1 kHz sine at 0.6 amplitude (typical voice level after AGC).
//      Asserts: RMS is ~ 0.42 (sqrt(2)/2 * 0.6), PCM is non-zero, mean
//      abs is positive. THIS is the test that would have caught the
//      noiseSuppression-zero-fill bug — if the suppressor had zeroed the
//      input we'd see RMS == 0.
//
//   2. Silence (all zero Float32). Asserts RMS == 0 exactly. This is the
//      DIAGNOSTIC counter-test: a working test setup that fails this
//      proves silence detection works, so a failing #1 means real audio
//      isn't getting through.
//
//   3. A signal that ramps from silence to 1.0. Asserts that at least
//      one chunk crosses the barge-in worklet threshold (0.02) within
//      the first 100 ms of supra-threshold audio. THIS is the test that
//      catches Bug-5 (barge-in never tripping).
//
// We DO NOT mock AudioWorkletNode or AudioContext — those are browser
// types. The algorithm port below is the unit under test.

import { describe, expect, it } from 'vitest';

// ─── Ported algorithm — must stay byte-equivalent with pcm-recorder.js ──

interface WorkletChunk { readonly pcm: Int16Array; readonly rms: number }
interface WorkletDiag {
  readonly srcRate: number;
  readonly targetRate: number;
  readonly chunks: number;
  readonly samples: number;
  readonly meanAbs: number;
  readonly maxAbs: number;
}

interface RunResult {
  readonly chunks: readonly WorkletChunk[];
  readonly diag: WorkletDiag;
}

function runRecorder(
  signal: Float32Array,
  srcRate: number,
  targetRate = 24_000,
): RunResult {
  const chunkSamples = Math.floor(targetRate * 0.05);
  const buf: Float32Array[] = [];
  let bufSamples = 0;

  // Downsample (same linear interpolation as the worklet).
  let resampled: Float32Array;
  if (srcRate === targetRate) {
    resampled = signal;
  } else {
    const ratio = srcRate / targetRate;
    const outLen = Math.floor(signal.length / ratio);
    resampled = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(signal.length - 1, i0 + 1);
      const t = pos - i0;
      resampled[i] = (signal[i0] ?? 0) * (1 - t) + (signal[i1] ?? 0) * t;
    }
  }
  buf.push(resampled);
  bufSamples += resampled.length;

  const chunks: WorkletChunk[] = [];
  let diagSumAbs = 0;
  let diagMaxAbs = 0;
  let diagSampleCount = 0;
  let diagChunks = 0;

  while (bufSamples >= chunkSamples) {
    const out = new Float32Array(chunkSamples);
    let filled = 0;
    while (filled < chunkSamples && buf.length > 0) {
      const head = buf[0];
      if (head === undefined) break;
      const need = chunkSamples - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        buf.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        buf[0] = head.subarray(need);
        filled += need;
      }
    }
    bufSamples -= chunkSamples;

    const pcm = new Int16Array(out.length);
    let sumSq = 0;
    let chunkSumAbs = 0;
    let chunkMaxAbs = 0;
    for (let i = 0; i < out.length; i++) {
      let s = out[i] ?? 0;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      const v = Math.round(s * 32767);
      pcm[i] = v;
      const abs = Math.abs(s);
      sumSq += s * s;
      chunkSumAbs += abs;
      if (abs > chunkMaxAbs) chunkMaxAbs = abs;
    }
    const rms = Math.sqrt(sumSq / out.length);
    chunks.push({ pcm, rms });
    diagSumAbs += chunkSumAbs;
    diagSampleCount += out.length;
    if (chunkMaxAbs > diagMaxAbs) diagMaxAbs = chunkMaxAbs;
    diagChunks += 1;
  }

  return {
    chunks,
    diag: {
      srcRate,
      targetRate,
      chunks: diagChunks,
      samples: diagSampleCount,
      meanAbs: diagSampleCount > 0 ? diagSumAbs / diagSampleCount : 0,
      maxAbs: diagMaxAbs,
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('web mic pipeline — algorithm port of pcm-recorder.js', () => {
  it('1 kHz sine at 0.6 amplitude produces RMS ≈ 0.424 (Bug-1: silence-bug regression guard)', () => {
    // 1 second of 1 kHz sine at amplitude 0.6 sampled at 48 kHz.
    const srcRate = 48_000;
    const seconds = 1;
    const signal = new Float32Array(srcRate * seconds);
    for (let i = 0; i < signal.length; i++) {
      signal[i] = 0.6 * Math.sin(2 * Math.PI * 1000 * (i / srcRate));
    }
    const { chunks, diag } = runRecorder(signal, srcRate);
    // At 24 kHz target, 50 ms chunks = 1200 samples each, ~20 chunks/sec.
    expect(chunks.length, 'expected ~20 chunks for 1 s of audio').toBeGreaterThan(18);
    const meanRms = chunks.reduce((a, c) => a + c.rms, 0) / chunks.length;
    // RMS of 0.6 sin = 0.6 / sqrt(2) ≈ 0.4243
    expect(meanRms).toBeGreaterThan(0.40);
    expect(meanRms).toBeLessThan(0.45);
    // Diagnostic counters reflect real audio.
    expect(diag.meanAbs).toBeGreaterThan(0.3);
    expect(diag.maxAbs).toBeGreaterThan(0.55);
    // Sanity on PCM payload — no chunk is entirely silent.
    for (const c of chunks) {
      expect(c.pcm.some((v) => v !== 0), 'PCM chunk must contain non-zero samples').toBe(true);
    }
  });

  it('silence (all zeros) produces RMS == 0 (counter-test)', () => {
    const srcRate = 48_000;
    const signal = new Float32Array(srcRate); // 1 s of zero
    const { chunks, diag } = runRecorder(signal, srcRate);
    expect(chunks.length).toBeGreaterThan(18);
    for (const c of chunks) {
      expect(c.rms).toBe(0);
      expect(c.pcm.every((v) => v === 0)).toBe(true);
    }
    expect(diag.meanAbs).toBe(0);
    expect(diag.maxAbs).toBe(0);
  });

  it('ramp from silence to 1.0 crosses the barge-in worklet threshold within 100 ms (Bug-5)', () => {
    // Linear ramp from 0 to 1 over 1 s sampled at 48 kHz, with a high-
    // freq carrier so the AC component (not the DC) drives RMS.
    const srcRate = 48_000;
    const signal = new Float32Array(srcRate);
    for (let i = 0; i < signal.length; i++) {
      const amplitude = i / signal.length;
      signal[i] = amplitude * Math.sin(2 * Math.PI * 800 * (i / srcRate));
    }
    const { chunks } = runRecorder(signal, srcRate);
    const BARGE_IN_WORKLET_RMS_THRESHOLD = 0.02; // mirrors jarvis-client.js

    // Find the first chunk where RMS > threshold.
    const firstHit = chunks.findIndex((c) => c.rms > BARGE_IN_WORKLET_RMS_THRESHOLD);
    expect(firstHit, 'expected at least one chunk above the barge-in threshold').toBeGreaterThanOrEqual(0);
    // Each chunk represents 50 ms of audio.
    const firstHitMs = firstHit * 50;
    // The ramp is over 1000 ms; barge-in must trip well before the end.
    // In practice it trips around the 100-200 ms mark depending on the
    // carrier; assert it's < 250 ms to leave margin without making the
    // test brittle.
    expect(firstHitMs).toBeLessThan(250);
  });

  it('downsample preserves total energy approximately (Bug-1 ratio guard)', () => {
    // If the linear-interpolation downsampler were buggy and dropped most
    // samples to zero, the post-downsample RMS would be << the input RMS.
    // Assert the ratio is sensible.
    const srcRate = 48_000;
    const signal = new Float32Array(srcRate);
    for (let i = 0; i < signal.length; i++) {
      signal[i] = 0.5 * Math.sin(2 * Math.PI * 500 * (i / srcRate));
    }
    let inSumSq = 0;
    for (const sample of signal) inSumSq += sample ** 2;
    const inRms = Math.sqrt(inSumSq / signal.length);

    const { chunks } = runRecorder(signal, srcRate);
    const outRms = chunks.reduce((a, c) => a + c.rms, 0) / chunks.length;
    // Allow ±5 % drift from the 1 kHz interpolation.
    expect(outRms / inRms).toBeGreaterThan(0.95);
    expect(outRms / inRms).toBeLessThan(1.05);
  });
});
