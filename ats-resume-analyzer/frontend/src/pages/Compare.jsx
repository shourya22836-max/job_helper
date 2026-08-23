import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { compareResume, fetchRoles } from '../lib/api.js'
import { useHistory } from '../context/HistoryContext.jsx'

export default function Compare() {
  const { current } = useHistory()
  const [roles, setRoles] = useState([])
  const [roleId, setRoleId] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchRoles().then((d) => {
      setRoles(d.roles || [])
      if (d.roles?.[0]) setRoleId(d.roles[0].id)
    }).catch((e) => setError(e.message))
  }, [])

  const onCompare = async (e) => {
    e?.preventDefault?.()
    if (!current?.resumeText) {
      setError('No resume loaded. Analyze a resume first (resume text will be re-sent from your last analysis).')
      return
    }
    if (!roleId) return
    setError(null)
    setLoading(true)
    setResult(null)
    try {
      const r = await compareResume({ resumeText: current.resumeText, roleId, analysis: current.result })
      setResult(r)
    } catch (e) {
      setError(e.message || 'Compare failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>⚖️ Resume Comparison</h1>
        <p className="muted">
          Compare your resume against the ideal profile for a chosen role. See matched / missing skills, sections, and prioritized recommendations.
        </p>
      </header>

      {!current && (
        <div className="empty-state card">
          <p>You need a resume loaded to compare.</p>
          <Link to="/analyze" className="btn btn-primary">Analyze a resume</Link>
        </div>
      )}

      {current && (
        <>
          <form className="card form" onSubmit={onCompare}>
            <div className="form-row">
              <label className="form-label">Select a role</label>
              <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="select" disabled={loading}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.level})</option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading || !roleId}>
              {loading ? 'Comparing…' : 'Compare →'}
            </button>
          </form>

          {error && <div className="form-error">{error}</div>}

          {loading && <div className="card status-card"><div className="spinner" /><p>Comparing…</p></div>}

          {result && !loading && (
            <div className="results">
              <section className="card hero-card">
                <div className="hero-row">
                  <div>
                    <h2 style={{ margin: 0 }}>{result.role.name}</h2>
                    <p className="muted"><strong>{result.role.category}</strong> · {result.role.level}</p>
                  </div>
                  <div className="score-delta">
                    {result.ats_score_delta >= 0 ? '+' : ''}{result.ats_score_delta}
                    <span className="muted small"> vs current {result.role?.base_score ?? 0}</span>
                  </div>
                </div>
                <p>{result.role.description}</p>
              </section>

              <div className="grid-2">
                <div className="card">
                  <h3>✓ Matched skills ({result.matched_skills.length})</h3>
                  {result.matched_skills.length === 0 ? <p className="muted small">No skills matched yet.</p> : (
                    <div className="pills">
                      {result.matched_skills.map((s) => <span key={s} className="pill pill-success">{s}</span>)}
                    </div>
                  )}
                </div>
                <div className="card">
                  <h3>✗ Missing skills ({result.missing_skills.length})</h3>
                  {result.missing_skills.length === 0 ? <p className="muted small">All core skills present.</p> : (
                    <div className="pills">
                      {result.missing_skills.map((s) => <span key={s} className="pill pill-danger">{s}</span>)}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid-2">
                <div className="card">
                  <h3>🔑 Matched keywords</h3>
                  {result.matched_keywords.length === 0 ? <p className="muted small">No keywords matched.</p> : (
                    <div className="pills">
                      {result.matched_keywords.map((k) => <span key={k} className="pill pill-success">{k}</span>)}
                    </div>
                  )}
                </div>
                <div className="card">
                  <h3>🔍 Missing keywords</h3>
                  {result.missing_keywords.length === 0 ? <p className="muted small">All keywords present.</p> : (
                    <div className="pills">
                      {result.missing_keywords.map((k) => <span key={k} className="pill pill-warning">{k}</span>)}
                    </div>
                  )}
                </div>
              </div>

              {result.missing_sections?.length > 0 && (
                <div className="card warning">
                  <h3>📄 Missing recommended sections</h3>
                  <ul>
                    {result.missing_sections.map((s) => <li key={s}>{s[0].toUpperCase() + s.slice(1)}</li>)}
                  </ul>
                </div>
              )}

              {result.recommendations?.length > 0 && (
                <div className="card">
                  <h3>💡 Prioritized recommendations</h3>
                  <ol className="recommendations-list">
                    {result.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                  </ol>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}