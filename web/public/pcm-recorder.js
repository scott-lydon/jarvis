// Capture worklet — buffers mic Float32 samples, downsamples to 24 kHz
// if needed, converts to 16-bit PCM, posts back as ArrayBuffer in
// ~50 ms chunks. Also computes RMS so the main thread can detect the
// user starting to speak while the agent is speaking (barge-in).

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 24000;
    this.srcRate = sampleRate;
    this.buf = [];
    this.bufSamples = 0;
    this.chunkSamples = Math.floor(this.targetRate * 0.05); // 50ms
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

      // Float32 → Int16 LE
      const pcm = new Int16Array(out.length);
      let sumSq = 0;
      for (let i = 0; i < out.length; i++) {
        let s = out[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        const v = Math.round(s * 32767);
        pcm[i] = v;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / out.length);
      this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
