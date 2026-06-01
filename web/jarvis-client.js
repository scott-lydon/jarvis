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
  // Barge-in detection. We watch TWO signals so a single noisy false
  // positive doesn't trip the playback teardown — and so a single silenced
  // mic chunk doesn't HIDE a real barge-in either.
  //   - worklet RMS (post-resample, post-quantize): trips at 0.02
  //   - mic AnalyserNode RMS (raw mic source, no quantization): trips at 0.05
  // We tear down on whichever fires first.
  const BARGE_IN_WORKLET_RMS_THRESHOLD = 0.02;
  const BARGE_IN_ANALYSER_RMS_THRESHOLD = 0.05;
  // Diagnostic: the worklet posts a one-line summary every N seconds so we
  // can see in the browser console whether real audio is reaching us.
  const MIC_DIAG_INTERVAL_MS = 2000;
  // Debug capture buffer — the LAST N seconds of mic PCM are kept in a
  // circular buffer in memory so the user can play back EXACTLY what we
  // sent upstream. Lets the user (and us) catch the case where Whisper
  // returns "you" because our audio payload is silent.
  const CAPTURE_BUFFER_SECONDS = 30;
  const CAPTURE_BUFFER_SAMPLES = TARGET_RATE * CAPTURE_BUFFER_SECONDS; // 720_000 Int16 @ 24 kHz

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

  /**
   * Wrap a mono Int16 PCM sample buffer in a RIFF/WAV header so the
   * browser (and Finder Quick Look) can play it. Keeps the helper here
   * — the client is the only thing that needs to emit WAVs.
   */
  function buildWav(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.byteLength;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    // "RIFF" + chunk size + "WAVE"
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    // "fmt " sub-chunk
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);        // sub-chunk size for PCM
    view.setUint16(20, 1, true);         // audio format = PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    // "data" sub-chunk
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    // PCM payload
    new Int16Array(buf, 44).set(samples);
    return new Blob([buf], { type: 'audio/wav' });
  }
  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
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
      this.micSource = null;
      this.micWorklet = null;
      // Mic-side analyser — drives the LevelMeter while the user is
      // listening. Separate from the playback analyser below.
      this.micAnalyser = null;
      this.micAnalyserBuf = new Uint8Array(0);
      this.micTimeBuf = new Float32Array(0);
      this.playerCtx = null;
      this.playerWorklet = null;
      // Playback-side analyser — drives the LevelMeter while Jarvis is
      // speaking. Reading from the mic during playback is wrong because
      // the user isn't speaking; reading from playback while listening is
      // wrong because there's nothing playing. _tickLevels() picks the
      // right source based on this.status.
      this.analyser = null;
      this.analyserBuf = new Uint8Array(0);
      // Last mic-diagnostic post timestamp (ms). The worklet posts one
      // sampled summary per chunk; we log once per MIC_DIAG_INTERVAL_MS.
      this._lastDiagMs = 0;

      // Circular capture buffer (Int16 LE @ 24 kHz mono). Holds the most
      // recent CAPTURE_BUFFER_SECONDS of mic audio so the user can play
      // back / download what we ACTUALLY sent upstream. Lets us see
      // whether the audio payload is real or near-silence — without that
      // visibility, Whisper returning "you" is unfalsifiable.
      this._captureBuf = new Int16Array(CAPTURE_BUFFER_SAMPLES);
      this._captureWrite = 0;     // next write index
      this._captureCount = 0;     // total samples ever written (<= CAPTURE_BUFFER_SAMPLES)
      // Bytes sent upstream (input_audio_buffer.append). Surface in dev panel.
      this._micBytesSent = 0;

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
      if (this.micAnalyser) { try { this.micAnalyser.disconnect(); } catch (_) {} this.micAnalyser = null; }
      if (this.micSource) { try { this.micSource.disconnect(); } catch (_) {} this.micSource = null; }
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
        // Bug-1 fix (2026-05-31): drop `noiseSuppression: true` and the
        // `sampleRate` constraint.
        //
        // Why: Chrome's noiseSuppression aggressively zero-fills buffers
        // that don't match its speech profile (room noise, quiet voice,
        // accented input, anything brief). When that happens upstream
        // Whisper hears silence and falls back to its most common
        // single-token output: "you". That is the EXACT symptom the user
        // saw — every utterance transcribed to "you". `echoCancellation`
        // stays ON because the playback bleeds into the mic otherwise
        // and trips fake barge-ins.
        //
        // We also let the mic deliver at its native rate (usually 48 kHz)
        // and let the AudioContext + pcm-recorder worklet handle the
        // 48→24 kHz downsample with linear interpolation. The previous
        // `sampleRate: 24000` constraint was silently ignored by every
        // browser, which produced subtle aliasing on top of the noise-
        // suppression damage.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
        this.micStream = stream;
        // Bug-B robust trigger (2026-05-31, third pass): fire onMicGranted
        // the INSTANT getUserMedia resolves. This is the only point in the
        // entire pipeline where we KNOW the user just tapped Allow — no
        // WebSocket round-trip required, no inference from a status flip.
        // The React layer uses this to dismiss the mic-intro banner with
        // zero latency.
        if (typeof this.listener.onMicGranted === 'function') {
          try { this.listener.onMicGranted(); } catch (_) { /* listener bug — ignore */ }
        }
        // Bug-G belt (2026-06-01): request 48 kHz explicitly. Chromium
        // honors this. Safari may honor it (16.4+) or silently fall
        // back to the system rate (typically 44.1 kHz on macOS) — the
        // worklet's phase-continuous resampler covers both cases. The
        // 48 kHz path is preferred because it produces an exact 2:1
        // downsample ratio (48000 / 24000 = 2.0), bypassing the
        // interpolation entirely.
        let micCtx;
        try {
          micCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: TARGET_RATE * 2 });
        } catch (_) {
          // Safari < 16 throws on the sampleRate option — fall back.
          micCtx = new AudioContext({ latencyHint: 'interactive' });
        }
        this.micCtx = micCtx;
        await this.micCtx.audioWorklet.addModule('./pcm-recorder.js');
        const src = this.micCtx.createMediaStreamSource(stream);
        this.micSource = src;

        // Mic-side analyser for the LevelMeter visualisation while
        // listening (Bug-4 fix). Hangs off the SAME source node as the
        // worklet so it sees identical audio.
        this.micAnalyser = this.micCtx.createAnalyser();
        this.micAnalyser.fftSize = 256;
        this.micAnalyser.smoothingTimeConstant = 0.6;
        this.micAnalyserBuf = new Uint8Array(this.micAnalyser.frequencyBinCount);
        this.micTimeBuf = new Float32Array(this.micAnalyser.fftSize);
        src.connect(this.micAnalyser);

        this.micWorklet = new AudioWorkletNode(this.micCtx, 'pcm-recorder', {
          processorOptions: { targetRate: TARGET_RATE, diagIntervalMs: MIC_DIAG_INTERVAL_MS },
        });
        src.connect(this.micWorklet);
        this.micWorklet.port.onmessage = (ev) => {
          const data = ev.data;
          // Diagnostic message (Bug-1 visibility): the worklet posts
          // {kind: 'diag', ...} periodically. Surface to the dev panel
          // via the listener so we can see if real audio is flowing.
          if (data && data.kind === 'diag') {
            if (typeof this.listener.onMicDiag === 'function') this.listener.onMicDiag(data);
            return;
          }
          const pcm = data.pcm;
          const rms = data.rms || 0;
          // Transparency: store every chunk we send upstream in a circular
          // buffer so the user can play back EXACTLY what was captured.
          this._appendToCaptureBuffer(pcm);
          // Bug-5 fix: dual-signal barge-in. Trip on either the worklet
          // RMS OR the analyser-time-domain RMS (raw mic, no quantize),
          // so a noise-suppressed worklet output doesn't HIDE a real
          // barge-in. The mic analyser path is checked here too.
          let analyserRms = 0;
          if (this.status === STATUS_SPEAKING) {
            analyserRms = this._readMicAnalyserRMS();
            if (rms > BARGE_IN_WORKLET_RMS_THRESHOLD || analyserRms > BARGE_IN_ANALYSER_RMS_THRESHOLD) {
              void this._handleBargeIn();
            }
          }
          // Bug-H gate (2026-06-01): while Jarvis is speaking, drop
          // low-amplitude mic chunks. Reason: macOS / iOS / Windows
          // hardware echoCancellation is imperfect — when Jarvis is
          // playing through laptop speakers, the mic captures ~10-30 %
          // of his voice back as ambient bleed, and the user has no
          // control over the residual leak. The upstream server VAD
          // then treats that bleed as user speech, opens a new turn,
          // and Whisper transcribes Jarvis's own delayed voice (or the
          // remaining un-cancelled harmonic content) as garbled vowels.
          // Gate: while speaking, only forward chunks loud enough that
          // they could plausibly be the user actually barging in
          // (analyser RMS > 0.04 OR worklet RMS > 0.02). Below that, we
          // skip the upstream append — we have NOT seen a real user
          // barge-in, and we don't want server-side VAD picking up the
          // bleed. We still keep the chunk in the local capture buffer
          // for transparency (so DevSignalPanel WAV download is honest).
          if (this.status === STATUS_SPEAKING
              && rms < BARGE_IN_WORKLET_RMS_THRESHOLD
              && analyserRms < BARGE_IN_ANALYSER_RMS_THRESHOLD) {
            return;
          }
          const base64 = arrayBufferToBase64(pcm);
          this._micBytesSent += base64.length;
          this._sendUpstream({ type: 'input_audio_buffer.append', audio: base64 });
        };
      }
      await this._setupPlayback();
      if (this.micCtx && this.micCtx.state === 'suspended') await this.micCtx.resume();
    }

    // Read the raw time-domain RMS from the mic analyser. Returns 0 when
    // the analyser is not yet attached.
    _readMicAnalyserRMS() {
      if (!this.micAnalyser || !this.micTimeBuf) return 0;
      this.micAnalyser.getFloatTimeDomainData(this.micTimeBuf);
      let sumSq = 0;
      for (let i = 0; i < this.micTimeBuf.length; i++) {
        const s = this.micTimeBuf[i];
        sumSq += s * s;
      }
      return Math.sqrt(sumSq / this.micTimeBuf.length);
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
    //
    // Bug-4 fix: pick the right analyser source for the current state.
    //   - listening / thinking → MIC analyser (user's voice waves)
    //   - speaking             → PLAYBACK analyser (jarvis' voice waves)
    //   - idle / interrupted   → flat low levels (no source to read)
    //
    // The design's MicButton only RENDERS the LevelMeter while listening,
    // but we keep emitting a sensible value across all states so the
    // React useState reflects ground truth and tests can assert on it.
    _tickLevels() {
      const n = 7;
      const tick = () => {
        let out = null;
        if (this.status === STATUS_SPEAKING && this.analyser) {
          this.analyser.getByteFrequencyData(this.analyserBuf);
          const groupSize = Math.max(1, Math.floor(this.analyserBuf.length / n));
          out = new Array(n);
          for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < groupSize; j++) sum += this.analyserBuf[i * groupSize + j] || 0;
            out[i] = (sum / groupSize) / 255;
          }
        } else if ((this.status === STATUS_LISTENING || this.status === STATUS_THINKING) && this.micAnalyser) {
          this.micAnalyser.getByteFrequencyData(this.micAnalyserBuf);
          // The mic spectrum is heavily weighted to low frequencies. Read
          // the FFT below ~4 kHz where speech actually sits, split into 7
          // log-spaced bins so the visual differentiates vowels/consonants
          // instead of all-bars-equal.
          const speechMax = Math.min(this.micAnalyserBuf.length, Math.floor(this.micAnalyserBuf.length * 0.5));
          out = new Array(n);
          for (let i = 0; i < n; i++) {
            // Geometric bin spacing keeps low energy from dominating.
            const lo = Math.floor(Math.pow(i / n, 1.4) * speechMax);
            const hi = Math.floor(Math.pow((i + 1) / n, 1.4) * speechMax);
            let sum = 0, count = 0;
            for (let j = lo; j < hi; j++) { sum += this.micAnalyserBuf[j] || 0; count += 1; }
            const v = count > 0 ? (sum / count) / 255 : 0;
            // Stretch — the analyser's pre-normalised 0..1 sits in 0.05..0.4
            // for typical speech; map to 0.1..1 so the bars actually wiggle.
            out[i] = Math.max(0.08, Math.min(1, v * 2.8));
          }
        }
        if (out && typeof this.listener.onMicLevels === 'function') {
          this.listener.onMicLevels(out);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    // ── Capture-buffer + playback (signal-flow transparency) ─────
    //
    // Public surface for the dev panel:
    //   getCaptureSnapshot()  → { samples: Int16Array, sampleRate, durationSec }
    //   playCapture()         → audible playback of the captured PCM
    //   downloadCaptureWav()  → triggers a browser download of jarvis-capture.wav
    //
    // Every mic chunk that we send upstream is ALSO written into a
    // 30-second circular buffer. Lets the user verify whether real
    // audio reached the WebSocket — if playback sounds like silence,
    // the failure is in the mic / browser audio stack, not in Whisper.

    _appendToCaptureBuffer(pcmArrayBuffer) {
      // Incoming buffer is the Int16 LE PCM the worklet posted (already
      // detached from the worklet thread; safe to read).
      const incoming = new Int16Array(pcmArrayBuffer);
      const cap = this._captureBuf.length;
      let writeIdx = this._captureWrite;
      // Linear copy with wrap. For 50 ms chunks (~1200 samples) this is
      // cheap; for big chunks this could be split into two .set() calls
      // but the current 1200-sample shape never wraps in one go after
      // the first lap, so keep it readable.
      for (let i = 0; i < incoming.length; i++) {
        this._captureBuf[writeIdx] = incoming[i] || 0;
        writeIdx += 1;
        if (writeIdx >= cap) writeIdx = 0;
      }
      this._captureWrite = writeIdx;
      this._captureCount = Math.min(this._captureCount + incoming.length, cap);
    }

    /**
     * Return the captured PCM in chronological order (oldest sample first).
     * Returns null if nothing has been captured yet.
     */
    getCaptureSnapshot() {
      if (this._captureCount === 0) return null;
      const cap = this._captureBuf.length;
      const startIdx = this._captureCount < cap
        ? 0
        : this._captureWrite; // oldest is the next write slot
      const out = new Int16Array(this._captureCount);
      let readIdx = startIdx;
      for (let i = 0; i < this._captureCount; i++) {
        out[i] = this._captureBuf[readIdx];
        readIdx += 1;
        if (readIdx >= cap) readIdx = 0;
      }
      return {
        samples: out,
        sampleRate: TARGET_RATE,
        durationSec: this._captureCount / TARGET_RATE,
        bytesSent: this._micBytesSent,
      };
    }

    /**
     * Play the captured PCM through a one-shot AudioContext so the user
     * can HEAR what we sent upstream. Resolves when playback ends, or
     * rejects on a missing buffer / Web-Audio failure.
     */
    async playCapture() {
      const snap = this.getCaptureSnapshot();
      if (!snap) throw new Error('Nothing captured yet — start a session and speak first.');
      const ctx = new AudioContext({ sampleRate: snap.sampleRate });
      const buffer = ctx.createBuffer(1, snap.samples.length, snap.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < snap.samples.length; i++) channel[i] = snap.samples[i] / 32768;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      await new Promise((resolve) => {
        node.onended = () => { resolve(); };
        node.start();
      });
      await ctx.close();
    }

    /**
     * Build a WAV (RIFF) blob from the captured PCM and trigger a
     * browser download.
     */
    downloadCaptureWav(filename) {
      const snap = this.getCaptureSnapshot();
      if (!snap) throw new Error('Nothing captured yet — start a session and speak first.');
      const wav = buildWav(snap.samples, snap.sampleRate);
      const url = URL.createObjectURL(wav);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `jarvis-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a tick so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
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
