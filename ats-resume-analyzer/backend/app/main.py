"""FastAPI entry point for the AI Resume Assistant."""
from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import ats_checks, extractor, llm_analyzer, roles_data
from .schemas import (
    AnalyzeResponse,
    ChatRequest,
    ChatResponse,
    ImproveRequest,
    ImproveResponse,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger(__name__)

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_FILE_BYTES = 5 * 1024 * 1024
ALLOWED_EXTS = {".pdf", ".docx", ".txt"}

app = FastAPI(
    title="AI Resume Assistant",
    description="Upload a resume, get AI-powered ATS feedback, chat, rewrite, and more.",
    version="2.0.0",
)

# CORS: allow local dev + any Vercel preview/production domains via env var
_cors_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
]
if os.getenv("CORS_ORIGINS"):
    _cors_origins.extend([o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": os.getenv("OPENAI_MODEL", "openai/gpt-4o-mini"),
        "api_key_set": bool(
            os.getenv("OPENROUTER_API_KEY", "").strip()
            and not os.getenv("OPENROUTER_API_KEY", "").startswith("sk-or-your")
        ),
    }


# --------------------------------------------------------------------------- #
# Analyze (multipart file upload — unchanged from v1)
# --------------------------------------------------------------------------- #
@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(
    resume: UploadFile = File(...),
    job_description: str = Form(...),
) -> AnalyzeResponse:
    filename = resume.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {sorted(ALLOWED_EXTS)}",
        )

    contents = await resume.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 5 MB).")

    saved_name = f"{uuid.uuid4().hex}{ext}"
    saved_path = UPLOAD_DIR / saved_name
    try:
        saved_path.write_bytes(contents)
        try:
            text, meta = extractor.extract_text_with_meta(saved_path)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Text extraction failed")
            raise HTTPException(status_code=400, detail=f"Could not read file: {exc}") from exc

        if not text.strip():
            detail_msg = "No text could be extracted."
            if meta.get("ext") == ".pdf":
                if meta.get("ocr_available"):
                    detail_msg += " OCR was attempted but yielded no text — the file may be corrupt or password-protected."
                else:
                    detail_msg += " The file looks like a scanned image. Install Tesseract (`brew install tesseract`) for automatic OCR, or re-export the PDF as a text-based PDF from Word/Google Docs."
            else:
                detail_msg += " The file may be password-protected or in an unsupported format."
            raise HTTPException(status_code=400, detail=detail_msg)

        ats_results = ats_checks.run_checks(text, meta=meta)
        llm_result = llm_analyzer.analyze(text, job_description)

        formatting = llm_result.get("formatting_issues") or []
        if not formatting:
            formatting = [
                c.message for c in ats_results
                if not c.passed and ("format" in c.name.lower() or "ats parse" in c.name.lower())
            ]

        return AnalyzeResponse(
            match_score=llm_result.get("match_score", 0),
            matched_skills=llm_result.get("matched_skills", []),
            missing_skills=llm_result.get("missing_skills", []),
            keywords_missing=llm_result.get("keywords_missing", []),
            strengths=llm_result.get("strengths", []),
            weaknesses=llm_result.get("weaknesses", []),
            suggested_improvements=llm_result.get("suggested_improvements", []),
            formatting_issues=formatting,
            ats_checks=ats_results,
            summary=llm_result.get("summary"),
        )
    finally:
        try:
            if saved_path.exists():
                saved_path.unlink()
        except Exception:  # noqa: BLE001
            logger.warning("Failed to delete temp file %s", saved_path)


# --------------------------------------------------------------------------- #
# Chat
# --------------------------------------------------------------------------- #
@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="message is required")
    reply = llm_analyzer.chat(
        message=req.message,
        resume_text=req.resume_text,
        analysis=req.analysis,
        history=[m.model_dump() for m in req.history],
    )
    return ChatResponse(reply=reply)


# --------------------------------------------------------------------------- #
# Improve
# --------------------------------------------------------------------------- #
@app.post("/api/improve", response_model=ImproveResponse)
async def improve(req: ImproveRequest) -> ImproveResponse:
    if not req.current_text.strip():
        raise HTTPException(status_code=400, detail="current_text is required")
    if req.section not in {"summary", "experience", "projects", "skills"}:
        raise HTTPException(status_code=400, detail="section must be one of: summary, experience, projects, skills")
    result = llm_analyzer.improve(
        section=req.section,
        current_text=req.current_text,
        style=req.style,
        resume_text=req.resume_text,
    )
    return ImproveResponse(**result)


# --------------------------------------------------------------------------- #
# Roles
# --------------------------------------------------------------------------- #
@app.get("/api/roles")
def list_roles() -> dict:
    return {"roles": roles_data.get_roles()}
