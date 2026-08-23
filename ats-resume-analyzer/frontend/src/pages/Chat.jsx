import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { sendChatMessage } from '../lib/api.js'
import { useHistory } from '../context/HistoryContext.jsx'

const SUGGESTED_PROMPTS = [
  'How can I improve my resume overall?',
  'What skills am I missing for this job?',
  'Rewrite my summary section.',
  'Explain my ATS score.',
  'What should I add to stand out?',
  'How do I quantify my achievements?',
]

function Message({ role, content, onCopy, onRegenerate, isLast }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true)
      onCopy?.()
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className={`chat-message chat-${role}`}>
      <div className="chat-avatar">{role === 'user' ? '🧑' : '🤖'}</div>
      <div className="chat-bubble">
        <div className="chat-text">{content}</div>
        {role === 'assistant' && (
          <div className="chat-actions">
            <button className="link-btn" onClick={handleCopy}>{copied ? 'Copied!' : 'Copy'}</button>
            {isLast && onRegenerate && (
              <button className="link-btn" onClick={onRegenerate}>Regenerate</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="chat-message chat-assistant">
      <div className="chat-avatar">🤖</div>
      <div className="chat-bubble">
        <div className="typing"><span /><span /><span /></div>
      </div>
    </div>
  )
}

export default function Chat() {
  const { current } = useHistory()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const scrollerRef = useRef(null)

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
  }, [messages, loading])

  const submit = async (text, regenerateIndex = null) => {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    setError(null)

    let next
    if (regenerateIndex !== null) {
      // Truncate everything from the regenerated assistant message onward
      next = messages.slice(0, regenerateIndex)
    } else {
      next = [...messages, { role: 'user', content: trimmed }]
    }
    setMessages(next)
    setInput('')
    setLoading(true)
    try {
      const history = next.slice(0, -1) // exclude the user message we just added
      const res = await sendChatMessage({
        message: trimmed,
        resumeText: current?.resumeText || null,
        analysis: current?.result || null,
        history,
      })
      setMessages([...next, { role: 'assistant', content: res.reply }])
    } catch (e) {
      setError(e.message || 'Chat failed')
      setMessages([...next, { role: 'assistant', content: 'Sorry — I could not reach the server.' }])
    } finally {
      setLoading(false)
    }
  }

  const handleRegenerate = (assistantIdx) => {
    const prevUser = [...messages.slice(0, assistantIdx)].reverse().find((m) => m.role === 'user')
    if (prevUser) submit(prevUser.content, assistantIdx)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(input)
    }
  }

  return (
    <div className="page chat-page">
      <header className="page-header">
        <h1>💬 AI Resume Chat</h1>
        <p className="muted">
          Ask anything about your resume, the job description, or your career. The coach uses your resume + analysis as context.
        </p>
      </header>

      {!current && (
        <div className="empty-state card">
          <p>You don't have a resume loaded. Upload one to get personalized answers.</p>
          <Link to="/analyze" className="btn btn-primary">Analyze a resume</Link>
        </div>
      )}

      {current && (
        <>
          {messages.length === 0 && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Suggested prompts</h3>
              <div className="prompt-chips">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button key={p} className="prompt-chip" onClick={() => submit(p)} disabled={loading}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="chat-window card" ref={scrollerRef}>
            {messages.length === 0 && (
              <div className="chat-empty">
                <div className="big-emoji">💬</div>
                <p className="muted">Start a conversation. I'm grounded in your resume and analysis.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <Message
                key={i}
                role={m.role}
                content={m.content}
                isLast={m.role === 'assistant' && i === messages.length - 1}
                onRegenerate={m.role === 'assistant' ? () => handleRegenerate(i) : null}
              />
            ))}
            {loading && <TypingIndicator />}
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="chat-input-row">
            <textarea
              className="chat-input"
              placeholder="Ask about your resume, skills, ATS score, or career strategy…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              disabled={loading}
            />
            <button
              className="btn btn-primary"
              onClick={() => submit(input)}
              disabled={loading || !input.trim()}
            >
              {loading ? 'Sending…' : 'Send'}
            </button>
          </div>
          <p className="muted small">Chat history is not saved between sessions in this version.</p>
        </>
      )}
    </div>
  )
}