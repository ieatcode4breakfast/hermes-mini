"""The app's HTTP routes: identity, settings, capabilities and the first-run/home-target flow; restart
and gateway events; dictation; the Inbox and merged jobs; to-dos; seen/unread markers; the app-chats
registry; and audio metadata.

These import the real ``dashboard/plugin_api.py`` and call the routes through the actual FastAPI
router, with a ``TestClient``. They need FastAPI (which Hermes ships); where it is absent the class
is skipped rather than silently passing.

Every test runs against a disposable ``HERMES_HOME``.
"""

from __future__ import annotations

import copy
import io
import json
import os
import sqlite3
import sys
import types
import unittest
from unittest import mock

from tests.support import DASHBOARD, DisposableHome, load_module

try:  # Hermes ships FastAPI; a bare harness may not
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    HAVE_FASTAPI = True
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False

from tests import images


def build_app():
    """Mount the plugin router at its real prefix on a throwaway FastAPI app."""
    module = load_module("hermes_dashboard_plugin_hermes-mini", DASHBOARD / "plugin_api.py")
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/hermes-mini")
    return app, module


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class RouteTestCase(DisposableHome):
    def setUp(self):
        super().setUp()
        self.app, self.api = build_app()
        self.client = TestClient(self.app, raise_server_exceptions=False)


class RestartCommandTest(RouteTestCase):
    def _argv(self, *extra):
        return ["hermes", "dashboard", "--no-open", "--host", "127.0.0.1", "--port", "9119", *extra]

    def test_restart_target_reads_the_dashboard_argv(self):
        with mock.patch.object(sys, "argv", self._argv()):
            self.assertEqual(self.api._restart_target(), ("127.0.0.1", "9119"))

    def test_command_kills_this_process_and_keeps_skip_build(self):
        with (
            mock.patch.object(sys, "argv", self._argv("--skip-build")),
            mock.patch.object(self.api.core, "find_hermes_executable", return_value="/usr/local/bin/hermes"),
        ):
            command = self.api._restart_all_command()
        self.assertIn("gateway restart -y --detach", command)
        self.assertIn(f"kill {os.getpid()}", command)
        self.assertIn("dashboard --no-open --port 9119 --host 127.0.0.1 --skip-build", command)

    def test_command_does_not_add_skip_build_when_absent(self):
        with (
            mock.patch.object(sys, "argv", self._argv()),
            mock.patch.object(self.api.core, "find_hermes_executable", return_value="/usr/local/bin/hermes"),
        ):
            command = self.api._restart_all_command()
        self.assertNotIn("--skip-build", command)


class DictationRouteTest(RouteTestCase):
    def test_a_recording_reaches_the_provider_through_a_temp_file(self):
        with mock.patch.object(self.api, "_transcribe_sync", return_value={"ok": True, "text": "hello"}):
            response = self.client.post(
                "/api/plugins/hermes-mini/dictate",
                content=b"x" * 200,
                headers={"content-type": "audio/webm"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "text": "hello"})


class InboxJobWrapperTest(RouteTestCase):
    def test_a_wrapped_job_preview_shows_only_the_result(self):
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE m (id INTEGER, role TEXT, display_kind TEXT, content TEXT, session_id TEXT, "
            "timestamp REAL, display_metadata TEXT, finish_reason TEXT, tool_calls TEXT)"
        )
        conn.execute(
            "INSERT INTO m VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                1,
                "user",
                "job_delivery",
                "[Scheduled job result]\nCronjob Response: Jump reminder\n(job_id: 2c5acc839c96)\n"
                "-------------\n\nJump reminder — time to jump!\n\n"
                'To stop or manage this job, send me a new message (e.g. "stop reminder Jump reminder").',
                "home",
                1.0,
                None,
                None,
                None,
            ),
        )
        item = self.api._inbox_item(conn.execute("SELECT * FROM m").fetchone(), {})
        self.assertIsNotNone(item)
        self.assertNotIn("Cronjob Response", item["text"])
        self.assertEqual(item["text"], "Jump reminder — time to jump!")

    def test_a_preview_keeps_underscores_and_drops_formatting(self):
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE m (id INTEGER, role TEXT, display_kind TEXT, content TEXT, session_id TEXT, "
            "timestamp REAL, display_metadata TEXT, finish_reason TEXT, tool_calls TEXT)"
        )
        conn.execute(
            "INSERT INTO m VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (1, "assistant", "", "## Totals\n**Done:** `column_total` and snake_case_name, 2*3=6", "s", 1.0,
             None, "stop", None),
        )
        item = self.api._inbox_item(conn.execute("SELECT * FROM m").fetchone(), {})
        self.assertEqual(item["text"], "Totals Done: column_total and snake_case_name, 2*3=6")


class GatewayEventsRouteTest(RouteTestCase):
    def test_lists_recorded_stops_and_starts(self):
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/gateway-events").json(), {"events": []})
        self.api.core.record_gateway_event("down", ts=100)
        self.api.core.record_gateway_event("up", ts=104)
        response = self.client.get("/api/plugins/hermes-mini/gateway-events")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["events"], [{"ts": 100.0, "kind": "down"}, {"ts": 104.0, "kind": "up"}])


