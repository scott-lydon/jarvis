// main.jsx — Jarvis main screen app

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─── Sample conversation seed (shown when forced to non-idle states) ───
const SEED_TURNS = [
  { id: 't1', kind: 'turn', role: 'user',      time: '09:41:02', text: 'Weather in Austin' },
  { id: 'x1', kind: 'tool', name: 'weather', duration: 412,
    args:   { location: 'Austin, TX', units: 'imperial' },
    result: { temp_f: 84, feels_like_f: 88, conditions: 'Partly cloudy', humidity: 58, wind_mph: 8, source: 'wttr.in' },
  },
  { id: 't2', kind: 'turn', role: 'assistant', time: '09:41:04',
    text: "It's 84°F and partly cloudy in Austin, feels like 88. Winds out of the south around 8 mph." },

  { id: 't3', kind: 'turn', role: 'user',      time: '09:42:15', text: 'Remember that I prefer Fahrenheit' },
  { id: 'x2', kind: 'tool', name: 'memory_write', duration: 38,
    args:   { key: 'user.units.temperature', value: 'fahrenheit', scope: 'global' },
    result: { ok: true, id: 'mem_3a91', written_at: '2026-05-28T09:42:15Z' },
  },
  { id: 't4', kind: 'turn', role: 'assistant', time: '09:42:16',
    text: "Saved. I'll default to Fahrenheit going forward." },

  { id: 't5', kind: 'turn', role: 'user',      time: '09:44:20', text: 'How many open PRs on cattle-co/feeder?' },
  { id: 'x3', kind: 'tool', name: 'github', duration: 318,
    args:   { endpoint: 'GET /repos/cattle-co/feeder/pulls', params: { state: 'open', per_page: 100 } },
    result: { count: 7, oldest_days: 23, authors: ['kpark','mreed','jlin','tsato'] },
  },
  { id: 't6', kind: 'turn', role: 'assistant', time: '09:44:22',
    text: "Seven open pull requests on cattle-co/feeder. Oldest is 23 days old. Want me to list them by author?" },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#4ade80",
  "density": "tight",
  "micPosition": "bottom",
  "showExamples": true
}/*EDITMODE-END*/;

