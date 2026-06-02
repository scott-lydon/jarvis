// main.jsx — REAL Jarvis main screen, wired to the live proxy.
//
// This file REPLACES the design's mock main.jsx (which used SEED_TURNS +
// fake mic levels + force-state). Every piece of UI state here flows from
// real upstream events delivered by window.JarvisClient (jarvis-client.js):
//
//   jarvis.session_ready              → state becomes 'listening'
//   input_audio_buffer.speech_started → state stays 'listening', caption flips
//   input_audio_buffer.speech_stopped → state becomes 'thinking'
//   jarvis.filler                     → state becomes 'thinking', filler text
//   response.audio.delta              → state becomes 'speaking', PCM enqueued
//   response.audio.done               → state returns to 'listening'
//   response.audio_transcript.done    → push assistant TurnRow
//   conversation.item.input_audio_transcription.completed → push user TurnRow
//   jarvis.tool_result                → push ToolTile (resolves the pending tile)
//   jarvis.error / jarvis.upstream_closed → ErrorBanner
//
// Barge-in (US-04): the client's getUserMedia path detects user voice while
// status === 'speaking' and calls JarvisClient.bargeIn(), which CLOSES the
// playback AudioContext and recreates a fresh one (~<100ms silence on Web
// Audio — the only reliable path; clearing the worklet queue is not enough
// because the AudioContext output buffer keeps playing whatever was already
// scheduled). The UI flashes 'interrupted' for ~400ms then returns to
// 'listening'.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#4ade80",
  "density": "tight",
  "showExamples": true
}/*EDITMODE-END*/;

