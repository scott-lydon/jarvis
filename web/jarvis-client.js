// jarvis-client.js — vanilla-JS client that owns the WebSocket, the mic
// capture pipeline, the playback pipeline, and the barge-in path.
//
// Exposes `window.JarvisClient` as a constructor consumed by web/main.jsx.
// Callbacks (state, transcript, tool result, error, barge-in) flow back to
// React via the listener object passed into the constructor — keeping the
// audio engine framework-agnostic.
//
// Barge-in (US-04) is the critical fix in this file. The old approach was
// to post {type: 'clear'} to the playback worklet, which drops the JS-side
// queue. That is necessary but NOT sufficient: AudioContext's hardware /
// output buffer keeps playing whatever was already scheduled, so the user
// still hears 100-300ms of trailing audio. The fix here is a HARD reset:
//
//   1. close() the playback AudioContext (kills the output buffer too).
//   2. recreate a fresh AudioContext + pcm-player worklet + analyser.
//   3. From that point new response.audio.delta chunks land in the fresh
//      context and play normally.
//
// Combined with the proxy's `response.cancel` upstream (already in place),
// this gets <100ms of silence on every barge-in we have measured.

(function () {
  const STATUS_IDLE        = 'idle';
  const STATUS_LISTENING   = 'listening';
  const STATUS_THINKING    = 'thinking';
  const STATUS_SPEAKING    = 'speaking';
  const STATUS_INTERRUPTED = 'interrupted';

  const TARGET_RATE      = 24000;
  const MAX_RETRIES      = 3;
  const RETRY_BACKOFF_MS = 1000;
  // RMS threshold above which we treat captured mic audio as "user is
  // actively speaking right now" while we're playing back. Tuned in the
  // Slice-6 barge-in test; the player worklet posts back smoothed RMS so
  // this is robust to brief room noise.
  const BARGE_IN_RMS_THRESHOLD = 0.04;

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + chunk)));
    }
    return btoa(bin);
  }
  function base64ToUint8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  class JarvisClient {
    constructor(listener) {
      this.listener = listener || {};
      // Persist a stable userId so cross-session memory works.
      let uid = localStorage.getItem('jarvis.userId');
      if (!uid) {
        uid = crypto.randomUUID();
        localStorage.setItem('jarvis.userId', uid);
      }
      this.userId = uid;

      this.ws = null;
      this.micCtx = null;
      this.micStream = null;
      this.micWorklet = null;
      this.playerCtx = null;
      this.playerWorklet = null;
      this.analyser = null;
      this.analyserBuf = new Uint8Array(0);

      this.status = STATUS_IDLE;
      this.active = false;
      this.retriesUsed = 0;
      this.intentionalClose = false;
      this.demoMode = false;
      // Set true on barge-in to ignore audio deltas that may still be in
      // flight while we tear down + rebuild the playback context.
      this.suppressDeltas = false;

      this._tickLevels();
    }

    isActive() { return this.active; }

    // ── Status helper ────────────────────────────────────────────
    _setStatus(s) {
      this.status = s;
      if (typeof this.listener.onState === 'function') this.listener.onState(s);
    }

    // ── Start / stop ─────────────────────────────────────────────
    async start() {
      if (this.active) return;
      this.active = true;
      this.demoMode = false;
      this.intentionalClose = false;
      this.retriesUsed = 0;
      this._setStatus(STATUS_LISTENING);
      try {
        await this._openAudio({ withMic: true });
        this._openSocket();
      } catch (cause) {
        const isPermDenied = (cause && cause.name === 'NotAllowedError');
        const message = (cause && cause.message) ? cause.message : String(cause);
        if (isPermDenied && typeof this.listener.onMicPermissionDenied === 'function') {
          this.listener.onMicPermissionDenied(message);
        } else if (typeof this.listener.onError === 'function') {
          this.listener.onError('Failed to start', message);
        }
        this.active = false;
        this._setStatus(STATUS_IDLE);
      }
    }

    async startDemo() {
      if (this.active) return;
      this.active = true;
      this.demoMode = true;
      this.intentionalClose = false;
      this.retriesUsed = 0;
      this._setStatus(STATUS_LISTENING);
      try {
        await this._openAudio({ withMic: false });
        this._openSocket();
      } catch (cause) {
        const message = (cause && cause.message) ? cause.message : String(cause);
        if (typeof this.listener.onError === 'function') {
          this.listener.onError('Failed to start demo', message);
        }
        this.active = false;
        this.demoMode = false;
        this._setStatus(STATUS_IDLE);
        throw cause;
      }
    }

    async stop() {
      this.active = false;
      this.demoMode = false;
      this.intentionalClose = true;
      if (this.ws) {
        try { this.ws.close(1000, 'user_stopped'); } catch (_) {}
        this.ws = null;
      }
      if (this.micWorklet) { try { this.micWorklet.disconnect(); } catch (_) {} this.micWorklet = null; }
      if (this.micStream) {
        const tracks = this.micStream.getTracks();
        for (let i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (_) {} }
        this.micStream = null;
      }
      if (this.micCtx) { try { await this.micCtx.close(); } catch (_) {} this.micCtx = null; }
      await this._teardownPlayback();
      this._setStatus(STATUS_IDLE);
    }

    // ── Audio open / teardown ────────────────────────────────────
    async _openAudio(opts) {
      if (opts && opts.withMic) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: TARGET_RATE },
          video: false,
        });
        this.micStream = stream;
        this.micCtx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
        await this.micCtx.audioWorklet.addModule('./pcm-recorder.js');
        const src = this.micCtx.createMediaStreamSource(stream);
        this.micWorklet = new AudioWorkletNode(this.micCtx, 'pcm-recorder', {
          processorOptions: { targetRate: TARGET_RATE },
        });
        src.connect(this.micWorklet);
        this.micWorklet.port.onmessage = (ev) => {
          const pcm = ev.data.pcm;
          const rms = ev.data.rms;
          // Barge-in: user is speaking while Jarvis is speaking. Trigger
          // the HARD playback teardown + the upstream cancel.
          if (this.status === STATUS_SPEAKING && rms > BARGE_IN_RMS_THRESHOLD) {
            void this._handleBargeIn();
          }
          this._sendUpstream({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(pcm) });
        };
      }
      await this._setupPlayback();
      if (this.micCtx && this.micCtx.state === 'suspended') await this.micCtx.resume();
    }

    async _setupPlayback() {
      this.playerCtx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
      await this.playerCtx.audioWorklet.addModule('./pcm-player.js');
      this.playerWorklet = new AudioWorkletNode(this.playerCtx, 'pcm-player');
      this.analyser = this.playerCtx.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyserBuf = new Uint8Array(this.analyser.frequencyBinCount);
      this.playerWorklet.connect(this.analyser);
      this.analyser.connect(this.playerCtx.destination);
      if (this.playerCtx.state === 'suspended') await this.playerCtx.resume();
    }

    async _teardownPlayback() {
      if (this.playerWorklet) {
        try { this.playerWorklet.port.postMessage({ type: 'clear' }); } catch (_) {}
        try { this.playerWorklet.disconnect(); } catch (_) {}
        this.playerWorklet = null;
      }
      if (this.analyser) {
        try { this.analyser.disconnect(); } catch (_) {}
        this.analyser = null;
      }
      if (this.playerCtx) {
        try { await this.playerCtx.close(); } catch (_) {}
        this.playerCtx = null;
      }
    }

    // ── Barge-in: hard reset playback path. The only path that gives <100ms
    //    of silence on Web Audio. ─────────────────────────────────────────
    async _handleBargeIn() {
      // Idempotency guard: rms can fire many times in the same 50ms chunk
      // window while we're already tearing down. Suppress until the new
      // context is up.
      if (this.suppressDeltas) return;
      this.suppressDeltas = true;
      // Tell the model to stop generating right now (server already wired).
      this._sendUpstream({ type: 'jarvis.barge_in' });
      // 1) Kill the playback context entirely (kills the hardware buffer).
      await this._teardownPlayback();
      // 2) Notify React so it can flash 'interrupted'.
      if (typeof this.listener.onBargeIn === 'function') this.listener.onBargeIn();
      // 3) Rebuild a fresh playback path so the NEXT response can play.
      try {
        await this._setupPlayback();
      } catch (cause) {
        if (typeof this.listener.onError === 'function') {
          this.listener.onError('Playback reset failed', (cause && cause.message) || String(cause));
        }
      } finally {
        this.suppressDeltas = false;
      }
    }

    // ── WebSocket ────────────────────────────────────────────────
    _openSocket() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${location.host}/realtime`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.retriesUsed = 0;
        this._sendUpstream({ type: 'jarvis.client_hello', userId: this.userId });
      });
      ws.addEventListener('close', (e) => {
        if (this.intentionalClose || !this.active) return;
        if (this.retriesUsed < MAX_RETRIES) {
          this.retriesUsed += 1;
          const delayMs = RETRY_BACKOFF_MS * this.retriesUsed;
          window.setTimeout(() => {
            if (this.active && !this.intentionalClose) this._openSocket();
          }, delayMs);
        } else {
          if (typeof this.listener.onError === 'function') {
            this.listener.onError(
              'Connection lost',
              `Failed after ${MAX_RETRIES} retries (code ${e.code})`,
            );
          }
        }
      });
      ws.addEventListener('error', () => {
        // Logged via close handler.
      });
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string' || ev.data.length === 0) return;
        let evt;
        try { evt = JSON.parse(ev.data); } catch (_) { return; }
        this._handleServerEvent(evt);
      });
    }

    _sendUpstream(evt) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.send(JSON.stringify(evt)); } catch (_) {}
    }

    // ── Server event handling ─────────────────────────────────────
    _handleServerEvent(evt) {
      const type = evt.type;
      switch (type) {
        case 'jarvis.session_ready':
          if (evt.userId) {
            this.userId = evt.userId;
            localStorage.setItem('jarvis.userId', this.userId);
            if (typeof this.listener.onSessionReady === 'function') {
              this.listener.onSessionReady(this.userId);
            }
          }
          this._setStatus(STATUS_LISTENING);
          return;

        case 'jarvis.filler':
          this._setStatus(STATUS_THINKING);
          if (typeof this.listener.onFiller === 'function') {
            this.listener.onFiller(evt.text || '', evt.tool || 'unknown');
          }
          return;

        case 'jarvis.tool_result':
          if (typeof this.listener.onToolResult === 'function') {
            this.listener.onToolResult(
              evt.tool || 'unknown',
              evt.ok !== false,
              typeof evt.durationMs === 'number' ? evt.durationMs : 0,
              evt.result,
            );
          }
          return;

        case 'jarvis.upstream_closed':
          if (typeof this.listener.onError === 'function') {
            this.listener.onError('Upstream closed', `code=${evt.code} reason=${evt.reason || ''}`);
          }
          return;

        case 'jarvis.error':
          if (typeof this.listener.onError === 'function') {
            this.listener.onError('Server error', evt.message || evt.error || 'unknown');
          }
          return;

        case 'response.audio.delta':
          // Drop deltas that are in flight during a barge-in teardown — they
          // would re-fill the queue we just killed. Status flip to speaking
          // happens AFTER the suppress check so the UI doesn't flicker.
          if (this.suppressDeltas) return;
          this._setStatus(STATUS_SPEAKING);
          this._enqueuePcm(evt.delta);
          return;

        case 'response.audio.done':
          this._setStatus(STATUS_LISTENING);
          return;

        case 'response.audio_transcript.done':
          if (typeof this.listener.onAssistantTurn === 'function') {
            this.listener.onAssistantTurn(evt.transcript || '');
          }
          return;

        case 'conversation.item.input_audio_transcription.completed':
          if (typeof this.listener.onUserTurn === 'function') {
            const text = evt.transcript || '';
            if (text.length > 0) this.listener.onUserTurn(text);
          }
          return;

        case 'input_audio_buffer.speech_started':
          this._setStatus(STATUS_LISTENING);
          return;

        case 'input_audio_buffer.speech_stopped':
          this._setStatus(STATUS_THINKING);
          return;

        case 'error':
          if (typeof this.listener.onError === 'function') {
            const msg = (evt.error && evt.error.message) || 'upstream error';
            this.listener.onError('Upstream error', msg);
          }
          return;

        default:
          // Many events flow through (rate_limits, response.created, etc.) — ignore.
          return;
      }
    }

    _enqueuePcm(base64) {
      if (!this.playerWorklet || !base64) return;
      const bytes = base64ToUint8(base64);
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const f32 = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        f32[i] = (samples[i] || 0) / 32768;
      }
      try {
        this.playerWorklet.port.postMessage({ type: 'chunk', samples: f32 }, [f32.buffer]);
      } catch (_) {
        // Worklet may have just been torn down during a barge-in — ignore.
      }
    }

    // ── Levels tick (drives the MicButton LevelMeter) ────────────
    _tickLevels() {
      const tick = () => {
        if (this.analyser) {
          this.analyser.getByteFrequencyData(this.analyserBuf);
          const n = 7;
          const groupSize = Math.max(1, Math.floor(this.analyserBuf.length / n));
          const out = new Array(n);
          for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < groupSize; j++) sum += this.analyserBuf[i * groupSize + j] || 0;
            out[i] = (sum / groupSize) / 255;
          }
          if (typeof this.listener.onMicLevels === 'function') this.listener.onMicLevels(out);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    // ── Demo manifest harness (preserved Slice 9 behavior) ───────
    async runDemo(manifestUrlOrObject) {
      let manifest;
      if (typeof manifestUrlOrObject === 'string') {
        const res = await fetch(manifestUrlOrObject);
        if (!res.ok) {
          if (typeof this.listener.onError === 'function') {
            this.listener.onError('Demo fetch failed', `status ${res.status}`);
          }
          return;
        }
        manifest = await res.json();
      } else {
        manifest = manifestUrlOrObject;
      }
      await this.startDemo();
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const steps = manifest.steps || [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.delayMs && step.delayMs > 0) {
          await new Promise((r) => window.setTimeout(r, step.delayMs));
        }
        if (step.text && step.text.length > 0) {
          this._sendUpstream({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: step.text }],
            },
          });
          this._sendUpstream({ type: 'response.create' });
        }
      }
    }
  }

  window.JarvisClient = JarvisClient;
})();
