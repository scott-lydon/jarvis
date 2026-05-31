// components.jsx — shared UI bits for the main Jarvis screen
// All exported to window for cross-script use.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─────────────────────────────────────────────────────────────
// Tiny inline icon set (no external deps, no SVG slop)
// ─────────────────────────────────────────────────────────────
const Icon = {
  mic: (props) => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3"/>
      <path d="M5 11a7 7 0 0 0 14 0"/>
      <line x1="12" y1="18" x2="12" y2="22"/>
    </svg>
  ),
  chevron: (props) => (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="9 6 15 12 9 18"/>
    </svg>
  ),
  close: (props) => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="6" y1="6" x2="18" y2="18"/>
      <line x1="18" y1="6" x2="6" y2="18"/>
    </svg>
  ),
  reset: (props) => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
    </svg>
  ),
  warning: (props) => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
};

// ─────────────────────────────────────────────────────────────
// STATE LABELS
// ─────────────────────────────────────────────────────────────
const STATE_META = {
  idle:      { label: 'Idle',      hint: 'Tap mic to start',          dotClass: '',     color: 'var(--fg-muted)' },
  listening: { label: 'Listening', hint: 'Speak now',                 dotClass: 'live', color: 'var(--accent)'   },
  thinking:  { label: 'Thinking',  hint: 'Routing…',                  dotClass: 'warn', color: 'var(--warn)'     },
  speaking:  { label: 'Speaking',  hint: 'Jarvis is responding',      dotClass: 'live', color: 'var(--accent)'   },
};

