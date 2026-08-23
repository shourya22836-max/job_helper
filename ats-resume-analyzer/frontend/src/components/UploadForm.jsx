import { useRef, useState } from 'react'

const ACCEPTED = '.pdf,.docx,.txt'

export default function UploadForm({ onAnalyze, status }) {
  const inputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [jobDescription, setJobDescription] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [localError, setLocalError] = useState(null)

  const isLoading = status === 'loading'

  const handleFile = (selected) => {
    setLocalError(null)
    if (!selected) return
    const name = selected.name.toLowerCase()
    if (!name.endsWith('.pdf') && !name.endsWith('.docx') && !name.endsWith('.txt')) {
      setLocalError('Please upload a PDF, DOCX, or TXT file.')
      return
    }
    if (selected.size > 5 * 1024 * 1024) {
      setLocalError('File too large. Max 5 MB.')
      return
    }
    setFile(selected)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    handleFile(e.dataTransfer.files?.[0])
  }

  const onDragOver = (e) => {
    e.preventDefault()
    setDragOver(true)
  }

  const onDragLeave = () => setDragOver(false)

  const onSubmit = (e) => {
    e.preventDefault()
    if (!file) {
      setLocalError('Please select a resume file.')
      return
    }
    if (!jobDescription.trim() || jobDescription.trim().length < 20) {
      setLocalError('Please paste the full job description (at least a few sentences).')
      return
    }
    onAnalyze({ file, jobDescription: jobDescription.trim() })
  }

  return (
    <form className="upload-form" onSubmit={onSubmit}>
      <div className="form-row">
        <label className="form-label" htmlFor="resume-input">
          1. Upload your resume
        </label>
        <div
          className={`dropzone ${dragOver ? 'over' : ''} ${file ? 'has-file' : ''}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        >
          <input
            id="resume-input"
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
                <div className="file-size">{(file.size / 1024).toFixed(1)} KB</div>
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setFile(null)
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="dropzone-empty">
              <div className="upload-icon">⬆️</div>
              <div><strong>Click to upload</strong> or drag &amp; drop</div>
              <div className="muted">PDF, DOCX, or TXT (max 5 MB)</div>
            </div>
          )}
        </div>
      </div>

      <div className="form-row">
        <label className="form-label" htmlFor="jd-input">
          2. Paste the job description
        </label>
        <textarea
          id="jd-input"
          className="jd-input"
          placeholder="Paste the full job description here — responsibilities, requirements, nice-to-haves…"
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          rows={10}
          disabled={isLoading}
        />
        <div className="char-count muted">
          {jobDescription.length.toLocaleString()} characters
        </div>
      </div>

      {localError && <div className="form-error">{localError}</div>}

      <button type="submit" className="btn btn-primary" disabled={isLoading}>
        {isLoading ? 'Analyzing…' : 'Analyze my resume →'}
      </button>
    </form>
  )
}
