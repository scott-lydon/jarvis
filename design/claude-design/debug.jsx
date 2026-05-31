// debug.jsx — Jarvis debug panel

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─── Pre-filled JSON examples for tool injection ─────────────
const INJECT_EXAMPLES = {
  // Mirrors the tool contract in plan.md §2.4. `fetched_at_iso` is the
  // freshness annotation that satisfies the "no reused-as-fresh data" rule
  // — the debug panel surfaces it so a tester can verify the cache age.
  weather: JSON.stringify({
    location: "Austin, TX",
    temp_f: 84,
    feels_like_f: 88,
    conditions: "Partly cloudy",
    humidity: 58,
    wind_mph: 8,
    source: "wttr.in",
    fetched_at_iso: "2026-05-31T16:44:13.366Z",
  }, null, 2),
  github: JSON.stringify({
    endpoint: "GET /repos/cattle-co/feeder/pulls",
    params:   { state: "open", per_page: 100 },
    response: {
      count: 7,
      oldest_days: 23,
      authors: ["kpark","mreed","jlin","tsato"],
    },
  }, null, 2),
  memory_write: JSON.stringify({
    key:   "user.units.temperature",
    value: "fahrenheit",
    scope: "global",
    ok:    true,
    id:    "mem_3a91",
  }, null, 2),
};

const SEED_EVENTS = [
  { t: '09:44:22.118', kind: 'audio.out',  msg: 'PCM16 frame 2.4kB → client' },
  { t: '09:44:22.041', kind: 'tool.done',  msg: 'github → 7 results (264ms)' },
  { t: '09:44:21.778', kind: 'tool.call',  msg: 'github(GET /repos/cattle-co/feeder/issues)' },
  { t: '09:44:21.612', kind: 'audio.in',   msg: '14 PCM16 frames → openai' },
  { t: '09:44:21.184', kind: 'session',    msg: 'turn detected (user)' },
];

const SEED_LOGS = [
  { t: '09:44:22.118', lvl: 'info',  src: 'ws',      msg: 'frame#4192  audio.out  2412B' },
  { t: '09:44:22.092', lvl: 'info',  src: 'ws',      msg: 'frame#4191  audio.out  2412B' },
  { t: '09:44:22.041', lvl: 'info',  src: 'tools',   msg: 'github       ok       264ms' },
  { t: '09:44:21.778', lvl: 'info',  src: 'tools',   msg: 'github       call     GET /repos/cattle-co/feeder/issues?state=open&labels=urgent' },
  { t: '09:44:21.612', lvl: 'info',  src: 'ws',      msg: '14 frames    audio.in  → openai' },
  { t: '09:44:21.601', lvl: 'debug', src: 'vad',     msg: 'turn.end   confidence=0.94' },
  { t: '09:44:21.184', lvl: 'debug', src: 'vad',     msg: 'turn.start confidence=0.88' },
  { t: '09:44:18.002', lvl: 'info',  src: 'session', msg: 'tokens   in=1248  out=512  total=1760' },
  { t: '09:44:17.504', lvl: 'warn',  src: 'tools',   msg: 'memory_write rate limit @ 4/10s' },
  { t: '09:44:14.220', lvl: 'info',  src: 'ws',      msg: 'response.audio.delta  size=18kB' },
  { t: '09:44:13.778', lvl: 'info',  src: 'tools',   msg: 'weather      ok       412ms' },
  { t: '09:44:13.366', lvl: 'info',  src: 'tools',   msg: 'weather      call     wttr.in?q=Austin,TX&format=j1' },
  { t: '09:44:12.001', lvl: 'info',  src: 'session', msg: 'session.created  model=gpt-realtime' },
  { t: '09:44:11.998', lvl: 'info',  src: 'ws',      msg: 'connect openai realtime → 101 switching protocols' },
  { t: '09:44:11.802', lvl: 'info',  src: 'http',    msg: 'POST /session.start  user=op_3a91' },
];

