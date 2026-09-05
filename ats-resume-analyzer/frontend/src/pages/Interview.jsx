import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchRoles, getInterviewFeedback, startInterview } from '../lib/api.js'
import { useHistory } from '../context/HistoryContext.jsx'
import { useSpeechRecognition } from '../hooks/useSpeechRecognition.js'
import { useBrowserTTS } from '../hooks/useBrowserTTS.js'
// InterviewerAvatar is lazy-loaded below to keep the initial bundle small
// and supports multiple providers (local 3D, Tavus, HeyGen, etc.)
// AudioVisualizer for waveform bars and speaking ring
import { WaveformBars, AudioLevelMeter, useAudioLevel } from '../components/interview/AudioVisualizer.jsx'

// ---------------------------------------------------------------------------
// Lazy LiveKit import — keeps the page bundle small and lets the rest of the
// app work even if `npm install` hasn't been run yet.
// ---------------------------------------------------------------------------
async function loadLiveKit() {
  try {
    return await import('livekit-client')
  } catch (e) {
    console.warn('livekit-client not available:', e)
    return null
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERVIEW_TYPES = [
  { id: 'hr', name: 'HR', icon: '🤝', desc: 'Motivation, teamwork, communication, culture fit.' },
  { id: 'technical', name: 'Technical', icon: '⚙️', desc: 'Skills, projects, problem-solving, trade-offs.' },
  { id: 'behavioral', name: 'Behavioral', icon: '🧠', desc: 'STAR-format questions about past experience.' },
]

const QUESTION_COUNT_OPTIONS = [4, 6, 8, 10]

// Data-channel topic the LiveKit agent uses to publish captions.
const DC_TOPIC_CONTROL = 'interview.control'

// Helper to dynamically load the InterviewerAvatar component.
async function loadInterviewerAvatar() {
  const mod = await import('../components/interview/InterviewerAvatar.jsx')
  return mod.default || null
}

function verdictLabel(v) {
  if (v === 'strong') return 'Strong'
  if (v === 'needs_work') return 'Needs work'
  return 'OK'
}

// Professional interviewer display names
const INTERVIEWER_ROLE_LABELS = {
  hr: 'Senior HR Partner • Interviewer',
  technical: 'Software Development Engineer • Interviewer',
  behavioral: 'Engineering Leadership • Interviewer',
}

const INTERVIEWER_ROUND_LABELS = {
  hr: 'HR Screening Round',
  technical: 'Technical Round',
  behavioral: 'Behavioral Round',
}

// ---------------------------------------------------------------------------
// Setup phase
// ---------------------------------------------------------------------------

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
                  <option key={r.id} value={r.id}>{r.name} ({r.level})</option>
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
                >{n}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
    </>
  )
}

// ---------------------------------------------------------------------------
// Pre-flight: device check
// ---------------------------------------------------------------------------

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

        const AC = window.AudioContext
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

// ---------------------------------------------------------------------------
// Live phase — LiveKit-based realtime voice
// ---------------------------------------------------------------------------

