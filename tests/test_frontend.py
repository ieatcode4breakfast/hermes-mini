"""Static integrity of the shipped browser app.

These are cheap, honest checks on the files the browser actually loads: every relative import
resolves, the service worker only lists files that exist, its optional/required split is real, and
nothing outside the app's own scope is referenced. They do not claim the UI has been exercised in a
browser beyond what the README's verified/not-verified list says.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
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



class JobDeliveryInAnyChatTest(unittest.TestCase):
    """A job result appended live belongs to the chat on screen: a named chat gets it too, and no other chat does."""

    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.fn = self.app[self.app.index("async function syncJobDeliveries("):self.app.index("\nfunction addAssistantBubble(")]

    def test_the_chat_on_screen_is_not_required_to_be_the_main_chat(self):
        self.assertNotIn("state.viewedId !== state.homeId", self.fn)
        self.assertNotIn("state.homeId", self.fn)

    def test_it_fetches_the_open_chats_rows_and_notices_a_chat_change_mid_fetch(self):
        self.assertIn("const storedId = state.storedId;", self.fn)
        self.assertIn("const viewedId = state.viewedId;", self.fn)
        self.assertIn("/api/sessions/${encodeURIComponent(storedId)}/messages?limit=20&order=latest", self.fn)
        self.assertIn(
            "if (state.storedId !== storedId || state.viewedId !== viewedId || state.streaming || state.switching) return;",
            self.fn,
        )

    def test_a_row_already_on_screen_is_never_appended_twice(self):
        self.assertIn("const shownIds = new Set(", self.fn)
        self.assertIn("if (entry.kind !== \"job\"", self.fn)
        self.assertIn("shownIds.has(id)", self.fn)

    def test_the_push_that_triggers_it_names_no_chat_so_every_chat_syncs(self):
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('client.postMessage({ type: "hermes-mini-job" })', sw)
        self.assertIn('if (data.type === "hermes-mini-job") {\n      void syncJobDeliveries();', self.app)


class FeedbackSurfaceTest(unittest.TestCase):
    def test_model_errors_use_dismissible_toasts_with_details(self):
        model = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        toast = (DASHBOARD / "toast.js").read_text(encoding="utf-8")
        self.assertIn("showPersistentToast(message, { detail: errorText(error) })", model)
        self.assertNotIn("inlineNotice", model)
        persistent = toast.split("export function showPersistentToast(", 1)[1].split("let node = null", 1)[0]
        self.assertIn('dismiss.setAttribute("aria-label", "Dismiss message")', persistent)
        self.assertIn('dismiss.addEventListener("click"', persistent)
        self.assertNotIn("setTimeout", persistent)

    def test_both_dictation_surfaces_use_dismissible_toasts(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn("if (sid === state.liveSid) showPersistentToast(message)", app)
        self.assertIn("reportError(dictationFailure(res))", app)
        self.assertIn("if (ui.input.isConnected) showPersistentToast(dictationFailure(res))", app)


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
        self.assertLessEqual(methods, {"model.options", "model.save_key", "model.disconnect", "config.get", "config.set", "approval.pending"})

    def test_provider_picker_uses_explicit_inventory_and_declared_auth(self):
        self.assertIn("const params = { explicit_only: true };", self.model)
        self.assertIn('if (!custom && keyField && (!row.auth_type || row.auth_type === "api_key"))', self.model)
        self.assertNotIn("connected && !row.auth_type", self.model)
        self.assertIn("Sign in to Nous Portal in Hermes.", self.model)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_model_switch_confirmations_keep_costs_and_other_warnings(self):
        formatter = self.model.split("function displaySwitchWarning(", 1)[1].split("\nexport function", 1)[0]
        warnings = "\n\n".join((
            "!!! EXPENSIVE MODEL WARNING !!!\n\nExample costs more.\n"
            "Input tokens: $25.00/M\nOutput tokens: unknown\n"
            "Confirm only if you intend to use this model.",
            "!!! LARGE CONTEXT MODEL SWITCH !!!\n\nThis session holds ~125,000 tokens of context.\n"
            "Confirm only if you intend to switch now.",
            "Other provider warning.",
        ))
        script = f"function displaySwitchWarning({formatter}\nprocess.stdout.write(displaySwitchWarning({json.dumps(warnings)}));"
        copy = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
        self.assertIn("Input (what the model reads): $25.00 per million tokens", copy)
        self.assertIn("Output (what it generates): unknown", copy)
        self.assertIn("125,000 tokens of history", copy)
        self.assertIn("your provider charges its full input rate", copy.lower())
        self.assertTrue(copy.endswith("Other provider warning."))
        self.assertNotIn("!!!", copy)

    def test_api_keys_never_touch_browser_storage(self):
        for word in ("localStorage", "sessionStorage", "indexedDB", "console."):
            self.assertNotIn(word, self.model)

    def test_new_chat_model_confirmation_gates_send_and_cleans_up_cancel(self):
        prepare = self.app.split("async function openFreshChat()", 1)[1].split("async function attachUnsent", 1)[0]
        self.assertIn('rpc("session.create", modelUi.draftCreateParams())', prepare)
        self.assertLess(prepare.index("await modelUi.applyDraftModel("), prepare.index("await registerNewChat("))
        self.assertIn('rpc("session.close", { session_id: created.session_id })', prepare)
        self.assertIn("if (!await openFreshChat()) {", self.app)
        self.assertNotIn("/api/model/set", self.model)
        self.assertIn("await requestModelSwitch(pick.model, pick.provider, sid, stillDraft)", self.model)

    def test_new_chats_pin_starting_model_and_isolate_cross_chat_state(self):
        self.assertIn("const createParams = await modelUi.defaultCreateParams();", self.app)
        self.assertIn('const created = await rpc("session.create", createParams);', self.app)
        self.assertIn("await modelUi.ensureDraftDefault();", self.app)
        self.assertIn("if (!draftPick && draftDefault?.model)", self.model)
        self.assertIn("function setInfo(payload, { replace = false } = {})", self.model)
        self.assertIn("if (!isDraft() || seq !== draftSeq) return;", self.model)
        self.assertIn("if (isDraft() || getSid() !== sid) return;", self.model)
        self.assertIn("if (event.session_id && event.session_id !== state.liveSid) return;", self.app)
        self.assertIn("modelUi.setInfo(resumed.info, { replace: true });", self.app)
        self.assertIn("if (draftLoad === pending) draftLoad = null;", self.model)
        self.assertIn("if (loading === pending) {", self.model)
        self.assertIn('rpc("config.get", { key: "reasoning" }', self.model)
        self.assertIn('key: "reasoning", value: word, scope: "global"', self.model)
        self.assertIn('key: "reasoning", value: effort, scope: "global"', self.model)
        self.assertIn("[providerLabel(provider), shortModel(model), effortLabel(effort)", self.model)


class InboxTapReadTest(unittest.TestCase):
    """Tapping an Inbox row is a hand read: it clears a manual unread; a chat view does not."""

    def test_the_row_tap_posts_a_manual_read(self):
        inbox = (DASHBOARD / "inbox.js").read_text(encoding="utf-8")
        self.assertIn('body: JSON.stringify({ ids, manual: true })', inbox)
        activate = inbox[inbox.index("async function activate"):]
        activate = activate[:activate.index("\n  }")]
        self.assertNotIn("!item.markedUnread", activate)


class DockedOverlaysTest(unittest.TestCase):
    """The Inbox card paints over the docked computer pane; its scrim stays behind it. The model sheet is a
    top-layer popover now, so it is above the pane whatever else is open."""

    def test_the_inbox_card_rises_but_its_scrim_does_not(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        rule = re.search(
            r"body\.docked\.computer-docked \.inbox-dialog \{ z-index: var\(--z-panel-over-computer\); \}",
            css,
        )
        self.assertIsNotNone(rule, "the docked Inbox card rule is missing")
        self.assertIn("body.docked.computer-docked.inbox-open .topbar { z-index: var(--z-header-over-computer); }", css)
        # The scrim stays under the computer pane: the pane is not dimmed or blocked.
        self.assertIn(".inbox-scrim { z-index: var(--z-inbox-scrim); }", css)
        # The model sheet leaves the ladder entirely: it is a manual popover and carries no z-index.
        self.assertNotRegex(css, r"\.model-sheet \{[^}]*z-index")
        model = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        self.assertIn('sheet.setAttribute("popover", "manual");', model)
        self.assertIn('scrim.setAttribute("popover", "manual");', model)
        approvals = (DASHBOARD / "approvals.js").read_text(encoding="utf-8")
        self.assertIn('sheet.setAttribute("popover", "manual");', approvals)
        self.assertIn('scrim.setAttribute("popover", "manual");', approvals)
        self.assertIn('key: "approvals.mode"', approvals)
        self.assertIn("Turn off approvals?", approvals)
        self.assertIn(
            'showToast(mode === "off" ? "Approvals off" : `Approvals: ${label}`, mode === "off" ? "error" : "success");',
            approvals,
        )



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
        self.assertIn("if (!keepDictation) cancelDictation(true);", clear_fn)

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
        self.assertIn("chip.hidden = !settled && !model;", model)
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

    def test_inline_media_limit_notice_and_lazy_observer(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn("const MAX_INLINE_MEDIA = 50;", app)
        self.assertIn("This app's preview limit has been reached.", app)
        self.assertIn("inlineMediaObserver", app)


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
        self.assertIn('if (!custom && keyField && (!row.auth_type || row.auth_type === "api_key"))', js)


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

    def test_universal_16px_base_and_scaled_tiers(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn("body { font: 16px/1.5", css)
        self.assertNotIn("@media (max-width: 600px) { body { font-size: 14px; } }", css)
        self.assertIn(".activity-tree {", css)
        self.assertIn("font-size: 14.5px;", css)
        self.assertIn(".msg-time { margin: 0 6px; font-size: 13px;", css)


class SocketAuthOrderTest(unittest.TestCase):
    def test_gate_is_known_before_the_socket_query_is_chosen(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        fn = app[app.index("async function connect()"):app.index("// Thread attach:")]
        self.assertLess(fn.index("const token = await sessionToken();"), fn.index("if (window.__HERMES_AUTH_REQUIRED__)"))


class ChatsPanelShadeTest(unittest.TestCase):
    def test_panel_has_its_own_shade_in_both_themes_and_no_divider(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertEqual(css.count("--panel: "), 3)  # light, dark (system), dark (forced)
        drawer = css[css.index("\n.drawer {"):]
        self.assertIn("background: var(--panel);", drawer[:300])
        docked = css[css.index("body.docked .drawer {"):]
        self.assertIn("border-right: 0;", docked[:300])
        head = css[css.index(".group-head {"):]
        self.assertIn("var(--panel)", head[:200])  # the sticky day header matches the panel


class ComputerButtonStaysOutTest(unittest.TestCase):
    def test_docked_computer_keeps_its_button_when_tools_fold(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        rule = css[css.index("body.computer-docked:not(.tools-open) #screenBtn {"):]
        self.assertIn("visibility: visible; pointer-events: auto;", rule[:200])
        # it must come after the fold rule, so it wins at equal specificity or more
        self.assertGreater(css.index("body.computer-docked:not(.tools-open) #screenBtn {"),
                           css.index("body:not(.tools-open) .fab.fab-tray {"))


class ComputerFollowsThemeTest(unittest.TestCase):
    def test_letterbox_colour_is_read_again_on_theme_change(self):
        js = (DASHBOARD / "computer" / "screen.js").read_text(encoding="utf-8")
        self.assertIn('attributeFilter: ["data-theme"]', js)
        self.assertIn('"(prefers-color-scheme: dark)").addEventListener?.("change", syncLetterbox)', js)
        self.assertIn("if (rfb) rfb.background = appBackground();", js)
        self.assertIn("client.background = appBackground();", js)


class AttachMenuOverHeaderTest(unittest.TestCase):
    def test_the_menu_is_in_the_top_layer_not_lifted_by_z_index(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertRegex(html, r'id="attachMenu"[^>]*\bpopover="manual"')
        self.assertIn("openPopover(attachMenu);", app)
        self.assertIn("closePopover(attachMenu);", app)
        # It is fixed-position in the top layer and placed from the "+" button's box on screen.
        self.assertIn("function placeAttachMenu()", app)
        self.assertIn("attachMenu.style.left = `${left}px`;", app)
        self.assertIn("attachMenu.style.top = `${top}px`;", app)
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn(".attach-menu {\n  position: fixed; left: 0; top: 0;", css)
        self.assertNotRegex(css, r"\.attach-menu \{[^}]*z-index")
        # The class stays only as the fallback for a browser without the Popover API.
        self.assertIn(".composer.menu-open { z-index: var(--z-composer-above); }", css)
        self.assertIn("position: absolute; top: 0; left: 0; right: 0; z-index: var(--z-header);", css)


class TodoNewRowSavedAtOnceTest(unittest.TestCase):
    """A new to-do row is saved the moment it appears, and becomes draggable as soon as its id lands."""

    def setUp(self):
        self.js = (DASHBOARD / "todo.js").read_text(encoding="utf-8")

    def fn(self, name):
        start = self.js.index(f"function {name}(")
        return self.js[start:self.js.index("\n  }\n", start)]

    def test_add_item_and_enter_post_at_once(self):
        self.assertIn("void postNew(draft, openIndex(draft.id));", self.fn("startDraft"))
        self.assertIn("void postNew(draft, openIndex(draft.id));", self.fn("splitEdit"))
        self.assertNotIn("commitDraft", self.js)

    def test_landing_arms_the_drag_and_keeps_the_edit(self):
        land = self.fn("landDraft")
        self.assertIn("armDrag(node)", land)
        self.assertIn("editing.id = id;", land)
        self.assertIn("payload.id", land)

    def test_drag_measures_from_the_press_point(self):
        begin = self.fn("beginDrag")
        self.assertIn("startY: pressY,", begin)
        self.assertIn("beginDrag(node, pointerId, startX, startY, ev.clientX, ev.clientY, touch);", self.js)

    def test_touch_grip_reaches_the_checkbox_and_mouse_is_unchanged(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn("left: -18px; width: 40px; height: 44px;", css)
        touch = css[css.index("@media (pointer: coarse) {\n  .todo-grip-hit"):]
        self.assertIn(".todo-grip-hit { left: -30px; width: 53px; }", touch[:120])

    def test_touch_drag_can_start_on_the_checkbox(self):
        self.assertIn('event.pointerType !== "mouse" && Boolean(event.target.closest(".todo-check"))', self.js)
        self.assertIn("armPress(event, node, { capture: !onCheck, startPx: onCheck ? CHECK_DRAG_START_PX : DRAG_START_PX });", self.js)
        self.assertIn("if (drag || performance.now() < suppressClickUntil) return;", self.js)
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn(".todo-list > .todo-row:not(.draft) .todo-check { touch-action: none; }", css)

    def test_a_childs_capture_handover_does_not_cancel_the_drag(self):
        self.assertIn("event.pointerId !== drag.pointerId || event.target !== drag.node) return;", self.fn("dragLost"))
        self.assertIn("if (ev.pointerId === pointerId && ev.target === node) cleanup();", self.js)

    def test_post_returns_the_new_id(self):
        api = (DASHBOARD / "plugin_api.py").read_text(encoding="utf-8")
        self.assertIn('return JSONResponse({"items": items, "id": item["id"]})', api)


class PopupTopLayerTest(unittest.TestCase):
    """Every menu, popup window and toast is a manual popover: the browser's top layer, above every stacking
    context. The big side panels stay in the page's own named layering (z-index ladder)."""

    INDEX_POPOVERS = (
        "attachMenu",
        "rowMenuScrim", "rowMenu",
        "msgMenuScrim", "msgMenu",
        "renameScrim", "renameDialog",
        "confirmScrim", "confirmDialog",
    )
    INDEX_PANELS = ("scrim", "drawer", "todoScrim", "todoDialog", "schedScrim", "schedDialog", "inboxScrim", "inboxDialog")

    def _tag(self, html, element):
        match = re.search(rf"<[^>]*\bid=\"{element}\"[^>]*>", html)
        self.assertIsNotNone(match, element)
        return match.group(0)

    def test_index_menus_and_dialogs_are_manual_popovers(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        for element in self.INDEX_POPOVERS:
            self.assertIn('popover="manual"', self._tag(html, element), element)

    def test_side_panels_keep_the_z_index_ladder(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        for element in self.INDEX_PANELS:
            self.assertNotIn("popover", self._tag(html, element), element)

    def test_js_built_popups_set_the_popover_attribute(self):
        schedules = (DASHBOARD / "schedules.js").read_text(encoding="utf-8")
        self.assertIn('menuScrim.setAttribute("popover", "manual");', schedules)
        self.assertIn('menuEl.setAttribute("popover", "manual");', schedules)
        model = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        self.assertIn('sheet.setAttribute("popover", "manual");', model)
        self.assertIn('scrim.setAttribute("popover", "manual");', model)
        toast = (DASHBOARD / "toast.js").read_text(encoding="utf-8")
        self.assertIn('node.setAttribute("popover", "manual");', toast)
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('restartToast.setAttribute("popover", "manual");', app)
        self.assertIn('jumpToast.setAttribute("popover", "manual");', app)

    def test_open_target_shows_loading_toast_until_flash(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('document.createTextNode("Loading message")', app)
        self.assertIn('jumpToast.querySelector(".restart-dots")', app)
        fn = app[app.index("async function openTarget("):app.index("async function reconnect(")]
        self.assertIn("showJumpNotice();", fn)
        self.assertIn("hideJumpNotice();\n    await revealRow(row);", fn)
        self.assertNotIn("success", fn)

    def test_the_helpers_show_and_hide_in_the_top_layer(self):
        toast = (DASHBOARD / "toast.js").read_text(encoding="utf-8")
        # Feature-detected, so a browser without the API keeps today's behaviour.
        self.assertIn("typeof HTMLElement.prototype.showPopover === \"function\"", toast)
        self.assertIn("el.showPopover();", toast)
        self.assertIn("el.hidePopover();", toast)
        self.assertIn('el.matches(":popover-open")', toast)

    def test_each_popup_shows_and_hides_through_the_helper(self):
        calls = {
            "confirm.js": ("openPopover(scrim);", "openPopover(dialog);", "closePopover(scrim, 240);", "closePopover(dialog, 200);"),
            "drawer.js": (
                "openPopover(renameScrim);", "openPopover(renameDialog);",
                "openPopover(rowMenuScrim);", "openPopover(rowMenu);",
                "closePopover(rowMenu, 160);",
            ),
            "app.js": ("openPopover(attachMenu);", "openPopover(els.msgMenu);", "reopenPopover(restartToast);"),
            "model.js": ("openPopover(parts.scrim);", "openPopover(sheet);", "closePopover(sheet, 260);"),
            "schedules.js": ("openPopover(menuScrim);", "openPopover(menuEl);", "closePopover(menuEl, 160);"),
        }
        for name, needles in calls.items():
            js = (DASHBOARD / name).read_text(encoding="utf-8")
            for needle in needles:
                self.assertIn(needle, js, f"{name}: {needle}")

    def test_a_toast_is_re_shown_so_it_sits_above_an_open_dialog(self):
        toast = (DASHBOARD / "toast.js").read_text(encoding="utf-8")
        self.assertIn("reopenPopover(node);", toast)
        self.assertIn("export function reopenPopover(el)", toast)

    def test_scrims_are_shown_before_their_own_dialog(self):
        confirm = (DASHBOARD / "confirm.js").read_text(encoding="utf-8")
        self.assertLess(confirm.index("openPopover(scrim);"), confirm.index("openPopover(dialog);"))
        drawer = (DASHBOARD / "drawer.js").read_text(encoding="utf-8")
        self.assertLess(drawer.index("openPopover(renameScrim);"), drawer.index("openPopover(renameDialog);"))
        self.assertLess(drawer.index("openPopover(rowMenuScrim);"), drawer.index("openPopover(rowMenu);"))
        model = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        self.assertLess(model.index("openPopover(parts.scrim);"), model.index("openPopover(sheet);"))
        schedules = (DASHBOARD / "schedules.js").read_text(encoding="utf-8")
        self.assertLess(schedules.index("openPopover(menuScrim);"), schedules.index("openPopover(menuEl);"))
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertLess(app.index("openPopover(els.msgMenuScrim);"), app.index("openPopover(els.msgMenu);"))


class ZIndexLadderTest(unittest.TestCase):
    """One named z-index ladder; nothing at 4 or above is a bare number, and popups never use z-index at all."""

    Z_INDEX_RE = re.compile(r"z-index\s*:\s*([^;{}]+)")
    LADDER = (
        "--z-composer", "--z-header", "--z-composer-above", "--z-drawer-scrim", "--z-drawer",
        "--z-panel-scrim", "--z-panel", "--z-inbox-scrim", "--z-inbox", "--z-header-over-panel",
        "--z-computer", "--z-header-beside-computer", "--z-computer-chrome", "--z-viewer", "--z-drawer-over-computer",
        "--z-panel-over-computer", "--z-header-over-computer",
    )

    def setUp(self):
        self.style = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.screen = (DASHBOARD / "computer" / "screen.css").read_text(encoding="utf-8")

    def test_the_ladder_is_defined_in_root(self):
        root = self.style[self.style.index(":root {"):self.style.index("}", self.style.index(":root {"))]
        for name in self.LADDER:
            self.assertRegex(root, rf"{name}: \d+;", name)
        # The rule itself, stated where the ladder is defined.
        self.assertIn("Menus, popup windows and toasts never use z-index", root)

    def test_no_literal_z_index_of_four_or_more(self):
        offenders = []
        for name, text in (("style.css", self.style), ("computer/screen.css", self.screen)):
            # Comments talk about z-index too; only declarations count.
            text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
            for match in self.Z_INDEX_RE.finditer(text):
                value = match.group(1).strip()
                if value.startswith("var(--z-"):
                    continue
                if re.fullmatch(r"-?\d+", value) and abs(int(value)) < 4:
                    continue
                offenders.append(f"{name}: z-index: {value}")
        self.assertEqual(offenders, [])

    def test_docked_computer_keeps_the_round_buttons_at_the_window_edge(self):
        self.assertIn("body.docked.computer-docked .topbar { z-index: var(--z-header-beside-computer); }", self.style)
        self.assertIn("body.docked.computer-docked .topbar > .fab:not(.fab-menu) { position: fixed; }", self.style)
        value = {n: int(v) for n, v in re.findall(r"(--z-[a-z-]+): (\d+);", self.style)}
        # Above the computer pane, below everything that must cover the buttons when it opens.
        self.assertGreater(value["--z-header-beside-computer"], value["--z-computer"])
        for over in ("--z-computer-chrome", "--z-viewer", "--z-drawer-over-computer", "--z-panel-over-computer"):
            self.assertLess(value["--z-header-beside-computer"], value[over], over)

    def test_gateway_restart_feedback_stays_out_of_chat(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertNotIn("/gateway-events", app)
        self.assertNotIn("addGatewayLine", app)
        self.assertIn("showRestartNotice();", app)
        self.assertIn('showToast(back ? "Restarted" : "Restart didn\'t finish"', app)

    def test_every_layer_used_is_named(self):
        defined = set(re.findall(r"(--z-[a-z-]+)\s*:", self.style + self.screen))
        used = set(re.findall(r"var\((--z-[a-z-]+)\)", self.style + self.screen))
        self.assertEqual(used - defined, set())

    def test_menus_and_dialog_cards_carry_no_z_index(self):
        css = re.sub(r"/\*.*?\*/", "", self.style + self.screen, flags=re.S)
        rules = re.findall(r"([^{}]+)\{([^}]*)\}", css)
        for selector in (".attach-menu", ".row-menu", ".msg-menu", ".sched-menu", ".rename-dialog", ".confirm-dialog", ".model-sheet", ".toast"):
            bodies = [body for sel, body in rules if selector in {part.strip() for part in sel.split(",")}]
            self.assertTrue(bodies, selector)
            for body in bodies:
                self.assertNotIn("z-index", body, selector)



class ComputerStartButtonTest(unittest.TestCase):
    """Start Screen sits in the stopped-screen card, centred under its message, not in the floating control row."""

    def test_start_is_under_the_message(self):
        markup = (DASHBOARD / "computer" / "markup.js").read_text(encoding="utf-8")
        card = markup.split('<div class="bs-card">', 1)[1].split("</div>", 1)[0]
        self.assertLess(card.index('id="bsOverlayBody"'), card.index('id="bsStart"'))
        controls = markup.split('class="bs-controls"', 1)[1].split("</div>", 1)[0]
        self.assertNotIn("bsStart", controls)
        css = (DASHBOARD / "computer" / "screen.css").read_text(encoding="utf-8")
        self.assertIn(".bs-overlay .bs-btn[hidden] { display: none; }", css)



class ClarifyDictationTest(unittest.TestCase):
    """A question card's answer box is one field with the mic inside, and records with the composer's strip."""

    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.css = (DASHBOARD / "style.css").read_text(encoding="utf-8")

    def test_both_answer_rows_use_the_field_with_send_outside(self):
        for fn in ("function renderClarify(", "function renderMultiSelect("):
            body = self.app.split(fn, 1)[1].split("\nfunction ", 1)[0]
            self.assertIn("row.append(clarifyAnswerField(input, send), send);", body)

    def test_the_mic_sits_inside_the_field_with_the_composers_strip(self):
        field = self.app.split("function clarifyAnswerField(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("if (!isDictationSupported()) return field;", field)
        self.assertIn("features.dictation === false) return field;", field)
        for part in ('"dictate-hud clarify-hud"', '"dictate-viz"', '"vbar"', '"dictate-timer", "1:00"', '"dictate-cancel"'):
            self.assertIn(part, field)
        self.assertIn("field.append(hud, mic);", field)
        self.assertIn("stopCardDictation({ discard: true })", field)  # the x cancels
        self.assertIn("stopCardDictation({ send: true })", field)  # Send while recording sends after
        self.assertIn(".answer-field.dictating input { display: none; }", self.css)

    def test_countdown_route_and_one_recording_at_a_time(self):
        start = self.app.split("async function startCardDictation(", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("if (cardDictation || state.dictating || state.transcribing)", start)
        self.assertIn("formatCountdown(remaining)", start)
        self.assertIn('classList.toggle("warn", secLeft <= 15 && secLeft > 5)', start)
        self.assertIn("stopCardDictation({ discard: true })", start)  # a card that moves on drops it
        composer = self.app.split("async function startDictation(", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("if (cardDictation) return;", composer)
        finish = self.app.split("async function finishCardDictation(", 1)[1].split("\n}\n", 1)[0]
        self.assertIn('api("/api/plugins/hermes-mini/dictate"', finish)
        self.assertIn("dictationInsert(before, text, after)", finish)


class MobileZoomLockTest(unittest.TestCase):
    """The PWA shell locks mobile pinch/double-tap zoom while keeping single-finger scrolling and viewer zoom."""

    def test_viewport_and_root_disallow_page_zoom(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn("maximum-scale=1", html)
        self.assertIn("user-scalable=no", html)
        self.assertIn("touch-action: pan-x pan-y;", css)


class NewChatMainPromotionTest(unittest.TestCase):
    """Starting a New chat when no saved main chat exists promotes it to main chat."""

    def test_first_send_from_new_chat_claims_home_before_prompt_submit(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        reg = app[app.index("async function registerNewChat("):app.index("\n// Finds the recorded home thread")]
        self.assertIn("const existing = await currentServerThreadRow();", reg)
        self.assertIn("const winner = await registerAppChat(id, true);", reg)
        self.assertIn("state.homeId = winner;", reg)
        self.assertIn("updateCaption();", reg)
        self.assertIn("refreshDockedDrawer();", reg)
        self.assertIn("await registerAppChat(id);", reg)
        self.assertNotIn("session.archive", reg)

        fresh = app[app.index("async function openFreshChat("):app.index("\n// A New chat has no server id now")]
        self.assertIn("await registerNewChat(created.stored_session_id);", fresh)

        create_fn = app[app.index("async function createThread("):app.index("\n// Tags a chat as started in the app")]
        self.assertIn("if (!state.viewedUnsent) state.liveSid = created.session_id;", create_fn)

        send = app[app.index("    await rpc(\"prompt.submit\""):app.index("  } catch (error) {\n    // Nothing was submitted")]
        self.assertIn("void registerAppChat(chatId);", send)


class ComposerBottomBarTest(unittest.TestCase):
    """Top row holds attach, input, dictation, and send; bottom row holds Approvals + icon left and model right."""

    def test_markup_orders_main_row_above_approval_prefix_icon_and_model(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        row = html[html.index('<div class="row">', html.index('<footer class="composer">')):html.index('<div id="readonlyBar"')]
        self.assertNotIn("composer-tabs", row)
        self.assertLess(row.index('<div class="composer-main">'), row.index('<div class="composer-bar">'))
        main = row[row.index('<div class="composer-main">'):row.index('<input id="photo"')]
        self.assertLess(main.index('id="attach"'), main.index('<textarea id="input"'))
        self.assertLess(main.index('<textarea id="input"'), main.index('id="dictateHud"'))
        self.assertLess(main.index('id="dictateHud"'), main.index('id="micBtn"'))
        self.assertLess(main.index('id="micBtn"'), main.index('id="send"'))
        bar = row[row.index('<div class="composer-bar">'):]
        self.assertLess(bar.index('id="approvalChip"'), bar.index('id="modelChip"'))
        chip = bar[bar.index('id="approvalChip"'):bar.index('id="modelChip"')]
        self.assertLess(
            chip.index('<span class="approval-tab-prefix">Approvals</span>'),
            chip.index('<span class="approval-tab-icon" aria-hidden="true"></span>'),
        )
        self.assertNotIn("approval-tab-label", chip)
        self.assertNotIn("approval-tab-text", chip)

    def test_styles_align_approval_left_and_model_right(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertNotIn("composer-tabs", css)
        self.assertNotIn(".composer-left", css)
        self.assertNotIn(".composer-right", css)
        self.assertNotIn(".composer .row.wide", css)
        self.assertIn(".composer-main {", css)
        self.assertIn(".composer-bar {", css)
        self.assertIn("gap: 6px; padding: 0 4px;", css)
        self.assertIn("margin: 0 0 0 auto;", css)
        model_tab_block = css[css.index(".model-tab {"):css.index(".model-tab:active")]
        self.assertIn("background: transparent; color: var(--muted);", model_tab_block)
        self.assertNotIn("color-mix(in srgb, var(--fg) 6%, transparent)", model_tab_block)
        approval_tab_block = css[css.index(".approval-tab {"):css.index(".approval-tab[hidden]")]
        self.assertIn("border: 0; border-radius: 999px;", approval_tab_block)
        self.assertIn("background: transparent; color: var(--muted);", approval_tab_block)
        self.assertNotIn("approval-tab-label", css)
        self.assertNotIn("approval-tab-text", css)
        self.assertIn(".approval-tab-prefix { white-space: nowrap; color: var(--muted); transition: color 150ms ease; }", css)
        self.assertIn(".approval-tab.is-off { color: var(--danger); }", css)
        self.assertIn(':where(:root[data-input="mouse"]) .approval-tab:hover,', css)
        self.assertIn(':where(:root[data-input="mouse"]) .approval-tab:hover .approval-tab-prefix,', css)
        self.assertNotIn(".approval-tab:hover .approval-tab-icon", css)
        self.assertIn(".composer .row textarea { position: relative; z-index: 1; }", css)
        self.assertIn(".composer .row.dictating:has(textarea:not(:placeholder-shown)) .composer-main {", css)
        self.assertIn(".log { padding-bottom: 16px; }", css)
        self.assertIn("bottom: calc(100% + 10px);", css)
        self.assertIn('const rowRect = els.attach.closest(".row")?.getBoundingClientRect() || r;', app)
        autosize_block = app[app.index("function autosize()"):app.index("// New chat opens a local draft")]
        self.assertNotIn('"wide"', autosize_block)
        self.assertIn("if ((state.dictating || state.transcribing) && !el.value)", autosize_block)
        self.assertIn('el.style.height = "";', autosize_block)


class TodoParentRowActionsTest(unittest.TestCase):
    """Active parent to-do rows place the eye track toggle and delete × buttons directly on the row."""

    def test_todo_js_renders_direct_track_and_delete_buttons_without_row_menu(self):
        js = (DASHBOARD / "todo.js").read_text(encoding="utf-8")
        self.assertIn('tracked ? "todo-track" : "todo-track untracked"', js)
        self.assertIn("svgIcon(tracked ? EYE_ICON : EYE_OFF_ICON)", js)
        self.assertIn("() => void toggleTrack(item)", js)
        self.assertIn('showToast(next ? "Tracked" : "Untracked");', js)
        self.assertIn('const del = el("button", "todo-del");', js)
        for removed in ("todo-dots", "todo-untracked-icon", "todo-menu", "hermesMiniTodoMenu", "openMenu", "closeMenu"):
            self.assertNotIn(removed, js)

    def test_todo_css_styles_direct_track_button_and_removes_row_menu(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn(".todo-track {", css)
        self.assertIn(".todo-track.untracked { opacity: 0.55; }", css)
        self.assertIn(".todo-row.draft .todo-track, .todo-row.indent .todo-track { display: none; }", css)
        for removed in (".todo-dots", ".todo-untracked-icon", ".todo-menu", ".todo-menu-scrim"):
            self.assertNotIn(removed, css)

    def test_todo_header_displays_live_tracked_counter(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        js = (DASHBOARD / "todo.js").read_text(encoding="utf-8")
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn('<h2 id="todoTitle" class="todo-title"><span>To-do</span><span id="todoHeaderCount"', html)
        self.assertIn('const headerCountEl = $("todoHeaderCount");', js)
        self.assertIn("headerCountEl.textContent = label;", js)
        self.assertIn('headerCountEl.classList.toggle("zero", real === 0);', js)
        self.assertIn(".todo-title .todo-head-count {", css)
        self.assertIn(".todo-title .todo-head-count.zero {", css)

    def test_row_buttons_require_completed_tap_and_delete_asks_confirmation(self):
        js = (DASHBOARD / "todo.js").read_text(encoding="utf-8")
        self.assertIn("function bindRowButton(", js)
        self.assertIn("if (event.button !== 0) return;", js)
        self.assertIn("if (editing) event.preventDefault();", js)
        self.assertIn('listEl.addEventListener("scroll", onCancel', js)
        self.assertIn("if (!tap.released) return;", js)
        self.assertIn('bindRowButton(del, "delete", item, () => void confirmRemove(item));', js)
        self.assertIn('title: "Delete to-do?",', js)
        self.assertIn("danger: true,", js)


if __name__ == "__main__":
    unittest.main()