function lvlColor(l) {
  if (l === 'warn')  return 'var(--warn)';
  if (l === 'error') return 'var(--err)';
  if (l === 'debug') return 'var(--fg-faint)';
  return 'var(--fg-muted)';
}

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
function DebugApp() {
  const [forcedState, setForcedState] = useState('idle');
  const [activeTab, setActiveTab]     = useState('weather');
  const [drafts, setDrafts] = useState(INJECT_EXAMPLES);
  const [events, setEvents] = useState(SEED_EVENTS);
  const [logs,   setLogs]   = useState(SEED_LOGS);
  const [injectStatus, setInjectStatus] = useState(null);
  const [tokens, setTokens] = useState({ in: 1248, out: 512 });
  const [audioFrames, setAudioFrames] = useState(4192);
  const logRef = useRef(null);

  // Heartbeat: bump audio frame counter & token usage slowly to feel live
  useEffect(() => {
    const id = setInterval(() => {
      setAudioFrames(f => f + Math.floor(Math.random() * 3));
      setTokens(t => ({ ...t, out: t.out + Math.floor(Math.random() * 4) }));
    }, 1200);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll logs to top (newest at top)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [logs.length]);

  const inject = useCallback(() => {
    const payload = drafts[activeTab];
    let parsed;
    try { parsed = JSON.parse(payload); }
    catch (e) {
      setInjectStatus({ kind: 'err', msg: 'Invalid JSON: ' + e.message });
      return;
    }
    const t = nowTime();
    setEvents(ev => [{
      t, kind: 'inject.' + activeTab,
      msg: `injected ${Object.keys(parsed).length} keys`,
    }, ...ev].slice(0, 50));
    setLogs(l => [{
      t: t + '.' + String(Math.floor(Math.random() * 999)).padStart(3, '0'),
      lvl: 'info', src: 'debug',
      msg: `inject ${activeTab} → main screen  payload=${payload.length}B`,
    }, ...l]);
    setInjectStatus({ kind: 'ok', msg: 'Injected — main screen would receive this result' });
    setTimeout(() => setInjectStatus(null), 2400);
  }, [activeTab, drafts]);

  const clearLogs = () => setLogs([]);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr',
      gridTemplateRows: 'auto 1fr',
      minHeight: '100vh',
    }}>
      <TopBar forcedState={forcedState} setForcedState={setForcedState}/>
      <Workspace
        activeTab={activeTab} setActiveTab={setActiveTab}
        drafts={drafts} setDrafts={setDrafts}
        inject={inject} injectStatus={injectStatus}
        events={events}
        tokens={tokens} audioFrames={audioFrames}
        logs={logs} clearLogs={clearLogs} logRef={logRef}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TOP BAR — title, force-state toolbar, back link
// ─────────────────────────────────────────────────────────────
// Side-effect hints for FORCE STATE — surfaced as title= and aria-label so a
// developer / founder knows exactly what each state does to the main screen.
// Added post-UX-review (2026-05-31) per the debug-critic finding that the
// buttons had no labeling for their side effects.
const FORCE_STATE_HINT = {
  idle:        'Empty the conversation. Mic dimmed but reactive.',
  listening:   'Seed transcript + start live mic capture. No upstream call.',
  thinking:    'Seed transcript + render the routing indicator. No tool fires.',
  speaking:    'Seed transcript + last assistant turn streams with caret. No audio plays.',
  interrupted: 'Transient (~400ms): red ring, X glyph. Auto-reverts to listening.',
};

