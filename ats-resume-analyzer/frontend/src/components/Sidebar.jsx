import { NavLink } from 'react-router-dom'

const NAV = [
  { to: '/', label: 'Dashboard', icon: '🏠', end: true },
  { to: '/analyze', label: 'Analyze Resume', icon: '🔍' },
  { to: '/chat', label: 'AI Resume Chat', icon: '💬' },
  { to: '/improver', label: 'Resume Improver', icon: '✨' },
  { to: '/ideal', label: 'Ideal Resumes', icon: '🎯' },
  { to: '/matcher', label: 'Job Role Match', icon: '🧭' },
  { to: '/compare', label: 'Compare', icon: '⚖️' },
  { to: '/interview', label: 'Interview', icon: '🎤' },
  { to: '/history', label: 'History', icon: '🕒' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
]

export default function Sidebar({ open, onClose }) {
  return (
    <>
      <div className={`sidebar-overlay ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo-mark">📌</div>
          <div>
            <div className="sidebar-title">AI Resume Assistant</div>
            <div className="sidebar-sub">ATS + career coaching</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              onClick={onClose}
            >
              <span className="sidebar-icon" aria-hidden>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <p className="muted small">
            Your resume is deleted immediately after analysis. History stays in your browser.
          </p>
        </div>
      </aside>
    </>
  )
}
