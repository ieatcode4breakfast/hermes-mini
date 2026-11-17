"""A failed send leaves no bubble that looks sent."""

from __future__ import annotations

import unittest

from tests.support import DASHBOARD


class FailedSendTest(unittest.TestCase):
    def test_a_failed_send_removes_its_bubble_in_every_chat(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        send = app.split("\nasync function send() {", 1)[1].split("\nasync function ", 1)[0]
        failure = send.split("} catch (error) {\n    // Nothing was submitted", 1)[1].split("} finally {", 1)[0]
        self.assertIn("els.input.value = saved.text;", failure)
        removal = failure.index("userRow?.remove();")
        # Not only for the first message of a new chat: the removal is outside the viewedUnsent branch.
        self.assertNotIn("if (state.viewedUnsent) {", failure[:removal])


if __name__ == "__main__":
    unittest.main()