function TopBar({ forcedState, setForcedState }) {
  // 'interrupted' is the transient barge-in cue (US-04). Forceable here so
  // a tester can land directly in that state without doing the voice dance.
  const opts = ['idle', 'listening', 'thinking', 'speaking', 'interrupted'];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '11px 18px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg)',
      position: 'sticky', top: 0, zIndex: 5,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-ring)',
          display: 'grid', placeItems: 'center',
        }}>
          <div style={{ width: 6, height: 6, borderRadius: 50, background: 'var(--accent)' }}/>
        </div>
        <div style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>Jarvis</div>
        <span className="mono" style={{
          fontSize: 9.5, padding: '2px 6px', borderRadius: 4,
          background: 'var(--surface-2)', color: 'var(--warn)',
          border: '1px solid var(--border)', textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>debug</span>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginLeft: 8, padding: '4px 6px',
        background: 'var(--surface-1)', border: '1px solid var(--border)',
        borderRadius: 8,
      }}>
        <span className="mono" style={{
          fontSize: 10, color: 'var(--fg-muted)', letterSpacing: '0.06em',
          textTransform: 'uppercase', paddingLeft: 4,
        }}>force state</span>
        {/* `title` attributes added post-UX-review so a developer hovering
            knows what each state DOES (vs. just painting the badge). Per the
            debug-critic finding: "a founder mid-demo will tap 'speaking'
            expecting audio and nothing happens" — the tooltips are the cheap
            fix; full two-zone restructure (preview vs. apply-to-main) lands
            when the inject pipe is wired in Slice 1. */}
        {opts.map(o => (
          <button
            key={o}
            onClick={() => setForcedState(o)}
            title={FORCE_STATE_HINT[o]}
            aria-label={`Force ${o} — ${FORCE_STATE_HINT[o]}`}
            style={{
              padding: '5px 10px', fontSize: 11.5, fontFamily: 'var(--f-mono)',
              color: forcedState === o ? 'var(--fg)' : 'var(--fg-muted)',
              background: forcedState === o ? 'var(--surface-3)' : 'transparent',
              border: `1px solid ${forcedState === o ? 'var(--border-strong)' : 'transparent'}`,
              borderRadius: 5,
            }}
          >{o}</button>
        ))}
        <a
          href={`index.html?dev=1#force=${forcedState}`}
          title="Open the main screen forced into this state (new tab)"
          style={{
            marginLeft: 4, padding: '5px 9px',
            fontSize: 10.5, color: 'var(--accent)',
            border: '1px solid var(--accent-ring)',
            background: 'var(--accent-soft)',
            borderRadius: 5, textDecoration: 'none',
            fontFamily: 'var(--f-mono)',
          }}>open ↗</a>
      </div>

      <div style={{ flex: 1 }}/>

      <a href="index.html" style={{
        color: 'var(--fg-muted)', fontSize: 12, textDecoration: 'none',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}>
        ← Main screen
      </a>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// WORKSPACE — three columns (inject / state / logs)
// ─────────────────────────────────────────────────────────────
function Workspace(props) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(340px, 1fr) minmax(280px, 0.85fr) minmax(380px, 1.2fr)',
      gap: 1,
      background: 'var(--border)',
      minHeight: 0,
    }}>
      <InjectColumn  {...props}/>
      <StateColumn   {...props}/>
      <LogsColumn    {...props}/>
    </div>
  );
}

