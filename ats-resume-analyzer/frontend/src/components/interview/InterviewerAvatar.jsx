/** @jsxImportSource react */
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react'

/**
 * InterviewerAvatar - Unified avatar component supporting multiple providers.
 *
 * Providers:
 *   - "local" (default): 3D WebGL avatar via AvatarScene (React Three Fiber)
 *   - "tavus": Tavus CVR video streaming
 *   - "heygen": HeyGen Streaming Avatar
 *   - "beyond_presence": Beyond Presence
 *   - "simli": Simli low-latency WebRTC
 *
 * Props:
 *   provider         - Avatar provider name (from backend config)
 *   session          - AvatarSession object from backend
 *   state            - 'idle' | 'thinking' | 'speaking' | 'listening' | 'paused'
 *   onViseme         - Callback for viseme frames (local provider)
 *   onExpression     - Callback for expression changes (local provider)
 *   className        - Additional CSS classes
 *   style            - Inline styles
 *
 * Imperative API (via ref):
 *   setViseme(frame)     - Push viseme frame (local provider)
 *   setExpression(label, intensity) - Set emotion (local provider)
 *   resetExpression()    - Reset to neutral (local provider)
 */

// Lazy-load heavy 3D deps only when needed
const loadAvatarScene = () =>
  import('../AvatarScene').then((m) => m.default)

const PROVIDER_CONFIG = {
  local: {
    label: 'Local 3D',
    supportsVideo: false,
    supportsWebRTC: false,
  },
  tavus: {
    label: 'Tavus',
    supportsVideo: true,
    supportsWebRTC: false,
  },
  heygen: {
    label: 'HeyGen',
    supportsVideo: true,
    supportsWebRTC: true,
  },
  beyond_presence: {
    label: 'Beyond Presence',
    supportsVideo: true,
    supportsWebRTC: true,
  },
  simli: {
    label: 'Simli',
    supportsVideo: false,
    supportsWebRTC: true,
  },
}

function SpeakingRing({ isActive, intensity = 1, className = '' }) {
  const ringRef = useRef(null)
  const [pulse, setPulse] = useState(0)

  useEffect(() => {
    if (!isActive) {
      setPulse(0)
      return
    }
    let raf = null
    const start = performance.now()
    const tick = () => {
      const t = (performance.now() - start) / 1000
      // 3Hz pulse modulated by intensity
      setPulse(0.5 + 0.5 * Math.sin(t * Math.PI * 6) * intensity)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => raf && cancelAnimationFrame(raf)
  }, [isActive, intensity])

  return (
    <div
      ref={ringRef}
      className={`speaking-ring ${className}`}
      style={{
        '--ring-pulse': pulse,
        '--ring-intensity': intensity,
      }}
      aria-hidden="true"
    >
      <div className="speaking-ring-inner" />
      <div className="speaking-ring-outer" />
      <div className="speaking-ring-glow" />
    </div>
  )
}

function BreathingAnimation({ isActive, className = '' }) {
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    if (!isActive) {
      setPhase(0)
      return
    }
    let raf = null
    const start = performance.now()
    const tick = () => {
      const t = (performance.now() - start) / 1000
      // Slow 0.25Hz breathing (4s cycle)
      setPhase(0.5 + 0.5 * Math.sin(t * Math.PI * 0.5))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => raf && cancelAnimationFrame(raf)
  }, [isActive])

  return (
    <div
      className={`breathing-animation ${className}`}
      style={{
        '--breath-phase': phase,
      }}
      aria-hidden="true"
    >
      <div className="breath-ring" />
      <div className="breath-ring-delayed" />
    </div>
  )
}

/* Professional Fallback Avatar - Used when no 3D/video provider available */
function ProfessionalFallbackAvatar({ state, className = '', style }) {
  const isSpeaking = state === 'speaking'
  const isThinking = state === 'thinking'
  const isPaused = state === 'paused'

  return (
    <div
      className={`interviewer-fallback ${className}`}
      style={style}
      data-state={state}
      role="img"
      aria-label={`AI Interviewer - ${state}`}
    >
      <div className="interviewer-silhouette" />
      {isSpeaking && <div className="speaking-ring" />}
      {isThinking && <div className="thinking-pulse" />}
      {!isSpeaking && !isThinking && <div className="breathing-ring" />}
    </div>
  )
}

