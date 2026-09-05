"""LangGraph workflow driving the mock interview (tools-based pattern).

This follows the jb-akp/LiveKit-LangGraph reference pattern:
- Single LLM with tools for recording answers
- Structured system prompt defining interview flow
- Simple graph: LLM → tool_executor → LLM (or END)

The LiveKit agent wraps this with LLMAdapter for realtime STT/TTS.
"""

from __future__ import annotations

import logging
import os
from typing import Annotated, Any, Dict, Optional, Sequence

from langchain_core.messages import AIMessage, BaseMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# State                                                                       #
# --------------------------------------------------------------------------- #
class InterviewState(Dict[str, Any]):
    """Typed-shaped dict so LangGraph's reducers and our code can share it."""
    messages: Annotated[Sequence[BaseMessage], add_messages]


def _make_llm() -> ChatOpenAI:
    """OpenRouter-compatible ChatOpenAI pointed at OpenRouter."""
    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set in backend/.env")

    base_url = os.getenv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1")
    model = os.getenv("OPENAI_MODEL", "openai/gpt-4o-mini")

    return ChatOpenAI(
        api_key=api_key,
        base_url=base_url,
        model=model,
        temperature=0.7,
    )


# --------------------------------------------------------------------------- #
# Tools                                                                       #
# --------------------------------------------------------------------------- #
@tool
def record_answer_tool(question: str, answer: str) -> str:
    """Record the candidate's answer to the current question."""
    # In production, this could persist to a database
    logger.info(f"Recorded answer for question: {question[:50]}... -> {answer[:50]}...")
    return f"Answer recorded successfully for: {question[:80]}"


# --------------------------------------------------------------------------- #
# System Prompt                                                               #
# --------------------------------------------------------------------------- #
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


def _role_brief(role: Dict[str, Any]) -> str:
    return (
        f"ROLE: {role.get('name')} ({role.get('level')}, {role.get('category')})\n"
        f"DESCRIPTION: {role.get('description', '')}\n"
        f"CORE SKILLS: {', '.join(role.get('core_skills', []))}\n"
        f"KEYWORDS: {', '.join(role.get('keywords', []))}"
    )


def _build_system_prompt(
    role: Dict[str, Any],
    interview_type: str,
    question_count: int,
    resume_text: Optional[str],
) -> str:
    """Build the system prompt that defines the interview structure."""
    type_block = TYPE_GUIDANCE.get(interview_type, TYPE_GUIDANCE["technical"])
    role_block = _role_brief(role)
    resume_block = (
        f"CANDIDATE RESUME (truncated):\n{resume_text[:3000]}"
        if resume_text
        else "No resume provided — keep questions general for the role."
    )

    return (
        "You are a senior interviewer conducting a live mock interview.\n"
        "Speak as if in a real interview. Never break character. Be concise (1-3 sentences).\n\n"
        f"{type_block}\n\n"
        f"{role_block}\n\n"
        f"{resume_block}\n\n"
        f"INTERVIEW STRUCTURE: You will ask exactly {question_count} questions.\n"
        "Progress naturally from general to specific. Tailor each question to the candidate's "
        "background and the target role.\n\n"
        "RULES:\n"
        "- Ask ONE question at a time.\n"
        "- Do NOT repeat earlier questions.\n"
        "- When you receive an answer, briefly acknowledge it, then ask the NEXT question.\n"
        "- After the candidate answers, you MUST call the record_answer_tool with the question and answer.\n"
        "- After asking the final question and recording the answer, give a warm closing line and end.\n"
        "- Your output must be ONLY what you would say out loud — no preamble, no numbering, no JSON.\n"
    )


