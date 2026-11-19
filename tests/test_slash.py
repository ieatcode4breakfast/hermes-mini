"""The "/" picker and skills (dashboard/slash.js, app.js): skills and schedules picked into the draft as pills, a
draft with skills sent through Hermes's skill command, and a stored skill message shown as its pills and words.

The JS helpers run under Node. Where a Hermes checkout is on the path (the test-box gate), the JS twin of Hermes's
describe_skill_invocation and slugify_skill_name is checked against the real ones on the same messages.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from tests.support import DASHBOARD

PRELUDE = r'''
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
// toast.js registers page listeners when loaded; the helpers need no page.
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, getElementById() { return null; } };
const m = await import(pathToFileURL(process.argv[1]).href);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
'''


def run_node(script: str, payload) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", "--input-type=module", "-e", PRELUDE + script, str(DASHBOARD / "slash.js")],
        input=json.dumps(payload), text=True, capture_output=True,
    )


def _hermes_root() -> Path | None:
    for entry in sys.path:
        base = Path(entry or ".")
        if (base / "agent" / "skill_commands.py").is_file() and (base / "tui_gateway").is_dir():
            return base
    return None


HERMES = _hermes_root()


@unittest.skipUnless(shutil.which("node"), "Node is needed for the slash picker helpers")
class SlashHelpersTest(unittest.TestCase):
    def test_query_is_the_slash_word_at_the_caret(self):
        script = r'''
const q = (value, caret = value.length) => m.slashQuery(value, caret);
assert.deepEqual(q('/'), { start: 0, query: '' });
assert.deepEqual(q('/hum'), { start: 0, query: 'hum' });
assert.deepEqual(q('use /hum'), { start: 4, query: 'hum' });
assert.deepEqual(q('a\n/sch'), { start: 2, query: 'sch' });
assert.deepEqual(q('/human', 3), { start: 0, query: 'hu' });
assert.equal(q('and/or'), null);
assert.equal(q('/usr/lo'), null);
assert.equal(q('/hum more'), null);
assert.equal(q('plain'), null);
assert.equal(q(''), null);
// A pill's padding spaces count as whitespace: a slash right after a pill starts a query.
assert.deepEqual(q('   x  /a'), { start: 6, query: 'a' });
'''
        run = run_node(script, None)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_matches_rank_skills_and_filter_schedules(self):
        script = r'''
const skills = m.skillRows([
  { name: 'humanizer', description: 'Humanize text', usage: 1 },
  { name: 'github', description: 'GitHub via gh: humans welcome', usage: 9 },
  { name: 'weekly-review-planning', description: 'Weekly reset', usage: 0 },
  { name: 'off', description: 'x', enabled: false },
  { name: '', description: 'nameless' },
  'junk',
]);
assert.deepEqual(skills.map((s) => s.name), ['humanizer', 'github', 'weekly-review-planning']);
const schedules = [{ id: 'a', title: 'Morning briefing' }, { id: 'b', title: 'Review inbox' }];
let hit = m.slashMatches('', skills, schedules);
assert.deepEqual(hit.skills.map((s) => s.name), ['github', 'humanizer', 'weekly-review-planning']); // most used first
assert.deepEqual(hit.schedules.map((s) => s.id), ['a', 'b']);
hit = m.slashMatches('hum', skills, schedules);
assert.deepEqual(hit.skills.map((s) => s.name), ['humanizer', 'github']); // name before description
assert.deepEqual(hit.schedules, []);
hit = m.slashMatches('review', skills, schedules);
assert.deepEqual(hit.skills.map((s) => s.name), ['weekly-review-planning']);
assert.deepEqual(hit.schedules.map((s) => s.id), ['b']);
hit = m.slashMatches('weekly rev', skills, schedules);
assert.deepEqual(hit.skills.map((s) => s.name), ['weekly-review-planning']);
hit = m.slashMatches('brief', skills, schedules);
assert.deepEqual(hit.schedules.map((s) => s.id), ['a']);
assert.deepEqual(m.slashMatches('zzz', skills, schedules), { skills: [], schedules: [] });
assert.deepEqual(m.slashMatches('a', null, null), { skills: [], schedules: [] });
'''
        run = run_node(script, None)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_stored_skill_messages_show_as_pills_and_words(self):
        script = r'''
const note = '[IMPORTANT: The user has invoked the "humanizer" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]';
const ask = 'The user has provided the following instruction alongside the skill invocation: ';
const d = (content) => m.describeSkillInvocation(content);
assert.deepEqual(d(`${note}\n\nBody\n\n${ask}fix  the\nleak`), { names: ['humanizer'], text: 'fix the leak' });
assert.deepEqual(d(`${note}\n\nBody`), { names: ['humanizer'], text: '' });
assert.deepEqual(d(`${note}\n\n${ask}quoted\n\n${ask}real one\n\n[Runtime note: x]`), { names: ['humanizer'], text: 'real one' });
const stacked = '[IMPORTANT: The user has invoked the "/humanizer /github" stacked skill bundle, loading 2 skills together. Treat every skill below as active guidance for this turn.]\n\nSkills loaded: humanizer, github\n\nUser instruction: do it\n\n[Loaded as part of the stacked skill invocation "humanizer".]\n\nUser instruction: not this';
assert.deepEqual(d(stacked), { names: ['humanizer', 'github'], text: 'do it' });
assert.equal(m.skillLabel(d(stacked)), '/humanizer /github do it');
assert.equal(m.skillLabel(d(`${note}\n\nBody`)), '/humanizer');
assert.equal(d('hello'), null);
assert.equal(d(''), null);
assert.equal(d(null), null);
assert.equal(m.skillSlug('Code Review'), 'code-review');
assert.equal(m.skillSlug('foo_bar  baz'), 'foo-bar-baz');
assert.equal(m.skillSlug('C++ helper'), 'c-helper');
'''
        run = run_node(script, None)
        self.assertEqual(run.returncode, 0, run.stderr)


@unittest.skipUnless(shutil.which("node"), "Node is needed for the slash picker helpers")
@unittest.skipUnless(HERMES, "no Hermes checkout on sys.path")
class SkillTextMatchesHermesTest(unittest.TestCase):
    """slash.js describeSkillInvocation and skillSlug give what Hermes's own functions give."""

    def test_describe_and_slug_agree_with_hermes(self):
        from agent import skill_commands as sc

        note = ('[IMPORTANT: The user has invoked the "humanizer" skill, indicating they want you to follow its '
                'instructions. The full skill content is loaded below.]')
        parts = [note, "", "Body text\nwith lines"]
        sc.append_user_instruction(parts, "fix  the\n\nleak")
        single = "\n".join(parts)
        bare = "\n".join([note, "", "Body"])
        runtime = single + "\n\n[Runtime note: from a schedule]"
        quoted = "\n".join([note, "", sc._SINGLE_SKILL_INSTRUCTION + "inside the body", ""]) + "\n" + \
            sc._SINGLE_SKILL_INSTRUCTION + "the real one"
        stacked = sc._scaffold_header('"/humanizer /github" stacked skill bundle', ["humanizer", "github"],
                                      user_instruction="do it") + '\n\n[Loaded as part of the stacked skill invocation "humanizer".]\n\nBody'
        stacked_bare = sc._scaffold_header('"/humanizer /github" stacked skill bundle', ["humanizer", "github"]) + \
            '\n\n[Loaded as part of the stacked skill invocation "humanizer".]\n\nBody'
        excerpt = single.replace("the\n\nleak", "the" + sc.SKILL_EXCERPT_JOINT + "tail")
        messages = [single, bare, runtime, quoted, stacked, stacked_bare, excerpt, "hello", "", "[IMPORTANT: other"]
        expected = [sc.describe_skill_invocation(text, separator=" ") for text in messages]
        names = ["Code Review", "claude-code", "Foo_Bar  Baz", "C++ helper", "Ünïcode Skill", "--x--", "a.b"]
        slugs = [sc.slugify_skill_name(name) for name in names]
        script = r'''
const out = input.messages.map((text) => {
  const info = m.describeSkillInvocation(text);
  return info ? m.skillLabel(info) : null;
});
assert.deepEqual(out, input.expected);
assert.deepEqual(input.names.map((name) => m.skillSlug(name)), input.slugs);
'''
        run = run_node(script, {"messages": messages, "expected": expected, "names": names, "slugs": slugs})
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_hermes_still_offers_what_the_picker_uses(self):
        tools = (HERMES / "tui_gateway" / "methods_tools.py").read_text(encoding="utf-8")
        self.assertIn('@method("command.dispatch")', tools)
        routes = (HERMES / "hermes_cli" / "web_routers" / "skills.py").read_text(encoding="utf-8")
        self.assertIn('@router.get("/api/skills")', routes)


