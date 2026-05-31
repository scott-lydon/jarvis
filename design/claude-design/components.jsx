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
  // Listening and speaking previously shared the green accent + accent-soft
  // glow, which made them visually identical from any distance. Post-UX-review
  // (2026-05-31) speaking is now cyan so the user can tell at a glance whether
  // it's their turn to talk or Jarvis's. See styles.css --state-* tokens.
  // Glyph class is a redundant non-color signal (WCAG 1.4.1 Use-of-Color).
  idle:        { label: 'Idle',        hint: 'Tap mic to start',     dotClass: '',     glyph: 'idle',        color: 'var(--fg-muted)'         },
  listening:   { label: 'Listening',   hint: 'Speak now',            dotClass: 'live', glyph: 'listening',   color: 'var(--state-listening)'  },
  thinking:    { label: 'Thinking',    hint: 'Routing…',             dotClass: 'warn', glyph: 'thinking',    color: 'var(--state-thinking)'   },
  speaking:    { label: 'Speaking',    hint: 'Jarvis is responding', dotClass: 'speak',glyph: 'speaking',    color: 'var(--state-speaking)'   },
  // Transient state shown for ~400ms after a barge-in cancel (US-04).
  // Auto-reverts to 'listening' (the user is the one who interrupted,
  // so we should hear them next). Visual + X-glyph for trauma-fast read.
  interrupted: { label: 'Interrupted', hint: 'Stopping…',            dotClass: 'err',  glyph: 'interrupted', color: 'var(--state-interrupted)' },
};

