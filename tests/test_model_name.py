"""Models read as names ("DeepSeek v4.1 Flash"), not ids; the id is still what is sent."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

CASES = {
    "deepseek/deepseek-v4.1-flash": "DeepSeek v4.1 Flash",
    "deepseek-flash": "DeepSeek Flash",
    "claude-haiku-4-5": "Haiku 4.5",
    "anthropic/claude-sonnet-5[1m]": "Sonnet 5 1M",
    "claude-opus-4-8-20251101": "Opus 4.8",
    "gpt-5.2": "GPT-5.2",
    "gemini-2.5-pro": "Gemini 2.5 Pro",
    "glm-5.2": "GLM 5.2",
    "qwen3-235b-a22b": "Qwen3 235B A22B",
    "minimax-m2": "MiniMax M2",
    "Qwen3-8B-Instruct-UD-Q4_K_XL": "Qwen3 8B Q4",
    "kimi-k2-thinking": "Kimi K2 Thinking",
    "nousresearch/hermes-4-405b": "Hermes 4 405B",
    "": "",
}


class ModelNameTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_display_names(self):
        module = (DASHBOARD / "model-name.js").as_uri()
        script = (
            f"import({json.dumps(module)}).then(({{ displayModelName }}) => "
            f"process.stdout.write(JSON.stringify({json.dumps(list(CASES))}.map(displayModelName))));"
        )
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
        self.assertEqual(dict(zip(CASES, json.loads(out))), CASES)

    def test_wiring(self):
        model = (DASHBOARD / "model.js").read_text(encoding="utf-8")
        self.assertIn('import { displayModelName } from "./model-name.js";', model)
        short = model.split("export function shortModel(", 1)[1].split("\n}", 1)[0]
        self.assertIn("return displayModelName(model);", short)
        self.assertIn('node("span", "model-option-name", displayModelName(model))', model)
        self.assertIn("label.title = model;", model)
        self.assertIn("displayModelName(m).toLowerCase().includes(query)", model)
        # What is sent stays the id.
        self.assertIn("`${model} --provider ${provider}`", model)
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"model-name.js"', sw.split("const CORE = [", 1)[1].split("];", 1)[0])


if __name__ == "__main__":
    unittest.main()
