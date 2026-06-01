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
    // Bug-G fix (2026-06-01): chunk-boundary continuity for non-integer
    // downsample ratios. Each Web Audio render quantum delivers 128
    // input samples to process(). At srcRate=44100 → targetRate=24000
    // the ratio is 1.8375; 128 / 1.8375 = 69.66... output samples per
    // chunk. The previous implementation rounded down to 69 and
    // restarted at input-position 0 on the next call, discarding the
    // remaining 0.66 sample and creating a phase discontinuity at the
    // chunk boundary. That discontinuity repeats at the render-quantum
    // rate (~370 Hz on Safari/macOS @ 44.1 kHz: 48000/128) — exactly in
    // the vowel-formant band — and Whisper transcribes the resulting
    // periodic artifact as sustained vowels ("aaaaaaaa"), regardless of
    // what the user actually said.
    //
    // Fix: carry the fractional read position across process() calls.
    // The next chunk starts reading at posOffset, which is the residual
    // sub-sample offset left over from the previous chunk. Combined
    // with the input carry-over buffer (this.prevTail), the resampler
    // becomes globally continuous — no phase jumps, no 370 Hz buzz.
    this.posOffset = 0;          // fractional input-sample offset to start next chunk
    this.prevTail = null;        // last few input samples carried into next call so interpolation can read across the boundary
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

    // Downsample if the input rate ≠ target rate.
    //
    // Bug-G fix (2026-06-01): phase-continuous linear interpolation
    // across render-quantum boundaries. See constructor comment for the
    // root-cause analysis ("aaaaaaaa" Whisper transcripts on Safari).
    //
    // Glue this.prevTail (last 2 input samples from the previous call)
    // to the front of `mono` so the interpolation can read across the
    // boundary without snapping back to index 0. The interpolation
    // position is `this.posOffset` (sub-sample fraction left over from
    // the previous chunk), and we walk forward at `ratio` per output
    // sample until the position exceeds the available input window.
    let resampled;
    if (this.srcRate === this.targetRate) {
      // No resample needed; clear the carry-over state to be safe.
      resampled = mono;
      this.posOffset = 0;
      this.prevTail = null;
    } else {
      const ratio = this.srcRate / this.targetRate;
      // Construct the working window: prevTail (2 samples) + mono.
      // The carry-over lets interpolation read mono[-1] and mono[-2]
      // virtually so a boundary read at pos<2 doesn't reset to mono[0].
      let work;
      let baseOffsetInMono;
      if (this.prevTail !== null && this.prevTail.length > 0) {
        work = new Float32Array(this.prevTail.length + mono.length);
        work.set(this.prevTail, 0);
        work.set(mono, this.prevTail.length);
        baseOffsetInMono = this.prevTail.length; // index of mono[0] inside `work`
      } else {
        work = mono;
        baseOffsetInMono = 0;
      }
      // The pos coordinate is in `work`'s index space. We start at the
      // posOffset that was set last time (interpreted as offset into
      // the new chunk's input). prevTail carried 2 samples, so the
      // effective starting position in `work` is baseOffsetInMono +
      // posOffset, MINUS the tail length so the absolute global phase
      // stays continuous. In practice: posOffset already represents
      // "how far past the previous chunk's last consumed input we
      // would have stepped" — so starting at (baseOffsetInMono - tail) +
      // posOffset = posOffset within `work` works out to be the correct
      // continuation point.
      const startPos = this.posOffset; // already in `work` coordinates
      // Compute how many output samples fit before pos overruns the
      // last interpolatable index (work.length - 1, because i1 = i0+1).
      const lastReadablePos = work.length - 1;
      const outLen = startPos > lastReadablePos
        ? 0
        : Math.floor((lastReadablePos - startPos) / ratio) + 1;
      resampled = new Float32Array(outLen);
      let lastPos = startPos;
      for (let i = 0; i < outLen; i++) {
        const pos = startPos + i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(work.length - 1, i0 + 1);
        const t = pos - i0;
        resampled[i] = work[i0] * (1 - t) + work[i1] * t;
        lastPos = pos;
      }
      // For the NEXT process() call, prevTail = last 2 samples of `mono`
      // (NOT of `work`, because the next call's incoming `mono` joins
      // directly after these). posOffset is the residual sub-sample
      // distance into the next call's `work` window where we want to
      // start reading.
      const tailLen = Math.min(2, mono.length);
      this.prevTail = mono.slice(mono.length - tailLen);
      // The position we would have stepped to next is `lastPos + ratio`,
      // expressed in this call's `work` coordinates. Translate that
      // into the NEXT call's `work` coordinates:
      //   - next call's work = prevTail (tailLen) + new mono
      //   - the sample at this call's `work` index (work.length - tailLen + j)
      //     is the same sample as next call's work[j].
      // So next pos in next call's coords = (lastPos + ratio) - (work.length - tailLen)
      const nextAbsolutePos = lastPos + ratio;
      this.posOffset = nextAbsolutePos - (work.length - tailLen);
      // Clamp: if upstream pauses momentarily and posOffset drifts off
      // the end of `work`, reset to 0 so we don't get stuck.
      if (this.posOffset < 0) this.posOffset = 0;
      // If posOffset is somehow huge (shouldn't happen with continuous
      // 128-sample chunks), wrap it back via modulo on ratio.
      if (this.posOffset > tailLen + ratio) this.posOffset = this.posOffset % ratio;
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