function App() {
  // ── Dev mode (force-state bar). On via ?dev=1, #dev, or the footer toggle. ──
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
    // Derive soft / ring / glow from the accent
    document.documentElement.style.setProperty('--accent-soft', hexA(t.accent, 0.14));
    document.documentElement.style.setProperty('--accent-ring', hexA(t.accent, 0.32));
    document.documentElement.style.setProperty('--accent-glow', hexA(t.accent, 0.55));
  }, [t.accent]);

  // ── App state ──
  const [state, setState] = useState('idle');
  const [items, setItems] = useState([]); // turns + tool tiles
  const [banners, setBanners] = useState([]);
  const [micLevels, setMicLevels] = useState([0.3, 0.5, 0.4, 0.6, 0.5, 0.4, 0.5]);
  const [streamingId, setStreamingId] = useState(null);
  // F15: persistent capability chip + inline panel. Closed by default so the
  // chip is the affordance; opening reveals the same ExamplePrompts the idle
  // state uses, but at any point in the session (not just first turn).
  const [capOpen, setCapOpen] = useState(false);
  const logRef = useRef(null);

  // Auto-scroll log to bottom on new items
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [items.length, streamingId]);

  // Fake live mic levels while listening
  useEffect(() => {
    if (state !== 'listening') return;
    const id = setInterval(() => {
      setMicLevels(arr => arr.map(() => 0.25 + Math.random() * 0.75));
    }, 110);
    return () => clearInterval(id);
  }, [state]);

  // ── Force-state handling: when dev forces a non-idle state, seed transcript ──
  const handleForceState = useCallback((s) => {
    setState(s);
    if (s === 'idle') {
      setItems([]);
      setStreamingId(null);
      return;
    }
    if (s === 'listening') {
      setItems([
        ...SEED_TURNS,
        { id: 'live', kind: 'live-transcript', role: 'user', time: nowTime(),
          text: 'how many issues are tagged urgent on the same repo' },
      ]);
      setStreamingId('live');
    }
    if (s === 'thinking') {
      setItems(SEED_TURNS.concat([
        { id: 'tu', kind: 'turn', role: 'user', time: nowTime(),
          text: 'How many issues are tagged urgent on the same repo?' },
      ]));
      setStreamingId(null);
    }
    if (s === 'speaking') {
      setItems(SEED_TURNS.concat([
        { id: 'tu', kind: 'turn', role: 'user', time: nowTime(),
          text: 'How many issues are tagged urgent on the same repo?' },
        { id: 'tx', kind: 'tool', name: 'github', duration: 264,
          args:   { endpoint: 'GET /repos/cattle-co/feeder/issues', params: { state: 'open', labels: 'urgent' } },
          result: { count: 4, ids: [1782, 1799, 1803, 1811] } },
        { id: 'ta', kind: 'turn', role: 'assistant', time: nowTime(),
          text: 'Four open issues are tagged urgent on cattle-co/feeder. Numbers 1782, 1799, 1803, and 1811.' },
      ]));
      setStreamingId('ta');
    }
  }, []);

  const handleMicTap = useCallback(() => {
    setState(s => (s === 'idle' ? 'listening' : 'idle'));
  }, []);

  const handleReset = useCallback(() => {
    setState('idle');
    setItems([]);
    setBanners([]);
    setStreamingId(null);
  }, []);

  // F17/F19: BroadcastChannel listener. The debug surface (debug.html in
  // another tab of the same browser) drives this screen with:
  //   - jarvis.ping  → reply with jarvis.pong so the debug panel can
  //                    surface a live "main attached" indicator
  //   - jarvis.inject → push a synthetic tool tile (or, when tool is
  //                     'simulate_failure', push a banner instead)
  //   - jarvis.force  → call handleForceState; lets a developer drive
  //                     this screen into any state from the debug tab
  // The channel is opened once on mount and closed on unmount. Failures
  // here are silent on purpose — a missing BroadcastChannel (very old
  // Safari, sandboxed iframe) means the debug surface simply cannot
  // reach this tab, which is a non-fatal degradation.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('jarvis-debug');
    const onMsg = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'jarvis.ping') {
        try { ch.postMessage({ type: 'jarvis.pong', ts: Date.now() }); }
        catch (_) { /* channel closed in another tab — ignore. */ }
        return;
      }
      if (m.type === 'jarvis.force' && typeof m.state === 'string') {
        handleForceState(m.state);
        return;
      }
      if (m.type === 'jarvis.inject') {
        // F19 simulate_failure routes to a banner. Real failure injection
        // (network drop, tool timeout, fake 5xx) lands in Slice 1 when
        // the proxy actually exists; for the design loop this is enough
        // to verify the wiring and the user-visible error surface.
        if (m.tool === 'simulate_failure') {
          const kind = m.payload?.failure_kind ?? 'unknown';
          setBanners(b => [...b, {
            id: `inj_${m.tsMs ?? Date.now()}`,
            kind: 'err',
            title: `Simulated failure: ${kind}`,
            body: 'Driven by the debug surface via BroadcastChannel. Dismiss to clear.',
            dismissible: true,
          }]);
          return;
        }
        // Default: turn the injected payload into a synthetic tool tile so
        // the user sees the same UI shape as a real tool result.
        setItems(it => [...it, {
          id: `inj_${m.tsMs ?? Date.now()}`,
          kind: 'tool',
          name: m.tool,
          duration: 0,
          args: { source: 'debug-inject' },
          result: m.payload,
        }]);
        return;
      }
    };
    ch.addEventListener('message', onMsg);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  }, [handleForceState]);

  const dismissBanner = useCallback((id) => {
    setBanners(b => b.filter(x => x.id !== id));
  }, []);

  // Seed the mic-permission banner once so the pattern is visible.
  // Post-UX-review (2026-05-31): banner now ships with `dismissible: false`
  // and an inline CTA pill so a first-time user can grant access in one tap
  // without needing to find the mic button at the bottom of the screen.
  // The X was misleading — implied the warning was optional. It isn't.
  useEffect(() => {
    setBanners([{
      id: 'b1', kind: 'warn',
      title: 'Microphone permission required',
      body: 'Jarvis can\'t hear you until you grant access.',
      dismissible: false,
      cta: {
        label: 'Grant microphone access',
        onClick: () => handleMicTap(),
      },
    }]);
  }, [handleMicTap]);

  const turnsCount = useMemo(
    () => items.filter(i => i.kind === 'turn').length,
    [items]
  );

  return (
    <>
      <Header
        state={state}
        sessionId="op_3a91"
        dev={showForce}
        capabilityChip={
          <CapabilityChip
            open={capOpen}
            onToggle={() => setCapOpen(v => !v)}
          />
        }
      />

      {/* F15 capability panel — opens inline below the Header. Constrained
          max-h + overflow-y per the global overlay rule. Closing on pick keeps
          the chip a one-tap affordance (open, scan, choose, dismiss). */}
      <CapabilityPanel
        open={capOpen}
        onClose={() => setCapOpen(false)}
        onPick={() => setCapOpen(false)}
      />

      {/* Conversation log — scrolls inside its own container */}
      <div ref={logRef} className="scroll-area" style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        paddingBottom: 8,
      }}>
        {/* Pinned error banners */}
        {banners.map(b => (
          <ErrorBanner key={b.id} banner={b} onDismiss={dismissBanner}/>
        ))}

        {/* Idle empty state */}
        {state === 'idle' && items.length === 0 && t.showExamples && (
          <ExamplePrompts/>
        )}

        {/* Render items. ToolTile gets `dev={showForce}` so the raw-JSON
            result is collapsed by default for end users (spoken answer
            leads) but open by default in dev mode for observability. */}
        {items.map(it => {
          if (it.kind === 'tool') return <ToolTile key={it.id} tool={it} dev={showForce}/>;
          if (it.kind === 'live-transcript') {
            return (
              <div key={it.id} style={{ padding: '6px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3, justifyContent: 'flex-end' }}>
                  <span className="mono tnum" style={{ fontSize: 10, color: 'var(--fg-faint)' }}>
                    {it.time}
                  </span>
                  <span className="mono" style={{
                    fontSize: 10, letterSpacing: '0.08em',
                    color: 'var(--accent)', fontWeight: 600,
                  }}>USER · LIVE</span>
                </div>
                <div style={{
                  fontSize: 14.5, lineHeight: 1.42,
                  color: 'var(--fg-muted)', fontStyle: 'italic',
                  textAlign: 'right',
                }}>
                  {it.text}
                  <span style={{
                    display: 'inline-block', width: 7, height: 14, marginLeft: 2,
                    verticalAlign: '-2px',
                    background: 'var(--accent)',
                    animation: 'caret-blink 1s steps(2) infinite',
                  }}/>
                </div>
              </div>
            );
          }
          return (
            <TurnRow
              key={it.id}
              turn={it}
              density={t.density}
              streaming={it.id === streamingId && it.role === 'assistant'}
            />
          );
        })}

        {/* Thinking inline indicator inside the log */}
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

      {/* Mic + state region (fixed at bottom of stage) */}
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

      {showForce && <ForceStateBar state={state} onSet={handleForceState}/>}

      <Footer onReset={handleReset} turns={turnsCount}
              showForce={showForce} onToggleForce={() => setShowForce(v => !v)}/>

      {/* ── Tweaks ── */}
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
// Helpers
// ─────────────────────────────────────────────────────────────
function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function hexA(hex, a) {
  const m = hex.replace('#', '');
  const full = m.length === 3
    ? m.split('').map(c => c + c).join('')
    : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ─────────────────────────────────────────────────────────────
// Mount inside iOS phone bezel
// ─────────────────────────────────────────────────────────────
const DEVICE_W = 402;
const DEVICE_H = 874;

function Stage() {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const fit = () => {
      const margin = 32; // breathing room around the device
      const sw = (window.innerWidth  - margin) / DEVICE_W;
      const sh = (window.innerHeight - margin) / DEVICE_H;
      setScale(Math.min(1, sw, sh));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid', placeItems: 'center',
      overflow: 'hidden',
      background:
        'radial-gradient(ellipse at top, #11141a 0%, var(--bg) 60%)',
    }}>
      {/* Scaled box reserves the post-scale footprint so it stays centered */}
      <div style={{ width: DEVICE_W * scale, height: DEVICE_H * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <IOSDevice dark>
            <div style={{
              display: 'flex', flexDirection: 'column',
              height: '100%', minHeight: 0,
              background: 'var(--bg)',
              color: 'var(--fg)',
              paddingTop: 54, /* clear the status bar / dynamic island */
            }}>
              <App/>
            </div>
          </IOSDevice>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Stage/>);
