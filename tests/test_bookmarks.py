"""Bookmarks: the reply action, the Tools-tray panel, the routes and the stored ids.

The route tests build a small ``state.db`` in a disposable ``HERMES_HOME`` and need FastAPI; where it is
absent that class is skipped rather than silently passing. The static tests read the shipped files.
"""

from __future__ import annotations

import json
import sqlite3
import unittest
from unittest import mock

from tests.support import DASHBOARD, DisposableHome

try:  # Hermes ships FastAPI; a bare harness may not
    from tests.test_routes import HAVE_FASTAPI, build_app

    from starlette.testclient import TestClient
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False
    build_app = None  # type: ignore[assignment]
    TestClient = None  # type: ignore[assignment]


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class BookmarksRouteTest(DisposableHome):
    BASE = "/api/plugins/hermes-mini/bookmarks"
    CHATS = "/api/plugins/hermes-mini/app-chats"

    def setUp(self):
        super().setUp()
        self.app, self.api = build_app()
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def _db(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " display_kind TEXT, display_metadata TEXT, timestamp REAL, finish_reason TEXT, tool_calls TEXT,"
            " active INTEGER, compacted INTEGER)"
        )
        conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL, acquired_at REAL)")
        conn.execute("INSERT INTO sessions VALUES ('chat', 'Reminders', 0)")
        conn.commit()
        self.client.post(self.CHATS, json={"id": "chat"})
        return conn

    def _add(self, conn, row_id, text, role="assistant", ts=1_800_000_000.0):
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, display_kind, display_metadata, timestamp,"
            " finish_reason, tool_calls, active, compacted) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (row_id, "chat", role, text, None, None, ts, "stop" if role == "assistant" else None, None, 1, 0),
        )
        conn.commit()

    def store(self):
        return json.loads((self.home / "data" / "hermes-mini" / "bookmarks.json").read_text(encoding="utf-8"))

    def add(self, item_id):
        return self.client.post(self.BASE, json={"id": item_id})

    def items(self):
        response = self.client.get(self.BASE)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["items"]

    def ids(self):
        response = self.client.get(f"{self.BASE}/ids")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["ids"]

    def test_add_list_ids_delete_round_trip(self):
        conn = self._db()
        self._add(conn, 1, "Deploy is green.")
        self._add(conn, 2, "Tests pass.", ts=1_800_000_060.0)
        added = self.add(1)
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(added.json(), {"ok": True, "id": 1})
        self.assertEqual(self.ids(), [1])
        items = self.items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], 1)
        self.assertEqual(items[0]["session_id"], "chat")
        self.assertEqual(items[0]["thread"], "Reminders")
        self.assertIn("Deploy is green", items[0]["text"])
        self.assertIsInstance(items[0]["bookmarked_at"], int)

        # Newest bookmark first: the stored times decide, whatever order the ids were added in.
        self.assertEqual(self.add(2).status_code, 200)
        data = self.store()
        for item in data["items"]:
            item["added"] = 2000 if item["id"] == 2 else 1000
        (self.home / "data" / "hermes-mini" / "bookmarks.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual([item["id"] for item in self.items()], [2, 1])

        removed = self.client.delete(f"{self.BASE}/1")
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json(), {"ok": True})
        self.assertEqual(self.ids(), [2])
        # Idempotent: a second tap on a bookmark already gone is still what the person wanted.
        self.assertEqual(self.client.delete(f"{self.BASE}/1").status_code, 200)
        self.assertEqual(self.client.delete(f"{self.BASE}/999").status_code, 200)
        self.assertEqual([item["id"] for item in self.items()], [2])

    def test_add_is_idempotent(self):
        conn = self._db()
        self._add(conn, 1, "Keep this one.")
        self.assertEqual(self.add(1).status_code, 200)
        self.assertEqual(self.add(1).status_code, 200)
        self.assertEqual([item["id"] for item in self.store()["items"]], [1])

    def test_a_bookmark_whose_message_is_gone_is_omitted(self):
        conn = self._db()
        self._add(conn, 1, "Old reply.")
        self._add(conn, 2, "New reply.")
        self.add(1)
        self.add(2)
        conn.execute("DELETE FROM messages WHERE id = 1")
        conn.commit()
        self.assertEqual([item["id"] for item in self.items()], [2])
        # Its row is gone for good (ids are never reused), so opening the list also drops it from the store.
        self.assertEqual(sorted(item["id"] for item in self.store()["items"]), [2])
        self.assertEqual(self.ids(), [2])

    def test_a_deleted_chat_drops_its_bookmarks_from_the_store(self):
        conn = self._db()
        conn.execute("INSERT INTO sessions VALUES ('other', 'Errands', 0)")
        conn.commit()
        self.client.post(self.CHATS, json={"id": "other"})
        self._add(conn, 1, "Keep me.")
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, display_kind, display_metadata, timestamp,"
            " finish_reason, tool_calls, active, compacted) VALUES (2,'other','assistant','Gone soon.',NULL,NULL,"
            "1800000001,'stop',NULL,1,0)")
        conn.commit()
        self.add(1)
        self.add(2)
        conn.execute("DELETE FROM messages WHERE session_id = 'other'")
        conn.execute("DELETE FROM sessions WHERE id = 'other'")
        conn.commit()
        self.assertEqual([item["id"] for item in self.items()], [1])
        self.assertEqual(self.ids(), [1])

    def test_a_reply_that_exists_but_does_not_resolve_is_hidden_not_removed(self):
        conn = self._db()
        self._add(conn, 1, "Kept while hidden.")
        self.add(1)
        # The row stays; it just stops being an agent bubble the list can show.
        conn.execute("UPDATE messages SET display_kind = 'hidden' WHERE id = 1")
        conn.commit()
        self.assertEqual(self.items(), [])
        self.assertEqual(self.ids(), [1])

    def test_a_user_message_is_not_an_agent_reply(self):
        conn = self._db()
        self._add(conn, 3, "A message from the person.", role="user")
        self.assertEqual(self.add(3).status_code, 404)
        self.assertEqual(self.ids(), [])

    def test_bad_bodies_are_refused(self):
        self._db()
        for body in ({}, {"id": "1"}, {"id": 0}, {"id": -4}, {"id": 1.5}, {"id": True}, {"id": None}):
            response = self.client.post(self.BASE, json=body)
            self.assertEqual(response.status_code, 400, body)
        self.assertEqual(self.client.post(self.BASE, content=b"not json").status_code, 400)
        # A non-integer path id is refused by the route's own typing.
        self.assertIn(self.client.delete(f"{self.BASE}/nope").status_code, (400, 422))

    def test_the_cap_refuses_a_new_bookmark(self):
        conn = self._db()
        self._add(conn, 1, "First.")
        self._add(conn, 2, "Second.")
        with mock.patch.object(self.api, "MAX_BOOKMARKS", 1):
            self.assertEqual(self.add(1).status_code, 200)
            full = self.add(2)
        self.assertEqual(full.status_code, 409, full.text)
        self.assertEqual(self.ids(), [1])

    def test_a_garbled_store_reads_as_empty(self):
        path = self.home / "data" / "hermes-mini" / "bookmarks.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.items(), [])
        self.assertEqual(self.ids(), [])
        # The next add replaces the bad file with a valid one.
        conn = self._db()
        self._add(conn, 1, "Recovered.")
        self.assertEqual(self.add(1).status_code, 200)
        self.assertEqual(self.store()["items"][0]["id"], 1)

    def test_nothing_is_written_under_the_plugin_package(self):
        conn = self._db()
        self._add(conn, 1, "Kept.")
        before = self.snapshot_tree(DASHBOARD)
        self.add(1)
        self.items()
        self.ids()
        self.client.delete(f"{self.BASE}/1")
        self.assertEqual(self.snapshot_tree(DASHBOARD), before)


