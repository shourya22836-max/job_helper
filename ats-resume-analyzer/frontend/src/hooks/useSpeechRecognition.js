// Browser Web Speech API wrapper for live interview STT.
//
// - Uses window.SpeechRecognition (Chromium) or window.webkitSpeechRecognition
//   (older Safari). On unsupported browsers (Firefox, iOS Safari) we report
//   unsupported=true so the UI can fall back to the text input that's already
//   in Interview.jsx.
// - Streams interim + final transcripts back via the onResult callback so the
//   page can mirror them in the transcript list, just like Deepgram captions.
// - Designed to be paused/resumed around agent turns (avoid feeding STT output
//   back as user input while the AI is speaking).
//
// Returns:
//   {
//     supported,       // boolean
//     listening,       // boolean
//     error,           // string | null
//     start(),         // begin recognition
//     stop(),          // stop recognition (fires onend → final result)
//     toggle(),        // start or stop
//     interim,         // current interim (unfinalized) transcript
//     reset(),         // clear interim text without stopping
//   }
//
// Callbacks:
//   onResult({ text, final, ts })
//   onError(message)
//
// Usage:
//   const { supported, start, stop, interim } = useSpeechRecognition({
//     lang: 'en-US',
//     onResult: ({ text, final }) => ...,
//   })

import { useCallback, useEffect, useRef, useState } from 'react'

function getCtor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

export function useSpeechRecognition({
  lang = 'en-US',
  interimResults = true,
  continuous = false,
  onResult,
  onError,
} = {}) {
  const [supported] = useState(() => Boolean(getCtor()))
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)
  const [interim, setInterim] = useState('')

  const recogRef = useRef(null)
  const onResultRef = useRef(onResult)
  const onErrorRef = useRef(onError)

  // Keep latest callback refs so we don't restart recognition when they change.
  useEffect(() => { onResultRef.current = onResult }, [onResult])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  const start = useCallback(() => {
    if (!supported) {
      const msg = 'Speech recognition is not supported in this browser.'
      setError(msg)
      onErrorRef.current?.(msg)
      return
    }
    if (listening) return

    // Stop any previous instance cleanly.
    try { recogRef.current?.abort?.() } catch { /* ignore */ }

    const Ctor = getCtor()
    const r = new Ctor()
    r.lang = lang
    r.interimResults = interimResults
    r.continuous = continuous
    r.maxAlternatives = 1

    r.onresult = (e) => {
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        const text = res[0]?.transcript || ''
        if (res.isFinal) {
          onResultRef.current?.({ text: text.trim(), final: true, ts: Date.now() / 1000 })
          setInterim('')
        } else {
          interimText += text
        }
      }
      if (interimText) setInterim(interimText)
    }

    r.onerror = (e) => {
      const msg = e?.error || 'speech recognition error'
      // 'no-speech' / 'aborted' are routine — don't surface them as user-facing errors.
      if (msg !== 'no-speech' && msg !== 'aborted') {
        setError(msg)
        onErrorRef.current?.(msg)
      }
      setListening(false)
    }

    r.onend = () => {
      setListening(false)
      setInterim('')
    }

    recogRef.current = r
    setError(null)
    try {
      r.start()
      setListening(true)
    } catch (e) {
      const msg = e?.message || 'Failed to start speech recognition.'
      setError(msg)
      onErrorRef.current?.(msg)
      setListening(false)
    }
  }, [supported, lang, interimResults, continuous, listening])

  const stop = useCallback(() => {
    try { recogRef.current?.stop?.() } catch { /* ignore */ }
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  const reset = useCallback(() => setInterim(''), [])

  // Always tear down on unmount.
  useEffect(() => {
    return () => {
      try { recogRef.current?.abort?.() } catch { /* ignore */ }
    }
  }, [])

  return { supported, listening, error, interim, start, stop, toggle, reset }
}
