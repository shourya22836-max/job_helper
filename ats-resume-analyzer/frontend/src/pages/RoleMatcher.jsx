import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchRoles, roleMatch } from '../lib/api.js'
import { useHistory } from '../context/HistoryContext.jsx'

function SparkScore({ score }) {
  const clamped = Math.max(0, Math.min(100, score || 0))
  const color = clamped >= 75 ? '#10b981' : clamped >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <div className="match-score">
      <span className="match-score-num" style={{ color }}>{clamped}</span>
      <span className="match-score-max">/100</span>
    </div>
  )
}

export default function RoleMatcher() {
  const { current } = useHistory()
  const [roles, setRoles] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [matches, setMatches] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchRoles().then((d) => setRoles(d.roles || [])).catch((e) => setError(e.message))
  }, [])

  const toggle = (id) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const onCompare = async (e) => {
    e?.preventDefault?.()
    if (!current?.resumeText) {
      setError('No resume loaded. Analyze a resume first.')
      return
    }
    if (selected.size === 0) { setError('Pick at least one role to compare.'); return }
    setError(null)
    setLoading(true)
    setMatches(null)
    try {
      const res = await roleMatch({ resumeText: current.resumeText, roleIds: Array.from(selected) })
      // Sort by score descending
      res.matches.sort((a, b) => b.score - a.score)
      setMatches(res.matches)
    } catch (e) {
      setError(e.message || 'Match failed.')
    } finally {
      setLoading(false)
    }
  }

  const grouped = roles.reduce((acc, r) => {
    acc[r.category] = acc[r.category] || []
    acc[r.category].push(r)
    return acc
  }, {})

  return (
    <div className="page">
      <header className="page-header">
        <h1>🧭 Job Role Match</h1>
        <p className="muted">
          See how well your resume fits many roles at once, with reasoning and the gaps to close.
        </p>
      </header>

      {!current && (
        <div className="empty-state card">
          <p>You need a resume loaded to match against roles.</p>
          <Link to="/analyze" className="btn btn-primary">Analyze a resume</Link>
        </div>
      )}

      {current && (
        <>
          <form className="card form" onSubmit={onCompare}>
            <div className="form-row">
              <label className="form-label">Pick roles to compare ({selected.size} selected)</label>
              {Object.entries(grouped).map(([cat, list]) => (
                <div key={cat} className="role-category">
                  <div className="role-category-title">{cat}</div>
                  <div className="chip-grid">
                    {list.map((r) => (
                      <button
                        type="button"
                        key={r.id}
                        className={`chip ${selected.has(r.id) ? 'chip-active' : ''}`}
                        onClick={() => toggle(r.id)}
                      >
                        {r.name} <span className="muted">· {r.level}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="btn btn-primary" disabled={loading || selected.size === 0}>
              {loading ? 'Matching…' : `Match ${selected.size} role${selected.size === 1 ? '' : 's'} →`}
            </button>
          </form>

          {loading && <div className="card status-card"><div className="spinner" /><p>Matching across {selected.size} roles…</p></div>}

          {matches && !loading && (
            <div className="results">
              {matches.map((m) => (
                <article key={m.role_id} className="card match-card">
                  <div className="match-card-header">
                    <div>
                      <h3 style={{ margin: 0 }}>{m.role_name}</h3>
                      <p className="muted small" style={{ margin: '4px 0 0' }}>{m.reasoning}</p>
                    </div>
                    <SparkScore score={m.score} />
                  </div>
                  <div className="grid-2">
                    <div>
                      <div className="muted small">Matched skills</div>
                      {m.matched_skills.length === 0 ? <em className="muted small">None</em> : (
                        <div className="pills">
                          {m.matched_skills.map((s) => <span key={s} className="pill pill-success">{s}</span>)}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="muted small">Missing skills</div>
                      {m.missing_skills.length === 0 ? <em className="muted small">None</em> : (
                        <div className="pills">
                          {m.missing_skills.map((s) => <span key={s} className="pill pill-danger">{s}</span>)}
                        </div>
                      )}
                    </div>
                  </div>
                  {m.missing_keywords?.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div className="muted small">Missing keywords</div>
                      <div className="pills">
                        {m.missing_keywords.map((k) => <span key={k} className="pill pill-warning">{k}</span>)}
                      </div>
                    </div>
                  )}
                  <div className="btn-row" style={{ marginTop: 12 }}>
                    <Link to={`/compare?role=${m.role_id}`} className="btn">See detailed comparison</Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}