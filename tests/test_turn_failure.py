"""A turn that fails with no reply text says so in plain words, never as Hermes' raw error."""

from __future__ import annotations

import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

SCRIPT = r'''
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { turnFailureText } = await import(pathToFileURL(process.argv[1]).href);
const general = turnFailureText('');
assert.match(general, /^The assistant could not finish this reply\./);
// Raw provider output never reaches the chat.
for (const raw of ['HTTP 500: {"error":{"message":"upstream"}}', 'Traceback (most recent call last):', 'boom']) {
  assert.equal(turnFailureText(raw), general, raw);
}
// Hermes' own wordings keep their meaning.
assert.match(turnFailureText('The conversation is too long for this model. Run /compress.'), /Start a new chat/);
assert.match(turnFailureText('The model provider rejected the API key. Fix it with /model.'), /setup or account problem/);
'''


class TurnFailureTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the browser module")
    def test_wording(self):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT, str(DASHBOARD / "message-policy.js")],
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_complete_shows_a_failure_with_no_text(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        complete = app.split('case "message.complete": {', 1)[1].split("\n    case ", 1)[0]
        self.assertIn('if (!text && payload.status === "error") sysLine(turnFailureText(payload.error));', complete)
        self.assertLess(complete.index("turnFailureText"), complete.rindex("finishTurn();"))


if __name__ == "__main__":
    unittest.main()
