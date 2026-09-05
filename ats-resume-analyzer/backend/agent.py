"""LiveKit Agents entrypoint for the AI mock interview (tools-based pattern).

This follows the jb-akp/LiveKit-LangGraph reference pattern:
- LangGraph workflow with tools drives the conversation
- Custom LLMAdapter wraps the graph and publishes data channel events
- Data channel publishes captions/expressions/visemes to frontend
- Frontend sends text answers, skip, pause, end via data channel

Architecture:
    mic → LiveKit room → STT (Deepgram)
                            ↓ HumanMessage
                       LangGraph workflow (LLM + tools)
                            ↓ AIMessage
                       TTS (provider-agnostic via abstraction)
                            ↓
                        LiveKit room → speakers
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, AsyncIterator, Dict, Optional

from dotenv import load_dotenv

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig

from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobProcess,
    RoomInputOptions,
    WorkerOptions,
    cli,
)
from livekit.agents.inference import TurnDetector
from livekit.plugins.deepgram import STT
from livekit.plugins.langchain import LLMAdapter
from livekit.plugins.silero import VAD
from livekit.agents.tts import TTS as LiveKitTTS, SynthesizeStream, TTSCapabilities

# Import our TTS provider abstraction
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from app.services.tts import TTSProviderFactory, preprocess_tts_text


# --------------------------------------------------------------------------- #
# LiveKit-compatible TTS wrapper for our provider abstraction                #
# --------------------------------------------------------------------------- #
class ProviderTTS(LiveKitTTS):
    """LiveKit TTS plugin that wraps our provider abstraction."""

    def __init__(self):
        super().__init__(
            capabilities=TTSCapabilities(streaming=True),
            sample_rate=24000,
            num_channels=1,
        )
        self._provider = None

    def _get_provider(self):
        if self._provider is None:
            self._provider = TTSProviderFactory.create_from_env()
        return self._provider

    def synthesize(self, text: str, *, voice_id: str | None = None, **kwargs) -> "SynthesizeStream":
        """Create a streaming synthesis."""
        provider = self._get_provider()
        # Preprocess text for the specific provider
        processed_text = preprocess_tts_text(text, provider.provider_name if hasattr(provider, 'provider_name') else 'cartesia')
        return ProviderSynthesizeStream(provider, processed_text)


class ProviderSynthesizeStream(SynthesizeStream):
    """Streaming synthesis that yields audio chunks from our provider."""

    def __init__(self, provider, text: str):
        super().__init__()
        self._provider = provider
        self._text = text
        self._task = None

    async def _run(self):
        try:
            async for chunk in self._provider.synthesize_streaming(self._text):
                if chunk.is_final:
                    break
                if chunk.audio:
                    # LiveKit expects Int16 PCM frames
                    # Our providers return float32 or raw bytes, convert as needed
                    yield chunk.audio
        except Exception as e:
            logging.getLogger(__name__).error(f"TTS streaming error: {e}")
        finally:
            await self._mark_ended()

# Importing app.* registers the FastAPI app only when uvicorn starts this file
# directly. We guard so the LiveKit CLI's import of this module never imports
# FastAPI at module-load time (which would break worker startup if FastAPI
# happened to be missing on the worker host).
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

# macOS system Python ships with an outdated CA bundle; without this, the
# LiveKit Rust client fails TLS verification against livekit.cloud and
# surfaces as `transport timed out`. certifi is already in requirements.txt.
try:
    import certifi  # type: ignore

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("SSL_CERT_DIR", os.path.dirname(certifi.where()))
except ImportError:  # pragma: no cover
    pass

logger = logging.getLogger("ats.interview.agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")


# Data-channel topic shared with the frontend
DC_TOPIC_CONTROL = "interview.control"


# --------------------------------------------------------------------------- #
# Room metadata helpers                                                       #
# --------------------------------------------------------------------------- #
def _decode_metadata(raw: Optional[str]) -> Dict[str, Any]:
    """Decode room.metadata (set by /api/interview/token) into the interview config."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (TypeError, ValueError):
        logger.warning("room.metadata is not valid JSON: %r", raw)
        return {}


def _interview_type_block(interview_type: str) -> str:
    return {
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
    }.get(interview_type, "INTERVIEW TYPE: Technical. Keep questions role-specific.")


def _role_brief(role: Dict[str, Any]) -> str:
    return (
        f"ROLE: {role.get('name')} ({role.get('level')}, {role.get('category')})\n"
        f"DESCRIPTION: {role.get('description', '')}\n"
        f"CORE SKILLS: {', '.join(role.get('core_skills', []))}\n"
        f"KEYWORDS: {', '.join(role.get('keywords', []))}"
    )


