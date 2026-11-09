"""Bridge delivery targets and the app-chat home pointer.

The bridge is loaded by file path, exactly as the plugin loader does it, and driven against a fake
session store plus a real (disposable) app-chat registry.
"""

from __future__ import annotations

import json
import unittest

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

    def _read_all(self, sql, params=()):
        # The resolver's only read-all is the case-insensitive live-title probe (LIMIT 2).
        needle = str(params[0]).lower()
        found = [
            row
            for row in self.rows
            if (row.get("title") or "").lower() == needle and not row.get("archived")
        ]
        return found[:2]


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
