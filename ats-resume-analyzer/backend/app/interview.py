"""LiveKit + Deepgram + LLM-powered mock interview backend.

Provides:
- `mint_access_token` / `ensure_room`         — LiveKit JWT + room bootstrap
- `generate_first_question` / `generate_next_question` — adaptive question generation
- `evaluate_answer`                           — per-Q judgement
- `generate_feedback`                         — final report
- `interview_ws`                              — FastAPI WebSocket handler that owns
                                                 the audio round-trip via Deepgram
                                                 streaming STT and the LLM helpers.

The LiveKit room is used for video preview + data-channel signaling only; the
audio round-trip runs over this WebSocket.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect

from . import llm_analyzer, roles_data

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Prompt fragments
# --------------------------------------------------------------------------- #
INTERVIEWER_SYSTEM_PROMPT = """You are a senior interviewer conducting a live mock interview with a candidate.
You are professional, friendly, and concise. Ask ONE question at a time. Keep your replies brief (1-3 sentences).
React to what the candidate actually said — acknowledge strengths briefly, then probe or move on.
Never break character. Never reveal you are an AI. Speak as if you are in a real interview."""

QUESTION_GEN_SYSTEM_PROMPT = """You are a senior interviewer. Generate the NEXT question for a live mock interview.

Return strict JSON with EXACTLY these keys:
- "question": the interview question (one sentence, conversational, no preamble)
- "intent": a 1-sentence note on WHY this question fits this candidate and stage

Tailor the question to the candidate's resume (if given), the target role, and the interview type.
Do NOT repeat earlier questions. Progress from general to specific."""

EVALUATE_SYSTEM_PROMPT = """You are an expert interview coach evaluating a candidate's answer.

Return strict JSON with EXACTLY these keys:
- "verdict": "strong" | "ok" | "needs_work"
- "score": integer 0-100
- "comment": 1-2 sentence specific feedback on what was good and what was missing
- "suggested_answer": a concise, strong example answer (3-5 sentences) the candidate could have given

Be honest and specific. Reference concrete things the candidate said."""

FEEDBACK_SYSTEM_PROMPT = """You are an expert interview coach summarizing a candidate's full mock interview.

You will receive the full transcript (alternating assistant questions and user answers) and per-question
evaluations. Return strict JSON with EXACTLY these keys:

- "score": { "overall": 0-100, "communication": 0-100, "technical_knowledge": 0-100, "confidence": 0-100 }
- "strengths": array of 3-6 short strings
- "areas_for_improvement": array of 3-6 short, concrete, actionable strings
- "questions_answered_well": array of items where verdict was "strong" or "ok". Each item: { question, answer_snippet (first 120 chars), verdict, score, comment, suggested_answer }
- "questions_needing_improvement": array of items where verdict was "needs_work". Same shape as above.
- "narrative_summary": 2-4 sentence overall verdict

