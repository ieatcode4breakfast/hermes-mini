"""The app's HTTP routes: identity, settings, capabilities and the first-run flow.

These import the real ``dashboard/plugin_api.py`` and call the routes through the actual FastAPI
router, with a ``TestClient``. They need FastAPI (which Hermes ships); where it is absent the class
is skipped rather than silently passing.

Every test runs against a disposable ``HERMES_HOME``.
"""

from __future__ import annotations

import copy
import io
import json
import os
import sqlite3
import sys
import types
import unittest
from unittest import mock

from tests.support import DASHBOARD, DisposableHome, load_module

try:  # Hermes ships FastAPI; a bare harness may not
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    HAVE_FASTAPI = True
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False

from tests import images


def build_app():
    """Mount the plugin router at its real prefix on a throwaway FastAPI app."""
    module = load_module("hermes_dashboard_plugin_hermes-mini", DASHBOARD / "plugin_api.py")
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/hermes-mini")
    return app, module


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class RouteTestCase(DisposableHome):
    def setUp(self):
        super().setUp()
        self.app, self.api = build_app()
        self.client = TestClient(self.app, raise_server_exceptions=False)


class RestartCommandTest(RouteTestCase):
    def _argv(self, *extra):
        return ["hermes", "dashboard", "--no-open", "--host", "127.0.0.1", "--port", "9119", *extra]

    def test_restart_target_reads_the_dashboard_argv(self):
        with mock.patch.object(sys, "argv", self._argv()):
            self.assertEqual(self.api._restart_target(), ("127.0.0.1", "9119"))

    def test_command_kills_this_process_and_keeps_skip_build(self):
        with (
            mock.patch.object(sys, "argv", self._argv("--skip-build")),
            mock.patch.object(self.api.core, "find_hermes_executable", return_value="/usr/local/bin/hermes"),
        ):
            command = self.api._restart_all_command()
        self.assertIn("gateway restart -y --detach", command)
        self.assertIn(f"kill {os.getpid()}", command)
        self.assertIn("dashboard --no-open --port 9119 --host 127.0.0.1 --skip-build", command)

    def test_command_does_not_add_skip_build_when_absent(self):
        with (
            mock.patch.object(sys, "argv", self._argv()),
            mock.patch.object(self.api.core, "find_hermes_executable", return_value="/usr/local/bin/hermes"),
        ):
            command = self.api._restart_all_command()
        self.assertNotIn("--skip-build", command)


class DictationRouteTest(RouteTestCase):
    def test_a_recording_reaches_the_provider_through_a_temp_file(self):
        with mock.patch.object(self.api, "_transcribe_sync", return_value={"ok": True, "text": "hello"}):
            response = self.client.post(
                "/api/plugins/hermes-mini/dictate",
                content=b"x" * 200,
                headers={"content-type": "audio/webm"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "text": "hello"})


class InboxJobWrapperTest(RouteTestCase):
    def test_a_wrapped_job_preview_shows_only_the_result(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE m (id INTEGER, role TEXT, display_kind TEXT, content TEXT, session_id TEXT, "
            "timestamp REAL, display_metadata TEXT, finish_reason TEXT, tool_calls TEXT)"
        )
        conn.execute(
            "INSERT INTO m VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                1,
                "user",
                "job_delivery",
                "[Scheduled job result]\nCronjob Response: Jump reminder\n(job_id: 2c5acc839c96)\n"
                "-------------\n\nJump reminder — time to jump!\n\n"
                'To stop or manage this job, send me a new message (e.g. "stop reminder Jump reminder").',
                "home",
                1.0,
                None,
                None,
                None,
            ),
        )
        item = self.api._inbox_item(conn.execute("SELECT * FROM m").fetchone(), {})
        self.assertIsNotNone(item)
        self.assertNotIn("Cronjob Response", item["text"])
        self.assertEqual(item["text"], "Jump reminder — time to jump!")


