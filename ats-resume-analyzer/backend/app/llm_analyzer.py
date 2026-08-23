"""LLM-powered resume analysis (OpenAI-compatible — works with OpenRouter)."""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "openai/gpt-4o-mini"

SYSTEM_PROMPT = """You are an expert ATS (Applicant Tracking System) analyzer and senior recruiter.
You evaluate resumes against job descriptions and return precise, actionable feedback.

Your output MUST be valid JSON matching the requested schema. No prose, no markdown fences.
Be specific — name concrete skills and tools, not generic advice."""

CHAT_SYSTEM_PROMPT = """You are a friendly, expert career coach who specializes in resumes and ATS optimization.
You have access to a user's resume and prior analysis (if provided). Answer their questions
concisely (2–5 sentences) with concrete, actionable advice. If you don't have enough
context, say so and suggest what to provide. Never invent details not in their resume."""


# --------------------------------------------------------------------------- #
# Low-level OpenRouter helper
# --------------------------------------------------------------------------- #
def _client_and_kwargs(messages: list[dict], *, model: str, temperature: float = 0.4, max_tokens: int | None = None) -> dict:
    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key or api_key.startswith("sk-your-key") or api_key.startswith("sk-or-your"):
        raise RuntimeError("OPENROUTER_API_KEY is not set in backend/.env")

    from openai import OpenAI
    client = OpenAI(api_key=api_key, base_url=OPENROUTER_BASE_URL)

    extra_headers: dict = {}
    if os.getenv("OPENROUTER_SITE_URL"):
        extra_headers["HTTP-Referer"] = os.environ["OPENROUTER_SITE_URL"]
    if os.getenv("OPENROUTER_APP_NAME"):
        extra_headers["X-Title"] = os.environ["OPENROUTER_APP_NAME"]

    kwargs: dict = {
        "model": model,
        "temperature": temperature,
        "messages": messages,
    }
    if max_tokens:
        kwargs["max_tokens"] = max_tokens
    if extra_headers:
        kwargs["extra_headers"] = extra_headers
    return {"client": client, "kwargs": kwargs}


def _call_chat_json(messages: list[dict], *, temperature: float = 0.3, max_tokens: int | None = None) -> Dict[str, Any]:
    model = os.getenv("OPENAI_MODEL", DEFAULT_MODEL)
    setup = _client_and_kwargs(messages, model=model, temperature=temperature, max_tokens=max_tokens)
    response = setup["client"].chat.completions.create(**setup["kwargs"])
    content = response.choices[0].message.content or "{}"
    return json.loads(content)


def _call_chat_text(messages: list[dict], *, temperature: float = 0.4, max_tokens: int | None = None) -> str:
    model = os.getenv("OPENAI_MODEL", DEFAULT_MODEL)
    setup = _client_and_kwargs(messages, model=model, temperature=temperature, max_tokens=max_tokens)
    response = setup["client"].chat.completions.create(**setup["kwargs"])
    return (response.choices[0].message.content or "").strip()


# --------------------------------------------------------------------------- #
# 1) Original analyze (kept for /api/analyze)
# --------------------------------------------------------------------------- #
def _build_user_prompt(resume_text: str, jd_text: str) -> str:
    return f"""Analyze the resume below against the job description and return a JSON object with EXACTLY these keys:

- "match_score": integer 0-100, how well the resume fits the JD
- "matched_skills": array of strings — skills present in BOTH resume and JD
- "missing_skills": array of strings — skills required by JD but absent from resume
- "keywords_missing": array of strings — important JD keywords/phrases absent from resume
- "strengths": array of strings — 3-6 resume strengths relative to this JD
- "weaknesses": array of strings — 3-6 concrete weaknesses relative to this JD
- "suggested_improvements": array of strings — 5-10 prioritized, specific improvements
- "formatting_issues": array of strings — ATS formatting problems you detect
- "summary": string — 2-3 sentence overall verdict

Be honest: if a skill is not actually demonstrated in the resume, do not list it as matched.

=== JOB DESCRIPTION ===
{jd_text}

=== RESUME ===
{resume_text}
"""


def _fallback_response(error_msg: str) -> Dict[str, Any]:
    return {
        "match_score": 0,
        "matched_skills": [],
        "missing_skills": [],
        "keywords_missing": [],
        "strengths": [],
        "weaknesses": [],
        "suggested_improvements": [f"AI analysis unavailable: {error_msg}"],
        "formatting_issues": [],
        "summary": "AI analysis could not be completed. Rule-based ATS checks are still shown below.",
    }


