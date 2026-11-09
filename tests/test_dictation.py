"""Dictation delegates to Hermes' configured speech-to-text provider.

Nothing here talks to a speech service. The route is checked to (a) call Hermes' own
``transcribe_audio`` with the uploaded file, (b) never read a provider URL or provider key of its
own, and (c) map the provider's error envelope to the app's friendly codes. The provider probe is
also checked to be passive (it installs nothing and makes no call).
"""

from __future__ import annotations

import inspect
import unittest
from unittest import mock

from tests.support import DASHBOARD, DisposableHome, ensure_hermes_on_path, load_module
from tests import images

HAVE_HERMES = ensure_hermes_on_path()

try:
    import fastapi  # noqa: F401

    HAVE_FASTAPI = True
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False


class DictationSourceTest(unittest.TestCase):
    """Static guarantees that hold even without FastAPI installed."""

    def setUp(self):
        self.source = (DASHBOARD / "plugin_api.py").read_text(encoding="utf-8")

    def test_no_hard_coded_provider_url_or_key_lookup(self):
        for needle in ("api.groq.com", "GROQ_API_KEY", "GROQ_TRANSCRIPTIONS_URL", "whisper-large-v3",
                       "api.openai.com", "XAI_API_KEY", "MISTRAL_API_KEY"):
            self.assertNotIn(needle, self.source, f"dictation still references {needle}")
        # It also must not read a secrets file itself: Hermes' resolver owns credentials.
        self.assertNotIn('".env"', self.source)
        self.assertNotIn("ENV_FILE_PATH", self.source)

    def test_route_uses_hermes_transcription(self):
        self.assertIn("from tools.transcription_tools import transcribe_audio", self.source)
        self.assertIn('transcribe_audio(path, source="hermes-mini")', self.source)

    def test_provider_probe_is_hermes_own_resolution(self):
        self.assertIn("from tools.transcription_tools import _get_provider, _load_stt_config", self.source)

    def test_upload_never_trusts_the_client_filename(self):
        self.assertIn("tempfile.mkstemp(", self.source)
        self.assertIn("_ALLOWED_AUDIO_SUFFIXES", self.source)


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
@unittest.skipUnless(HAVE_HERMES, "the Hermes source tree is not available for the real STT signature")
class DictationRouteTest(DisposableHome):
    def setUp(self):
        super().setUp()
        self.api = load_module("hermes_dashboard_plugin_hermes-mini", DASHBOARD / "plugin_api.py")

    def test_transcribe_sync_returns_the_provider_text(self):
        with mock.patch("tools.transcription_tools.transcribe_audio",
                        return_value={"success": True, "transcript": "hello world", "provider": "local"}) as call:
            result = self.api._transcribe_sync("/tmp/some-upload.webm")
        self.assertEqual(result, {"ok": True, "text": "hello world"})
        call.assert_called_once()
        # The real signature: (file_path, model=None, source=None). A plugin may not invent one.
        args, kwargs = call.call_args
        self.assertEqual(args[0], "/tmp/some-upload.webm")
        self.assertEqual(kwargs.get("source"), "hermes-mini")
        signature = inspect.signature(__import__("tools.transcription_tools", fromlist=["transcribe_audio"]).transcribe_audio)
        self.assertEqual(list(signature.parameters)[:3], ["file_path", "model", "source"])

    def test_provider_error_codes_map_to_friendly_messages(self):
        cases = {
            "No STT provider available. Install faster-whisper": "no_provider",
            "HTTP 429 rate limit": "rate_limit",
            "API key was rejected": "auth",
            "Recording is too large": "too_large",
            "Request timed out": "timeout",
            "something odd": "error",
        }
        for provider_error, expected in cases.items():
            with mock.patch("tools.transcription_tools.transcribe_audio",
                            return_value={"success": False, "error": provider_error}):
                result = self.api._transcribe_sync("/tmp/x.webm")
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], expected, provider_error)
            self.assertTrue(result["error"])

    def test_unavailable_reason_comes_from_hermes_resolution(self):
        with mock.patch("tools.transcription_tools._get_provider", return_value="none"):
            self.assertIsNotNone(self.api._dictation_unavailable_reason())
        with mock.patch("tools.transcription_tools._get_provider", return_value="local"):
            self.assertIsNone(self.api._dictation_unavailable_reason())


if __name__ == "__main__":
    unittest.main()