class IdentityRoutesTest(RouteTestCase):
    def test_get_identity_is_a_pure_read(self):
        before = self.snapshot_tree(self.home)
        response = self.client.get("/api/plugins/hermes-mini/identity")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["name"], "Hermes")
        self.assertFalse(body["onboarding_complete"])
        self.assertEqual(self.snapshot_tree(self.home), before)
        self.assertFalse((self.home / "hermes-mini").exists())

    def test_status_lists_features_as_booleans(self):
        response = self.client.get("/api/plugins/hermes-mini/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        for key in ("computer", "push", "dictation", "model_configured"):
            self.assertIn(key, body["features"])
            self.assertIsInstance(body["features"][key], bool)

    def test_first_internal_save_writes_identity_outside_package(self):
        payload = images.png(64, 64)
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        # The display name always comes from Hermes; an app-side save no longer renames the agent.
        self.assertEqual(body["name"], "Hermes")
        self.assertTrue(body["onboarding_complete"])
        self.assertTrue(body["avatar_url"].startswith("/api/plugins/hermes-mini/avatar/"))

        config = self.home / "hermes-mini" / "config.yaml"
        assets = self.home / "hermes-mini" / "assets"
        self.assertTrue(config.is_file())
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(assets.iterdir())), 1)

    def test_name_only_save_is_json(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            json={"name": "Ada"},
        )
        # No picture and no saved one: the first-run completion needs one.
        self.assertEqual(response.status_code, 400)
        self.assertIn("picture", response.json()["detail"])

    def test_avatar_is_served_from_external_assets(self):
        self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.png(48, 48),
            headers={"Content-Type": "image/png"},
        )
        identity = self.client.get("/api/plugins/hermes-mini/identity").json()
        response = self.client.get(identity["avatar_url"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertTrue(response.content.startswith(b"\x89PNG"))

    def test_avatar_route_refuses_traversal_and_unknown_files(self):
        for path in ("/api/plugins/hermes-mini/avatar/..%2F..%2Fconfig.yaml",
                     "/api/plugins/hermes-mini/avatar/does-not-exist.png"):
            self.assertIn(self.client.get(path).status_code, (404, 400))


class IdentityValidationTest(RouteTestCase):
    def test_svg_upload_is_refused_by_content(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.SVG_BYTES,
            headers={"Content-Type": "image/svg+xml"},
        )
        # An image/* content type is streamed, then rejected by the byte-level check.
        self.assertEqual(response.status_code, 400)
        self.assertIn("PNG, JPEG or WebP", response.json()["detail"])

    def test_svg_masquerading_as_png_is_refused(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.SVG_BYTES,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 400)

    def test_oversize_upload_is_refused(self):
        oversized = images.png(8, 8) + b"\x00" * (9 * 1024 * 1024)
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=oversized,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 413)

    def test_too_small_image_is_refused(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.png(4, 4),
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 400)


class SettingsRoutesTest(RouteTestCase):
    def test_get_settings_reports_paths_and_no_secrets(self):
        body = self.client.get("/api/plugins/hermes-mini/settings").json()
        self.assertEqual(body["config_path"], str(self.home / "hermes-mini" / "config.yaml"))
        self.assertEqual(body["schema"], 1)
        # Nothing that looks like a credential may be exposed.
        text = json.dumps(body).lower()
        for word in ("token", "secret", "password", "api_key"):
            self.assertNotIn(word, text)

    def test_post_settings_validates_urls(self):
        bad = self.client.post("/api/plugins/hermes-mini/settings", json={"public_url": "javascript:alert(1)"})
        self.assertEqual(bad.status_code, 400)
        good = self.client.post("/api/plugins/hermes-mini/settings", json={"public_url": "https://chat.example.com"})
        self.assertEqual(good.status_code, 200)
        self.assertEqual(good.json()["public_url"], "https://chat.example.com")

    def test_home_label_roundtrip(self):
        response = self.client.post("/api/plugins/hermes-mini/settings", json={"home_label": "My desk"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/settings").json()["home_label"], "My desk")


class CapabilitiesTest(RouteTestCase):
    def test_capabilities_are_booleans_only(self):
        body = self.client.get("/api/plugins/hermes-mini/capabilities").json()
        self.assertEqual(set(body), {"computer", "push", "dictation", "model_configured"})
        for value in body.values():
            self.assertIsInstance(value, bool)

    def test_capabilities_do_not_create_push_or_desktop_state(self):
        before = self.plugin_owned()
        self.client.get("/api/plugins/hermes-mini/capabilities")
        self.client.get("/api/plugins/hermes-mini/status")
        self.assertEqual(self.plugin_owned(), before)
        self.assertFalse((self.home / "data" / "hermes-mini" / "push").exists())


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class DataRoutesTest(RouteTestCase):
    def test_todos_roundtrip_and_path(self):
        created = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Buy milk"})
        self.assertEqual(created.status_code, 200, created.text)
        items = self.client.get("/api/plugins/hermes-mini/todos").json()["items"]
        self.assertEqual([item["text"] for item in items], ["Buy milk"])
        self.assertTrue((self.home / "data" / "hermes-mini" / "todos.json").is_file())

    def test_seen_store_is_created_on_first_read_and_kept_outside_package(self):
        body = self.client.get("/api/plugins/hermes-mini/seen").json()
        self.assertIn("seen", body)
        self.assertTrue((self.home / "data" / "hermes-mini" / "seen.json").is_file())

    def test_seen_takes_the_reading_devices_push_endpoint(self):
        url = "/api/plugins/hermes-mini/seen"
        ok = self.client.put(url, json={"id": "chat-a", "at": 1_800_000_000, "endpoint": "https://fcm.googleapis.com/fcm/send/x"})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["seen"]["chat-a"], 1_800_000_000)
        self.assertEqual(self.client.put(url, json={"id": "chat-b", "at": 1_800_000_000}).status_code, 200)
        self.assertEqual(self.client.put(url, json={"id": "chat-c", "at": 1, "endpoint": 7}).status_code, 400)
        self.assertEqual(self.client.put(url, json={"id": "chat-c", "at": 1, "endpoint": "x" * 3000}).status_code, 400)

    def test_app_chats_registry_is_empty_until_a_chat_is_added(self):
        body = self.client.get("/api/plugins/hermes-mini/app-chats").json()
        self.assertEqual(body["ids"], [])
        added = self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "abc123"})
        self.assertEqual(added.status_code, 200)
        self.assertTrue(added.json()["added"])
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/app-chats").json()["ids"], ["abc123"])