class SlashWiringTest(unittest.TestCase):
    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.slash = (DASHBOARD / "slash.js").read_text(encoding="utf-8")
        self.css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")

    def test_picker_is_a_top_layer_popup_fed_by_skills_and_schedules(self):
        self.assertIn('menu.setAttribute("popover", "manual");', self.slash)
        self.assertIn('api("/api/skills")', self.slash)
        self.assertIn('api("/api/cron/jobs")', self.slash)
        self.assertNotRegex(self.css, r"\.slash-menu \{[^}]*z-index")
        self.assertIn('"slash.js"', self.sw.split("const CORE = [", 1)[1].split("];", 1)[0])

    def test_picks_become_pills_and_skills_go_through_the_skill_command(self):
        self.assertIn('if (item.kind === "skill") addSkillMention(item.name);', self.app)
        self.assertIn("else addMention(item.job);", self.app)
        self.assertIn('kind === "skill" ? SKILL_ICON : CLOCK_ICON', self.app)
        self.assertIn('await rpc("command.dispatch", { session_id: state.liveSid, name: first, arg });', self.app)
        self.assertIn('const full = [outgoing, ...refs].filter(Boolean).join("\\n");', self.app)

    def test_skill_messages_are_shown_short_and_not_edited(self):
        self.assertIn("describeSkillInvocation(messageText(message))", self.app)
        self.assertIn("Boolean(describeSkillInvocation(messageText(message)))", self.app)
        self.assertIn("body.append(skillPill(name));", self.app)

    def test_a_steer_never_carries_skills(self):
        steer = self.app.split("async function steer() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("if (draftSkills().length) {", steer)
        self.assertIn("expandMentions(expandPastes(els.input.value))", steer)


if __name__ == "__main__":
    unittest.main()
