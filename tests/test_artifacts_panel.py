"""The Artifacts panel (dashboard/artifacts.js): the tray button, the dialog, and the read-only module."""

from __future__ import annotations

import re
import unittest

from tests.support import DASHBOARD


class ArtifactsPanelTest(unittest.TestCase):
    def setUp(self):
        self.html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        self.js = (DASHBOARD / "artifacts.js").read_text(encoding="utf-8")
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.css = (DASHBOARD / "style.css").read_text(encoding="utf-8")

    def test_artifacts_is_a_chats_panel_row_under_schedules(self):
        drawer = self.html.split('<aside id="drawer"', 1)[1].split("</aside>", 1)[0]
        self.assertLess(drawer.index('id="schedBtn"'), drawer.index('id="artBtn"'))
        self.assertIn('id="artBtn" class="chat-row drawer-inbox drawer-art"', drawer)
        head = self.html.split('<header class="topbar">', 1)[1].split("</header>", 1)[0]
        self.assertNotIn("artBtn", head)
        self.assertEqual(self.html.count("fab fab-tray"), 3)
        self.assertNotIn("#artBtn", self.css)
        drawer_js = (DASHBOARD / "drawer.js").read_text(encoding="utf-8")
        self.assertEqual(drawer_js.count("if (schedRow) list.append(schedRow);\n      if (artRow) list.append(artRow);")
                         + drawer_js.count("if (schedRow) list.append(schedRow);\n    if (artRow) list.append(artRow);"), 2)
        # On a phone the chats panel steps aside before the panel opens.
        handler = self.app.split('els.artBtn.addEventListener("click", () => {', 1)[1].split("\n});", 1)[0]
        self.assertIn("drawerApi.isOpen() && !isDocked() ? drawerApi.close()", handler)
        # One icon, stacked layers, on the row and on the panel's own Back button.
        layers = '<path d="M12 2.5 2.5 7.25 12 12l9.5-4.75z"/>'
        self.assertIn(layers, drawer.split('id="artBtn"', 1)[1].split("</button>", 1)[0])
        self.assertIn(layers, self.html.split('id="artBack"', 1)[1].split("</button>", 1)[0])
        self.assertNotIn('<circle cx="7" cy="7" r="3.5"/>', self.html)

    def test_the_panel_is_a_dialog_with_search_and_four_tabs(self):
        self.assertIn('id="artScrim" class="scrim todo-scrim"', self.html)
        self.assertIn('id="artDialog" class="todo-dialog art-dialog"', self.html)
        self.assertIn('role="dialog" aria-modal="true" aria-labelledby="artTitle"', self.html)
        for part in ("artBack", "artTitle", "artClose", "artSearch", "artTabs", "artBody"):
            self.assertIn(f'id="{part}"', self.html)
        self.assertIn('role="tablist"', self.html)
        panel = self.html.split('id="artTabs"', 1)[1].split('id="artBody"', 1)[0]
        self.assertEqual(panel.count('role="tab"'), 4)
        self.assertEqual(panel.count('class="art-tab-count"'), 4)
        for tab in ("all", "image", "file", "link"):
            self.assertIn(f'data-tab="{tab}"', self.html)
        self.assertIn('placeholder="Search" aria-label="Search artifacts"', self.html)
        self.assertIn('id="artBody" class="art-body"', self.html)
        # The phone card rules are the to-do panel's; only the computer size is its own.
        self.assertIn(".art-dialog { width: min(calc(100vw - 32px), 720px);", self.css)

    def test_the_module_only_reads_the_artifacts_route(self):
        self.assertIn('const ARTIFACTS_API = "/api/plugins/hermes-mini/artifacts";', self.js)
        self.assertIn("api(ARTIFACTS_API)", self.js)
        # Read only: no write verb, and it never fetches by itself.
        self.assertNotIn("method:", self.js)
        self.assertNotIn("fetch(", self.js)
        for label in ("Open chat", "Copy path", "Copy link"):
            self.assertIn(f'"{label}"', self.js)
        for message in ("Couldn't load artifacts", "Loading…", "Showing the most recent items"):
            self.assertIn(message, self.js)

    def test_a_raw_path_never_reaches_an_image_source(self):
        # One assignment, to a source that is either the authenticated data URL from fetchMedia or an https URL.
        self.assertIn("httpsSource(", self.js)
        self.assertIn("entry.img.src = url;", self.js)
        self.assertEqual(len(re.findall(r"\.src\s*=", self.js)), 1)
        self.assertNotIn("img.src = item.value", self.js)
        self.assertNotIn(".src = value", self.js)
        self.assertIn("fetchMedia(entry.item.value)", self.js)

    def test_the_app_creates_the_panel_and_shares_the_chat_actions(self):
        self.assertIn('import { createArtifacts } from "./artifacts.js";', self.app)
        self.assertIn("const artifacts = createArtifacts({", self.app)
        self.assertIn("els.artBtn.addEventListener", self.app)
        # Opening it steps the other panels aside; their openers step aside for it.
        self.assertIn("void artifacts.close().then(() => inbox.close())", self.app)
        self.assertIn(".then(() => artifacts.close())", self.app)
        # A file opens the way a chat card does: one function for both.
        self.assertIn("async function openFile(path, name, card = null) {", self.app)
        self.assertIn('card.addEventListener("click", () => void openFile(path, name, card));', self.app)
        self.assertIn("  openViewer,\n  fetchMedia,\n  openFile,", self.app)
        self.assertIn(".inbox-list, .sched-list, .art-body\";", self.app)

    def test_the_service_worker_caches_the_module(self):
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        core = sw.split("const CORE = [", 1)[1].split("];", 1)[0]
        self.assertIn('"schedules.js",\n  "artifacts.js",', core)
        optional = sw.split("const OPTIONAL_CORE = [", 1)[1]
        self.assertNotIn('"artifacts.js"', optional)


if __name__ == "__main__":
    unittest.main()