class AppChatsHomeRoutesTest(RouteTestCase):
    def test_home_is_claimed_once_and_can_be_cleared(self):
        url = "/api/plugins/hermes-mini/app-chats"
        first = self.client.post(url, json={"id": "chat-a", "home": True}).json()
        self.assertEqual(first["home"], "chat-a")
        self.assertEqual(self.client.get(url).json()["home"], "chat-a")
        second = self.client.post(url, json={"id": "chat-b", "home": True}).json()
        self.assertEqual(second["home"], "chat-a")
        self.assertEqual(self.client.get(url).json()["home"], "chat-a")
        cleared = self.client.delete("/api/plugins/hermes-mini/app-chats/home")
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(self.client.get(url).json()["home"], "")

    def test_inbox_scope_uses_the_recorded_home_not_the_title(self):
        self.client.post(
            "/api/plugins/hermes-mini/app-chats", json={"id": "home", "home": True},
        )
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.executemany(
            "INSERT INTO sessions VALUES (?, ?, ?)",
            [
                ("home", "Renamed home", 0),
                ("thief", "Hermes Mini", 0),
                ("side", "Side chat", 0),
            ],
        )
        self.assertEqual(set(self.api._scope_titles(conn)), {"home"})


class HomeTargetSeedTest(RouteTestCase):
    """The one Hermes-owned value the app writes: its default scheduled-job destination."""

    def _run_seed(self, config):
        saved = []
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        module = types.ModuleType("hermes_cli.config")
        module.load_config = lambda: config
        module.save_config = lambda value: saved.append(copy.deepcopy(value))
        with mock.patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.config": module}):
            self.api._ensure_home_target()
            self.api._ensure_home_target()
        return saved

    def test_records_the_main_chat_once(self):
        saved = self._run_seed({"platforms": {}})
        self.assertEqual(len(saved), 1)
        block = saved[0]["platforms"]["hermes-mini"]
        self.assertEqual(block["home_channel"], {
            "platform": "hermes-mini",
            "chat_id": "main",
            "name": "Hermes Mini main chat",
        })
        self.assertTrue(block["enabled"])

    def test_an_existing_target_is_never_replaced(self):
        config = {"platforms": {"hermes-mini": {
            "home_channel": {"platform": "hermes-mini", "chat_id": "side"},
        }}}
        self.assertEqual(self._run_seed(config), [])
        self.assertEqual(
            config["platforms"]["hermes-mini"]["home_channel"]["chat_id"], "side",
        )


if __name__ == "__main__":
    unittest.main()