class RestartWritesItsLineFirstTest(RouteTestCase):
    def test_the_restart_route_records_the_stop_before_anything_stops(self):
        self.api._last_restart = 0.0
        with (
            mock.patch.object(self.api.core, "find_hermes_executable", return_value="/usr/local/bin/hermes"),
            mock.patch("subprocess.Popen") as popen,
        ):
            response = self.client.post("/api/plugins/hermes-mini/gateway/restart")
        popen.assert_called_once()
        self.assertEqual(response.status_code, 200)
        event = response.json()["event"]
        self.assertEqual(event["kind"], "down")
        self.assertEqual(self.api.core.gateway_events(), [event])
        # The gateway's own report of the same stop is not a second line.
        self.assertFalse(self.api.core.record_gateway_event("down"))

    def test_a_restart_that_cannot_start_writes_no_line(self):
        self.api._last_restart = 0.0
        with (
            mock.patch.object(self.api.core, "find_hermes_executable", return_value="/usr/local/bin/hermes"),
            mock.patch("subprocess.Popen", side_effect=OSError("no bash")),
        ):
            response = self.client.post("/api/plugins/hermes-mini/gateway/restart")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.api.core.gateway_events(), [])


class InboxDbCase(RouteTestCase):
    """A small state.db with one app chat; helpers for the Inbox routes. Holds no tests itself."""

    BASE = "/api/plugins/hermes-mini/inbox"

    def _db(self, with_uid=True):
        path = self.home / "state.db"
        conn = sqlite3.connect(path)
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, "
            "display_metadata TEXT, timestamp REAL, finish_reason TEXT, tool_calls TEXT, active INTEGER, "
            f"compacted INTEGER{', message_uid TEXT' if with_uid else ''})"
        )
        conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL, acquired_at REAL)")
        conn.execute("INSERT INTO sessions VALUES ('chat', 'Reminders', 0)")
        conn.commit()
        self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "chat"})
        self.with_uid = with_uid
        return conn

    def _add(self, conn, row_id, uid, text, active=1, ts=1_800_000_000.0):
        if getattr(self, "with_uid", True):
            conn.execute(
                "INSERT INTO messages VALUES (?, 'chat', 'assistant', ?, NULL, NULL, ?, 'stop', NULL, ?, 0, ?)",
                (row_id, text, ts, active, uid),
            )
        else:
            conn.execute(
                "INSERT INTO messages VALUES (?, 'chat', 'assistant', ?, NULL, NULL, ?, 'stop', NULL, ?, 0)",
                (row_id, text, ts, active),
            )
        conn.commit()

    def _compact(self, conn, moves):
        """Context compaction: every row goes inactive, the kept ones come back as new rows (same uid and time)."""
        old = {row[0]: row for row in conn.execute("SELECT id, message_uid, content, timestamp FROM messages")}
        conn.execute("UPDATE messages SET active = 0")
        for old_id, new_id in moves.items():
            _, uid, text, ts = old[old_id]
            self._add(conn, new_id, uid, text, ts=ts)

    def count(self):
        response = self.client.get(f"{self.BASE}/unread-count")
        self.assertEqual(response.status_code, 200)
        return response.json()["count"]

    def feed(self, unread=False):
        response = self.client.get(f"{self.BASE}?limit=100{'&unread=1' if unread else ''}")
        self.assertEqual(response.status_code, 200)
        return response.json()["items"]

    def flags(self):
        return {item["id"]: (item["read"], item["marked_unread"]) for item in self.feed()}

    def unread_tab(self):
        return [item["id"] for item in self.feed(unread=True)]

    def mark(self, route, ids, manual=True):
        response = self.client.post(f"{self.BASE}/{route}", json={"ids": ids, "manual": manual})
        self.assertEqual(response.status_code, 200, response.text)
        return response

    def stored(self):
        return json.loads((self.home / "data" / "hermes-mini" / "inbox-read.json").read_text(encoding="utf-8"))


class InboxCompactionCopyTest(InboxDbCase):
    """Context compaction re-inserts kept messages under new ids; a read message must stay read."""

    def test_a_compaction_copy_of_a_read_reply_stays_read(self):
        self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "chat"})
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged: 10h30m")
        self._add(conn, 11, "uid-b", "Changed the wording", ts=1_800_000_060.0)
        base = "/api/plugins/hermes-mini/inbox"
        self.assertEqual(self.client.get(f"{base}/unread-count").json()["count"], 2)
        self.client.post(f"{base}/read", json={"ids": [10]})
        self.assertEqual(self.client.get(f"{base}/unread-count").json()["count"], 1)

        # Compaction: the originals go inactive and come back as new rows with the same message_uid.
        conn.execute("UPDATE messages SET active = 0")
        self._add(conn, 50, "uid-a", "Logged: 10h30m")
        self._add(conn, 51, "uid-b", "Changed the wording", ts=1_800_000_060.0)
        conn.close()

        self.assertEqual(self.client.get(f"{base}/unread-count").json()["count"], 1)
        unread = self.client.get(f"{base}?unread=1").json()["items"]
        self.assertEqual([item["id"] for item in unread], [51])
        feed = {item["id"]: item["read"] for item in self.client.get(base).json()["items"]}
        self.assertEqual(feed, {50: True, 51: False})

    def test_mark_unread_wins_over_the_watermark_and_read_copies(self):
        self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "chat"})
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged: 10h30m")
        self._add(conn, 11, "uid-b", "Changed the wording", ts=1_800_000_060.0)
        base = "/api/plugins/hermes-mini/inbox"
        count = lambda: self.client.get(f"{base}/unread-count").json()["count"]
        flags = lambda: {item["id"]: item["read"] for item in self.client.get(base).json()["items"]}
        unread_tab = lambda: [item["id"] for item in self.client.get(f"{base}?unread=1").json()["items"]]
        mark = lambda route, ids, manual=True: self.client.post(f"{base}/{route}", json={"ids": ids, "manual": manual})

        self.client.post(f"{base}/read-all", json={})
        self.assertEqual(count(), 0)
        # Under the watermark: marked unread on purpose, then read again.
        self.assertEqual(mark("unread", [10]).status_code, 200)
        self.assertEqual((count(), unread_tab(), flags()), (1, [10], {10: False, 11: True}))
        held = {item["id"]: item["marked_unread"] for item in self.client.get(base).json()["items"]}
        self.assertEqual(held, {10: True, 11: False})
        # Seen in the chat (a read that is not manual): a message marked unread by hand stays unread.
        mark("read", [10], manual=False)
        self.assertEqual((count(), unread_tab()), (1, [10]))
        mark("read", [10])
        self.assertEqual((count(), unread_tab()), (0, []))
        # Never marked unread by hand: a chat view reads it as before.
        mark("read", [11], manual=False)
        self.assertEqual(count(), 0)

        # A compaction copy of a read message: unread on purpose, then read again.
        conn.execute("UPDATE messages SET active = 0")
        self._add(conn, 50, "uid-a", "Logged: 10h30m")
        conn.close()
        self.assertEqual(count(), 0)
        mark("unread", [50])
        self.assertEqual((count(), unread_tab()), (1, [50]))
        mark("read", [50])
        self.assertEqual(count(), 0)

        # Mark all clears every purposeful unread under it.
        mark("unread", [50])
        self.client.post(f"{base}/read-all", json={})
        self.assertEqual(count(), 0)
        self.assertEqual(mark("unread", ["x"]).status_code, 400)


