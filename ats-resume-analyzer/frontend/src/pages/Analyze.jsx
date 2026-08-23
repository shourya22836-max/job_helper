import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { analyzeResume } from '../lib/api.js'
import { useHistory } from '../context/HistoryContext.jsx'

const ACCEPTED = '.pdf,.docx,.txt'

export default function Analyze() {
  const inputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [jd, setJd] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const { addAnalysis } = useHistory()
  const nav = useNavigate()

  const handleFile = (selected) => {
    setError(null)
    if (!selected) return
    const name = selected.name.toLowerCase()
    if (!name.endsWith('.pdf') && !name.endsWith('.docx') && !name.endsWith('.txt')) {
      setError('Please upload a PDF, DOCX, or TXT file.')
      return
    }
    if (selected.size > 5 * 1024 * 1024) {
      setError('File too large. Max 5 MB.')
      return
    }
    setFile(selected)
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!file) return setError('Please select a resume file.')
    if (!jd.trim() || jd.trim().length < 20) return setError('Please paste the full job description (a few sentences).')
    setError(null)
    setLoading(true)
    try {
      const result = await analyzeResume(file, jd.trim())
      // Attach the resume text we sent (will be saved with the history entry)
      const id = addAnalysis({ fileName: file.name, jdText: jd, result: { ...result, _fileSize: file.size } })
      // The resume text isn't returned by the API; the user must upload again to use it elsewhere
      // We still save a minimal entry that other pages can read.
      nav(`/results/${id}`)
    } catch (err) {
      setError(err.message || 'Analysis failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Analyze Resume</h1>
        <p className="muted">Upload a resume (PDF, DOCX, or TXT) and paste the job description.</p>
      </header>

      <form className="card form" onSubmit={onSubmit}>
        <div className="form-row">
          <label className="form-label">1. Upload your resume</label>
          <div
            className={`dropzone ${dragOver ? 'over' : ''} ${file ? 'has-file' : ''}`}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]) }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              hidden
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            {file ? (
              <div className="file-info">
                <div className="file-icon">📄</div>
                <div>
                  <div className="file-name">{file.name}</div>
                  <div className="file-size muted">{(file.size / 1024).toFixed(1)} KB</div>
                </div>
                <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); setFile(null) }}>Remove</button>
              </div>
            ) : (
              <div className="dropzone-empty">
                <div className="upload-icon">⬆️</div>
                <div><strong>Click to upload</strong> or drag &amp; drop</div>
                <div className="muted small">PDF, DOCX, or TXT (max 5 MB)</div>
              </div>
            )}
          </div>
        </div>

        <div className="form-row">
          <label className="form-label">2. Paste the job description</label>
          <textarea
            className="jd-input"
            placeholder="Paste the full job description here — responsibilities, requirements, nice-to-haves…"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            rows={10}
            disabled={loading}
          />
          <div className="char-count muted small">{jd.length.toLocaleString()} characters</div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Analyzing…' : 'Analyze my resume →'}
        </button>
      </form>

      <p className="muted small">
        After analysis you can chat with an AI coach about the result, rewrite sections, and compare against ideal roles.
      </p>
    </div>
  )
}
