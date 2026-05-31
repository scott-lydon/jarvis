// Jarvis web client — voice loop.
//
// Architecture:
//   - One WebSocket to /realtime carries OpenAI Realtime events both ways
//     plus a few `jarvis.*` local-control events.
//   - Mic capture: getUserMedia → AudioContext @ 24 kHz → mic-capture
//     AudioWorklet that downsamples to Int16 PCM and posts back to main
//     thread. Main thread base64-encodes and pushes
//     `input_audio_buffer.append` frames upstream.
//   - Audio playback: server `response.audio.delta` (already renamed from
//     `response.output_audio.delta` by the proxy) carries base64 PCM16
//     @ 24 kHz. Decoded into Float32 and queued to a pcm-player worklet.
//   - Bars: AnalyserNode on the playback bus + animation frame loop.
//   - Barge-in: when the mic worklet flags RMS > VAD threshold AND we
//     are currently in `speaking` state, the client (a) clears its own
//     play queue (≤200ms target, US-04), (b) sends a `jarvis.barge_in`
//     event so the proxy emits `response.cancel` upstream (≤300ms target).
//
// Persistence: userId is stored in localStorage so the same browser
// hits the same memory row across reloads.

const STATUS_IDLE = 'idle';
const STATUS_LISTENING = 'listening';
const STATUS_THINKING = 'thinking';
const STATUS_SPEAKING = 'speaking';
const STATUS_ERROR = 'error';
type Status = typeof STATUS_IDLE | typeof STATUS_LISTENING | typeof STATUS_THINKING | typeof STATUS_SPEAKING | typeof STATUS_ERROR;

const TARGET_RATE = 24_000;
const NUM_BARS = 32;

interface JarvisToolResult { type: 'jarvis.tool_result'; tool: string; ok: boolean; durationMs: number; result: unknown }
interface JarvisFiller { type: 'jarvis.filler'; text: string; tool: string }
interface JarvisSessionReady { type: 'jarvis.session_ready'; userId: string }
interface JarvisUpstreamClosed { type: 'jarvis.upstream_closed'; code: number; reason: string }
interface JarvisErrorEvt { type: 'jarvis.error'; error: string; message?: string }
interface AudioDelta { type: 'response.audio.delta'; delta: string }
interface AudioDone { type: 'response.audio.done' }
interface SpeechStarted { type: 'input_audio_buffer.speech_started' }
interface SpeechStopped { type: 'input_audio_buffer.speech_stopped' }
interface ErrEvt { type: 'error'; error?: { message?: string } }

type ServerEvent =
  | JarvisToolResult
  | JarvisFiller
  | JarvisSessionReady
  | JarvisUpstreamClosed
  | JarvisErrorEvt
  | AudioDelta
  | AudioDone
  | SpeechStarted
  | SpeechStopped
  | ErrEvt
  | { type: string; [k: string]: unknown };

class JarvisClient {
  private ws: WebSocket | null = null;
  private micCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micWorklet: AudioWorkletNode | null = null;
  private playerCtx: AudioContext | null = null;
  private playerWorklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private status: Status = STATUS_IDLE;
  private active = false;
  private userId: string;
  private barEls: HTMLElement[] = [];
  private analyserBuf = new Uint8Array(0);
  private capturedSamplesSinceCommit = 0;

  constructor() {
    this.userId = localStorage.getItem('jarvis.userId') ?? crypto.randomUUID();
    localStorage.setItem('jarvis.userId', this.userId);
    this.setupBars();
    this.setupButton();
    this.tickBars();
    this.devSetUser();
    this.fetchCaps();
  }

  private setupBars(): void {
    const host = document.getElementById('bars');
    if (host === null) return;
    for (let i = 0; i < NUM_BARS; i++) {
      const el = document.createElement('span');
      el.className = 'bar';
      host.appendChild(el);
      this.barEls.push(el);
    }
  }

  private setupButton(): void {
    const btn = document.getElementById('mic-btn') as HTMLButtonElement | null;
    if (btn === null) return;
    btn.addEventListener('click', () => {
      if (this.active) void this.stop(); else void this.start();
    });
  }

  private setStatus(s: Status, caption?: string): void {
    this.status = s;
    const el = document.getElementById('status-pill');
    if (el !== null) {
      el.className = `status status-${s}`;
      el.textContent = s;
    }
    const cap = document.getElementById('caption');
    if (cap !== null && caption !== undefined) cap.textContent = caption;
  }

  private devLog(line: string): void {
    const pre = document.getElementById('dev-events');
    if (pre === null) return;
    const ts = new Date().toISOString().slice(11, 19);
    pre.textContent = `${ts}  ${line}\n${pre.textContent ?? ''}`.slice(0, 4000);
  }

