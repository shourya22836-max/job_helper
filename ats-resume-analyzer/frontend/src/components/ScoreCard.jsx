export default function ScoreCard({ score }) {
  const clamped = Math.max(0, Math.min(100, Math.round(score || 0)))
  const color = clamped >= 75 ? '#10b981' : clamped >= 50 ? '#f59e0b' : '#ef4444'
  const label = clamped >= 75 ? 'Strong match' : clamped >= 50 ? 'Decent match' : 'Weak match'

  // SVG circle math
  const radius = 70
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (clamped / 100) * circumference

  return (
    <div className="score-card">
      <div className="score-ring">
        <svg width="180" height="180" viewBox="0 0 180 180">
          <circle
            cx="90"
            cy="90"
            r={radius}
            stroke="#e5e7eb"
            strokeWidth="14"
            fill="none"
          />
          <circle
            cx="90"
            cy="90"
            r={radius}
            stroke={color}
            strokeWidth="14"
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 90 90)"
            style={{ transition: 'stroke-dashoffset 0.8s ease' }}
          />
          <text
            x="90"
            y="92"
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="44"
            fontWeight="700"
            fill={color}
          >
            {clamped}
          </text>
          <text
            x="90"
            y="125"
            textAnchor="middle"
            fontSize="14"
            fill="#6b7280"
          >
            / 100
          </text>
        </svg>
      </div>
      <div className="score-info">
        <div className="score-label" style={{ color }}>{label}</div>
        {score === 0 && (
          <p className="muted">Set your OPENROUTER_API_KEY in backend/.env to enable AI scoring.</p>
        )}
      </div>
    </div>
  )
}
