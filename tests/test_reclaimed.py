"""A chat whose live session Hermes closed reopens instead of spinning and failing every send."""

from __future__ import annotations

import unittest

from tests.support import DASHBOARD


class ReclaimedSessionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def test_session_reclaimed_for_this_chat_reattaches(self):
        body = self.app.split('case "session.reclaimed": {', 1)[1].split("\n    case ", 1)[0]
        self.assertIn("if (isThisChat(payload)) void reattachChat();", body)

    def test_reattach_drops_the_dead_id_stops_the_dots_and_resumes(self):
        fn = self.app.split("function reattachChat(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("if (reattachRun) return reattachRun;", fn)
        self.assertIn("state.liveSid = null;", fn)
        self.assertIn("if (state.streaming) finishTurn();", fn)
        self.assertIn("await attachThread();", fn)
        self.assertIn("dropSocket(state.ws)", fn)  # a failed resume goes through the reconnect path

    def test_a_send_that_finds_no_session_says_so_and_reattaches(self):
        send = self.app.split("\nasync function send() {", 1)[1].split("\nasync function ", 1)[0]
        self.assertIn("const lost = isLostSession(error);", send)
        self.assertIn("LOST_SESSION_TEXT", send)
        self.assertIn("if (lost) void reattachChat();", send)


if __name__ == "__main__":
    unittest.main()
