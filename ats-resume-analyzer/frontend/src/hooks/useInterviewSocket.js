import { useEffect, useRef, useState, useCallback } from 'react'

// Owns the WebSocket connection to /api/interview/ws/{interviewId} and
// captures the local microphone into 16-kHz mono Int16 PCM frames.
//
// Returns:
//   { status, captions, currentQuestion, questionIndex, totalQuestions,
//     aiThinking, aiSpeaking, error, start, sendText, sendPcm, pause, resume, end }
//
// `captions` is an array of { role, text, final, ts } events.

const SAMPLE_RATE = 16000
const PCM_FRAME_MS = 100
const PCM_FRAME_SAMPLES = (SAMPLE_RATE * PCM_FRAME_MS) / 1000 // 1600

export function useInterviewSocket() {
  const [status, setStatus] = useState('idle') // idle | connecting | ready | ended | error
  const [captions, setCaptions] = useState([])
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [questionIndex, setQuestionIndex] = useState(0)
  const [totalQuestions, setTotalQuestions] = useState(0)
  const [aiThinking, setAiThinking] = useState(false)
  const [aiSpeaking, setAiSpeaking] = useState(false)
  const [error, setError] = useState(null)

  const wsRef = useRef(null)
  const audioCtxRef = useRef(null)
  const processorRef = useRef(null)
  const sourceRef = useRef(null)
  const streamRef = useRef(null)
  const pausedRef = useRef(false)
  const lastFinalKeyRef = useRef(null)
  const captionListenersRef = useRef(new Set())

  const subscribeCaptions = useCallback((fn) => {
    captionListenersRef.current.add(fn)
    return () => captionListenersRef.current.delete(fn)
  }, [])

  const pushCaption = useCallback((cap) => {
    setCaptions((prev) => {
      const last = prev[prev.length - 1]
      // Merge consecutive interim captions from the same role.
      if (
        cap.role === last?.role &&
        cap.final === false &&
        last?.final === false
      ) {
        const next = prev.slice(0, -1)
        return [...next, cap]
      }
      return [...prev, cap]
    })
    captionListenersRef.current.forEach((fn) => {
      try { fn(cap) } catch { /* ignore */ }
    })
  }, [])

  const stopAudioCapture = useCallback(() => {
    try {
      if (processorRef.current) {
        processorRef.current.disconnect()
        processorRef.current.onaudioprocess = null
        processorRef.current = null
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect()
        sourceRef.current = null
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {})
        audioCtxRef.current = null
      }
    } catch (e) {
      console.warn('stopAudioCapture error', e)
    }
  }, [])

  const sendControl = useCallback((payload) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(payload))
    } catch (e) {
      console.warn('send control failed', e)
    }
  }, [])

  const start = useCallback(async ({ interviewId, config }) => {
    setStatus('connecting')
    setError(null)
    setCaptions([])
    setCurrentQuestion('')
    setQuestionIndex(0)
    setTotalQuestions(0)
    setAiThinking(false)
    setAiSpeaking(false)
    pausedRef.current = false

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.host
    const url = `${proto}://${host}/api/interview/ws/${interviewId}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: 'config', ...config }))
      setStatus('ready')

      // Start mic capture → PCM frames
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        streamRef.current = stream

        const AudioCtx = window.AudioContext || window.webkitAudioContext
        const audioCtx = new AudioCtx({ sampleRate: SAMPLE_RATE })
        audioCtxRef.current = audioCtx
        const source = audioCtx.createMediaStreamSource(stream)
        sourceRef.current = source

        // Use ScriptProcessor for broad browser support. AudioWorklet would be better
        // for latency, but ScriptProcessor works everywhere.
        const processor = audioCtx.createScriptProcessor(2048, 1, 1)
        processorRef.current = processor
        let pcmBuffer = new Int16Array(0)

        processor.onaudioprocess = (e) => {
          if (pausedRef.current) return
          if (ws.readyState !== WebSocket.OPEN) return
          const input = e.inputBuffer.getChannelData(0)
          // Convert Float32 → Int16
          const int16 = new Int16Array(input.length)
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]))
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
          }
          // Append to rolling buffer, send complete PCM_FRAME_SAMPLES chunks.
          const merged = new Int16Array(pcmBuffer.length + int16.length)
          merged.set(pcmBuffer, 0)
          merged.set(int16, pcmBuffer.length)
          pcmBuffer = merged
          while (pcmBuffer.length >= PCM_FRAME_SAMPLES) {
            const frame = pcmBuffer.slice(0, PCM_FRAME_SAMPLES)
            pcmBuffer = pcmBuffer.slice(PCM_FRAME_SAMPLES)
            try {
              ws.send(frame.buffer)
            } catch (e) {
              console.warn('ws.send pcm failed', e)
              return
            }
          }
        }
        source.connect(processor)
        processor.connect(audioCtx.destination)
      } catch (e) {
        setError(`Microphone unavailable: ${e?.message || e}`)
      }
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'question':
          setCurrentQuestion(msg.text || '')
          setQuestionIndex(msg.index ?? 0)
          setTotalQuestions(msg.total ?? 0)
          pushCaption({ role: 'assistant', text: msg.text || '', final: true, ts: Date.now() })
          setAiSpeaking(false)
          break
        case 'caption':
          if (msg.role === 'user') {
            pushCaption({ role: 'user', text: msg.text || '', final: !!msg.final, ts: Date.now() })
            if (msg.final) lastFinalKeyRef.current = msg.text
          } else if (msg.role === 'assistant') {
            pushCaption({ role: 'assistant', text: msg.text || '', final: true, ts: Date.now() })
            setAiSpeaking(true)
          }
          break
        case 'ai_thinking':
          setAiThinking(true)
          setAiSpeaking(false)
          break
        case 'ai_done':
          setAiThinking(false)
          setAiSpeaking(false)
          break
        case 'ai_timeout':
          setAiThinking(false)
          setError(msg.message || 'AI took too long to respond.')
          break
        case 'paused':
          pausedRef.current = true
          break
        case 'resumed':
          pausedRef.current = false
          break
        case 'complete':
          setStatus('ended')
          stopAudioCapture()
          break
        case 'error':
          setError(msg.message || 'Server error')
          break
        default:
          break
      }
    }

    ws.onerror = () => {
      setError('WebSocket connection failed.')
      setStatus('error')
    }

    ws.onclose = () => {
      stopAudioCapture()
      setStatus((prev) => (prev === 'ended' ? 'ended' : prev === 'error' ? 'error' : 'ended'))
    }
  }, [pushCaption, stopAudioCapture])

  const sendText = useCallback((text) => {
    sendControl({ type: 'text', text })
  }, [sendControl])

  const sendPcm = useCallback((int16) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(int16.buffer) } catch (e) { console.warn(e) }
  }, [])

  const pause = useCallback(() => {
    pausedRef.current = true
    sendControl({ type: 'pause' })
  }, [sendControl])

  const resume = useCallback(() => {
    pausedRef.current = false
    sendControl({ type: 'resume' })
  }, [sendControl])

  const end = useCallback(() => {
    sendControl({ type: 'end' })
    stopAudioCapture()
    setStatus('ended')
  }, [sendControl, stopAudioCapture])

  useEffect(() => {
    return () => {
      stopAudioCapture()
      try { wsRef.current?.close() } catch { /* ignore */ }
    }
  }, [stopAudioCapture])

  return {
    status,
    captions,
    currentQuestion,
    questionIndex,
    totalQuestions,
    aiThinking,
    aiSpeaking,
    error,
    subscribeCaptions,
    start,
    sendText,
    sendPcm,
    pause,
    resume,
    end,
  }
}