// ─────────────────────────────────────────────────────────────
// HEADER — status badge + session id
// ─────────────────────────────────────────────────────────────
function Header({ state, sessionId, dev }) {
  const meta = STATE_META[state];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px 10px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg)',
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
        <div style={{ fontWeight: 600, letterSpacing: '-0.01em', fontSize: 15 }}>Jarvis</div>
        {dev && (
          <span className="mono" style={{
            fontSize: 9.5, padding: '2px 6px', borderRadius: 4,
            background: 'var(--surface-2)', color: 'var(--warn)',
            border: '1px solid var(--border)', textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>dev</span>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '5px 10px 5px 8px',
        background: 'var(--surface-1)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        fontSize: 12,
      }}>
        <span className={`dot ${meta.dotClass}`}/>
        <span style={{ color: meta.color, fontWeight: 500 }}>{meta.label}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ERROR BANNER — pinned at top of log, dismissible
// ─────────────────────────────────────────────────────────────
function ErrorBanner({ banner, onDismiss }) {
  const palette = {
    err:  { bg: 'rgba(248,113,113,0.08)',  border: 'rgba(248,113,113,0.32)',  fg: '#fca5a5' },
    warn: { bg: 'rgba(251,191,36,0.08)',   border: 'rgba(251,191,36,0.32)',   fg: '#fcd34d' },
    info: { bg: 'rgba(96,165,250,0.08)',   border: 'rgba(96,165,250,0.32)',   fg: '#93c5fd' },
  }[banner.kind || 'err'];
  return (
    <div className="fade-in" style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '9px 10px', margin: '8px 12px 0',
      background: palette.bg, border: `1px solid ${palette.border}`,
      borderRadius: 8, color: palette.fg, fontSize: 12.5,
    }}>
      <span style={{ marginTop: 1, color: palette.fg }}><Icon.warning/></span>
      <div style={{ flex: 1, lineHeight: 1.4 }}>
        <div style={{ fontWeight: 600 }}>{banner.title}</div>
        {banner.body && <div style={{ opacity: 0.85, marginTop: 2 }}>{banner.body}</div>}
      </div>
      <button onClick={() => onDismiss(banner.id)} style={{ color: palette.fg, opacity: 0.7, padding: 2 }} aria-label="Dismiss">
        <Icon.close/>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TURN ROW — user / assistant; tight, role-labeled
// ─────────────────────────────────────────────────────────────
function TurnRow({ turn, density, streaming }) {
  const isUser = turn.role === 'user';
  const pad = density === 'tight' ? '6px 14px' : density === 'medium' ? '10px 14px' : '14px 14px';
  return (
    <div className="fade-in" style={{ padding: pad }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3,
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      }}>
        <span className="mono" style={{
          fontSize: 10, letterSpacing: '0.08em',
          color: isUser ? 'var(--fg-muted)' : 'var(--accent)',
          fontWeight: 600,
          order: isUser ? 2 : 0,
        }}>
          {isUser ? 'USER' : 'JARVIS'}
        </span>
        <span className="mono tnum" style={{ fontSize: 10, color: 'var(--fg-faint)', order: 1 }}>
          {turn.time}
        </span>
      </div>
      <div style={{
        color: 'var(--fg)',
        fontSize: 14.5, lineHeight: 1.42,
        textWrap: 'pretty',
        whiteSpace: 'pre-wrap',
        textAlign: isUser ? 'right' : 'left',
      }}>
        {turn.text}
        {streaming && (
          <span style={{
            display: 'inline-block', width: 7, height: 14, marginLeft: 2,
            verticalAlign: '-2px',
            background: 'var(--accent)',
            animation: 'caret-blink 1s steps(2) infinite',
          }}/>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TOOL TILE — bordered card, mono header, expandable JSON
// ─────────────────────────────────────────────────────────────
const TOOL_META = {
  weather:      { icon: '◐', label: 'weather'      },
  github:       { icon: '◇', label: 'github'       },
  memory_write: { icon: '◈', label: 'memory_write' },
  memory_read:  { icon: '◈', label: 'memory_read'  },
};

function JsonBlock({ value }) {
  const text = useMemo(() => {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }, [value]);
  return (
    <pre className="mono" style={{
      margin: 0, padding: '8px 10px',
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      fontSize: 11.5, lineHeight: 1.5,
      color: 'var(--fg)',
      overflowX: 'auto',
      whiteSpace: 'pre',
    }}>{text}</pre>
  );
}

function ToolTile({ tool }) {
  const [openArgs, setOpenArgs] = useState(false);
  const [openResult, setOpenResult] = useState(true);
  const meta = TOOL_META[tool.name] || { icon: '◌', label: tool.name };
  const hasError = !!tool.error;

  return (
    <div className="fade-in" style={{
      margin: '6px 14px',
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--surface-1)',
      overflow: 'hidden',
    }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px',
        borderBottom: '1px solid var(--hairline)',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.02), transparent)',
      }}>
        <span style={{ color: hasError ? 'var(--err)' : 'var(--accent)', fontSize: 13 }}>{meta.icon}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--fg)', fontWeight: 600 }}>
          {meta.label}
        </span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--fg-faint)' }}>
          {tool.duration}ms
        </span>
        <div style={{ flex: 1 }}/>
        <span className="mono" style={{
          fontSize: 9.5, padding: '2px 6px', borderRadius: 4,
          background: hasError ? 'rgba(248,113,113,0.12)' : 'var(--surface-2)',
          color: hasError ? 'var(--err)' : 'var(--fg-muted)',
          border: `1px solid ${hasError ? 'rgba(248,113,113,0.3)' : 'var(--border)'}`,
          textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
        }}>
          {hasError ? 'error' : 'tool call'}
        </span>
      </div>

      {/* args (collapsed by default) */}
      <CollapseRow label="args" open={openArgs} onToggle={() => setOpenArgs(v => !v)}>
        <JsonBlock value={tool.args}/>
      </CollapseRow>

      {/* result / error */}
      <CollapseRow
        label={hasError ? 'error' : 'result'}
        open={openResult}
        onToggle={() => setOpenResult(v => !v)}
        labelColor={hasError ? 'var(--err)' : undefined}
      >
        <JsonBlock value={hasError ? tool.error : tool.result}/>
      </CollapseRow>
    </div>
  );
}

