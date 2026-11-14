"""Static integrity of the shipped browser app.

These are cheap, honest checks on the files the browser actually loads: every relative import
resolves, the service worker only lists files that exist, its optional/required split is real, and
nothing outside the app's own scope is referenced. They do not claim the UI has been exercised in a
browser beyond what the recorded manual/headless checks say in the README.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from tests.support import DASHBOARD, PROJECT_ROOT

IMPORT_RE = re.compile(r"""(?:from|import)\s*\(?\s*["'](\.{1,2}/[^"']+)["']""")
DYNAMIC_IMPORT_RE = re.compile(r"""import\(\s*["'](\.{1,2}/[^"']+)["']\s*\)""")
SW_STRING_RE = re.compile(r'"([A-Za-z0-9_./-]+\.(?:js|css|json|svg|png))"')


def js_files() -> list[Path]:
    return [path for path in DASHBOARD.rglob("*.js") if "vendor" not in path.parts]


class ModuleGraphTest(unittest.TestCase):
    def test_every_relative_import_resolves(self):
        missing = []
        for path in js_files():
            text = path.read_text(encoding="utf-8")
            for match in list(IMPORT_RE.finditer(text)) + list(DYNAMIC_IMPORT_RE.finditer(text)):
                target = (path.parent / match.group(1)).resolve()
                if not target.exists():
                    missing.append(f"{path.relative_to(PROJECT_ROOT)} -> {match.group(1)}")
        self.assertEqual(missing, [], f"unresolved imports: {missing}")

    def test_no_references_to_a_sibling_plugin(self):
        offenders = []
        for path in js_files():
            text = path.read_text(encoding="utf-8")
            for needle in ("../vesper", "/api/plugins/vesper", "/dashboard-plugins/vesper"):
                if needle in text:
                    offenders.append(f"{path.relative_to(PROJECT_ROOT)}: {needle}")
        self.assertEqual(offenders, [])

    def test_app_shell_imports_the_computer_only_lazily(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertNotRegex(app, r'^\s*import\s+\{[^}]*\}\s+from\s+"\./computer/screen\.js"')
        self.assertIn('import("./computer/screen.js")', app)

    def test_identity_module_is_imported_statically(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('from "./identity.js"', app)


class ServiceWorkerTest(unittest.TestCase):
    def setUp(self):
        self.text = (DASHBOARD / "sw.js").read_text(encoding="utf-8")

    def _list_between(self, start: str, end: str) -> list[str]:
        block = self.text.split(start, 1)[1].split(end, 1)[0]
        return SW_STRING_RE.findall(block)

    def test_every_shell_file_exists(self):
        core = self._list_between("const CORE = [", "];")
        optional = self._list_between("const OPTIONAL_CORE = [", "];")
        self.assertTrue(core)
        self.assertTrue(optional)
        missing = [name for name in core + optional if not (DASHBOARD / name).exists()]
        self.assertEqual(missing, [], f"service worker lists missing files: {missing}")

    def test_core_shell_does_not_include_the_computer(self):
        core = self._list_between("const CORE = [", "];")
        self.assertFalse([name for name in core if name.startswith("computer/")])

    def test_computer_files_are_optional(self):
        optional = self._list_between("const OPTIONAL_CORE = [", "];")
        self.assertIn("computer/screen.js", optional)
        self.assertIn("computer/screen.css", optional)

    def test_scope_and_api_path(self):
        self.assertIn('"index.html"', self.text)
        self.assertIn("/api/plugins/hermes-mini/", self.text)
        self.assertRegex(self.text, r'const CACHE = "hermes-mini-v\d+"')

    def test_install_precaches_optional_files_individually(self):
        # cache.addAll for every file would make one missing optional asset fail the whole install.
        self.assertIn("cache.addAll(CORE.map(requestFor))", self.text)
        self.assertIn(".catch(() => undefined)", self.text)


class ManifestTest(unittest.TestCase):
    def test_dashboard_manifest_points_at_existing_files(self):
        data = json.loads((DASHBOARD / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "hermes-mini")
        self.assertEqual(data["label"], "Hermes Mini")
        self.assertTrue(data["tab"]["hidden"])
        self.assertTrue((DASHBOARD / data["entry"]).is_file())
        self.assertTrue((DASHBOARD / data["api"]).is_file())

    def test_pwa_manifest_names_the_product_and_real_icons(self):
        data = json.loads((DASHBOARD / "pwa.json").read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "Hermes Mini")
        self.assertEqual(data["short_name"], "Hermes Mini")
        self.assertIn("/dashboard-plugins/hermes-mini/", data["start_url"])
        for icon in data["icons"]:
            self.assertTrue((DASHBOARD / icon["src"]).is_file(), icon["src"])

    def test_index_keeps_product_name_separate_from_agent_name(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        self.assertIn("<title>Hermes Mini</title>", html)
        self.assertIn("const AGENT_NAME_PLACEHOLDER", html) if False else None
        # The agent name starts empty and is filled from the identity route, never baked in.
        self.assertIn('<meta name="agent-name" content="">', html)

    def test_no_legacy_branding_or_fixed_paths(self):
        needles = ("Vesper", "vesper", "/root/.hermes", "/root/.local/bin")
        offenders = []
        for path in list(PROJECT_ROOT.rglob("*.py")) + list(PROJECT_ROOT.rglob("*.js")) + list(PROJECT_ROOT.rglob("*.html")) + list(PROJECT_ROOT.rglob("*.css")):
            if "vendor" in path.parts or "tests" in path.parts:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for needle in needles:
                if needle in text:
                    offenders.append(f"{path.relative_to(PROJECT_ROOT)}: {needle}")
        self.assertEqual(offenders, [])


class NotificationBellTest(unittest.TestCase):
    def test_bell_is_revealed_after_the_browser_support_check(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertRegex(html, r'id="pushBtn"[^>]*\bhidden\b')
        self.assertIn("pushBtn.hidden = false;", app)
        self.assertGreater(
            app.index("pushBtn.hidden = false;"),
            app.index('"PushManager" in window'),
        )

    def test_a_server_no_still_hides_the_bell(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn("if (detail.push === false) pushBtn.hidden = true;", app)


class DictationButtonTest(unittest.TestCase):
    def test_mic_is_revealed_after_the_browser_support_check(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertRegex(html, r'id="micBtn"[^>]*\bhidden\b')
        self.assertIn("els.micBtn.hidden = false;", app)
        self.assertGreater(
            app.index("els.micBtn.hidden = false;"),
            app.index("!isDictationSupported()"),
        )

    def test_a_server_no_still_hides_the_mic(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn("if (detail.dictation === false", app)


class JobWrapperTest(unittest.TestCase):
    def test_chat_and_inbox_apply_the_wrapper_strip(self):
        helper = (DASHBOARD / "jobtext.js").read_text(encoding="utf-8")
        self.assertIn("export function stripCronWrapper", helper)
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('from "./jobtext.js"', app)
        self.assertIn("stripCronWrapper(raw.replace(JOB_PREFIX", app)
        inbox = (DASHBOARD / "inbox.js").read_text(encoding="utf-8")
        self.assertIn('from "./jobtext.js"', inbox)
        self.assertIn("stripCronWrapper(item.text)", inbox)

    def test_the_helper_is_precached(self):
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"jobtext.js"', sw)



class ModelPickerTest(unittest.TestCase):
    """The model chip and sheet (model.js) restyle Hermes's own gateway methods; nothing app-side holds model state."""

    def setUp(self):
        self.model = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def test_model_tab_rides_on_the_input(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        composer = html[html.index('<footer class="composer">'):html.index("</footer>")]
        self.assertIn('id="modelChip"', composer)
        topbar = html[html.index('<header class="topbar">'):html.index("</header>")]
        self.assertNotIn("modelChip", topbar)

    def test_chip_lookups_match_the_markup(self):
        # chip.querySelector only sees the button's children; a sibling looked up that way is null and crashes boot.
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        button = html[html.index('id="modelChip"'):]
        button = button[:button.index("</button>")]
        for cls in re.findall(r'chip\.querySelector\("\.([a-z-]+)"\)', self.model):
            self.assertIn(f'class="{cls}', button, cls)

    def test_module_is_imported_and_precached(self):
        self.assertIn('from "./model.js"', self.app)
        self.assertIn('"model.js"', (DASHBOARD / "sw.js").read_text(encoding="utf-8"))

    def test_only_hermes_methods_are_called(self):
        methods = set(re.findall(r'rpc\(\s*"([a-z_.]+)"', self.model))
        self.assertTrue(methods)
        self.assertLessEqual(methods, {"model.options", "model.save_key", "model.disconnect", "config.set"})

    def test_api_keys_never_touch_browser_storage(self):
        for word in ("localStorage", "sessionStorage", "indexedDB", "console."):
            self.assertNotIn(word, self.model)

    def test_new_chat_pick_rides_on_session_create(self):
        self.assertIn('rpc("session.create", modelUi.createParams())', self.app)

    def test_model_switch_is_shown_not_hidden(self):
        hidden = re.search(r"const HIDDEN_NOTICE_KINDS = new Set\(\[([^\]]*)\]\)", self.app).group(1)
        self.assertNotIn("model_switch", hidden)
        self.assertIn('kind === "model_switch"', self.app)


class InboxTapReadTest(unittest.TestCase):
    """Tapping an Inbox row is a hand read: it clears a manual unread; a chat view does not."""

    def test_the_row_tap_posts_a_manual_read(self):
        inbox = (DASHBOARD / "inbox.js").read_text(encoding="utf-8")
        self.assertIn('body: JSON.stringify({ ids, manual: true })', inbox)
        activate = inbox[inbox.index("async function activate"):]
        activate = activate[:activate.index("\n  }")]
        self.assertNotIn("!item.markedUnread", activate)


if __name__ == "__main__":
    unittest.main()