Be specific. Reference what the candidate actually said."""

TYPE_GUIDANCE: Dict[str, str] = {
    "hr": (
        "INTERVIEW TYPE: HR / cultural fit. Focus on motivation, teamwork, "
        "communication, conflict resolution, career goals, and 'tell me about yourself'. "
        "Keep questions conversational and behavioral."
    ),
    "technical": (
        "INTERVIEW TYPE: Technical. Probe concrete skills, projects, problem-solving, "
        "tools, and how the candidate reasons about trade-offs. Use real-world scenarios."
    ),
    "behavioral": (
        "INTERVIEW TYPE: Behavioral (STAR). Ask Situation/Task/Action/Result questions "
        "about past experiences. Follow up on specifics and outcomes."
    ),
}


# --------------------------------------------------------------------------- #
# LiveKit + Deepgram env helpers
# --------------------------------------------------------------------------- #
def _require_livekit_env() -> tuple[str, str, str]:
    url = os.getenv("LIVEKIT_URL", "").strip()
    key = os.getenv("LIVEKIT_API_KEY", "").strip()
    secret = os.getenv("LIVEKIT_API_SECRET", "").strip()
    if not url or not key or not secret:
        raise RuntimeError(
            "LiveKit is not set. Add LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET "
            "to backend/.env (free tier: https://cloud.livekit.io)."
        )
    return url, key, secret


def _require_deepgram_env() -> str:
    key = os.getenv("DEEPGRAM_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "DEEPGRAM_API_KEY is not set in backend/.env "
            "(free tier: https://console.deepgram.com)."
        )
    return key


def server_url() -> str:
    """Return the LiveKit WebSocket URL. May be empty if unconfigured."""
    return os.getenv("LIVEKIT_URL", "").strip()


def mint_access_token(room_name: str, identity: str, *, ttl_seconds: int = 3600) -> tuple[str, str]:
    """Return (jwt_token, livekit_url). Raises RuntimeError if LiveKit env is missing."""
    url, api_key, api_secret = _require_livekit_env()

    # Lazy import — keeps the module importable even if the SDK isn't installed.
    from livekit.api import AccessToken, VideoGrants

    grants = VideoGrants(
        room=room_name,
        room_join=True,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    token = (
        AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_name(identity)
        .with_ttl(timedelta(seconds=ttl_seconds))
        .with_grants(grants)
        .to_jwt()
    )
    return token, url


async def ensure_room(room_name: str) -> None:
    """Best-effort room creation. Failures are logged but do not raise."""
    try:
        url, api_key, api_secret = _require_livekit_env()
    except RuntimeError:
        return

    try:
        from livekit.api import LiveKitAPI
        from livekit.api import CreateRoomRequest

        lk = LiveKitAPI(url=url, api_key=api_key, api_secret=api_secret)
        try:
            await lk.room.create_room(CreateRoomRequest(name=room_name))
        finally:
            await lk.aclose()
    except Exception as exc:  # noqa: BLE001
        logger.warning("ensure_room(%s) failed (non-fatal): %s", room_name, exc)


# --------------------------------------------------------------------------- #
# LLM-backed question generation, evaluation, feedback
# --------------------------------------------------------------------------- #
def _role_brief(role: dict) -> str:
    return (
        f"ROLE: {role.get('name')} ({role.get('level')}, {role.get('category')})\n"
        f"DESCRIPTION: {role.get('description', '')}\n"
        f"CORE SKILLS: {', '.join(role.get('core_skills', []))}\n"
        f"KEYWORDS: {', '.join(role.get('keywords', []))}"
    )


def _interview_type_block(interview_type: str) -> str:
    return TYPE_GUIDANCE.get(interview_type, TYPE_GUIDANCE["technical"])


def generate_first_question(
    *,
    role: dict,
    interview_type: str,
    resume_text: Optional[str] = None,
) -> str:
    """Return the first interview question as plain text."""
    try:
        if resume_text:
            resume_block = "CANDIDATE RESUME (truncated):\n" + resume_text[:3000]
        else:
            resume_block = "No resume provided — ask a general opening question for the role."
        user = f"""Start the mock interview.

{_interview_type_block(interview_type)}

{_role_brief(role)}

{resume_block}

Ask ONE opening question. Be brief and conversational."""
        msgs = [
            {"role": "system", "content": INTERVIEWER_SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
        q = llm_analyzer._call_chat_text(msgs, temperature=0.6, max_tokens=200)
        if not q:
            raise RuntimeError("Empty LLM response")
        return q.strip().strip('"').strip()
    except Exception as exc:  # noqa: BLE001
        logger.exception("generate_first_question failed")
        return _fallback_first_question(role, interview_type)


def generate_next_question(
    *,
    role: dict,
    interview_type: str,
    resume_text: Optional[str] = None,
    prior_turns: Optional[List[dict]] = None,
    question_index: int = 1,
    total: int = 6,
) -> str:
    """Return the next interview question, conditioned on prior Q/A."""
    prior_turns = prior_turns or []
    prior_lines = []
    for h in prior_turns[-6:]:  # cap prompt length
        role_tag = "Interviewer" if h.get("role") == "assistant" else "Candidate"
        prior_lines.append(f"{role_tag}: {h.get('text', '')[:400]}")
    prior_block = "\n".join(prior_lines) if prior_lines else "(no prior turns)"

    if resume_text:
        resume_block = "CANDIDATE RESUME (truncated):\n" + resume_text[:3000]
    else:
        resume_block = ""

    try:
        user = f"""Continue the mock interview (question {question_index + 1} of {total}).

{_interview_type_block(interview_type)}

{_role_brief(role)}

{resume_block}

CONVERSATION SO FAR:
{prior_block}

Generate the next question. It must NOT repeat any earlier question. Increase depth as the interview progresses. Return JSON only."""
        msgs = [
            {"role": "system", "content": QUESTION_GEN_SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
        data = llm_analyzer._call_chat_json(msgs, temperature=0.7, max_tokens=250)
        q = str(data.get("question", "")).strip()
        if not q:
            raise RuntimeError("Empty question from LLM")
        return q
    except Exception as exc:  # noqa: BLE001
        logger.exception("generate_next_question failed")
        return _fallback_question(role, interview_type, question_index)


def evaluate_answer(
    *,
    role: dict,
    interview_type: str,
    question: str,
    answer: str,
) -> Dict[str, Any]:
    """Score one question/answer pair. Returns a dict matching QAReviewItem."""
    try:
        user = f"""QUESTION: {question}

