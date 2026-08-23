import ScoreCard from './ScoreCard.jsx'

function SkillPills({ items, variant }) {
  if (!items || items.length === 0) {
    return <p className="muted small">None detected.</p>
  }
  return (
    <div className="pills">
      {items.map((skill, i) => (
        <span key={`${variant}-${i}-${skill}`} className={`pill pill-${variant}`}>
          {skill}
        </span>
      ))}
    </div>
  )
}

function ListBlock({ title, items, emptyText }) {
  if (!items || items.length === 0) return null
  return (
    <div className="list-block">
      <h3>{title}</h3>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

export default function ResultsPanel({ result, score }) {
  if (!result) return null
  const passed = result.ats_checks?.filter((c) => c.passed).length || 0
  const total = result.ats_checks?.length || 0
  const finalScore = score ?? result.match_score ?? 0

  return (
    <div className="results">
      {result.summary && (
        <div className="summary-card">
          <p>{result.summary}</p>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>Match score</h3>
          <ScoreCard score={finalScore} />
          <p className="muted small">Based on skills, keywords, and overall alignment with the job description.</p>
        </div>

        <div className="card">
          <h3>ATS checks <span className="muted small">({passed}/{total} passed)</span></h3>
          <ul className="checks-list">
            {result.ats_checks?.map((check) => (
              <li key={check.name} className={check.passed ? 'check-pass' : 'check-fail'}>
                <span className="check-icon">{check.passed ? '✓' : '✕'}</span>
                <div>
                  <strong>{check.name}</strong>
                  <div className="check-msg">{check.message}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>✓ Skills you have</h3>
          <SkillPills items={result.matched_skills} variant="success" />
        </div>
        <div className="card">
          <h3>✗ Missing skills</h3>
          <SkillPills items={result.missing_skills} variant="danger" />
        </div>
      </div>

      {result.keywords_missing && result.keywords_missing.length > 0 && (
        <div className="card">
          <h3>🔑 Keywords from the JD missing in your resume</h3>
          <p className="muted small">
            ATS systems score resumes on exact keyword matches. Add these naturally to your
            experience and skills sections.
          </p>
          <SkillPills items={result.keywords_missing} variant="warning" />
        </div>
      )}

      <ListBlock title="💡 Suggested improvements" items={result.suggested_improvements} />
      <div className="grid-2">
        <ListBlock title="💪 Strengths" items={result.strengths} />
        <ListBlock title="⚠️ Weaknesses" items={result.weaknesses} />
      </div>

      {result.formatting_issues && result.formatting_issues.length > 0 && (
        <div className="card warning">
          <h3>📐 Formatting / ATS issues</h3>
          <ul>
            {result.formatting_issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
