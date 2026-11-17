"""Question sets (dashboard/clarify.js): Skip answers one question, Back and Change reopen an earlier one, and a
set of two or more ends on a review step whose Submit sends the last answer.

Hermes locks each answer with clarify.lock and lets it be changed until the lock that leaves nothing unanswered,
which ends the set; a null answer is reported to the agent as "skipped" for that question.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

SCRIPT = r'''
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[1]).href);
const Q = (n) => Array.from({ length: n }, (_, i) => ({ qid: `q${i + 1}`, question: `Question ${i + 1}?` }));

// Three questions: answer, skip, answer. The first two lock at once; the third would end the set, so it waits.
let f = m.startFlow(Q(3));
assert.equal(f.index, 0);
assert.equal(m.hasReview(f), true);
assert.deepEqual(m.answerCurrent(f, 'Italian'), [{ qid: 'q1', value: 'Italian' }]);
assert.equal(f.index, 1);
assert.deepEqual(m.answerCurrent(f, null), [{ qid: 'q2', value: null }]);
assert.equal(f.index, 2);
assert.deepEqual(m.answerCurrent(f, 'Low'), []);
assert.equal(f.reviewing, true);
assert.deepEqual(m.answerRows(f).map((r) => [r.status, r.value]), [['answered', 'Italian'], ['skipped', null], ['answered', 'Low']]);

// Change the first answer from the review: it locks again (Hermes overwrites it) and the review comes back.
m.changeAnswer(f, 0);
assert.equal(f.reviewing, false);
assert.equal(m.currentAnswer(f), 'Italian');
assert.deepEqual(m.answerCurrent(f, 'Mexican'), [{ qid: 'q1', value: 'Mexican' }]);
assert.equal(f.reviewing, true);

// Change the last answer: still held, nothing sent.
m.changeAnswer(f, 2);
assert.deepEqual(m.answerCurrent(f, 'High'), []);
assert.equal(f.reviewing, true);

// Back out of a Change without answering keeps the earlier answer.
m.changeAnswer(f, 1);
m.backToReview(f);
assert.equal(f.reviewing, true);
assert.equal(f.answers.q2, null);

// Submit sends only what was held.
assert.deepEqual(m.submitLocks(f), [{ qid: 'q3', value: 'High' }]);
assert.deepEqual(m.submitLocks(f), []);

// Back from question 2 reopens question 1 with its answer; answering again moves forward, not to the review.
f = m.startFlow(Q(2));
m.answerCurrent(f, 'A');
m.goBack(f);
assert.equal(f.index, 0);
assert.equal(m.currentAnswer(f), 'A');
assert.deepEqual(m.answerCurrent(f, 'B'), [{ qid: 'q1', value: 'B' }]);
assert.equal(f.index, 1);
assert.equal(f.reviewing, false);
m.goBack(f);
m.goBack(f);
assert.equal(f.index, 0, 'Back stops at the first question');

// One question: no review. An answer or a skip is sent at once and ends the set.
f = m.startFlow(Q(1));
assert.equal(m.hasReview(f), false);
assert.deepEqual(m.answerCurrent(f, 'Yes'), [{ qid: 'q1', value: 'Yes' }]);
assert.equal(f.reviewing, false);
f = m.startFlow(Q(1));
assert.deepEqual(m.answerCurrent(f, null), [{ qid: 'q1', value: null }]);

// A card reopened after a reload starts on the first question Hermes has no answer for; a skip counts as one.
f = m.startFlow(Q(3), { q1: 'x', q2: null });
assert.equal(f.index, 2);
assert.equal(f.answers.q2, null);
assert.deepEqual(m.answerCurrent(f, 'z'), []);
assert.equal(f.reviewing, true);

// A question never reached is sent as skipped on Submit.
f = m.startFlow(Q(2));
m.answerCurrent(f, 'A');
m.goBack(f);
f.reviewing = true;
assert.deepEqual(m.submitLocks(f), [{ qid: 'q2', value: null }]);

// A failed send puts everything back.
f = m.startFlow(Q(3));
const saved = m.saveState(f);
m.answerCurrent(f, 'A');
m.restoreState(f, saved);
assert.equal(f.index, 0);
assert.equal(f.sent.size, 0);
assert.equal(m.currentAnswer(f), undefined);
'''


class ClarifyFlowTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the browser module")
    def test_skip_back_change_and_review(self):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT, str(DASHBOARD / "clarify.js")],
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_card_uses_the_flow_and_skip_is_per_question(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('import * as clarifyFlow from "./clarify.js";', app)
        render = app.split("function renderClarify(", 1)[1].split("\nfunction ", 1)[0]
        nav = app.split("function clarifyNavRow(", 1)[1].split("\nfunction ", 1)[0]
        # Skip answers this question with null; it no longer cancels the whole set.
        self.assertIn("answerClarify(id, entry, null)", nav)
        self.assertNotIn("answerServerRequest", render + nav)
        self.assertIn('"Send"', render)
        self.assertIn("clarifyNavRow(id, entry)", render)
        for label in ('"Back"', '"Skip"'):
            self.assertIn(label, nav)
        review = app.split("function renderClarifyReview(", 1)[1].split("\nfunction ", 1)[0]
        for label in ('"Your answers"', '"Change"', '"Submit"'):
            self.assertIn(label, review)
        step = app.split("async function runClarifyStep(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('rpc("clarify.lock"', step)
        self.assertIn("clarifyFlow.restoreState(flow, saved)", step)

    def test_multi_select_toggles_and_sends_a_list(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        render = app.split("function renderClarify(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("if (question.multi_select) {", render)
        multi = app.split("function renderMultiSelect(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("picked.delete(value)", multi)  # a tap toggles; it does not send
        self.assertIn("answerClarify(id, entry, JSON.stringify(items))", multi)
        self.assertIn('"Next" : "Send"', multi)
        self.assertIn("clarifyNavRow(id, entry)", multi)
        self.assertIn("send.disabled = picked.size === 0", multi)

    def test_module_is_precached(self):
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        core = sw.split("const CORE = [", 1)[1].split("];", 1)[0]
        self.assertIn('"clarify.js"', re.findall(r'"[^"]+"', core))


if __name__ == "__main__":
    unittest.main()