class MergedJobRowsTest(InboxDbCase):
    """Hermes folds job results and the person's next message into one user row (dropping the job label).

    The chat redraws that row from its originals (/merged-jobs) and the Inbox lists the job originals again.
    """

    JOB = "[Scheduled job result]\n"

    def _merged_db(self, with_absorbed=True):
        path = self.home / "state.db"
        conn = sqlite3.connect(path)
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, "
            "display_metadata TEXT, timestamp REAL, finish_reason TEXT, tool_calls TEXT, active INTEGER, "
            f"compacted INTEGER, message_uid TEXT{', absorbed_message_uids TEXT' if with_absorbed else ''})")
        conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL, acquired_at REAL)")
        conn.execute("INSERT INTO sessions VALUES ('chat', 'Reminders', 0)")
        self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "chat"})

        def row(row_id, role, content, kind, ts, active, uid, absorbed=None):
            values = [row_id, "chat", role, content, kind, None, ts, "stop" if role == "assistant" else None, None,
                      active, 0, uid]
            if with_absorbed:
                values.append(absorbed)
            conn.execute(f"INSERT INTO messages VALUES ({','.join('?' for _ in values)})", values)

        row(1, "assistant", "Morning.", None, 1_800_000_000.0, 1, "u-a")
        # Two job results, then the person's reply: the originals go inactive, the fold is a new active row.
        row(2, "user", self.JOB + "Take your meds.", "job_delivery", 1_800_000_100.0, 0, "u-j1")
        row(3, "user", self.JOB + "Sleep check: what time did you sleep?", "job_delivery", 1_800_000_200.0, 0, "u-j2")
        row(4, "user", "Slept around 10:30.", None, 1_800_000_300.0, 0, "u-me")
        merged = "\n\n".join([self.JOB + "Take your meds.", self.JOB + "Sleep check: what time did you sleep?",
                                "Slept around 10:30."])
        row(9, "user", merged, None, 1_800_000_100.0, 1, "u-j1", json.dumps(["u-j2", "u-me"]) if with_absorbed else None)
        row(10, "assistant", "Logged.", None, 1_800_000_400.0, 1, "u-b")
        conn.commit()
        return conn

    def parts(self):
        response = self.client.get("/api/plugins/hermes-mini/merged-jobs?session=chat")
        self.assertEqual(response.status_code, 200)
        return response.json()["rows"]

    def test_the_chat_gets_the_originals_of_a_folded_row(self):
        self._merged_db()
        parts = self.parts()
        self.assertEqual(list(parts), ["9"])
        self.assertEqual([(p["id"], p["display_kind"]) for p in parts["9"]],
                         [(2, "job_delivery"), (3, "job_delivery"), (9, None)])
        self.assertEqual(parts["9"][2]["content"], "Slept around 10:30.")
        self.assertEqual(parts["9"][0]["timestamp"], 1_800_000_100.0)

    def test_the_inbox_lists_folded_job_results_by_their_original_ids(self):
        self._merged_db()
        self.assertEqual(sorted(item["id"] for item in self.feed()), [1, 2, 3, 10])
        texts = {item["id"]: item["text"] for item in self.feed()}
        self.assertEqual(texts[3], "Sleep check: what time did you sleep?")
        self.assertEqual(self.count(), 4)
        self.mark("read", [2, 3], manual=False)
        self.assertEqual(self.count(), 2)

    def test_a_job_result_still_shown_by_an_active_copy_is_not_listed_twice(self):
        conn = self._merged_db()
        conn.execute("INSERT INTO messages VALUES (20, 'chat', 'user', ?, 'job_delivery', NULL, 1800000200.0, NULL, NULL,"
                     " 1, 0, 'u-j2', NULL)", (self.JOB + "Sleep check: what time did you sleep?",))
        conn.commit()
        self.assertEqual(sorted(item["id"] for item in self.feed()), [1, 2, 10, 20])

    def test_a_fold_without_a_job_or_with_a_missing_original_is_left_alone(self):
        conn = self._merged_db()
        conn.execute("DELETE FROM messages WHERE id = 3")
        conn.commit()
        self.assertEqual(self.parts(), {})
        conn.execute("UPDATE messages SET display_kind = NULL WHERE id = 2")
        conn.execute("INSERT INTO messages VALUES (3, 'chat', 'user', 'two', NULL, NULL, 1800000200.0, NULL, NULL, 0, 0,"
                     " 'u-j2', NULL)")
        conn.commit()
        self.assertEqual(self.parts(), {})

    def test_an_older_hermes_without_fold_records_changes_nothing(self):
        self._merged_db(with_absorbed=False)
        self.assertEqual(self.parts(), {})
        self.assertEqual(sorted(item["id"] for item in self.feed()), [1, 10])

    def test_the_route_wants_a_chat_id(self):
        self._merged_db()
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/merged-jobs").status_code, 400)
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/merged-jobs?session=nope").json(), {"rows": {}})