// ─────────────────────────────────────────────────────────────
// HEADER — status badge + session id
// ─────────────────────────────────────────────────────────────
function Header({ state, sessionId, dev, capabilityChip }) {
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
        {/* Wordmark + tagline. Tagline added post-UX-review so a first-time user
            gets a one-line "what is this" within 2 seconds of opening the app. */}
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <div style={{ fontWeight: 600, letterSpacing: '-0.01em', fontSize: 15 }}>Jarvis</div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginTop: 1 }}>
            Voice copilot for field work
          </div>
        </div>
        {dev && (
          <span className="mono" style={{
            fontSize: 9.5, padding: '2px 6px', borderRadius: 4,
            background: 'var(--surface-2)', color: 'var(--warn)',
            border: '1px solid var(--border)', textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>dev</span>
        )}
      </div>

      {/* Status badge + (optional) capability chip. The chip is supplied by
          the parent (main.jsx) so the chip can carry its own open/onToggle
          state without leaking into Header. Gap 6 keeps them clustered. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {capabilityChip}
        <div
          role="status"
          aria-label={`Jarvis is ${meta.label}. ${meta.hint}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '5px 10px 5px 8px',
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
            borderRadius: 999,
            fontSize: 12,
          }}
        >
          <span className={`state-glyph ${meta.glyph}`} aria-hidden="true"/>
          <span style={{ color: meta.color, fontWeight: 500 }}>{meta.label}</span>
        </div>
      </div>

      {/* Screen-reader-only live region. Announces every state transition so
          a VoiceOver user knows whether Jarvis is hearing them, working,
          speaking, or has been interrupted. WCAG 4.1.3. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Jarvis is {meta.label.toLowerCase()}. {meta.hint}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ERROR BANNER — pinned at top of log, dismissible
// ─────────────────────────────────────────────────────────────
// Banners now support an optional `cta` (action-bearing pill) and a
// `dismissible: false` flag. Mandatory-action banners (mic permission)
// drop the dismiss X — a first-time user shouldn't be able to ignore a
// blocker disguised as advice. Per UX review 2026-05-31.
function ErrorBanner({ banner, onDismiss }) {
  const palette = {
    err:  { bg: 'rgba(248,113,113,0.08)',  border: 'rgba(248,113,113,0.32)',  fg: '#fca5a5' },
    warn: { bg: 'rgba(251,191,36,0.08)',   border: 'rgba(251,191,36,0.32)',   fg: '#fcd34d' },
    info: { bg: 'rgba(96,165,250,0.08)',   border: 'rgba(96,165,250,0.32)',   fg: '#93c5fd' },
  }[banner.kind || 'err'];
  const showDismiss = banner.dismissible !== false;
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
        {banner.cta && (
          <button
            onClick={banner.cta.onClick}
            style={{
              marginTop: 8,
              padding: '6px 12px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              color: '#0a0a0a',
              background: palette.fg,
              border: `1px solid ${palette.fg}`,
              cursor: 'pointer',
            }}
          >
            {banner.cta.label}
          </button>
        )}
      </div>
      {showDismiss && (
        <button
          onClick={() => onDismiss(banner.id)}
          style={{ color: palette.fg, opacity: 0.7, padding: 2 }}
          aria-label="Dismiss"
        >
          <Icon.close/>
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TURN ROW — user / assistant; tight, role-labeled
// ─────────────────────────────────────────────────────────────
function TurnRow({ turn, density, streaming }) {
  const isUser = turn.role === 'user';
  const isRefusal = turn.refused === true; // US-06 grounded refusal variant
  const pad = density === 'tight' ? '6px 14px' : density === 'medium' ? '10px 14px' : '14px 14px';
  return (
    <div
      className="fade-in"
      style={{
        padding: pad,
        // Refusal variant: left-edge neutral-info accent stripe so the user
        // can see at a glance "this was refused on purpose, not fabricated".
        // Trust signal that matches the spec.md US-06 acceptance criteria.
        borderLeft: isRefusal ? '3px solid var(--info)' : '3px solid transparent',
        marginLeft:  isRefusal ? -3 : 0,
      }}
    >
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
        {isRefusal && (
          <span className="mono" style={{
            fontSize: 9.5, padding: '2px 6px', borderRadius: 4,
            background: 'rgba(96,165,250,0.12)',
            color: 'var(--info)',
            border: '1px solid rgba(96,165,250,0.32)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>no tool for this</span>
        )}
        <span className="mono tnum" style={{ fontSize: 10, color: 'var(--fg-faint)', order: 1 }}>
          {turn.time}
        </span>
      </div>
      <div style={{
        color: isRefusal ? 'var(--fg-dim)' : 'var(--fg)',
        fontSize: 14.5, lineHeight: 1.42,
        textWrap: 'pretty',
        whiteSpace: 'pre-wrap',
        textAlign: isUser ? 'right' : 'left',
        fontStyle: isRefusal ? 'italic' : 'normal',
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

// ToolTile gained two post-UX-review affordances:
// (1) `pending` state — rendered while the tool call is in flight, BEFORE
//     the duration or result lands. Makes US-02 cadence visible: the user
//     sees "Jarvis is reaching for the data" instead of unexplained silence.
// (2) `dev` prop — when false, the raw JSON result is collapsed by default
//     so a non-developer user gets the spoken answer as the primary signal,
//     not a pretty-printed JSON dump competing for attention.
function ToolTile({ tool, dev = false }) {
  const isPending = tool.pending === true || tool.duration == null;
  const hasError = !!tool.error;
  // Non-dev users: collapse result by default so the spoken answer leads.
  // Dev/pending: open by default for transparency / observability.
  const [openArgs, setOpenArgs] = useState(false);
  const [openResult, setOpenResult] = useState(dev || isPending);
  const meta = TOOL_META[tool.name] || { icon: '◌', label: tool.name };

  // Pending tiles get a shimmering border accent (the .fade-in animation is
  // suppressed under prefers-reduced-motion; a static accent border remains).
  const borderColor = isPending ? 'var(--accent-ring)'
                    : hasError  ? 'rgba(248,113,113,0.45)'
                                : 'var(--border)';

  return (
    <div className="fade-in" style={{
      margin: '6px 14px',
      border: `1px solid ${borderColor}`,
      borderRadius: 8,
      background: 'var(--surface-1)',
      overflow: 'hidden',
      boxShadow: isPending ? '0 0 0 3px var(--accent-soft)' : 'none',
      transition: 'box-shadow 200ms, border-color 200ms',
    }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px',
        borderBottom: '1px solid var(--hairline)',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.02), transparent)',
      }}>
        <span style={{
          color: hasError  ? 'var(--err)'
               : isPending ? 'var(--accent)'
                           : 'var(--accent)',
          fontSize: 13,
        }}>
          {meta.icon}
        </span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--fg)', fontWeight: 600 }}>
          {meta.label}
          {isPending && (
            <span style={{
              marginLeft: 4, color: 'var(--accent)',
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
              <ThinkingDots/>
            </span>
          )}
        </span>
        {!isPending && (
          <span className="mono" style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
            {tool.duration}ms
          </span>
        )}
        <div style={{ flex: 1 }}/>
        <span className="mono" style={{
          fontSize: 9.5, padding: '2px 6px', borderRadius: 4,
          background: hasError
            ? 'rgba(248,113,113,0.12)'
            : isPending
              ? 'var(--accent-soft)'
              : 'var(--surface-2)',
          color: hasError
            ? 'var(--err)'
            : isPending
              ? 'var(--accent)'
              : 'var(--fg-muted)',
          border: `1px solid ${
            hasError  ? 'rgba(248,113,113,0.3)'
          : isPending ? 'var(--accent-ring)'
                      : 'var(--border)'
          }`,
          textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
        }}>
          {hasError ? 'error' : isPending ? 'pending' : 'tool call'}
        </span>
      </div>

      {/* args (collapsed by default) */}
      {!isPending && (
        <CollapseRow label="args" open={openArgs} onToggle={() => setOpenArgs(v => !v)}>
          <JsonBlock value={tool.args}/>
        </CollapseRow>
      )}

      {/* result / error */}
      {!isPending && (
        <CollapseRow
          label={hasError ? 'error' : 'result'}
          open={openResult}
          onToggle={() => setOpenResult(v => !v)}
          labelColor={hasError ? 'var(--err)' : undefined}
        >
          <JsonBlock value={hasError ? tool.error : tool.result}/>
        </CollapseRow>
      )}
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
// `chip` is the human-facing label shown to the end user. `tool` is the
// internal tool name used by the dispatcher. They diverge for memory_write
// because the raw tool name reads as engineer-speak ("write to memory"),
// while users intuit "memory" as a capability category. github stays as
// github since the target audience (technical-adjacent field workers) knows
// the term and the spec uses real public repos as the demo.
const EXAMPLE_PROMPTS = [
  { tool: 'github',       chip: 'github',  text: 'How many open PRs on this repo?' },
  { tool: 'weather',      chip: 'weather', text: 'Weather in Austin' },
  { tool: 'memory_write', chip: 'memory',  text: 'Yesterday I asked about deployment, what did we figure out?' },
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
            }}>{p.chip || p.tool}</span>
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
  const isIdle      = state === 'idle';
  const isListening = state === 'listening';
  const isThinking  = state === 'thinking';
  const isSpeaking  = state === 'speaking';
  const isInterrupted = state === 'interrupted';
  const isActive    = isListening || isSpeaking;

  // Speaking now uses the speaking-state cyan so the user can distinguish
  // "should I talk?" (green ring) from "shut up, Jarvis is talking" (cyan
  // ring) at a glance. Interrupted uses err-red for the brief barge-in cue.
  const ringColor = isListening   ? 'var(--state-listening)'
                  : isSpeaking    ? 'var(--state-speaking)'
                  : isInterrupted ? 'var(--state-interrupted)'
                  : 'var(--accent)';
  const ringGlow  = isListening   ? 'rgba(74,222,128,0.32)'
                  : isSpeaking    ? 'rgba(34,211,238,0.32)'
                  : isInterrupted ? 'rgba(248,113,113,0.36)'
                  : 'var(--accent-soft)';

  return (
    // The OUTER wrapper is now the hit target. 120×120 (was 88×88 inside a
    // dead 120×120 wrapper) — gloves, wet hands, and ambient-stress fingers
    // miss small targets. WCAG 2.5.8 and 2.5.5. role="button" + aria-pressed
    // give screen readers a real toggle to announce.
    <div
      role="button"
      aria-pressed={isActive}
      aria-label={isActive ? 'Stop Jarvis' : 'Start listening'}
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap?.(); } }}
      style={{
        position: 'relative',
        width: 120, height: 120,
        display: 'grid', placeItems: 'center',
        cursor: 'pointer',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* Idle: slow breathing pulse so the button looks ALIVE, not disabled.
          Pre-fix the idle mic looked identical to a broken/disabled button
          (the orange permission banner above made this worse). The 3s pulse
          is slower than listening's 1.8s so the two states still differ. */}
      {isIdle && (
        <div style={{
          position: 'absolute', inset: 18,
          borderRadius: '50%',
          border: '1.5px solid var(--accent-ring)',
          animation: 'ring-pulse 3s ease-out infinite',
          opacity: 0,
        }}/>
      )}

      {/* Pulsing rings while listening (faster, full accent). */}
      {isListening && [0, 1].map(i => (
        <div key={i} style={{
          position: 'absolute', inset: 16,
          borderRadius: '50%',
          border: '2px solid var(--state-listening)',
          animation: `ring-pulse 1.8s ease-out ${i * 0.9}s infinite`,
          opacity: 0,
        }}/>
      ))}

      {/* Static cyan ring while speaking. */}
      {isSpeaking && (
        <div style={{
          position: 'absolute', inset: 18,
          borderRadius: '50%',
          border: '1.5px solid var(--state-speaking)',
        }}/>
      )}

      {/* Static red ring while interrupted (transient, ~400ms). */}
      {isInterrupted && (
        <div style={{
          position: 'absolute', inset: 18,
          borderRadius: '50%',
          border: '1.5px solid var(--state-interrupted)',
        }}/>
      )}

      {/* Inner visual surface (not the hit target — pointer-events off). */}
      <div style={{
        pointerEvents: 'none',
        position: 'relative',
        width: 88, height: 88,
        borderRadius: '50%',
        background: isListening
          ? 'radial-gradient(circle at 50% 35%, #2a3a30, #0f1612)'
          : 'var(--surface-2)',
        border: `1.5px solid ${
          isListening   ? 'var(--state-listening)'
        : isSpeaking    ? 'var(--state-speaking)'
        : isInterrupted ? 'var(--state-interrupted)'
        : isIdle        ? 'var(--accent-ring)'
                        : 'var(--border-strong)'
        }`,
        boxShadow: isListening
          ? `0 0 0 5px var(--accent-soft), 0 8px 28px -8px var(--accent-glow)`
          : isSpeaking
            ? `0 0 0 4px ${ringGlow}`
          : isInterrupted
            ? `0 0 0 4px ${ringGlow}`
          : isIdle
            ? `0 0 0 3px var(--accent-soft), 0 6px 20px -10px rgba(0,0,0,0.7)`
            : '0 6px 20px -10px rgba(0,0,0,0.7)',
        // Idle now shows accent-colored mic so the button doesn't read as
        // disabled. Pre-fix the muted-grey icon + grey surface combined with
        // the orange permission banner above signaled "this is broken".
        color: (isListening || isIdle) ? 'var(--accent)'
             : isSpeaking              ? 'var(--state-speaking)'
             : isInterrupted           ? 'var(--state-interrupted)'
             : 'var(--fg-muted)',
        display: 'grid', placeItems: 'center',
        transition: 'background 200ms, border-color 200ms, box-shadow 200ms, color 200ms',
      }}>
        {isThinking && <ThinkingDots/>}
        {isSpeaking && <WaveformBars/>}
        {isInterrupted && (
          /* X glyph for the transient interrupted state. */
          <div style={{ fontSize: 26, fontWeight: 300, color: 'var(--state-interrupted)' }}>×</div>
        )}
        {(isIdle || isListening) && (
          <div style={{ display: 'grid', placeItems: 'center', gap: 6 }}>
            <Icon.mic/>
            {isListening && <LevelMeter levels={micLevels}/>}
          </div>
        )}
      </div>
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
  const opts = ['idle', 'listening', 'thinking', 'speaking', 'interrupted'];
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
// Footer is now dev-mode-gated. Pre-fix it showed "Debug panel" link,
// "8 turns" counter, and "Reset session" to every user — confusing for
// first-time users (8 of what? I just opened it). In production view the
// footer collapses to a single muted "Reset" so a stuck user can recover.
// Dev mode (?dev=1 or #dev) restores the full debug surface.
function Footer({ onReset, turns, showForce, onToggleForce }) {
  if (!showForce) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        padding: '8px 16px 38px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg)',
        fontSize: 11.5,
      }}>
        <button
          onClick={onReset}
          aria-label="Reset session"
          style={{
            color: 'var(--fg-dim)',
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}
        >
          <Icon.reset/>
          Reset
        </button>
      </div>
    );
  }
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
        color: 'var(--warn)',
        background: 'rgba(251,191,36,0.1)',
        border: '1px solid rgba(251,191,36,0.32)',
      }}>
        <span style={{ fontSize: 11, lineHeight: 1 }}>●</span>
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

