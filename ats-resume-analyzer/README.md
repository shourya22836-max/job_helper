# AI Resume Assistant

A multi-page web app that helps students understand how ATS recruitment works and gives them
practical AI tools to improve their resumes. Upload a resume, paste a job description, and
get an end-to-end assistant: scoring, chat, rewriting, role comparison, history tracking, and
educational ideal-resume guides — all driven by an OpenRouter-compatible LLM with a
rule-based ATS engine running alongside.

## What it does

- **Parses** PDF, DOCX, or TXT resumes (with Tesseract OCR fallback for scanned PDFs)
- **Scores** resume-vs-JD match (0–100) using OpenRouter + a deterministic ATS engine
- **Identifies** matched / missing skills, missing keywords, and formatting hazards
- **AI Chat** — ChatGPT-style Q&A grounded in your resume and analysis
- **Resume Improver** — rewrite Summary / Experience / Projects / Skills in 5 styles
- **Ideal Resumes** — pick a role + level and see what a strong resume for it looks like
- **Resume Comparison** — diff your resume against the ideal profile of a chosen role
- **Job Role Match** — score your resume against many roles at once, ranked
- **AI Mock Interview** — live, voice-based mock interview with a real-time AI
  interviewer (LiveKit presence + Deepgram live captions + OpenRouter questions)
- **History** — every analysis is saved in `localStorage`, with an ATS score trend sparkline
- **Settings** — API key status, model preference, theme (light/dark), export / clear data

## Pages (sidebar nav)

1. **Dashboard** — landing page, quick actions, recent history preview
2. **Analyze Resume** — upload + JD form, saves to history, navigates to Results
3. **AI Resume Chat** — chat with the assistant, with suggested prompts
4. **Resume Improver** — section + style chips, side-by-side diff view
5. **Ideal Resumes** — pick role + level, see an educational reference resume
6. **Job Role Match** — multi-select roles, get ranked matches
7. **Interview** — live mock interview with an AI interviewer (HR / Technical / Behavioral)
8. **History** — past analyses with score trend sparkline
9. **Settings** — model, theme, export, clear

## Architecture

```
React (Vite + React Router v6)
  └─ Context: HistoryContext (localStorage-backed)
  └─ lib/api.js  →  fetch →  FastAPI  →  OpenAI SDK → OpenRouter
                                              ↘ pdfplumber / python-docx / pytesseract
                                              ↘ LiveKit (interview presence)
                                              ↘ Deepgram (live STT over WebSocket)
                                          rule-based ATS checks
```

No accounts, no backend persistence — all resume text and analyses live in the browser's
`localStorage` under the `ra:` key prefix.

## Project layout

```
ats-resume-analyzer/
├── backend/
│   ├── app/
│   │   ├── main.py            # endpoints: health, analyze, chat, improve, roles, role-match, compare, interview/token, interview/feedback
│   │   ├── extractor.py       # PDF / DOCX / TXT extraction + OCR fallback
│   │   ├── ats_checks.py      # Rule-based ATS engine
│   │   ├── llm_analyzer.py    # OpenRouter integration + multi-prompt helpers
│   │   ├── interview.py       # LiveKit tokens + Deepgram STT WebSocket + interview Q&A and feedback
│   │   ├── roles_data.py      # 15 curated roles with skills, keywords, examples
│   │   └── schemas.py         # Pydantic models
│   ├── uploads/               # Temp storage (auto-deleted)
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx
│       ├── App.jsx                  # Router + Layout
│       ├── styles.css               # Full design system, dark mode, responsive
│       ├── context/
│       │   └── HistoryContext.jsx
│       ├── lib/
│       │   ├── api.js
│       │   └── storage.js
│       ├── components/
│       │   ├── Layout.jsx
│       │   ├── Sidebar.jsx
│       │   ├── ResultsPanel.jsx
│       │   ├── ScoreCard.jsx
│       │   └── UploadForm.jsx
│       └── pages/
│           ├── Dashboard.jsx
│           ├── Analyze.jsx
│           ├── Results.jsx
│           ├── Chat.jsx
│           ├── Improver.jsx
│           ├── IdealResumes.jsx
│           ├── Compare.jsx
│           ├── Interview.jsx        # AI Mock Interview (setup → pre-flight → live → feedback)
│           ├── RoleMatcher.jsx
│           ├── History.jsx
│           └── Settings.jsx
└── README.md
```

