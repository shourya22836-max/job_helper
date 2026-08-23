import { useState } from 'react'
import { Link } from 'react-router-dom'
import { improveSection } from '../lib/api.js'
import { useHistory } from '../context/HistoryContext.jsx'

const SECTIONS = [
  { id: 'summary', label: 'Summary', hint: '2–4 sentences at the top of your resume.' },
  { id: 'experience', label: 'Experience', hint: 'Bullets describing what you did at a role.' },
  { id: 'projects', label: 'Projects', hint: 'A project name + 1–3 bullet description.' },
  { id: 'skills', label: 'Skills', hint: 'A list or paragraph of tools/technologies.' },
]

const STYLES = [
  { id: 'professional', label: 'Professional', icon: '👔' },
  { id: 'concise', label: 'Concise', icon: '✂️' },
  { id: 'ats_friendly', label: 'ATS-friendly', icon: '🤖' },
  { id: 'achievement_focused', label: 'Achievement-focused', icon: '🏆' },
  { id: 'grammar', label: 'Grammar fix', icon: '📝' },
]

const PLACEHOLDERS = {
  summary: 'e.g. "Recent CS graduate with strong React and Python skills. Built 3 capstone projects and one open-source tool with 200+ stars."',
  experience: 'e.g. "- Built a dashboard\n- Worked on auth\n- Did code reviews"',
  projects: 'e.g. "Project: Resume Analyzer — Built with FastAPI and OpenAI. Parses PDF/DOCX, scores resumes, deployed on Vercel."',
  skills: 'e.g. "Python, React, PostgreSQL, Docker, AWS, Git, Figma"',
}

export default function Improver() {
  const { current } = useHistory()
  const [section, setSection] = useState('summary')
  const [style, setStyle] = useState('professional')
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const onSubmit = async (e) => {
    e?.preventDefault?.()
    if (!text.trim()) { setError('Please paste some text to improve.'); return }
    setError(null)
    setLoading(true)
    setResult(null)
    try {
      const res = await improveSection({
        section,
        currentText: text,
        resumeText: current?.resumeText || null,
        style,
      })
      setResult(res)
    } catch (e) {
      setError(e.message || 'Improvement failed.')
    } finally {
      setLoading(false)
    }
  }

  const copyImproved = () => {
    if (!result?.improved) return
    navigator.clipboard?.writeText(result.improved).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>✨ Resume Improver</h1>
        <p className="muted">
          Paste a section of your resume, pick a style, and get an AI-rewritten version with a rationale.
        </p>
      </header>

      <form className="card form" onSubmit={onSubmit}>
        <div className="form-row">
          <label className="form-label">1. Choose a section</label>
          <div className="chip-grid">
            {SECTIONS.map((s) => (
              <button
                type="button"
                key={s.id}
                className={`chip ${section === s.id ? 'chip-active' : ''}`}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="muted small">{SECTIONS.find((s) => s.id === section)?.hint}</p>
        </div>

        <div className="form-row">
          <label className="form-label">2. Paste your current text</label>
          <textarea
            className="jd-input"
            rows={8}
            placeholder={PLACEHOLDERS[section]}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="form-row">
          <label className="form-label">3. Pick a style</label>
          <div className="chip-grid">
            {STYLES.map((s) => (
              <button
                type="button"
                key={s.id}
                className={`chip chip-icon ${style === s.id ? 'chip-active' : ''}`}
                onClick={() => setStyle(s.id)}
              >
                <span>{s.icon}</span> {s.label}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <button type="submit" className="btn btn-primary" disabled={loading || !text.trim()}>
          {loading ? 'Rewriting…' : 'Improve →'}
        </button>
      </form>

      {loading && (
        <div className="card status-card">
          <div className="spinner" />
          <p>Rewriting your text…</p>
        </div>
      )}

      {result && !loading && (
        <div className="results">
          <div className="diff-grid">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>📥 Original</h3>
              <pre className="diff-text">{text}</pre>
            </div>
            <div className="card improved-card">
              <div className="diff-header">
                <h3 style={{ margin: 0 }}>✨ Improved</h3>
                <button className="btn" onClick={copyImproved}>{copied ? 'Copied!' : 'Copy'}</button>
              </div>
              <pre className="diff-text">{result.improved}</pre>
            </div>
          </div>
          {result.explanation && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Why these changes</h3>
              <p>{result.explanation}</p>
            </div>
          )}
        </div>
      )}

      {!current && (
        <div className="muted small">
          💡 Tip: <Link to="/analyze">Analyze a resume</Link> first so the improver has more context to work with.
        </div>
      )}
    </div>
  )
}