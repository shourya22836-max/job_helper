import { Link, useParams } from 'react-router-dom'
import { useHistory } from '../context/HistoryContext.jsx'
import ResultsPanel from '../components/ResultsPanel.jsx'

export default function Results() {
  const { id } = useParams()
  const { history, restoreAnalysis } = useHistory()

  // Try history first
  let entry = history.find((e) => e.id === id)
  // If not found, attempt restore (rare — direct URL)
  if (!entry) {
    const restored = restoreAnalysis(id)
    if (restored) entry = history.find((e) => e.id === id)
  }

  if (!entry) {
    return (
      <div className="page">
        <div className="card">
          <h2>Analysis not found</h2>
          <p className="muted">It may have been deleted.</p>
          <Link to="/analyze" className="btn btn-primary">Analyze a new resume</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="results-header">
        <div>
          <h1 style={{ margin: 0 }}>{entry.fileName}</h1>
          <p className="muted small">
            {new Date(entry.timestamp).toLocaleString()}
            {entry.jdSnippet ? ` · ${entry.jdSnippet.slice(0, 80)}${entry.jdSnippet.length > 80 ? '…' : ''}` : ''}
          </p>
        </div>
        <div className="btn-row">
          <Link to="/chat" className="btn">💬 Chat</Link>
          <Link to="/improver" className="btn">✨ Improve</Link>
          <Link to="/compare" className="btn">⚖️ Compare</Link>
        </div>
      </div>
      <ResultsPanel result={entry.result} score={entry.score} />
    </div>
  )
}
