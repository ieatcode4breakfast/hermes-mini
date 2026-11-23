"""Bridge delivery targets and the app-chat home pointer.

The bridge is loaded by file path, exactly as the plugin loader does it, and driven against a fake
session store plus a real (disposable) app-chat registry.
"""

from __future__ import annotations

import json
import unittest
from unittest import mock

from tests.support import PROJECT_ROOT, DisposableHome, load_module

BRIDGE = PROJECT_ROOT / "bridge.py"
CHATS = PROJECT_ROOT / "app_chats.py"


class FakeSessionDB:
    def __init__(self, rows):
        self.rows = rows

    def get_session(self, session_id):
        return next((row for row in self.rows if row["id"] == session_id), None)

    def get_session_by_title(self, title):
        return next((row for row in self.rows if row.get("title") == title), None)

    def search_sessions(self, source=None, limit=20, offset=0, **kwargs):
        # The public session list the case-insensitive title probe scans (most recent first).
        self.scan_limit = limit
        return list(self.rows)[offset:offset + limit]


ROWS = [
    {"id": "home", "title": "Hermes Mini", "archived": 0},
    {"id": "side-main", "title": "main", "archived": 0},
    {"id": "rem-row", "title": "Reminders", "archived": 0},
    {"id": "old", "title": "Old chat", "archived": 1},
]


class RegistryTestCase(DisposableHome):
    def registry(self, ids=(), home=""):
        path = self.home / "data" / "hermes-mini" / "app-chats.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        document = {"ids": list(ids)}
        if home:
            document["home"] = home
        path.write_text(json.dumps(document), encoding="utf-8")
        return path


class ResolveSessionTest(RegistryTestCase):
    def setUp(self):
        super().setUp()
        self.bridge = load_module("hermes_mini_bridge_delivery", BRIDGE)
        self.registry(ids=("home",))

    def db(self, rows=None):
        return FakeSessionDB([dict(row) for row in (rows or ROWS)])

    def test_job_notification_text_keeps_underscores(self):
        self.assertEqual(self.bridge._plain("**Report:** `column_total` = 4_200 in [sales_q3](x)"),
                         "Report: column_total = 4_200 in sales_q3")

    def test_a_shutdown_notice_is_not_stored_but_marks_a_stop(self):
        result = self.bridge.deliver_text("⚠️ Hermes is shutting down — your current task will be interrupted.")
        self.assertEqual(result["message_id"], "suppressed-lifecycle-notice")
        self.assertEqual([e["kind"] for e in self.bridge.mini_core.gateway_events()], ["down"])

    def test_recording_never_breaks_the_caller(self):
        with mock.patch.object(self.bridge.mini_core, "record_gateway_event", side_effect=OSError("read-only")):
            self.bridge._record_gateway_event("up")  # logs, does not raise

    def test_reserved_main_wins_over_a_chat_named_main(self):
        db = self.db()
        self.assertEqual(self.bridge._resolve_session_id(db, "main"), ("home", "home"))
        self.assertEqual(self.bridge._resolve_session_id(db, "home"), ("home", "home"))

    def test_a_live_id_resolves_first(self):
        self.assertEqual(
            self.bridge._resolve_session_id(self.db(), "side-main"), ("side-main", "id"),
        )

    def test_deleted_id_falls_back_to_main(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db(), "gone"), ("home", "home"))

    def test_archived_id_falls_back_to_main(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db(), "old"), ("home", "home"))

    def test_exact_title(self):
        self.assertEqual(
            self.bridge._resolve_session_id(self.db(), "Reminders"), ("rem-row", "title"),
        )

    def test_case_insensitive_title_when_unique(self):
        self.assertEqual(
            self.bridge._resolve_session_id(self.db(), "reminders"), ("rem-row", "title"),
        )

    def test_case_insensitive_probe_uses_the_public_list(self):
        db = self.db()
        self.bridge._resolve_session_id(db, "reminders")
        self.assertEqual(db.scan_limit, self.bridge.TITLE_SCAN_LIMIT)
        self.assertNotIn("_read", self.bridge._resolve_session_id.__code__.co_names)

    def test_case_insensitive_pair_is_ambiguous_and_falls_back(self):
        db = FakeSessionDB([
            {"id": "home", "title": "Hermes Mini", "archived": 0},
            {"id": "a", "title": "Budgets", "archived": 0},
            {"id": "b", "title": "budgets", "archived": 0},
        ])
        self.assertEqual(self.bridge._resolve_session_id(db, "BUDGETS"), ("home", "home"))

    def test_archived_title_falls_back(self):
        self.assertEqual(
            self.bridge._resolve_session_id(self.db(), "Old chat"), ("home", "home"),
        )

    def test_missing_name_falls_back(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db(), "nope"), ("home", "home"))

    def test_no_main_chat_returns_none(self):
        self.registry(ids=())
        self.assertEqual(self.bridge._resolve_session_id(self.db([]), "nope"), (None, "home"))


