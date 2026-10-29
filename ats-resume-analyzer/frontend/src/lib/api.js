// Fetch wrappers for all backend endpoints.
// In development: Vite proxies /api → http://localhost:8000
// In production (Vercel): uses BACKEND_URL binding for direct service-to-service calls

function getApiBase() {
  // Vercel injects BACKEND_URL binding at runtime for the frontend service
  // Falls back to relative /api for local dev (via Vite proxy) and Vercel preview (via rewrites)
  return import.meta.env.VITE_BACKEND_URL || '';
}

async function jsonOrThrow(res) {
  const ct = res.headers.get('content-type') || ''
  const body = ct.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    const detail = typeof body === 'object' ? body.detail || JSON.stringify(body) : body
    throw new Error(detail || `Request failed (${res.status})`)
  }
  return body
}

export async function analyzeResume(file, jobDescription) {
  const fd = new FormData()
  fd.append('resume', file)
  fd.append('job_description', jobDescription)
  const res = await fetch(`${getApiBase()}/api/analyze`, { method: 'POST', body: fd })
  return jsonOrThrow(res)
}

export async function sendChatMessage({ message, resumeText, analysis, history }) {
  const res = await fetch(`${getApiBase()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, resume_text: resumeText, analysis, history }),
  })
  return jsonOrThrow(res)
}

export async function improveSection({ section, currentText, resumeText, style }) {
  const res = await fetch(`${getApiBase()}/api/improve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      section,
      current_text: currentText,
      resume_text: resumeText,
      style,
    }),
  })
  return jsonOrThrow(res)
}

export async function fetchRoles() {
  const res = await fetch(`${getApiBase()}/api/roles`)
  return jsonOrThrow(res)
}

export async function roleMatch({ resumeText, roleIds }) {
  const res = await fetch(`${getApiBase()}/api/role-match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resume_text: resumeText, role_ids: roleIds }),
  })
  return jsonOrThrow(res)
}

export async function compareResume({ resumeText, roleId, analysis }) {
  const res = await fetch(`${getApiBase()}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resume_text: resumeText, role_id: roleId, analysis }),
  })
  return jsonOrThrow(res)
}

export async function getHealth() {
  const res = await fetch(`${getApiBase()}/api/health`)
  return jsonOrThrow(res)
}

export async function startInterview({ roleId, interviewType, questionCount, resumeText }) {
  const res = await fetch(`${getApiBase()}/api/interview/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      role_id: roleId,
      interview_type: interviewType,
      question_count: questionCount,
      resume_text: resumeText,
    }),
  })
  return jsonOrThrow(res)
}

export async function getInterviewFeedback({ interviewId, role, interviewType, turns }) {
  const res = await fetch(`${getApiBase()}/api/interview/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      interview_id: interviewId,
      role,
      interview_type: interviewType,
      turns: turns.map((t) => ({ role: t.role, text: t.text, timestamp: t.timestamp })),
    }),
  })
  return jsonOrThrow(res)
}