# --------------------------------------------------------------------------- #
# Graph Nodes                                                                 #
# --------------------------------------------------------------------------- #
def _build_graph():
    """Build the StateGraph with LLM + tool routing."""

    tools = [record_answer_tool]

    def call_llm(state: InterviewState) -> InterviewState:
        """Invoke the LLM with the current message history."""
        llm = _make_llm().bind_tools(tools)

        # Extract config from state (stashed during create_workflow)
        config = state.get("_config", {})
        system_prompt = config.get("system_prompt", "")

        msgs = [SystemMessage(content=system_prompt)] + list(state.get("messages", []))
        message = llm.invoke(msgs)
        return {"messages": [message]}

    def tool_executor(state: InterviewState) -> InterviewState:
        """Execute any tool calls from the last AIMessage."""
        last_message = state["messages"][-1]
        if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
            return {}

        results = []
        for tool_call in last_message.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call.get("args", {})

            if tool_name == "record_answer_tool":
                result = record_answer_tool.invoke(tool_args)
            else:
                result = f"Unknown tool: {tool_name}"

            tool_message = ToolMessage(
                tool_call_id=tool_call["id"],
                name=tool_name,
                content=str(result),
            )
            results.append(tool_message)

        return {"messages": results}

    def route_after_llm(state: InterviewState) -> str:
        """Route to tool_executor if LLM made tool calls, otherwise END."""
        last_message = state["messages"][-1]
        if isinstance(last_message, AIMessage) and last_message.tool_calls:
            return "tool_executor"
        return END

    graph = StateGraph(InterviewState)
    graph.add_node("llm", call_llm)
    graph.add_node("tool_executor", tool_executor)

    graph.set_entry_point("llm")
    graph.add_conditional_edges(
        "llm",
        route_after_llm,
        {"tool_executor": "tool_executor", END: END},
    )
    graph.add_edge("tool_executor", "llm")

    return graph


# --------------------------------------------------------------------------- #
# Public Factory                                                              #
# --------------------------------------------------------------------------- #
def create_workflow(
    *,
    role: Dict[str, Any],
    interview_type: str,
    question_count: int,
    resume_text: Optional[str],
):
    """Return a compiled LangGraph runnable for one interview.

    The caller (LiveKit agent) will:
      1. Invoke it once with empty state to get the first question (AIMessage).
      2. For each candidate answer, append a HumanMessage and invoke again.
      3. Read the next AIMessage and stream it to TTS / data channel.
    """
    graph = _build_graph()
    compiled = graph.compile()

    # Build the system prompt once
    system_prompt = _build_system_prompt(
        role=role,
        interview_type=interview_type,
        question_count=question_count,
        resume_text=resume_text,
    )

    # Stash config in initial state
    initial_state: InterviewState = {
        "messages": [],
        "_config": {
            "system_prompt": system_prompt,
            "role": role,
            "interview_type": interview_type,
            "question_count": question_count,
            "resume_text": resume_text,
        },
    }

    class _BoundWorkflow:
        def __init__(self, runnable, initial: InterviewState):
            self._runnable = runnable
            self._initial = initial

        async def ainvoke(self, state: Optional[InterviewState] = None):
            # Merge config into incoming state
            if state is not None:
                state = dict(state)
                state["_config"] = self._initial["_config"]
            return await self._runnable.ainvoke(state if state is not None else self._initial)

        async def astream(self, state: Optional[InterviewState] = None, *, stream_mode="values"):
            if state is not None:
                state = dict(state)
                state["_config"] = self._initial["_config"]
            async for chunk in self._runnable.astream(
                state if state is not None else self._initial,
                stream_mode=stream_mode,
            ):
                yield chunk

    return _BoundWorkflow(compiled, initial_state), initial_state


def new_state(
    *,
    role: Dict[str, Any],
    interview_type: str,
    question_count: int,
    resume_text: Optional[str],
) -> InterviewState:
    """Create initial state for a new interview (without compiling graph)."""
    system_prompt = _build_system_prompt(
        role=role,
        interview_type=interview_type,
        question_count=question_count,
        resume_text=resume_text,
    )
    return {
        "messages": [],
        "_config": {
            "system_prompt": system_prompt,
            "role": role,
            "interview_type": interview_type,
            "question_count": question_count,
            "resume_text": resume_text,
        },
    }