"""FastAPI entry point for the AI Resume Assistant."""
from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import ats_checks, extractor, interview, llm_analyzer, roles_data
from .services.avatar import AvatarProviderFactory, AvatarSession
from .schemas import (
    AnalyzeResponse,
    ChatRequest,
    ChatResponse,
    CompareRequest,
    CompareResponse,
    ImproveRequest,
    ImproveResponse,
    InterviewFeedbackRequest,
    InterviewFeedbackResponse,
    InterviewStartRequest,
    InterviewStartResponse,
    RoleMatchRequest,
    RoleMatchResponse,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger(__name__)

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_FILE_BYTES = 5 * 1024 * 1024
ALLOWED_EXTS = {".pdf", ".docx", ".txt"}

app = FastAPI(
    title="AI Resume Assistant",
    description="Upload a resume, get AI-powered ATS feedback, chat, rewrite, compare, and more.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
    ],
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


# --------------------------------------------------------------------------- #
# Role match (multi-role)
# --------------------------------------------------------------------------- #
@app.post("/api/role-match", response_model=RoleMatchResponse)
async def role_match(req: RoleMatchRequest) -> RoleMatchResponse:
    if not req.resume_text.strip():
        raise HTTPException(status_code=400, detail="resume_text is required")
    if not req.role_ids:
        raise HTTPException(status_code=400, detail="role_ids is required")

    roles = [roles_data.get_role(rid) for rid in req.role_ids]
    roles = [r for r in roles if r]
    if not roles:
        raise HTTPException(status_code=400, detail="No valid role_ids provided")

    matches = llm_analyzer.role_match(req.resume_text, roles)
    return RoleMatchResponse(matches=matches)


# --------------------------------------------------------------------------- #
# Compare (resume vs ideal role)
# --------------------------------------------------------------------------- #
@app.post("/api/compare", response_model=CompareResponse)
async def compare(req: CompareRequest) -> CompareResponse:
    if not req.resume_text.strip():
        raise HTTPException(status_code=400, detail="resume_text is required")
    role = roles_data.get_role(req.role_id)
    if not role:
        raise HTTPException(status_code=404, detail=f"Unknown role_id: {req.role_id}")

    result = llm_analyzer.compare(req.resume_text, role, analysis=req.analysis)
    return CompareResponse(
        role=result["role"],
        matched_skills=result["matched_skills"],
        missing_skills=result["missing_skills"],
        missing_sections=result["missing_sections"],
        matched_keywords=result["matched_keywords"],
        missing_keywords=result["missing_keywords"],
        recommendations=result["recommendations"],
        ats_score_delta=result["ats_score_delta"],
    )


# --------------------------------------------------------------------------- #
# Interview — start (mints LiveKit token + generates first question)
# --------------------------------------------------------------------------- #
@app.post("/api/interview/token", response_model=InterviewStartResponse)
async def start_interview(req: InterviewStartRequest) -> InterviewStartResponse:
    role = roles_data.get_role(req.role_id)
    if not role:
        raise HTTPException(status_code=404, detail=f"Unknown role_id: {req.role_id}")

    interview_id = interview.new_interview_id()
    room_name = f"int-{interview_id}"
    identity = f"user-{uuid.uuid4().hex[:8]}"
    question_count = max(2, min(int(req.question_count or 6), 12))

    try:
        token, lk_url = interview.mint_access_token(room_name, identity)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # Encode the interview config in the LiveKit room's metadata so the
    # voice agent (backend/agent.py) can read it when it joins the room.
    room_metadata = json.dumps({
        "interview_id": interview_id,
        "interview_type": req.interview_type,
        "question_count": question_count,
        "role": role,
        "resume_text": req.resume_text or "",
    })
    await interview.ensure_room(room_name, metadata=room_metadata)

    # Pre-generate the first question so the UI can show it as a caption while
    # the agent connects. The LiveKit agent will also speak it once it joins.
    first_q = interview.generate_first_question(
        role=role, interview_type=req.interview_type, resume_text=req.resume_text,
    )

    # Create avatar session (backend-only secrets; frontend gets session config)
    avatar_provider_name = os.getenv("AVATAR_PROVIDER", "local").lower().strip()
    avatar_session = None
    try:
        avatar_provider = AvatarProviderFactory.create_from_env()
        avatar_config = AvatarProviderFactory._PROVIDERS.get(avatar_provider_name)
        if avatar_config:
            from .services.avatar import AvatarConfig
            config = AvatarConfig()
            avatar_session = await avatar_provider.create_session(config)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Avatar session creation failed, using local fallback: %s", exc)
        # Local fallback
        from .services.avatar import LocalAvatarProvider, AvatarConfig
        local_provider = LocalAvatarProvider()
        avatar_session = await local_provider.create_session(AvatarConfig())

    # Convert AvatarSession dataclass to dict for Pydantic response
    avatar_session_dict = asdict(avatar_session) if avatar_session else None

    return InterviewStartResponse(
        room_name=room_name,
        identity=identity,
        token=token,
        livekit_url=lk_url,
        role=role,
        interview_type=req.interview_type,
        question_count=question_count,
        first_question=first_q,
        interview_id=interview_id,
        avatar_provider=avatar_provider_name,
        avatar_session=avatar_session_dict,
    )


# --------------------------------------------------------------------------- #
# Interview — feedback (called by the frontend after the interview ends)
# --------------------------------------------------------------------------- #
@app.post("/api/interview/feedback", response_model=InterviewFeedbackResponse)
async def interview_feedback(req: InterviewFeedbackRequest) -> InterviewFeedbackResponse:
    turns = [t.model_dump() for t in req.turns]
    # Pair (assistant question, user answer) turns.
    per_q: list[dict] = []
    pending_question: Optional[str] = None
    answer_buf: list[str] = []
    for t in turns:
        if t.get("role") == "assistant":
            if pending_question and answer_buf:
                per_q.append(interview.evaluate_answer(
                    role=req.role,
                    interview_type=req.interview_type,
                    question=pending_question,
                    answer=" ".join(answer_buf),
                ))
            pending_question = t.get("text", "")
            answer_buf = []
        else:
            if pending_question is not None:
                answer_buf.append(t.get("text", ""))
    if pending_question and answer_buf:
        per_q.append(interview.evaluate_answer(
            role=req.role,
            interview_type=req.interview_type,
            question=pending_question,
            answer=" ".join(answer_buf),
        ))

    feedback = interview.generate_feedback(
        role=req.role, interview_type=req.interview_type,
        turns=turns, per_q=per_q,
    )
    return InterviewFeedbackResponse(**feedback)


# --------------------------------------------------------------------------- #
# Interview — runtime config (frontend polls this to know if the agent is ready
# to join, what the question count is, etc.). Currently a passthrough that
# reads the role + question_count set when /api/interview/token was called.
# --------------------------------------------------------------------------- #
@app.get("/api/interview/status/{interview_id}")
def interview_status(interview_id: str) -> dict:
    """Best-effort status. The LiveKit room is the source of truth for
    agent presence; this endpoint lets the UI show a friendly message while
    it waits for the agent worker to spin up.
    """
    return {
        "interview_id": interview_id,
        "agent_required": True,
        "agent_help": (
            "If the AI never joins, start the voice agent worker with "
            "`python agent.py dev` from the backend directory."
        ),
    }