function LivePhase({ startData, onComplete, onAbort }) {
  const userVideoRef = useRef(null)
  const roomRef = useRef(null)
  const avatarRef = useRef(null)
  const cleanupRef = useRef([])

  const [phase, setPhase] = useState('live')
  const [transcript, setTranscript] = useState([]) // {role, text, final, ts}
  const [currentQuestion, setCurrentQuestion] = useState(startData.first_question)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [totalQuestions, setTotalQuestions] = useState(startData.question_count)
  const [aiSpeaking, setAiSpeaking] = useState(false)
  const [aiThinking, setAiThinking] = useState(false)
  const [agentJoined, setAgentJoined] = useState(false)
  const [paused, setPaused] = useState(false)
  const [camOn, setCamOn] = useState(true)
  const [micOn, setMicOn] = useState(true)
  const [error, setError] = useState(null)
  const [textDraft, setTextDraft] = useState('')
  const [connectionState, setConnectionState] = useState('connecting')
  const [emotion, setEmotion] = useState('neutral')
  const [AvatarComp, setAvatarComp] = useState(null)
  const completedRef = useRef(false)

  const roomName = startData.room_name
  const roleName = startData.role?.name || 'Interviewer'

  // ----- Lazy-load the InterviewerAvatar component ------------------------------
  useEffect(() => {
    let cancelled = false
    loadInterviewerAvatar().then((C) => { if (!cancelled) setAvatarComp(() => C) })
    return () => { cancelled = true }
  }, [])

  // ----- Seed the first question into the transcript immediately so the
  // panel isn't blank waiting for the agent to join. The ParticipantConnected
  // handler will not duplicate it.
  useEffect(() => {
    const q = startData?.first_question
    if (!q) return
    setTranscript((prev) =>
      prev.length === 0
        ? [{ role: 'assistant', text: q, final: true, ts: Date.now() / 1000 }]
        : prev,
    )
  }, [startData?.first_question])

  // ----- Browser TTS fallback (only used when Cartesia isn't producing audio)
  // If the agent published a `question` DC message and we never got an audio
  // track, we speak it locally so the avatar has something to lip-sync to.
  const lastSpokenQuestionRef = useRef(null)
  const audioTrackSeenRef = useRef(false)
  const tts = useBrowserTTS({
    onViseme: (frame) => avatarRef.current?.setViseme(frame),
    onStart: () => { setAiSpeaking(true); setAiThinking(false) },
    onEnd: () => { setAiSpeaking(false) },
  })

  // ----- Speak the FIRST question locally as soon as we mount, if no real
  // agent audio track arrives within a short grace period. This guarantees
  // the user hears the opening question even when Cartesia isn't configured
  // and the captions-only fallback is the only path available.
  useEffect(() => {
    if (!tts.supported) return
    const q = startData?.first_question
    if (!q) return
    lastSpokenQuestionRef.current = q
    const t = setTimeout(() => {
      if (!audioTrackSeenRef.current) tts.speak(q)
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- Browser STT fallback (when Deepgram isn't in the loop).
  // We only forward final transcripts as user messages so the agent doesn't
  // see mid-sentence fragments.
  const sendDcRef = useRef(null) // forward-declared; assigned below
  const pushTranscriptRef = useRef(null)
  const stt = useSpeechRecognition({
    onResult: ({ text, final, ts }) => {
      if (!final || !text) return
      // Mirror into transcript like the LiveKit path.
      pushTranscriptRef.current?.({ role: 'user', text, final: true, ts })
      // Send to the agent.
      sendDcRef.current?.({ type: 'text', text })
    },
  })

  // ----- Connect to the LiveKit room and publish mic + camera --------------
  useEffect(() => {
    let cancelled = false

    async function connect() {
      const lk = await loadLiveKit()
      if (!lk) {
        setError('livekit-client is not installed. Run `npm install` in the frontend directory.')
        return
      }
      if (!startData.livekit_url || !startData.token) {
        setError('LiveKit URL or access token missing — check your backend .env.')
        return
      }

      const room = new lk.Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: { simulcast: false },
      })
      roomRef.current = room

      room.on(lk.RoomEvent.ConnectionStateChanged, (state) => {
        setConnectionState(String(state))
      })

      room.on(lk.RoomEvent.ParticipantConnected, (participant) => {
        // Any non-local participant arriving is treated as the agent.
        if (participant.identity !== room.localParticipant.identity) {
          setAgentJoined(true)
          // Seed the very first transcript line with the pre-generated question,
          // so the UI is never empty.
          setTranscript((prev) =>
            prev.length === 0
              ? [{ role: 'assistant', text: startData.first_question, final: true, ts: Date.now() / 1000 }]
              : prev,
          )
        }
      })

      room.on(lk.RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.identity !== room.localParticipant.identity) {
          // The agent left — treat this as the interview ending.
          if (!completedRef.current) finishInterview()
        }
      })

      room.on(lk.RoomEvent.DataReceived, (payload, _participant, _kind, _topic) => {
        // Decode the agent's JSON captions and control events.
        try {
          const text = new TextDecoder().decode(payload)
          const msg = JSON.parse(text)
          handleDcMessage(msg)
        } catch (e) {
          console.warn('bad data-channel payload', e)
        }
      })

      room.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind === lk.Track.Kind.Audio && participant.identity !== room.localParticipant.identity) {
          // Attach the agent's audio to the default output.
          audioTrackSeenRef.current = true
          const el = track.attach()
          el.id = 'lk-agent-audio'
          document.body.appendChild(el)
          cleanupRef.current.push(() => {
            try { el.remove() } catch { /* ignore */ }
          })
          // Cancel any browser-TTS fallback that's still playing.
          tts.cancel()
          setAiSpeaking(true)
        }
      })

      try {
        await room.connect(startData.livekit_url, startData.token)
        if (cancelled) { room.disconnect(); return }
        await room.localParticipant.setMicrophoneEnabled(true)
        await room.localParticipant.setCameraEnabled(true)
        // Attach our own camera preview.
        const camPub = room.localParticipant.getTrackPublication(lk.Track.Source.Camera)
        if (camPub?.videoTrack && userVideoRef.current) {
          userVideoRef.current.srcObject = new MediaStream([camPub.videoTrack.mediaStreamTrack])
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Could not connect to LiveKit room.')
      }
    }

    connect()

    return () => {
      cancelled = true
      try { roomRef.current?.disconnect() } catch { /* ignore */ }
      cleanupRef.current.forEach((fn) => { try { fn() } catch { /* ignore */ } })
      cleanupRef.current = []
      // Cancel any active browser TTS/STT so audio doesn't leak past unmount.
      try { tts.cancel() } catch { /* ignore */ }
      try { stt.stop() } catch { /* ignore */ }
      avatarRef.current?.resetExpression()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- Control mic/camera on the LocalParticipant ------------------------
  useEffect(() => {
    const room = roomRef.current
    if (!room) return
    room.localParticipant.setMicrophoneEnabled(micOn).catch(() => {})
  }, [micOn])

  useEffect(() => {
    const room = roomRef.current
    if (!room) return
    room.localParticipant.setCameraEnabled(camOn).catch(() => {})
  }, [camOn])

  // ----- Data-channel message handling -------------------------------------
  const handleDcMessage = useCallback((msg) => {
    const t = msg?.type
    if (!t) return
    if (t === 'question') {
      setCurrentQuestion(msg.text || '')
      setQuestionIndex(msg.index ?? 0)
      if (typeof msg.total === 'number') setTotalQuestions(msg.total)
      setAiSpeaking(false)
      setAiThinking(false)
      setTranscript((prev) => [
        ...prev,
        { role: 'assistant', text: msg.text || '', final: true, ts: Date.now() / 1000 },
      ])
      // If no LiveKit audio track arrived within a short grace period, speak
      // the question locally so the avatar has something to lip-sync to.
      // This is the captions-only mode fallback.
      if (!audioTrackSeenRef.current && msg.text && msg.text !== lastSpokenQuestionRef.current) {
        lastSpokenQuestionRef.current = msg.text
        if (tts.supported) {
          setTimeout(() => {
            if (!audioTrackSeenRef.current) tts.speak(msg.text)
          }, 800)
        }
      }
    } else if (t === 'caption') {
      const role = msg.role === 'user' ? 'user' : 'assistant'
      const text = msg.text || ''
      const isFinal = !!msg.final
      setTranscript((prev) => {
        if (!isFinal && prev.length && prev[prev.length - 1].role === role && !prev[prev.length - 1].final) {
          const next = prev.slice()
          next[next.length - 1] = { ...next[next.length - 1], text }
          return next
        }
        return [...prev, { role, text, final: isFinal, ts: Date.now() / 1000 }]
      })
      if (role === 'assistant' && isFinal) setAiSpeaking(true)
    } else if (t === 'ai_thinking') {
      setAiThinking(true)
      setAiSpeaking(false)
      avatarRef.current?.setExpression('think', 0.7)
    } else if (t === 'ai_done') {
      setAiThinking(false)
      setAiSpeaking(false)
    } else if (t === 'expression') {
      // Agent told us what emotion to display before speaking.
      const label = msg.emotion || 'neutral'
      const intensity = typeof msg.intensity === 'number' ? msg.intensity : 0.6
      setEmotion(label)
      avatarRef.current?.setExpression(label, intensity)
    } else if (t === 'viseme') {
      // Per-frame mouth/blink data — drives the avatar during TTS.
      avatarRef.current?.setViseme({
        mouthOpen: msg.mouthOpen ?? 0,
        smile: msg.smile ?? 0,
        browRaise: msg.browRaise ?? 0,
        blink: msg.blink ?? 0,
        ts: msg.ts,
      })
      if ((msg.mouthOpen ?? 0) > 0.05) {
        setAiSpeaking(true)
        setAiThinking(false)
      }
    } else if (t === 'complete') {
      completedRef.current = true
      finishInterview()
    } else if (t === 'error') {
      setError(msg.message || 'Realtime error.')
    }
  }, [tts])

  // ----- Send control messages back over the data channel ------------------
  const sendDc = useCallback((obj) => {
    const room = roomRef.current
    if (!room) return
    const enc = new TextEncoder().encode(JSON.stringify(obj))
    try {
      room.localParticipant.publishData(enc, { reliable: true, topic: DC_TOPIC_CONTROL })
    } catch (e) {
      console.warn('publishData failed', e)
    }
  }, [])

  // Keep the imperative sendDc reachable from the STT hook.
  useEffect(() => { sendDcRef.current = sendDc }, [sendDc])

  // Helper used by STT and the text-input box to push a transcript line.
  const pushTranscript = useCallback((entry) => {
    setTranscript((prev) => [...prev, entry])
  }, [])
  useEffect(() => { pushTranscriptRef.current = pushTranscript }, [pushTranscript])

  const finishInterview = useCallback(async () => {
    setPhase('finalizing')
    try {
      try { roomRef.current?.disconnect() } catch { /* ignore */ }
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

  const onPauseToggle = () => {
    if (paused) sendDc({ type: 'resume' })
    else sendDc({ type: 'pause' })
    setPaused((v) => !v)
  }

  const onEnd = () => {
    if (completedRef.current) return
    sendDc({ type: 'end' })
    setTimeout(() => {
      if (!completedRef.current) {
        completedRef.current = true
        finishInterview()
      }
    }, 600)
  }

  const onSkip = () => sendDc({ type: 'skip' })

  const onSendText = () => {
    const text = textDraft.trim()
    if (!text) return
    setTextDraft('')
    sendDc({ type: 'text', text })
    // Mirror it into the transcript so the user sees their message.
    setTranscript((prev) => [
      ...prev,
      { role: 'user', text, final: true, ts: Date.now() / 1000 },
    ])
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
      <div className="interview-header-bar">
        <div className="interview-header-left">
          <span className="pill pill-success">{startData.role.name}</span>
          <span className="pill">{startData.interview_type.toUpperCase()}</span>
        </div>
        <div className="interview-header-center">
          <span className="interview-status-badge">
            <span className={`status-dot ${aiThinking ? 'thinking' : aiSpeaking ? 'speaking' : agentJoined ? 'live' : 'connecting'}`} />
            {aiThinking ? 'AI thinking…' : aiSpeaking ? 'AI speaking' : agentJoined ? 'Live' : 'Connecting…'}
            {!agentJoined && connectionState !== 'connected' && ` (${connectionState})`}
          </span>
        </div>
        <div className="interview-header-right">
          {paused && <span className="pill pill-warning">Paused</span>}
        </div>
      </div>

      <div className="interview-main-grid">
        {/* LEFT PANEL - Interviewer Avatar */}
        <div className="interviewer-panel">
          <div className="interviewer-avatar-container">
            <div className="interviewer-avatar-wrapper">
              {AvatarComp ? (
                <AvatarComp
                  ref={avatarRef}
                  provider={startData.avatar_provider || 'local'}
                  session={startData.avatar_session}
                  state={aiThinking ? 'thinking' : aiSpeaking ? 'speaking' : paused ? 'paused' : 'idle'}
                  onViseme={(frame) => avatarRef.current?.setViseme?.(frame)}
                  onExpression={(label, intensity) => avatarRef.current?.setExpression?.(label, intensity)}
                  style={{ width: '100%', height: '100%' }}
                />
              ) : (
                // Professional fallback while component loads
                <div className="interviewer-fallback" data-state={aiThinking ? 'thinking' : aiSpeaking ? 'speaking' : paused ? 'paused' : 'idle'}>
                  <div className="interviewer-silhouette" />
                  {aiSpeaking && <div className="speaking-ring" />}
                  {aiThinking && <div className="thinking-pulse" />}
                  {!aiSpeaking && !aiThinking && <div className="breathing-ring" />}
                </div>
              )}

              {/* Candidate self-preview - bottom right of interviewer */}
              <div className={`candidate-preview ${camOn ? '' : 'muted'}`}>
                {camOn ? (
                  <video ref={userVideoRef} autoPlay playsInline muted />
                ) : (
                  <div className="preview-placeholder">
                    <span className="camera-icon">📷</span>
                    <span>Camera off</span>
                  </div>
                )}
                <span className="preview-label">You</span>
              </div>
            </div>

            {/* Interviewer title & round label */}
            <div className="interviewer-info">
              <div className="interviewer-title">
                {INTERVIEWER_ROLE_LABELS[startData.interview_type] || 'Senior Interviewer'}
              </div>
              <div className="interviewer-round">
                {INTERVIEWER_ROUND_LABELS[startData.interview_type] || `${startData.interview_type.charAt(0).toUpperCase() + startData.interview_type.slice(1)} Round`}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL - Controls & Content */}
        <div className="interview-sidebar">
          {/* Controls Bar - fixed at top of sidebar */}
          <div className="sidebar-controls" role="toolbar" aria-label="Interview controls">
            <button
              type="button"
              className={`sidebar-btn ${micOn ? '' : 'off'}`}
              title={micOn ? 'Mute microphone' : 'Unmute microphone'}
              onClick={onMicToggle}
              aria-pressed={!micOn}
            >
              <span className="btn-icon">{micOn ? '🎙️' : '🔇'}</span>
              <span className="btn-label">{micOn ? 'Mute' : 'Unmute'}</span>
            </button>
            {stt.supported && (
              <button
                type="button"
                className={`sidebar-btn ${stt.listening ? 'active' : ''}`}
                title={stt.listening ? 'Stop voice recognition' : 'Start voice recognition'}
                onClick={() => stt.toggle()}
                aria-pressed={stt.listening}
              >
                <span className="btn-icon">{stt.listening ? '🎤' : '🗣️'}</span>
                <span className="btn-label">{stt.listening ? 'Listening' : 'Voice'}</span>
              </button>
            )}
            <button
              type="button"
              className={`sidebar-btn ${camOn ? '' : 'off'}`}
              title={camOn ? 'Turn camera off' : 'Turn camera on'}
              onClick={onCamToggle}
              aria-pressed={!camOn}
            >
              <span className="btn-icon">{camOn ? '📹' : '🎬'}</span>
              <span className="btn-label">{camOn ? 'Camera Off' : 'Camera On'}</span>
            </button>
            <button
              type="button"
              className="sidebar-btn"
              title={paused ? 'Resume interview' : 'Pause interview'}
              onClick={onPauseToggle}
              aria-pressed={paused}
            >
              <span className="btn-icon">{paused ? '▶️' : '⏸️'}</span>
              <span className="btn-label">{paused ? 'Resume' : 'Pause'}</span>
            </button>
            <button
              type="button"
              className="sidebar-btn"
              title="Skip question"
              onClick={onSkip}
            >
              <span className="btn-icon">⏭️</span>
              <span className="btn-label">Skip</span>
            </button>
            <button
              type="button"
              className="sidebar-btn danger"
              title="End interview"
              onClick={onEnd}
            >
              <span className="btn-icon">⏹️</span>
              <span className="btn-label">End</span>
            </button>
          </div>

          {stt.supported && stt.listening && (
            <div className="stt-hint">
              <span className="listening-indicator" />
              Listening… {stt.interim ? `"${stt.interim}"` : ''}
            </div>
          )}
          {stt.supported === false && (
            <div className="stt-hint warning">
              Voice recognition unavailable — type your answer below.
            </div>
          )}

          {/* Progress Section */}
          <div className="sidebar-section progress-section">
            <div className="progress-header">
              <span className="progress-text">
                Question {Math.min(questionIndex + 1, totalQuestions)} of {totalQuestions}
              </span>
              <span className="progress-pct">{progressPct}%</span>
            </div>
            <div className="progress-bar"><div className="progress-bar-fill" style={{ width: `${progressPct}%` }} /></div>
          </div>

          {/* Current Question Card */}
          <div className="sidebar-section question-section">
            <div className="section-label">Current Question</div>
            <div className="question-card">
              <p className="question-text">{currentQuestion}</p>
            </div>
          </div>

          {/* Live Transcript */}
          <div className="sidebar-section transcript-section">
            <div className="section-header">
              <h3>Live Transcript</h3>
              <span className="muted small">{transcript.length} line{transcript.length === 1 ? '' : 's'}</span>
            </div>
            <div className="transcript-list">
              {transcript.length === 0 && (
                <p className="transcript-empty">Waiting for interview to begin…</p>
              )}
              {transcript.map((line, i) => (
                <div key={i} className={`transcript-line ${line.role} ${line.final ? '' : 'interim'}`}>
                  <span className="t-role">{line.role === 'user' ? 'You' : 'Interviewer'}</span>
                  <span className="t-text">{line.text}</span>
                </div>
              ))}
              {aiThinking && (
                <div className="transcript-line assistant interim">
                  <span className="t-role">Interviewer</span>
                  <span className="t-text"><span className="typing"><span /><span /><span /></span></span>
                </div>
              )}
            </div>
          </div>

          {/* Text Fallback Input */}
          <div className="sidebar-section input-section">
            <div className="section-label">Type Your Answer</div>
            <div className="chat-input-row">
              <input
                className="chat-input"
                placeholder="Type your answer and press Enter…"
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendText() }}}
                disabled={paused || phase !== 'live'}
                autoFocus
              />
              <button
                type="button"
                className="btn btn-primary send-btn"
                onClick={onSendText}
                disabled={!textDraft.trim() || paused || phase !== 'live'}
              >
                Send
              </button>
            </div>
          </div>

          {error && <div className="form-error sidebar-error">{error}</div>}

          {/* Footer Actions */}
          <div className="sidebar-footer">
            <button type="button" className="btn btn-danger btn-full" onClick={onEnd}>End Interview</button>
            <button type="button" className="btn btn-secondary btn-full" onClick={onAbort}>Cancel & Exit</button>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Feedback phase (unchanged)
// ---------------------------------------------------------------------------

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
      {qa.answer_snippet && <div className="qa-a">"{qa.answer_snippet}"</div>}
      <div className="qa-score"><div><div style={{ width: `${score}%` }} /></div></div>
      {qa.comment && <div className="qa-comment"><strong>Coach:</strong> {qa.comment}</div>}
      {qa.suggested_answer && (
        <div className="qa-suggested"><strong>Try instead:</strong> {qa.suggested_answer}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page entrypoint
// ---------------------------------------------------------------------------

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
    if (stream) {
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
