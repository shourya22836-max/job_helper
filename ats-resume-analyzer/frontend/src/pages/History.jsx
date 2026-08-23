import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useHistory } from '../context/HistoryContext.jsx'
import { exportAll, getResumeTextFor } from '../lib/storage.js'

function Sparkline({ scores }) {
  if (!scores || scores.length < 2) return null
  const w = 240, h = 40, pad = 4
  const min = Math.min(...scores), max = Math.max(...scores)
  const range = Math.max(max - min, 1)
  const stepX = (w - pad * 2) / (scores.length - 1)
  const points = scores.map((s, i) => {
    const x = pad + i * stepX
    const y = h - pad - ((s - min) / range) * (h - pad * 2)
    return `${x},${y}`
  })
  const lineColor = scores[scores.length - 1] >= scores[0] ? '#10b981' : '#ef4444'
  return (
    <svg width={w} height={h} className="sparkline" aria-label="Score trend">
      <polyline points={points.join(' ')} fill="none" stroke={lineColor} strokeWidth="2" />
      {scores.map((s, i) => {
        const x = pad + i * stepX
        const y = h - pad - ((s - min) / range) * (h - pad * 2)
        return <circle key={i} cx={x} cy={y} r="2.5" fill={lineColor} />
      })}
    </svg>
  )
}

export default function History() {
  const { history, removeAnalysis, clearAll, restoreAnalysis } = useHistory()
  const nav = useNavigate()
  const [confirmClear, setConfirmClear] = useState(false)
  const [compareIds, setCompareIds] = useState([])

  const sorted = useMemo(() => [...history].sort((a, b) => b.timestamp - a.timestamp), [history])
  const scores = useMemo(() => [...history].sort((a, b) => a.timestamp - b.timestamp).map((e) => e.score), [history])

  const toggleCompare = (id) => {
    setCompareIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2))
  }

  const onExport = () => {
    const data = exportAll()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `resume-history-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const onView = (entry) => {
    if (!getResumeTextFor(entry.id)) {
      // Restore from history (sets as current)
      restoreAnalysis(entry.id)
    }
    nav(`/results/${entry.id}`)
  }

  if (history.length === 0) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>🕒 History</h1>
        </header>
        <div className="empty-state card">
          <p>No analyses yet. Once you analyze a resume, it'll show up here.</p>
          <Link to="/analyze" className="btn btn-primary">Analyze a resume</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>🕒 History</h1>
        <p className="muted">All your analyses, stored locally in your browser.</p>
      </header>

      {scores.length >= 2 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Score trend</h3>
          <Sparkline scores={scores} />
          <p className="muted small">
            {scores[0]} → {scores[scores.length - 1]} over {scores.length} analyses
          </p>
        </div>
      )}

      <div className="card-header-row">
        <h3 style={{ margin: 0 }}>All analyses ({sorted.length})</h3>
        <div className="btn-row">
          {compareIds.length === 2 && (
            <Link to={`/compare?ids=${compareIds.join(',')}`} className="btn btn-primary">Compare 2 selected</Link>
          )}
          <button className="btn" onClick={onExport}>Export JSON</button>
          <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>Clear all</button>
        </div>
      </div>

      <ul className="history-list">
        {sorted.map((e) => (
          <li key={e.id} className="card history-item">
            <div className="history-item-main">
              <div className="history-item-title">
                <input
                  type="checkbox"
                  checked={compareIds.includes(e.id)}
                  onChange={() => toggleCompare(e.id)}
                  aria-label={`Select ${e.fileName} for compare`}
                />
                <strong>{e.fileName}</strong>
                <span className="score-pill small">{e.score}/100</span>
              </div>
              <p className="muted small" style={{ margin: '4px 0' }}>
                {new Date(e.timestamp).toLocaleString()}
              </p>
              {e.jdSnippet && (
                <p className="jd-snippet" title={e.jdSnippet}>
                  JD: {e.jdSnippet}
                </p>
              )}
            </div>
            <div className="btn-row">
              <button className="btn" onClick={() => onView(e)}>View</button>
              <button className="btn" onClick={() => { restoreAnalysis(e.id); nav('/chat') }}>Chat</button>
              <button className="btn btn-danger" onClick={() => removeAnalysis(e.id)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>

      <p className="muted small">{compareIds.length}/2 selected for comparison.</p>

      {confirmClear && (
        <div className="modal-overlay" onClick={() => setConfirmClear(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Clear all history?</h3>
            <p>This will permanently delete all {history.length} analysis{history.length === 1 ? '' : 'es'} from your browser. This cannot be undone.</p>
            <div className="btn-row">
              <button className="btn" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { clearAll(); setConfirmClear(false); setCompareIds([]) }}>
                Yes, delete all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}