class InboxManualUnreadTest(InboxDbCase):
    """Mark unread by hand: wins over every other read rule and holds until marked read by hand or Mark all."""

    def _two_read(self, conn):
        self._add(conn, 10, "uid-a", "Logged: 10h30m")
        self._add(conn, 11, "uid-b", "Changed the wording", ts=1_800_000_060.0)
        self.client.post(f"{self.BASE}/read-all", json={})
        self.assertEqual(self.count(), 0)

    def test_held_unread_survives_a_compaction(self):
        conn = self._db()
        self._two_read(conn)
        self.mark("unread", [10])
        self._compact(conn, {10: 50, 11: 51})
        # The copy of the held message is still unread and still held; the other copy is read.
        self.assertEqual(self.flags(), {50: (False, True), 51: (True, False)})
        self.assertEqual((self.count(), self.unread_tab()), (1, [50]))

    def test_a_chat_view_of_the_copy_does_not_release_it(self):
        conn = self._db()
        self._two_read(conn)
        self.mark("unread", [10])
        self._compact(conn, {10: 50, 11: 51})
        self.mark("read", [50], manual=False)  # the chat scrolled it into view
        self.assertEqual((self.count(), self.flags()[50]), (1, (False, True)))

    def test_marking_the_copy_read_by_hand_releases_the_message(self):
        conn = self._db()
        self._two_read(conn)
        self.mark("unread", [10])
        self._compact(conn, {10: 50, 11: 51})
        self.mark("read", [50])
        self.assertEqual((self.count(), self.flags()), (0, {50: (True, False), 51: (True, False)}))
        self.assertEqual(self.stored()["unread"], [])  # the old id 10 is released too
        # And a second compaction does not bring the hold back.
        self._compact(conn, {50: 70})
        self.assertEqual((self.count(), self.flags()), (0, {70: (True, False)}))

    def test_marking_the_original_read_releases_its_copies(self):
        conn = self._db()
        self._two_read(conn)
        self.mark("unread", [10])
        self._add(conn, 50, "uid-a", "Logged: 10h30m")  # a copy that is still active beside the original
        self.mark("read", [10])
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.stored()["unread"], [])

    def test_an_inbox_tap_releases_the_hold_but_a_chat_view_does_not(self):
        conn = self._db()
        self._two_read(conn)
        self.mark("unread", [11])
        # The chat scrolling it into view is not a decision: the hold stays.
        for _ in range(3):
            self.mark("read", [11], manual=False)
        self.client.post(f"{self.BASE}/read", json={"ids": [11]})  # no "manual" key: the chat's own call
        self.assertEqual((self.count(), self.unread_tab(), self.flags()[11]), (1, [11], (False, True)))
        # A tap on the Inbox row is a hand read: it releases the hold.
        self.mark("read", [11])
        self.assertEqual((self.count(), self.unread_tab(), self.flags()[11]), (0, [], (True, False)))

    def test_a_message_never_held_is_read_by_a_chat_view(self):
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged")
        self._add(conn, 11, "uid-b", "Other", ts=1_800_000_060.0)
        self.assertEqual(self.count(), 2)
        self.mark("unread", [11])
        self.mark("read", [10], manual=False)
        self.assertEqual((self.count(), self.unread_tab()), (1, [11]))

    def test_mark_unread_then_read_round_trip_above_the_watermark(self):
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged")
        self.mark("read", [10], manual=False)
        self.assertEqual(self.count(), 0)
        self.mark("unread", [10])
        self.assertEqual((self.count(), self.flags()), (1, {10: (False, True)}))
        self.assertNotIn(10, self.stored()["read"])
        self.mark("read", [10])
        self.assertEqual((self.count(), self.flags()), (0, {10: (True, False)}))

    def test_mark_all_releases_every_hold(self):
        conn = self._db()
        self._two_read(conn)
        self.mark("unread", [10, 11])
        self.assertEqual(self.count(), 2)
        self.client.post(f"{self.BASE}/read-all", json={})
        self.assertEqual((self.count(), self.unread_tab(), self.stored()["unread"]), (0, [], []))

    def test_the_unread_tab_reaches_an_old_held_message_past_a_long_read_history(self):
        conn = self._db()
        self._add(conn, 1, "uid-old", "The old one", ts=1_700_000_000.0)
        for row_id in range(2, 452):  # 450 newer messages: more than two raw batches of 200
            self._add(conn, row_id, f"uid-{row_id}", f"Message {row_id}", ts=1_800_000_000.0 + row_id)
        self.client.post(f"{self.BASE}/read-all", json={})
        self.assertEqual((self.count(), self.unread_tab()), (0, []))
        self.mark("unread", [1])
        self.assertEqual((self.count(), self.unread_tab()), (1, [1]))
        # The All tab pages to it with the cursor and shows it held.
        items, cursor, seen = [], None, {}
        while True:
            url = f"{self.BASE}?limit=100" + (f"&before={cursor}" if cursor else "")
            body = self.client.get(url).json()
            items += body["items"]
            cursor = body["next"]
            if not cursor:
                break
        seen = {item["id"]: (item["read"], item["marked_unread"]) for item in items}
        self.assertEqual(len(items), 451)
        self.assertEqual(seen[1], (False, True))
        self.assertTrue(all(seen[row_id] == (True, False) for row_id in range(2, 452)))

    def test_a_database_without_message_uid_still_works(self):
        conn = self._db(with_uid=False)
        self._add(conn, 10, None, "Logged")
        self._add(conn, 11, None, "Other", ts=1_800_000_060.0)
        self.assertEqual(self.count(), 2)
        self.mark("read", [10], manual=False)
        self.mark("unread", [11])
        self.mark("read", [11], manual=False)
        self.assertEqual((self.count(), self.flags()), (1, {10: (True, False), 11: (False, True)}))
        self.mark("read", [11])
        self.assertEqual(self.count(), 0)

    def test_a_damaged_read_file_is_an_empty_tracker(self):
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged")
        path = self.home / "data" / "hermes-mini" / "inbox-read.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"watermark": 5, "read": ["x", True, -3], "unread": ["10", False, 0, -1, 2.5]}),
                        encoding="utf-8")
        self.assertEqual((self.count(), self.flags()), (1, {10: (False, False)}))
        path.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.count(), 1)
        self.mark("unread", [10])
        self.assertEqual(self.stored()["unread"], [10])

    def test_the_routes_refuse_bad_bodies(self):
        conn = self._db()
        for body in ({"ids": "10"}, {"ids": [0]}, {"ids": [True]}, {"ids": ["10"]}, {"ids": list(range(1, 1002))}, {}):
            for route in ("read", "unread"):
                response = self.client.post(f"{self.BASE}/{route}", json=body)
                self.assertEqual(response.status_code, 400, (route, body))
        # "manual" must be exactly true; anything else is a chat view.
        self._add(conn, 10, "uid-a", "Logged")
        self.mark("unread", [10])
        for manual in ("true", 1, None):
            self.client.post(f"{self.BASE}/read", json={"ids": [10], "manual": manual})
            self.assertEqual(self.count(), 1, manual)


