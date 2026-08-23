import { useEffect, useMemo, useState } from 'react'
import { fetchRoles } from '../lib/api.js'

export default function IdealResumes() {
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [roleId, setRoleId] = useState('')
  const [level, setLevel] = useState('all')

  useEffect(() => {
    fetchRoles()
      .then((data) => {
        setRoles(data.roles || [])
        if (data.roles?.[0]) setRoleId(data.roles[0].id)
      })
      .catch((e) => setError(e.message || 'Failed to load roles'))
      .finally(() => setLoading(false))
  }, [])

  const filteredRoles = useMemo(() => {
    if (level === 'all') return roles
    return roles.filter((r) => r.level === level)
  }, [roles, level])

  const role = roles.find((r) => r.id === roleId)

  if (loading) return <div className="page"><div className="card status-card"><div className="spinner" /><p>Loading roles…</p></div></div>
  if (error) return <div className="page"><div className="card error"><strong>Couldn't load roles</strong><p>{error}</p></div></div>

  return (
    <div className="page">
      <header className="page-header">
        <h1>🎯 Ideal Resumes</h1>
        <p className="muted">
          Educational reference showing what a strong resume looks like for each role at each experience level.
        </p>
      </header>

      <div className="disclaimer">
        <strong>Heads up:</strong> This is <em>guidance, not a guarantee of employment</em>.
        Real resumes vary by industry, company, and individual background. Use this as a starting point, not a template.
      </div>

      <div className="card filter-bar">
        <div className="filter-group">
          <label className="form-label">Role</label>
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="select">
            {filteredRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name} ({r.level})</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label className="form-label">Experience level</label>
          <div className="chip-grid">
            {['all', 'entry', 'mid', 'senior'].map((l) => (
              <button
                type="button"
                key={l}
                className={`chip ${level === l ? 'chip-active' : ''}`}
                onClick={() => setLevel(l)}
              >
                {l === 'all' ? 'All' : l[0].toUpperCase() + l.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!role ? (
        <div className="card empty-state"><p>Pick a role above to see its ideal structure.</p></div>
      ) : (
        <div className="results">
          <section className="card hero-card">
            <div className="hero-row">
              <div>
                <h2 style={{ marginTop: 0 }}>{role.name}</h2>
                <p className="muted"><strong>{role.category}</strong> · {role.level[0].toUpperCase() + role.level.slice(1)} level</p>
              </div>
              <span className="badge">{role.ideal_length_words[0]}–{role.ideal_length_words[1]} words</span>
            </div>
            <p>{role.description}</p>
          </section>

          <div className="grid-2">
            <div className="card">
              <h3>Recommended sections</h3>
              <ul className="sections-checklist">
                {role.recommended_sections.map((s) => (
                  <li key={s}>✓ {s[0].toUpperCase() + s.slice(1)}</li>
                ))}
              </ul>
            </div>
            <div className="card">
              <h3>Core skills</h3>
              <div className="pills">
                {role.core_skills.map((s) => <span key={s} className="pill pill-success">{s}</span>)}
              </div>
              {role.bonus_skills?.length > 0 && (
                <>
                  <h3 style={{ marginTop: 16 }}>Bonus skills</h3>
                  <div className="pills">
                    {role.bonus_skills.map((s) => <span key={s} className="pill pill-warning">{s}</span>)}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <h3>🔑 Keywords to weave through your resume</h3>
            <p className="muted small">
              ATS systems scan for these. Weave them naturally into experience bullets and your summary.
            </p>
            <div className="pills">
              {role.keywords.map((k) => <span key={k} className="pill">{k}</span>)}
            </div>
          </div>

          <div className="card example-card">
            <h3>📝 Example summary</h3>
            <p className="example-text">{role.example_summary}</p>
          </div>

          <div className="card">
            <h3>💪 Strong bullet-point examples</h3>
            <p className="muted small">
              Each bullet follows the pattern: <strong>[Action verb] + [what you did] + [quantified impact]</strong>.
            </p>
            <ol className="bullets-list">
              {role.example_bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ol>
          </div>

          <div className="card">
            <h3>🛠️ Project ideas</h3>
            <div className="project-grid">
              {role.project_ideas.map((p, i) => (
                <div key={i} className="project-card">
                  <div className="project-emoji">💡</div>
                  <div>{p}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}