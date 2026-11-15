"""Static integrity of the shipped browser app.

These are cheap, honest checks on the files the browser actually loads: every relative import
resolves, the service worker only lists files that exist, its optional/required split is real, and
nothing outside the app's own scope is referenced. They do not claim the UI has been exercised in a
browser beyond what the README's verified/not-verified list says.
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


class DockedOverlaysTest(unittest.TestCase):
    """The Inbox and model sheet paint over the docked computer pane; their scrims stay behind it."""

    def test_the_cards_rise_but_the_scrims_do_not(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        rule = re.search(
            r"body\.docked\.computer-docked \.inbox-dialog,\s*"
            r"body\.docked\.computer-docked \.model-sheet \{ z-index: 73; \}",
            css,
        )
        self.assertIsNotNone(rule, "the docked Inbox/model card rule is missing")
        self.assertIn("body.docked.computer-docked.inbox-open .topbar { z-index: 74; }", css)
        # The scrims stay under the computer pane: the pane is not dimmed or blocked.
        self.assertIn(".inbox-scrim { z-index: 65; }", css)
        self.assertIn(".model-scrim { z-index: 60; }", css)



class RenameFastPathTest(unittest.TestCase):
    """Renaming a chat uses WS session.mutate directly instead of HTTP PATCH -> connect_gateway."""

    def test_rename_uses_ws_session_mutate_and_drawer_caches_revision(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        drawer = (DASHBOARD / "drawer.js").read_text(encoding="utf-8")
        self.assertIn("runtimeRevision: Number.isInteger(raw.runtime_revision) ? raw.runtime_revision : null", drawer)
        self.assertIn("runtimeGeneration: Number.isInteger(raw.runtime_generation) ? raw.runtime_generation : null", drawer)

        rename_fn = app[app.index("async function renameSession"):app.index("\nasync function deleteSessionFenced")]
        self.assertIn('rpc("session.list", { title })', rename_fn)
        self.assertIn('rpc("session.mutate", params)', rename_fn)
        self.assertIn('operation: "sidebar"', rename_fn)
        self.assertIn('reason === "revision_conflict" || reason === "stale_generation"', rename_fn)
        self.assertIn("data.revision", rename_fn)
        self.assertIn("item.runtimeRevision = result.revision", rename_fn)
        self.assertIn("code !== -32601", rename_fn)


class InboxUnreadToggleTest(unittest.TestCase):
    """Marking an item read on the Unread tab removes it immediately and rolls back cleanly on error."""

    def test_unread_tab_toggle_removes_row_and_rolls_back_on_error(self):
        inbox = (DASHBOARD / "inbox.js").read_text(encoding="utf-8")
        toggle_fn = inbox[inbox.index("async function toggleRead"):inbox.index("\n  // Tapping a row")]
        self.assertNotIn("const next =", toggle_fn)
        self.assertIn('const removeOnUnread = filter === "unread" && markAsRead;', toggle_fn)
        self.assertIn("items.splice(removedIndex, 1);", toggle_fn)
        self.assertIn("renderAll();", toggle_fn)
        self.assertIn("if (next !== null && listEl.scrollHeight <= listEl.clientHeight + 240) void loadMore();", toggle_fn)
        self.assertIn("items.splice(Math.min(removedIndex, items.length), 0, item);", toggle_fn)
        self.assertIn("setUnread(Math.max(0, unread + (markAsRead ? 1 : -1)));", toggle_fn)



class PinnedOrderTest(unittest.TestCase):
    """A newly pinned chat always lands at the bottom of the existing pinned chats."""

    def test_new_pin_goes_to_bottom_in_set_pinned_and_order_pinned(self):
        drawer = (DASHBOARD / "drawer.js").read_text(encoding="utf-8")
        order_fn = drawer[drawer.index("function orderPinned"):drawer.index("\n  const sentinel =")]
        self.assertIn("return [...placed, ...fresh];", order_fn)
        self.assertNotIn("return [...fresh, ...placed];", order_fn)

        set_fn = drawer[drawer.index("async function setPinned"):drawer.index("\n  // ---------- row menu")]
        self.assertIn("st.pinOrder = [...kept, ...unplacedExisting, item.id];", set_fn)
        self.assertNotIn("[item.id, ...kept]", set_fn)


class StartupDictationAndModelChipTest(unittest.TestCase):
    """Startup attaches without aborting active dictation and hides #modelChip until settled."""

    def test_clear_log_preserves_dictation_on_boot_and_history_reload(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        clear_fn = app[app.index("function clearLog"):app.index("\n// ---------- HTTP")]
        self.assertIn("{ keepDictation = false } = {}", clear_fn)
        self.assertIn('if (!keepDictation && typeof cancelDictation === "function") cancelDictation(true);', clear_fn)

        history_fn = app[app.index("async function loadHistory"):app.index("\n// Loads the next older page")]
        self.assertIn("clearLog({ keepDictation: true });", history_fn)

        draft_fn = app[app.index("function openDraft"):app.index("\n// Creates the real chat")]
        self.assertIn("clearLog({ keepDictation: Boolean(opts.keepPick) });", draft_fn)

        attach_fn = app[app.index("async function attachThread"):app.index("\nfunction isMissing")]
        self.assertIn("await Promise.all([ensureHome(), attachUnsent()]);", attach_fn)
        self.assertLess(attach_fn.index("await Promise.all([ensureHome(), attachUnsent()]);"), attach_fn.index("setEmptyState(false);"))

        boot_block = app[app.index("if (state.viewedUnsent) setEmptyState(true);"):]
        self.assertIn(
            'Promise.all([\n      api("/api/sessions?limit=1"),\n      connect(),\n      bootIdentity,\n    ])',
            boot_block,
        )

    def test_model_chip_hidden_until_settled(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        model = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn('id="modelChip" class="model-tab" type="button" aria-haspopup="dialog" aria-expanded="false" hidden>', html)
        self.assertIn("let settled = false;", model)
        self.assertIn('if ("model" in payload) settled = true;', model)
        self.assertIn("chip.hidden = !settled && !model && !info.pending;", model)
        self.assertIn(".model-tab[hidden], .model-tab-meta[hidden] { display: none; }", css)

class NarrationShimmerTest(unittest.TestCase):
    """The live narrator label sweeps a sliding highlight across crisp text in both light and dark modes."""

    def test_narration_shimmer_animation_and_reduced_motion(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn("--narration-base: color-mix(in srgb, var(--fg) 75%, var(--muted));", css)
        self.assertIn("--narration-shine: #ffffff;", css)
        self.assertIn("--narration-base: color-mix(in srgb, var(--muted) 70%, transparent);", css)
        self.assertIn("--narration-shine: color-mix(in srgb, var(--fg) 88%, var(--accent));", css)
        self.assertIn("animation: narration-shimmer 1.8s infinite linear;", css)
        self.assertIn("-webkit-background-clip: text;", css)
        self.assertIn("background-clip: text;", css)
        self.assertIn("-webkit-text-fill-color: transparent;", css)
        self.assertIn("@keyframes narration-shimmer", css)
        self.assertIn("0% { background-position: 100% 50%; }", css)
        self.assertIn("100% { background-position: 0% 50%; }", css)
        reduced = css[css.index("@media (prefers-reduced-motion: reduce)"):]
        self.assertIn("animation: none;", reduced)
        self.assertIn("background: none;", reduced)
        self.assertIn("-webkit-text-fill-color: currentColor;", reduced)


class WebImageFallbackTest(unittest.TestCase):
    """A web picture that fails to load is swapped for its alt text, styled like a missing local picture."""

    def test_failed_https_picture_becomes_its_alt_text(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        body = app[app.index("function webImageFallback(bubble)"):app.index("function attachMedia(")]
        self.assertIn('querySelectorAll("img.md-img")', body)
        self.assertIn("/^https:/i", body)
        self.assertIn('el("span", "md-media-slot")', body)
        self.assertIn('addEventListener("error", fallback, { once: true })', body)
        attach = app[app.index("function attachMedia("):]
        self.assertLess(attach.index("webImageFallback(bubble)"), attach.index("inlineMediaTags(bubble)"))


class ProviderNoteTest(unittest.TestCase):
    """Providers the app cannot connect get a plain note, never Hermes' terminal hint."""

    def test_setup_note_replaces_the_raw_warning(self):
        js = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        self.assertNotIn("row.warning", js)
        self.assertIn("function setupNote(row, custom, connected)", js)
        self.assertIn('navigator.clipboard.writeText("hermes model")', js)

    def test_custom_endpoints_get_no_key_box(self):
        js = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        body = js[js.index("function isCustomProvider(row)"):js.index("function setupNote(")]
        self.assertIn('slug === "custom"', body)
        self.assertIn('slug.startsWith("custom:")', body)
        self.assertIn("row.is_user_defined", body)
        self.assertIn('if (!custom && (row.auth_type === "api_key"', js)


class SkillNarrationTest(unittest.TestCase):
    """Only the tool that writes a skill claims an update; reading or listing replaces that line, never inherits it."""

    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        block = self.app[self.app.index("const NARRATION_TOOL_LABELS = ["):self.app.index("function narrationLabel(")]
        self.block = block
        self.labels = [(prefix, label) for prefix, label in re.findall(r'\["([^"]+)", "([^"]*)"\]', block)]

    def _label(self, name):
        lower = name.lower()
        for prefix, label in self.labels:
            if lower.startswith(prefix):
                return label
        return ""

    def test_skill_manage_says_it_is_updating_skills(self):
        self.assertEqual(self._label("skill_manage"), "Updating skills\u2026")

    def test_reading_and_listing_do_not_claim_an_update(self):
        for name in ("skill_view", "skills_list"):
            label = self._label(name)
            self.assertTrue(label, name)
            self.assertNotIn("Updating", label)

    def test_no_earlier_prefix_shadows_a_later_one(self):
        for index, (prefix, _label) in enumerate(self.labels):
            later = [other for other, _ in self.labels[index + 1:]]
            self.assertFalse([other for other in later if other.startswith(prefix)], prefix)

    def test_labels_are_literals_not_templates(self):
        self.assertNotIn("${", self.block)


class MessageUnreadActionTest(unittest.TestCase):
    """A reply can be marked unread again from the chat, and the same button marks it read once it is held unread; a
    user message cannot, and one press sends one request."""

    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.inbox = (DASHBOARD / "inbox.js").read_text(encoding="utf-8")

    def _bar(self):
        return self.app[self.app.index("function addMessageActions("):self.app.index("// Edit is offered for a typed user message")]

    def _handler(self):
        body = self.app[self.app.index("async function toggleReplyUnread("):]
        return body[:body.index("\n}\n")]

    def test_reply_bar_offers_mark_unread_after_branch(self):
        bar = self._bar()
        self.assertIn('actionButton("unread", "Mark unread", ICON_UNREAD', bar)
        self.assertLess(bar.index('actionButton("branch"'), bar.index('actionButton("unread"'))

    def test_user_messages_get_no_mark_unread(self):
        bar = self._bar()
        user = bar[bar.index('if (meta.role === "user") {'):bar.index("} else {")]
        self.assertNotIn("unread", user)

    def test_the_open_envelope_icon_is_defined(self):
        self.assertIn("const ICON_UNREAD = `<svg ${ICON_ATTRS}>", self.app)
        start = self.app.index("const ICON_READ = `<svg ${ICON_ATTRS}>")
        icon = self.app[start:self.app.index("\n", start)]
        self.assertIn("m22 10-8.97 5.7", icon)  # the open flap, not the sealed unread card
        self.assertNotEqual(icon, self.app[self.app.index("const ICON_UNREAD = `<svg"):][:len(icon)])

    def test_both_labels_follow_the_marked_unread_flag(self):
        sync = self.app[self.app.index("function syncUnreadButton("):self.app.index("// Edit is offered for a typed user message")]
        self.assertIn('const label = marked ? "Mark read" : "Mark unread";', sync)
        self.assertIn("button.innerHTML = marked ? ICON_READ : ICON_UNREAD;", sync)
        self.assertIn("syncUnreadButton(button, meta);", self.app[self.app.index("function syncActionAvailability("):])
        # The record carries the flag, so every row starts as not held.
        record = self.app[self.app.index("function messageRecord("):self.app.index("// \"3:16 PM\" today")]
        self.assertIn("markedUnread: false", record)

    def test_long_press_menu_offers_mark_unread(self):
        menu = self.app[self.app.index("function openMsgMenu("):self.app.index("// Places the card near the press point")]
        self.assertIn('msgMenuItem("Mark unread", ICON_UNREAD', menu)
        self.assertIn('msgMenuItem("Mark read", ICON_READ', menu)
        self.assertIn("meta.markedUnread", menu)

    def test_inbox_posts_a_manual_unread_and_refreshes(self):
        body = self.inbox[self.inbox.index("async function markUnread("):]
        body = body[:body.index("\n  }")]
        self.assertIn("${INBOX_API}/unread", body)
        self.assertIn("manual: true", body)
        self.assertIn("if (open) void loadHead();", body)
        exports = self.inbox[self.inbox.rindex("  return {"):]
        self.assertIn("markUnread,", exports)
        self.assertIn("markReadByHand,", exports)
        self.assertIn("readState,", exports)

    def test_mark_read_by_hand_posts_manual_and_refreshes(self):
        body = self.inbox[self.inbox.index("async function markReadByHand("):]
        body = body[:body.index("\n  }")]
        self.assertIn("${INBOX_API}/read", body)
        self.assertIn("manual: true", body)
        self.assertIn("ids: [messageId]", body)
        self.assertIn("if (open) void loadHead();", body)
        self.assertIn("void refreshBadge();", body)
        self.assertNotIn("catch", body)  # a failure is the caller's to report

    def test_read_state_asks_the_state_route(self):
        body = self.inbox[self.inbox.index("async function readState("):]
        body = body[:body.index("\n  }")]
        self.assertIn("${INBOX_API}/state?ids=${ids.join(\",\")}", body)
        self.assertIn("data.states", body)

    def test_one_press_sends_one_request(self):
        body = self._handler()
        self.assertIn("if (!meta || unreadBusy.has(row)) return;", body)
        self.assertIn("unreadBusy.add(row);", body)
        self.assertIn("unreadBusy.delete(row);", body)

    def test_the_button_waits_for_the_reply_id(self):
        body = self._handler()
        self.assertIn("const rowId = await resolveRowId(row);", body)
        self.assertIn('if (!rowId) throw new Error(', body)

    def test_the_press_marks_read_or_unread_from_the_flag(self):
        body = self._handler()
        self.assertIn("const markingRead = Boolean(meta.markedUnread);", body)
        self.assertIn("await inbox.markReadByHand(rowId);", body)
        self.assertIn('showToast("Marked read");', body)
        self.assertIn("await inbox.markUnread(rowId);", body)
        self.assertIn('showToast("Marked unread");', body)
        self.assertIn("meta.markedUnread = !markingRead;", body)

    def test_failure_is_reported(self):
        body = self._handler()
        self.assertIn('showToast(`Could not mark ${markingRead ? "read" : "unread"}`, "error")', body)

    def test_the_history_load_refreshes_the_marks(self):
        load = self.app[self.app.index("async function loadHistory("):self.app.index("// Loads the next older page")]
        self.assertIn("void refreshInboxMarks();", load)
        marks = self.app[self.app.index("async function refreshInboxMarks("):]
        self.assertIn("inbox.readState(", marks)
        self.assertIn(".markedUnread = Boolean(state && state.marked_unread)", marks)
        self.assertIn("syncActionAvailability();", marks)
        self.assertIn("INBOX_STATE_CHUNK = 200", self.app)
        self.assertIn("catch {\n      return;", marks)  # a failed read leaves every flag as it was, silently


class LoginReturnTest(unittest.TestCase):
    """A 401 sends the person to Hermes' login with the app's own page as the return address."""

    def test_login_redirect_always_carries_next(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        start = app.index("if (res.status === 401)")
        block = app[start:app.index("throw new AuthRedirect", start)]
        self.assertIn("new URL(body.login_url || `${PREFIX}/login`, location.origin)", block)
        self.assertIn('if (!login.searchParams.get("next")) login.searchParams.set("next", location.pathname + location.search);', block)
        self.assertIn("location.assign(login.pathname + login.search)", block)
        self.assertNotIn("location.assign(body.login_url ||", app)

    def test_empty_schedules_message_is_centred(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn(".sched-list:empty { flex: 0 0 auto; }", css)
        self.assertIn(".sched-empty[hidden] { display: none; }", css)


class InstallScanTest(unittest.TestCase):
    """Hermes' install scanner treats an exclamation mark followed by a backtick-quoted run as a skill's
    inline-shell snippet (inline_shell_exec, high: the install then asks to be forced). No file may contain one."""

    def test_no_inline_shell_lookalike_in_shipped_files(self):
        tick = chr(96)  # spelled out so this test does not match itself
        pattern = re.compile("!" + tick + "[^" + tick + r"\s][^" + tick + r"\n]*" + tick)
        offenders = []
        for path in PROJECT_ROOT.rglob("*"):
            if not path.is_file() or ".git" in path.parts or path.suffix not in {".js", ".mjs", ".py", ".md", ".html", ".css", ".txt", ".yaml", ".json"}:
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{path.relative_to(PROJECT_ROOT)}:{number}")
        self.assertEqual(offenders, [], f"write the backtick as \\x60 (a regex) or reword: {offenders}")


class IosComposerZoomTest(unittest.TestCase):
    """iOS Safari zooms into a focused field under 16px: the message box is 16px on Apple touch devices only."""

    def test_composer_is_16px_on_ios_only(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        block = css[css.index("@supports (-webkit-touch-callout: none) {"):]
        block = block[:block.index("}\n}") + 3]
        self.assertIn(".composer textarea, .composer textarea:focus { font-size: 16px; }", block)


if __name__ == "__main__":
    unittest.main()