def _initial_instructions(metadata: Dict[str, Any]) -> str:
    """Build the agent's first spoken message / opening prompt."""
    role = metadata.get("role") or {}
    itype = metadata.get("interview_type") or "technical"
    resume_text = (metadata.get("resume_text") or "").strip()

    resume_block = (
        f"CANDIDATE RESUME (truncated):\n{resume_text[:3000]}"
        if resume_text
        else "No resume provided — keep questions general for the role."
    )
    return (
        "You are a senior interviewer conducting a live mock interview with the candidate.\n"
        "Speak as if in a real interview. Never break character. Be concise (1-3 sentences per turn).\n\n"
        f"{_interview_type_block(itype)}\n\n"
        f"{_role_brief(role)}\n\n"
        f"{resume_block}\n\n"
        "RULES:\n"
        "- Ask ONE question at a time.\n"
        "- Do NOT repeat earlier questions.\n"
        "- React briefly to what the candidate said before asking the next question.\n"
        "- After you have asked the configured number of questions, give a short warm closing line.\n"
        "- Output ONLY what you would say out loud — no preamble, no numbering, no JSON."
    )


# --------------------------------------------------------------------------- #
# Agent definition                                                            #
# --------------------------------------------------------------------------- #
class InterviewAgent(Agent):
    """A minimal Agent whose instructions are seeded from room metadata."""

    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


