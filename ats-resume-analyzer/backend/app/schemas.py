"""Pydantic schemas for request/response models."""
from typing import Any, List, Literal, Optional
from pydantic import BaseModel, Field


class AtsCheckResult(BaseModel):
    name: str
    passed: bool
    message: str


class AnalyzeResponse(BaseModel):
    match_score: int = Field(ge=0, le=100, description="Overall JD match score 0-100")
    matched_skills: List[str] = Field(default_factory=list)
    missing_skills: List[str] = Field(default_factory=list)
    keywords_missing: List[str] = Field(default_factory=list)
    strengths: List[str] = Field(default_factory=list)
    weaknesses: List[str] = Field(default_factory=list)
    suggested_improvements: List[str] = Field(default_factory=list)
    formatting_issues: List[str] = Field(default_factory=list)
    ats_checks: List[AtsCheckResult] = Field(default_factory=list)
    summary: Optional[str] = None


# --- Chat ---
class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    resume_text: Optional[str] = None
    analysis: Optional[dict[str, Any]] = None
    history: List[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str


# --- Improve ---
class ImproveRequest(BaseModel):
    section: str  # summary | experience | projects | skills
    current_text: str
    resume_text: Optional[str] = None
    style: str = "professional"  # professional | concise | ats_friendly | achievement_focused | grammar


class ImproveResponse(BaseModel):
    improved: str
    explanation: str


# --- Role match ---
class RoleMatchItem(BaseModel):
    role_id: str
    role_name: str
    score: int
    matched_skills: List[str] = Field(default_factory=list)
    missing_skills: List[str] = Field(default_factory=list)
    missing_keywords: List[str] = Field(default_factory=list)
    reasoning: str = ""


class RoleMatchRequest(BaseModel):
    resume_text: str
    role_ids: List[str]


class RoleMatchResponse(BaseModel):
    matches: List[RoleMatchItem] = Field(default_factory=list)


# --- Compare ---
class CompareRequest(BaseModel):
    resume_text: str
    role_id: str
    analysis: Optional[dict[str, Any]] = None


class CompareResponse(BaseModel):
    role: dict[str, Any]
    matched_skills: List[str] = Field(default_factory=list)
    missing_skills: List[str] = Field(default_factory=list)
    missing_sections: List[str] = Field(default_factory=list)
    matched_keywords: List[str] = Field(default_factory=list)
    missing_keywords: List[str] = Field(default_factory=list)
    recommendations: List[str] = Field(default_factory=list)
    ats_score_delta: int = 0


# --- Interview ---
class InterviewTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    timestamp: float


class InterviewStartRequest(BaseModel):
    role_id: str
    interview_type: Literal["hr", "technical", "behavioral"] = "technical"
    question_count: int = 6
    resume_text: Optional[str] = None


class InterviewStartResponse(BaseModel):
    room_name: str
    identity: str
    token: str
    livekit_url: str
    role: dict[str, Any]
    interview_type: str
    question_count: int
    first_question: str
    interview_id: str


class InterviewFeedbackRequest(BaseModel):
    interview_id: str
    role: dict[str, Any]
    interview_type: str
    turns: List[InterviewTurn]


class QAReviewItem(BaseModel):
    question: str
    answer_snippet: str
    verdict: Literal["strong", "ok", "needs_work"]
    score: int = Field(ge=0, le=100)
    comment: str
    suggested_answer: str


class ScoreBlock(BaseModel):
    overall: int = Field(ge=0, le=100)
    communication: int = Field(ge=0, le=100)
    technical_knowledge: int = Field(ge=0, le=100)
    confidence: int = Field(ge=0, le=100)


class InterviewFeedbackResponse(BaseModel):
    score: ScoreBlock
    strengths: List[str] = Field(default_factory=list)
    areas_for_improvement: List[str] = Field(default_factory=list)
    questions_answered_well: List[QAReviewItem] = Field(default_factory=list)
    questions_needing_improvement: List[QAReviewItem] = Field(default_factory=list)
    narrative_summary: str = ""
    generated_at: str