function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function hexA(hex, a) {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function App() {
  // ── Dev mode (force-state bar). On via ?dev=1 or #dev. The bar drives the
  //    LIVE client (start/stop), not a mock — there is no mock here. ──
  const devFromUrl = useMemo(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      return p.get('dev') === '1' || /\bdev\b/.test(window.location.hash);
    } catch { return false; }
  }, []);
  const [showForce, setShowForce] = useState(devFromUrl);

  // ── Tweaks ──
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Apply accent CSS var live
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', t.accent);
    document.documentElement.style.setProperty('--accent-soft', hexA(t.accent, 0.14));
    document.documentElement.style.setProperty('--accent-ring', hexA(t.accent, 0.32));
    document.documentElement.style.setProperty('--accent-glow', hexA(t.accent, 0.55));
  }, [t.accent]);

  // ── App state — driven entirely by the live client. ──
  const [state, setState]         = useState('idle');
  const [items, setItems]         = useState([]); // turns + tool tiles
  const [banners, setBanners]     = useState([]);
  const [micLevels, setMicLevels] = useState([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
  const [sessionId, setSessionId] = useState('—');
  const [capOpen, setCapOpen]     = useState(false);
  const [streamingId, setStreamingId] = useState(null);
  // Dev signal-flow telemetry (drives the DevSignalPanel below).
  const [micDiag, setMicDiag]   = useState(null);
  const [lastUserTranscript, setLastUserTranscript] = useState('');
  // Bug-I/J transparency (2026-06-01): when the proxy discards an
  // utterance as a Whisper artifact or stop command, surface it in the
  // dev panel so the user can see WHAT was filtered and why. Tied to
  // jarvis.input_discarded events (see jarvis-client.js).
  const [lastDiscarded, setLastDiscarded] = useState(null);
  // Bug-O (2026-06-01) silenced-mode flag. While true the yellow
  // banner renders ("Jarvis is silenced. Say 'speak' to continue.") and
  // the audio.delta gate in jarvis-client.js drops any in-flight
  // playback. Flipped by jarvis.silenced / jarvis.unsilenced from the
  // proxy.
  const [silenced, setSilenced] = useState(false);
  // Bug-F fix (2026-06-01): make the mic-intro banner state-derived
  // instead of imperative. The previous "push it into banners on mount,
  // pop it on onMicGranted" model had three separate dismissal triggers
  // (Permissions API initial probe, Permissions API change handler,
  // onMicGranted from getUserMedia.then) and the user still saw the
  // banner persist on Safari/macOS. Root cause: the imperative model
  // is fragile — any unsubscribed listener bug, any closure-staleness,
  // any browser-permission-quirk-throwing-silently breaks dismissal,
  // and we already saw the user with an ACTIVE 'Listening' session
  // sitting next to a "Microphone permission required" banner — a
  // logical impossibility.
  //
  // New model: micPermissionState is the single source of truth.
  //   'unknown'  → we haven't probed yet; show the banner conservatively
  //   'prompt'   → permission has not been granted or denied; show banner
  //   'granted'  → mic is allowed; never show banner
  //   'denied'   → show a different "revoked / re-enable in settings" banner
  // The render layer reads (state, micPermissionState) and renders the
  // appropriate banner. Status === 'listening|thinking|speaking' is
  // ALSO treated as proof of grant — by definition the session can't
  // be live without a working mic — so even if the Permissions API
  // never updates, the banner stays gone after the session starts.
  const [micPermissionState, setMicPermissionState] = useState('unknown');
  const logRef = useRef(null);
  const clientRef = useRef(null);
  // Track in-flight tool calls so we can resolve a pending tile when the
  // jarvis.tool_result lands. Realtime tool_results don't carry args, so we
  // stash the args at function_call_arguments.done time… except the proxy
  // does NOT forward those to clients, so for now we render the tool tile
  // only with the resolved result (args = {} until we plumb them through).
  const pendingToolsRef = useRef([]); // FIFO of pending tool names

  // Auto-scroll log to bottom on new items
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [items.length, streamingId]);

  // Briefly flash the 'interrupted' state on barge-in, then revert to listening.
  const flashInterruptedRef = useRef(null);
  const flashInterrupted = useCallback(() => {
    setState('interrupted');
    if (flashInterruptedRef.current) clearTimeout(flashInterruptedRef.current);
    flashInterruptedRef.current = window.setTimeout(() => {
      setState((s) => (s === 'interrupted' ? 'listening' : s));
    }, 400);
  }, []);

  // Bug-F fix (2026-06-01): Permissions API drives micPermissionState,
  // which the render layer uses to decide whether to show the mic-intro
  // banner. Three-layer detection:
  //
  //   Layer 1 — Permissions API initial probe (Chromium, Safari 16+).
  //     Resolves with one of 'granted' / 'denied' / 'prompt'. On Safari
  //     pre-16 / Firefox older builds this throws (TypeError on the
  //     'microphone' name) and we fall through to Layer 2/3.
  //   Layer 2 — Permissions API change listener. Drives revocation
  //     detection: if the user revokes mid-session we surface the
  //     re-enable instructions banner. Also re-confirms a granted flip
  //     after the OS-level prompt resolves.
  //   Layer 3 — onMicGranted callback fired by the JarvisClient the
  //     instant getUserMedia.then() resolves. This is the ground-truth
  //     signal that works on EVERY browser. The Permissions API is a
  //     defense-in-depth nice-to-have on top.
  //
  // On every layer, micPermissionState is set explicitly so the render
  // gating below stays a single state machine.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return;
    let cancelled = false;
    let statusRef = null;
    const onChange = () => {
      if (cancelled || !statusRef) return;
      const next = statusRef.state;
      if (next === 'granted' || next === 'denied' || next === 'prompt') {
        setMicPermissionState(next);
      }
    };
    navigator.permissions.query({ name: 'microphone' }).then((status) => {
      if (cancelled) return;
      statusRef = status;
      onChange();
      try { status.addEventListener('change', onChange); } catch (_) { status.onchange = onChange; }
    }).catch(() => {
      // Permissions API not supported for 'microphone' (Safari < 16,
      // older Firefox) — leave micPermissionState as 'unknown' and
      // rely on onMicGranted + state-derived suppression.
    });
    return () => {
      cancelled = true;
      if (statusRef) {
        try { statusRef.removeEventListener('change', onChange); } catch (_) { statusRef.onchange = null; }
      }
    };
  }, []);

  // Bug-F fix (2026-06-01): an active session is itself proof of mic
  // grant. If state transitions to listening/thinking/speaking, the
  // browser has given us a working mic — clamp micPermissionState to
  // 'granted' so the render layer cannot show "permission required"
  // next to a live "Listening" status bar.
  useEffect(() => {
    if (state === 'listening' || state === 'thinking' || state === 'speaking') {
      setMicPermissionState((prev) => (prev === 'granted' ? prev : 'granted'));
    }
  }, [state]);

  // ── Boot the real client ──
  useEffect(() => {
    const client = new window.JarvisClient({
      onState: (s) => setState(s),
      onMicLevels: (lvls) => setMicLevels(lvls),
      onMicDiag: (d) => setMicDiag(d),
      // Bug-F fix (2026-06-01): ground-truth grant signal. Fires the
      // instant navigator.mediaDevices.getUserMedia().then() resolves
      // — i.e. the instant the user taps Allow in the OS-level prompt.
      // Drives the state-derived banner gating; works on every browser
      // even when the Permissions API is unsupported for 'microphone'.
      onMicGranted: () => {
        setMicPermissionState('granted');
      },
      onSessionReady: (uid) => setSessionId(uid.slice(0, 6)),
      onUserTurn: (text) => {
        setLastUserTranscript(text);
        setItems((it) => it.concat([{
          id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          kind: 'turn',
          role: 'user',
          time: nowTime(),
          text,
        }]));
      },
      onAssistantTurn: (text) => {
        const id = `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        setItems((it) => it.concat([{
          id,
          kind: 'turn',
          role: 'assistant',
          time: nowTime(),
          text,
        }]));
        setStreamingId(null);
      },
      onFiller: (text, tool) => {
        // Filler is a spoken cue we surface in the log as a transient assistant
        // turn so the user gets a textual signal in parallel with the audio.
        setItems((it) => it.concat([{
          id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          kind: 'turn',
          role: 'assistant',
          time: nowTime(),
          text,
        }]));
        pendingToolsRef.current.push(tool);
        setItems((it) => it.concat([{
          id: `tool_pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          kind: 'tool',
          name: tool,
          duration: null,
          pending: true,
          args: {},
          result: null,
        }]));
      },
      onToolResult: (tool, ok, durationMs, result) => {
        // Resolve the most-recent pending tile for this tool name.
        setItems((it) => {
          let resolved = false;
          const next = it.map((row) => {
            if (resolved) return row;
            if (row.kind === 'tool' && row.name === tool && row.pending) {
              resolved = true;
              return { ...row, pending: false, duration: durationMs, result, error: ok ? null : result };
            }
            return row;
          });
          if (!resolved) {
            // No pending tile (no filler fired) — append a finished tile.
            next.push({
              id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              kind: 'tool',
              name: tool,
              duration: durationMs,
              pending: false,
              args: {},
              result,
              error: ok ? null : result,
            });
          }
          return next;
        });
      },
      onError: (title, body) => {
        setBanners((b) => b.concat([{
          id: `err_${Date.now()}`,
          kind: 'err',
          title,
          body,
          dismissible: true,
        }]));
      },
      onMicPermissionDenied: (detail) => {
        setMicPermissionState('denied');
        setBanners((b) => b.concat([{
          id: `mic_denied_${Date.now()}`,
          kind: 'err',
          title: 'Microphone permission denied',
          body: detail,
          dismissible: true,
        }]));
      },
      onBargeIn: () => flashInterrupted(),
      onInputDiscarded: (reason, transcript) => {
        setLastDiscarded({ reason, transcript, at: nowTime() });
      },
      onSilenced: (_transcript) => { setSilenced(true); },
      onUnsilenced: (_transcript) => { setSilenced(false); },
    });
    clientRef.current = client;
    // Demo-harness globals — preserve existing behavior so headless harnesses
    // can drive the page without mic capture.
    window.__demoReady = true;
    window.__startDemo = async (m) => { await client.runDemo(m); };
    // Auto-start demo if URL carries ?demo=<manifest>.
    try {
      const params = new URLSearchParams(window.location.search);
      const manifest = params.get('demo');
      if (manifest && manifest.length > 0) {
        window.setTimeout(() => { void client.runDemo(manifest); }, 100);
      }
    } catch (_) { /* ignore */ }
    return () => {
      try { client.stop(); } catch (_) { /* ignore */ }
      clientRef.current = null;
    };
  }, [flashInterrupted]);

  // BUG-DIAG-2026-06-01: mic-tap interception. Until the user has
  // confirmed the two-phase diagnostic this session (or has been forced
  // open via ?diag-force=1), tapping the mic opens the MicTestModal
  // instead of starting the real Realtime session. Once confirmed, the
  // session-storage flag is set and subsequent taps go straight to
  // client.start(). Delete this state + the interceptor branch + the
  // modal component below when the diagnostic is removed.
  const [showMicTest, setShowMicTest] = useState(false);
  const handleMicTap = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    if (c.isActive()) {
      void c.stop();
      return;
    }
    const force = typeof window.jarvisMicTestForcedOpen === 'function' && window.jarvisMicTestForcedOpen();
    const passed = typeof window.jarvisMicTestSessionPassed === 'function' && window.jarvisMicTestSessionPassed();
    if (force || !passed) {
      setShowMicTest(true);
      return;
    }
    void c.start();
  }, []);
  const handleMicTestConfirm = useCallback(() => {
    setShowMicTest(false);
    const c = clientRef.current;
    if (c) void c.start();
  }, []);
  const handleMicTestDismiss = useCallback(() => {
    setShowMicTest(false);
  }, []);

  const handleReset = useCallback(() => {
    const c = clientRef.current;
    if (c) void c.stop();
    setItems([]);
    setBanners([]);
    setStreamingId(null);
    setState('idle');
  }, []);

  // Dev force-state: in production we never fake state, so the force-state
  // bar in dev mode now DRIVES the client (start = listening, idle = stop).
  // No SEED_TURNS, ever.
  const handleForceState = useCallback((s) => {
    const c = clientRef.current;
    if (!c) return;
    if (s === 'idle') {
      void c.stop();
      return;
    }
    if (!c.isActive()) void c.start();
    // Other states (thinking/speaking/interrupted) flow from the upstream
    // event stream; we don't override them. Surfacing this as a hint:
    // dev clicks 'speaking' but the underlying state stays where the model
    // actually is.
  }, []);

  const dismissBanner = useCallback((id) => {
    setBanners(b => b.filter(x => x.id !== id));
  }, []);

  // Bug-F fix (2026-06-01): mic-intro banner is now state-derived —
  // see micIntroBanner / micRevokedBanner memoized below. We no longer
  // push it into the imperative `banners` array on mount; the render
  // layer composes it from (state, micPermissionState) so a live
  // session can never coexist with a "permission required" warning.

  const turnsCount = useMemo(
    () => items.filter(i => i.kind === 'turn').length,
    [items]
  );

  // Bug-F fix (2026-06-01): derived mic banner. Show "permission
  // required" only when:
  //   - the session is idle (no live capture confirming grant), AND
  //   - permission is not 'granted' (either 'unknown', 'prompt', or
  //     the explicit denied state which uses its own banner below).
  // When the user taps "Grant microphone access" we call handleMicTap
  // which triggers getUserMedia — the OS prompt drives micPermissionState
  // to 'granted' (or the denied callback above), so the banner naturally
  // disappears as soon as the answer is in.
  const micIntroBanner = useMemo(() => {
    if (state !== 'idle') return null;
    if (micPermissionState === 'granted') return null;
    if (micPermissionState === 'denied') return null; // handled by micRevokedBanner
    return {
      id: 'mic_intro', kind: 'warn',
      title: 'Microphone permission required',
      body: 'Jarvis can\'t hear you until you grant access.',
      dismissible: false,
      cta: { label: 'Grant microphone access', onClick: handleMicTap },
    };
  }, [state, micPermissionState, handleMicTap]);

  // Bug-F fix (2026-06-01): derived revocation banner. Same source of
  // truth (micPermissionState) — surfaces re-enable instructions when
  // the browser flips to 'denied' after a prior grant. There is no
  // programmatic way to re-prompt; the user must change it in site
  // settings, so the body text walks them there.
  const micRevokedBanner = useMemo(() => {
    if (micPermissionState !== 'denied') return null;
    return {
      id: 'mic_revoked', kind: 'err',
      title: 'Microphone access was revoked',
      body: 'Safari / Chrome → site settings (the lock icon in the URL bar) → Microphone → Allow. Then reload this page.',
      // Non-dismissible: the only fix is to flip the permission back,
      // and the state machine will clear the banner automatically when
      // the Permissions API reports 'granted' (or onMicGranted fires
      // after the user retries). A dismiss button here would deceive
      // the user into thinking they had cleared it.
      dismissible: false,
    };
  }, [micPermissionState]);

  // Bug-O (2026-06-01) silenced-mode banner. Matches the user's spec:
  // "a yellow warning like the microphone permission banner at the
  // beginning, reading 'Jarvis is silenced. Say the word speak to
  // continue talking.'" Yellow (kind: 'warn') is the same chrome as
  // the mic-intro banner so the user reads it the same way. Non-
  // dismissible because the only way OUT of silenced mode is the
  // resume phrase — clicking an X would create a false sense of
  // exit while the proxy is still in create_response=false.
  const silencedBanner = useMemo(() => {
    if (!silenced) return null;
    return {
      id: 'jarvis_silenced', kind: 'warn',
      title: 'Jarvis is silenced.',
      body: 'Say the word "speak" to continue talking.',
      dismissible: false,
    };
  }, [silenced]);

  const allBanners = useMemo(() => {
    const out = [];
    if (silencedBanner) out.push(silencedBanner);
    if (micIntroBanner) out.push(micIntroBanner);
    if (micRevokedBanner) out.push(micRevokedBanner);
    for (const b of banners) out.push(b);
    return out;
  }, [silencedBanner, micIntroBanner, micRevokedBanner, banners]);

  return (
    <>
      <Header
        state={state}
        sessionId={sessionId}
        dev={showForce}
        capabilityChip={
          <CapabilityChip
            open={capOpen}
            onToggle={() => setCapOpen(v => !v)}
          />
        }
      />

      <CapabilityPanel
        open={capOpen}
        onClose={() => setCapOpen(false)}
        onPick={() => setCapOpen(false)}
      />

      <div ref={logRef} className="scroll-area" style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        paddingBottom: 8,
      }}>
        {allBanners.map(b => (
          <ErrorBanner key={b.id} banner={b} onDismiss={dismissBanner}/>
        ))}

        {(state === 'idle' || state === 'listening') && items.length === 0 && t.showExamples && (
          // Bug-K (2026-06-01): the previous gate showed ExamplePrompts
          // ONLY in 'idle', so the instant the user tapped the mic and
          // state flipped to 'listening' the suggestion list disappeared.
          // The user reported "the suggestion topics also went away"
          // because the banner-gone moment coincided with the state
          // flip. Loosened: prompts stay visible during 'listening'
          // until the first real turn lands (items.length > 0). The
          // first transcribed user turn or assistant turn pushes items
          // > 0 and the prompts retire on their own.
          <ExamplePrompts/>
        )}

        {items.map(it => {
          if (it.kind === 'tool') return <ToolTile key={it.id} tool={it} dev={showForce}/>;
          return (
            <TurnRow
              key={it.id}
              turn={it}
              density={t.density}
              streaming={it.id === streamingId && it.role === 'assistant'}
            />
          );
        })}

        {state === 'thinking' && (
          <div style={{ padding: '6px 14px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <span className="mono" style={{
                fontSize: 10, letterSpacing: '0.08em',
                color: 'var(--warn)', fontWeight: 600,
              }}>JARVIS</span>
              <span className="mono tnum" style={{ fontSize: 10, color: 'var(--fg-faint)' }}>
                {nowTime()}
              </span>
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', background: 'var(--surface-1)',
              border: '1px solid var(--border)', borderRadius: 6,
            }}>
              <ThinkingDots/>
              <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>routing</span>
            </div>
          </div>
        )}
      </div>

      <div style={{
        padding: '4px 0 4px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 0,
        borderTop: '1px solid var(--border)',
        background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.4))',
      }}>
        <MicButton state={state} onTap={handleMicTap} micLevels={micLevels}/>
        <div style={{
          fontSize: 11, color: 'var(--fg-muted)',
          marginTop: -2, marginBottom: 6,
          minHeight: 14,
        }}>
          {STATE_META[state].hint}
        </div>
      </div>

      {showForce && (
        <DevSignalPanel
          clientRef={clientRef}
          diag={micDiag}
          lastUserTranscript={lastUserTranscript}
          lastDiscarded={lastDiscarded}
        />
      )}
      {showForce && <ForceStateBar state={state} onSet={handleForceState}/>}

      <Footer onReset={handleReset} turns={turnsCount}
              showForce={showForce} onToggleForce={() => setShowForce(v => !v)}/>

      {/* BUG-DIAG-2026-06-01: two-phase mic + Whisper diagnostic. */}
      {showMicTest && window.JarvisMicTestModal && (
        <window.JarvisMicTestModal
          clientRef={clientRef}
          onConfirm={handleMicTestConfirm}
          onDismiss={handleMicTestDismiss}
        />
      )}

      <TweaksPanel>
        <TweakSection label="Accent"/>
        <TweakColor
          label="Color" value={t.accent}
          options={['#4ade80', '#60a5fa', '#fb923c', '#22d3ee', '#a78bfa', '#f43f5e']}
          onChange={(v) => setTweak('accent', v)}
        />
        <TweakSection label="Conversation log"/>
        <TweakRadio
          label="Density" value={t.density}
          options={['tight', 'medium', 'comfy']}
          onChange={(v) => setTweak('density', v)}
        />
        <TweakToggle
          label="Show examples in idle"
          value={t.showExamples}
          onChange={(v) => setTweak('showExamples', v)}
        />
      </TweaksPanel>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// DevSignalPanel — surfaces the new transparency hooks added in
