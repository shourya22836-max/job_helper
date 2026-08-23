import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  addToHistory as addToHistoryStore,
  clearHistory as clearHistoryStore,
  getResumeTextFor,
  loadCurrent,
  loadHistory,
  removeFromHistory as removeFromHistoryStore,
  saveCurrent,
  saveSettings as saveSettingsStore,
  loadSettings,
} from '../lib/storage.js'

const HistoryContext = createContext(null)

export function HistoryProvider({ children }) {
  const [history, setHistory] = useState(() => loadHistory())
  const [current, setCurrent] = useState(() => loadCurrent())
  const [settings, setSettings] = useState(() => loadSettings())

  // Cross-tab sync
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'ra:history') setHistory(loadHistory())
      if (e.key === 'ra:current') setCurrent(loadCurrent())
      if (e.key === 'ra:settings') setSettings(loadSettings())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const addAnalysis = useCallback(({ fileName, jdText, result }) => {
    const id = `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const entry = {
      id,
      timestamp: Date.now(),
      fileName: fileName || 'resume',
      jdSnippet: (jdText || '').slice(0, 240).trim(),
      score: result?.match_score ?? 0,
      result,
    }
    const next = addToHistoryStore(entry)
    setHistory(next)

    // Set as current + persist resume text if available
    const resumeText = result?.resumeText || null
    const currentEntry = {
      id,
      fileName: entry.fileName,
      score: entry.score,
      jdSnippet: entry.jdSnippet,
      timestamp: entry.timestamp,
      result,
      resumeText,
    }
    saveCurrent(currentEntry)
    setCurrent(currentEntry)
    return id
  }, [])

  const removeAnalysis = useCallback((id) => {
    const next = removeFromHistoryStore(id)
    setHistory(next)
    if (current?.id === id) {
      setCurrent(null)
    }
  }, [current])

  const clearAll = useCallback(() => {
    clearHistoryStore()
    setHistory([])
    setCurrent(null)
  }, [])

  const restoreAnalysis = useCallback((id) => {
    const entry = history.find((e) => e.id === id)
    if (!entry) return null
    const resumeText = getResumeTextFor(id)
    const restored = {
      id: entry.id,
      fileName: entry.fileName,
      score: entry.score,
      jdSnippet: entry.jdSnippet,
      timestamp: entry.timestamp,
      result: entry.result,
      resumeText,
    }
    saveCurrent(restored)
    setCurrent(restored)
    return restored
  }, [history])

  const updateSettings = useCallback((patch) => {
    const next = { ...settings, ...patch }
    saveSettingsStore(next)
    setSettings(next)
  }, [settings])

  const value = useMemo(() => ({
    history,
    current,
    settings,
    addAnalysis,
    removeAnalysis,
    clearAll,
    restoreAnalysis,
    updateSettings,
    setCurrent,
  }), [history, current, settings, addAnalysis, removeAnalysis, clearAll, restoreAnalysis, updateSettings])

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}

export function useHistory() {
  const ctx = useContext(HistoryContext)
  if (!ctx) throw new Error('useHistory must be used within HistoryProvider')
  return ctx
}