function VideoStreamProvider({ session, state, className = '' }) {
  const videoRef = useRef(null)
  const [error, setError] = useState(null)
  const [connecting, setConnecting] = useState(true)

  const config = PROVIDER_CONFIG[session?.provider] || {}

  useEffect(() => {
    if (!session || !videoRef.current) return
    const video = videoRef.current
    setConnecting(true)
    setError(null)

    const cleanup = () => {
      if (video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop())
        video.srcObject = null
      }
    }

    const connect = async () => {
      try {
        if (config.supportsWebRTC && session.webrtc_url) {
          // WebRTC connection for HeyGen, Beyond Presence, Simli
          const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          })
          pc.ontrack = (e) => {
            video.srcObject = e.streams[0]
            setConnecting(false)
          }
          // Note: Actual WebRTC signaling would happen via backend
          // This is a simplified placeholder
          console.warn('[InterviewerAvatar] WebRTC signaling not fully implemented')
          setError('WebRTC signaling requires backend integration')
          setConnecting(false)
        } else if (session.stream_url) {
          // Direct video stream (Tavus, etc.)
          video.src = session.stream_url
          video.crossOrigin = 'anonymous'
          video.play().catch(() => {})
          video.onloadeddata = () => setConnecting(false)
          video.onerror = () => setError('Failed to load video stream')
        } else {
          setError('No stream URL available')
          setConnecting(false)
        }
      } catch (e) {
        setError(e.message)
        setConnecting(false)
      }
    }

    connect()
    return cleanup
  }, [session, config.supportsWebRTC])

  if (error) {
    // Fall back to professional fallback on error
    return (
      <ProfessionalFallbackAvatar state={state} className={className} />
    )
  }

  return (
    <div className={`avatar-video-wrapper ${className}`}>
      {connecting && <div className="avatar-video-loading">Connecting…</div>}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={false}
        className="avatar-video"
        style={{
          objectFit: 'cover',
          width: '100%',
          height: '100%',
          borderRadius: 'inherit',
        }}
      />
      {(state === 'speaking' || state === 'thinking') && (
        <SpeakingRing isActive={state === 'speaking'} intensity={state === 'speaking' ? 1 : 0.4} />
      )}
      {state === 'idle' && <BreathingAnimation isActive />}
    </div>
  )
}

function Local3DAvatar({
  session,
  state,
  onViseme,
  onExpression,
  className = '',
  style,
  ref,
}) {
  const avatarRef = useRef(null)
  const [AvatarScene, setAvatarScene] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [mounted, setMounted] = useState(false)

  // Load AvatarScene component lazily
  useEffect(() => {
    setMounted(true)
    loadAvatarScene()
      .then((comp) => setAvatarScene(() => comp))
      .catch((e) => {
        console.error('[InterviewerAvatar] Failed to load AvatarScene:', e)
        setLoadError(e.message)
      })
  }, [])

  // Forward imperative API
  useImperativeHandle(ref, () => ({
    setViseme: (frame) => avatarRef.current?.setViseme?.(frame),
    setExpression: (label, intensity) => avatarRef.current?.setExpression?.(label, intensity),
    resetExpression: () => avatarRef.current?.resetExpression?.(),
  }), [])

  if (!mounted) {
    return (
      <div className={`avatar-local-loading ${className}`} style={style}>
        <div className="avatar-spinner" aria-label="Loading avatar" />
      </div>
    )
  }

  if (loadError || !AvatarScene) {
    // Professional fallback when 3D fails to load
    return (
      <ProfessionalFallbackAvatar state={state} className={className} style={style} />
    )
  }

  return (
    <div className={`avatar-local-wrapper ${className}`} style={style}>
      <AvatarScene
        ref={avatarRef}
        modelUrl={session?.model_url}
        isSpeaking={state === 'speaking'}
        isThinking={state === 'thinking'}
        emotion={
          state === 'thinking' ? 'think' :
          state === 'speaking' ? 'neutral' :
          'neutral'
        }
        onViseme={onViseme}
        onExpression={onExpression}
      />
      {(state === 'speaking' || state === 'thinking') && (
        <SpeakingRing isActive={state === 'speaking'} intensity={state === 'speaking' ? 1 : 0.4} />
      )}
      {state === 'idle' && <BreathingAnimation isActive />}
    </div>
  )
}

const InterviewerAvatar = forwardRef(function InterviewerAvatar(
  {
    provider = 'local',
    session,
    state = 'idle',
    onViseme,
    onExpression,
    className = '',
    style,
    'data-testid': testId,
  },
  ref,
) {
  const config = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.local
  const isVideoProvider = config.supportsVideo || config.supportsWebRTC

  // Normalize state - support 'paused' as well
  const validStates = ['idle', 'thinking', 'speaking', 'listening', 'paused']
  const normalizedState = validStates.includes(state) ? state : 'idle'

  // Handle viseme/expression callbacks for local provider
  const handleViseme = useCallback((frame) => {
    onViseme?.(frame)
  }, [onViseme])

  const handleExpression = useCallback((label, intensity) => {
    onExpression?.(label, intensity)
  }, [onExpression])

  return (
    <div
      className={`interviewer-avatar interviewer-avatar--${provider} ${className}`}
      style={style}
      data-provider={provider}
      data-state={normalizedState}
      data-testid={testId}
      role="img"
      aria-label={`AI Interviewer (${config.label}) - ${normalizedState}`}
    >
      {isVideoProvider ? (
        <VideoStreamProvider
          session={session}
          state={normalizedState}
          className="interviewer-avatar__video"
        />
      ) : (
        <Local3DAvatar
          ref={ref}
          session={session}
          state={normalizedState}
          onViseme={handleViseme}
          onExpression={handleExpression}
          className="interviewer-avatar__local"
          style={style}
        />
      )}

      {/* State indicator badge */}
      <div className={`avatar-state-badge avatar-state-badge--${normalizedState}`} aria-hidden="true">
        <span className="avatar-state-dot" />
        <span className="avatar-state-label">
          {normalizedState.charAt(0).toUpperCase() + normalizedState.slice(1)}
        </span>
      </div>

      {/* Provider label (debug) */}
      {process.env.NODE_ENV === 'development' && (
        <div className="avatar-provider-label" aria-hidden="true">
          {config.label}
        </div>
      )}
    </div>
  )
})

InterviewerAvatar.displayName = 'InterviewerAvatar'

export default InterviewerAvatar