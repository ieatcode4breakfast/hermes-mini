"""A streamed reply never doubles (re-sent chunks) and survives a reload mid-reply (inflight seeding)."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest

from tests.support import DASHBOARD


def _fn(app: str, name: str) -> str:
    body = app.split(f"\nfunction {name}(", 1)[1].split("\nfunction ", 1)[0]
    return f"function {name}(" + body.split("\n}\n", 1)[0] + "\n}\n"


class StreamDedupeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def case(self, name):
        return self.app.split(f'case "{name}": {{', 1)[1].split("\n    case ", 1)[0]

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_stream_chunk_behaviour(self):
        script = _fn(self.app, "streamChunk") + r"""
const out = [];
const s = { turnId: "t", segment: 0, applied: 0 };
const d = (segment, offset, text, turn_id = "t") => streamChunk(s, { text, segment, offset, turn_id });
out.push(d(0, 0, "Hello "));          // new text
out.push(d(0, 6, "world"));           // continues
out.push(d(0, 0, "Hello "));          // re-sent: dropped
out.push(d(0, 3, "lo wor"));          // inside what is applied: dropped
out.push(d(0, 8, "rld!!"));           // overlaps: only the tail
out.push(d(0, 20, "gap"));            // a gap: kept
out.push(d(1, 0, "Next"));            // new segment without an interim: seal
out.push(d(0, 23, "late"));           // an old segment: dropped
out.push(streamChunk(s, { text: "plain" }));              // unstamped: appended
out.push(streamChunk(null, { text: "x", segment: 0, offset: 0 }));
const seeded = { turnId: null, segment: 0, applied: 0 };
out.push(streamChunk(seeded, { text: "more", segment: 2, offset: 40, turn_id: "u" }));  // adopt after a reload
out.push(seeded);
out.push(streamChunk(seeded, { text: "more", segment: 2, offset: 40, turn_id: "u" }));  // and dedupe from there
process.stdout.write(JSON.stringify(out));
"""
        got = json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(got, [
            {"text": "Hello ", "seal": False},
            {"text": "world", "seal": False},
            {"text": "", "seal": False},
            {"text": "", "seal": False},
            {"text": "!!", "seal": False},
            {"text": "gap", "seal": False},
            {"text": "Next", "seal": True},
            {"text": "", "seal": False},
            {"text": "plain", "seal": False},
            {"text": "x", "seal": False},
            {"text": "more", "seal": False},
            {"turnId": "u", "segment": 2, "applied": 44},
            {"text": "", "seal": False},
        ])

    def test_delta_goes_through_stream_chunk(self):
        delta = self.case("message.delta")
        self.assertLess(delta.index("if (state.hiddenTurn) {"), delta.index("streamChunk(state.stream, payload)"))
        self.assertIn("if (chunk.seal) sealSegment();", delta)
        self.assertIn("turn.text += chunk.text;", delta)
        self.assertNotIn("turn.text += payload.text;", delta)

    def test_start_and_interim_keep_the_cursor(self):
        start = self.case("message.start")
        self.assertIn("state.stream.turnId === payload.turn_id) break;", start)
        self.assertIn("state.stream = { turnId: payload.turn_id || null, segment: 0, applied: 0 };", start)
        interim = self.case("message.interim")
        self.assertIn("if (payload.segment < stream.segment) break;", interim)
        self.assertIn("stream.segment = payload.segment + 1;", interim)
        finish = self.app.split("function finishTurn(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("state.stream = null;", finish)

    def test_a_reattach_seeds_the_running_reply(self):
        attach = self.app.split("function finishAttach(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("if (running) seedInflight(inflight);", attach)
        self.assertEqual(self.app.count("resumed.inflight || null"), 2)  # home and other chats
        seed = _fn(self.app, "seedInflight")
        self.assertIn('inflight.display_kind === "hidden"', seed)
        self.assertIn("if (!text.startsWith(covered)) return;", seed)
        self.assertIn("turn.seeded = true;", seed)
        self.assertIn("state.turn.seeded", self.case("message.complete"))


if __name__ == "__main__":
    unittest.main()
