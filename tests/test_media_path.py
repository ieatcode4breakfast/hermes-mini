"""The local-media matcher shared by the Markdown renderer, Hermes' MEDIA: directive and the app.

A picture needs a raster extension; a MEDIA: file may be any type. Paths are only fetched through the
dashboard's authenticated routes, and only when absolute, ~/ or file:/// — never relative, quoted or with
control characters. Relative paths stay out because the browser cannot resolve the agent's working directory.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

CASES = [
    ("/root/.hermes/data/chart.png", "/root/.hermes/data/chart.png"),
    ("~/pics/a.jpg", "~/pics/a.jpg"),
    ("file:///root/x.webp", "/root/x.webp"),
    ("MEDIA:/root/x.png", "/root/x.png"),
    ("MEDIA: /root/x.png", "/root/x.png"),
    ("media:~/x.jpg", "~/x.jpg"),
    ("MEDIA:https://example.com/x.png", ""),
    ("/root/a%20b.png", "/root/a b.png"),
    ("/root/a.PNG", "/root/a.PNG"),
    ("/root/x.png ", "/root/x.png"),
    ("https://example.com/x.png", ""),
    ("root/x.png", ""),
    ("//host/x.png", ""),
    ("file://host/x.png", ""),
    ("file:////root/x.png", ""),
    ("/root/x.svg", ""),
    ("/root/x.txt", ""),
    ('/root/x.png"', ""),
    ("/root/a\nb.png", ""),
    ("", ""),
]

MEDIA_CASES = [
    ("/root/report.pdf", "/root/report.pdf"),
    ("~/docs/x.docx", "~/docs/x.docx"),
    ("file:///root/x.zip", "/root/x.zip"),
    ("MEDIA:/root/README", "/root/README"),
    ("/root/a%20b.pdf", "/root/a b.pdf"),
    ("MEDIA:https://example.com/x.pdf", ""),
    ("https://example.com/x.pdf", ""),
    ("relative.pdf", ""),
    ("//host/x.pdf", ""),
    ("file:////root/x.pdf", ""),
    ("/root/x\x00.pdf", ""),
    ("", ""),
]

TAG_CASES = [
    ("MEDIA:/root/x.png", ["/root/x.png"]),
    ("before MEDIA:/root/x.png after", ["/root/x.png"]),
    ('MEDIA: "/root/a b.png".', ["/root/a b.png"]),
    ("MEDIA:/root/x.png)", ["/root/x.png"]),
    ("**MEDIA:/root/x.png**", ["/root/x.png"]),
    ("MEDIA:/root/x.svg", ["/root/x.svg"]),
    ("SOMEDIA:/root/x.png", []),
    ("media:~/x.jpg", ["~/x.jpg"]),
    ("MEDIA:/root/a.png and MEDIA:/root/b.jpg", ["/root/a.png", "/root/b.jpg"]),
]

TAG_KIND_CASES = [
    ("MEDIA:/root/x.png", [["/root/x.png", "image"]]),
    ("MEDIA:/root/report.pdf", [["/root/report.pdf", "file"]]),
    ("MEDIA:/root/README", [["/root/README", "file"]]),
    ('MEDIA: "/root/a b.docx"', [["/root/a b.docx", "file"]]),
    ("MEDIA:/root/x.svg", [["/root/x.svg", "file"]]),
    ("MEDIA:/root/x.png and MEDIA:/root/x.pdf", [["/root/x.png", "image"], ["/root/x.pdf", "file"]]),
]


def run_node(script: str, payload: list) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", "--input-type=module", "-e", script, str(DASHBOARD / "media-path.js")],
        input=json.dumps(payload), text=True, capture_output=True,
    )


@unittest.skipUnless(shutil.which("node"), "Node is needed for the media path matcher")
class LocalMediaPathTest(unittest.TestCase):
    def test_image_matcher(self):
        script = '''
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { localImagePath } = await import('data:text/javascript;base64,' +
  fs.readFileSync(process.argv[1]).toString('base64'));
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [source, expected] of cases) assert.equal(localImagePath(source), expected, JSON.stringify(source));
console.log(`${cases.length} image path cases passed`);
'''
        run = run_node(script, CASES)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_media_path(self):
        script = '''
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { localMediaPath } = await import('data:text/javascript;base64,' +
  fs.readFileSync(process.argv[1]).toString('base64'));
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [source, expected] of cases) assert.equal(localMediaPath(source), expected, JSON.stringify(source));
console.log(`${cases.length} media path cases passed`);
'''
        run = run_node(script, MEDIA_CASES)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_media_tag_spans(self):
        script = '''
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { mediaTags } = await import('data:text/javascript;base64,' +
  fs.readFileSync(process.argv[1]).toString('base64'));
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [text, expected] of cases) assert.deepEqual(mediaTags(text).map((tag) => tag.path), expected, JSON.stringify(text));
console.log(`${cases.length} MEDIA tag cases passed`);
'''
        run = run_node(script, TAG_CASES)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_media_tag_kinds(self):
        script = '''
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { mediaTags } = await import('data:text/javascript;base64,' +
  fs.readFileSync(process.argv[1]).toString('base64'));
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [text, expected] of cases) assert.deepEqual(mediaTags(text).map((tag) => [tag.path, tag.kind]), expected, JSON.stringify(text));
console.log(`${cases.length} MEDIA kind cases passed`);
'''
        run = run_node(script, TAG_KIND_CASES)
        self.assertEqual(run.returncode, 0, run.stderr)


if __name__ == "__main__":
    unittest.main()
