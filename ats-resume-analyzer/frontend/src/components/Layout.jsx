import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import { useHistory } from '../context/HistoryContext.jsx'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { current, settings } = useHistory()

  // Mirror settings.theme onto <html data-theme="..."> so the dark-mode CSS
  // tokens in styles.css take effect. Removing the attribute (instead of
  // setting "light") lets the bare `:root` rules win for the default theme.
  useEffect(() => {
    const root = document.documentElement
    if (settings?.theme === 'dark') {
      root.dataset.theme = 'dark'
    } else {
      delete root.dataset.theme
    }
  }, [settings?.theme])

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