class HomePointerTest(RegistryTestCase):
    def setUp(self):
        super().setUp()
        self.bridge = load_module("hermes_mini_bridge_delivery_home", BRIDGE)

    def test_recorded_home_wins_over_a_title_holder(self):
        self.registry(ids=("home", "thief"), home="home")
        db = FakeSessionDB([
            {"id": "home", "title": "Renamed home", "archived": 0},
            {"id": "thief", "title": "Hermes Mini", "archived": 0},
        ])
        self.assertEqual(self.bridge._resolve_session_id(db, "main"), ("home", "home"))

    def test_stale_recorded_home_does_not_follow_the_title(self):
        self.registry(ids=("thief",), home="gone")
        db = FakeSessionDB([
            {"id": "thief", "title": "Hermes Mini", "archived": 0},
        ])
        self.assertEqual(self.bridge._resolve_session_id(db, "main"), (None, "home"))

    def test_archived_recorded_home_does_not_follow_the_title(self):
        self.registry(ids=("home", "thief"), home="home")
        db = FakeSessionDB([
            {"id": "home", "title": "Hermes Mini", "archived": 1},
            {"id": "thief", "title": "Hermes Mini", "archived": 0},
        ])
        self.assertEqual(self.bridge._resolve_session_id(db, "main"), (None, "home"))

    def test_migration_accepts_a_registered_title_holder(self):
        self.registry(ids=("home",))
        db = FakeSessionDB([{"id": "home", "title": "Hermes Mini", "archived": 0}])
        self.assertEqual(self.bridge._resolve_session_id(db, "main"), ("home", "home"))

    def test_migration_rejects_an_unregistered_title_holder(self):
        self.registry(ids=())
        db = FakeSessionDB([{"id": "thief", "title": "Hermes Mini", "archived": 0}])
        self.assertEqual(self.bridge._resolve_session_id(db, "main"), (None, "home"))


class AppChatsHomeTest(RegistryTestCase):
    def setUp(self):
        super().setUp()
        self.chats = load_module("hermes_mini_app_chats", CHATS)

    def test_home_is_recorded_and_survives_adding_a_chat(self):
        self.assertTrue(self.chats.add("chat-a"))
        self.assertEqual(self.chats.claim_home("chat-a"), "chat-a")
        self.assertTrue(self.chats.add("chat-b"))
        self.assertEqual(self.chats.home(), "chat-a")
        self.assertEqual(self.chats.ids(), frozenset({"chat-a", "chat-b"}))

    def test_the_first_claim_wins(self):
        self.assertEqual(self.chats.claim_home("first"), "first")
        self.assertEqual(self.chats.claim_home("second"), "first")
        self.assertEqual(self.chats.home(), "first")

    def test_clearing_and_resetting_the_home(self):
        self.chats.claim_home("first")
        self.assertTrue(self.chats.set_home(""))
        self.assertEqual(self.chats.home(), "")
        self.assertTrue(self.chats.set_home("second"))
        self.assertEqual(self.chats.home(), "second")

    def test_a_registry_without_a_home_reads_empty(self):
        self.registry(ids=("chat-a",))
        self.assertEqual(self.chats.home(), "")
        self.assertEqual(self.chats.ids(), frozenset({"chat-a"}))
