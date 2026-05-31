// Jarvis web client — voice loop.
//
// Slice 9 polish layered on top of the original Slice 1 voice loop:
//
//   - Mic permission denied modal (Slice 9 / lesson F4): when
//     `getUserMedia` rejects with NotAllowedError, surface a modal that
//     explains step-by-step how to re-enable the mic. The error pill
//     used to be the only feedback; modal is now the primary path.
//   - WebSocket auto-retry with 1 s backoff up to 3 attempts (plan §2.7):
//     transient close codes (1006, 1001, 1011) trigger an exponential
//     reconnect. After 3 failures we surface the error and stop.
//   - `?demo=<manifest>` URL handler + `window.__demoReady` /
//     `window.__startDemo()` globals (lesson F8): a deterministic way to
//     drive the client from a Playwright/Puppeteer harness for demo
//     recording without a real microphone. The manifest is a remote JSON
//     file (or the literal `manifest.json` in `/public/demo/`) describing
//     a sequence of pre-recorded prompts to play back. Manifests do not
//     replace the real mic; they only run when explicitly requested.
//
// All overlays bound their height per CLAUDE.md (max-h: min(90vh, ...))
// so the close X stays reachable on a 720p laptop screen.

const STATUS_IDLE = 'idle';
const STATUS_LISTENING = 'listening';
const STATUS_THINKING = 'thinking';
const STATUS_SPEAKING = 'speaking';
const STATUS_ERROR = 'error';
type Status =
  | typeof STATUS_IDLE
  | typeof STATUS_LISTENING
  | typeof STATUS_THINKING
  | typeof STATUS_SPEAKING
  | typeof STATUS_ERROR;

const TARGET_RATE = 24_000;
const NUM_BARS = 32;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1_000;

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

interface DemoManifest {
  readonly name: string;
  readonly steps: readonly DemoStep[];
}
interface DemoStep {
  readonly delayMs?: number;
  readonly text?: string;       // text-only: shown as caption, then sent as a typed message upstream.
  readonly audioUrl?: string;   // optional pre-recorded PCM16 24 kHz to inject as user input.
}

