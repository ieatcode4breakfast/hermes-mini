"""The hook half: app-chat scoping, notification filtering, and the self-edit guard.

These tests import ``__init__.py`` the way the loader does and drive the hook functions directly.
Session lookups use a fake ``SessionDB`` so the tests never touch a real ``state.db``; the fake
exposes the documented read methods the hooks now call.
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

from tests.support import PROJECT_ROOT, DisposableHome, load_module


class FakeSessionDB:
    """The documented read surface the hooks use, over an in-memory table."""

    rows: dict[str, dict] = {}
    latest: dict | None = None

    def __init__(self, *args, **kwargs):
        pass

    def get_session_title(self, session_id):
        row = self.rows.get(session_id)
        return row["title"] if row else None

    def get_session(self, session_id):
        return self.rows.get(session_id)

    def _read_one(self, sql, params=()):
        if "FROM messages" in sql and self.latest is not None:
            return self.latest
        return None


def fake_hermes_state():
    module = types.ModuleType("hermes_state")
    module.SessionDB = FakeSessionDB
    return module


class HookTestCase(DisposableHome):
    def setUp(self):
        super().setUp()
        FakeSessionDB.rows = {}
        FakeSessionDB.latest = None
        sys.modules["hermes_state"] = fake_hermes_state()
        self.hooks = load_module("hermes_mini_hooks", PROJECT_ROOT / "__init__.py")
        self.push = load_module("hermes_mini_push", PROJECT_ROOT / "push_store.py")
        self.chats = load_module("hermes_mini_app_chats", PROJECT_ROOT / "app_chats.py")

    def tearDown(self):
        sys.modules.pop("hermes_state", None)
        super().tearDown()

    def add_session(self, session_id, title="", source="tui", parent=None, archived=0):
        FakeSessionDB.rows[session_id] = {
            "id": session_id, "title": title, "source": source,
            "parent_session_id": parent, "archived": archived,
        }

    def notified(self):
        """Capture what would be queued by patching the store's notify."""
        calls = []
        original = self.push.notify

        def record(*args, **kwargs):
            calls.append((args, kwargs))
            return True

        self.push.notify = record
        self.addCleanup(setattr, self.push, "notify", original)
        return calls


class AppChatScopingTest(HookTestCase):
    def test_home_thread_is_always_an_app_chat(self):
        self.add_session("s1", title="Hermes Mini")
        self.assertEqual(self.hooks._app_chat("s1"), ("s1", "Hermes Mini"))

    def test_registered_tui_chat_is_notified(self):
        self.add_session("s2", title="Groceries")
        self.chats.add("s2")
        self.assertEqual(self.hooks._app_chat("s2"), ("s2", "Groceries"))

    def test_unregistered_tui_chat_is_not_notified(self):
        self.add_session("s3", title="Terminal chat")
        self.assertIsNone(self.hooks._app_chat("s3"))

    def test_discord_chat_is_not_notified(self):
        self.add_session("s4", title="Server", source="discord")
        self.chats.add("s4")
        self.assertIsNone(self.hooks._app_chat("s4"))

    def test_subagent_chat_is_not_notified(self):
        self.add_session("s5", title="Subagent: helper")
        self.assertIsNone(self.hooks._app_chat("s5"))

    def test_unknown_session_is_not_notified(self):
        self.assertIsNone(self.hooks._app_chat("nope", "also-nope"))


class NotificationTest(HookTestCase):
    def test_reply_hook_skips_tool_call_steps(self):
        self.add_session("s1", title="Hermes Mini")
        calls = self.notified()
        self.hooks._post_llm_call(session_id="s1", assistant_response="Hi", finish_reason="tool_calls")
        self.assertEqual(calls, [])

    def test_reply_hook_skips_silence_markers(self):
        self.add_session("s1", title="Hermes Mini")
        calls = self.notified()
        self.hooks._post_llm_call(session_id="s1", assistant_response="NO_REPLY")
        self.assertEqual(calls, [])

    def test_reply_hook_notifies_for_a_real_reply(self):
        self.add_session("s1", title="Hermes Mini")
        calls = self.notified()
        self.hooks._post_llm_call(session_id="s1", assistant_response="Here is the answer.")
        self.assertEqual(len(calls), 1)
        args, kwargs = calls[0]
        self.assertEqual(args[0], "reply")
        self.assertEqual(kwargs["match"], "Here is the answer.")

    def test_approval_hook_skips_coalesced_requests(self):
        calls = self.notified()
        self.hooks._pre_approval_request(session_id="s1", command="rm -rf /", coalesced=True)
        self.assertEqual(calls, [])

    def test_approval_hook_ignores_a_chat_outside_the_app(self):
        self.add_session("s9", title="CLI", source="cli")
        calls = self.notified()
        self.hooks._pre_approval_request(session_id="s9", command="ls")
        self.assertEqual(calls, [])

    def test_human_input_hook_only_for_clarify(self):
        self.add_session("s1", title="Hermes Mini")
        calls = self.notified()
        self.hooks._on_human_input_request(session_id="s1", kind="approval", prompt="ok?")
        self.assertEqual(calls, [])
        self.hooks._on_human_input_request(session_id="s1", kind="clarify", prompt="Which one?")
        self.assertEqual(len(calls), 1)


