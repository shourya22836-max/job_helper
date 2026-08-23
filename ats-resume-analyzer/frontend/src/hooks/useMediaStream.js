import { useEffect, useState } from 'react'

// Wraps navigator.mediaDevices.getUserMedia for the local mic + cam stream.
// Returns { stream, error, ready }. Streams are auto-stopped on unmount.
export function useMediaStream({ audio = true, video = true } = {}) {
  const [stream, setStream] = useState(null)
  const [error, setError] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let s = null
    async function startStream() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Browser does not support microphone/camera access.')
        setReady(true)
        return
      }
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: audio
            ? {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            : false,
          video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        setStream(s)
        setReady(true)
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || 'Microphone/camera permission was denied.')
          setReady(true)
        }
      }
    }
    startStream()
    return () => {
      cancelled = true
      if (s) s.getTracks().forEach((t) => t.stop())
    }
  }, [audio, video])

  return { stream, error, ready }
}