import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useHistory } from '../context/HistoryContext.jsx'
import { getHealth } from '../lib/api.js'
import { exportAll } from '../lib/storage.js'

const MODEL_OPTIONS = [
  { id: '', label: 'Backend default (from .env)' },
  { id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o mini (recommended, cheap)' },
  { id: 'openai/gpt-4o', label: 'OpenAI GPT-4o (higher quality)' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Anthropic Claude 3.5 Sonnet' },
  { id: 'google/gemini-2.0-flash-exp', label: 'Google Gemini 2.0 Flash (free tier)' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Meta Llama 3.3 70B' },
]

export default function Settings() {
  const { history, clearAll, settings, updateSettings } = useHistory()
  const [health, setHealth] = useState(null)
  const [healthErr, setHealthErr] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    getHealth().then(setHealth).catch((e) => setHealthErr(e.message))
  }, [])

  const onExport = () => {
    const data = exportAll()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `resume-assistant-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>⚙️ Settings</h1>
      </header>

      <div className="card">
        <h3>API key</h3>
        <p className="muted small">
          Your OpenRouter API key is stored in <code>backend/.env</code> on the server. It's never exposed to the browser or this UI.
        </p>
        {healthErr ? (
          <div className="status-line error">Cannot reach backend: {healthErr}</div>
        ) : health ? (
          <div className="status-line">
            <span className={`dot ${health.api_key_set ? 'dot-success' : 'dot-warn'}`} />
            {health.api_key_set
              ? <><strong>API key detected</strong> — model: {health.model}</>
              : <>API key not set. Add <code>OPENROUTER_API_KEY</code> to <code>backend/.env</code>.</>}
          </div>
        ) : (
          <div className="status-line muted">Checking…</div>
        )}
      </div>

      <div className="card">
        <h3>Model preference</h3>
        <p className="muted small">
          This is a UI preference only — the backend reads its model from <code>.env</code>. Use this to remember which model you prefer.
        </p>
        <select
          className="select"
          value={settings.defaultModel || ''}
          onChange={(e) => updateSettings({ defaultModel: e.target.value })}
        >
          {MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>

      <div className="card">
        <h3>Theme</h3>
        <div className="chip-grid">
          {['light', 'dark'].map((t) => (
            <button
              key={t}
              type="button"
              className={`chip ${settings.theme === t ? 'chip-active' : ''}`}
              onClick={() => updateSettings({ theme: t })}
            >
              {t === 'light' ? '☀️' : '🌙'} {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <p className="muted small">Dark mode is a preview — most pages support it.</p>
      </div>

      <div className="card">
        <h3>Data</h3>
        <p className="muted">
          You have {history.length} saved analys{history.length === 1 ? 'is' : 'es'} in this browser.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={onExport}>Export all data as JSON</button>
          <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>Clear all history</button>
        </div>
      </div>

      <div className="card">
        <h3>About</h3>
        <p className="muted">
          AI Resume Assistant — an educational tool for students learning how ATS recruitment works.
        </p>
        <Link to="/analyze" className="btn btn-primary">Back to Analyze</Link>
      </div>

      {confirmClear && (
        <div className="modal-overlay" onClick={() => setConfirmClear(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Clear all history?</h3>
            <p>This will permanently delete all {history.length} analysis{history.length === 1 ? '' : 'es'} from your browser. This cannot be undone.</p>
            <div className="btn-row">
              <button className="btn" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { clearAll(); setConfirmClear(false) }}>
                Yes, delete everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
  