# --------------------------------------------------------------------------- #
# Entrypoint                                                                  #
# --------------------------------------------------------------------------- #
def prewarm(proc: JobProcess) -> None:
    """Prewarm is called once per worker process."""
    try:
        proc.userdata["silence"] = None
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------------------- #
# Data-channel helpers                                                        #
# --------------------------------------------------------------------------- #
async def _publish_dc(room, payload: Dict[str, Any]) -> None:
    """Publish a JSON control message to the frontend over the data channel."""
    if room is None or room.local_participant is None:
        return
    try:
        await room.local_participant.publish_data(
            json.dumps(payload),
            reliable=True,
            topic=DC_TOPIC_CONTROL,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("publish_data failed: %s", exc)


# --------------------------------------------------------------------------- #
# Emotion / viseme emission (drives the 3D avatar)                           #
# --------------------------------------------------------------------------- #
_EMOTION_KEYWORDS = {
    "encourage": [
        "great", "excellent", "wonderful", "really good", "nice", "well done",
        "love that", "impressive", "perfect", "fantastic", "good point",
        "that's a great", "thank you for", "i appreciate",
    ],
    "concern": [
        "could you clarify", "could you elaborate", "i'm not sure i follow",
        "can you be more specific", "that's a bit vague", "hmm",
        "i'm a little concerned", "not sure how that", "could you explain",
    ],
    "think": [
        "let me think", "that's interesting", "interesting", "let me see",
        "good question", "consider", "imagine", "suppose",
    ],
    "smile": [
        "welcome", "thanks for joining", "nice to meet", "glad to", "let's begin",
        "let's start", "ready", "we're all set",
    ],
}


def _classify_emotion(text: str) -> tuple[str, float]:
    """Return (label, intensity) from a chunk of agent text."""
    if not text:
        return ("neutral", 0.0)
    lower = text.lower()
    for label, kws in _EMOTION_KEYWORDS.items():
        for kw in kws:
            if kw in lower:
                return (label, 0.6)
    return ("neutral", 0.0)


async def _publish_emotion(room, label: str, intensity: float) -> None:
    """Tell the frontend the avatar's current emotion at the start of a turn."""
    await _publish_dc(room, {
        "type": "expression",
        "emotion": label,
        "intensity": float(intensity),
        "ts": asyncio.get_event_loop().time(),
    })


def _text_to_viseme_stream(text: str):
    """Yield coarse viseme frames for a chunk of text.

    We don't have phoneme-level timing from the LLM, so we synthesize a
    plausible mouth-envelope from the text's syllable density.
    """
    import time

    words = [w for w in text.split() if w.strip()]
    if not words:
        return
    frame_dt = 0.05  # 20 Hz
    idx = 0
    while idx < len(words):
        word = words[idx].strip(".,!?;:")
        vowels = sum(1 for c in word.lower() if c in "aeiouy")
        openness = min(1.0, 0.25 + 0.18 * vowels)
        if any(word.endswith(p) for p in ("?", "!")):
            openness = min(1.0, openness + 0.25)
        smile = 0.25
        brow_raise = 0.0
        yield {
            "mouthOpen": openness,
            "smile": smile,
            "browRaise": brow_raise,
            "blink": 0.0,
            "ts": time.time(),
        }
        steps = max(1, int(0.12 / frame_dt))
        for _ in range(steps - 1):
            yield {
                "mouthOpen": openness * 0.9,
                "smile": smile,
                "browRaise": 0.0,
                "blink": 0.0,
                "ts": time.time(),
            }
        if idx and idx % 7 == 0:
            yield {
                "mouthOpen": openness * 0.5,
                "smile": smile,
                "browRaise": 0.0,
                "blink": 1.0,
                "ts": time.time(),
            }
        idx += 1


async def _stream_visemes(room, text: str, *, is_active: Optional[asyncio.Event] = None) -> None:
    """Background task: send viseme frames while the agent is speaking."""
    frame_dt = 0.05  # 20 Hz
    for frame in _text_to_viseme_stream(text):
        if is_active is not None and not is_active.is_set():
            return
        if room is None:
            return
        rp = getattr(room, "local_participant", None)
        if rp is None:
            return
        try:
            await rp.publish_data(
                json.dumps({
                    "type": "viseme",
                    "mouthOpen": frame["mouthOpen"],
                    "smile": frame["smile"],
                    "browRaise": frame["browRaise"],
                    "blink": frame["blink"],
                    "ts": frame["ts"],
                }),
                reliable=True,
                topic=DC_TOPIC_CONTROL,
            )
        except Exception as exc:  # noqa: BLE001
            logger.info("viseme publish stopped: %s", exc)
            return
        try:
            await asyncio.sleep(frame_dt)
        except asyncio.CancelledError:
            return


# --------------------------------------------------------------------------- #
# Custom LLMAdapter that publishes data channel events                       #
# --------------------------------------------------------------------------- #
class InterviewLLMAdapter(LLMAdapter):
    """LLMAdapter that publishes interview events to the data channel."""

    def __init__(self, graph, room, room_active: asyncio.Event, question_count: int):
        super().__init__(graph=graph)
        self._room = room
        self._room_active = room_active
        self._question_count = question_count
        self._question_index = 0
        self._seen_ai_messages = set()

    async def astream(self, input: Any, config: Optional[RunnableConfig] = None, **kwargs) -> AsyncIterator[Any]:
        """Stream the graph output and publish events for AI messages."""
        async for chunk in super().astream(input, config, **kwargs):
            # Check if this chunk contains a new AIMessage
            if isinstance(chunk, dict) and "messages" in chunk:
                for msg in chunk["messages"]:
                    if isinstance(msg, AIMessage) and msg.content:
                        msg_id = id(msg)
                        if msg_id not in self._seen_ai_messages:
                            self._seen_ai_messages.add(msg_id)
                            await self._publish_ai_message(msg.content)
            yield chunk

    async def _publish_ai_message(self, text: str) -> None:
        """Publish AI message events to data channel."""
        # Determine if this is a closing message
        is_closing = "wrap" in text.lower() or ("thank you" in text.lower() and "interview" in text.lower())

        # Publish question event (for transcript UI)
        await _publish_dc(self._room, {
            "type": "question",
            "text": text,
            "index": self._question_index,
            "total": self._question_count,
            "closing": is_closing,
        })

        # Publish caption event
        await _publish_dc(self._room, {
            "type": "caption",
            "role": "assistant",
            "text": text,
            "final": True,
        })

        # Publish emotion for avatar
        if is_closing:
            emotion_label, emotion_intensity = ("smile", 0.7)
        else:
            emotion_label, emotion_intensity = _classify_emotion(text)
        await _publish_emotion(self._room, emotion_label, emotion_intensity)

        # Start viseme streaming for lip-sync
        if self._room is not None and getattr(self._room, "local_participant", None) \
                and (self._room_active is None or self._room_active.is_set()):
            asyncio.create_task(_stream_visemes(self._room, text, is_active=self._room_active))

        self._question_index += 1

        if is_closing:
            await _publish_dc(self._room, {"type": "complete"})


# --------------------------------------------------------------------------- #
# Entrypoint                                                                  #
# --------------------------------------------------------------------------- #
async def entrypoint(ctx: JobContext) -> None:
    """Join a LiveKit room, build the LangGraph workflow, run the voice pipeline."""
    await ctx.connect()

    metadata = _decode_metadata(ctx.room.metadata)
    if not metadata:
        logger.warning(
            "Room %s has no metadata; the interview will use generic prompts.",
            ctx.room.name,
        )

    # Import lazily so the LiveKit CLI can import this module without pulling
    # in our FastAPI app (which transitively imports everything).
    from app.interview_graph import create_workflow, new_state

    role = metadata.get("role") or {"name": "Software Engineer", "level": "Mid", "category": "engineering",
                                    "description": "", "core_skills": [], "keywords": []}
    interview_type = metadata.get("interview_type") or "technical"
    question_count = int(metadata.get("question_count") or 6)
    resume_text = metadata.get("resume_text") or None

    workflow, _initial = create_workflow(
        role=role,
        interview_type=interview_type,
        question_count=question_count,
        resume_text=resume_text,
    )

    # Wrap the compiled LangGraph runnable for the AgentSession with our custom adapter
    # that publishes data channel events for the frontend.
    room_active = asyncio.Event()
    room_active.set()
    llm = InterviewLLMAdapter(
        graph=workflow,
        room=ctx.room,
        room_active=room_active,
        question_count=question_count,
    )

    # Plugin selection — degrade gracefully when keys are missing
    stt_plugin: Optional[STT] = None
    if os.getenv("DEEPGRAM_API_KEY", "").strip():
        stt_plugin = STT(model="nova-2", language="en")

    # TTS provider abstraction — uses TTS_PROVIDER, TTS_API_KEY, TTS_VOICE_ID from env
    tts_plugin = None
    try:
        if os.getenv("TTS_API_KEY", "").strip() or os.getenv("CARTESIA_API_KEY", "").strip():
            tts_plugin = ProviderTTS()
    except Exception as exc:  # noqa: BLE001
        logger.warning("TTS provider initialization failed: %s", exc)
        tts_plugin = None

    vad_plugin = VAD.load() if hasattr(VAD, "load") else VAD()

    turn_detector = None
    try:
        turn_detector = TurnDetector()
    except Exception as exc:  # noqa: BLE001
        logger.info("TurnDetector unavailable (%s); falling back to VAD-only.", exc)

    session = AgentSession(
        stt=stt_plugin,
        llm=llm,
        tts=tts_plugin,
        vad=vad_plugin,
        turn_detection=turn_detector,
    )

    instructions = _initial_instructions(metadata)
    agent = InterviewAgent(instructions=instructions)

    # Start the session — joins the LiveKit room and drives the pipeline.
    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(),
    )

    # ------------------------------------------------------------------ #
    # Data-channel control handler (frontend → agent)                    #
    # ------------------------------------------------------------------ #
    # The frontend sends typed JSON over topic `interview.control` for:
    # - text answers (when STT isn't used)
    # - skip question
    # - pause/resume
    # - end interview
    interview_state = new_state(
        role=role,
        interview_type=interview_type,
        question_count=question_count,
        resume_text=resume_text,
    )
    closed = False
    lock = asyncio.Lock()

    def _on_room_disconnect(*_args, **_kwargs) -> None:
        room_active.clear()

    try:
        ctx.room.on("disconnected", _on_room_disconnect)
    except Exception:  # noqa: BLE001
        pass

    async def _inject_user_message(text: str) -> None:
        """Inject a HumanMessage into the graph state and invoke."""
        nonlocal interview_state, closed
        async with lock:
            if closed or interview_state.get("done"):
                return
            from langchain_core.messages import HumanMessage

            msgs = list(interview_state.get("messages", []))
            msgs.append(HumanMessage(content=text))
            interview_state["messages"] = msgs
            # Invoke the graph with updated state
            interview_state = await workflow.ainvoke(interview_state)

    def _on_data(data_packet) -> None:  # noqa: ANN001
        if data_packet is None:
            return
        topic = (getattr(data_packet, "topic", "") or "").strip()
        if topic != DC_TOPIC_CONTROL:
            return
        buf = getattr(data_packet, "data", None)
        if buf is None:
            return
        try:
            raw = bytes(buf)
        except Exception:  # noqa: BLE001
            return
        try:
            msg = json.loads(raw.decode("utf-8", errors="replace"))
        except Exception:  # noqa: BLE001
            logger.warning("control message is not valid JSON: %r", raw[:200])
            return

        mtype = (msg or {}).get("type")

        async def _ack() -> None:
            nonlocal closed
            if closed:
                return
            if mtype == "text":
                text = str(msg.get("text", "")).strip()
                if not text:
                    return
                await _inject_user_message(text)
            elif mtype == "skip":
                await _inject_user_message("(skipped)")
            elif mtype == "pause":
                pass
            elif mtype == "resume":
                pass
            elif mtype == "end":
                closed = True
                room_active.clear()
                await _publish_dc(ctx.room, {"type": "complete"})

        asyncio.create_task(_ack())

    ctx.room.on("data_received", _on_data)

    logger.info("Interview agent started for room %s", ctx.room.name)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))