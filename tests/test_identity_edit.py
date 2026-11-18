"""The name and picture editor: saves through Hermes's profile methods, never by writing Hermes's files.
The Inbox moved from the agent's picture to its own row under the main chat."""

from __future__ import annotations

import os
import unittest

from tests import images
from tests.support import DASHBOARD, DisposableHome
from tests.test_routes import RouteTestCase


class IdentityProfileTest(DisposableHome):
    def test_default_profile_when_nothing_is_set(self):
        self.assertEqual(self.core.identity_profile(), "default")

    def test_default_profile_when_it_has_the_title(self):
        self.write_profile("ui_meta:\n  hermes-bots:\n    title: Vesper\n")
        named = self.home / "profiles" / "writer"
        os.environ["HERMES_HOME"] = str(named)
        try:
            self.assertEqual(self.core.identity_profile(), "default")
        finally:
            os.environ["HERMES_HOME"] = str(self.home)

    def test_named_serving_profile_when_the_default_has_nothing(self):
        named = self.home / "profiles" / "writer"
        named.mkdir(parents=True)
        os.environ["HERMES_HOME"] = str(named)
        try:
            self.assertEqual(self.core.identity_profile(), "writer")
        finally:
            os.environ["HERMES_HOME"] = str(self.home)

    def test_forget_uploaded_avatar_touches_only_the_apps_settings(self):
        saved = self.core.save_identity("Ada", images.png(32, 32), complete=True)
        name = saved["agent"]["avatar"]
        self.assertTrue((self.core.assets_dir() / name).is_file())
        profile = self.write_profile("ui_meta:\n  hermes-bots:\n    title: Vesper\n")
        before = profile.read_bytes()
        self.assertTrue(self.core.forget_uploaded_avatar())
        self.assertEqual(self.core.load_settings()["agent"]["avatar"], "")
        self.assertFalse((self.core.assets_dir() / name).exists())
        self.assertEqual(profile.read_bytes(), before)
        self.assertFalse(self.core.forget_uploaded_avatar())


class IdentityEditRoutesTest(RouteTestCase):
    def test_status_names_the_profile_to_edit(self):
        body = self.client.get("/api/plugins/hermes-mini/status").json()
        self.assertEqual(body["profile"], "default")

    def test_forget_upload_drops_the_app_picture(self):
        self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.png(48, 48),
            headers={"Content-Type": "image/png"},
        )
        self.assertTrue(self.client.get("/api/plugins/hermes-mini/identity").json()["has_custom_avatar"])
        response = self.client.post("/api/plugins/hermes-mini/identity/forget-upload")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["removed"])
        self.assertFalse(body["has_custom_avatar"])


class IdentityEditFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        cls.edit = (DASHBOARD / "identity-edit.js").read_text(encoding="utf-8")
        cls.html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        cls.drawer = (DASHBOARD / "drawer.js").read_text(encoding="utf-8")

    def test_saves_through_hermes_profile_methods(self):
        for method in ('"profiles.list"', '"profiles.set_asset"', '"profiles.configure"'):
            self.assertIn(method, self.edit)
        # The hermes-bots entry keeps its other fields, and the write is a compare-and-swap.
        self.assertIn('ui_meta: { "hermes-bots": { ...bots, ...patch } }', self.edit)
        self.assertIn('ui_meta_expected_revisions: { "hermes-bots": revision }', self.edit)
        self.assertIn("patch.title = name;", self.edit)
        self.assertIn('patch.imageKind = "photo";', self.edit)
        self.assertIn("/identity/forget-upload", self.edit)
        self.assertIn("await identityApi.loadStatus();", self.edit)

    def test_no_bot_wording_on_screen(self):
        dialog = self.html.split('id="identityDialog"', 1)[1].split("</div>\n\n", 1)[0]
        self.assertIn('<h2 id="identityTitle" class="rename-title identity-title">Edit profile</h2>', dialog)
        self.assertIn('<label class="identity-label" for="identityName">Name</label>', dialog)
        self.assertNotIn("bot", dialog.lower())

    def test_picture_opens_the_editor_and_the_inbox_is_a_panel_row(self):
        head = self.html.split('<header class="topbar">', 1)[1].split("</header>", 1)[0]
        self.assertIn('id="identityBtn"', head)
        self.assertNotIn('id="inboxCount"', head)
        self.assertIn('id="menuDot"', head)
        drawer = self.html.split('<aside id="drawer"', 1)[1].split("</aside>", 1)[0]
        row = drawer.split('id="inboxBtn"', 1)[1].split("</button>", 1)[0]
        self.assertIn('id="inboxCount" class="row-count"', row)
        self.assertLess(row.index(">Inbox<"), row.index('id="inboxCount"'))  # the count at the right end
        browse = self.drawer.split("function renderBrowse(", 1)[1].split("\n  function ", 1)[0]
        slot = browse.index("list.append(slot);")
        inbox = browse.index("if (inboxRow) list.append(inboxRow);", slot)
        self.assertLess(inbox, browse.index("list.append(newBtn);", slot))
        self.assertIn("createIdentityEditor({ rpc, identityApi, api, showToast });", self.app)
        self.assertIn('els.inboxBtn.addEventListener("click", toggleInbox);', self.app)

    def test_service_worker_precaches_the_module(self):
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"identity-edit.js"', sw.split("const CORE = [", 1)[1].split("];", 1)[0])


if __name__ == "__main__":
    unittest.main()
