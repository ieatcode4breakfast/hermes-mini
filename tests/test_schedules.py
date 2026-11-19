"""The Schedules panel (dashboard/schedules.js): plain-English schedule wording and row selection."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

SCRIPT = r'''
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
// confirm.js and toast.js register page listeners when loaded; the wording helpers need no page.
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, getElementById() { return null; } };
const m = await import(pathToFileURL(process.argv[1]).href);
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [expr, words] of cases.cron) assert.equal(m.cronWords(expr), words, expr);
assert.equal(m.scheduleWords({ schedule: { kind: 'interval', minutes: 10 } }), 'Every 10 minutes');
assert.equal(m.scheduleWords({ schedule: { kind: 'interval', minutes: 120 } }), 'Every 2 hours');
assert.equal(m.scheduleWords({ schedule: { kind: 'once' } }), 'One time');
assert.equal(m.scheduleWords({ schedule: { kind: 'cron', expr: '0 9 L * *' } }), 'Custom schedule');
assert.equal(m.jobTitle({ name: 'assistant-debrief-morning' }), 'Assistant debrief morning');
assert.equal(m.jobTitle({ name: '', prompt: 'Water the plants\nthen tell me' }), 'Water the plants');

const now = new Date(2026, 10, 15, 10, 0);
const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).toISOString();
assert.equal(m.whenWords(at(15, 21), now), 'Today, 9:00 pm');
assert.equal(m.whenWords(at(16, 3), now), 'Tomorrow, 3:00 am');
assert.equal(m.whenWords(at(19, 7, 45), now), 'Thursday, 7:45 am');
assert.equal(m.whenWords(new Date(2026, 11, 8, 9).toISOString(), now), 'Dec 8, 9:00 am');
assert.equal(m.whenWords(new Date(2027, 0, 4, 9).toISOString(), now), 'Jan 4 2027, 9:00 am');

const rows = m.scheduleRows([
  { id: 'a', name: 'meds', schedule: { kind: 'cron', expr: '0 3 * * *' }, state: 'scheduled', next_run_at: at(16, 3), last_status: 'ok' },
  { id: 'b', name: 'mail-check', schedule: { kind: 'interval', minutes: 30 }, state: 'scheduled', next_run_at: at(15, 11), run_claim: { at: 'x' } },
  { id: 'c', name: 'done-once', schedule: { kind: 'once' }, state: 'completed', next_run_at: null },
  { id: 'd', name: 'weekly', schedule: { kind: 'cron', expr: '0 9 * * 1' }, state: 'paused', enabled: false, next_run_at: at(16, 9) },
  { id: 'e', name: 'report', schedule: { kind: 'cron', expr: '0 21 * * *' }, state: 'scheduled', next_run_at: at(15, 21), last_status: 'error' },
], now);
assert.deepEqual(rows.map((r) => [r.title, r.when, r.next, r.running, r.paused, r.failed]), [
  ['Mail check', 'Every 30 minutes', '', true, false, false],
  ['Report', 'Every day at 9:00 pm', 'Today, 9:00 pm', false, false, true],
  ['Meds', 'Every day at 3:00 am', 'Tomorrow, 3:00 am', false, false, false],
  ['Weekly', 'Mondays at 9:00 am', '', false, true, false],
]);
assert.deepEqual(m.scheduleRows(null), []);
assert.equal(m.mentionText({ title: 'Morning briefing', id: '666a4ca6070b' }), '[Schedule: Morning briefing · job 666a4ca6070b]');
assert.equal(m.mentionText({ title: 'A]b', id: 'x1' }), '[Schedule: A)b · job x1]');
'''

CRON = [
    ("* * * * *", "Every minute"),
    ("*/5 * * * *", "Every 5 minutes"),
    ("15 * * * *", "Every hour"),
    ("0 */2 * * *", "Every 2 hours"),
    ("45 7 * * *", "Every day at 7:45 am"),
    ("30 0 * * *", "Every day at 12:30 am"),
    ("0 1,10 * * *", "Every day at 1:00 am and 10:00 am"),
    ("0 0,4,8,12,16,20 * * *", "6 times a day"),
    ("0 21,22,23,0-12 * * *", "16 times a day"),
    ("0 13 * * 1-5", "Weekdays at 1:00 pm"),
    ("0 9 * * 0,6", "Weekends at 9:00 am"),
    ("0 15 * * 2-6", "Tue–Sat at 3:00 pm"),
    ("0 9 * * 1", "Mondays at 9:00 am"),
    ("0 9 * * 1,3", "Mon and Wed at 9:00 am"),
    ("0 9 1 * *", "Monthly on the 1st at 9:00 am"),
    ("0 20 22 * *", "Monthly on the 22nd at 8:00 pm"),
    ("0 21 13 11 *", "On Nov 13 at 9:00 pm"),
    ("0 9 8-15 12 *", "On Dec 8–15 at 9:00 am"),
    ("0 8,11,14,17,20 11 11 *", "On Nov 11, 5 times a day"),
    ("0 9 1 * 1", ""),
    ("bad", ""),
]


class SchedulesPanelTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the browser module")
    def test_wording_and_rows(self):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT, str(DASHBOARD / "schedules.js")],
                             input=json.dumps({"cron": CRON}), text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_the_panel_only_reads_pauses_resumes_and_deletes(self):
        source = (DASHBOARD / "schedules.js").read_text(encoding="utf-8")
        self.assertIn('api("/api/cron/jobs")', source)
        # The only changes it can make: pause/resume (POST) and delete (DELETE), delete behind a confirm.
        self.assertEqual(sorted(set(__import__("re").findall(r'method: "([A-Z]+)"', source))), ["DELETE", "POST"])
        self.assertIn("/${verb}`", source)
        self.assertIn("confirmDialog(", source)
        for label in ("Add to message", "Pause", "Resume", "Delete"):
            self.assertIn(f'"{label}"', source)
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('expandMentions(expandPastes(els.input.value))', app)
        self.assertIn('appendWithSchedules(body, text)', app)
        self.assertIn("SCHEDULE_REF", app)
        self.assertNotIn('method: "PUT"', source)
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        # Opened from a row in the chats panel, directly under the main chat.
        drawer = html.split('id="drawer"', 1)[1].split("</aside>", 1)[0]
        self.assertIn('class="chat-row drawer-inbox drawer-sched"', drawer)
        drawer_js = (DASHBOARD / "drawer.js").read_text(encoding="utf-8")
        self.assertEqual(drawer_js.count("if (schedRow) list.append(schedRow);"), 2)
        browse = drawer_js.split("function renderBrowse(", 1)[1].split("\n  function ", 1)[0]
        slot = browse.index("list.append(slot);")
        self.assertLess(browse.index("if (schedRow) list.append(schedRow);", slot), browse.index("list.append(newBtn);", slot))
        self.assertIn('id="schedDialog"', html)
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('import { createSchedules, mentionText } from "./schedules.js";', app)

    def test_tools_button_folds_the_tray_buttons(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        order = [html.index(f'id="{name}"') for name in ("toolsBtn", "profileBtn", "screenBtn", "todoBtn", "artBtn")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(html.count("fab fab-tray"), 4)
        self.assertIn('aria-controls="profileBtn screenBtn todoBtn artBtn"', html)
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn("body:not(.tools-open) .fab.fab-tray", css)
        self.assertIn("body.tools-open #toolsBtn", css)
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('document.body.classList.toggle("tools-open", openTools)', app)

    def test_desktop_scrollbars_follow_a_class_not_hover(self):
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn(".log.sb-on::-webkit-scrollbar-thumb", css)
        self.assertNotIn(":hover::-webkit-scrollbar-thumb,", css)
        self.assertIn("@media (hover: hover) and (pointer: fine) {", css)
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('classList.add("sb-on")', app)


if __name__ == "__main__":
    unittest.main()
