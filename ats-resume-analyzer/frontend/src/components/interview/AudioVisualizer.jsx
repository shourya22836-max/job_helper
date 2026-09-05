/**
 * AudioVisualizer - Real-time audio visualization components.
 *
 * Components:
 *   - WaveformBars: Animated frequency bars for speaking/listening states
 *   - SpeakingRing: Pulsing ring around avatar when AI is speaking
 *   - AudioLevelMeter: Horizontal meter for microphone input level
 *
 * These components are driven by props/state (not direct audio analysis)
 * so they work with both LiveKit audio tracks and browser TTS fallback.
 */

import { useEffect, useRef, useState, useCallback } from 'react'

// ---------------------------------------------------------------------------
// WaveformBars — animated frequency bars
// ---------------------------------------------------------------------------
function WaveformBars({
  isActive = false,
  barCount = 16,
  color = 'var(--primary)',
  height = 40,
  className = '',
}) {
  const [bars, setBars] = useState(() => Array(barCount).fill(0.1))
  const rafRef = useRef(null)
  const isActiveRef = useRef(isActive)

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    if (!isActive) {
      // Smooth decay to baseline
      let raf = null
      const decay = () => {
        setBars((prev) =>
          prev.map((v) => Math.max(0.05, v * 0.92))
        )
        if (prev => prev.some(v => v > 0.06)) {
          raf = requestAnimationFrame(decay)
        }
      }
      raf = requestAnimationFrame(decay)
      return () => raf && cancelAnimationFrame(raf)
    }

    // Active animation: random-ish levels with smoothing
    let raf = null
    const tick = () => {
      if (!isActiveRef.current) return
      setBars((prev) =>
        prev.map((v) => {
          // Target: random between 0.15 and 1.0
          const target = 0.15 + Math.random() * 0.85
          // Smooth toward target
          return v + (target - v) * 0.3
        })
      )
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => raf && cancelAnimationFrame(raf)
  }, [isActive])

  return (
    <div
      className={`waveform-bars ${className}`}
      style={{ height, display: 'flex', alignItems: 'flex-end', gap: 3 }}
      aria-hidden="true"
      role="img"
      aria-label={isActive ? 'Audio waveform - speaking' : 'Audio waveform - silent'}
    >
      {bars.map((level, i) => (
        <div
          key={i}
          className="waveform-bar"
          style={{
            flex: 1,
            height: `${Math.max(4, level * height)}px`,
            background: color,
            borderRadius: 2,
            transition: 'height 50ms ease-out',
            opacity: 0.7 + level * 0.3,
          }}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpeakingRing — pulsing ring for avatar
// ---------------------------------------------------------------------------
function SpeakingRing({
  isActive = false,
  size = 160,
  ringWidth = 4,
  color = 'var(--primary)',
  className = '',
}) {
  const [pulse, setPulse] = useState(0)
  const rafRef = useRef(null)
  const isActiveRef = useRef(isActive)

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    if (!isActive) {
      setPulse(0)
      return
    }
    let raf = null
    const start = performance.now()
    const tick = () => {
      if (!isActiveRef.current) return
      const t = (performance.now() - start) / 1000
      // 2.5Hz pulse with easing
      const raw = Math.sin(t * Math.PI * 5)
      const eased = (raw + 1) / 2 // 0-1
      setPulse(0.3 + 0.7 * eased) // 0.3 to 1.0
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => raf && cancelAnimationFrame(raf)
  }, [isActive])

  return (
    <div
      className={`speaking-ring ${className}`}
      style={{
        width: size,
        height: size,
        position: 'absolute',
        inset: -ringWidth * 2,
        borderRadius: '50%',
        pointerEvents: 'none',
        zIndex: 10,
      }}
      aria-hidden="true"
    >
      <div
        className="speaking-ring-inner"
        style={{
          position: 'absolute',
          inset: ringWidth,
          border: `${ringWidth}px solid ${color}`,
          borderRadius: '50%',
          opacity: pulse,
          transform: `scale(${0.8 + pulse * 0.3})`,
          transition: 'opacity 50ms, transform 50ms',
          boxShadow: `0 0 ${ringWidth * 4}px ${color}`,
        }}
      />
      <div
        className="speaking-ring-outer"
        style={{
          position: 'absolute',
          inset: 0,
          border: `${ringWidth}px solid ${color}`,
          borderRadius: '50%',
          opacity: pulse * 0.5,
          transform: `scale(${0.7 + pulse * 0.5})`,
          transition: 'opacity 50ms, transform 50ms',
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// AudioLevelMeter — horizontal meter for mic input
// ---------------------------------------------------------------------------
function AudioLevelMeter({
  level = 0, // 0-1
  width = 200,
  height = 8,
  color = 'var(--success)',
  bgColor = 'var(--surface-2)',
  borderColor = 'var(--border)',
  className = '',
  showLabel = false,
}) {
  const [displayLevel, setDisplayLevel] = useState(0)
  const rafRef = useRef(null)
  const targetRef = useRef(level)

  useEffect(() => {
    targetRef.current = level
  }, [level])

  useEffect(() => {
    let raf = null
    const tick = () => {
      setDisplayLevel((prev) => {
        const diff = targetRef.current - prev
        return prev + diff * 0.15 // Smooth interpolation
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => raf && cancelAnimationFrame(raf)
  }, [])

  const pct = Math.round(displayLevel * 100)

  return (
    <div className={`audio-level-meter ${className}`} style={{ width }}>
      {showLabel && <div className="audio-level-label">{pct}%</div>}
      <div
        className="audio-level-track"
        style={{
          width: '100%',
          height,
          background: bgColor,
          border: `1px solid ${borderColor}`,
          borderRadius: 999,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          className="audio-level-fill"
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: 999,
            transition: 'width 80ms linear',
            boxShadow: `0 0 8px ${color}`,
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MicActivityIndicator — compact mic status with level
// ---------------------------------------------------------------------------
function MicActivityIndicator({
  isActive = false,
  level = 0,
  className = '',
}) {
  return (
    <div className={`mic-activity-indicator ${className} ${isActive ? 'active' : ''}`}>
      <div className="mic-icon" aria-hidden="true">🎙️</div>
      <AudioLevelMeter
        level={level}
        width={100}
        height={6}
        color="var(--success)"
        className="mic-level"
      />
      <span className="mic-status">{isActive ? 'Live' : 'Muted'}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// useAudioLevel — hook to analyze audio from a MediaStream
// ---------------------------------------------------------------------------
function useAudioLevel(stream, { enabled = true, smoothingTimeConstant = 0.8 } = {}) {
  const [level, setLevel] = useState(0)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceRef = useRef(null)
  const rafRef = useRef(null)
  const enabledRef = useRef(enabled)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    if (!enabled || !stream) {
      setLevel(0)
      return
    }

    const cleanup = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (sourceRef.current) {
        try { sourceRef.current.disconnect() } catch { }
        sourceRef.current = null
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {})
        audioCtxRef.current = null
      }
      analyserRef.current = null
      setLevel(0)
    }

    const setup = async () => {
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return

        const ctx = new AC()
        audioCtxRef.current = ctx
        const src = ctx.createMediaStreamSource(stream)
        sourceRef.current = src
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = smoothingTimeConstant
        analyserRef.current = analyser
        src.connect(analyser)

        const buffer = new Uint8Array(analyser.frequencyBinCount)
        const tick = () => {
          if (!analyserRef.current || !enabledRef.current) return
          analyserRef.current.getByteFrequencyData(buffer)
          let sum = 0
          for (let i = 0; i < buffer.length; i++) {
            sum += buffer[i]
          }
          const avg = sum / buffer.length / 255 // 0-1
          setLevel(Math.min(1, avg * 3)) // Amplify for visibility
          rafRef.current = requestAnimationFrame(tick)
        }
        tick()
      } catch (e) {
        console.warn('[useAudioLevel] Failed to setup:', e)
      }
    }

    setup()
    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, enabled, smoothingTimeConstant])

  return level
}

// ---------------------------------------------------------------------------
// Export all
// ---------------------------------------------------------------------------
export {
  WaveformBars,
  SpeakingRing,
  AudioLevelMeter,
  MicActivityIndicator,
  useAudioLevel,
}

// Default export for convenience
export default {
  WaveformBars,
  SpeakingRing,
  AudioLevelMeter,
  MicActivityIndicator,
  useAudioLevel,
}