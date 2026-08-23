import { Link } from 'react-router-dom'
import { useHistory } from '../context/HistoryContext.jsx'

export default function Dashboard() {
  const { current, history } = useHistory()
  const recent = history.slice(0, 5)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Welcome 👋</h1>
        <p className="muted">
          Upload a resume to get ATS feedback, chat with an AI career coach, rewrite sections, and compare against ideal roles.
        </p>
      </header>

      <section className="quick-actions">
        <Link to="/analyze" className="action-card">
          <div className="action-icon">🔍</div>
          <h3>Analyze a resume</h3>
          <p className="muted small">Upload + paste a JD. Get an ATS score, missing skills, and improvement suggestions.</p>
        </Link>
        <Link to="/chat" className="action-card">
          <div className="action-icon">💬</div>
          <h3>AI Resume Chat</h3>
          <p className="muted small">Ask anything about your resume or career — grounded in your actual text.</p>
        </Link>
        <Link to="/improver" className="action-card">
          <div className="action-icon">✨</div>
          <h3>Improve a section</h3>
          <p className="muted small">Rewrite Summary, Experience, Projects, or Skills in 5 styles.</p>
        </Link>
        <Link to="/ideal" className="action-card">
          <div className="action-icon">🎯</div>
          <h3>Ideal Resumes</h3>
          <p className="muted small">Educational guide: structure, skills, keywords, and example bullets per role.</p>
        </Link>
        <Link to="/matcher" className="action-card">
          <div className="action-icon">🧭</div>
          <h3>Job Role Match</h3>
          <p className="muted small">See which roles fit you best with reasoning and gaps.</p>
        </Link>
        <Link to="/compare" className="action-card">
          <div className="action-icon">⚖️</div>
          <h3>Compare with a role</h3>
          <p className="muted small">Match / missing skills, sections, and prioritized recommendations.</p>
        </Link>
        <Link to="/interview" className="action-card">
          <div className="action-icon">🎤</div>
          <h3>AI Mock Interview</h3>
          <p className="muted small">Live voice interview with an AI. Real-time captions + detailed scorecard.</p>
        </Link>
      </section>

      {current && (
        <section className="card current-card">
          <div className="current-card-header">
            <div>
              <h3 style={{ margin: 0 }}>Currently loaded</h3>
              <p className="muted small" style={{ margin: '4px 0 0' }}>{current.fileName}</p>
            </div>
            <div className="score-pill">{current.score}/100</div>
          </div>
          {current.result?.summary && <p style={{ marginTop: 12 }}>{current.result.summary}</p>}
          <div className="btn-row" style={{ marginTop: 16 }}>
            <Link to={`/results/${current.id}`} className="btn btn-primary">View full analysis</Link>
            <Link to="/chat" className="btn">Chat about this resume</Link>
            <Link to="/improver" className="btn">Improve a section</Link>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-header-row">
          <h3 style={{ margin: 0 }}>Recent analyses</h3>
          <Link to="/history" className="link-btn">View all →</Link>
        </div>
        {recent.length === 0 ? (
          <p className="muted">No analyses yet. Start by analyzing a resume.</p>
        ) : (
          <ul className="recent-list">
            {recent.map((e) => (
              <li key={e.id}>
                <Link to={`/results/${e.id}`}>
                  <span className="recent-name">{e.fileName}</span>
                  <span className="recent-score">{e.score}/100</span>
                </Link>
                <span className="muted small">{new Date(e.timestamp).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