  private devSetConn(state: string): void {
    const p = document.getElementById('dev-conn');
    if (p !== null) p.textContent = state;
  }

  private devSetUser(): void {
    const p = document.getElementById('dev-userid');
    if (p !== null) p.textContent = `user: ${this.userId}`;
  }

  private async fetchCaps(): Promise<void> {
    try {
      const res = await fetch('/healthz');
      if (!res.ok) return;
      const json = await res.json() as { capabilities: Array<{ name: string; available: boolean }> };
      const enabled = json.capabilities.filter((c) => c.available).map((c) => c.name);
      const chip = document.getElementById('cap-chip');
      if (chip !== null) {
        chip.textContent = enabled.length === 0
          ? 'capabilities: none'
          : `capabilities: ${enabled.join(', ')}`;
      }
    } catch {
      // server not up yet — ignore.
    }
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const btn = document.getElementById('mic-btn') as HTMLButtonElement | null;
    if (btn !== null) {
      btn.setAttribute('aria-pressed', 'true');
      const label = btn.querySelector('.mic-label');
      if (label !== null) label.textContent = 'Tap to stop';
    }
    this.setStatus(STATUS_LISTENING, 'Connecting…');
    try {
      await this.openAudio();
      this.openSocket();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.setStatus(STATUS_ERROR, `Failed to start: ${message}`);
      this.devLog(`start failed: ${message}`);
      this.active = false;
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    const btn = document.getElementById('mic-btn') as HTMLButtonElement | null;
    if (btn !== null) {
      btn.setAttribute('aria-pressed', 'false');
      const label = btn.querySelector('.mic-label');
      if (label !== null) label.textContent = 'Tap to talk';
    }
    if (this.ws !== null) {
      try { this.ws.close(1000, 'user_stopped'); } catch { /* ignore */ }
      this.ws = null;
    }
    if (this.micWorklet !== null) { this.micWorklet.disconnect(); this.micWorklet = null; }
    if (this.micStream !== null) { for (const t of this.micStream.getTracks()) t.stop(); this.micStream = null; }
    if (this.micCtx !== null) { await this.micCtx.close(); this.micCtx = null; }
    if (this.playerWorklet !== null) {
      this.playerWorklet.port.postMessage({ type: 'clear' });
      this.playerWorklet.disconnect();
      this.playerWorklet = null;
    }
    if (this.playerCtx !== null) { await this.playerCtx.close(); this.playerCtx = null; }
    this.setStatus(STATUS_IDLE, '');
    this.devSetConn('disconnected');
  }

  private async openAudio(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: TARGET_RATE },
      video: false,
    });
    this.micStream = stream;

    // Two contexts: one for capture (input @ 24kHz) and one for playback.
    // Browsers often refuse to set sampleRate exactly; we downsample in
    // the capture worklet defensively.
    this.micCtx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    await this.micCtx.audioWorklet.addModule('./pcm-recorder.js');
    const src = this.micCtx.createMediaStreamSource(stream);
    this.micWorklet = new AudioWorkletNode(this.micCtx, 'pcm-recorder', {
      processorOptions: { targetRate: TARGET_RATE },
    });
    src.connect(this.micWorklet);
    this.micWorklet.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      const pcm = ev.data.pcm;
      const samples = pcm.byteLength / 2;
      this.capturedSamplesSinceCommit += samples;
      // VAD-like cue for client-side barge-in
      if (this.status === STATUS_SPEAKING && ev.data.rms > 0.04) {
        this.handleBargeIn();
      }
      this.sendUpstream({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(pcm) });
    };

    this.playerCtx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    await this.playerCtx.audioWorklet.addModule('./pcm-player.js');
    this.playerWorklet = new AudioWorkletNode(this.playerCtx, 'pcm-player');
    this.analyser = this.playerCtx.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyserBuf = new Uint8Array(this.analyser.frequencyBinCount);
    this.playerWorklet.connect(this.analyser);
    this.analyser.connect(this.playerCtx.destination);

    // Resume contexts in case the browser created them suspended.
    if (this.micCtx.state === 'suspended') await this.micCtx.resume();
    if (this.playerCtx.state === 'suspended') await this.playerCtx.resume();
  }

  private openSocket(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/realtime`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    this.devSetConn('connecting');
    ws.addEventListener('open', () => {
      this.devSetConn('open');
      // Client tells the server which user this is. The server validates
      // UUID v4 shape; if it rejects, it mints a new one and tells us.
      // (No header upgrade in browsers, so we send it as the first event.)
      this.sendUpstream({ type: 'jarvis.client_hello', userId: this.userId });
    });
    ws.addEventListener('close', (e) => {
      this.devSetConn(`closed (${String(e.code)})`);
      if (this.active) this.setStatus(STATUS_ERROR, `Connection closed (${String(e.code)}).`);
    });
    ws.addEventListener('error', () => {
      this.setStatus(STATUS_ERROR, 'WebSocket error.');
    });
    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (data.length === 0) return;
      try {
        const evt = JSON.parse(data) as ServerEvent;
        this.handleServerEvent(evt);
      } catch {
        this.devLog(`unparseable server msg: ${data.slice(0, 80)}`);
      }
    });
  }

  private sendUpstream(evt: Record<string, unknown>): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(evt));
  }

  private handleServerEvent(evt: ServerEvent): void {
    switch (evt.type) {
      case 'jarvis.session_ready':
        this.userId = (evt as JarvisSessionReady).userId;
        localStorage.setItem('jarvis.userId', this.userId);
        this.devSetUser();
        this.setStatus(STATUS_LISTENING, 'Listening. Say something.');
        return;
      case 'jarvis.filler': {
        const f = evt as JarvisFiller;
        this.setStatus(STATUS_THINKING, f.text);
        this.devLog(`filler [${f.tool}] ${f.text}`);
        return;
      }
      case 'jarvis.tool_result': {
        const r = evt as JarvisToolResult;
        const pre = document.getElementById('dev-tool');
        if (pre !== null) pre.textContent = JSON.stringify({ tool: r.tool, ok: r.ok, ms: r.durationMs, result: r.result }, null, 2);
        this.devLog(`tool_result ${r.tool} ok=${String(r.ok)} ${String(r.durationMs)}ms`);
        return;
      }
      case 'jarvis.upstream_closed': {
        const c = evt as JarvisUpstreamClosed;
        this.setStatus(STATUS_ERROR, `Upstream closed: ${String(c.code)} ${c.reason}`);
        return;
      }
      case 'jarvis.error': {
        const e = evt as JarvisErrorEvt;
        this.setStatus(STATUS_ERROR, e.message ?? e.error);
        return;
      }
      case 'response.audio.delta': {
        const d = evt as AudioDelta;
        this.setStatus(STATUS_SPEAKING);
        this.enqueuePcm(d.delta);
        return;
      }
      case 'response.audio.done':
        this.setStatus(STATUS_LISTENING, 'Listening.');
        return;
      case 'input_audio_buffer.speech_started':
        this.setStatus(STATUS_LISTENING, 'Heard you.');
        return;
      case 'input_audio_buffer.speech_stopped':
        this.setStatus(STATUS_THINKING, 'Thinking…');
        return;
      case 'error': {
        const e = evt as ErrEvt;
        this.setStatus(STATUS_ERROR, e.error?.message ?? 'upstream error');
        this.devLog(`upstream error: ${JSON.stringify(e)}`);
        return;
      }
      default:
        // Most other events are not user-visible; log to dev pane only.
        this.devLog(evt.type);
    }
  }

  private handleBargeIn(): void {
    if (this.playerWorklet !== null) {
      this.playerWorklet.port.postMessage({ type: 'clear' });
    }
    this.sendUpstream({ type: 'jarvis.barge_in' });
    this.setStatus(STATUS_LISTENING, 'Cut off.');
    this.devLog('barge_in');
  }

  private enqueuePcm(base64: string): void {
    if (this.playerWorklet === null) return;
    const bytes = base64ToUint8(base64);
    // PCM16 little-endian; convert to Float32 in [-1, 1).
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      f32[i] = s / 32768;
    }
    this.playerWorklet.port.postMessage({ type: 'chunk', samples: f32 }, [f32.buffer]);
  }

  private tickBars(): void {
    const tick = (): void => {
      if (this.analyser !== null) {
        this.analyser.getByteFrequencyData(this.analyserBuf);
        const groupSize = Math.max(1, Math.floor(this.analyserBuf.length / NUM_BARS));
        for (let i = 0; i < NUM_BARS; i++) {
          let sum = 0;
          for (let j = 0; j < groupSize; j++) sum += this.analyserBuf[i * groupSize + j] ?? 0;
          const avg = sum / groupSize;
          const h = Math.max(4, Math.round((avg / 255) * 90));
          const el = this.barEls[i];
          if (el !== undefined) { el.style.height = `${String(h)}px`; el.style.opacity = String(Math.max(0.4, avg / 255)); }
        }
      } else {
        // idle wobble
        for (let i = 0; i < NUM_BARS; i++) {
          const el = this.barEls[i];
          if (el !== undefined) {
            const phase = (Date.now() / 250) + i * 0.4;
            const h = 6 + Math.round(4 * Math.sin(phase));
            el.style.height = `${String(h)}px`;
            el.style.opacity = '0.45';
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// boot
new JarvisClient();
