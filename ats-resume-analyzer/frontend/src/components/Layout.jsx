import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import { useHistory } from '../context/HistoryContext.jsx'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { current } = useHistory()

  return (
    <div className="layout">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="layout-main">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <div className="topbar-title">AI Resume Assistant</div>
          <div className="topbar-right">
            {current ? (
              <span className="topbar-chip" title="Currently loaded resume">
                ✓ {current.fileName} · {current.score}/100
              </span>
            ) : (
              <span className="topbar-chip muted">No resume loaded</span>
            )}
          </div>
        </header>
        <main className="layout-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
