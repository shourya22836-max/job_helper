"""Avatar Provider Abstraction Layer.

Provides a unified interface for multiple avatar providers:
- Tavus (CVR - Conversational Video Rendering)
- HeyGen (Streaming Avatar)
- Beyond Presence
- Simli
- Local fallback (3D WebGL avatar via React Three Fiber)

All secrets stay backend-only. Frontend receives only session tokens/URLs.
"""

from __future__ import annotations

import os
import logging
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, Literal, Dict, Any

import httpx

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Data types                                                                  #
# --------------------------------------------------------------------------- #
@dataclass
class AvatarSession:
    """Represents an active avatar session."""
    session_id: str
    provider: str
    # For video streaming providers (Tavus, HeyGen, etc.)
    stream_url: Optional[str] = None
    webrtc_url: Optional[str] = None
    # For local fallback
    model_url: Optional[str] = None
    # Common
    expires_at: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class AvatarConfig:
    """Configuration for avatar appearance/behavior."""
    avatar_id: Optional[str] = None
    voice_id: Optional[str] = None
    background: Optional[str] = None
    quality: Literal["low", "medium", "high", "ultra"] = "high"
    enable_lip_sync: bool = True
    enable_expressions: bool = True


# --------------------------------------------------------------------------- #
# Base Provider Interface                                                     #
# --------------------------------------------------------------------------- #
class AvatarProvider(ABC):
    """Abstract base class for avatar providers."""

    def __init__(self, api_key: str, **kwargs):
        self.api_key = api_key
        self.config = kwargs

    @abstractmethod
    async def create_session(
        self,
        config: AvatarConfig,
        *,
        replica_id: Optional[str] = None,
    ) -> AvatarSession:
        """Create a new avatar session."""
        raise NotImplementedError

    @abstractmethod
    async def close_session(self, session_id: str) -> None:
        """Close/terminate an avatar session."""
        raise NotImplementedError

    @abstractmethod
    async def send_text(self, session_id: str, text: str) -> None:
        """Send text for the avatar to speak."""
        raise NotImplementedError

    @abstractmethod
    async def interrupt(self, session_id: str) -> None:
        """Interrupt current speech."""
        raise NotImplementedError

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Return provider identifier."""
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# Provider Implementations                                                    #
# --------------------------------------------------------------------------- #
class TavusAvatar(AvatarProvider):
    """Tavus Conversational Video Rendering (CVR)."""

    def __init__(
        self,
        api_key: str,
        replica_id: str,
        base_url: str = "https://tavusapi.com/v2",
    ):
        super().__init__(api_key, replica_id=replica_id, base_url=base_url)
        self.replica_id = replica_id
        self.base_url = base_url.rstrip("/")

    @property
    def provider_name(self) -> str:
        return "tavus"

    async def create_session(
        self,
        config: AvatarConfig,
        *,
        replica_id: Optional[str] = None,
    ) -> AvatarSession:
        """Create a Tavus conversation session."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "replica_id": replica_id or self.replica_id,
            "conversation_name": f"interview-{uuid.uuid4().hex[:8]}",
            "properties": {
                "language": "english",
                "max_call_duration": 3600,
                "participant_left_timeout": 60,
                "enable_recording": False,
                "enable_transcription": True,
            },
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.base_url}/conversations",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        session_id = data.get("conversation_id") or data.get("id")
        stream_url = data.get("stream_url") or data.get("streaming_url")

        return AvatarSession(
            session_id=session_id,
            provider="tavus",
            stream_url=stream_url,
            metadata={"tavus_data": data},
        )

    async def close_session(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.delete(f"{self.base_url}/conversations/{session_id}", headers=headers)

    async def send_text(self, session_id: str, text: str) -> None:
        """Send text to Tavus conversation (Tavus uses LLM-driven conversation)."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {"text": text, "interrupt": True}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{self.base_url}/conversations/{session_id}/interact",
                headers=headers,
                json=payload,
            )

    async def interrupt(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{self.base_url}/conversations/{session_id}/interrupt",
                headers=headers,
            )


class HeyGenAvatar(AvatarProvider):
    """HeyGen Streaming Avatar."""

    def __init__(
        self,
        api_key: str,
        avatar_id: str,
        base_url: str = "https://api.heygen.com/v2",
    ):
        super().__init__(api_key, avatar_id=avatar_id, base_url=base_url)
        self.avatar_id = avatar_id
        self.base_url = base_url.rstrip("/")

    @property
    def provider_name(self) -> str:
        return "heygen"

    async def create_session(
        self,
        config: AvatarConfig,
        *,
        replica_id: Optional[str] = None,
    ) -> AvatarSession:
        """Create a HeyGen streaming session."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "avatar_id": config.avatar_id or self.avatar_id,
            "quality": config.quality,
            "voice_id": config.voice_id,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.base_url}/streaming/create",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        return AvatarSession(
            session_id=data.get("session_id"),
            provider="heygen",
            webrtc_url=data.get("webrtc_url"),
            stream_url=data.get("stream_url"),
            metadata={"heygen_data": data},
        )

    async def close_session(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{self.base_url}/streaming/close",
                headers=headers,
                json={"session_id": session_id},
            )

    async def send_text(self, session_id: str, text: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload = {"session_id": session_id, "text": text, "task_type": "repeat"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{self.base_url}/streaming/task",
                headers=headers,
                json=payload,
            )

    async def interrupt(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload = {"session_id": session_id, "task_type": "interrupt"}
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{self.base_url}/streaming/task",
                headers=headers,
                json=payload,
            )


class BeyondPresenceAvatar(AvatarProvider):
    """Beyond Presence Avatar."""

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        base_url: str = "https://api.beyondpresence.ai/v1",
    ):
        super().__init__(api_key, agent_id=agent_id, base_url=base_url)
        self.agent_id = agent_id
        self.base_url = base_url.rstrip("/")

    @property
    def provider_name(self) -> str:
        return "beyond_presence"

    async def create_session(
        self,
        config: AvatarConfig,
        *,
        replica_id: Optional[str] = None,
    ) -> AvatarSession:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "agent_id": config.avatar_id or self.agent_id,
            "voice_id": config.voice_id,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.base_url}/sessions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        return AvatarSession(
            session_id=data.get("session_id"),
            provider="beyond_presence",
            webrtc_url=data.get("webrtc_url"),
            stream_url=data.get("stream_url"),
            metadata={"bp_data": data},
        )

    async def close_session(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.delete(f"{self.base_url}/sessions/{session_id}", headers=headers)

    async def send_text(self, session_id: str, text: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload = {"session_id": session_id, "text": text}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{self.base_url}/sessions/{session_id}/speak",
                headers=headers,
                json=payload,
            )

    async def interrupt(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{self.base_url}/sessions/{session_id}/interrupt",
                headers=headers,
            )


class SimliAvatar(AvatarProvider):
    """Simli Avatar (low-latency WebRTC)."""

    def __init__(
        self,
        api_key: str,
        face_id: str,
        base_url: str = "https://api.simli.ai/v1",
    ):
        super().__init__(api_key, face_id=face_id, base_url=base_url)
        self.face_id = face_id
        self.base_url = base_url.rstrip("/")

    @property
    def provider_name(self) -> str:
        return "simli"

    async def create_session(
        self,
        config: AvatarConfig,
        *,
        replica_id: Optional[str] = None,
    ) -> AvatarSession:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "face_id": config.avatar_id or self.face_id,
            "voice_id": config.voice_id,
            "max_session_length": 3600,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.base_url}/sessions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        return AvatarSession(
            session_id=data.get("session_id"),
            provider="simli",
            webrtc_url=data.get("webrtc_url"),
            stream_url=data.get("stream_url"),
            metadata={"simli_data": data},
        )

    async def close_session(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.delete(f"{self.base_url}/sessions/{session_id}", headers=headers)

    async def send_text(self, session_id: str, text: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload = {"session_id": session_id, "text": text}
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{self.base_url}/sessions/{session_id}/speak",
                headers=headers,
                json=payload,
            )

    async def interrupt(self, session_id: str) -> None:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{self.base_url}/sessions/{session_id}/interrupt",
                headers=headers,
            )


