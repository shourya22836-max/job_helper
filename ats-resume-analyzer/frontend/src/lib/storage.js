// LocalStorage wrappers — safe on SSR / when storage is unavailable
const KEY_HISTORY = 'ra:history'
const KEY_CURRENT = 'ra:current'
const KEY_SETTINGS = 'ra:settings'

function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota exceeded or storage disabled */
  }
}

// --- history ---
export function loadHistory() {
  return safeGet(KEY_HISTORY, [])
}

export function saveHistory(history) {
  safeSet(KEY_HISTORY, history)
}

export function addToHistory(entry) {
  const history = loadHistory()
  const next = [entry, ...history].slice(0, 100) // cap at 100
  saveHistory(next)
  return next
}

export function updateInHistory(id, patch) {
  const history = loadHistory().map((e) => (e.id === id ? { ...e, ...patch } : e))
  saveHistory(history)
  return history
}

export function removeFromHistory(id) {
  const history = loadHistory().filter((e) => e.id !== id)
  saveHistory(history)
  // Also clean up any saved resume text for that id
  try {
    localStorage.removeItem(`${KEY_CURRENT}:text:${id}`)
  } catch { /* ignore */ }
  return history
}

export function clearHistory() {
  try {
    const history = loadHistory()
    history.forEach((e) => {
      try { localStorage.removeItem(`${KEY_CURRENT}:text:${e.id}`) } catch { /* ignore */ }
    })
    localStorage.removeItem(KEY_HISTORY)
    localStorage.removeItem(KEY_CURRENT)
  } catch { /* ignore */ }
}

// --- current resume (the one being used by other pages) ---
export function loadCurrent() {
  return safeGet(KEY_CURRENT, null)
}

export function saveCurrent(entry) {
  safeSet(KEY_CURRENT, entry)
  if (entry?.id && entry?.resumeText) {
    safeSet(`${KEY_CURRENT}:text:${entry.id}`, entry.resumeText)
  }
}

export function getResumeTextFor(id) {
  return safeGet(`${KEY_CURRENT}:text:${id}`, null)
}

// --- settings ---
const DEFAULT_SETTINGS = {
  theme: 'light',
  defaultModel: '',
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...safeGet(KEY_SETTINGS, {}) }
}

export function saveSettings(s) {
  safeSet(KEY_SETTINGS, s)
}

// --- export ---
export function exportAll() {
  const history = loadHistory()
  const texts = {}
  history.forEach((e) => {
    texts[e.id] = getResumeTextFor(e.id)
  })
  return {
    exportedAt: new Date().toISOString(),
    history,
    texts,
    settings: loadSettings(),
  }
}
