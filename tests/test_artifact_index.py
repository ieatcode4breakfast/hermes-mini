"""The artifacts index: extraction rules (pure) and the read-only route.

The pure half loads ``artifact_index.py`` by path, the way the plugin's own loaders do, and never
touches state.db. The route test builds a small ``state.db`` in a disposable ``HERMES_HOME`` and
needs FastAPI; where it is absent that class is skipped rather than silently passing.
"""

from __future__ import annotations

import sqlite3
import unittest

from tests.support import PROJECT_ROOT, DisposableHome, load_module

try:  # Hermes ships FastAPI; a bare harness may not
    from tests.test_routes import HAVE_FASTAPI, build_app

    from starlette.testclient import TestClient
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False
    build_app = None  # type: ignore[assignment]
    TestClient = None  # type: ignore[assignment]


def load_index():
    return load_module("hermes_mini_artifact_index", PROJECT_ROOT / "artifact_index.py")


class ArtifactRulesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.index = load_index()

    def row(self, row_id, text, role="assistant", tool_name="", ts=1_800_000_000.0, session="chat"):
        return {"id": row_id, "session_id": session, "role": role, "tool_name": tool_name,
                "text": text, "timestamp": ts}

    def test_assistant_text_yields_media_images_links_urls_and_paths(self):
        text = (
            "Done. MEDIA:/x/report.pdf\n"
            "![a](/tmp/a.png)\n"
            "[doc](https://example.com/a)\n"
            "See https://example.com/b and ./notes.md\n"
            "![inline](data:image/png;base64,AAAA)\n"
        )
        items = self.index.collect_rows([self.row(1, text)])
        self.assertEqual(
            {item["value"] for item in items},
            {"/x/report.pdf", "/tmp/a.png", "https://example.com/a", "https://example.com/b"},
        )

    def test_a_media_tag_is_explicit(self):
        candidates = self.index.collect_from_message("assistant", "", 'Here MEDIA:"/tmp/my report.pdf"')
        self.assertIn(("/tmp/my report.pdf", True), candidates)

    def test_a_write_tool_payload_keeps_its_path(self):
        items = self.index.collect_rows(
            [self.row(5, '{"path": "/root/notes.md"}', role="tool", tool_name="write_file", ts=10)]
        )
        self.assertEqual(len(items), 1)
        self.assertEqual(
            (items[0]["value"], items[0]["kind"], items[0]["label"], items[0]["message_id"], items[0]["ts"]),
            ("/root/notes.md", "file", "notes.md", 5, 10.0),
        )
        self.assertEqual(items[0]["id"], "chat:/root/notes.md")

    def test_a_reader_tool_is_ignored(self):
        row = self.row(5, '{"path": "/root/notes.md"}', role="tool", tool_name="read_file")
        self.assertEqual(self.index.collect_rows([row]), [])
        self.assertEqual(self.index.collect_from_message("tool", "read_file", '{"path": "/root/notes.md"}'), [])

    def test_terminal_output_keeps_files_and_drops_extensionless_paths(self):
        items = self.index.collect_rows([
            self.row(6, "wrote /tmp/out.png", role="tool", tool_name="terminal"),
            self.row(5, "/usr/bin/env", role="tool", tool_name="terminal"),
        ])
        self.assertEqual([item["value"] for item in items], ["/tmp/out.png"])
        payload = self.index.collect_rows(
            [self.row(7, '{"output": "made /tmp/rendered.webp"}', role="tool", tool_name="terminal")]
        )
        self.assertEqual([item["value"] for item in payload], ["/tmp/rendered.webp"])

    def test_command_output_gives_pictures_and_documents_not_links_or_tool_state(self):
        stdout = ("Cloning into https://github.com/x/y.git\n"
                  "/root/.hermes/logs/receipt.json\n/root/.cache/pip/thing.png\n/srv/out/data.json\n"
                  "Saved /srv/out/chart.png and /srv/out/report.pdf\n")
        values = [v for v, _ in self.index.collect_from_message("tool", "terminal", stdout)]
        self.assertIn("/srv/out/chart.png", values)
        self.assertIn("/srv/out/report.pdf", values)
        for dropped in ("https://github.com/x/y.git", "/root/.hermes/logs/receipt.json",
                        "/root/.cache/pip/thing.png", "/srv/out/data.json"):
            self.assertNotIn(dropped, values)

    def test_escaped_json_never_glues_onto_a_url_or_path(self):
        payload = '{"output": "see https://example.com/a\\n/srv/out/chart.png\\n\u2570\u2500"}'
        values = [v for v, _ in self.index.collect_from_message("tool", "terminal", payload)]
        self.assertEqual(values, ["/srv/out/chart.png"])
        text = "Repo: https://github.com/x/y.git... and https://example.com/page."
        urls = [v for v, _ in self.index.collect_from_message("assistant", "", text) if v.startswith("http")]
        self.assertIn("https://github.com/x/y.git", urls)
        self.assertIn("https://example.com/page", urls)
        self.assertFalse(any(u.endswith((".", "\\")) for u in urls))

    def test_browser_vision_screenshot_paths_are_read(self):
        items = self.index.collect_rows(
            [self.row(8, "Screenshot path: /tmp/shot.png\n", role="tool", tool_name="browser_vision")]
        )
        self.assertEqual([item["value"] for item in items], ["/tmp/shot.png"])

    def test_dedupe_keeps_the_earliest_occurrence(self):
        rows = [
            self.row(2, "again: /tmp/x.png", ts=20),
            self.row(1, "![x](/tmp/x.png)", ts=10),
        ]
        items = self.index.collect_rows(rows)
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]["message_id"], items[0]["ts"]), (1, 10.0))

    def test_kinds_and_labels(self):
        self.assertEqual(self.index.kind("/tmp/a.png"), "image")
        self.assertEqual(self.index.kind("/x/report.pdf"), "file")
        self.assertEqual(self.index.kind("https://example.com/a"), "link")
        self.assertEqual(self.index.label("/x/report.pdf"), "report.pdf")
        self.assertEqual(self.index.label("https://example.com/a"), "example.com/a")

    def test_values_a_browser_cannot_show_are_dropped(self):
        for value in ("data:image/png;base64,AAAA", "./notes.md", "../notes.png", '/tmp/a"b.png',
                      "/tmp/a\x01.png", "/tmp/" + "a" * 4090 + ".png"):
            self.assertFalse(self.index.looks_like_artifact(value), value)


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class ArtifactsRouteTest(DisposableHome):
    BASE = "/api/plugins/hermes-mini/artifacts"
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
            " active INTEGER, compacted INTEGER, tool_name TEXT)"
        )
        conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL, acquired_at REAL)")
        conn.execute("INSERT INTO sessions VALUES ('chat-a', 'Alpha', 0)")
        conn.execute("INSERT INTO sessions VALUES ('chat-b', 'Beta', 0)")
        conn.execute("INSERT INTO sessions VALUES ('other', 'Other', 0)")
        conn.commit()
        return conn

    def _add(self, conn, row_id, session, role, content, ts, tool_name=None, kind=None):
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, display_kind, display_metadata, timestamp,"
            " finish_reason, tool_calls, active, compacted, tool_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (row_id, session, role, content, kind, None, ts,
             "stop" if role == "assistant" else None, None, 1, 0, tool_name),
        )
        conn.commit()

    def test_only_app_chats_list_newest_first_and_tool_output_points_at_its_reply(self):
        conn = self._db()
        out = self.home / "out"
        out.mkdir()
        report_path, pic_path = out / "report.md", out / "pic.png"
        report_path.write_text("x")
        pic_path.write_bytes(b"x")
        self._add(conn, 1, "chat-a", "tool", '{"path": "%s"}' % report_path, 100.0, tool_name="write_file")
        self._add(conn, 2, "chat-a", "assistant", "Saved it.", 101.0)
        self._add(conn, 3, "chat-a", "assistant", "Here: ![](%s)" % pic_path, 102.0)
        # The same picture brought up again in another chat later: listed once, from where it first appeared.
        self._add(conn, 7, "chat-b", "assistant", "Again: ![](%s)" % pic_path, 105.0)
        # Gone from disk (a cleared scratch folder): never listed.
        self._add(conn, 6, "chat-b", "assistant", "Old: ![](%s)" % (out / "gone.png"), 99.0)
        self._add(conn, 4, "chat-b", "assistant", "See https://example.com/a", 103.0)
        self._add(conn, 5, "other", "assistant", "![x](/tmp/other.png)", 104.0)
        self.client.post(self.CHATS, json={"id": "chat-a", "home": True})
        self.client.post(self.CHATS, json={"id": "chat-b"})

        response = self.client.get(self.BASE)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["truncated"])
        items = body["items"]
        self.assertEqual(
            [item["value"] for item in items],
            ["https://example.com/a", str(pic_path), str(report_path)],
        )
        self.assertEqual([item["ts"] for item in items], [103.0, 102.0, 100.0])

        by_value = {item["value"]: item for item in items}
        report = by_value[str(report_path)]
        self.assertEqual((report["kind"], report["label"]), ("file", "report.md"))
        # The tool row produced the file; the item points at the reply that delivered it.
        self.assertEqual(report["message_id"], 2)
        self.assertEqual(report["session_id"], "chat-a")
        self.assertEqual(report["thread"], self.api.core.agent_identity()["home_label"])
        self.assertTrue(report["home"])
        self.assertEqual(by_value["https://example.com/a"]["kind"], "link")
        self.assertEqual(by_value["https://example.com/a"]["thread"], "Beta")
        self.assertEqual(by_value[str(pic_path)]["kind"], "image")
        self.assertEqual((by_value[str(pic_path)]["session_id"], by_value[str(pic_path)]["message_id"]), ("chat-a", 3))
        self.assertEqual(set(report), {"id", "kind", "value", "label", "session_id", "message_id", "ts",
                                       "thread", "home"})
