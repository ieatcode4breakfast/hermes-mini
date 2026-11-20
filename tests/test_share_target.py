"""Android's share sheet (Web Share Target): pwa.json lists the app as a share target, sw.js keeps the posted share
and opens the app with ?shared=1, and share-target.js / app.js put it into the message box.

The JS helpers run under Node with a small in-memory Cache Storage; the wiring tests read the shipped files.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest

from tests.support import DASHBOARD


def run_node(script: str) -> subprocess.CompletedProcess:
    prelude = r'''
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[1]).href);
'''
    return subprocess.run(["node", "--input-type=module", "-e", prelude + script, str(DASHBOARD / "share-target.js")],
                          text=True, capture_output=True)


class ShareTargetWiringTest(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((DASHBOARD / "pwa.json").read_text(encoding="utf-8"))
        self.sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.share = (DASHBOARD / "share-target.js").read_text(encoding="utf-8")
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def test_manifest_offers_the_app_for_text_links_and_any_file(self):
        target = self.manifest["share_target"]
        self.assertEqual(target["method"], "POST")
        self.assertEqual(target["enctype"], "multipart/form-data")
        # Relative: it resolves against pwa.json, inside the app's scope, behind any proxy prefix.
        self.assertEqual(target["action"], "share-target")
        self.assertEqual({k: target["params"][k] for k in ("title", "text", "url")},
                         {"title": "title", "text": "text", "url": "url"})
        self.assertEqual(target["params"]["files"], [{"name": "files", "accept": ["*/*"]}])

    def test_worker_and_app_agree_on_the_hand_over(self):
        self.assertIn('const SHARE_PATH = `${SCOPE_PATH}share-target`;', self.sw)
        cache = re.search(r'const SHARE_CACHE = "([^"]+)";', self.sw).group(1)
        self.assertIn(f'export const SHARE_CACHE = "{cache}";', self.share)
        self.assertFalse(cache.startswith("hermes-mini-v"))  # activate deletes those
        self.assertIn('form.getAll("files")', self.sw)
        for field in ("title", "text", "url"):
            self.assertIn(f'field("{field}")', self.sw)
        self.assertIn("index.html?shared=1", self.sw)
        self.assertIn('export const SHARE_PARAM = "shared";', self.share)
        self.assertIn('${SCOPE_PATH}__share/${name}', self.sw)
        self.assertIn('endsWith("/__share/meta")', self.share)
        self.assertIn('request.method === "POST" && url.pathname === SHARE_PATH', self.sw)
        self.assertIn('"share-target.js"', self.sw.split("const CORE = [", 1)[1].split("];", 1)[0])

    def test_app_takes_a_share_on_every_start(self):
        self.assertEqual(self.app.count("await receiveShared();"), 2)  # first start and the reconnect path
        self.assertIn('import { takeShared, SHARE_PARAM } from "./share-target.js";', self.app)


@unittest.skipUnless(shutil.which("node"), "Node is needed for the share helpers")
class ShareTargetHelpersTest(unittest.TestCase):
    def test_shared_text_drops_repeats(self):
        run = run_node(r'''
assert.equal(m.sharedText({ title: 'Q3', text: 'Look https://x.co/a', url: 'https://x.co/a' }), 'Q3\nLook https://x.co/a');
assert.equal(m.sharedText({ title: 'https://x.co/a', url: 'https://x.co/a' }), 'https://x.co/a');
assert.equal(m.sharedText({ title: 'Page', url: 'https://x.co/a' }), 'Page\nhttps://x.co/a');
assert.equal(m.sharedText({ text: '  just words  ' }), 'just words');
assert.equal(m.sharedText({ title: 'Look', text: 'Look here' }), 'Look here');
assert.equal(m.sharedText({}), '');
''')
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_take_shared_reads_and_clears_the_cache(self):
        run = run_node(r'''
// A minimal Cache Storage: what sw.js receiveShare writes, as the browser would keep it.
function storage() {
  const caches = new Map();
  return {
    caches,
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const map = caches.get(name);
      return {
        async keys() { return [...map.keys()].map((url) => new Request(url)); },
        async match(key) { const r = map.get(typeof key === 'string' ? key : key.url); return r ? r.clone() : undefined; },
        async put(key, response) { map.set(typeof key === 'string' ? key : key.url, response); },
        async delete(key) { return map.delete(typeof key === 'string' ? key : key.url); },
      };
    },
  };
}
const base = 'https://box.example/dashboard-plugins/hermes-mini/__share/';
const s = storage();
const cache = await s.open(m.SHARE_CACHE);
const now = 1_800_000_000_000;
await cache.put(base + '0', new Response('PNGDATA', { headers: { 'content-type': 'image/png' } }));
await cache.put(base + '1', new Response('a,b', { headers: { 'content-type': 'text/csv' } }));
await cache.put(base + 'meta', new Response(JSON.stringify({ at: now - 1000, title: 'Q3', text: 'see https://x.co', url: 'https://x.co',
  files: [{ key: base + '0', name: 'chart.png', type: 'image/png', lastModified: 5 }, { key: base + '1', name: 'n.csv', type: 'text/csv' },
          { key: base + '9', name: 'gone.txt' }] })));
const shared = await m.takeShared(s, now);
assert.equal(shared.text, 'Q3\nsee https://x.co');
assert.deepEqual(shared.files.map((f) => [f.name, f.type, f.size]), [['chart.png', 'image/png', 7], ['n.csv', 'text/csv', 3]]);
assert.equal(await shared.files[0].text(), 'PNGDATA');
assert.equal(s.caches.get(m.SHARE_CACHE).size, 0); // taken once
assert.equal(await m.takeShared(s, now), null);
// Too old: dropped, never put into the message box.
await cache.put(base + 'meta', new Response(JSON.stringify({ at: now - m.SHARE_MAX_AGE_MS - 1, text: 'stale', files: [] })));
assert.equal(await m.takeShared(s, now), null);
assert.equal(s.caches.get(m.SHARE_CACHE).size, 0);
// A broken meta entry is cleared, not thrown.
await cache.put(base + 'meta', new Response('{not json'));
assert.equal(await m.takeShared(s, now), null);
assert.equal(await m.takeShared(null, now), null);
''')
        self.assertEqual(run.returncode, 0, run.stderr)


if __name__ == "__main__":
    unittest.main()