class InboxStateTest(InboxDbCase):
    """GET /inbox/state: the read flags of specific messages, for the chat's Mark unread / Mark read button."""

    def state(self, ids):
        response = self.client.get(f"{self.BASE}/state?ids={','.join(str(value) for value in ids)}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["states"]

    def test_a_manual_unread_hold_is_reported(self):
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged: 10h30m")
        self.client.post(f"{self.BASE}/read-all", json={})
        self.mark("unread", [10])
        self.assertEqual(self.state([10]), {"10": {"read": False, "marked_unread": True}})

    def test_a_manual_read_releases_the_hold(self):
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged: 10h30m")
        self.mark("unread", [10])
        self.mark("read", [10])
        self.assertEqual(self.state([10]), {"10": {"read": True, "marked_unread": False}})

    def test_a_read_compaction_copy_reports_read_through_its_original(self):
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged: 10h30m")
        self.mark("read", [10])
        self._compact(conn, {10: 50})
        self.assertEqual(self.state([50]), {"50": {"read": True, "marked_unread": False}})

    def test_an_unknown_message_is_omitted(self):
        conn = self._db()
        self._add(conn, 10, "uid-a", "Logged: 10h30m")
        self.assertEqual(list(self.state([10, 999])), ["10"])

    def test_the_route_needs_whole_message_ids(self):
        self._db()
        for ids in ("", "x", "10,x", "-1", "0", "1.5", " "):
            response = self.client.get(f"{self.BASE}/state?ids={ids}")
            self.assertEqual(response.status_code, 400, ids)
        for value in ("²", "١٠"):
            self.assertEqual(self.client.get(f"{self.BASE}/state?ids={value}").status_code, 400, value)

    def test_too_many_ids_are_refused(self):
        self._db()
        ids = ",".join(str(value) for value in range(1, 202))
        self.assertEqual(self.client.get(f"{self.BASE}/state?ids={ids}").status_code, 400)
        ids = ",".join(str(value) for value in range(1, 201))
        self.assertEqual(self.client.get(f"{self.BASE}/state?ids={ids}").status_code, 200)


class ProviderKeyFieldTest(RouteTestCase):
    def test_returns_only_accepted_key_field_names(self):
        auth = types.ModuleType("hermes_cli.auth")
        auth.PROVIDER_REGISTRY = {
            "keys": types.SimpleNamespace(auth_type="api_key", api_key_env_vars=("FIRST_KEY", "ALIAS_KEY")),
            "nous": types.SimpleNamespace(auth_type="oauth_device_code", api_key_env_vars=("IGNORED",)),
            "no-field": types.SimpleNamespace(auth_type="api_key", api_key_env_vars=()),
        }
        with mock.patch.dict(sys.modules, {"hermes_cli.auth": auth}):
            response = self.client.get("/api/plugins/hermes-mini/provider-key-fields")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"providers": {"keys": "FIRST_KEY"}})


