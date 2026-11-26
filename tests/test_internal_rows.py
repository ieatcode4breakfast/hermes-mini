"""Internal gateway text never shows as the person's own message (mirrors Hermes's session_history.py)."""

from __future__ import annotations

import shutil
import subprocess
import unittest

from tests.support import DASHBOARD


class InternalRowsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        cls.entries = cls.app.split("function chatEntries(", 1)[1].split("\nfunction ", 1)[0]

    def test_system_marker_user_rows_are_skipped(self):
        self.assertIn('messageText(message).trimStart().startsWith("[System:")', self.entries)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_model_switch_markers_are_hidden_but_other_chat_rows_stay(self):
        script = (
            "const expandMerged = (rows) => rows; const modelOnly = () => false;\n"
            "const NOTICE_KINDS = new Set(), HIDDEN_NOTICE_KINDS = new Set();\n"
            "const messageText = (row) => row.content, failureText = (text) => text;\n"
            'const displayText = (text) => text, isSilenceMarker = () => false;\n'
            "const LEGACY_HEARTBEAT = /^never matches/;\n"
            f"function chatEntries({self.entries}\n"
            "const marker = '[System: The active model for this chat has changed to example/model.]';\n"
            "const rows = [\n"
            "  {role: 'user', content: marker, display_kind: 'model_switch'},\n"
            "  {role: 'user', content: marker},\n"
            "  {role: 'assistant', content: 'Switched to the next topic.'},\n"
            "  {role: 'user', content: 'Turn failed', display_kind: 'failed_turn'},\n"
            "];\n"
            "process.stdout.write(JSON.stringify(chatEntries(rows, {notices: true}).map(row => row.text)));"
        )
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
        self.assertEqual(out, '["Switched to the next topic.","Turn failed"]')

    def test_discord_triggering_note_is_stripped_from_user_text(self):
        self.assertIn('.replace(DISCORD_TRIGGERING_NOTE, "$1")', self.entries)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_discord_note_regex_matches_the_hermes_text(self):
        line = next(l for l in self.app.splitlines() if l.lstrip().startswith("/(^|\\n)\\[Triggering message id"))
        regex = line.strip().rstrip(";")
        script = (
            f"const re = {regex};\n"
            "const t = 'hi\\n[Triggering message id: `123` — use as `message_id` for reply/react/pin via the discord "
            "tools.]\\n\\nthere';\n"
            "process.stdout.write(JSON.stringify(t.replace(re, '$1')));"
        )
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
        self.assertEqual(out, '"hi\\nthere"')


if __name__ == "__main__":
    unittest.main()
