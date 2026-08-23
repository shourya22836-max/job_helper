import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchRoles, getInterviewFeedback, startInterview } from '../lib/api.js'
import { useHistory } from '../context/HistoryContext.jsx'

// Lazy-load livekit-client so the page still works if the package isn't
// installed (e.g., a fresh checkout that hasn't run npm install yet).
async function loadLiveKit() {
  try {
    const mod = await import('livekit-client')
    return mod
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const INTERVIEW_TYPES = [
  {
    id: 'hr',
    name: 'HR',
    icon: '🤝',
    desc: 'Motivation, teamwork, communication, culture fit.',
  },
  {
    id: 'technical',
    name: 'Technical',
    icon: '⚙️',
    desc: 'Skills, projects, problem-solving, trade-offs.',
  },
  {
    id: 'behavioral',
    name: 'Behavioral',
    icon: '🧠',
    desc: 'STAR-format questions about past experience.',
  },
]

const PHASES = ['setup', 'preflight', 'live', 'feedback']

const QUESTION_COUNT_OPTIONS = [4, 6, 8, 10]

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function formatTs(t) {
  if (!t) return ''
  const d = new Date(t * 1000)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function verdictLabel(v) {
  if (v === 'strong') return 'Strong'
  if (v === 'needs_work') return 'Needs work'
  return 'OK'
}

/* -------------------------------------------------------------------------- */
/* Setup phase                                                                 */
/* -------------------------------------------------------------------------- */

function SetupPhase({ roles, loadingRoles, roleId, setRoleId, interviewType, setInterviewType,
                     questionCount, setQuestionCount, hasResume, error }) {
  return (
    <>
      <header className="page-header">
        <h1>🎤 AI Mock Interview</h1>
        <p className="muted">
          Practice a live interview with an AI interviewer. Pick a role, choose the type, and the AI
          will ask questions tailored to your resume and the target role. You'll get real-time
          captions and a detailed scorecard at the end.
        </p>
      </header>

      {!hasResume && (
        <div className="card warning">
          <p style={{ margin: 0 }}>
            No resume loaded — questions will be generic for the role.{' '}
            <Link to="/analyze">Analyze a resume first</Link> for personalized questions.
          </p>
        </div>
      )}

      <div className="interview-setup-grid">
        <div className="card form">
          <h3 style={{ marginTop: 0 }}>1. Pick a target role</h3>
          {loadingRoles ? (
            <p className="muted">Loading roles…</p>
          ) : roles.length === 0 ? (
            <p className="form-error">Could not load roles. Make sure the backend is running.</p>
          ) : (
            <div className="form-row">
              <label className="form-label">Role</label>
              <select className="select" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.level})
                  </option>
                ))}
              </select>
              {roleId && (() => {
                const r = roles.find((x) => x.id === roleId)
                return r ? <p className="muted small" style={{ margin: 0 }}>{r.description}</p> : null
              })()}
            </div>
          )}
        </div>

        <div className="card form">
          <h3 style={{ marginTop: 0 }}>2. Choose interview type</h3>
          <div className="interview-type-grid">
            {INTERVIEW_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`type-card ${interviewType === t.id ? 'active' : ''}`}
                onClick={() => setInterviewType(t.id)}
              >
                <span className="type-icon">{t.icon}</span>
                <span className="type-name">{t.name}</span>
                <span className="type-desc">{t.desc}</span>
              </button>
            ))}
          </div>

          <div className="form-row" style={{ marginTop: 8 }}>
            <label className="form-label">Number of questions</label>
            <div className="chip-grid">
              {QUESTION_COUNT_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${questionCount === n ? 'chip-active' : ''}`}
                  onClick={() => setQuestionCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Pre-flight: device check                                                    */
/* -------------------------------------------------------------------------- */

function PreflightPhase({ role, interviewType, questionCount, hasResume, onStart, error, busy }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(null)

  const [camOn, setCamOn] = useState(true)
  const [micOn, setMicOn] = useState(true)
  const [permError, setPermError] = useState(null)
  const [level, setLevel] = useState(0)
  const [devices, setDevices] = useState({ audioIn: [], videoIn: [] })
  const [audioInId, setAudioInId] = useState('')
  const [videoInId, setVideoInId] = useState('')

  // Acquire media stream.
  useEffect(() => {
    let cancelled = false
    async function acquire() {
      try {
        const constraints = {
          audio: audioInId ? { deviceId: { exact: audioInId } } : true,
          video: videoInId ? { deviceId: { exact: videoInId } } : true,
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setPermError(null)

        // Setup mic meter.
        const AC = window.AudioContext || window.webkitAudioContext
        if (AC) {
          const ctx = new AC()
          audioCtxRef.current = ctx
          const src = ctx.createMediaStreamSource(stream)
          const an = ctx.createAnalyser()
          an.fftSize = 512
          src.connect(an)
          analyserRef.current = an
          const buf = new Uint8Array(an.frequencyBinCount)
          const tick = () => {
            if (!analyserRef.current) return
            analyserRef.current.getByteTimeDomainData(buf)
            let sum = 0
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128
              sum += v * v
            }
            const rms = Math.sqrt(sum / buf.length)
            setLevel(Math.min(1, rms * 4))
            rafRef.current = requestAnimationFrame(tick)
          }
          tick()
        }

        // Enumerate devices (after permission grant).
        try {
          const list = await navigator.mediaDevices.enumerateDevices()
          if (!cancelled) {
            setDevices({
              audioIn: list.filter((d) => d.kind === 'audioinput'),
              videoIn: list.filter((d) => d.kind === 'videoinput'),
            })
          }
        } catch { /* ignore */ }
      } catch (e) {
        if (!cancelled) setPermError(e.message || 'Could not access camera/microphone.')
      }
    }
    acquire()
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {})
      }
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioInId, videoInId])

  // Track enable state.
  useEffect(() => {
    const s = streamRef.current
    if (!s) return
    s.getAudioTracks().forEach((t) => (t.enabled = micOn))
    s.getVideoTracks().forEach((t) => (t.enabled = camOn))
  }, [micOn, camOn])

  return (
    <>
      <header className="page-header">
        <h1>🎤 Pre-flight check</h1>
        <p className="muted">
          Confirm your camera and microphone work before the interview starts.
        </p>
      </header>

      <div className="interview-config-summary">
        <span className="pill pill-success">{role?.name}</span>
        <span className="pill">{interviewType.toUpperCase()}</span>
        <span className="pill">{questionCount} questions</span>
        {hasResume && <span className="pill pill-success">Resume loaded</span>}
      </div>

      {permError && <div className="form-error">{permError}</div>}

      <div className="preflight">
        <div className="preview-tile">
          {camOn ? (
            <video ref={videoRef} autoPlay playsInline muted />
          ) : (
            <div className="preview-placeholder">
              <div className="big-emoji">📷</div>
              <span>Camera off</span>
            </div>
          )}
          <span className="preview-label">You</span>
        </div>

        <div className="device-tile">
          <div className="device-row">
            <div>
              <div className="device-name">Camera</div>
              <div className={`device-status ${camOn ? 'on' : 'off'}`}>{camOn ? 'On' : 'Off'}</div>
            </div>
            <button
              type="button"
              className={`toggle-switch ${camOn ? 'on' : ''}`}
              aria-label="Toggle camera"
              onClick={() => setCamOn((v) => !v)}
              disabled={!streamRef.current}
            />
          </div>

          <div className="device-row">
            <div>
              <div className="device-name">Microphone</div>
              <div className={`device-status ${micOn ? 'on' : 'off'}`}>{micOn ? 'On' : 'Off'}</div>
            </div>
            <button
              type="button"
              className={`toggle-switch ${micOn ? 'on' : ''}`}
              aria-label="Toggle microphone"
              onClick={() => setMicOn((v) => !v)}
              disabled={!streamRef.current}
            />
          </div>

          <div className="mic-meter"><div style={{ width: `${Math.round(level * 100)}%` }} /></div>
          <p className="muted small" style={{ margin: 0 }}>
            Speak normally — the green bar shows your input level.
          </p>

          {devices.audioIn.length > 1 && (
            <div className="form-row">
              <label className="form-label">Microphone</label>
              <select className="select" value={audioInId} onChange={(e) => setAudioInId(e.target.value)}>
                <option value="">Default</option>
                {devices.audioIn.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 6)}`}</option>
                ))}
              </select>
            </div>
          )}

          {devices.videoIn.length > 1 && (
            <div className="form-row">
              <label className="form-label">Camera</label>
              <select className="select" value={videoInId} onChange={(e) => setVideoInId(e.target.value)}>
                <option value="">Default</option>
                {devices.videoIn.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 6)}`}</option>
                ))}
              </select>
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onStart({ stream: streamRef.current, camOn, micOn })}
            disabled={busy || !streamRef.current}
          >
            {busy ? 'Starting…' : 'Start interview →'}
          </button>
        </div>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Live phase                                                                  */
/* -------------------------------------------------------------------------- */

function LivePhase({
  startData,
  onComplete,
  onAbort,
}) {
  const videoRef = useRef(null)
  const wsRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const processorRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const micOnRef = useRef(true)

  const [phase, setPhase] = useState('live')
  const [transcript, setTranscript] = useState([]) // {role, text, final, ts}
  const [currentQuestion, setCurrentQuestion] = useState(startData.first_question)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [totalQuestions, setTotalQuestions] = useState(startData.question_count)
  const [aiSpeaking, setAiSpeaking] = useState(false)
  const [aiThinking, setAiThinking] = useState(false)
  const [paused, setPaused] = useState(false)
  const [camOn, setCamOn] = useState(true)
  const [micOn, setMicOn] = useState(true)
  const [error, setError] = useState(null)
  const [textDraft, setTextDraft] = useState('')
  const completedRef = useRef(false)

  const roomName = startData.room_name
  const roleName = startData.role?.name || 'Interviewer'

  /* --- attach local camera preview + (best-effort) LiveKit presence --- */
  useEffect(() => {
    let cancelled = false
    let room = null
    let localStream = null
    let lkCleanup = () => {}

    async function setup() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        if (cancelled) {
          localStream.getTracks().forEach((t) => t.stop())
          return
        }
        mediaStreamRef.current = localStream
        if (videoRef.current) videoRef.current.srcObject = localStream
      } catch { /* ignore — fallback is no preview */ }

      // Best-effort LiveKit connection (no-op if env is missing or SDK absent).
      const lk = await loadLiveKit()
      if (!lk) return
      if (!startData.livekit_url || !startData.token) return
      try {
        room = new lk.Room({
          adaptiveStream: true,
          dynacast: true,
          publishDefaults: { simulcast: false },
        })
        await room.connect(startData.livekit_url, startData.token)
        if (cancelled) { room.disconnect(); return }
        if (localStream) {
          await room.localParticipant.setCameraEnabled(true)
        }
        lkCleanup = () => {
          try { room.disconnect() } catch { /* ignore */ }
        }
      } catch (e) {
        // Non-fatal — LiveKit is optional for the audio round-trip.
        console.warn('LiveKit connection failed; continuing without presence:', e)
      }
    }

    setup()
    return () => {
      cancelled = true
      lkCleanup()
      if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const s = mediaStreamRef.current
    if (!s) return
    s.getVideoTracks().forEach((t) => (t.enabled = camOn))
  }, [camOn])

  /* --- connect to backend WebSocket and stream audio --- */
  useEffect(() => {
    let cancelled = false
    let ws

    async function connect() {
      try {
        // Acquire a stream that we keep open for the whole interview.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000, channelCount: 1 },
          video: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        mediaStreamRef.current = stream

        // Build ws URL — same host:port as the page.
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${proto}//${window.location.host}/api/interview/ws/${startData.interview_id}`

        ws = new WebSocket(wsUrl)
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'config',
            role_id: startData.role.id,
            interview_type: startData.interview_type,
            question_count: startData.question_count,
            resume_text: null, // Backend already got it via /token; send null to skip.
          }))
          // Set up audio pipeline.
          try {
            const Ctor = /** @type {any} */ (window).AudioContext
              || /** @type {any} */ (window).webkitAudioContext
            const ctx = new Ctor({ sampleRate: 16000 })
            audioCtxRef.current = ctx
            const src = ctx.createMediaStreamSource(stream)
            sourceNodeRef.current = src
            // ScriptProcessor is deprecated but the most universally supported
            // path for live PCM capture across browsers (AudioWorklet would need
            // a separate worker file). This is the audio capture path for STT.
            const proc = /** @type {any} */ (ctx).createScriptProcessor(4096, 1, 1)
            processorRef.current = proc
            /** @type {any} */ (proc).onaudioprocess = (e) => {
              if (!micOnRef.current) return
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                const input = /** @type {any} */ (e).inputBuffer.getChannelData(0)
                // Convert Float32 → Int16 PCM
                const pcm = new Int16Array(input.length)
                for (let i = 0; i < input.length; i++) {
                  let s = Math.max(-1, Math.min(1, input[i]))
                  pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
                }
                wsRef.current.send(pcm.buffer)
              }
            }
            src.connect(proc)
            // Connect processor to a muted gain so it actually fires.
            const mute = ctx.createGain()
            mute.gain.value = 0
            proc.connect(mute)
            mute.connect(ctx.destination)
          } catch (e) {
            console.warn('Audio pipeline setup failed', e)
          }
        }

        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return
          let msg
          try { msg = JSON.parse(ev.data) } catch { return }
          handleWsMessage(msg)
        }

        ws.onerror = () => setError('Realtime connection error. Check the backend logs.')
        ws.onclose = () => {
          // If we closed unexpectedly, do nothing special — the cleanup
          // runs and the user sees the spinner/feedback screen.
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to start audio stream.')
      }
    }

    connect()

    return () => {
      cancelled = true
      try { if (ws) ws.close() } catch { /* ignore */ }
      try { if (processorRef.current) processorRef.current.disconnect() } catch { /* ignore */ }
      try { if (sourceNodeRef.current) sourceNodeRef.current.disconnect() } catch { /* ignore */ }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep mic state in sync — separate effect so it doesn't tear down the WS.
  useEffect(() => {
    micOnRef.current = micOn
  }, [micOn])

  /* --- handle incoming WS messages --- */
  const handleWsMessage = useCallback((msg) => {
    const t = msg.type
    if (t === 'question') {
      setCurrentQuestion(msg.text)
      setQuestionIndex(msg.index ?? 0)
      if (typeof msg.total === 'number') setTotalQuestions(msg.total)
      setAiSpeaking(false)
      setAiThinking(false)
      setTranscript((prev) => [...prev, { role: 'assistant', text: msg.text, final: true, ts: msg.timestamp || Date.now() / 1000 }])
    } else if (t === 'caption') {
      const role = msg.role === 'user' ? 'user' : 'assistant'
      const text = msg.text
      const isFinal = !!msg.final
      setTranscript((prev) => {
        if (!isFinal && prev.length && prev[prev.length - 1].role === role && !prev[prev.length - 1].final) {
          const next = prev.slice()
          next[next.length - 1] = { ...next[next.length - 1], text }
          return next
        }
        return [...prev, { role, text, final: isFinal, ts: Date.now() / 1000 }]
      })
      if (role === 'assistant' && isFinal) {
        setAiSpeaking(true)
      }
    } else if (t === 'ai_thinking') {
      setAiThinking(true)
      setAiSpeaking(false)
    } else if (t === 'ai_done') {
      setAiThinking(false)
      setAiSpeaking(false)
    } else if (t === 'ai_timeout') {
      setAiThinking(false)
    } else if (t === 'paused') {
      setPaused(true)
    } else if (t === 'resumed') {
      setPaused(false)
    } else if (t === 'complete') {
      completedRef.current = true
      finishInterview()
    } else if (t === 'error') {
      setError(msg.message || 'Realtime error.')
    }
  }, [])

  /* --- finish: collect transcript, call feedback endpoint --- */
  const finishInterview = useCallback(async () => {
    setPhase('finalizing')
    try {
      // Close the WS.
      try { wsRef.current?.close() } catch { /* ignore */ }
      const turns = transcript
        .filter((t) => t.final)
        .map((t) => ({ role: t.role, text: t.text, timestamp: t.ts }))
      const feedback = await getInterviewFeedback({
        interviewId: startData.interview_id,
        role: startData.role,
        interviewType: startData.interview_type,
        turns,
      })
      onComplete(feedback, turns)
    } catch (e) {
      setError(e.message || 'Could not generate feedback.')
      setPhase('live')
    }
  }, [transcript, startData, onComplete])

  /* --- controls --- */
  const sendCtrl = (obj) => {
    try {
      wsRef.current?.send(JSON.stringify(obj))
    } catch { /* ignore */ }
  }

  const onPauseToggle = () => {
    if (paused) sendCtrl({ type: 'resume' })
    else sendCtrl({ type: 'pause' })
  }

  const onEnd = () => {
    if (completedRef.current) return
    sendCtrl({ type: 'end' })
    // Force-complete in case server didn't get to send 'complete'.
    setTimeout(() => {
      if (!completedRef.current) {
        completedRef.current = true
        finishInterview()
      }
    }, 600)
  }

  const onSkip = () => {
    sendCtrl({ type: 'skip' })
  }

  const onSendText = () => {
    const text = textDraft.trim()
    if (!text) return
    setTextDraft('')
    sendCtrl({ type: 'text', text })
  }

  const onCamToggle = () => setCamOn((v) => !v)
  const onMicToggle = () => setMicOn((v) => !v)

  const progressPct = totalQuestions > 0
    ? Math.round(((Math.min(questionIndex + 1, totalQuestions)) / totalQuestions) * 100)
    : 0

  if (phase === 'finalizing') {
    return (
      <div className="card status-card">
        <div className="spinner" />
        <p>Generating your feedback report…</p>
      </div>
    )
  }

  return (
    <>
      <div className="interview-config-summary">
        <span className="pill pill-success">{startData.role.name}</span>
        <span className="pill">{startData.interview_type.toUpperCase()}</span>
        <span className="pill">Room: {roomName}</span>
        {paused && <span className="pill pill-warning">Paused</span>}
      </div>

      <div className="interview-stage">
        {/* --- Call tiles: AI avatar + user PiP --- */}
        <div className="call-tiles">
          <div className="avatar-tile">
            <div className="ai-status">
              <span className="dot-live" />
              {aiThinking ? 'AI thinking…' : aiSpeaking ? 'AI speaking' : 'Live'}
            </div>
            <div className="avatar-figure">
              <div className={`avatar-circle ${aiSpeaking && !aiThinking ? 'speaking' : ''}`}>
                🤖
              </div>
              <div className="avatar-name">{roleName} · Interviewer</div>
              <div className="avatar-role">{INTERVIEW_TYPES.find((t) => t.id === startData.interview_type)?.name} round</div>
            </div>
          </div>

          <div className={`user-pip ${camOn ? '' : 'muted-cam'}`}>
            {camOn ? (
              <video ref={videoRef} autoPlay playsInline muted />
            ) : (
              <div className="preview-placeholder">
                <div className="big-emoji" style={{ fontSize: '1.6rem' }}>📷</div>
                <span>Camera off</span>
              </div>
            )}
            <span className="pip-label">You</span>
          </div>

          <div className="controls-bar" role="toolbar" aria-label="Interview controls">
            <button
              type="button"
              className={`ctrl-btn ${micOn ? '' : 'off'}`}
              title={micOn ? 'Mute mic' : 'Unmute mic'}
              aria-label={micOn ? 'Mute mic' : 'Unmute mic'}
              onClick={onMicToggle}
            >{micOn ? '🎙️' : '🔇'}</button>
            <button
              type="button"
              className={`ctrl-btn ${camOn ? '' : 'off'}`}
              title={camOn ? 'Turn camera off' : 'Turn camera on'}
              aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
              onClick={onCamToggle}
            >{camOn ? '📹' : '🎬'}</button>
            <button
              type="button"
              className="ctrl-btn"
              title={paused ? 'Resume' : 'Pause'}
              aria-label={paused ? 'Resume' : 'Pause'}
              onClick={onPauseToggle}
            >{paused ? '▶️' : '⏸️'}</button>
            <button
              type="button"
              className="ctrl-btn"
              title="Skip question"
              aria-label="Skip question"
              onClick={onSkip}
            >⏭️</button>
            <button
              type="button"
              className="ctrl-btn danger"
              title="End interview"
              aria-label="End interview"
              onClick={onEnd}
            >⏹️</button>
          </div>
        </div>

        {/* --- Side: progress + question + transcript --- */}
        <div className="interview-side">
          <div className="progress-row">
            <span className="progress-text">
              Question {Math.min(questionIndex + 1, totalQuestions)} of {totalQuestions}
            </span>
            <div className="progress-bar"><div className="progress-bar-fill" style={{ width: `${progressPct}%` }} /></div>
          </div>

          <div className="card question-card">
            <div className="q-label">Current question</div>
            <p className="q-text">{currentQuestion}</p>
          </div>

          <div className="card transcript-card">
            <div className="t-header">
              <h3>Live transcript</h3>
              <span className="muted small">{transcript.length} line{transcript.length === 1 ? '' : 's'}</span>
            </div>
            <div className="transcript-list">
              {transcript.length === 0 && (
                <p className="muted small">Speak or type to see captions here.</p>
              )}
              {transcript.map((line, i) => (
                <div key={i} className={`transcript-line ${line.role} ${line.final ? '' : 'interim'}`}>
                  <span className="t-role">{line.role === 'user' ? 'You' : 'AI'}</span>
                  <span className="t-text">{line.text}</span>
                </div>
              ))}
              {aiThinking && (
                <div className="transcript-line assistant interim">
                  <span className="t-role">AI</span>
                  <span className="t-text">
                    <span className="typing"><span /><span /><span /></span>
                  </span>
                </div>
              )}
            </div>

            <div className="text-fallback">
              <p className="muted">Voice not working? Type your answer instead.</p>
              <div className="chat-input-row">
                <input
                  className="chat-input"
                  placeholder="Type your answer…"
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onSendText() }}
                  disabled={paused || phase !== 'live'}
                />
                <button type="button" className="btn btn-primary" onClick={onSendText} disabled={!textDraft.trim()}>
                  Send
                </button>
              </div>
            </div>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="btn-row">
            <button type="button" className="btn btn-danger" onClick={onEnd}>End interview</button>
            <button type="button" className="btn" onClick={onAbort}>Cancel</button>
          </div>
        </div>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Feedback phase                                                              */