def analyze(resume_text: str, jd_text: str) -> Dict[str, Any]:
    try:
        if not resume_text.strip():
            return _fallback_response("Resume text is empty — could not extract any text from the file.")
        if not jd_text.strip():
            return _fallback_response("Job description is empty — please paste a job description to analyze against.")

        data = _call_chat_json(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _build_user_prompt(resume_text, jd_text)},
            ]
        )
        return {
            "match_score": int(data.get("match_score", 0) or 0),
            "matched_skills": list(data.get("matched_skills", []) or []),
            "missing_skills": list(data.get("missing_skills", []) or []),
            "keywords_missing": list(data.get("keywords_missing", []) or []),
            "strengths": list(data.get("strengths", []) or []),
            "weaknesses": list(data.get("weaknesses", []) or []),
            "suggested_improvements": list(data.get("suggested_improvements", []) or []),
            "formatting_issues": list(data.get("formatting_issues", []) or []),
            "summary": data.get("summary") or "",
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("OpenRouter analysis failed")
        return _fallback_response(str(exc))


# --------------------------------------------------------------------------- #
# 2) Chat
# --------------------------------------------------------------------------- #
def chat(
    message: str,
    resume_text: Optional[str] = None,
    analysis: Optional[dict] = None,
    history: Optional[List[dict]] = None,
) -> str:
    """Return the assistant's reply text. Falls back gracefully if API fails."""
    try:
        system_parts = [CHAT_SYSTEM_PROMPT]
        if resume_text:
            truncated = resume_text[:6000]  # cap to fit context
            system_parts.append(f"\n\nUSER'S RESUME (truncated if long):\n{truncated}")
        if analysis and isinstance(analysis, dict):
            summary = analysis.get("summary") or ""
            score = analysis.get("match_score")
            if score is not None:
                system_parts.append(f"\n\nPRIOR ATS ANALYSIS — Match score: {score}/100")
            if summary:
                system_parts.append(f"Summary: {summary}")

        messages: list[dict] = [{"role": "system", "content": "\n".join(system_parts)}]

        for h in (history or [])[-10:]:  # keep last 10 turns
            if h.get("role") in ("user", "assistant") and h.get("content"):
                messages.append({"role": h["role"], "content": h["content"]})

        messages.append({"role": "user", "content": message})
        return _call_chat_text(messages, temperature=0.5)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Chat failed")
        return f"(Chat unavailable: {exc})"


# --------------------------------------------------------------------------- #
# 3) Improve (rewrite a section in a chosen style)
# --------------------------------------------------------------------------- #
STYLE_INSTRUCTIONS = {
    "professional": (
        "Rewrite in a polished, confident, professional voice suitable for any industry. "
        "Use full sentences, active voice, and avoid jargon or buzzwords. Preserve the original meaning."
    ),
    "concise": (
        "Rewrite to be as concise as possible while preserving the substance. "
        "Cut filler, combine related points, and prefer short punchy phrases. Target ~50% of the original length."
    ),
    "ats_friendly": (
        "Rewrite so it ranks well with ATS systems: front-load strong keywords, use standard section labels, "
        "spell out acronyms on first use, avoid tables/columns/special characters. Match the language of common job descriptions."
    ),
    "achievement_focused": (
        "Rewrite emphasizing concrete achievements and impact. Where possible, add or strengthen quantified metrics "
        "(%, $, hours, users). Start bullets with strong action verbs (Built, Led, Optimized, Shipped)."
    ),
    "grammar": (
        "Fix all grammar, spelling, and punctuation issues. Improve clarity and flow. "
        "Do NOT change meaning, structure, or the order of information. Keep the same length."
    ),
}

SECTION_INSTRUCTIONS = {
    "summary": "This is the SUMMARY / PROFESSIONAL PROFILE section of a resume.",
    "experience": "This is the WORK EXPERIENCE section (bullets describing roles).",
    "projects": "This is the PROJECTS section.",
    "skills": "This is the SKILLS section (a list or paragraph of skills/tools).",
}


def improve(section: str, current_text: str, style: str, resume_text: Optional[str] = None) -> Dict[str, str]:
    """Return {improved, explanation} for the given section + style."""
    section = (section or "").lower().strip()
    style = (style or "professional").lower().strip()
    sec_instr = SECTION_INSTRUCTIONS.get(section, "This is a section of a resume.")
    style_instr = STYLE_INSTRUCTIONS.get(style, STYLE_INSTRUCTIONS["professional"])

    system = (
        "You are an expert resume editor. Given the original text of a resume section and a target style, "
        "return a JSON object with exactly two keys: 'improved' (the rewritten text) and 'explanation' "
        "(a 1–2 sentence rationale for the key changes). Do not wrap the JSON in markdown fences."
    )
    user = f"""SECTION: {section}
{sec_instr}

TARGET STYLE: {style}
{style_instr}

ORIGINAL TEXT:
\"\"\"
{current_text}
\"\"\"

Return JSON only with keys "improved" and "explanation"."""
    try:
        data = _call_chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.4,
        )
        return {
            "improved": str(data.get("improved", "")).strip() or current_text,
            "explanation": str(data.get("explanation", "")).strip(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Improve failed")
        return {
            "improved": current_text,
            "explanation": f"Improve unavailable: {exc}",
        }


# --------------------------------------------------------------------------- #
# 4) Role match (single LLM call for many roles)
# --------------------------------------------------------------------------- #
def role_match(resume_text: str, roles: List[dict]) -> List[dict]:
    """Return a list of {role_id, role_name, score, matched_skills, missing_skills, missing_keywords, reasoning}."""
    if not roles:
        return []
    try:
        roles_block = "\n".join(
            f"- id={r['id']} | name={r['name']} | level={r['level']} | "
            f"core_skills={r['core_skills']} | keywords={r['keywords']}"
            for r in roles
        )
        user = f"""Score how well this resume matches each of the job roles below.
Return a JSON object with a single key "matches" whose value is an array — one entry per role, in the same order as input.
Each entry must contain:
  role_id, role_name, score (0-100), matched_skills (array), missing_skills (array), missing_keywords (array), reasoning (1-2 sentences).

Be honest: only count a skill as matched if it's actually demonstrated in the resume.
Reasoning should explain why it's a strong/weak fit in 1-2 short sentences.

ROLES:
{roles_block}

RESUME:
\"\"\"
{resume_text[:8000]}
\"\"\"
"""
        data = _call_chat_json(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user},
            ],
            temperature=0.3,
        )
        matches = data.get("matches") or []
        # Normalize + preserve order/count
        out: list[dict] = []
        for i, r in enumerate(roles):
            m = matches[i] if i < len(matches) else {}
            out.append({
                "role_id": m.get("role_id") or r["id"],
                "role_name": m.get("role_name") or r["name"],
                "score": int(m.get("score", 0) or 0),
                "matched_skills": list(m.get("matched_skills", []) or []),
                "missing_skills": list(m.get("missing_skills", []) or []),
                "missing_keywords": list(m.get("missing_keywords", []) or []),
                "reasoning": str(m.get("reasoning", "") or ""),
            })
        return out
    except Exception as exc:  # noqa: BLE001
        logger.exception("Role match failed")
        return [
            {
                "role_id": r["id"],
                "role_name": r["name"],
                "score": 0,
                "matched_skills": [],
                "missing_skills": [],
                "missing_keywords": [],
                "reasoning": f"Role-match unavailable: {exc}",
            }
            for r in roles
        ]


