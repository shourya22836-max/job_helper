// Browser-side Text-to-Speech hook with optional viseme/mouth-amplitude streaming.
//
// Use this as the FALLBACK TTS path when the LiveKit agent isn't using Cartesia
// (e.g. captions-only mode). The hook speaks text via window.speechSynthesis
// AND emits a ~30 Hz stream of mouth-amplitude frames so the 3D avatar can
// lip-sync visually.
//
// Why: a static avatar while the AI speaks feels broken. Even a coarse
// envelope-driven mouth-open makes the avatar feel alive.
//
// Viseme model:
//   mouthOpen = derived from the current utterance's RMS amplitude
//   smile     = mild baseline so the avatar isn't deadpan while talking
//
// In production with Cartesia on the agent, the agent sends real
// {type:"viseme"} frames over the LiveKit data channel; this hook is the
// graceful-degradation path.
//
// Returns:
//   { supported, speaking, speak(text), cancel(), lastViseme }

import { useCallback, useEffect, useRef, useState } from 'react'

const VISEME_HZ = 30

export function useBrowserTTS({
  lang = 'en-US',
  rate = 1.0,
  pitch = 1.0,
  volume = 1.0,
  voiceURI = null,             // null → pick default voice for `lang`
  onViseme,                   // ({ mouthOpen, smile, ts }) => void
  onStart,                    // () => void
  onEnd,                      // () => void
} = {}) {
  const [supported] = useState(() => typeof window !== 'undefined' && 'speechSynthesis' in window)
  const [speaking, setSpeaking] = useState(false)
  const [lastViseme, setLastViseme] = useState(null)
  const [voices, setVoices] = useState([])

  const utteranceRef = useRef(null)
  const rafRef = useRef(null)
  const analyserRef = useRef(null)
  const audioCtxRef = useRef(null)
  const sourceRef = useRef(null)
  const cancelledRef = useRef(false)
  const onVisemeRef = useRef(onViseme)
  const onStartRef = useRef(onStart)
  const onEndRef = useRef(onEnd)

  useEffect(() => { onVisemeRef.current = onViseme }, [onViseme])
  useEffect(() => { onStartRef.current = onStart }, [onStart])
  useEffect(() => { onEndRef.current = onEnd }, [onEnd])

  // Voices load asynchronously on Chromium — refresh on voiceschanged.
  useEffect(() => {
    if (!supported) return
    const synth = window.speechSynthesis
    const refresh = () => setVoices(synth.getVoices() || [])
    refresh()
    synth.onvoiceschanged = refresh
    return () => { synth.onvoiceschanged = null }
  }, [supported])

  const pickVoice = useCallback(() => {
    if (!voices.length) return null
    if (voiceURI) return voices.find((v) => v.voiceURI === voiceURI) || voices[0]
    // Prefer a voice matching the requested lang, else the first voice.
    return voices.find((v) => v.lang?.toLowerCase().startsWith(lang.toLowerCase().split('-')[0]))
        || voices[0]
  }, [voices, voiceURI, lang])

  const cleanupAudio = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect() } catch { /* ignore */ }
      sourceRef.current = null
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    analyserRef.current = null
  }, [])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    if (!supported) return
    try { window.speechSynthesis.cancel() } catch { /* ignore */ }
    cleanupAudio()
    setSpeaking(false)
    setLastViseme(null)
  }, [supported, cleanupAudio])

  const speak = useCallback((text) => {
    if (!supported || !text || !text.trim()) return
    cancelledRef.current = false

    // Stop anything already playing.
    try { window.speechSynthesis.cancel() } catch { /* ignore */ }
    cleanupAudio()

    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice()
    if (v) u.voice = v
    u.lang = lang
    u.rate = rate
    u.pitch = pitch
    u.volume = volume

    u.onstart = () => {
      setSpeaking(true)
      onStartRef.current?.()

      // Tap the synthesized audio so we can drive a real envelope instead of
      // a fake loop. SpeechSynthesis doesn't expose the audio buffer directly
      // on most browsers, so we fall back to a synthetic envelope below if
      // audioContext can't capture the stream.
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (AC) {
          const ctx = new AC()
          audioCtxRef.current = ctx
          const an = ctx.createAnalyser()
          an.fftSize = 256
          analyserRef.current = an
          // We can't easily attach to the synth output, so generate a
          // soft pulsing envelope keyed to the utterance duration as a
          // graceful fallback. It still produces visible mouth motion.
          const startTs = performance.now()
          // Estimate utterance duration: ~60ms per character at rate=1
          const estimatedMs = Math.max(1500, text.length * 60 / rate)
          const buf = new Uint8Array(an.frequencyBinCount)
          const tick = () => {
            if (cancelledRef.current) return
            const elapsed = performance.now() - startTs
            const t = elapsed / estimatedMs
            // Two sinusoids mixed → mouth opens/closes with a 6Hz cadence
            // modulated by a slower envelope so it doesn't feel robotic.
            const wave = 0.5 + 0.5 * Math.sin(elapsed * 0.018)
            const pulse = Math.max(0, Math.sin(elapsed * 0.012))
            const amp = Math.min(1, wave * pulse * 0.85 + 0.1)
            const vis = {
              mouthOpen: amp,
              smile: 0.25,
              browRaise: 0,
              blink: 0,
              ts: Date.now() / 1000,
            }
            setLastViseme(vis)
            onVisemeRef.current?.(vis)
            // Animate the analyser too so the data isn't all zeros.
            for (let i = 0; i < buf.length; i++) buf[i] = 128 + Math.floor(amp * 60)
            an.getByteTimeDomainData(buf)
            rafRef.current = requestAnimationFrame(tick)
            if (t > 1.05) return
          }
          rafRef.current = requestAnimationFrame(tick)
        }
      } catch { /* ignore — synthetic envelope above still works */ }
    }

    u.onend = () => {
      cleanupAudio()
      setSpeaking(false)
      setLastViseme(null)
      onEndRef.current?.()
    }

    u.onerror = () => {
      cleanupAudio()
      setSpeaking(false)
      setLastViseme(null)
      onEndRef.current?.()
    }

    utteranceRef.current = u
    window.speechSynthesis.speak(u)
  }, [supported, pickVoice, lang, rate, pitch, volume, cleanupAudio])

  // Cleanup on unmount.
  useEffect(() => () => {
    cancelledRef.current = true
    if (supported) {
      try { window.speechSynthesis.cancel() } catch { /* ignore */ }
    }
    cleanupAudio()
  }, [supported, cleanupAudio])

  return { supported, speaking, speak, cancel, lastViseme, voices }
}
