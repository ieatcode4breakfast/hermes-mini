"""Approvals Hermes withdraws close their card; hidden turns are never drawn."""

from __future__ import annotations

import unittest

from tests.support import DASHBOARD


class WithdrawnAndHiddenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def case(self, name):
        return self.app.split(f'case "{name}": {{', 1)[1].split("\n    case ", 1)[0]

    def test_approval_cancelled_closes_the_matching_open_cards(self):
        body = self.case("approval.cancelled")
        self.assertIn("if (!isThisChat(payload)) break;", body)
        self.assertIn("payload.request_ids", body)
        self.assertIn("card.params.request_id", body)
        self.assertIn("resolveApproval(card, null)", body)
        match = self.app.split("function isThisChat(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("state.liveSid", match)
        self.assertIn("payload.stored_session_id", match)
        self.assertIn("state.storedId", match)

    def test_a_hidden_turn_draws_nothing(self):
        self.assertIn('state.hiddenTurn = payload.display_kind === "hidden";', self.case("message.start"))
        delta = self.case("message.delta")
        self.assertLess(delta.index("if (state.hiddenTurn) {"), delta.index("ensureTurn()"))
        self.assertIn("state.hiddenTurn", self.case("message.interim"))
        complete = self.case("message.complete")
        self.assertIn("if (state.hiddenTurn ||", complete)
        self.assertIn("if (!hidden) inbox.messageComplete();", complete)
        finish = self.app.split("function finishTurn(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("state.hiddenTurn = false;", finish)


if __name__ == "__main__":
    unittest.main()