// ─────────────────────────────────────────────────────────────
// CAPABILITY CHIP — persistent "what can I ask?" affordance (F15)
// ─────────────────────────────────────────────────────────────
// Pre-fix the example prompts evaporated after the first turn and never
// came back. A returning user who forgot the tool surface had to scroll
// back through history hunting for examples, or guess. The chip lives in
// the Header gap and reveals an inline ExamplePrompts panel on tap.
// Closed by default; chevron flips when open; tap outside or the chip
// again to dismiss.
function CapabilityChip({ open, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="capability-panel"
      aria-label="Show what you can ask"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 9px',
        background: open ? 'var(--surface-3)' : 'var(--surface-1)',
        border: `1px solid ${open ? 'var(--border-strong)' : 'var(--border)'}`,
        borderRadius: 999,
        fontSize: 11, color: 'var(--fg-muted)',
        fontFamily: 'var(--f-mono)',
        cursor: 'pointer',
        transition: 'background 150ms, border-color 150ms',
      }}
    >
      <span style={{
        display: 'inline-grid', placeItems: 'center',
        width: 14, height: 14, borderRadius: '50%',
        border: '1px solid var(--fg-muted)',
        fontSize: 9, fontWeight: 700, lineHeight: 1,
      }}>?</span>
      <span>Ask</span>
      <span style={{
        fontSize: 8, color: 'var(--fg-dim)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 150ms',
      }}>▾</span>
    </button>
  );
}

