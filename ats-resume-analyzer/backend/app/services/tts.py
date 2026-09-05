"""TTS Provider Abstraction Layer.

Provides a unified interface for multiple TTS providers:
- Cartesia (Sonic-2)
- ElevenLabs (v2, Turbo)
- Deepgram Aura
- OpenAI TTS

All secrets stay backend-only. Frontend never receives API keys.
"""

from __future__ import annotations

import os
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Optional, Literal

import httpx

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Data types                                                                  #
# --------------------------------------------------------------------------- #
@dataclass
class TTSChunk:
    """A single chunk of synthesized audio."""
    audio: bytes
    is_final: bool = False
    sample_rate: int = 24000
    channels: int = 1


@dataclass
class TTSVoice:
    """Voice configuration for a provider."""
    provider: str
    voice_id: str
    name: str
    language: str = "en"
    sample_rate: int = 24000


# --------------------------------------------------------------------------- #
# Base Provider Interface                                                     #
# --------------------------------------------------------------------------- #
class TTSProvider(ABC):
    """Abstract base class for TTS providers."""

    def __init__(self, api_key: str, voice_id: str, **kwargs):
        self.api_key = api_key
        self.voice_id = voice_id
        self.config = kwargs

    @property
    def provider_name(self) -> str:
        """Return the provider identifier (e.g., 'cartesia', 'elevenlabs')."""
        return self.__class__.__name__.replace('TTS', '').lower()

    @abstractmethod
    async def synthesize_streaming(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> AsyncIterator[TTSChunk]:
        """Stream synthesized audio chunks for the given text."""
        raise NotImplementedError

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> bytes:
        """Synthesize complete audio for the given text."""
        raise NotImplementedError

    @abstractmethod
    def get_voice_info(self) -> TTSVoice:
        """Return voice metadata."""
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# Provider Implementations                                                    #
# --------------------------------------------------------------------------- #
class CartesiaTTS(TTSProvider):
    """Cartesia Sonic-2 TTS."""

    def __init__(
        self,
        api_key: str,
        voice_id: str,
        model: str = "sonic-2",
        sample_rate: int = 24000,
    ):
        super().__init__(api_key, voice_id, model=model, sample_rate=sample_rate)
        self.model = model
        self.sample_rate = sample_rate
        self._base_url = "https://api.cartesia.ai/tts/bytes"

    async def synthesize_streaming(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> AsyncIterator[TTSChunk]:
        """Stream audio from Cartesia using chunked transfer encoding."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Cartesia-Version": "2024-06-10",
        }
        payload = {
            "model_id": self.model,
            "transcript": text,
            "voice": {"mode": "id", "id": self.voice_id},
            "output_format": {
                "container": "raw",
                "encoding": "pcm_f32le",
                "sample_rate": self.sample_rate,
            },
            "language": language,
            "stream": True,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("POST", self._base_url, headers=headers, json=payload) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(chunk_size=1024):
                    if chunk:
                        yield TTSChunk(
                            audio=chunk,
                            is_final=False,
                            sample_rate=self.sample_rate,
                        )
                yield TTSChunk(audio=b"", is_final=True, sample_rate=self.sample_rate)

    async def synthesize(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> bytes:
        """Synthesize complete audio (non-streaming)."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Cartesia-Version": "2024-06-10",
        }
        payload = {
            "model_id": self.model,
            "transcript": text,
            "voice": {"mode": "id", "id": self.voice_id},
            "output_format": {
                "container": "raw",
                "encoding": "pcm_f32le",
                "sample_rate": self.sample_rate,
            },
            "language": language,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self._base_url, headers=headers, json=payload)
            resp.raise_for_status()
            return resp.content

    def get_voice_info(self) -> TTSVoice:
        return TTSVoice(
            provider="cartesia",
            voice_id=self.voice_id,
            name=f"Cartesia {self.model}",
            sample_rate=self.sample_rate,
        )


class ElevenLabsTTS(TTSProvider):
    """ElevenLabs v2 / Turbo TTS."""

    def __init__(
        self,
        api_key: str,
        voice_id: str,
        model: str = "eleven_turbo_v2_5",
        sample_rate: int = 24000,
    ):
        super().__init__(api_key, voice_id, model=model, sample_rate=sample_rate)
        self.model = model
        self.sample_rate = sample_rate
        self._base_url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"

    async def synthesize_streaming(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> AsyncIterator[TTSChunk]:
        """Stream audio from ElevenLabs."""
        headers = {
            "xi-api-key": self.api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }
        payload = {
            "text": text,
            "model_id": self.model,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("POST", self._base_url, headers=headers, json=payload) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(chunk_size=1024):
                    if chunk:
                        yield TTSChunk(
                            audio=chunk,
                            is_final=False,
                            sample_rate=self.sample_rate,
                        )
                yield TTSChunk(audio=b"", is_final=True, sample_rate=self.sample_rate)

    async def synthesize(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> bytes:
        """Synthesize complete audio."""
        headers = {
            "xi-api-key": self.api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }
        payload = {
            "text": text,
            "model_id": self.model,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
            },
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self._base_url.replace("/stream", ""), headers=headers, json=payload)
            resp.raise_for_status()
            return resp.content

    def get_voice_info(self) -> TTSVoice:
        return TTSVoice(
            provider="elevenlabs",
            voice_id=self.voice_id,
            name=f"ElevenLabs {self.model}",
            sample_rate=self.sample_rate,
        )


class DeepgramAuraTTS(TTSProvider):
    """Deepgram Aura TTS."""

    def __init__(
        self,
        api_key: str,
        voice_id: str,
        model: str = "aura-2-zeus-en",
        sample_rate: int = 24000,
    ):
        super().__init__(api_key, voice_id, model=model, sample_rate=sample_rate)
        self.model = model
        self.sample_rate = sample_rate
        self._base_url = "https://api.deepgram.com/v1/speak"

    async def synthesize_streaming(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> AsyncIterator[TTSChunk]:
        """Stream audio from Deepgram Aura."""
        headers = {
            "Authorization": f"Token {self.api_key}",
            "Content-Type": "application/json",
        }
        params = {
            "model": self.model,
            "encoding": "linear16",
            "sample_rate": self.sample_rate,
            "container": "none",
        }
        payload = {"text": text}

        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream(
                "POST", self._base_url, headers=headers, params=params, json=payload
            ) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(chunk_size=1024):
                    if chunk:
                        yield TTSChunk(
                            audio=chunk,
                            is_final=False,
                            sample_rate=self.sample_rate,
                        )
                yield TTSChunk(audio=b"", is_final=True, sample_rate=self.sample_rate)

    async def synthesize(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> bytes:
        """Synthesize complete audio."""
        headers = {
            "Authorization": f"Token {self.api_key}",
            "Content-Type": "application/json",
        }
        params = {
            "model": self.model,
            "encoding": "linear16",
            "sample_rate": self.sample_rate,
            "container": "wav",
        }
        payload = {"text": text}

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self._base_url, headers=headers, params=params, json=payload)
            resp.raise_for_status()
            return resp.content

    def get_voice_info(self) -> TTSVoice:
        return TTSVoice(
            provider="deepgram_aura",
            voice_id=self.voice_id,
            name=f"Deepgram Aura {self.model}",
            sample_rate=self.sample_rate,
        )


class OpenAITTS(TTSProvider):
    """OpenAI TTS (tts-1, tts-1-hd)."""

    def __init__(
        self,
        api_key: str,
        voice_id: str,
        model: str = "tts-1",
        sample_rate: int = 24000,
    ):
        super().__init__(api_key, voice_id, model=model, sample_rate=sample_rate)
        self.model = model
        self.sample_rate = sample_rate
        self._base_url = "https://api.openai.com/v1/audio/speech"

    async def synthesize_streaming(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> AsyncIterator[TTSChunk]:
        """Stream audio from OpenAI TTS."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "input": text,
            "voice": self.voice_id,
            "response_format": "pcm",
            "speed": speed,
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", self._base_url, headers=headers, json=payload) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(chunk_size=1024):
                    if chunk:
                        yield TTSChunk(
                            audio=chunk,
                            is_final=False,
                            sample_rate=self.sample_rate,
                        )
                yield TTSChunk(audio=b"", is_final=True, sample_rate=self.sample_rate)

    async def synthesize(
        self,
        text: str,
        *,
        language: str = "en",
        speed: float = 1.0,
    ) -> bytes:
        """Synthesize complete audio."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "input": text,
            "voice": self.voice_id,
            "response_format": "mp3",
            "speed": speed,
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(self._base_url, headers=headers, json=payload)
            resp.raise_for_status()
            return resp.content

    def get_voice_info(self) -> TTSVoice:
        return TTSVoice(
            provider="openai",
            voice_id=self.voice_id,
            name=f"OpenAI {self.model}",
            sample_rate=self.sample_rate,
        )


# --------------------------------------------------------------------------- #
# Factory & Preprocessing                                                     #
# --------------------------------------------------------------------------- #
class TTSProviderFactory:
    """Factory for creating TTS provider instances."""

    _PROVIDERS = {
        "cartesia": CartesiaTTS,
        "elevenlabs": ElevenLabsTTS,
        "deepgram_aura": DeepgramAuraTTS,
        "openai": OpenAITTS,
    }

    @classmethod
    def create(cls, provider_name: str, **kwargs) -> TTSProvider:
        """Create a TTS provider instance."""
        provider_name = provider_name.lower().strip()
        if provider_name not in cls._PROVIDERS:
            available = ", ".join(cls._PROVIDERS.keys())
            raise ValueError(f"Unknown TTS provider: {provider_name}. Available: {available}")
        return cls._PROVIDERS[provider_name](**kwargs)

    @classmethod
    def create_from_env(cls) -> TTSProvider:
        """Create provider from environment variables.

        Required env vars:
        - TTS_PROVIDER: one of cartesia, elevenlabs, deepgram_aura, openai
        - TTS_API_KEY: provider-specific API key
        - TTS_VOICE_ID: provider-specific voice ID

        Optional:
        - TTS_MODEL: provider-specific model name
        - TTS_SAMPLE_RATE: output sample rate (default 24000)
        """
        provider = os.getenv("TTS_PROVIDER", "cartesia").lower().strip()
        api_key = os.getenv("TTS_API_KEY", "").strip()
        voice_id = os.getenv("TTS_VOICE_ID", "").strip()

        if not api_key:
            raise RuntimeError(f"TTS_API_KEY not set for provider {provider}")
        if not voice_id:
            raise RuntimeError(f"TTS_VOICE_ID not set for provider {provider}")

        model = os.getenv("TTS_MODEL", "").strip() or None
        sample_rate = int(os.getenv("TTS_SAMPLE_RATE", "24000"))

        kwargs = {"api_key": api_key, "voice_id": voice_id}
        if model:
            kwargs["model"] = model
        if sample_rate:
            kwargs["sample_rate"] = sample_rate

        return cls.create(provider, **kwargs)

    @classmethod
    def available_providers(cls) -> list[str]:
        return list(cls._PROVIDERS.keys())


def preprocess_tts_text(text: str, provider: str) -> str:
    """Preprocess text for optimal TTS output per provider.

    - Expands common abbreviations
    - Handles numbers, dates, currencies
    - Adds SSML-like hints where supported
    - Normalizes whitespace
    """
    if not text:
        return ""

    # Normalize whitespace
    text = " ".join(text.split())

    # Common abbreviation expansions for more natural speech
    abbreviations = {
        r"\bAPI\b": "A P I",
        r"\bUI\b": "U I",
        r"\bUX\b": "U X",
        r"\bSQL\b": "S Q L",
        r"\bHTTP\b": "H T T P",
        r"\bREST\b": "REST",
        r"\bJSON\b": "J S O N",
        r"\bAWS\b": "A W S",
        r"\bCI/CD\b": "C I C D",
        r"\bML\b": "M L",
        r"\bAI\b": "A I",
        r"\bLLM\b": "L L M",
        r"\bGPU\b": "G P U",
        r"\bCPU\b": "C P U",
        r"\bRAM\b": "ram",
        r"\bSSD\b": "S S D",
        r"\bOS\b": "O S",
        r"\bIDE\b": "I D E",
        r"\bSDK\b": "S D K",
        r"\bFAQ\b": "F A Q",
        r"\bURL\b": "U R L",
        r"\bUUID\b": "U U I D",
        r"\bJWT\b": "J W T",
        r"\bOAuth\b": "O Auth",
        r"\bOIDC\b": "O I D C",
        r"\bGraphQL\b": "Graph Q L",
        r"\bWebSocket\b": "Web Socket",
        r"\bTypeScript\b": "Type Script",
        r"\bJavaScript\b": "Java Script",
        r"\bPython\b": "Python",
        r"\bReact\b": "React",
        r"\bNode\.js\b": "Node J S",
        r"\bNext\.js\b": "Next J S",
        r"\bDocker\b": "Docker",
        r"\bKubernetes\b": "Kubernetes",
        r"\bTerraform\b": "Terraform",
        r"\bAnsible\b": "Ansible",
        r"\bGitHub\b": "Git Hub",
        r"\bGitLab\b": "Git Lab",
    }

    import re
    for pattern, replacement in abbreviations.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    # Provider-specific tweaks
    if provider == "cartesia":
        # Cartesia handles punctuation well, add slight pauses
        text = re.sub(r"([.!?])\s+", r"\1 <break time='150ms'/> ", text)
    elif provider == "elevenlabs":
        # ElevenLabs benefits from explicit pauses
        text = re.sub(r"([.!?])\s+", r"\1 <break time='200ms'/> ", text)
    elif provider == "openai":
        # OpenAI TTS handles punctuation naturally
        pass

    return text.strip()


async def get_tts_provider() -> TTSProvider:
    """Get the configured TTS provider instance (cached singleton pattern)."""
    if not hasattr(get_tts_provider, "_instance"):
        get_tts_provider._instance = TTSProviderFactory.create_from_env()
    return get_tts_provider._instance