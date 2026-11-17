"""The "connect an app" card for Hermes' manage_connections tool (dashboard/connections.js + app.js).

Without it the tool waits on a card the app never shows, so the turn hangs until the card's deadline.
"""

from __future__ import annotations

import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

SCRIPT = r'''
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const c = await import(pathToFileURL(process.argv[1]).href);
const notion = { name: 'notion', kind: 'connector', action: 'connect', state: 'initiated', connect_url: 'https://portal.example/oauth?x=1' };

assert.equal(c.appName({ name: 'google-drive' }), 'Google Drive');
assert.equal(c.cardTitle({ targets: [notion] }), 'Connect Notion');
assert.equal(c.cardTitle({ targets: [notion, { ...notion, name: 'slack' }] }), 'Connect apps');
assert.equal(c.cardTitle({ targets: [{ name: 'linear', kind: 'mcp', action: 'install', state: 'pending' }] }), 'Install Linear');

// A hosted app: sign in through its link, or skip it.
assert.deepEqual(c.rowButtons(notion), ['open', 'skip']);
assert.equal(c.stateLabel(notion), 'Waiting for you to sign in');
// Only an https link is ever opened.
assert.equal(c.openUrl({ connect_url: 'javascript:alert(1)' }), '');
assert.equal(c.openUrl({ connect_url: 'http://plain.example/' }), '');
assert.deepEqual(c.rowButtons({ ...notion, connect_url: null }), ['skip']);
// A local install asks for an OK; one that needs credentials points to the desktop app.
const install = { name: 'linear', kind: 'mcp', action: 'install', state: 'pending' };
assert.deepEqual(c.rowButtons(install), ['allow', 'skip']);
assert.equal(c.stateLabel(install), 'Needs your OK');
const withEnv = { ...install, required_env: [{ name: 'LINEAR_KEY' }] };
assert.deepEqual(c.rowButtons(withEnv), ['skip']);
assert.match(c.stateLabel(withEnv), /desktop app/);
// A finished row has no buttons and says how it ended.
for (const state of ['connected', 'skipped', 'failed', 'expired', 'not_connected']) {
  assert.deepEqual(c.rowButtons({ ...notion, state }), [], state);
}
assert.equal(c.stateLabel({ ...notion, state: 'connected' }), 'Connected');

// Answers sent through connection.respond.
assert.deepEqual(c.rowAnswer(notion, 'skipped'), { targets: [{ name: 'notion', status: 'skipped' }] });
assert.deepEqual(c.doneAnswer(), { targets: [], settled_by: 'continue' });

// Settlement and ordering of updates.
assert.equal(c.isSettled({ settled: true }), true);
assert.equal(c.isSettled({ settled_at: 12.5 }), true);
assert.equal(c.isSettled({ settled_at: null }), false);
assert.equal(c.isNewer(3, { seq: 2 }), false);
assert.equal(c.isNewer(3, { seq: 4 }), true);
'''


class ConnectionCardTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the browser module")
    def test_rules(self):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT, str(DASHBOARD / "connections.js")],
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_wiring(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('import * as conn from "./connections.js";', app)
        self.assertIn('case "connection.request":\n    case "connection.update":\n      showConnection(payload);', app)
        answer = app.split("async function answerConnection(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('rpc("connection.respond", {', answer)
        self.assertIn('owner: { type: "session", session_id: state.liveSid }', answer)
        # A reload brings the open card back from session.resume.
        self.assertIn("pendingConnection = resumed.pending_connection || null;", app)
        self.assertIn("resumed.pending_connection || null,\n    resumed.inflight || null);", app)
        self.assertIn("syncConnectionCards(pendingConnection);", app)
        render = app.split("function renderConnection(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('window.open(conn.openUrl(target), "_blank", "noopener")', render)
        for label in ('"Open"', '"Allow"', '"Skip"', '"Done"'):
            self.assertIn(label, render)
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"connections.js"', sw.split("const CORE = [", 1)[1].split("];", 1)[0])


if __name__ == "__main__":
    unittest.main()
