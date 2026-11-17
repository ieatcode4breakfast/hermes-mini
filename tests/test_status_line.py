"""Compaction and a resumed turn show in the narration line; other status lines stay hidden."""

from __future__ import annotations

import unittest

from tests.support import DASHBOARD


class StatusLineTest(unittest.TestCase):
    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def test_status_update_feeds_the_narration_line_while_a_reply_runs(self):
        case = self.app.split('case "status.update": {', 1)[1].split("\n    case ", 1)[0]
        self.assertIn("const line = statusLine(payload);", case)
        self.assertIn("if (line && state.streaming) showNarration(line, ensureTurn());", case)
        self.assertIn("touchTurn();", case)

    def test_only_compaction_and_resume_are_shown(self):
        fn = self.app.split("function statusLine(payload) {", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('payload.kind === "compacting"', fn)
        self.assertIn("Resuming interrupted turn", fn)
        for hidden in ('"heartbeat"', '"goal"', '"loop"'):
            self.assertNotIn(hidden, fn)
        self.assertIn('text.includes("\\n")', fn)  # multi-line process notices never go in the one-line narration


if __name__ == "__main__":
    unittest.main()