class IdentityRoutesTest(RouteTestCase):
    def test_get_identity_is_a_pure_read(self):
        before = self.snapshot_tree(self.home)
        response = self.client.get("/api/plugins/hermes-mini/identity")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["name"], "Hermes")
        self.assertFalse(body["onboarding_complete"])
        self.assertEqual(self.snapshot_tree(self.home), before)
        self.assertFalse((self.home / "hermes-mini").exists())

    def test_status_lists_features_as_booleans(self):
        response = self.client.get("/api/plugins/hermes-mini/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        for key in ("computer", "push", "dictation", "model_configured"):
            self.assertIn(key, body["features"])
            self.assertIsInstance(body["features"][key], bool)

    def test_first_internal_save_writes_identity_outside_package(self):
        payload = images.png(64, 64)
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        # The display name always comes from Hermes; an app-side save no longer renames the agent.
        self.assertEqual(body["name"], "Hermes")
        self.assertTrue(body["onboarding_complete"])
        self.assertTrue(body["avatar_url"].startswith("/api/plugins/hermes-mini/avatar/"))

        config = self.home / "hermes-mini" / "config.yaml"
        assets = self.home / "hermes-mini" / "assets"
        self.assertTrue(config.is_file())
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(assets.iterdir())), 1)

    def test_name_only_save_is_json(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            json={"name": "Ada"},
        )
        # No picture and no saved one: the first-run completion needs one.
        self.assertEqual(response.status_code, 400)
        self.assertIn("picture", response.json()["detail"])

    def test_avatar_is_served_from_external_assets(self):
        self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.png(48, 48),
            headers={"Content-Type": "image/png"},
        )
        identity = self.client.get("/api/plugins/hermes-mini/identity").json()
        response = self.client.get(identity["avatar_url"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertTrue(response.content.startswith(b"\x89PNG"))

    def test_avatar_route_refuses_traversal_and_unknown_files(self):
        for path in ("/api/plugins/hermes-mini/avatar/..%2F..%2Fconfig.yaml",
                     "/api/plugins/hermes-mini/avatar/does-not-exist.png"):
            self.assertIn(self.client.get(path).status_code, (404, 400))


class IdentityValidationTest(RouteTestCase):
    def test_svg_upload_is_refused_by_content(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.SVG_BYTES,
            headers={"Content-Type": "image/svg+xml"},
        )
        # An image/* content type is streamed, then rejected by the byte-level check.
        self.assertEqual(response.status_code, 400)
        self.assertIn("PNG, JPEG or WebP", response.json()["detail"])

    def test_svg_masquerading_as_png_is_refused(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.SVG_BYTES,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 400)

    def test_oversize_upload_is_refused(self):
        oversized = images.png(8, 8) + b"\x00" * (9 * 1024 * 1024)
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=oversized,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 413)

    def test_too_small_image_is_refused(self):
        response = self.client.post(
            "/api/plugins/hermes-mini/identity?name=Ada&complete=1",
            content=images.png(4, 4),
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 400)


class SettingsRoutesTest(RouteTestCase):
    def test_get_settings_reports_paths_and_no_secrets(self):
        body = self.client.get("/api/plugins/hermes-mini/settings").json()
        self.assertEqual(body["config_path"], str(self.home / "hermes-mini" / "config.yaml"))
        self.assertEqual(body["schema"], 1)
        # Nothing that looks like a credential may be exposed.
        text = json.dumps(body).lower()
        for word in ("token", "secret", "password", "api_key"):
            self.assertNotIn(word, text)

    def test_post_settings_validates_urls(self):
        bad = self.client.post("/api/plugins/hermes-mini/settings", json={"public_url": "javascript:alert(1)"})
        self.assertEqual(bad.status_code, 400)
        good = self.client.post("/api/plugins/hermes-mini/settings", json={"public_url": "https://chat.example.com"})
        self.assertEqual(good.status_code, 200)
        self.assertEqual(good.json()["public_url"], "https://chat.example.com")

    def test_home_label_roundtrip(self):
        response = self.client.post("/api/plugins/hermes-mini/settings", json={"home_label": "My desk"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/settings").json()["home_label"], "My desk")


class CapabilitiesTest(RouteTestCase):
    def test_capabilities_are_booleans_only(self):
        body = self.client.get("/api/plugins/hermes-mini/capabilities").json()
        self.assertEqual(set(body), {"computer", "push", "dictation", "model_configured"})
        for value in body.values():
            self.assertIsInstance(value, bool)

    def test_capabilities_do_not_create_push_or_desktop_state(self):
        before = self.plugin_owned()
        self.client.get("/api/plugins/hermes-mini/capabilities")
        self.client.get("/api/plugins/hermes-mini/status")
        self.assertEqual(self.plugin_owned(), before)
        self.assertFalse((self.home / "data" / "hermes-mini" / "push").exists())


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class DataRoutesTest(RouteTestCase):
    def test_todos_roundtrip_and_path(self):
        created = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Buy milk"})
        self.assertEqual(created.status_code, 200, created.text)
        items = self.client.get("/api/plugins/hermes-mini/todos").json()["items"]
        self.assertEqual([item["text"] for item in items], ["Buy milk"])
        # The new row's id comes back, so the app can save a blank row at once and keep typing in it.
        self.assertEqual(created.json()["id"], items[0]["id"])
        blank = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "", "index": 1}).json()
        self.assertIn(blank["id"], [item["id"] for item in blank["items"] if item["text"] == ""])
        self.assertTrue((self.home / "data" / "hermes-mini" / "todos.json").is_file())

    def test_todos_tracked_flag_defaults_true_and_toggles(self):
        created = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Parent item"})
        self.assertEqual(created.status_code, 200, created.text)
        item_id = created.json()["id"]
        self.assertTrue(created.json()["items"][0]["tracked"])

        untracked = self.client.patch(f"/api/plugins/hermes-mini/todos/{item_id}", json={"tracked": False})
        self.assertEqual(untracked.status_code, 200, untracked.text)
        self.assertFalse(untracked.json()["items"][0]["tracked"])

        reread = self.client.get("/api/plugins/hermes-mini/todos").json()["items"]
        self.assertFalse(reread[0]["tracked"])

        retracked = self.client.patch(f"/api/plugins/hermes-mini/todos/{item_id}", json={"tracked": True})
        self.assertEqual(retracked.status_code, 200, retracked.text)
        self.assertTrue(retracked.json()["items"][0]["tracked"])

        bad_post = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Bad", "tracked": "no"})
        self.assertEqual(bad_post.status_code, 400)
        bad_patch = self.client.patch(f"/api/plugins/hermes-mini/todos/{item_id}", json={"tracked": 1})
        self.assertEqual(bad_patch.status_code, 400)

    def test_delete_parent_todo_deletes_children_too(self):
        parent = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Parent"}).json()["id"]
        child1 = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Child 1", "index": 1, "indent": 1}).json()["id"]
        child2 = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Child 2", "index": 2, "indent": 1}).json()["id"]
        other = self.client.post("/api/plugins/hermes-mini/todos", json={"text": "Other", "index": 3, "indent": 0}).json()["id"]
        deleted = self.client.delete(f"/api/plugins/hermes-mini/todos/{parent}")
        self.assertEqual(deleted.status_code, 200)
        remaining_ids = [item["id"] for item in deleted.json()["items"]]
        self.assertEqual(remaining_ids, [other])
        self.assertNotIn(child1, remaining_ids)
        self.assertNotIn(child2, remaining_ids)

    def test_seen_store_is_created_on_first_read_and_kept_outside_package(self):
        body = self.client.get("/api/plugins/hermes-mini/seen").json()
        self.assertIn("seen", body)
        self.assertEqual(body["unread"], [])
        self.assertTrue((self.home / "data" / "hermes-mini" / "seen.json").is_file())

    def test_seen_manual_unread_roundtrip(self):
        marked = self.client.post("/api/plugins/hermes-mini/seen/unread", json={"id": "chat-1", "unread": True})
        self.assertEqual(marked.status_code, 200, marked.text)
        self.assertIn("chat-1", marked.json()["unread"])
        # Passive PUT /seen does not clear a manual unread mark.
        seen_put = self.client.put("/api/plugins/hermes-mini/seen", json={"id": "chat-1", "at": 1_800_000_000})
        self.assertEqual(seen_put.status_code, 200)
        self.assertIn("chat-1", seen_put.json()["unread"])
        # Marking read clears it and updates the seen timestamp.
        cleared = self.client.post(
            "/api/plugins/hermes-mini/seen/unread",
            json={"id": "chat-1", "unread": False, "at": 1_800_000_123},
        )
        self.assertEqual(cleared.status_code, 200, cleared.text)
        self.assertNotIn("chat-1", cleared.json()["unread"])
        self.assertGreaterEqual(cleared.json()["seen"]["chat-1"], 1_800_000_123)
        # Invalid inputs rejected.
        self.assertEqual(self.client.post("/api/plugins/hermes-mini/seen/unread", json={"id": "", "unread": True}).status_code, 400)
        self.assertEqual(self.client.post("/api/plugins/hermes-mini/seen/unread", json={"id": "chat-1", "unread": "yes"}).status_code, 400)

    def test_reading_a_chat_sends_no_push(self):
        # Notifications are not retracted on read. An older cached page still sends its push endpoint: ignored.
        url = "/api/plugins/hermes-mini/seen"
        with mock.patch.object(self.api._push_store(), "_queue") as queued:
            ok = self.client.put(url, json={"id": "chat-a", "at": 1_800_000_000, "endpoint": "https://fcm.googleapis.com/fcm/send/x"})
            self.assertEqual(self.client.put(url, json={"id": "chat-b", "at": 1_800_000_000}).status_code, 200)
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["seen"]["chat-a"], 1_800_000_000)
        queued.put_nowait.assert_not_called()

    def test_app_chats_registry_is_empty_until_a_chat_is_added(self):
        body = self.client.get("/api/plugins/hermes-mini/app-chats").json()
        self.assertEqual(body["ids"], [])
        added = self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "abc123"})
        self.assertEqual(added.status_code, 200)
        self.assertTrue(added.json()["added"])
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/app-chats").json()["ids"], ["abc123"])