CANDIDATE ANSWER: {answer}

{_interview_type_block(interview_type)}

{_role_brief(role)}

Return JSON only with verdict, score, comment, suggested_answer."""
        msgs = [
            {"role": "system", "content": EVALUATE_SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
        data = llm_analyzer._call_chat_json(msgs, temperature=0.3, max_tokens=400)
        verdict = str(data.get("verdict", "ok")).strip().lower()
        if verdict not in {"strong", "ok", "needs_work"}:
            verdict = "ok"
        score = int(data.get("score", 50) or 50)
        score = max(0, min(100, score))
        return {
            "question": question,
            "answer_snippet": answer[:240],
            "verdict": verdict,
            "score": score,
            "comment": str(data.get("comment", "")).strip(),
            "suggested_answer": str(data.get("suggested_answer", "")).strip(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("evaluate_answer failed")
        return {
            "question": question,
            "answer_snippet": answer[:240],
            "verdict": "ok",
            "score": 50,
            "comment": f"Auto-evaluate unavailable: {exc}",
            "suggested_answer": "",
        }


def generate_feedback(
    *,
    role: dict,
    interview_type: str,
    turns: List[dict],
    per_q: List[dict],
) -> Dict[str, Any]:
    """Return the final InterviewFeedbackResponse dict."""
    transcript = "\n".join(
        f"{'Interviewer' if t.get('role') == 'assistant' else 'Candidate'}: {t.get('text', '')[:600]}"
        for t in turns
    )
    per_q_compact = [
        {"question": p["question"], "verdict": p["verdict"], "score": p["score"], "comment": p.get("comment", "")}
        for p in per_q
    ]
    try:
        user = f"""Summarize this mock interview.

{_interview_type_block(interview_type)}

{_role_brief(role)}

PER-QUESTION EVALUATIONS:
{json.dumps(per_q_compact, ensure_ascii=False)}

TRANSCRIPT:
{transcript}