// jarvis-client.js so the user can SEE the audio signal flow:
//   - Diagnostic readout from the worklet (srcRate / chunks /
//     meanAbs / maxAbs / bytesSent) — tells us if real audio is
//     reaching the worklet at all.
//   - Latest raw user transcript Whisper sent back — tells us
//     what the upstream model actually heard.
//   - "Play my last 30s" button → playCapture() → audible playback
//     of exactly what we sent upstream.
//   - "Download as WAV" button → downloadCaptureWav() so the
//     audio file can be inspected directly.
// Visible only in dev mode (?dev=1 or #dev or the footer toggle).
// ─────────────────────────────────────────────────────────────
function DevSignalPanel({ clientRef, diag, lastUserTranscript, lastDiscarded }) {
  const [status, setStatus] = useState(null);
  const handlePlay = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    setStatus('playing…');
    c.playCapture()
      .then(() => setStatus('playback done'))
      .catch((e) => setStatus(`error: ${e?.message || String(e)}`));
  }, [clientRef]);
  const handleDownload = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    try {
      c.downloadCaptureWav();
      setStatus('downloaded WAV');
    } catch (e) {
      setStatus(`error: ${e?.message || String(e)}`);
    }
  }, [clientRef]);

  const cell = { padding: '2px 6px', fontSize: 11, color: 'var(--fg-muted)' };
  const numCell = { ...cell, fontFamily: 'var(--f-mono)', color: 'var(--fg-dim)' };
  const btn = {
    padding: '4px 10px', fontSize: 11,
    background: 'var(--surface-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    color: 'var(--fg)',
    cursor: 'pointer',
  };
  return (
    <div style={{
      margin: '0 12px 8px',
      padding: '8px 10px',
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      fontSize: 11,
      color: 'var(--fg-muted)',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6,
      }}>
        <span style={{ fontFamily: 'var(--f-mono)', color: 'var(--accent)', fontSize: 10, letterSpacing: '0.08em' }}>
          DEV · signal flow
        </span>
        <span style={{ color: 'var(--fg-faint)' }}>{status || ''}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
        <div style={cell}>worklet srcRate</div>
        <div style={numCell}>{diag?.srcRate ?? '—'} Hz → {diag?.targetRate ?? 24000} Hz</div>
        <div style={cell}>chunks in last {diag?.elapsedMs ? Math.round(diag.elapsedMs) : '—'} ms</div>
        <div style={numCell}>{diag?.chunks ?? '—'}</div>
        <div style={cell}>mean abs amplitude</div>
        <div style={numCell}>{diag?.meanAbs != null ? diag.meanAbs.toFixed(4) : '—'} {diag?.meanAbs === 0 ? '(SILENCE detected upstream!)' : ''}</div>
        <div style={cell}>peak abs amplitude</div>
        <div style={numCell}>{diag?.maxAbs != null ? diag.maxAbs.toFixed(4) : '—'}</div>
        <div style={cell}>last upstream transcript</div>
        <div style={{ ...numCell, color: lastUserTranscript ? 'var(--fg)' : 'var(--fg-faint)' }}>
          {lastUserTranscript || '— (Whisper has not returned anything yet)'}
        </div>
        <div style={cell}>last discarded input</div>
        <div style={{ ...numCell, color: lastDiscarded ? 'var(--warn)' : 'var(--fg-faint)' }}>
          {lastDiscarded
            ? `${lastDiscarded.at} · ${lastDiscarded.reason} · "${lastDiscarded.transcript}"`
            : '— (no Whisper artifacts or stop commands seen)'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button type="button" style={btn} onClick={handlePlay}>▶ Play my last 30 s</button>
        <button type="button" style={btn} onClick={handleDownload}>⬇ Download WAV</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Mount — Bug-A fix (2026-05-31): the previous Stage scaled the
// 402×874 device frame with CSS `transform: scale(N)` where N < 1
// on a small viewport. The browser rasterizes children at their
// ORIGINAL size and downsamples in the compositor with bilinear
// filtering → blurry text + jagged edges. Fix:
//
//   - Desktop / large viewport (≥520 px wide AND ≥920 px tall):
//       render the IOSDevice at its native 402×874 with NO scaling.
//       Always crisp.
//   - Small viewport (anything narrower or shorter): drop the bezel
//       entirely and let the App fill the viewport responsively.
//       Mobile users wouldn't see a fake iPhone inside their real
//       iPhone anyway.
// ─────────────────────────────────────────────────────────────
const DEVICE_W = 402;
const DEVICE_H = 874;
const DESKTOP_BREAKPOINT_W = 520;
const DESKTOP_BREAKPOINT_H = 920;

function Stage() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= DESKTOP_BREAKPOINT_W && window.innerHeight >= DESKTOP_BREAKPOINT_H;
  });

  useEffect(() => {
    const fit = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT_W && window.innerHeight >= DESKTOP_BREAKPOINT_H);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Inner stack: the App + its bezel padding. Shared between bezeled
  // (desktop) and bezel-less (mobile) layouts so the App tree itself
  // is identical and React doesn't unmount on resize.
  const appShell = (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0,
      background: 'var(--bg)',
      color: 'var(--fg)',
      paddingTop: isDesktop ? 54 : 'env(safe-area-inset-top, 12px)',
    }}>
      <App/>
    </div>
  );

  if (isDesktop) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'grid', placeItems: 'center',
        overflow: 'hidden',
        background: 'radial-gradient(ellipse at top, #11141a 0%, var(--bg) 60%)',
      }}>
        <div style={{ width: DEVICE_W, height: DEVICE_H }}>
          <IOSDevice dark>{appShell}</IOSDevice>
        </div>
      </div>
    );
  }
  // Mobile / narrow viewport: no bezel, fullscreen App.
  return (
    <div style={{
      minHeight: '100vh',
      width: '100%',
      background: 'var(--bg)',
      color: 'var(--fg)',
      display: 'flex', flexDirection: 'column',
    }}>
      {appShell}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Stage/>);