function Column({ title, subtitle, children, action }) {
  return (
    <div style={{
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      minHeight: 0, maxHeight: 'calc(100vh - 56px)',
    }}>
      <div style={{
        padding: '12px 16px 10px',
        borderBottom: '1px solid var(--border)',
        position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="mono" style={{
            fontSize: 10.5, letterSpacing: '0.08em',
            color: 'var(--fg-muted)', textTransform: 'uppercase', fontWeight: 600,
          }}>{title}</div>
          <div style={{ flex: 1 }}/>
          {action}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-faint)', marginTop: 3 }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Column 1: Inject tool results ─────────────────────────────
function InjectColumn({ activeTab, setActiveTab, drafts, setDrafts, inject, injectStatus }) {
  const tabs = ['weather', 'github', 'memory_write'];
  return (
    <Column title="Inject tool result" subtitle="Simulates a tool call returning this payload to the main screen.">
      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 4, padding: '8px 12px 0',
        borderBottom: '1px solid var(--border)',
      }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            padding: '7px 10px',
            fontSize: 12, fontFamily: 'var(--f-mono)',
            color: activeTab === t ? 'var(--fg)' : 'var(--fg-muted)',
            background: activeTab === t ? 'var(--surface-2)' : 'transparent',
            border: '1px solid',
            borderColor: activeTab === t ? 'var(--border)' : 'transparent',
            borderBottomColor: activeTab === t ? 'var(--surface-2)' : 'transparent',
            borderRadius: '6px 6px 0 0',
            marginBottom: -1,
          }}>{t}</button>
        ))}
      </div>

      <div className="scroll-area" style={{
        flex: 1, minHeight: 0, padding: '12px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <textarea
          value={drafts[activeTab]}
          onChange={(e) => setDrafts(d => ({ ...d, [activeTab]: e.target.value }))}
          spellCheck={false}
          style={{
            flex: 1, minHeight: 280,
            padding: '10px 12px',
            background: 'var(--surface-1)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            fontFamily: 'var(--f-mono)',
            fontSize: 12, lineHeight: 1.55,
            resize: 'vertical',
            outline: 'none',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={inject} style={{
            padding: '8px 14px',
            background: 'var(--accent)', color: '#062611',
            border: 'none', borderRadius: 6,
            fontSize: 12.5, fontWeight: 600,
            fontFamily: 'var(--f-sans)',
          }}>Inject {activeTab}</button>
          <button onClick={() => setDrafts(d => ({ ...d, [activeTab]: INJECT_EXAMPLES[activeTab] }))} style={{
            padding: '8px 12px',
            background: 'var(--surface-2)', color: 'var(--fg-muted)',
            border: '1px solid var(--border)', borderRadius: 6,
            fontSize: 12,
          }}>Reset example</button>
          {injectStatus && (
            <span className="fade-in" style={{
              fontSize: 11.5,
              color: injectStatus.kind === 'ok' ? 'var(--accent)' : 'var(--err)',
            }}>
              {injectStatus.msg}
            </span>
          )}
        </div>
      </div>
    </Column>
  );
}

// ── Column 2: Current session state ───────────────────────────
function StateColumn({ events, tokens, audioFrames }) {
  return (
    <Column title="Session" subtitle="Live data from the WebSocket.">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, padding: 14 }}>
        <KV label="USER ID"     value="op_3a91"/>
        <KV label="MODEL"       value="gpt-realtime"/>
        <KV label="WEBSOCKET"   value={<><span className="dot live" style={{ marginRight: 6 }}/>connected · 412ms</>}/>
        <KV label="STARTED"     value="09:44:11.998"/>

        <Divider/>

        {/* Post-UX-review (2026-05-31) telemetry refactor. AUDIO FRAMES OUT is
            a vanity counter — high number, no actionable signal. The rows
            below map directly to QA_ADVERSARY.md attack categories so a
            developer reproducing a bug can read them at a glance:
              LAST UPSTREAM EVENT → J-CAT-1 (Realtime API regression)
              WEATHER CACHE AGE   → US-08 60s TTL + no-reused-as-fresh rule
              MEMORY SCOPE        → J-CAT-6 (per-user isolation)
              FIRST-AUDIO p99     → US-01 first-audio-frame latency budget. */}
        <KV label="LAST UPSTREAM EVENT" value={<span className="mono" style={{ color: 'var(--info)' }}>response.output_audio.delta</span>}/>
        <KV label="WEATHER CACHE AGE"   value={<span className="tnum">12s <span style={{ color: 'var(--fg-dim)' }}>(ttl 60s)</span></span>}/>
        <KV label="MEMORY SCOPE"        value={<span className="mono">user_id=op_3a91</span>}/>
        <KV label="FIRST-AUDIO p99"     value={<span className="tnum">1.18s <span style={{ color: 'var(--fg-dim)' }}>(budget 1.5s)</span></span>}/>

        <Divider/>

        <KV label="TOKENS IN / OUT"   value={<span className="tnum">{tokens.in.toLocaleString()} / {tokens.out.toLocaleString()}</span>}/>
        <KV label="TOOL CALLS"        value={<span className="tnum">3 weather · 1 github · 1 memory_write</span>}/>
        <KV label="ERRORS"            value={<span style={{ color: 'var(--warn)' }}>1 warn · 0 error</span>}/>

        <Divider/>

        <div className="mono" style={{
          fontSize: 10, letterSpacing: '0.08em', color: 'var(--fg-faint)',
          textTransform: 'uppercase', margin: '0 0 8px',
        }}>Last 5 events</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {events.slice(0, 5).map((e, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '78px 88px 1fr',
              gap: 8, alignItems: 'baseline',
              padding: '4px 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
            }}>
              <span className="mono tnum" style={{ fontSize: 10.5, color: 'var(--fg-faint)' }}>{e.t}</span>
              <span className="mono" style={{
                fontSize: 10.5, color: eventColor(e.kind),
              }}>{e.kind}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </Column>
  );
}

function KV({ label, value }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '128px 1fr',
      alignItems: 'baseline', padding: '5px 0',
    }}>
      <div className="mono" style={{
        fontSize: 10, letterSpacing: '0.06em',
        color: 'var(--fg-faint)', textTransform: 'uppercase',
      }}>{label}</div>
      <div style={{ fontSize: 12.5, color: 'var(--fg)', fontFamily: 'var(--f-mono)' }}>{value}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '12px 0' }}/>;
}

