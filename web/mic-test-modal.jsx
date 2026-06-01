// mic-test-modal.jsx — BUG-DIAG-2026-06-01.
//
// Two-phase diagnostic popup the user asked for after Whisper kept
// returning fabricated transcripts:
//
//   Phase A — Mic test (is the mic capturing real audio at all?):
//     Tap "Start mic test" → record 5 s through the SAME worklet path
//     production uses → "Play recording" so the user can hear EXACTLY
//     what was captured. Two outcomes:
//       - Sounds wrong / silent → mic / browser permission / OS issue.
//       - Sounds right         → Phase B.
//
//   Phase B — Whisper test (does Whisper understand the audio?):
//     Click "Send to Whisper" → POST the recorded WAV to
//     /api/transcribe-test (HTTP Whisper, same model as Realtime) →
//     show the transcript. Two outcomes:
//       - Transcript matches what was said → the Realtime path is the
//         broken one. Continue investigating the Realtime VAD /
//         streaming chunk format / etc.
//       - Transcript is wrong              → either Whisper hallucinates
//         even on clean audio (model-level) OR our PCM serialization
//         is wrong. Either way we now have a reproducible artifact.
//
// The modal opens when the user taps the mic. After they confirm both
// phases, the modal records the OK in sessionStorage and the next mic-
// tap goes straight to the real session. To force the modal back
// (e.g. to re-test after a deploy), reload with ?diag-force=1.
//
// Delete in one pass: grep BUG-DIAG-2026-06-01 across the repo and
// remove every matching file / line.

const { useCallback: useCb_DIAG, useEffect: useEffect_DIAG, useRef: useRef_DIAG, useState: useState_DIAG } = React;

const PHASE_INTRO       = 'intro';
const PHASE_RECORDING   = 'recording';
const PHASE_PLAYBACK    = 'playback';
const PHASE_TRANSCRIBE  = 'transcribing';
const PHASE_RESULT      = 'result';
const PHASE_ERROR       = 'error';

const RECORD_SECONDS = 5;
const SESSION_OK_KEY = 'jarvis.micTestPassed.v1';

function micTestSessionPassed() {
  try { return window.sessionStorage.getItem(SESSION_OK_KEY) === '1'; }
  catch (_) { return false; }
}
function setMicTestSessionPassed() {
  try { window.sessionStorage.setItem(SESSION_OK_KEY, '1'); } catch (_) { /* ignore */ }
}
function clearMicTestSessionPassed() {
  try { window.sessionStorage.removeItem(SESSION_OK_KEY); } catch (_) { /* ignore */ }
}
function micTestForcedOpen() {
  try {
    const p = new URLSearchParams(window.location.search);
    return p.get('diag-force') === '1';
  } catch (_) { return false; }
}

/**
 * MicTestModal — shown on mic-tap when the diagnostic flow hasn't been
 * confirmed yet this session. `onConfirm` is called when the user
 * passes both phases and wants to start the real session; `onDismiss`
 * is called if they back out (real session does NOT start).
 */