declare global {
  interface Window {
    __demoReady?: boolean;
    __startDemo?: (manifestUrlOrObject: string | DemoManifest) => Promise<void>;
  }
}

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
  private retriesUsed = 0;
  private intentionalClose = false;

  constructor() {
    this.userId = localStorage.getItem('jarvis.userId') ?? crypto.randomUUID();
    localStorage.setItem('jarvis.userId', this.userId);
    this.setupBars();
    this.setupButton();
    this.setupModal();
    this.tickBars();
    this.devSetUser();
    void this.fetchCaps();
    this.setupDemoGlobals();
    this.maybeAutoStartDemo();
  }

  // ----- DOM setup ----------------------------------------------------

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

  private setupModal(): void {
    const close = document.getElementById('mic-perm-close');
    if (close !== null) {
      close.addEventListener('click', () => { this.hideMicModal(); });
    }
    const backdrop = document.getElementById('mic-perm-modal');
    if (backdrop !== null) {
      backdrop.addEventListener('click', (ev) => {
        // Click on backdrop (not on the modal contents) closes.
        if (ev.target === backdrop) this.hideMicModal();
      });
    }
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.hideMicModal();
    });
  }

  private showMicModal(detail: string): void {
    const modal = document.getElementById('mic-perm-modal');
    if (modal !== null) modal.setAttribute('data-open', 'true');
    const det = document.getElementById('mic-perm-detail');
    if (det !== null) det.textContent = detail;
  }

  private hideMicModal(): void {
    const modal = document.getElementById('mic-perm-modal');
    if (modal !== null) modal.setAttribute('data-open', 'false');
  }

  private setRetryBanner(open: boolean, message?: string): void {
    const banner = document.getElementById('retry-banner');
    if (banner === null) return;
    banner.setAttribute('data-open', open ? 'true' : 'false');
    if (message !== undefined) banner.textContent = message;
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
      const json = await res.json() as { capabilities: { name: string; available: boolean }[] };
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

  // ----- Start / stop -------------------------------------------------

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.intentionalClose = false;
    this.retriesUsed = 0;
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
      const isPermDenied = cause instanceof DOMException && cause.name === 'NotAllowedError';
      const message = cause instanceof Error ? cause.message : String(cause);
      if (isPermDenied) {
        this.showMicModal(`Browser said: ${message}`);
        this.setStatus(STATUS_ERROR, 'Microphone permission denied.');
      } else {
        this.setStatus(STATUS_ERROR, `Failed to start: ${message}`);
      }
      this.devLog(`start failed: ${message}`);
      this.active = false;
      this.resetButton();
    }
  }

  private resetButton(): void {
    const btn = document.getElementById('mic-btn') as HTMLButtonElement | null;
    if (btn === null) return;
    btn.setAttribute('aria-pressed', 'false');
    const label = btn.querySelector('.mic-label');
    if (label !== null) label.textContent = 'Tap to talk';
  }

  async stop(): Promise<void> {
    this.active = false;
    this.intentionalClose = true;
    this.resetButton();
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
    this.setRetryBanner(false);
  }

  // ----- Audio context + worklets ------------------------------------

  private async openAudio(): Promise<void> {
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
    this.micWorklet.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      const pcm = ev.data.pcm;
      const samples = pcm.byteLength / 2;
      this.capturedSamplesSinceCommit += samples;
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

    if (this.micCtx.state === 'suspended') await this.micCtx.resume();
    if (this.playerCtx.state === 'suspended') await this.playerCtx.resume();
  }

  // ----- WebSocket with retry ----------------------------------------

  private openSocket(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/realtime`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    this.devSetConn('connecting');
    ws.addEventListener('open', () => {
      this.devSetConn('open');
      this.retriesUsed = 0;
      this.setRetryBanner(false);
      this.sendUpstream({ type: 'jarvis.client_hello', userId: this.userId });
    });
    ws.addEventListener('close', (e) => {
      this.devSetConn(`closed (${String(e.code)})`);
      if (this.intentionalClose || !this.active) return;
      // Slice 9: auto-retry transient closes up to MAX_RETRIES.
      if (this.retriesUsed < MAX_RETRIES) {
        this.retriesUsed += 1;
        const delayMs = RETRY_BACKOFF_MS * this.retriesUsed;
        this.setRetryBanner(true, `Reconnecting (${String(this.retriesUsed)}/${String(MAX_RETRIES)})…`);
        this.devLog(`reconnect attempt ${String(this.retriesUsed)} after ${String(delayMs)}ms`);
        window.setTimeout(() => {
          if (this.active && !this.intentionalClose) this.openSocket();
        }, delayMs);
      } else {
        this.setRetryBanner(false);
        this.setStatus(STATUS_ERROR, `Connection failed after ${String(MAX_RETRIES)} retries (${String(e.code)}).`);
      }
    });
    ws.addEventListener('error', () => {
      this.devLog('ws error');
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

  // ----- Server event handling ---------------------------------------

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
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      f32[i] = s / 32768;
    }
    this.playerWorklet.port.postMessage({ type: 'chunk', samples: f32 }, [f32.buffer]);
  }

  // ----- Visualizer ---------------------------------------------------

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

  // ----- Demo manifest harness (Slice 9) -----------------------------

  private setupDemoGlobals(): void {
    window.__demoReady = true;
    window.__startDemo = async (manifestUrlOrObject) => {
      await this.runDemo(manifestUrlOrObject);
    };
  }

  /**
   * If the URL carries `?demo=<manifest>`, fetch and auto-run it. The
   * `manifest` value is either a URL (absolute or relative) to a JSON
   * file matching the DemoManifest shape, or one of the bundled names
   * (just the URL string is used directly).
   */
  private maybeAutoStartDemo(): void {
    const params = new URLSearchParams(window.location.search);
    const manifest = params.get('demo');
    if (manifest === null || manifest.length === 0) return;
    // Run on the next macrotask so the page can finish loading.
    window.setTimeout(() => {
      void this.runDemo(manifest);
    }, 100);
  }

  private async runDemo(manifestUrlOrObject: string | DemoManifest): Promise<void> {
    let manifest: DemoManifest;
    if (typeof manifestUrlOrObject === 'string') {
      const res = await fetch(manifestUrlOrObject);
      if (!res.ok) {
        this.setStatus(STATUS_ERROR, `Demo manifest fetch failed: ${String(res.status)}`);
        return;
      }
      manifest = await res.json() as DemoManifest;
    } else {
      manifest = manifestUrlOrObject;
    }
    this.devLog(`demo: ${manifest.name} (${String(manifest.steps.length)} steps)`);
    await this.start();
    for (const step of manifest.steps) {
      if (step.delayMs !== undefined && step.delayMs > 0) {
        await new Promise<void>((r) => window.setTimeout(r, step.delayMs));
      }
      if (step.text !== undefined && step.text.length > 0) {
        // Push the prompt as a text message upstream so the model speaks
        // a response without needing a real microphone capture.
        this.sendUpstream({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: step.text }],
          },
        });
        this.sendUpstream({ type: 'response.create' });
        const cap = document.getElementById('caption');
        if (cap !== null) cap.textContent = `[demo] ${step.text}`;
      }
    }
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
