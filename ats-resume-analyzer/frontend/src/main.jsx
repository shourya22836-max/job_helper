import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// Apply the persisted theme before React mounts so a page reload in dark mode
// doesn't flash light styles. Mirrors the same conditional Layout.jsx uses.
try {
  const raw = localStorage.getItem('ra:settings')
  const theme = raw ? (JSON.parse(raw)?.theme) : null
  if (theme === 'dark') {
    document.documentElement.dataset.theme = 'dark'
  }
} catch {
  /* localStorage unavailable — fall through to the default light theme */
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
