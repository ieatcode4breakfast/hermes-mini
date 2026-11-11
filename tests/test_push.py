"""Web Push: opt-in key creation, subscription validation, SSRF gates and safe degradation.

No network call is made: the sender is never started, and the HTTP post is replaced by a recorder in
the one test that inspects headers. The tests assert the rules that matter — a key exists only after
an explicit opt-in, and only known push endpoints are accepted.
"""

from __future__ import annotations

import unittest
from unittest import mock

from tests.support import DASHBOARD, DisposableHome, load_module, load_push

try:
    import fastapi  # noqa: F401 - needed to import the plugin router

    HAVE_FASTAPI = True
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False


class PushKeyTest(DisposableHome):
    def setUp(self):
        super().setUp()
        self.push = load_push()

    def test_import_and_probe_create_nothing(self):
        before = self.snapshot_tree(self.home)
        self.assertTrue(self.push.crypto_available())
        self.assertFalse(self.push.keys_exist())
        self.assertIsNone(self.push.public_key_b64url())
        self.assertEqual(self.snapshot_tree(self.home), before)

    def test_opt_in_creates_the_key_outside_the_package(self):
        key = self.push.ensure_public_key_b64url()
        self.assertTrue(key)
        self.assertTrue(self.push.keys_exist())
        key_file = self.home / "data" / "hermes-mini" / "push" / "vapid_private.pem"
        self.assertTrue(key_file.is_file())
        self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)
        # A second read is stable, not regenerated.
        self.assertEqual(self.push.public_key_b64url(), key)

    def test_notify_does_nothing_until_opted_in(self):
        before = self.snapshot_tree(self.home)
        self.assertFalse(self.push.notify("reply", "x", "y", "session", "tag"))
        self.assertEqual(self.snapshot_tree(self.home), before)

    def test_public_key_is_a_p256_point(self):
        key = self.push.ensure_public_key_b64url()
        raw = self.push.b64url_decode(key)
        self.assertEqual(len(raw), 65)
        self.assertEqual(raw[0], 0x04)


class DismissTest(DisposableHome):
    """A read chat's reply/job notification is retracted once, and only if one was actually sent."""

    def setUp(self):
        super().setUp()
        self.push = load_push()
        self.push.ensure_public_key_b64url()
        self.sent = []
        put = mock.patch.object(self.push._queue, "put_nowait", side_effect=self.sent.append)
        start = mock.patch.object(self.push, "_ensure_sender")
        put.start(); start.start()
        self.addCleanup(put.stop); self.addCleanup(start.stop)

    def test_reply_then_read_sends_one_dismiss(self):
        self.assertTrue(self.push.notify("reply", "Mini", "hi", "chat-a", "reply:chat-a"))
        stamp = self.push._read_shown()["chat-a"]
        self.assertTrue(self.push.dismiss("chat-a", stamp + 5))
        self.assertEqual(self.sent[-1]["kind"], "dismiss")
        self.assertEqual(self.sent[-1]["session_id"], "chat-a")
        # Already retracted: a second read sends nothing.
        self.assertFalse(self.push.dismiss("chat-a", stamp + 10))
        self.assertEqual(len(self.sent), 2)

    def test_read_mark_older_than_the_notification_keeps_it(self):
        self.push.notify("job", "Mini", "done", "chat-b", "job:7")
        stamp = self.push._read_shown()["chat-b"]
        self.assertFalse(self.push.dismiss("chat-b", stamp - 60))
        self.assertIn("chat-b", self.push._read_shown())

    def test_approvals_and_unnotified_chats_send_nothing(self):
        self.push.notify("approval", "Mini", "rm -rf", "chat-c", "approval:chat-c")
        self.assertFalse(self.push.dismiss("chat-c", 2_000_000_000))
        self.assertFalse(self.push.dismiss("never-notified", 2_000_000_000))
        self.assertEqual([item["kind"] for item in self.sent], ["approval"])


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class EndpointGateTest(DisposableHome):
    """The accepted push hosts are the security boundary: this route must not POST anywhere else."""

    def setUp(self):
        super().setUp()
        self.api = load_module("hermes_dashboard_plugin_hermes-mini", DASHBOARD / "plugin_api.py")

    def test_only_known_push_services_are_allowed(self):
        allowed = [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/xyz",
            "https://web.push.apple.com/QG9",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ]
        refused = [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://evil.example.com/push",
            "https://fcm.googleapis.com.evil.example.com/x",
            "https://notify.windows.com.evil.example/x",
            "",
        ]
        for endpoint in allowed:
            self.assertTrue(self.api._endpoint_allowed(endpoint), endpoint)
        for endpoint in refused:
            self.assertFalse(self.api._endpoint_allowed(endpoint), endpoint)

    def test_subscription_rejects_a_bad_key_shape(self):
        good = {
            "endpoint": "https://fcm.googleapis.com/fcm/send/abc",
            "keys": {"p256dh": "AAAA", "auth": "AAAA"},
        }
        self.assertIsNone(self.api._subscription_from_body(good, "ua"))

    def test_subscription_entry_requires_endpoint_and_keys(self):
        push = load_push()
        with self.assertRaises(ValueError):
            push.add_subscription({"endpoint": "", "keys": {}})


class VapidSubjectTest(DisposableHome):
    def setUp(self):
        super().setUp()
        self.push = load_push()

    def test_subject_prefers_configured_origin_then_request_origin(self):
        self.assertEqual(self.push.vapid_subject("https://app.example.com"), "https://app.example.com")
        settings = self.core.load_settings()
        settings["push"]["contact"] = "https://contact.example.com"
        self.core.save_settings(settings)
        self.assertEqual(self.push.vapid_subject("https://app.example.com"), "https://contact.example.com")

    def test_subject_is_https_with_a_host_and_no_identity(self):
        subject = self.push.vapid_subject()
        self.assertTrue(subject.startswith("https://"))
        self.assertGreater(len(subject), len("https://"))
        self.assertNotIn("@", subject)
        self.assertNotIn("localhost", subject)

    def test_vapid_headers_carry_the_key_and_a_subject(self):
        self.push.ensure_public_key_b64url()
        headers = self.push.vapid_headers("https://fcm.googleapis.com/x", origin="https://app.example.com")
        self.assertTrue(headers["Authorization"].startswith("vapid t="))
        self.assertIn(", k=", headers["Authorization"])
        self.assertEqual(headers["Content-Encoding"], "aes128gcm")


if __name__ == "__main__":
    unittest.main()