class LocalAvatarProvider(AvatarProvider):
    """Local fallback: 3D WebGL avatar (React Three Fiber).

    This doesn't create a real session — it returns config for the frontend
    to render a local 3D avatar using AvatarScene.jsx.
    """

    def __init__(
        self,
        model_url: str = "https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb",
    ):
        super().__init__(api_key="", model_url=model_url)
        self.model_url = model_url

    @property
    def provider_name(self) -> str:
        return "local"

    async def create_session(
        self,
        config: AvatarConfig,
        *,
        replica_id: Optional[str] = None,
    ) -> AvatarSession:
        return AvatarSession(
            session_id=f"local-{uuid.uuid4().hex[:8]}",
            provider="local",
            model_url=config.avatar_id or self.model_url,
            metadata={"type": "local_3d"},
        )

    async def close_session(self, session_id: str) -> None:
        pass  # No-op for local

    async def send_text(self, session_id: str, text: str) -> None:
        pass  # Handled by frontend via data channel / browser TTS

    async def interrupt(self, session_id: str) -> None:
        pass  # Handled by frontend


# --------------------------------------------------------------------------- #
# Factory                                                                     #
# --------------------------------------------------------------------------- #
class AvatarProviderFactory:
    """Factory for creating avatar provider instances."""

    _PROVIDERS = {
        "tavus": TavusAvatar,
        "heygen": HeyGenAvatar,
        "beyond_presence": BeyondPresenceAvatar,
        "simli": SimliAvatar,
        "local": LocalAvatarProvider,
    }

    @classmethod
    def create(cls, provider_name: str, **kwargs) -> AvatarProvider:
        """Create an avatar provider instance."""
        provider_name = provider_name.lower().strip()
        if provider_name not in cls._PROVIDERS:
            available = ", ".join(cls._PROVIDERS.keys())
            raise ValueError(f"Unknown avatar provider: {provider_name}. Available: {available}")
        return cls._PROVIDERS[provider_name](**kwargs)

    @classmethod
    def create_from_env(cls) -> AvatarProvider:
        """Create provider from environment variables.

        Required env vars depend on provider:

        TAVUS:
        - AVATAR_PROVIDER=tavus
        - TAVUS_API_KEY
        - TAVUS_REPLICA_ID

        HEYGEN:
        - AVATAR_PROVIDER=heygen
        - HEYGEN_API_KEY
        - HEYGEN_AVATAR_ID

        BEYOND_PRESENCE:
        - AVATAR_PROVIDER=beyond_presence
        - BEYOND_PRESENCE_API_KEY
        - BEYOND_PRESENCE_AGENT_ID

        SIMLI:
        - AVATAR_PROVIDER=simli
        - SIMLI_API_KEY
        - SIMLI_FACE_ID

        LOCAL (fallback, no keys needed):
        - AVATAR_PROVIDER=local
        - LOCAL_AVATAR_MODEL_URL (optional)
        """
        provider = os.getenv("AVATAR_PROVIDER", "local").lower().strip()

        if provider == "tavus":
            api_key = os.getenv("TAVUS_API_KEY", "").strip()
            replica_id = os.getenv("TAVUS_REPLICA_ID", "").strip()
            if not api_key or not replica_id:
                raise RuntimeError("TAVUS_API_KEY and TAVUS_REPLICA_ID required for Tavus")
            return cls.create("tavus", api_key=api_key, replica_id=replica_id)

        elif provider == "heygen":
            api_key = os.getenv("HEYGEN_API_KEY", "").strip()
            avatar_id = os.getenv("HEYGEN_AVATAR_ID", "").strip()
            if not api_key or not avatar_id:
                raise RuntimeError("HEYGEN_API_KEY and HEYGEN_AVATAR_ID required for HeyGen")
            return cls.create("heygen", api_key=api_key, avatar_id=avatar_id)

        elif provider == "beyond_presence":
            api_key = os.getenv("BEYOND_PRESENCE_API_KEY", "").strip()
            agent_id = os.getenv("BEYOND_PRESENCE_AGENT_ID", "").strip()
            if not api_key or not agent_id:
                raise RuntimeError("BEYOND_PRESENCE_API_KEY and BEYOND_PRESENCE_AGENT_ID required")
            return cls.create("beyond_presence", api_key=api_key, agent_id=agent_id)

        elif provider == "simli":
            api_key = os.getenv("SIMLI_API_KEY", "").strip()
            face_id = os.getenv("SIMLI_FACE_ID", "").strip()
            if not api_key or not face_id:
                raise RuntimeError("SIMLI_API_KEY and SIMLI_FACE_ID required for Simli")
            return cls.create("simli", api_key=api_key, face_id=face_id)

        elif provider == "local":
            model_url = os.getenv("LOCAL_AVATAR_MODEL_URL", "").strip()
            return cls.create("local", model_url=model_url or
                "https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb")

        else:
            available = ", ".join(cls._PROVIDERS.keys())
            raise ValueError(f"Unknown avatar provider: {provider}. Available: {available}")

    @classmethod
    def available_providers(cls) -> list[str]:
        return list(cls._PROVIDERS.keys())


async def get_avatar_provider() -> AvatarProvider:
    """Get the configured avatar provider instance (cached singleton)."""
    if not hasattr(get_avatar_provider, "_instance"):
        get_avatar_provider._instance = AvatarProviderFactory.create_from_env()
    return get_avatar_provider._instance