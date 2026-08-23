// LocalStorage helpers for saved mock-interview reports.
const KEY_INTERVIEWS = 'ra:interviews'

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

export function loadInterviews() {
  return safeGet(KEY_INTERVIEWS, [])
}

export function saveInterviews(list) {
  safeSet(KEY_INTERVIEWS, list)
}

export function addInterview(record) {
  const list = loadInterviews()
  const next = [record, ...list].slice(0, 50)
  saveInterviews(next)
  return next
}

export function removeInterview(id) {
  const next = loadInterviews().filter((e) => e.id !== id)
  saveInterviews(next)
  return next
}

export function clearInterviews() {
  try {
    localStorage.removeItem(KEY_INTERVIEWS)
  } catch {
    /* ignore */
  }
}

export function exportInterviews() {
  return {
    exportedAt: new Date().toISOString(),
    interviews: loadInterviews(),
  }
}