class AppChatsHomeRoutesTest(RouteTestCase):
    def test_home_is_claimed_once_and_can_be_cleared(self):
        url = "/api/plugins/hermes-mini/app-chats"
        first = self.client.post(url, json={"id": "chat-a", "home": True}).json()
        self.assertEqual(first["home"], "chat-a")
        self.assertEqual(self.client.get(url).json()["home"], "chat-a")
        second = self.client.post(url, json={"id": "chat-b", "home": True}).json()
        self.assertEqual(second["home"], "chat-a")
        self.assertEqual(self.client.get(url).json()["home"], "chat-a")
        cleared = self.client.delete("/api/plugins/hermes-mini/app-chats/home")
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(self.client.get(url).json()["home"], "")

    def test_clearing_home_also_clears_gateway_events(self):
        self.api.core.record_gateway_event("down", ts=100)
        self.api.core.record_gateway_event("up", ts=104)
        self.assertEqual(len(self.client.get("/api/plugins/hermes-mini/gateway-events").json()["events"]), 2)
        cleared = self.client.delete("/api/plugins/hermes-mini/app-chats/home")
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/gateway-events").json(), {"events": []})

    def test_inbox_scope_uses_the_recorded_home_not_the_title(self):
        self.client.post(
            "/api/plugins/hermes-mini/app-chats", json={"id": "home", "home": True},
        )
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.executemany(
            "INSERT INTO sessions VALUES (?, ?, ?)",
            [
                ("home", "Renamed home", 0),
                ("thief", "Hermes Mini", 0),
                ("side", "Side chat", 0),
            ],
        )
        self.assertEqual(set(self.api._scope_titles(conn)), {"home"})


