"""A reply with tool rounds is drawn live the way a reload draws it: one bubble per stored assistant row.

Text written before a tool call closes into its own bubble (sealSegment); message.complete carries only the last
segment; message.interim commentary that was not streamed still appears live.
"""

from __future__ import annotations

import unittest

from tests.support import DASHBOARD


def case(app: str, name: str) -> str:
    return app.split(f'case "{name}": {{', 1)[1].split("\n    case ", 1)[0]


class TurnSegmentsTest(unittest.TestCase):
    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def test_a_tool_round_closes_the_bubble_instead_of_joining_text(self):
        tool = case(self.app, "tool.start")
        self.assertIn("sealSegment();", tool)
        self.assertNotIn('turn.text += "\\n\\n"', tool)
        self.assertNotIn("turn.prefix", self.app)

    def test_complete_draws_only_the_last_segment_and_no_empty_row(self):
        complete = case(self.app, "message.complete")
        self.assertIn("ensureTurn().text = text;", complete)
        self.assertIn("state.sealedSegment", complete)  # a repeat of the closed bubble is not drawn twice
        self.assertIn("state.turn.row.remove();", complete)

    def test_interim_commentary_is_handled(self):
        interim = case(self.app, "message.interim")
        self.assertIn("payload.already_streamed", interim)
        self.assertIn("sealSegment();", interim)

    def test_the_sealed_segment_belongs_to_one_turn(self):
        self.assertIn('state.sealedSegment = "";', case(self.app, "message.start"))
        finish = self.app.split("function finishTurn() {", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('state.sealedSegment = "";', finish)

    def test_card_and_segment_share_one_close(self):
        card = self.app.split("function sealTurnForCard() {", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("closeTurnRow(turn);", card)
        seal = self.app.split("function sealSegment() {", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("closeTurnRow(turn);", seal)
        self.assertNotIn("hideNarration", seal)  # the narration line carries on in the next row


if __name__ == "__main__":
    unittest.main()
