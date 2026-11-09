"""The app's HTTP routes: identity, settings, capabilities and the first-run flow.

These import the real ``dashboard/plugin_api.py`` and call the routes through the actual FastAPI
router, with a ``TestClient``. They need FastAPI (which Hermes ships); where it is absent the class
is skipped rather than silently passing.

Every test runs against a disposable ``HERMES_HOME``.
"""

from __future__ import annotations

import io
import json
import unittest

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

    def test_app_chats_registry_is_empty_until_a_chat_is_added(self):
        body = self.client.get("/api/plugins/hermes-mini/app-chats").json()
        self.assertEqual(body["ids"], [])
        added = self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "abc123"})
        self.assertEqual(added.status_code, 200)
        self.assertTrue(added.json()["added"])
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/app-chats").json()["ids"], ["abc123"])


if __name__ == "__main__":
    unittest.main()