class HomeTargetSeedTest(RouteTestCase):
    """The one Hermes-owned value the app writes: its default scheduled-job destination."""

    def _run_seed(self, config):
        saved = []
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        module = types.ModuleType("hermes_cli.config")
        module.load_config = lambda: config
        module.save_config = lambda value: saved.append(copy.deepcopy(value))
        with mock.patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.config": module}):
            self.api._ensure_home_target()
            self.api._ensure_home_target()
        return saved

    def test_records_the_main_chat_once(self):
        saved = self._run_seed({"platforms": {}})
        self.assertEqual(len(saved), 1)
        block = saved[0]["platforms"]["hermes-mini"]
        self.assertEqual(block["home_channel"], {
            "platform": "hermes-mini",
            "chat_id": "main",
            "name": "Hermes Mini main chat",
        })
        self.assertTrue(block["enabled"])

    def test_an_existing_target_is_never_replaced(self):
        config = {"platforms": {"hermes-mini": {
            "home_channel": {"platform": "hermes-mini", "chat_id": "side"},
        }}}
        self.assertEqual(self._run_seed(config), [])
        self.assertEqual(
            config["platforms"]["hermes-mini"]["home_channel"]["chat_id"], "side",
        )


class AudioMetaTest(RouteTestCase):
    URL = "/api/plugins/hermes-mini/audio-meta"

    def _clip(self, name="clip.m4a"):
        path = self.home / name
        path.write_bytes(b"not really audio")
        return path

    def test_peaks_scale_to_the_loudest_bucket(self):
        from array import array

        peaks = self.api.audio_peaks(array("h", [0, 10, -10, 0] + [0, 1000, -2000, 0]), 2)
        self.assertEqual(len(peaks), 2)
        self.assertEqual(peaks, [0.2, 1.0])  # quietest bucket at the floor, loudest at full height
        self.assertEqual(self.api.audio_peaks(array("h"), 3), [0.0, 0.0, 0.0])
        self.assertEqual(self.api.audio_peaks(array("h", [0] * 8), 2), [0.0, 0.0])
        self.assertEqual(self.api.audio_peaks(array("h", [300, -300] * 4), 2), [1.0, 1.0])

    def test_duration_and_peaks_come_from_the_decoded_samples(self):
        import struct

        clip = self._clip()
        pcm = struct.pack("<4000h", *([500] * 2000 + [-4000] * 2000))  # two seconds at 2 kHz
        done = types.SimpleNamespace(returncode=0, stdout=pcm)
        with (
            mock.patch.object(self.api, "_ffmpeg_binary", return_value="/usr/bin/ffmpeg"),
            mock.patch.object(self.api.subprocess, "run", return_value=done) as run,
        ):
            first = self.client.get(self.URL, params={"path": str(clip)})
            again = self.client.get(self.URL, params={"path": str(clip)})
        self.assertEqual(first.status_code, 200)
        body = first.json()
        self.assertEqual(body["duration"], 2.0)
        self.assertEqual(len(body["peaks"]), self.api.AUDIO_BARS)
        self.assertEqual(max(body["peaks"]), 1.0)
        self.assertLess(body["peaks"][0], body["peaks"][-1])
        self.assertEqual(again.json(), body)
        self.assertEqual(run.call_count, 1)  # cached by path, size and mtime

    def test_refuses_non_audio_missing_and_relative_paths(self):
        text = self.home / "notes.txt"
        text.write_text("hi", encoding="utf-8")
        for path in (str(text), str(self.home / "gone.mp3"), "clip.mp3", ""):
            self.assertEqual(self.client.get(self.URL, params={"path": path}).status_code, 404, path)

    def test_missing_ffmpeg_and_bad_audio_are_reported(self):
        clip = self._clip("talk.mp3")
        with mock.patch.object(self.api, "_ffmpeg_binary", return_value=None):
            self.assertEqual(self.client.get(self.URL, params={"path": str(clip)}).status_code, 503)
        failed = types.SimpleNamespace(returncode=1, stdout=b"")
        with (
            mock.patch.object(self.api, "_ffmpeg_binary", return_value="/usr/bin/ffmpeg"),
            mock.patch.object(self.api.subprocess, "run", return_value=failed),
        ):
            self.assertEqual(self.client.get(self.URL, params={"path": str(clip)}).status_code, 422)

    def test_hermes_tools_ffmpeg_is_found_when_not_on_path(self):
        binary = self.home / "tools" / "ffmpeg-9.0.1-linux-arm64" / "bin" / "ffmpeg"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\n", encoding="utf-8")
        binary.chmod(0o755)
        import shutil

        with mock.patch.object(shutil, "which", return_value=None):
            self.assertEqual(self.api._ffmpeg_binary(), str(binary))

    def test_macos_tools_layout_is_found_too(self):
        binary = self.home / "tools" / "ffmpeg-9.0.1-darwin-arm64" / "ffmpeg"  # single binary at the root
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\n", encoding="utf-8")
        binary.chmod(0o755)
        import shutil

        with mock.patch.object(shutil, "which", return_value=None):
            self.assertEqual(self.api._ffmpeg_binary(), str(binary))
        with mock.patch.object(shutil, "which", return_value=None):
            binary.unlink()
            self.assertIsNone(self.api._ffmpeg_binary())


if __name__ == "__main__":
    unittest.main()