// CapabilityPanel — the inline overlay that opens beneath the Header.
// Reuses ExamplePrompts so chip semantics and idle-state semantics stay
// in sync. Constrained max-h + overflow-y per global overlay rule.
function CapabilityPanel({ open, onClose, onPick }) {
  if (!open) return null;
  return (
    <div
      id="capability-panel"
      role="dialog"
      aria-label="What you can ask Jarvis"
      style={{
        position: 'relative',
        margin: '0 12px',
        marginTop: 6,
        background: 'var(--surface-1)',
        border: '1px solid var(--border-strong)',
        borderRadius: 8,
        maxHeight: 'min(60vh, calc(100vh - 8rem))',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        zIndex: 4,
        boxShadow: '0 8px 24px -10px rgba(0,0,0,0.6)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '8px 12px',
        borderBottom: '1px solid var(--hairline)',
        position: 'sticky', top: 0, background: 'var(--surface-1)',
      }}>
        <span className="mono" style={{
          fontSize: 10, letterSpacing: '0.08em',
          color: 'var(--fg-muted)', textTransform: 'uppercase',
        }}>What you can ask</span>
        <div style={{ flex: 1 }}/>
        <button
          onClick={onClose}
          aria-label="Close capabilities"
          style={{ color: 'var(--fg-muted)', padding: 4 }}
        >
          <Icon.close/>
        </button>
      </div>
      <ExamplePrompts onUse={(p) => { onPick?.(p); onClose?.(); }}/>
    </div>
  );
}

Object.assign(window, {
  Icon, STATE_META, TOOL_META,
  Header, ErrorBanner, TurnRow, ToolTile, JsonBlock, CollapseRow,
  ExamplePrompts, MicButton, ThinkingDots, WaveformBars, LevelMeter,
  ForceStateBar, Footer,
  CapabilityChip, CapabilityPanel,
  EXAMPLE_PROMPTS,
});