class InstructionsTest(HookTestCase):
    def test_default_rule_applies_only_in_app_chats(self):
        self.add_session("s1", title="Hermes Mini")
        self.add_session("s9", title="CLI", source="cli")
        self.assertEqual(
            self.hooks._pre_llm_call(session_id="s1"),
            {"context": self.hooks._DEFAULT_APP_INSTRUCTIONS},
        )
        self.assertIsNone(self.hooks._pre_llm_call(session_id="s9"))

    def test_optional_instructions_are_appended_in_app_chats(self):
        self.add_session("s1", title="Hermes Mini")
        self.add_session("s9", title="CLI", source="cli")
        path = self.core.instructions_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("Be brief.", encoding="utf-8")
        expected = self.hooks._DEFAULT_APP_INSTRUCTIONS + "\n\n" + "Be brief."
        self.assertEqual(self.hooks._pre_llm_call(session_id="s1"), {"context": expected})
        self.assertIsNone(self.hooks._pre_llm_call(session_id="s9"))


class ProgressNudgeTest(HookTestCase):
    def test_nudges_only_in_app_chats(self):
        self.add_session("s1", title="Hermes Mini")
        self.add_session("s9", title="CLI", source="cli")
        with mock.patch.object(self.hooks.time, "monotonic", return_value=0.0):
            self.assertIsNone(
                self.hooks._transform_tool_result(session_id="s1", turn_id="t1", result="x")
            )
            self.assertIsNone(
                self.hooks._transform_tool_result(session_id="s9", turn_id="t9", result="x")
            )

    def test_tenth_tool_call_nudges(self):
        self.add_session("s1", title="Hermes Mini")
        with mock.patch.object(self.hooks.time, "monotonic", return_value=0.0):
            for _ in range(9):
                self.assertIsNone(
                    self.hooks._transform_tool_result(session_id="s1", turn_id="t2", result="x")
                )
            out = self.hooks._transform_tool_result(session_id="s1", turn_id="t2", result="x")
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith("x"))
        self.assertIn("PROGRESS UPDATE", out)

    def test_four_minutes_nudges(self):
        self.add_session("s1", title="Hermes Mini")
        with mock.patch.object(self.hooks.time, "monotonic", side_effect=[0.0, 241.0]):
            self.assertIsNone(
                self.hooks._transform_tool_result(session_id="s1", turn_id="t3", result="x")
            )
            out = self.hooks._transform_tool_result(session_id="s1", turn_id="t3", result="x")
        self.assertIsNotNone(out)
        self.assertIn("~4 minutes", out)

    def test_subagent_is_skipped(self):
        self.add_session("s1", title="Hermes Mini")
        with mock.patch.object(self.hooks.time, "monotonic", return_value=0.0):
            for _ in range(10):
                self.assertIsNone(self.hooks._transform_tool_result(
                    session_id="s1", turn_id="t4", platform="subagent", result="x",
                ))

    def test_finished_turn_clears_the_tracker(self):
        self.add_session("s1", title="Hermes Mini")
        self.notified()
        with mock.patch.object(self.hooks.time, "monotonic", return_value=0.0):
            self.hooks._transform_tool_result(session_id="s1", turn_id="t5", result="x")
        self.assertIn("t5", self.hooks._TURN_TRACKER)
        self.hooks._post_llm_call(
            session_id="s1", turn_id="t5", assistant_response="Done.", finish_reason="stop",
        )
        self.assertNotIn("t5", self.hooks._TURN_TRACKER)


class GuardTest(HookTestCase):
    def test_blocks_writing_the_plugin_from_an_app_chat(self):
        self.add_session("s1", title="Hermes Mini")
        result = self.hooks._pre_tool_call(
            tool_name="write_file", session_id="s1",
            args={"path": str(PROJECT_ROOT / "__init__.py")},
        )
        self.assertEqual(result["action"], "block")

    def test_allows_reading_the_plugin(self):
        self.add_session("s1", title="Hermes Mini")
        self.assertIsNone(self.hooks._pre_tool_call(
            tool_name="read_file", session_id="s1",
            args={"path": str(PROJECT_ROOT / "__init__.py")},
        ))

    def test_allows_writes_elsewhere(self):
        self.add_session("s1", title="Hermes Mini")
        self.assertIsNone(self.hooks._pre_tool_call(
            tool_name="write_file", session_id="s1",
            args={"path": str(self.home / "notes.txt")},
        ))

    def test_shell_write_with_plugin_path_is_blocked(self):
        self.add_session("s1", title="Hermes Mini")
        # The guard matches the installed location, which is what a command in a real turn names.
        command = "rm -f /root/.hermes/plugins/hermes-mini/__init__.py"
        self.assertIsNotNone(self.hooks._pre_tool_call(
            tool_name="terminal", session_id="s1", args={"command": command},
        ))

    def test_shell_reads_of_the_plugin_are_allowed(self):
        self.add_session("s1", title="Hermes Mini")
        self.assertIsNone(self.hooks._pre_tool_call(
            tool_name="terminal", session_id="s1",
            args={"command": "cat /root/.hermes/plugins/hermes-mini/plugin.yaml"},
        ))

    def test_outside_an_app_chat_the_guard_is_silent(self):
        self.add_session("s9", title="CLI", source="cli")
        self.assertIsNone(self.hooks._pre_tool_call(
            tool_name="write_file", session_id="s9",
            args={"path": str(PROJECT_ROOT / "__init__.py")},
        ))


class RegistrationTest(HookTestCase):
    def test_register_declares_the_documented_hooks(self):
        calls = []

        class Ctx:
            def register_hook(self, name, callback):
                calls.append(name)

            def register_auxiliary_task(self, *args, **kwargs):
                calls.append("aux:" + args[0])

            def register_platform(self, *args, **kwargs):
                calls.append("platform")

        self.hooks.register(Ctx())
        for hook in ("pre_tool_call", "pre_approval_request", "on_human_input_request",
                     "post_llm_call", "pre_llm_call", "transform_tool_result"):
            self.assertIn(hook, calls)
        self.assertIn("aux:hermes_mini_narration", calls)
        self.assertIn("platform", calls)


if __name__ == "__main__":
    unittest.main()