## Setup

### 1. Backend

Requires Python 3.10+.

```bash
cd backend
python -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                # then add your OPENROUTER_API_KEY
uvicorn app.main:app --reload --port 8000
```

For the **AI Mock Interview** you also need:

- **LiveKit** (free tier at <https://cloud.livekit.io>) — set in `backend/.env`:
  ```
  LIVEKIT_URL=wss://your-project.livekit.cloud
  LIVEKIT_API_KEY=APIxxx...
  LIVEKIT_API_SECRET=secret...
  ```
- **Deepgram** (free tier at <https://console.deepgram.com>) for live speech-to-text:
  ```
  DEEPGRAM_API_KEY=...
  ```

If these aren't set, the rest of the app still works — only the Interview page will return a
503 with a helpful message.

#### Optional — Tesseract OCR (for scanned/image-only PDFs)

If a resume PDF is a scanned image, the app automatically falls back to OCR
via Tesseract. Install the `tesseract` system binary:

- **macOS:** `brew install tesseract`
- **Debian/Ubuntu:** `sudo apt install tesseract-ocr`
- **Windows:** download installer from the
  [Tesseract GitHub releases](https://github.com/UB-Mannheim/tesseract/wiki)

Get an OpenRouter API key at <https://openrouter.ai/keys>. OpenRouter is
OpenAI-compatible, so it works with the OpenAI Python SDK out of the box. You get
one key and access to many models (GPT-4o-mini, Claude, Gemini, Llama, etc.).

The default model `openai/gpt-4o-mini` costs roughly $0.0001 per analysis. To
switch models, edit `OPENAI_MODEL` in `backend/.env` — see the full list at
<https://openrouter.ai/models>.

### 2. Frontend

Requires Node 18+.

```bash
cd frontend
npm install
npm run dev
```

Then open <http://localhost:5173>. The Vite dev server proxies `/api/*` calls to
the backend on port 8000.

## API

All endpoints accept and return JSON. New endpoints **never receive raw resume
files** — the resume text and analysis result are stored in the browser and
re-sent on each request.

### `POST /api/analyze`
Multipart form:
- `resume` (file, required) — PDF, DOCX, or TXT
- `job_description` (string, required) — the JD text

Returns: `{ match_score, matched_skills, missing_skills, keywords_missing, strengths,
weaknesses, suggested_improvements, formatting_issues, ats_checks, summary }`

### `GET /api/health`
Returns: `{ status, api_key_set, model }`

### `POST /api/chat`
Body: `{ message, resume_text?, analysis?, history? }`
Returns: `{ reply }`
Chat with the assistant using your resume + analysis as context. Falls back to
general career advice when no resume is provided.

### `POST /api/improve`
Body: `{ section, current_text, resume_text?, style }`
- `section`: `summary` | `experience` | `projects` | `skills`
- `style`: `professional` | `concise` | `ats_friendly` | `achievement_focused` | `grammar`

Returns: `{ improved, explanation }`

### `GET /api/roles`
Returns the list of 15 curated roles with full ideal-resume data:
`core_skills, bonus_skills, keywords, recommended_sections, example_summary,
example_bullets, project_ideas, ideal_length_words`.

### `POST /api/role-match`
Body: `{ resume_text, role_ids: [str] }`
Returns: `{ matches: [{ role_id, role_name, score, matched_skills, missing_skills,
missing_keywords, reasoning }] }` — ranked by score.

### `POST /api/compare`
Body: `{ resume_text, role_id, analysis? }`
Returns: `{ role, matched_skills, missing_skills, matched_keywords, missing_keywords,
missing_sections, recommendations, ats_score_delta }`

### `POST /api/interview/token`
Body: `{ role_id, interview_type, question_count, resume_text? }`
Returns: `{ room_name, identity, token, livekit_url, role, interview_type, question_count,
first_question, interview_id }` — mints a LiveKit JWT and returns the opening question.

### `WS /api/interview/ws/{interview_id}`
Audio round-trip endpoint used during the live interview. The first frame is a JSON
config object (`role_id`, `interview_type`, `question_count`, `resume_text?`). After
that the client streams 16-kHz Int16 PCM frames as binary; the server replies with
JSON events: `question`, `caption` (interim + final), `ai_thinking`, `ai_done`,
`paused`, `resumed`, `complete`, `error`. Text fallbacks are sent as `{ "type": "text", "text": "..." }`.

### `POST /api/interview/feedback`
Body: `{ interview_id, role, interview_type, turns: [{ role, text, timestamp }] }`
Returns: `{ score: { overall, communication, technical_knowledge, confidence },
strengths, areas_for_improvement, questions_answered_well, questions_needing_improvement,
narrative_summary, generated_at }`

## Curated roles

15 roles across Engineering, Data, Mobile, Product/Design, and Security:

- Software Development Engineer (entry)
- Frontend Developer (entry / mid)
- Backend Developer (mid)
- Full-Stack Developer (mid)
- Data Scientist (entry / mid)
- ML Engineer (mid)
- Data Analyst (entry)
- Data Engineer (mid)
- DevOps Engineer (mid)
- Cloud Engineer (mid)
- Android Developer (entry)
- iOS Developer (entry)
- Product Manager (mid)
- UX Designer (mid)
- Cybersecurity Analyst (entry)

Each role carries: description, core skills, bonus skills, ATS keywords, recommended
sections, an example summary, example bullets, and project ideas — used both by the
**Ideal Resumes** page and as ground truth for **Compare** / **Job Role Match**.

## Usage walkthrough

1. Open <http://localhost:5173> — land on **Dashboard**
2. Click **Analyze a resume** → upload PDF/DOCX/TXT, paste a JD, click *Analyze my resume*
3. Results page shows match score + ATS checks + matched / missing skills + suggestions
4. The analysis is automatically saved to **History** (and the resume text to `localStorage`)
5. From **Dashboard** / sidebar, jump to:
   - **AI Chat** — ask "What skills am I missing?" or any resume-specific question
   - **Resume Improver** — rewrite a section in 5 styles, side-by-side
   - **Ideal Resumes** — pick a target role, see what a strong resume looks like
   - **Job Role Match** — pick multiple roles, get a ranked fit list
   - **History** — re-open past analyses, see your score trend over time
   - **Interview** — pick a role + type (HR / Technical / Behavioral), allow camera + mic,
     and run a live mock interview with an AI. Watch live captions, see your progress
     and the current question, and end the round for a detailed scorecard.
   - **Settings** — change model preference, toggle theme, export / clear data

## Privacy

- Uploaded files live in `backend/uploads/` only for the duration of the request and
  are deleted immediately after analysis. Nothing is persisted server-side.
- All analyses, scores, and resume text live in your browser's `localStorage` under
  the `ra:` prefix. Use **Settings → Clear all history** or **Export data as JSON**
  to manage it.
- The OpenRouter API key lives in `backend/.env` only — never exposed to the browser.

## Educational goals

This project helps students understand:

- **How ATS scoring works** — keyword match, section parsing, formatting
- **What recruiters look for** — action verbs, quantified impact, relevant skills
- **The gap between "looks good" and "passes ATS"** — formatting hazards, missing
  sections, weak verbs, unquantified achievements
- **How to translate job descriptions into resume content** — keyword alignment per role

## Troubleshooting

- **`OPENROUTER_API_KEY is not set`** — copy `.env.example` to `.env` in `backend/` and
  paste your OpenRouter key (`sk-or-v1-...`).
- **`LiveKit is not set` on /api/interview/token** — copy `.env.example` to `.env`
  and add `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` from a LiveKit Cloud
  project (free tier: <https://cloud.livekit.io>).
- **`DEEPGRAM_API_KEY is not set`** — create a Deepgram project and add
  `DEEPGRAM_API_KEY` to `backend/.env` (free tier: <https://console.deepgram.com>).
- **CORS error** — make sure the backend is running on port 8000; the Vite dev
  server proxies `/api` calls automatically.
- **`No text could be extracted`** — your PDF is likely a scanned image. Install
  Tesseract (`brew install tesseract`) or re-export as a text-based PDF.
- **Module not found errors** — re-run `pip install -r requirements.txt` inside
  the active virtual environment.
- **"Unexpected keyword argument 'proxies'"** from openai SDK — `httpx` got upgraded;
  pin it: `pip install httpx==0.27.2`.
- **Sidebar not visible on mobile** — tap the hamburger icon in the topbar.
- **No audio in the interview** — your browser blocks mic access until you click the
  lock icon in the URL bar and grant microphone permission for `localhost:5173`.
  Voice also requires HTTPS or `localhost` (browsers refuse mic on plain HTTP).

## License

MIT
