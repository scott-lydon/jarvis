// Playback worklet — accepts {type:"chunk", samples: Float32Array} from
// the main thread, queues them, drains one sample per output frame.
// Supports {type:"clear"} for barge-in (US-04): drops the queue and
// snaps to silence within one render quantum (~3 ms at 24 kHz).

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} */
    this.queue = [];
    this.queueOffset = 0;
    this.port.onmessage = (ev) => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'chunk' && data.samples instanceof Float32Array) {
        this.queue.push(data.samples);
      } else if (data.type === 'clear') {
        this.queue.length = 0;
        this.queueOffset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const channel = out[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      if (this.queue.length === 0) { channel[i] = 0; continue; }
      const head = this.queue[0];
      channel[i] = head[this.queueOffset];
      this.queueOffset += 1;
      if (this.queueOffset >= head.length) {
        this.queue.shift();
        this.queueOffset = 0;
      }
    }
    // Duplicate to all channels if multi-channel sink.
    for (let c = 1; c < out.length; c++) out[c].set(channel);
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor);