/* -------------------------------------------------------------------------- */

function FeedbackPhase({ feedback, turns, role, interviewType, onRetry }) {
  if (!feedback) return null
  const { score, strengths, areas_for_improvement, questions_answered_well,
    questions_needing_improvement, narrative_summary } = feedback

  const wellCount = questions_answered_well.length
  const needsCount = questions_needing_improvement.length
  const answeredCount = wellCount + needsCount

  const scorePct = Math.max(0, Math.min(100, score.overall || 0))
  const cssVarStyle = { '--p': `${(scorePct / 100) * 360}deg` }

  return (
    <>
      <header className="page-header">
        <h1>🎤 Interview feedback</h1>
        <p className="muted">
          {role.name} · {interviewType.toUpperCase()} · {answeredCount} question{answeredCount === 1 ? '' : 's'} answered
        </p>
      </header>

      <div className="feedback-summary">
        <div className="card score-block-main">
          <h3 style={{ margin: 0 }}>Overall score</h3>
          <div className="score-circle" style={cssVarStyle}>
            <div className="score-circle-text">
              <span className="score-num">{score.overall}</span>
              <span className="score-of">out of 100</span>
            </div>
          </div>

          <div className="sub-scores">
            <SubScore label="Communication" value={score.communication} />
            <SubScore label="Technical" value={score.technical_knowledge} />
            <SubScore label="Confidence" value={score.confidence} />
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          {narrative_summary ? (
            <p className="narrative">{narrative_summary}</p>
          ) : (
            <p className="muted">No summary available.</p>
          )}

          <h4 style={{ marginTop: 14, marginBottom: 6 }}>💪 Strengths</h4>
          {strengths.length === 0 ? (
            <p className="muted small">No strengths highlighted.</p>
          ) : (
            <ul className="strengths-list">
              {strengths.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}

          <h4 style={{ marginTop: 14, marginBottom: 6 }}>🎯 Areas to improve</h4>
          {areas_for_improvement.length === 0 ? (
            <p className="muted small">No specific areas flagged.</p>
          ) : (
            <ul className="improvements-list">
              {areas_for_improvement.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
        </div>
      </div>

      {questions_answered_well.length > 0 && (
        <section className="card">
          <h3>✅ Questions answered well ({wellCount})</h3>
          <div className="feedback-grid">
            {questions_answered_well.map((qa, i) => <QACard key={`w-${i}`} qa={qa} />)}
          </div>
        </section>
      )}

      {questions_needing_improvement.length > 0 && (
        <section className="card">
          <h3>📝 Questions to improve ({needsCount})</h3>
          <div className="feedback-grid">
            {questions_needing_improvement.map((qa, i) => <QACard key={`n-${i}`} qa={qa} />)}
          </div>
        </section>
      )}

      {turns.length > 0 && (
        <section className="card">
          <h3>📜 Full transcript</h3>
          <div className="transcript-list" style={{ maxHeight: 360 }}>
            {turns.map((t, i) => (
              <div key={i} className={`transcript-line ${t.role}`}>
                <span className="t-role">{t.role === 'user' ? 'You' : 'AI'}</span>
                <span className="t-text">{t.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onRetry}>Practice again</button>
        <Link to="/" className="btn">Back to dashboard</Link>
      </div>
    </>
  )
}

function SubScore({ label, value }) {
  const v = Math.max(0, Math.min(100, value || 0))
  return (
    <div className="sub-score">
      <div className="ss-label">{label}</div>
      <div className="ss-num">{v}</div>
      <div className="ss-bar"><div style={{ width: `${v}%` }} /></div>
    </div>
  )
}

function QACard({ qa }) {
  const v = qa.verdict || 'ok'
  const score = Math.max(0, Math.min(100, qa.score || 0))
  return (
    <div className="qa-item">
      <div className="qa-item-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className={`qa-verdict ${v}`}>{verdictLabel(v)}</span>
        <span className="muted small">{score}/100</span>
      </div>
      <div className="qa-q">{qa.question}</div>
      {qa.answer_snippet && (
        <div className="qa-a">"{qa.answer_snippet}"</div>
      )}
      <div className="qa-score"><div><div style={{ width: `${score}%` }} /></div></div>
      {qa.comment && <div className="qa-comment"><strong>Coach:</strong> {qa.comment}</div>}
      {qa.suggested_answer && (
        <div className="qa-suggested">
          <strong>Try instead:</strong> {qa.suggested_answer}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Main page                                                                   */
/* -------------------------------------------------------------------------- */

export default function Interview() {
  const { current } = useHistory()
  const hasResume = !!current?.resumeText

  const [phase, setPhase] = useState('setup')
  const [roles, setRoles] = useState([])
  const [loadingRoles, setLoadingRoles] = useState(true)
  const [roleId, setRoleId] = useState('')
  const [interviewType, setInterviewType] = useState('technical')
  const [questionCount, setQuestionCount] = useState(6)
  const [startData, setStartData] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [turns, setTurns] = useState([])
  const [error, setError] = useState(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchRoles()
      .then((d) => {
        if (cancelled) return
        const list = d.roles || []
        setRoles(list)
        if (list[0]) setRoleId(list[0].id)
      })
      .catch((e) => setError(e.message))
      .finally(() => { if (!cancelled) setLoadingRoles(false) })
    return () => { cancelled = true }
  }, [])

  const handleStart = async () => {
    setError(null)
    setStarting(true)
    try {
      const data = await startInterview({
        roleId,
        interviewType,
        questionCount,
        resumeText: current?.resumeText || null,
      })
      setStartData(data)
      setPhase('preflight')
    } catch (e) {
      setError(e.message || 'Could not start interview.')
    } finally {
      setStarting(false)
    }
  }

  const handlePreflightStart = async ({ stream, camOn, micOn }) => {
    // Keep the stream around so the Live phase can reuse it.
    if (stream) {
      // Stash on the startData so the Live phase picks it up.
      setStartData((prev) => ({ ...prev, _stream: stream, _camOn: camOn, _micOn: micOn }))
    }
    setPhase('live')
  }

  const handleComplete = (fb, ts) => {
    setFeedback(fb)
    setTurns(ts)
    setPhase('feedback')
  }

  const handleAbort = () => {
    setStartData(null)
    setPhase('setup')
  }

  const handleRetry = () => {
    setStartData(null)
    setFeedback(null)
    setTurns([])
    setError(null)
    setPhase('setup')
  }

  return (
    <div className="page interview-page">
      {phase === 'setup' && (
        <>
          <SetupPhase
            roles={roles}
            loadingRoles={loadingRoles}
            roleId={roleId}
            setRoleId={setRoleId}
            interviewType={interviewType}
            setInterviewType={setInterviewType}
            questionCount={questionCount}
            setQuestionCount={setQuestionCount}
            hasResume={hasResume}
            error={error}
          />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!roleId || starting}
              onClick={handleStart}
            >
              {starting ? 'Starting…' : 'Continue →'}
            </button>
          </div>
        </>
      )}

      {phase === 'preflight' && startData && (
        <PreflightPhase
          role={startData.role}
          interviewType={startData.interview_type}
          questionCount={startData.question_count}
          hasResume={hasResume}
          error={error}
          busy={starting}
          onStart={handlePreflightStart}
        />
      )}

      {phase === 'live' && startData && (
        <LivePhase
          startData={startData}
          onComplete={handleComplete}
          onAbort={handleAbort}
        />
      )}

      {phase === 'feedback' && feedback && (
        <FeedbackPhase
          feedback={feedback}
          turns={turns}
          role={startData?.role}
          interviewType={startData?.interview_type}
          onRetry={handleRetry}
        />
      )}
    </div>
  )
}