# --------------------------------------------------------------------------- #
# 5) Compare (resume vs ideal-role profile)
# --------------------------------------------------------------------------- #
def compare(resume_text: str, role: dict, analysis: Optional[dict] = None) -> dict:
    """Rule-based + LLM-hybrid compare. Returns matched/missing/skills/sections/keywords."""
    lower_resume = (resume_text or "").lower()

    def has_any(aliases: list[str]) -> bool:
        return any(a.lower() in lower_resume for a in aliases)

    matched_skills = [s for s in role.get("core_skills", []) if s.lower() in lower_resume]
    missing_skills = [s for s in role.get("core_skills", []) if s.lower() not in lower_resume]
    matched_keywords = [k for k in role.get("keywords", []) if k.lower() in lower_resume]
    missing_keywords = [k for k in role.get("keywords", []) if k.lower() not in lower_resume]

    sections_present = {
        "summary": has_any(["summary", "objective", "profile"]),
        "experience": has_any(["experience", "employment", "work experience"]),
        "projects": has_any(["projects", "personal projects"]),
        "skills": has_any(["skills", "technical skills"]),
        "education": has_any(["education", "academic"]),
    }
    missing_sections = [
        name for name, present in sections_present.items()
        if not present and name in role.get("recommended_sections", [])
    ]

    base_score = int((analysis or {}).get("match_score", 0) or 0)
    # Crude estimate: bonus/penalty based on role-specific gaps
    coverage = len(matched_skills) / max(len(role.get("core_skills", [])), 1)
    delta = int(round((coverage - 0.5) * 40))  # -20..+20

    # LLM-driven recommendations (short list)
    recs: list[str] = []
    try:
        user = f"""Compare this resume against the ideal profile for "{role['name']}" ({role['level']}).
Return JSON: {{ "recommendations": [3-6 short, concrete, prioritized actions the candidate should take] }}
Focus on the gaps most likely to fail ATS or recruiter screens.

ROLE CORE SKILLS: {role['core_skills']}
ROLE KEYWORDS: {role['keywords']}
RECOMMENDED SECTIONS: {role['recommended_sections']}

RESUME:
\"\"\"
{resume_text[:6000]}
\"\"\"
"""
        data = _call_chat_json(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user},
            ],
            temperature=0.3,
        )
        recs = list(data.get("recommendations") or [])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Compare recommendations failed")
        recs = [f"Could not generate recommendations: {exc}"]

    return {
        "role": role,
        "matched_skills": matched_skills,
        "missing_skills": missing_skills,
        "missing_sections": missing_sections,
        "matched_keywords": matched_keywords,
        "missing_keywords": missing_keywords,
        "recommendations": recs,
        "ats_score_delta": delta,
        "base_score": base_score,
    }