class BookmarksFrontEndTest(unittest.TestCase):
    def setUp(self):
        self.html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.js = (DASHBOARD / "bookmarks.js").read_text(encoding="utf-8")
        self.css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")

    def test_the_tray_has_four_buttons_in_order(self):
        head = self.html.split('<header class="topbar">', 1)[1].split("</header>", 1)[0]
        order = [head.index(f'id="{name}"') for name in
                 ("toolsBtn", "profileBtn", "screenBtn", "bookmarkBtn", "todoBtn")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(head.count("fab fab-tray"), 4)
        self.assertIn('aria-controls="profileBtn screenBtn bookmarkBtn todoBtn"', head)
        button = head.split('id="bookmarkBtn"', 1)[1].split("</button>", 1)[0]
        self.assertIn('class="fab fab-tray fab-bookmark"', button)
        self.assertIn('aria-controls="bmDialog"', button)
        self.assertIn('M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z', button)

    def test_the_slots_move_up_when_the_computer_is_hidden(self):
        for rule in ("#profileBtn { --slot: 1; }", "#screenBtn { --slot: 2; }",
                     "#bookmarkBtn { --slot: 3; }", "#todoBtn { --slot: 4; }",
                     "#screenBtn[hidden] + #bookmarkBtn { --slot: 2; }",
                     "#screenBtn[hidden] ~ #todoBtn { --slot: 3; }"):
            self.assertIn(rule, self.css)
        self.assertNotIn("#screenBtn[hidden] + #todoBtn { --slot: 2; }", self.css)
        self.assertEqual(self.css.count("(4 - var(--slot))"), 3)
        self.assertIn("body.bm-open #bookmarkBtn { background:", self.css)

    def test_the_panel_is_a_dialog_with_an_empty_state(self):
        self.assertIn('id="bmScrim" class="scrim todo-scrim"', self.html)
        self.assertIn('id="bmDialog" class="todo-dialog bm-dialog"', self.html)
        self.assertIn('role="dialog" aria-modal="true" aria-labelledby="bmTitle"', self.html)
        for part in ("bmBack", "bmTitle", "bmClose", "bmList", "bmEmpty"):
            self.assertIn(f'id="{part}"', self.html)
        self.assertIn("<span>Bookmarks</span>", self.html)
        self.assertIn("No bookmarks yet", self.html)
        self.assertIn("Bookmark a reply from the row under it, or press and hold it.", self.html)
        self.assertIn("M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z", self.html.split('id="bmBack"', 1)[1])
        self.assertIn(".bm-dialog { width:", self.css)

    def test_the_module_reads_and_writes_only_its_own_routes(self):
        self.assertIn('const BOOKMARKS_API = "/api/plugins/hermes-mini/bookmarks";', self.js)
        self.assertIn("api(`${BOOKMARKS_API}/ids`)", self.js)
        self.assertIn("method: \"POST\"", self.js)
        self.assertIn("method: \"DELETE\"", self.js)
        self.assertIn("aria-label\", \"Remove bookmark\"", self.js)
        self.assertIn("bookmarks.js", self.sw.split("const CORE = [", 1)[1].split("];", 1)[0])
        self.assertRegex(self.sw, r'const CACHE = "hermes-mini-v\d+";')

    def test_the_action_row_adds_bookmark_right_after_unread(self):
        bar = self.app[self.app.index("function addMessageActions("):self.app.index("// The unread button's label")]
        unread = bar.index('actionButton("unread", "Mark unread", ICON_UNREAD')
        bookmark = bar.index('actionButton("bookmark", "Bookmark", ICON_BOOKMARK')
        self.assertLess(unread, bookmark)
        self.assertIn('bar.append(actionButton("bookmark", "Bookmark", ICON_BOOKMARK, () => toggleReplyBookmark(row)));',
                      bar)
        self.assertIn("bookmarked: false", self.app[self.app.index("function messageRecord("):])

    def test_the_long_press_menu_offers_bookmark_after_mark_unread(self):
        menu = self.app[self.app.index("function openMsgMenu("):self.app.index("// Places the card near the press point")]
        self.assertLess(menu.index('msgMenuItem("Mark unread"'), menu.index('msgMenuItem("Bookmark"'))
        self.assertLess(menu.index('msgMenuItem("Mark unread"'), menu.index('msgMenuItem("Remove bookmark"'))
        self.assertIn("meta.bookmarked", menu)

    def test_the_app_creates_the_panel_and_the_panels_close_each_other(self):
        self.assertIn('import { createBookmarks } from "./bookmarks.js";', self.app)
        self.assertIn("const bookmarks = createBookmarks({", self.app)
        self.assertIn("els.bookmarkBtn.addEventListener", self.app)
        self.assertIn("void bookmarks.refreshIds().then(refreshBookmarkMarks);", self.app)
        self.assertIn("void bookmarks.close()", self.app)
        self.assertIn(".then(() => bookmarks.close())", self.app)
        self.assertIn("onChange: refreshBookmarkMarks", self.app)


if __name__ == "__main__":
    unittest.main()
