"""Bridge delivery targets: ids, reserved words, names and the silent main-chat fallback.

The bridge is loaded by file path, exactly as the plugin loader does it, and driven against a fake
session store exposing the documented read surface plus the case-insensitive title query.
"""

from __future__ import annotations

import unittest

from tests.support import PROJECT_ROOT, load_module

BRIDGE = PROJECT_ROOT / "bridge.py"


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


class ResolveSessionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = load_module("hermes_mini_bridge_delivery", BRIDGE)

    def setUp(self):
        self.db = FakeSessionDB([dict(row) for row in ROWS])

    def test_reserved_main_wins_over_a_chat_named_main(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db, "main"), ("home", "home"))
        self.assertEqual(self.bridge._resolve_session_id(self.db, "home"), ("home", "home"))

    def test_a_live_id_resolves_first(self):
        self.assertEqual(
            self.bridge._resolve_session_id(self.db, "side-main"), ("side-main", "id"),
        )

    def test_deleted_id_falls_back_to_main(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db, "gone"), ("home", "home"))

    def test_archived_id_falls_back_to_main(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db, "old"), ("home", "home"))

    def test_exact_title(self):
        self.assertEqual(
            self.bridge._resolve_session_id(self.db, "Reminders"), ("rem-row", "title"),
        )

    def test_case_insensitive_title_when_unique(self):
        self.assertEqual(
            self.bridge._resolve_session_id(self.db, "reminders"), ("rem-row", "title"),
        )

    def test_case_insensitive_pair_is_ambiguous_and_falls_back(self):
        db = FakeSessionDB([
            {"id": "home", "title": "Hermes Mini", "archived": 0},
            {"id": "a", "title": "Budgets", "archived": 0},
            {"id": "b", "title": "budgets", "archived": 0},
        ])
        self.assertEqual(self.bridge._resolve_session_id(db, "BUDGETS"), ("home", "home"))

    def test_archived_title_falls_back(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db, "Old chat"), ("home", "home"))

    def test_missing_name_falls_back(self):
        self.assertEqual(self.bridge._resolve_session_id(self.db, "nope"), ("home", "home"))

    def test_no_main_chat_returns_none(self):
        db = FakeSessionDB([])
        self.assertEqual(self.bridge._resolve_session_id(db, "nope"), (None, "home"))