function MicTestModal({ clientRef, onConfirm, onDismiss }) {
  const [phase, setPhase]             = useState_DIAG(PHASE_INTRO);
  const [recordedSec, setRecordedSec] = useState_DIAG(0);
  const [transcript, setTranscript]   = useState_DIAG(null);
  const [error, setError]             = useState_DIAG(null);
  const [transcribeMeta, setTranscribeMeta] = useState_DIAG(null);
  const tickRef = useRef_DIAG(null);

  // Live elapsed-seconds tick while recording, so the user sees the
  // countdown progressing instead of staring at a frozen spinner.
  useEffect_DIAG(() => {
    if (phase !== PHASE_RECORDING) {
      if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
      return undefined;
    }
    const startMs = Date.now();
    tickRef.current = window.setInterval(() => {
      setRecordedSec(Math.min(RECORD_SECONDS, (Date.now() - startMs) / 1000));
    }, 100);
    return () => {
      if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
    };
  }, [phase]);

  const handleStartRecording = useCb_DIAG(async () => {
    const c = clientRef.current;
    if (!c) {
      setError('Jarvis client not initialised yet — wait a moment and try again.');
      setPhase(PHASE_ERROR);
      return;
    }
    setError(null);
    setTranscript(null);
    setTranscribeMeta(null);
    setRecordedSec(0);
    setPhase(PHASE_RECORDING);
    try {
      await c.startMicTestRecording(RECORD_SECONDS);
      setPhase(PHASE_PLAYBACK);
    } catch (cause) {
      setError((cause && cause.message) || String(cause));
      setPhase(PHASE_ERROR);
    }
  }, [clientRef]);

  const handlePlay = useCb_DIAG(async () => {
    const c = clientRef.current;
    if (!c) return;
    try { await c.playCapture(); }
    catch (cause) {
      setError(`Playback failed: ${(cause && cause.message) || String(cause)}`);
      setPhase(PHASE_ERROR);
    }
  }, [clientRef]);

  const handleDownload = useCb_DIAG(() => {
    const c = clientRef.current;
    if (!c) return;
    try { c.downloadCaptureWav(); }
    catch (cause) {
      setError(`Download failed: ${(cause && cause.message) || String(cause)}`);
      setPhase(PHASE_ERROR);
    }
  }, [clientRef]);

  const handleTranscribe = useCb_DIAG(async () => {
    const c = clientRef.current;
    if (!c) return;
    setPhase(PHASE_TRANSCRIBE);
    try {
      const result = await c.testTranscribeViaHttp();
      setTranscribeMeta(result);
      if (result.ok && result.body && typeof result.body.text === 'string') {
        setTranscript(result.body.text);
        setPhase(PHASE_RESULT);
      } else {
        const errMsg = result.body?.error?.message || `HTTP ${result.status}`;
        setError(`Whisper test failed: ${errMsg}`);
        setPhase(PHASE_ERROR);
      }
    } catch (cause) {
      setError(`Transcription request failed: ${(cause && cause.message) || String(cause)}`);
      setPhase(PHASE_ERROR);
    }
  }, [clientRef]);

  const handleConfirmAndStart = useCb_DIAG(() => {
    setMicTestSessionPassed();
    onConfirm();
  }, [onConfirm]);

  const handleRetry = useCb_DIAG(() => {
    setError(null);
    setTranscript(null);
    setTranscribeMeta(null);
    setRecordedSec(0);
    setPhase(PHASE_INTRO);
  }, []);

  // ─── styling — uses the existing theme CSS vars from the design ──
  const overlay = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(8, 11, 18, 0.78)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  };
  const panel = {
    width: '100%', maxWidth: 480,
    maxHeight: 'min(90vh, calc(100vh - 3rem))',
    overflowY: 'auto', overscrollBehavior: 'contain',
    background: 'var(--surface-1)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
    color: 'var(--fg)',
  };
  const header = {
    position: 'sticky', top: 0,
    padding: '12px 16px',
    background: 'var(--surface-1)',
    borderBottom: '1px solid var(--border)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    zIndex: 1,
  };
  const headerTitle = { fontSize: 13, fontWeight: 600, letterSpacing: '0.02em' };
  const headerKbd = { fontSize: 10, color: 'var(--fg-faint)', fontFamily: 'var(--f-mono)' };
  const body = { padding: 16, fontSize: 13, lineHeight: 1.5 };
  const subdued = { color: 'var(--fg-muted)', fontSize: 11.5, marginTop: 4 };
  const ctaRow = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 };
  const btnPrimary = {
    padding: '8px 14px', fontSize: 13, fontWeight: 600,
    background: 'var(--accent)', color: '#0a0e1a',
    border: 'none', borderRadius: 8, cursor: 'pointer',
  };
  const btnSecondary = {
    padding: '8px 14px', fontSize: 13,
    background: 'var(--surface-2)', color: 'var(--fg)',
    border: '1px solid var(--border-strong)', borderRadius: 8, cursor: 'pointer',
  };
  const btnLink = {
    padding: '6px 10px', fontSize: 12,
    background: 'transparent', color: 'var(--fg-muted)',
    border: 'none', cursor: 'pointer', textDecoration: 'underline',
  };
  const transcriptBox = {
    marginTop: 10, padding: 10,
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
    fontFamily: 'var(--f-mono)', fontSize: 12.5, color: 'var(--fg)',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  };
  const meterTrack = {
    marginTop: 12, height: 8, width: '100%',
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
  };
  const meterFill = {
    height: '100%',
    width: `${Math.max(0, Math.min(100, (recordedSec / RECORD_SECONDS) * 100))}%`,
    background: 'var(--accent)',
    transition: 'width 100ms linear',
  };

  return (
    <div role="dialog" aria-label="Microphone diagnostic" style={overlay}>
      <div style={panel}>
        <div style={header}>
          <span style={headerTitle}>Microphone diagnostic ({phase})</span>
          <button type="button" style={btnLink} onClick={onDismiss} aria-label="Close">close</button>
        </div>
        <div style={body}>

          {phase === PHASE_INTRO && (
            <>
              <div>
                Two-step check before we start a real Jarvis session.
                Step 1 records {RECORD_SECONDS} seconds through your mic
                and lets you play it back so you can hear EXACTLY what
                Jarvis would hear. Step 2 sends the same recording to
                OpenAI's HTTP Whisper endpoint so you can see what
                Whisper transcribes from it — independent of the live
                Realtime pipeline.
              </div>
              <div style={subdued}>
                This isolates "is my mic broken?" from "is Whisper
                misunderstanding me?" — each gets a separate, replayable
                answer. The check is debug-only and will be removed once
                the audio pipeline is verified.
              </div>
              <div style={ctaRow}>
                <button type="button" style={btnPrimary} onClick={handleStartRecording}>
                  Start mic test ({RECORD_SECONDS} s)
                </button>
                <button type="button" style={btnSecondary} onClick={() => { setMicTestSessionPassed(); onConfirm(); }}>
                  Skip and start session
                </button>
              </div>
            </>
          )}

          {phase === PHASE_RECORDING && (
            <>
              <div><strong>Recording…</strong> speak now. Try something
                you would actually say to Jarvis, like "Hey, how are
                you?" or "What is the weather in Austin?"</div>
              <div style={subdued}>
                {recordedSec.toFixed(1)} / {RECORD_SECONDS}.0 s captured
              </div>
              <div style={meterTrack}><div style={meterFill}/></div>
            </>
          )}

          {phase === PHASE_PLAYBACK && (
            <>
              <div><strong>Step 1 done — captured {RECORD_SECONDS} seconds.</strong></div>
              <div style={subdued}>
                Tap "Play recording" and listen. If it sounds like you,
                the mic and our PCM encoding are fine — continue to
                Step 2. If it sounds silent / muffled / garbled, the
                problem is in the mic capture path (browser permission,
                another app holding the mic, OS audio settings) and
                Whisper would not be able to transcribe it either.
              </div>
              <div style={ctaRow}>
                <button type="button" style={btnPrimary} onClick={handlePlay}>▶ Play recording</button>
                <button type="button" style={btnSecondary} onClick={handleTranscribe}>
                  Step 2 → Send to Whisper
                </button>
                <button type="button" style={btnSecondary} onClick={handleDownload}>⬇ Save WAV</button>
                <button type="button" style={btnLink} onClick={handleStartRecording}>Re-record</button>
              </div>
            </>
          )}

          {phase === PHASE_TRANSCRIBE && (
            <>
              <div><strong>Sending recording to HTTP Whisper…</strong></div>
              <div style={subdued}>
                POSTing the WAV to /api/transcribe-test. The server
                forwards it to OpenAI's whisper-1 endpoint, which is
                the same Whisper revision the Realtime session uses.
              </div>
            </>
          )}

          {phase === PHASE_RESULT && (
            <>
              <div><strong>Step 2 done — gpt-4o-transcribe transcript:</strong></div>
              <div style={transcriptBox}>
                {transcript && transcript.length > 0
                  ? transcript
                  : '(empty — the model returned no text. Audio may have been too short, silent, or the anti-filler prompt correctly suppressed a hallucination.)'}
              </div>
              {transcribeMeta && (
                <div style={subdued}>
                  Sent {transcribeMeta.bytesSent.toLocaleString()} bytes
                  · {transcribeMeta.durationSec.toFixed(1)} s
                  @ {transcribeMeta.sampleRate} Hz
                  · HTTP {transcribeMeta.status}
                  · model gpt-4o-transcribe (file mode, higher accuracy)
                </div>
              )}
              <div style={subdued}>
                <strong>Interpretation:</strong>
                {' '}If this transcript matches what you said, the mic
                capture path is fine. The live session uses a
                different model (gpt-realtime-whisper, streaming-
                optimized) — any difference between the two transcripts
                points at the streaming path or VAD config. If both
                transcripts are wrong, either the audio itself is
                garbled OR our PCM encoding is subtly off.
              </div>
              <div style={ctaRow}>
                <button type="button" style={btnPrimary} onClick={handleConfirmAndStart}>
                  Looks right — start real session
                </button>
                <button type="button" style={btnSecondary} onClick={handlePlay}>▶ Play again</button>
                <button type="button" style={btnSecondary} onClick={handleDownload}>⬇ Save WAV</button>
                <button type="button" style={btnLink} onClick={handleRetry}>Run another test</button>
              </div>
            </>
          )}

          {phase === PHASE_ERROR && (
            <>
              <div style={{ color: 'var(--err)' }}><strong>Error</strong></div>
              <div style={transcriptBox}>{error || 'unknown error'}</div>
              <div style={ctaRow}>
                <button type="button" style={btnPrimary} onClick={handleRetry}>Retry</button>
                <button type="button" style={btnSecondary} onClick={onDismiss}>Cancel</button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}

// Expose under window globals so main.jsx can pick them up without an
// import (Babel-standalone has no ES module resolution; the design's
// JSX files all rely on the same window-globals contract).
window.JarvisMicTestModal           = MicTestModal;
window.jarvisMicTestSessionPassed   = micTestSessionPassed;
window.jarvisClearMicTestSessionPassed = clearMicTestSessionPassed;
window.jarvisMicTestForcedOpen      = micTestForcedOpen;