function eventColor(k) {
  if (k.startsWith('tool')) return 'var(--accent)';
  if (k.startsWith('audio')) return 'var(--info)';
  if (k.startsWith('inject')) return 'var(--warn)';
  if (k.startsWith('error')) return 'var(--err)';
  return 'var(--fg-muted)';
}

// ── Column 3: Logs ────────────────────────────────────────────
function LogsColumn({ logs, clearLogs, logRef }) {
  const [filter, setFilter] = useState('all');
  const filtered = useMemo(
    () => filter === 'all' ? logs : logs.filter(l => l.lvl === filter),
    [logs, filter]
  );
  return (
    <Column
      title="Logs"
      subtitle={`${logs.length} events · scrolls inside this pane`}
      action={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{
            background: 'var(--surface-1)', color: 'var(--fg-muted)',
            border: '1px solid var(--border)', borderRadius: 5,
            padding: '4px 7px', fontSize: 11, fontFamily: 'var(--f-mono)',
            outline: 'none',
          }}>
            <option value="all">all</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <button onClick={clearLogs} style={{
            padding: '5px 10px',
            background: 'var(--surface-2)', color: 'var(--fg-muted)',
            border: '1px solid var(--border)', borderRadius: 5,
            fontSize: 11, fontFamily: 'var(--f-mono)',
          }}>Clear</button>
        </div>
      }
    >
      <div ref={logRef} className="scroll-area" style={{
        flex: 1, minHeight: 0, padding: '4px 0',
      }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontFamily: 'var(--f-mono)', fontSize: 11.5,
        }}>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 24, textAlign: 'center', color: 'var(--fg-faint)' }}>
                  No events
                </td>
              </tr>
            )}
            {filtered.map((l, i) => (
              <tr key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--hairline)' }}>
                <td style={{
                  padding: '5px 10px 5px 14px', whiteSpace: 'nowrap',
                  color: 'var(--fg-faint)', verticalAlign: 'top',
                }}>{l.t}</td>
                <td style={{
                  padding: '5px 8px', whiteSpace: 'nowrap',
                  color: lvlColor(l.lvl), verticalAlign: 'top', width: 50,
                  textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em',
                }}>{l.lvl}</td>
                <td style={{
                  padding: '5px 8px', whiteSpace: 'nowrap',
                  color: 'var(--fg-muted)', verticalAlign: 'top', width: 70,
                }}>{l.src}</td>
                <td style={{
                  padding: '5px 14px 5px 8px',
                  color: 'var(--fg)', verticalAlign: 'top',
                  wordBreak: 'break-word',
                }}>{l.msg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Column>
  );
}

function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

ReactDOM.createRoot(document.getElementById('root')).render(<DebugApp/>);
