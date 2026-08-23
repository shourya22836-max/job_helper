import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import { HistoryProvider } from './context/HistoryContext.jsx'

import Dashboard from './pages/Dashboard.jsx'
import Analyze from './pages/Analyze.jsx'
import Results from './pages/Results.jsx'
import Chat from './pages/Chat.jsx'
import Improver from './pages/Improver.jsx'
import IdealResumes from './pages/IdealResumes.jsx'
import Compare from './pages/Compare.jsx'
import Interview from './pages/Interview.jsx'
import RoleMatcher from './pages/RoleMatcher.jsx'
import History from './pages/History.jsx'
import Settings from './pages/Settings.jsx'

export default function App() {
  return (
    <HistoryProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="analyze" element={<Analyze />} />
            <Route path="results/:id" element={<Results />} />
            <Route path="chat" element={<Chat />} />
            <Route path="improver" element={<Improver />} />
            <Route path="ideal" element={<IdealResumes />} />
            <Route path="compare" element={<Compare />} />
            <Route path="interview" element={<Interview />} />
            <Route path="matcher" element={<RoleMatcher />} />
            <Route path="history" element={<History />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </HistoryProvider>
  )
}
