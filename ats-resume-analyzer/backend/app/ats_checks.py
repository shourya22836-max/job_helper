"""Rule-based ATS checks — no LLM cost, deterministic signals."""
from __future__ import annotations

import re
from typing import List

from .schemas import AtsCheckResult

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"(\+?\d[\d\s().-]{8,}\d)")
URL_RE = re.compile(
    r"https?://\S+"
    r"|www\.\S+"
    r"|\b(?:linkedin|github|gitlab|behance|dribbble|medium|stackoverflow|kaggle)\.(?:com|in|io)\b\S*"
    r"|[\w.-]+\.(?:com|net|org|io|dev|ai|co|app|me|info|biz)/?\S*",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"\b\d[\d,.\+]*%?\b")

STRONG_VERBS = {
    "achieved", "architected", "automated", "boosted", "built", "collaborated",
    "created", "cut", "delivered", "deployed", "designed", "developed", "directed",
    "drove", "engineered", "enhanced", "established", "executed", "expanded",
    "generated", "implemented", "improved", "increased", "initiated", "launched",
    "led", "managed", "mentored", "migrated", "modernized", "optimized", "orchestrated",
    "organized", "owned", "pioneered", "planned", "produced", "reduced", "refactored",
    "researched", "resolved", "scaled", "shipped", "spearheaded", "streamlined",
    "supported", "trained", "transformed", "validated",
}

REQUIRED_SECTIONS = {
    "education": ["education", "academic"],
    "experience": ["experience", "work experience", "professional experience", "employment"],
    "skills": ["skills", "technical skills", "core competencies"],
    "projects": ["projects", "personal projects", "academic projects"],
    "summary": ["summary", "objective", "profile", "about"],
}

# Words / chars that often break ATS parsers
ATS_HAZARD_TOKENS = [
    "│", "┃", "║", "█",  # box-drawing characters
    "•" * 4,
]


def _word_count(text: str) -> int:
    return len(re.findall(r"\b\w+\b", text))


def _has_section(text: str, aliases: list[str]) -> bool:
    lower = text.lower()
    for alias in aliases:
        # match as a heading: line start or newline, optional #
        if re.search(rf"(^|\n)\s*#?\s*{re.escape(alias)}\b", lower):
            return True
    return False


def run_checks(resume_text: str, meta: dict | None = None) -> List[AtsCheckResult]:
    """Run all rule-based checks and return a list of results."""
    meta = meta or {}
    text = resume_text or ""
    lower = text.lower()
    results: list[AtsCheckResult] = []

    # 1) Contact info
    has_email = bool(EMAIL_RE.search(text))
    has_phone = bool(PHONE_RE.search(text))
    has_url = bool(URL_RE.search(text))
    if has_email and has_phone:
        results.append(AtsCheckResult(
            name="Contact information",
            passed=True,
            message="Email and phone number detected — recruiters can reach you.",
        ))
    elif has_email or has_phone:
        results.append(AtsCheckResult(
            name="Contact information",
            passed=False,
            message="Add both an email and a phone number so recruiters can contact you.",
        ))
    else:
        results.append(AtsCheckResult(
            name="Contact information",
            passed=False,
            message="No email or phone number found. Add a contact section at the top.",
        ))

    # 2) Required sections
    missing_sections = [
        name for name, aliases in REQUIRED_SECTIONS.items()
        if not _has_section(text, aliases)
    ]
    if not missing_sections:
        results.append(AtsCheckResult(
            name="Standard sections",
            passed=True,
            message="All standard sections (Education, Experience, Skills, Projects, Summary) are present.",
        ))
    else:
        results.append(AtsCheckResult(
            name="Standard sections",
            passed=False,
            message=f"Missing sections: {', '.join(missing_sections).title()}. ATS systems look for these.",
        ))

    # 3) Length
    wc = _word_count(text)
    if wc < 200:
        results.append(AtsCheckResult(
            name="Resume length",
            passed=False,
            message=f"Only {wc} words — too short. Aim for 400–800 words for a one-page resume.",
        ))
    elif wc > 1000:
        results.append(AtsCheckResult(
            name="Resume length",
            passed=False,
            message=f"{wc} words — too long. Trim to 1–2 pages (~600–900 words).",
        ))
    else:
        results.append(AtsCheckResult(
            name="Resume length",
            passed=True,
            message=f"{wc} words — within the recommended 400–900 range.",
        ))

    # 4) Action verbs
    words = re.findall(r"\b[a-zA-Z]+\b", lower)
    verb_hits = sum(1 for w in words if w in STRONG_VERBS)
    if verb_hits >= 8:
        results.append(AtsCheckResult(
            name="Action verbs",
            passed=True,
            message=f"{verb_hits} strong action verbs found (e.g. Built, Led, Designed).",
        ))
    elif verb_hits >= 3:
        results.append(AtsCheckResult(
            name="Action verbs",
            passed=False,
            message=f"Only {verb_hits} action verbs. Use more impact verbs like Built, Led, Optimized.",
        ))
    else:
        results.append(AtsCheckResult(
            name="Action verbs",
            passed=False,
            message="Very few action verbs detected. Start bullet points with verbs like Built, Led, Designed.",
        ))

    # 5) Quantified achievements
    numbers = NUMBER_RE.findall(text)
    if len(numbers) >= 6:
        results.append(AtsCheckResult(
            name="Quantified achievements",
            passed=True,
            message=f"{len(numbers)} numeric metrics detected — strong, measurable impact.",
        ))
    elif len(numbers) >= 2:
        results.append(AtsCheckResult(
            name="Quantified achievements",
            passed=False,
            message=f"Only {len(numbers)} numbers. Add more metrics (%, $, hours, users).",
        ))
    else:
        results.append(AtsCheckResult(
            name="Quantified achievements",
            passed=False,
            message="No quantified achievements found. Add numbers (e.g. 'cut load time by 40%').",
        ))

    # 6) ATS parse hazards (special chars / tables)
    hazards = [tok for tok in ATS_HAZARD_TOKENS if tok in text]
    if meta.get("has_tables"):
        hazards.append("tables")
    if hazards:
        results.append(AtsCheckResult(
            name="ATS parse-friendliness",
            passed=False,
            message=f"Formatting hazards detected ({', '.join(hazards)}). Use a single-column layout and standard bullets.",
        ))
    else:
        results.append(AtsCheckResult(
            name="ATS parse-friendliness",
            passed=True,
            message="No tables or unusual characters — ATS parsers should read this cleanly.",
        ))

    # 7) Image-only / scanned PDF warning
    density = meta.get("text_density", 0) or 0
    pages = meta.get("pages", 1) or 1
    if meta.get("ext") == ".pdf" and pages > 0 and density < 100:
        results.append(AtsCheckResult(
            name="Scanned/image PDF",
            passed=False,
            message="Very little text extracted. This may be a scanned image — ATS systems cannot read it.",
        ))

    # 8) Links present (LinkedIn/GitHub/portfolio) — bonus
    if has_url:
        results.append(AtsCheckResult(
            name="Links (LinkedIn / GitHub)",
            passed=True,
            message="Links detected — good for recruiters to verify your work.",
        ))
    else:
        results.append(AtsCheckResult(
            name="Links (LinkedIn / GitHub)",
            passed=False,
            message="No links found. Add LinkedIn / GitHub / portfolio URLs.",
        ))

    return results
