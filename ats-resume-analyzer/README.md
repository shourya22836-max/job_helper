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
- **History** — every analysis is saved in `localStorage`, with an ATS score trend sparkline
- **Settings** — API key status, model preference, theme (light/dark), export / clear data

## Pages (sidebar nav)

1. **Dashboard** — landing page, quick actions, recent history preview
2. **Analyze Resume** — upload + JD form, saves to history, navigates to Results
3. **AI Resume Chat** — chat with the assistant, with suggested prompts
4. **Resume Improver** — section + style chips, side-by-side diff view
5. **Ideal Resumes** — pick role + level, see an educational reference resume
6. **History** — past analyses with score trend sparkline
7. **Settings** — model, theme, export, clear

## Architecture

```
React (Vite + React Router v6)
  └─ Context: HistoryContext (localStorage-backed)
  └─ lib/api.js  →  fetch →  FastAPI  →  OpenAI SDK → OpenRouter
                                              ↘ pdfplumber / python-docx / pytesseract
                                          rule-based ATS checks
```

No accounts, no backend persistence — all resume text and analyses live in the browser's
`localStorage` under the `ra:` key prefix.

## Project layout

```
ats-resume-analyzer/
├── backend/
│   ├── app/
│   │   ├── main.py            # endpoints: health, analyze, chat, improve, roles, role-match, compare
│   │   ├── extractor.py       # PDF / DOCX / TXT extraction + OCR fallback
│   │   ├── ats_checks.py      # Rule-based ATS engine
│   │   ├── llm_analyzer.py    # OpenRouter integration + multi-prompt helpers
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
sections, an example summary, example bullets, and project ideas — used by the
**Ideal Resumes** page.

## Usage walkthrough

1. Open <http://localhost:5173> — land on **Dashboard**
2. Click **Analyze a resume** → upload PDF/DOCX/TXT, paste a JD, click *Analyze my resume*
3. Results page shows match score + ATS checks + matched / missing skills + suggestions
4. The analysis is automatically saved to **History** (and the resume text to `localStorage`)
5. From **Dashboard** / sidebar, jump to:
   - **AI Chat** — ask "What skills am I missing?" or any resume-specific question
   - **Resume Improver** — rewrite a section in 5 styles, side-by-side
   - **Ideal Resumes** — pick a target role, see what a strong resume looks like
   - **History** — re-open past analyses, see your score trend over time
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
- **CORS error** — make sure the backend is running on port 8000; the Vite dev
  server proxies `/api` calls automatically.
- **`No text could be extracted`** — your PDF is likely a scanned image. Install
  Tesseract (`brew install tesseract`) or re-export as a text-based PDF.
- **Module not found errors** — re-run `pip install -r requirements.txt` inside
  the active virtual environment.
- **"Unexpected keyword argument 'proxies'"** from openai SDK — `httpx` got upgraded;
  pin it: `pip install httpx==0.27.2`.
- **Sidebar not visible on mobile** — tap the hamburger icon in the topbar.

## License

MIT