Return JSON only matching the schema in your system prompt."""
        msgs = [
            {"role": "system", "content": FEEDBACK_SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ]
        data = llm_analyzer._call_chat_json(msgs, temperature=0.3, max_tokens=1500)

        score = data.get("score") or {}
        return {
            "score": {
                "overall": _clamp(score.get("overall", _avg(per_q))),
                "communication": _clamp(score.get("communication", _avg(per_q))),
                "technical_knowledge": _clamp(score.get("technical_knowledge", _avg(per_q))),
                "confidence": _clamp(score.get("confidence", _avg(per_q))),
            },
            "strengths": list(data.get("strengths") or []),
            "areas_for_improvement": list(data.get("areas_for_improvement") or []),
            "questions_answered_well": [
                _normalize_qa(p) for p in (data.get("questions_answered_well") or []) if p
            ],
            "questions_needing_improvement": [
                _normalize_qa(p) for p in (data.get("questions_needing_improvement") or []) if p
            ],
            "narrative_summary": str(data.get("narrative_summary") or "").strip(),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("generate_feedback failed")
        return _synthesized_feedback(per_q, exc)


def _normalize_qa(p: dict) -> Dict[str, Any]:
    verdict = str(p.get("verdict", "ok")).lower()
    if verdict not in {"strong", "ok", "needs_work"}:
        verdict = "ok"
    return {
        "question": str(p.get("question", "")).strip(),
        "answer_snippet": str(p.get("answer_snippet", ""))[:240],
        "verdict": verdict,
        "score": _clamp(p.get("score", 50)),
        "comment": str(p.get("comment", "")).strip(),
        "suggested_answer": str(p.get("suggested_answer", "")).strip(),
    }


def _synthesized_feedback(per_q: List[dict], exc: Exception) -> Dict[str, Any]:
    avg = _avg(per_q)
    well = [p for p in per_q if p.get("verdict") == "strong"]
    needs = [p for p in per_q if p.get("verdict") == "needs_work"]
    return {
        "score": {"overall": avg, "communication": avg, "technical_knowledge": avg, "confidence": avg},
        "strengths": [p["comment"] for p in well[:3]] or [f"You completed the interview."],
        "areas_for_improvement": [p["comment"] for p in needs[:3]] or [f"Try expanding on concrete examples."],
        "questions_answered_well": [_normalize_qa(p) for p in well],
        "questions_needing_improvement": [_normalize_qa(p) for p in needs],
        "narrative_summary": f"Auto-summary unavailable: {exc}. Per-question feedback is still shown below.",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def _clamp(x: Any) -> int:
    try:
        return max(0, min(100, int(x)))
    except (TypeError, ValueError):
        return 50


def _avg(per_q: List[dict]) -> int:
    if not per_q:
        return 50
    return int(round(sum(p.get("score", 50) for p in per_q) / len(per_q)))


def _fallback_first_question(role: dict, interview_type: str) -> str:
    if interview_type == "hr":
        return "Tell me a little about yourself and what draws you to this kind of role."
    if interview_type == "behavioral":
        return "Walk me through a recent project you're proud of — what was the situation, what did you do, and what was the result?"
    return f"Tell me about your experience with {role.get('core_skills', ['the role'])[0]}."


def _fallback_question(role: dict, interview_type: str, index: int) -> str:
    pool = {
        "hr": [
            "What's a teamwork situation where you disagreed with a teammate? How did you handle it?",
            "Where do you see yourself in 3-5 years?",
            "Why this role, and why now?",
            "What does good feedback look like to you?",
        ],
        "behavioral": [
            "Tell me about a time you had to learn something quickly for a project.",
            "Describe a time you made a mistake at work. What did you do next?",
            "Give me an example of when you went above and beyond.",
        ],
        "technical": [
            f"Walk me through how you'd design a small system using {role.get('core_skills', ['your main stack'])[0]}.",
            "Tell me about a technical decision you made and the trade-offs you considered.",
            "How do you debug a production issue you've never encountered?",
            f"What's a recent project where you used {role.get('core_skills', ['your main stack'])[0]}? What would you do differently?",
        ],
    }
    choices = pool.get(interview_type, pool["technical"])
    return choices[index % len(choices)]


# --------------------------------------------------------------------------- #
# WebSocket handler
# --------------------------------------------------------------------------- #
async def _ws_send(websocket: WebSocket, payload: dict) -> None:
    try:
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        logger.warning("ws send failed: %s", exc)


async def interview_ws(websocket: WebSocket, interview_id: str) -> None:
    """Audio round-trip endpoint: PCM frames in, JSON events out.

    The Deepgram live transcription runs in a background task; its events
    are pushed into an asyncio.Queue which the main control loop also reads.
    """
    await websocket.accept()
    logger.info("interview_ws open: %s", interview_id)

    # --- 1. Initial config frame ------------------------------------------
    try:
        cfg_raw = await websocket.receive_text()
        cfg = json.loads(cfg_raw)
    except (WebSocketDisconnect, json.JSONDecodeError, Exception) as exc:  # noqa: BLE001
        await _ws_send(websocket, {"type": "error", "message": f"Bad config: {exc}"})
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        return

    role_id = str(cfg.get("role_id") or "").strip()
    interview_type = str(cfg.get("interview_type") or "technical").strip()
    if interview_type not in {"hr", "technical", "behavioral"}:
        interview_type = "technical"
    try:
        question_count = max(2, min(int(cfg.get("question_count") or 6), 12))
    except (TypeError, ValueError):
        question_count = 6
    resume_text = cfg.get("resume_text") or None
    if isinstance(resume_text, str) and not resume_text.strip():
        resume_text = None

    role = roles_data.get_role(role_id)
    if not role:
        await _ws_send(websocket, {"type": "error", "message": f"Unknown role_id: {role_id}"})
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        return

    # --- 2. Deepgram live STT setup ---------------------------------------
    try:
        dg_key = _require_deepgram_env()
    except RuntimeError as exc:
        await _ws_send(websocket, {"type": "error", "message": str(exc)})
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        return

    dg = None
    dg_connection = None
    try:
        from deepgram import DeepgramClient
        from deepgram.clients.listen.v1 import LiveOptions
        from deepgram.clients.listen import LiveTranscriptionEvents
        dg = DeepgramClient(api_key=dg_key)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Deepgram init failed")
        await _ws_send(websocket, {"type": "error", "message": f"Deepgram unavailable: {exc}"})
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        return

    # Events queue — items are dicts: {"kind": "interim"|"final"|"utterance_end"|"error", "text": "..."}
    events: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _dg_callback(coro_fn):
        """Wrap an async callback so it can be registered with the 3.4.0 SDK.

        Deepgram's internal _listening() coroutine invokes these handlers via
        _emit(event, *args). To keep the queue thread-safe we schedule the work
        onto the running asyncio loop.
        """
        def _cb(*args, **kwargs):
            try:
                loop.call_soon_threadsafe(lambda: asyncio.create_task(coro_fn(*args, **kwargs)))
            except RuntimeError:
                # Loop closed (interview ending) — drop the event quietly.
                pass
        return _cb

    async def _on_dg_transcript(*args, **kwargs) -> None:
        # 3.4.0 _emit signature for Transcript: handler(self, result, **kwargs)
        result = kwargs.get("result")
        if result is None and len(args) > 1:
            result = args[1]
        if result is None:
            return
        try:
            channel = getattr(result, "channel", None)
            alternatives = getattr(channel, "alternatives", []) if channel else []
            alt = alternatives[0] if alternatives else None
            text = (getattr(alt, "transcript", "") if alt else "") or ""
            is_final = bool(getattr(result, "is_final", False))
        except Exception as exc:  # noqa: BLE001
            logger.warning("dg transcript parse error: %s", exc)
            return
        text = (text or "").strip()
        if not text:
            return
        await events.put({"kind": "final" if is_final else "interim", "text": text})

    async def _on_dg_utterance_end() -> None:
        await events.put({"kind": "utterance_end", "text": ""})

    async def _on_dg_error(*args, **kwargs) -> None:
        err = kwargs.get("error")
        if err is None and len(args) > 1:
            err = args[1]
        if err is None and args:
            err = args[0]
        logger.warning("Deepgram error: %s", err)
        await events.put({"kind": "error", "text": str(err) if err else "unknown"})

    try:
        live_options = LiveOptions(
            model="nova-2",
            language="en",
            encoding="linear16",
            sample_rate=16000,
            channels=1,
            smart_format=True,
            interim_results=True,
            endpointing=300,
            utterance_end_ms=1000,
            vad_events=True,
        )

        # 3.4.0 surface: dg.listen.asyncwebsocket.v("1") returns the async
        # client whose start()/send()/finish() are coroutines.
        dg_connection = dg.listen.asyncwebsocket.v("1")
        dg_connection.on(LiveTranscriptionEvents.Transcript, _dg_callback(_on_dg_transcript))
        dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, _dg_callback(_on_dg_utterance_end))
        dg_connection.on(LiveTranscriptionEvents.Error, _dg_callback(_on_dg_error))

        started_ok = await dg_connection.start(live_options)
        if not started_ok:
            await _ws_send(websocket, {"type": "error", "message": "Could not start Deepgram stream."})
            try:
                await websocket.close()
            except Exception:  # noqa: BLE001
                pass
            return
    except Exception as exc:  # noqa: BLE001
        logger.exception("Deepgram start failed")
        await _ws_send(websocket, {"type": "error", "message": f"Deepgram start failed: {exc}"})
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        return

    # --- 3. State + first question ----------------------------------------
    transcript: List[dict] = []
    state = "asking"  # asking | ai_thinking | paused | ended
    question_index = 0
    current_question = generate_first_question(
        role=role, interview_type=interview_type, resume_text=resume_text,
    )
    transcript.append({"role": "assistant", "text": current_question, "timestamp": time.time()})
    await _ws_send(websocket, {
        "type": "question",
        "text": current_question,
        "index": question_index,
        "total": question_count,
    })

    async def _ai_turn() -> None:
        nonlocal state, question_index, current_question
        state = "ai_thinking"
        await _ws_send(websocket, {"type": "ai_thinking"})

        msgs: List[dict] = [{"role": "system", "content": INTERVIEWER_SYSTEM_PROMPT}]
        msgs.append({
            "role": "system",
            "content": (
                f"{_interview_type_block(interview_type)}\n\n{_role_brief(role)}\n\n"
                + (f"CANDIDATE RESUME (truncated):\n{resume_text[:3000]}" if resume_text else "")
            ),
        })
        for t in transcript[-8:]:
            msgs.append({"role": t["role"], "content": t["text"]})

        try:
            text = await asyncio.wait_for(
                asyncio.to_thread(llm_analyzer._call_chat_text, msgs, temperature=0.6, max_tokens=400),
                timeout=90,
            )
            text = (text or "").strip()
        except Exception as exc:  # noqa: BLE001
            logger.exception("AI reply failed")
            await _ws_send(websocket, {"type": "ai_timeout", "message": str(exc)})
            text = "Thanks — let's move on."

        if not text:
            text = "Thanks — let's move on."

        transcript.append({"role": "assistant", "text": text, "timestamp": time.time()})
        await _ws_send(websocket, {"type": "caption", "role": "assistant", "text": text, "final": True})

        next_idx = question_index + 1
        if next_idx >= question_count:
            await _ws_send(websocket, {"type": "ai_done"})
            await _ws_send(websocket, {"type": "complete"})
            state = "ended"
            return

        nq = generate_next_question(
            role=role, interview_type=interview_type, resume_text=resume_text,
            prior_turns=transcript, question_index=next_idx, total=question_count,
        )
        question_index = next_idx
        current_question = nq
        transcript.append({"role": "assistant", "text": nq, "timestamp": time.time()})
        await _ws_send(websocket, {"type": "ai_done"})
        await _ws_send(websocket, {"type": "question", "text": nq, "index": next_idx, "total": question_count})
        state = "asking"

    # --- 4. Main loop: websocket + Deepgram queue --------------------------
    try:
        while True:
            receiver_task = asyncio.create_task(websocket.receive())
            event_task = asyncio.create_task(events.get())
            done, pending = await asyncio.wait(
                {receiver_task, event_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            # Cancel the still-pending task so the loop doesn't leak.
            for t in pending:
                t.cancel()

            # If the Deepgram queue task finished first, handle it.
            if event_task in done:
                try:
                    dg_event = event_task.result()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("event_task raised: %s", exc)
                    dg_event = None
                if isinstance(dg_event, dict):
                    kind = dg_event.get("kind")
                    text = (dg_event.get("text") or "").strip()
                    if text:
                        await _ws_send(websocket, {"type": "caption", "role": "user", "text": text, "final": kind == "final"})
                    if kind == "final" and text and state == "asking":
                        transcript.append({"role": "user", "text": text, "timestamp": time.time()})
                        await _ai_turn()
                continue

            # Otherwise the WebSocket produced a frame.
            try:
                ws_msg = receiver_task.result()
            except WebSocketDisconnect:
                logger.info("interview_ws client disconnected: %s", interview_id)
                break
            except Exception as exc:  # noqa: BLE001
                logger.warning("ws receive failed: %s", exc)
                break

            if ws_msg.get("type") != "websocket.receive":
                continue

            if "bytes" in ws_msg and ws_msg["bytes"] is not None:
                if dg_connection is not None and state == "asking":
                    try:
                        await dg_connection.send(ws_msg["bytes"])
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("send to Deepgram failed: %s", exc)
                continue

            if "text" in ws_msg and ws_msg["text"] is not None:
                try:
                    ctrl = json.loads(ws_msg["text"])
                except json.JSONDecodeError:
                    continue
                ctype = ctrl.get("type")

                if ctype == "text":
                    user_text = str(ctrl.get("text", "")).strip()
                    if user_text and state == "asking":
                        await _ws_send(websocket, {"type": "caption", "role": "user", "text": user_text, "final": True})
                        transcript.append({"role": "user", "text": user_text, "timestamp": time.time()})
                        await _ai_turn()
                elif ctype == "skip":
                    question_index += 1
                    if question_index >= question_count:
                        await _ws_send(websocket, {"type": "complete"})
                        state = "ended"
                        break
                    nq = generate_next_question(
                        role=role, interview_type=interview_type, resume_text=resume_text,
                        prior_turns=transcript, question_index=question_index, total=question_count,
                    )
                    current_question = nq
                    transcript.append({"role": "assistant", "text": nq, "timestamp": time.time()})
                    await _ws_send(websocket, {"type": "question", "text": nq, "index": question_index, "total": question_count})
                elif ctype == "pause":
                    if state == "asking":
                        state = "paused"
                        await _ws_send(websocket, {"type": "paused"})
                elif ctype == "resume":
                    if state == "paused":
                        state = "asking"
                        await _ws_send(websocket, {"type": "resumed"})
                elif ctype == "end":
                    state = "ended"
                    break

    except WebSocketDisconnect:
        logger.info("interview_ws client disconnected: %s", interview_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("interview_ws crashed: %s", exc)
        try:
            await _ws_send(websocket, {"type": "error", "message": str(exc)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        if dg_connection is not None:
            try:
                await dg_connection.finish()
            except Exception:  # noqa: BLE001
                pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        logger.info("interview_ws closed: %s", interview_id)


def new_interview_id() -> str:
    return f"iv_{uuid.uuid4().hex[:12]}"