function CollapseRow({ label, open, onToggle, labelColor, children }) {
  return (
    <div>
      <button onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        width: '100%', padding: '6px 10px',
        color: labelColor || 'var(--fg-muted)',
        fontFamily: 'var(--f-mono)', fontSize: 11,
        textAlign: 'left',
      }}>
        <span style={{
          display: 'inline-flex', transition: 'transform 120ms',
          transform: open ? 'rotate(90deg)' : 'rotate(0)',
        }}><Icon.chevron/></span>
        <span>{label}</span>
      </button>
      {open && <div style={{ padding: '0 10px 10px' }}>{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// IDLE EMPTY STATE — example prompts
// ─────────────────────────────────────────────────────────────
const EXAMPLE_PROMPTS = [
  { tool: 'github',       text: 'How many open PRs on this repo?' },
  { tool: 'weather',      text: 'Weather in Austin' },
  { tool: 'memory_write', text: 'Yesterday I asked about deployment, what did we figure out?' },
];

function ExamplePrompts({ onUse }) {
  return (
    <div style={{ padding: '20px 14px 8px' }}>
      <div className="mono" style={{
        fontSize: 10, letterSpacing: '0.08em',
        color: 'var(--fg-faint)', marginBottom: 10,
        textTransform: 'uppercase',
      }}>
        Try saying
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {EXAMPLE_PROMPTS.map((p, i) => (
          <button key={i} onClick={() => onUse?.(p)} style={{
            display: 'flex', alignItems: 'center', gap: 9,
            padding: '10px 11px', textAlign: 'left',
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--fg)', fontSize: 13.5,
            transition: 'border-color 120ms, background 120ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
            <span className="mono" style={{
              fontSize: 9.5, color: 'var(--accent)',
              padding: '2px 5px', borderRadius: 3,
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent-ring)',
            }}>{p.tool}</span>
            <span style={{ lineHeight: 1.35 }}>"{p.text}"</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MIC BUTTON — animated by state. Bottom-center, 88px.
// ─────────────────────────────────────────────────────────────
function MicButton({ state, onTap, micLevels }) {
  const isListening = state === 'listening';
  const isThinking  = state === 'thinking';
  const isSpeaking  = state === 'speaking';
  const isActive    = isListening || isSpeaking;

  return (
    <div style={{
      position: 'relative',
      width: 120, height: 120,
      display: 'grid', placeItems: 'center',
    }}>
      {/* Pulsing rings, only while listening */}
      {isListening && [0, 1].map(i => (
        <div key={i} style={{
          position: 'absolute', inset: 16,
          borderRadius: '50%',
          border: '2px solid var(--accent)',
          animation: `ring-pulse 1.8s ease-out ${i * 0.9}s infinite`,
          opacity: 0,
        }}/>
      ))}

      {/* Static ring when speaking — softer */}
      {isSpeaking && (
        <div style={{
          position: 'absolute', inset: 18,
          borderRadius: '50%',
          border: '1.5px solid var(--accent-ring)',
        }}/>
      )}

      {/* Mic button */}
      <button
        onClick={onTap}
        aria-label={isActive ? 'Stop' : 'Start listening'}
        style={{
          position: 'relative',
          width: 88, height: 88,
          borderRadius: '50%',
          background: isListening
            ? 'radial-gradient(circle at 50% 35%, #2a3a30, #0f1612)'
            : 'var(--surface-2)',
          border: `1.5px solid ${isListening ? 'var(--accent)' : 'var(--border-strong)'}`,
          boxShadow: isListening
            ? `0 0 0 5px var(--accent-soft), 0 8px 28px -8px var(--accent-glow)`
            : isSpeaking
              ? `0 0 0 4px var(--accent-soft)`
              : '0 6px 20px -10px rgba(0,0,0,0.7)',
          color: isListening ? 'var(--accent)' : 'var(--fg-muted)',
          display: 'grid', placeItems: 'center',
          transition: 'background 200ms, border-color 200ms, box-shadow 200ms, color 200ms',
        }}
      >
        {isThinking && <ThinkingDots/>}
        {isSpeaking && <WaveformBars/>}
        {(state === 'idle' || isListening) && (
          <div style={{ display: 'grid', placeItems: 'center', gap: 6 }}>
            <Icon.mic/>
            {isListening && <LevelMeter levels={micLevels}/>}
          </div>
        )}
      </button>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {[0,1,2].map(i => (
        <span key={i} style={{
          width: 7, height: 7, borderRadius: '50%',
          background: 'var(--fg-muted)',
          animation: `dot-bounce 1.1s ease-in-out ${i * 0.15}s infinite`,
        }}/>
      ))}
    </div>
  );
}

function WaveformBars({ count = 9 }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 3,
      height: 26,
    }}>
      {Array.from({ length: count }).map((_, i) => {
        const h = [10, 16, 22, 14, 24, 12, 20, 16, 10][i % 9];
        const delay = (i * 0.07) + 's';
        return (
          <span key={i} style={{
            width: 2.5, height: h,
            background: 'var(--accent)',
            borderRadius: 2,
            transformOrigin: 'center',
            animation: `wave 0.85s ease-in-out ${delay} infinite`,
          }}/>
        );
      })}
    </div>
  );
}

function LevelMeter({ levels = [0.4, 0.7, 0.55, 0.9, 0.6, 0.4, 0.7] }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 2.5,
      height: 8,
    }}>
      {levels.map((v, i) => (
        <span key={i} style={{
          width: 2, height: Math.max(2, v * 8),
          background: 'var(--accent)',
          borderRadius: 1,
          opacity: 0.85,
          transition: 'height 120ms',
        }}/>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FORCE STATE TOOLBAR — dev mode only
// ─────────────────────────────────────────────────────────────
function ForceStateBar({ state, onSet }) {
  const opts = ['idle', 'listening', 'thinking', 'speaking'];
  return (
    <div style={{
      margin: '0 12px 8px',
      padding: '6px 8px',
      background: 'var(--surface-1)',
      border: '1px dashed var(--border-strong)',
      borderRadius: 8,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span className="mono" style={{
        fontSize: 9.5, color: 'var(--warn)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
        paddingLeft: 4, marginRight: 2, whiteSpace: 'nowrap',
      }}>force state</span>
      {opts.map(o => (
        <button key={o} onClick={() => onSet(o)} style={{
          flex: 1, padding: '6px 0',
          fontSize: 11, fontFamily: 'var(--f-mono)',
          color: state === o ? 'var(--fg)' : 'var(--fg-muted)',
          background: state === o ? 'var(--surface-3)' : 'transparent',
          border: `1px solid ${state === o ? 'var(--border-strong)' : 'transparent'}`,
          borderRadius: 5,
          transition: 'all 120ms',
        }}>{o}</button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FOOTER — debug link + session reset
// ─────────────────────────────────────────────────────────────
function Footer({ onReset, turns, showForce, onToggleForce }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 16px 38px', /* extra bottom to clear iOS home indicator */
      borderTop: '1px solid var(--border)',
      background: 'var(--bg)',
      fontSize: 11.5,
    }}>
      <a href="debug.html" style={{
        color: 'var(--fg-muted)',
        textDecoration: 'none',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: 'var(--fg-faint)',
        }}/>
        Debug panel
      </a>
      <button onClick={onToggleForce} style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 9px', borderRadius: 999,
        fontSize: 11, fontFamily: 'var(--f-mono)', letterSpacing: '0.02em',
        color: showForce ? 'var(--warn)' : 'var(--fg-muted)',
        background: showForce ? 'rgba(251,191,36,0.1)' : 'var(--surface-1)',
        border: `1px solid ${showForce ? 'rgba(251,191,36,0.32)' : 'var(--border)'}`,
      }}>
        <span style={{ fontSize: 11, lineHeight: 1 }}>{showForce ? '●' : '○'}</span>
        Dev mode
      </button>
      <button onClick={onReset} style={{
        color: 'var(--fg-muted)',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}>
        <Icon.reset/>
        Reset
      </button>
    </div>
  );
}

Object.assign(window, {
  Icon, STATE_META, TOOL_META,
  Header, ErrorBanner, TurnRow, ToolTile, JsonBlock, CollapseRow,
  ExamplePrompts, MicButton, ThinkingDots, WaveformBars, LevelMeter,
  ForceStateBar, Footer,
  EXAMPLE_PROMPTS,
});
