"""Search: the Search row under New chat, the panel and plugin_api.py /search.

The route tests build a small ``state.db`` in a disposable ``HERMES_HOME`` and need FastAPI; where it is absent that
class is skipped rather than silently passing. The static tests read the shipped files.
"""

from __future__ import annotations

import sqlite3
import unittest

from tests.support import DASHBOARD, DisposableHome

try:  # Hermes ships FastAPI; a bare harness may not
    from tests.test_routes import HAVE_FASTAPI, build_app

    from starlette.testclient import TestClient
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False
    build_app = None  # type: ignore[assignment]
    TestClient = None  # type: ignore[assignment]


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class SearchRouteTest(DisposableHome):
    BASE = "/api/plugins/hermes-mini/search"
    CHATS = "/api/plugins/hermes-mini/app-chats"

    def setUp(self):
        super().setUp()
        self.app, self.api = build_app()
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def _db(self, fts=False):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER, started_at REAL, last_active REAL)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " display_kind TEXT, display_metadata TEXT, timestamp REAL, finish_reason TEXT, tool_calls TEXT,"
            " active INTEGER, compacted INTEGER, message_uid TEXT, display_order INTEGER,"
            " _compressed_summary INTEGER DEFAULT 0, absorbed_message_uids TEXT)"
        )
        conn.execute("INSERT INTO sessions VALUES ('chat', 'Reminders', 0, 1800000000, 1800000100)")
        conn.commit()
        self.client.post(self.CHATS, json={"id": "chat"})
        if fts:
            conn.execute("CREATE VIRTUAL TABLE messages_fts USING fts5(content)")
        conn.commit()
        return conn

    def _add(self, conn, row_id, text, role="assistant", session="chat", ts=1_800_000_000.0, kind=None,
             meta=None, finish="stop", tools=None, active=1, compacted=0, uid=None, slot=None,
             summary=0, absorbed=None):
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, display_kind, display_metadata, timestamp,"
            " finish_reason, tool_calls, active, compacted, message_uid, display_order,"
            " _compressed_summary, absorbed_message_uids)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row_id, session, role, text, kind, meta, ts, finish if role == "assistant" else None, tools,
             active, compacted, uid, slot, summary, absorbed),
        )
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_fts'").fetchone():
            conn.execute("INSERT INTO messages_fts (rowid, content) VALUES (?, ?)", (row_id, text))
        conn.commit()

    def search(self, q, limit=None):
        url = f"{self.BASE}?q={q}"
        if limit is not None:
            url += f"&limit={limit}"
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_blank_query_returns_nothing(self):
        self._db()
        for q in ("", "   ", "%20%20"):
            self.assertEqual(self.search(q), {"chats": [], "messages": []})

    def test_title_matches_only_in_scope_chats(self):
        conn = self._db()
        conn.execute("INSERT INTO sessions VALUES ('archived', 'Reminders old', 1, 1800000000, 1800000000)")
        conn.execute("INSERT INTO sessions VALUES ('cli', 'Reminders cli', 0, 1800000000, 1800000000)")
        conn.execute("INSERT INTO sessions VALUES ('other', 'Errands', 0, 1800000000, 1800000000)")
        conn.commit()
        self.client.post(self.CHATS, json={"id": "other"})
        data = self.search("reminders")
        self.assertEqual([chat["session_id"] for chat in data["chats"]], ["chat"])
        self.assertEqual(data["chats"][0]["title"], "Reminders")
        self.assertFalse(data["chats"][0]["home"])
        self.assertEqual(data["chats"][0]["ts"], 1_800_000_100.0)

    def test_message_matches_include_user_and_assistant_and_respect_visibility(self):
        conn = self._db()
        self._add(conn, 1, "Deploy is **green**.", ts=1_800_000_010.0)
        self._add(conn, 2, "Is deploy green?", role="user", ts=1_800_000_020.0)
        self._add(conn, 3, "Deploy hidden.", kind="hidden")
        self._add(conn, 4, "Deploy model only.", meta='{"model_only": true}')
        self._add(conn, 5, "Deploy tool preamble.", finish="tool_calls")
        self._add(conn, 6, "[SILENT]")
        self._add(conn, 7, "Deploy in a CLI chat.", session="cli")
        self._add(conn, 8, "Tool row deploy.", role="tool")
        conn.commit()
        data = self.search("deploy")
        self.assertEqual([item["id"] for item in data["messages"]], [2, 1])
        self.assertEqual([item["role"] for item in data["messages"]], ["user", "assistant"])
        self.assertIn("green", data["messages"][0]["snippet"])
        for item in data["messages"]:
            self.assertEqual(item["session_id"], "chat")
            self.assertEqual(item["thread"], "Reminders")
            self.assertFalse(item["home"])

    def test_multi_word_and_punctuation_queries_do_not_crash(self):
        conn = self._db(fts=True)
        self._add(conn, 1, "Check column_total and v0.2.1 now", ts=1_800_000_010.0)
        self._add(conn, 2, 'He said "hello world" today', role="user", ts=1_800_000_020.0)
        self._add(conn, 3, "Welcome to the -dash- test", ts=1_800_000_030.0)
        found = self.search("column_total%20now")
        self.assertEqual([item["id"] for item in found["messages"]], [1])
        self.assertEqual([item["id"] for item in self.search("v0.2.1")["messages"]], [1])
        self.assertEqual([item["id"] for item in self.search("%22hello")["messages"]], [2])
        self.assertEqual([item["id"] for item in self.search("-dash-")["messages"]], [3])
        # A bare quote is not a syntax error: the quoted FTS phrase simply finds nothing and the LIKE lane answers.
        self.assertEqual([item["id"] for item in self.search("%22")["messages"]], [2])

    def test_a_mid_word_substring_matches_the_same_with_and_without_fts(self):
        for fts in (True, False):
            with self.subTest(fts=fts):
                # A fresh state.db per lane, so the two runs cannot share tables.
                (self.home / "state.db").unlink(missing_ok=True)
                conn = self._db(fts=fts)
                self._add(conn, 1, "The column_total is wrong.")
                self.assertEqual([item["id"] for item in self.search("total")["messages"]], [1])
                self.assertEqual([item["id"] for item in self.search("column_total")["messages"]], [1])

    def test_a_plain_like_scan_works_without_the_fts_table(self):
        conn = self._db(fts=False)
        self._add(conn, 1, "Backup finished at noon.")
        self.assertEqual([item["id"] for item in self.search("backup")["messages"]], [1])
        self.assertFalse(conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_fts'").fetchone())

    def test_a_compacted_message_resolves_to_the_drawn_copy_once(self):
        conn = self._db()
        self._add(conn, 1, "Deploy is green.", uid="u1", slot=1, active=0, compacted=1)
        self._add(conn, 9, "Deploy is green.", uid="u1", slot=1)
        data = self.search("deploy")
        self.assertEqual([item["id"] for item in data["messages"]], [9])

    def test_a_job_delivery_reads_as_an_agent_message(self):
        conn = self._db()
        self._add(conn, 1, "[Scheduled job result] Backup finished.", role="user", kind="job_delivery")
        self._add(conn, 2, "Thanks, noted.", role="user", ts=1_800_000_020.0)
        data = self.search("backup")
        self.assertEqual([item["id"] for item in data["messages"]], [1])
        self.assertEqual(data["messages"][0]["role"], "assistant")
        self.assertEqual(data["messages"][0]["snippet"], "Backup finished.")
        # A normal person message keeps its own side.
        self.assertEqual(self.search("noted")["messages"][0]["role"], "user")

    def test_tool_call_rows_in_fts_do_not_starve_visible_matches(self):
        conn = self._db(fts=True)
        self._add(conn, 1, "Run python3 manage.py check.", ts=1_800_000_001.0)
        for idx in range(2, 210):
            self._add(conn, idx, f"Running python3 step {idx}", finish="tool_calls",
                      tools='[{"id": "call_1"}]', ts=1_800_000_000.0 + idx)
        data = self.search("python3")
        self.assertEqual([item["id"] for item in data["messages"]], [1])

    def test_compaction_summaries_are_hidden_and_merged_carriers_are_unwrapped(self):
        conn = self._db(fts=True)
        end = "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---"
        prior = "[PRIOR CONTEXT — for reference only; not a new message]"
        delim = "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]"
        head = "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns mention secretword."
        # Standalone summaries (user and assistant) are hidden in chat and must never match.
        self._add(conn, 1, f"{head}\n\n{end}", role="user", summary=1, ts=1_800_000_010.0)
        self._add(conn, 2, f"{prior}\n\n\n{delim}\n\n{head}\n\n{end}", role="assistant", summary=1, ts=1_800_000_020.0)
        # Merged carriers keep only the real message outside the summary.
        self._add(conn, 3, f"{prior}\nVisible reply about deploy.\n\n{delim}\n\n{head}\n\n{end}",
                  role="assistant", summary=1, ts=1_800_000_030.0)
        self._add(conn, 4, f"{head}\n\n{end}\n\nVisible question about deploy.",
                  role="user", summary=1, ts=1_800_000_040.0)
        self.assertEqual(self.search("secretword")["messages"], [])
        self.assertEqual(self.search("compaction")["messages"], [])
        hits = self.search("deploy")["messages"]
        self.assertEqual([item["id"] for item in hits], [4, 3])
        self.assertEqual(hits[0]["snippet"], "Visible question about deploy.")
        self.assertEqual(hits[1]["snippet"], "Visible reply about deploy.")

    def test_skill_messages_match_only_their_visible_label_and_words(self):
        single = (
            '[IMPORTANT: The user has invoked the "humanizer" skill, indicating they want you to follow its '
            'instructions. The full skill content is loaded below.]\n\nHidden skill body with secretword.\n\n'
            'The user has provided the following instruction alongside the skill invocation: fix the leak'
            '\n\n[Runtime note: from chat]'
        )
        stacked = (
            '[IMPORTANT: The user has invoked the "/humanizer /github" stacked skill bundle, loading 2 skills '
            'together.]\n\nUser instruction: ship it\n\n[Loaded as part of the stacked skill invocation '
            '"humanizer".]\n\nHidden skill body with secretword.'
        )
        for fts in (True, False):
            with self.subTest(fts=fts):
                (self.home / "state.db").unlink(missing_ok=True)
                conn = self._db(fts=fts)
                self._add(conn, 1, single, role="user", ts=1_800_000_010.0)
                self._add(conn, 2, stacked, role="user", ts=1_800_000_020.0)
                for hidden_term in ("secretword", "invoked", "instructions", "runtime"):
                    self.assertEqual(self.search(hidden_term)["messages"], [], hidden_term)
                for skill_term in ("humanizer", "%2Fhumanizer"):
                    hits = self.search(skill_term)["messages"]
                    self.assertEqual([item["id"] for item in hits], [2, 1], skill_term)
                    self.assertEqual(hits[0]["snippet"], "/humanizer /github ship it")
                    self.assertEqual(hits[1]["snippet"], "/humanizer fix the leak")
                leak = self.search("leak")["messages"]
                self.assertEqual([item["id"] for item in leak], [1])
                self.assertEqual(leak[0]["snippet"], "/humanizer fix the leak")

    def test_user_notices_and_wrappers_follow_chat_entries(self):
        conn = self._db(fts=True)
        row_id = 1
        for kind in ("internal_notification", "process_complete", "async_delegation_complete",
                     "personality_switch", "auto_continue", "model_switch", "failed_turn"):
            self._add(conn, row_id, f"Notice about deploy ({kind})", role="user", kind=kind)
            row_id += 1
        self._add(conn, row_id, "[System: The active model for this chat has changed to deploy-v1.]", role="user")
        row_id += 1
        self._add(conn, row_id, "[Background process proc_1 heartbeat #2 deploy running]", role="user")
        row_id += 1
        self._add(conn, row_id, "@image:/tmp/shot.png", role="user")
        row_id += 1
        self._add(
            conn, 50,
            "[OUT-OF-BAND USER MESSAGE — delivered once]\nCheck [Schedule: Morning deploy · job j99] now\n"
            "[/OUT-OF-BAND USER MESSAGE]\n@file:/tmp/secret.xlsx\n\n--- Attached Context ---\nsecretword in file",
            role="user", kind="steer", ts=1_800_000_050.0,
        )
        self.assertEqual(self.search("secretword")["messages"], [])
        self.assertEqual(self.search("secret.xlsx")["messages"], [])
        self.assertEqual(self.search("OUT-OF-BAND")["messages"], [])
        self.assertEqual(self.search("Photo")["messages"], [])
        self.assertEqual(self.search("j99")["messages"], [])
        hits = self.search("deploy")["messages"]
        self.assertEqual([item["id"] for item in hits], [50])
        self.assertEqual(hits[0]["role"], "user")
        self.assertEqual(hits[0]["snippet"], "Check Morning deploy now")

    def test_folded_job_delivery_matches_as_agent_reply_under_original_id(self):
        conn = self._db(fts=True)
        self._add(conn, 10, "[Scheduled job result] Backup finished.", role="user", kind="job_delivery",
                  active=0, compacted=0, uid="u_job", ts=1_800_000_010.0)
        self._add(conn, 11, "Thanks, noted.", role="user", active=0, compacted=0, uid="u_user", ts=1_800_000_020.0)
        self._add(conn, 12, "[Scheduled job result] Backup finished.\n\nThanks, noted.", role="user",
                  active=1, compacted=0, uid="u_job", absorbed='["u_user"]', ts=1_800_000_020.0)
        job_hits = self.search("backup")["messages"]
        self.assertEqual([item["id"] for item in job_hits], [10])
        self.assertEqual(job_hits[0]["role"], "assistant")
        self.assertEqual(job_hits[0]["snippet"], "Backup finished.")
        user_hits = self.search("noted")["messages"]
        self.assertEqual([item["id"] for item in user_hits], [12])
        self.assertEqual(user_hits[0]["role"], "user")
        self.assertEqual(user_hits[0]["snippet"], "Thanks, noted.")

    def test_limit_is_clamped(self):
        conn = self._db()
        for row_id in range(1, 8):
            self._add(conn, row_id, f"Deploy number {row_id}", ts=1_800_000_000.0 + row_id)
        self.assertEqual(len(self.search("deploy", limit=2)["messages"]), 2)
        self.assertEqual(len(self.search("deploy", limit=0)["messages"]), 1)
        self.assertEqual(len(self.search("deploy", limit=500)["messages"]), 7)

    def test_nothing_is_written_under_the_plugin_package(self):
        conn = self._db()
        self._add(conn, 1, "Deploy is green.")
        before = self.snapshot_tree(DASHBOARD)
        self.search("deploy")
        self.search("reminders")
        self.assertEqual(self.snapshot_tree(DASHBOARD), before)


class SearchFrontEndTest(unittest.TestCase):
    def setUp(self):
        self.html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.drawer = (DASHBOARD / "drawer.js").read_text(encoding="utf-8")
        self.js = (DASHBOARD / "search.js").read_text(encoding="utf-8")
        self.css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")

    def test_the_drawer_row_sits_under_new_chat(self):
        self.assertIn('id="searchBtn" class="drawer-new drawer-search"', self.html)
        self.assertLess(self.html.index('id="drawerNew"'), self.html.index('id="searchBtn"'))
        self.assertLess(self.html.index('id="searchBtn"'), self.html.index('id="schedBtn"'))
        self.assertIn('aria-controls="searchDialog"', self.html)
        self.assertIn("<span>Search</span>", self.html)

    def test_the_panel_is_a_dialog_with_a_field_and_results(self):
        self.assertIn('id="searchScrim" class="scrim todo-scrim"', self.html)
        self.assertIn('id="searchDialog" class="todo-dialog search-dialog"', self.html)
        self.assertIn('role="dialog" aria-modal="true" aria-labelledby="searchTitle"', self.html)
        for part in ("searchBack", "searchTitle", "searchClose", "searchInput", "searchClear", "searchResults", "searchEmpty"):
            self.assertIn(f'id="{part}"', self.html)
        self.assertIn("Search chat titles and messages.", self.html)
        # Side panels keep the z-index ladder, never a manual popover.
        tag = self.html[self.html.index('id="searchDialog"'):]
        self.assertNotIn("popover", tag[:tag.index(">")])
        self.assertIn(".search-dialog { width: min(560px, calc(100vw - 32px)); }", self.css)

    def test_the_drawer_places_the_row_after_new_chat(self):
        self.assertIn('const searchBtn = $("searchBtn");', self.drawer)
        self.assertEqual(self.drawer.count("if (searchBtn) list.append(searchBtn);"), 2)
        fn = self.drawer[self.drawer.index("function renderBrowse("):self.drawer.index("\n  function rowEl(")]
        self.assertLess(fn.index("list.append(newBtn);"), fn.index("if (searchBtn) list.append(searchBtn);"))

    def test_the_module_reads_the_route_and_builds_text_safely(self):
        self.assertIn('const SEARCH_API = "/api/plugins/hermes-mini/search";', self.js)
        self.assertIn("api(`${SEARCH_API}?q=${encodeURIComponent(query)}`)", self.js)
        self.assertIn("document.createTextNode", self.js)
        self.assertIn('document.createElement("mark")', self.js)
        # Result text is never parsed as HTML.
        self.assertNotIn("innerHTML", self.js)
        self.assertIn('"Chats"', self.js)
        self.assertIn('"Messages"', self.js)
        self.assertIn('"No matches"', self.js)
        self.assertIn('"Could not search chats."', self.js)
        self.assertIn("search.js", self.sw.split("const CORE = [", 1)[1].split("];", 1)[0])
        self.assertRegex(self.sw, r'const CACHE = "hermes-mini-v\d+";')

    def test_the_app_wires_the_panel_and_its_exits(self):
        self.assertIn('import { createSearch } from "./search.js";', self.app)
        self.assertIn("const search = createSearch({", self.app)
        self.assertIn("openSession: (sessionId) => openTarget(sessionId, null)", self.app)
        self.assertIn("openMessage: (sessionId, messageId) => openTarget(sessionId, { messageId, match: \"\", ts: 0 })", self.app)
        self.assertIn('document.getElementById("searchBtn").addEventListener', self.app)
        self.assertIn(".then(() => search.close())", self.app)
        self.assertIn(".then(() => search.open())", self.app)
        self.assertIn(".search-results", self.app)  # a scrolling area, so custom scrollbars work


    def test_home_icon_shown_on_both_chat_and_message_results(self):
        self.assertIn("function homeIcon()", self.js)
        chat_fn = self.js[self.js.index("function chatRow("):self.js.index("function messageRow(")]
        msg_fn = self.js[self.js.index("function messageRow("):self.js.index("function group(")]
        self.assertIn("if (item.home) head.append(homeIcon());", chat_fn)
        self.assertIn("if (item.home) head.append(homeIcon());", msg_fn)
if __name__ == "__main__":
    unittest.main()
