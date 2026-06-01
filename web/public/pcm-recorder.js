// Capture worklet — buffers mic Float32 samples, downsamples to 24 kHz
// if needed, converts to 16-bit PCM, posts back as ArrayBuffer in
// ~50 ms chunks. Also computes RMS so the main thread can detect the
// user starting to speak while the agent is speaking (barge-in).
//
// Bug-1 visibility fix (2026-05-31): emit a periodic {kind:'diag'}
// message containing the captured chunk count, average abs, max abs,
// and the AudioContext sample rate. Lets the browser console (and the
// integration test) confirm REAL audio is flowing — silent input
// produces all-zero diagnostics, distinguishable from a working mic.

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 24000;
    // Set explicitly so the main thread can sanity-check it.
    this.srcRate = sampleRate;
    this.diagIntervalMs = opts.diagIntervalMs || 2000;
    this.buf = [];
    this.bufSamples = 0;
    this.chunkSamples = Math.floor(this.targetRate * 0.05); // 50ms
    // Diagnostic accumulators (reset every diagIntervalMs).
    this.diagChunks = 0;
    this.diagSumAbs = 0;
    this.diagMaxAbs = 0;
    this.diagSampleCount = 0;
    this.diagStartedAt = currentTime * 1000; // ms
    // Post the first diag eagerly so the main thread sees that audio
    // is flowing within the first chunk window. Without this, the
    // first 2s of a session look indistinguishable from silence.
    this._postedFirstDiag = false;
  }

  _maybePostDiag() {
    const nowMs = currentTime * 1000;
    if (this._postedFirstDiag && (nowMs - this.diagStartedAt) < this.diagIntervalMs) return;
    const mean = this.diagSampleCount > 0 ? this.diagSumAbs / this.diagSampleCount : 0;
    this.port.postMessage({
      kind: 'diag',
      srcRate: this.srcRate,
      targetRate: this.targetRate,
      chunks: this.diagChunks,
      samples: this.diagSampleCount,
      meanAbs: mean,
      maxAbs: this.diagMaxAbs,
      elapsedMs: nowMs - this.diagStartedAt,
    });
    this.diagChunks = 0;
    this.diagSumAbs = 0;
    this.diagMaxAbs = 0;
    this.diagSampleCount = 0;
    this.diagStartedAt = nowMs;
    this._postedFirstDiag = true;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Mix to mono if stereo (already 1ch above but defensive).
    const mono = channel;

    // Downsample if the input rate ≠ target rate. Simple decimation
    // with a leading low-pass would be ideal; for MVP we use linear
    // interpolation which is fine at the 48k→24k ratio Realtime sees.
    let resampled;
    if (this.srcRate === this.targetRate) {
      resampled = mono;
    } else {
      const ratio = this.srcRate / this.targetRate;
      const outLen = Math.floor(mono.length / ratio);
      resampled = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(mono.length - 1, i0 + 1);
        const t = pos - i0;
        resampled[i] = mono[i0] * (1 - t) + mono[i1] * t;
      }
    }

    this.buf.push(resampled);
    this.bufSamples += resampled.length;

    while (this.bufSamples >= this.chunkSamples) {
      const out = new Float32Array(this.chunkSamples);
      let filled = 0;
      while (filled < this.chunkSamples && this.buf.length > 0) {
        const head = this.buf[0];
        const need = this.chunkSamples - filled;
        if (head.length <= need) {
          out.set(head, filled);
          filled += head.length;
          this.buf.shift();
        } else {
          out.set(head.subarray(0, need), filled);
          this.buf[0] = head.subarray(need);
          filled += need;
        }
      }
      this.bufSamples -= this.chunkSamples;

      // Float32 → Int16 LE + RMS + diagnostics
      const pcm = new Int16Array(out.length);
      let sumSq = 0;
      let chunkSumAbs = 0;
      let chunkMaxAbs = 0;
      for (let i = 0; i < out.length; i++) {
        let s = out[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        const v = Math.round(s * 32767);
        pcm[i] = v;
        const abs = Math.abs(s);
        sumSq += s * s;
        chunkSumAbs += abs;
        if (abs > chunkMaxAbs) chunkMaxAbs = abs;
      }
      const rms = Math.sqrt(sumSq / out.length);

      // Update diagnostic accumulators BEFORE posting the chunk so a
      // late-arriving listener still sees the data.
      this.diagChunks += 1;
      this.diagSumAbs += chunkSumAbs;
      this.diagSampleCount += out.length;
      if (chunkMaxAbs > this.diagMaxAbs) this.diagMaxAbs = chunkMaxAbs;

      this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    }

    this._maybePostDiag();
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