class SessionStoreBridgeTest(RegistryTestCase):
    def _install_fake_modules(self, modules: dict[str, object]):
        import sys
        sentinel = object()
        saved = {name: sys.modules.get(name, sentinel) for name in modules}
        for name, mod in modules.items():
            sys.modules[name] = mod

        def restore():
            for name, old in saved.items():
                if old is sentinel:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = old

        self.addCleanup(restore)

    def _make_persistence_fakes(self, rows: list[dict]):
        import types
        recorded = {"scopes": [], "opens": 0, "closes": 0, "appends": []}

        class FakeRecord:
            def __init__(self, row):
                self._row = dict(row)

            def as_session_row(self):
                return dict(self._row)

        class FakeEntry:
            def __init__(self, row):
                self.session = FakeRecord(row)

        class FakeSessions:
            def get(self, session_id):
                row = next((r for r in rows if r["id"] == session_id), None)
                return FakeRecord(row) if row is not None else None

            def get_by_title(self, title):
                row = next((r for r in rows if r.get("title") == title), None)
                return FakeRecord(row) if row is not None else None

            def search_sessions(self, *, window):
                return [FakeEntry(r) for r in rows[:window.limit]]

        class FakeMessages:
            def read_transcript(self, session_id, req):
                return []

            def append(self, session_id, message):
                recorded["appends"].append((session_id, message))
                return 900 + len(recorded["appends"])

        class FakeHandle:
            def __init__(self):
                self.sessions = FakeSessions()
                self.messages = FakeMessages()

            def __enter__(self):
                recorded["opens"] += 1
                return self

            def __exit__(self, *exc):
                recorded["closes"] += 1

        pa = types.ModuleType("persistence_assembly")
        pa.profile_scope = lambda profile=None, *, home=None: (recorded["scopes"].append(home) or ("scope", home))
        pa.open_persistence = lambda scope: FakeHandle()

        pm = types.ModuleType("persistence.conversation.messages")
        class FakeNewMessage:
            def __init__(self, **kw):
                self.payload = kw

            @classmethod
            def from_live(cls, payload):
                return cls(**payload)

        class FakeTranscriptRead:
            def __init__(self, **kw):
                self.kw = kw

        class FakeTranscriptView:
            ACTIVE = "active"

        pm.NewMessage = FakeNewMessage
        pm.TranscriptRead = FakeTranscriptRead
        pm.TranscriptView = FakeTranscriptView

        ps = types.ModuleType("persistence.conversation.sessions")
        class FakeSessionWindow:
            def __init__(self, *, limit=20):
                self.limit = limit

        ps.SessionWindow = FakeSessionWindow

        p_pkg = types.ModuleType("persistence")
        p_conv = types.ModuleType("persistence.conversation")
        p_pkg.conversation = p_conv
        p_conv.messages = pm
        p_conv.sessions = ps

        return {
            "persistence": p_pkg,
            "persistence.conversation": p_conv,
            "persistence.conversation.messages": pm,
            "persistence.conversation.sessions": ps,
            "persistence_assembly": pa,
        }, recorded

    def test_deliver_text_uses_persistence_interface_for_named_and_branched_chats(self):
        rows = [
            {"id": "home", "title": "Hermes Mini", "archived": 0, "parent_session_id": None},
            {"id": "side-1", "title": "Reminders", "archived": 0, "parent_session_id": None},
            {"id": "branch-1", "title": "Branch Check", "archived": 0, "parent_session_id": "side-1"},
        ]
        modules, recorded = self._make_persistence_fakes(rows)
        self._install_fake_modules(modules)
        self.registry(ids=("home", "side-1", "branch-1"), home="home")
        bridge = load_module("hermes_mini_bridge_persistence", BRIDGE)

        res1 = bridge.deliver_text("Take meds", target="Reminders")
        self.assertTrue(res1["success"])
        self.assertEqual(res1["chat_id"], "side-1")
        self.assertEqual(res1["resolved_by"], "title")
        self.assertEqual(res1["message_id"], "901")

        res2 = bridge.deliver_text("Check branch", target="branch check")
        self.assertTrue(res2["success"])
        self.assertEqual(res2["chat_id"], "branch-1")
        self.assertEqual(res2["resolved_by"], "title")
        self.assertEqual(res2["message_id"], "902")

        self.assertEqual(recorded["opens"], recorded["closes"])
        self.assertGreaterEqual(recorded["opens"], 4)
        self.assertTrue(all(h == self.home for h in recorded["scopes"]))

    def test_deliver_text_falls_back_to_legacy_session_db(self):
        import types
        rows = [
            {"id": "home", "title": "Hermes Mini", "archived": 0},
            {"id": "side-1", "title": "Notes", "archived": 0},
        ]
        appended = []

        class LegacyDB(FakeSessionDB):
            def __init__(self):
                super().__init__(rows)

            def append_message(self, **kwargs):
                appended.append(kwargs)
                return 77

        hs = types.ModuleType("hermes_state")
        hs.SessionDB = LegacyDB
        self._install_fake_modules({"hermes_state": hs})
        self.registry(ids=("home", "side-1"), home="home")
        bridge = load_module("hermes_mini_bridge_legacy", BRIDGE)

        res = bridge.deliver_text("Hello legacy", target="notes")
        self.assertTrue(res["success"])
        self.assertEqual(res["chat_id"], "side-1")
        self.assertEqual(res["message_id"], "77")
        self.assertEqual(len(appended), 1)
