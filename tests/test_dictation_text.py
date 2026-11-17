"""Dictated text goes in with the spaces a keyboard would add (dashboard/dictation-text.js)."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

# [text before the caret, dictated text, text after the caret, expected text inserted]
CASES = [
    ["", "hello there", "", "hello there "],
    ["Hello", "how are you", "", " how are you "],
    ["Hello ", "how are you", "", "how are you "],
    ["Hello\n", "next line", "", "next line "],
    ["We ate,", "and then left", "", " and then left "],
    ["Done.", "Next thing", "", " Next thing "],
    ["Hello", ", world", "", ", world "],
    ["Hello", "?", "", "? "],
    ["(", "aside", ")", "aside"],
    ["say \"", "hi", "\"", "hi"],
    ["he said.\"", "Then", "", " Then "],
    ["one", "two", " three", " two"],
    ["I said", "hello", "\"quoted\"", " hello "],
    ["one", "two", "three", " two "],
    ["one ", "two", ".", "two"],
    ["", "  padded  ", "", "padded "],
    ["x", "   ", "", ""],
]

SCRIPT = r'''
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { dictationInsert } = await import(pathToFileURL(process.argv[1]).href);
for (const [before, spoken, after, expected] of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  const got = dictationInsert(before, spoken, after);
  assert.equal(got.text, expected, JSON.stringify([before, spoken, after]));
  assert.equal(got.caret, expected.length, 'the caret goes after the inserted text and its space');
}
'''


class DictationSpacingTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the browser module")
    def test_spaces_before_and_after(self):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT, str(DASHBOARD / "dictation-text.js")],
                             input=json.dumps(CASES), text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_app_uses_the_helper_and_precaches_it(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('import { dictationInsert } from "./dictation-text.js";', app)
        insert = app.split("function insertDictatedText(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("dictationInsert(before, clean, after)", insert)
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"dictation-text.js"', sw.split("const CORE = [", 1)[1].split("];", 1)[0])



if __name__ == "__main__":
    unittest.main()
