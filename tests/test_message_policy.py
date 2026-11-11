"""Offline regression tests for what a person sees, including JS/Python parity."""
import json
import shutil
import subprocess
import sys
import types
import unittest
from unittest import mock

from tests.support import PROJECT_ROOT, DisposableHome, load_module

INTRO = "I'm Hermes, your assistant here — I can find things, run tasks, and keep track of work for you. Typing /help shows the commands you can use."
RESULT = "Here are your photos.\n\nMEDIA:/tmp/cat.jpg"


class MessagePolicyTest(DisposableHome):
    def setUp(self):
        super().setUp()
        self.policy = load_module('hermes_mini_message_policy', PROJECT_ROOT / 'message_policy.py')

    def test_mixed_answer_keeps_result_and_attachments(self):
        self.assertEqual(self.policy.display_text(RESULT + '\n\n' + INTRO), RESULT)
        self.assertEqual(self.policy.display_text(INTRO), '')

    def test_ordinary_greetings_quotes_code_and_commands_survive(self):
        for text in ["Hi! How can I help?", "I'm Hermes. You asked who I am.",
                     'Use /help in the terminal, as you requested.', '> ' + INTRO,
                     '```text\n\n' + INTRO + '\n\n```',
                     'The model provider uses /model for configuration.',
                     'Your reminder: restart the gateway after work.', RESULT]:
            with self.subTest(text=text):
                self.assertEqual(self.policy.display_text(text), text)

    def test_bridge_notices_are_narrow(self):
        for text in ['♻️ Gateway online — Hermes is back and ready.',
                     '♻ Gateway restarted successfully. Your session continues.',
                     '⚠️ Hermes is shutting down — please wait.',
                     '💡 First-time tip — send `/busy queue` to queue messages.']:
            self.assertEqual(self.policy.display_text(text, notice=True), '')
        self.assertEqual(self.policy.display_text('Gateway online — Hermes is back and ready.'),
                         'Gateway online — Hermes is back and ready.')
        self.assertEqual(self.policy.display_text(RESULT, notice=True), RESULT)
        self.assertEqual(self.policy.display_text(
            'Message queued.\n\n💡 First-time tip — send /busy queue.', notice=True), 'Message queued.')

    def test_failures_keep_actionable_meaning_without_commands(self):
        cases = {
            'The model provider rejected the API key. Fix the key with /model, then /retry.': 'setup or account',
            'The conversation is too long for this model. Run /compress, then /retry.': 'Start a new chat',
            'History changed during this turn — the response above is visible but was not saved to session history.': 'could not be saved',
            'I ran out of steps for this turn (10 tool calls). Raise max_iterations in your config.': 'Send “continue”',
            'The model provider is rate-limiting requests. Wait, then /retry.': 'Wait a moment',
        }
        for source, meaning in cases.items():
            shown = self.policy.display_text(source)
            self.assertIn(meaning, shown)
            self.assertNotIn('/retry', shown)
            self.assertNotIn('/model', shown)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for browser policy parity')
    def test_browser_parity_and_chunked_streaming(self):
        cases = [INTRO, RESULT + '\n\n' + INTRO, '> ' + INTRO,
                 '```text\n\n' + INTRO + '\n\n```', RESULT,
                 'The model provider rejected the API key. Fix it with /model, then /retry.',
                 'The model provider uses /model for configuration.',
                 'The conversation is too long for this model. Run /compress.',
                 'History changed during this turn — the response above is visible but was not saved to session history.',
                 '♻️ Gateway online — Hermes is back and ready.',
                 '💡 First-time tip — send /verbose.']
        fixtures = [{'text': text, 'notice': notice,
                     'expected': self.policy.display_text(text, notice=notice)}
                    for text in cases for notice in [False, True]]
        script = '''
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { displayText } = await import('data:text/javascript;base64,' +
  fs.readFileSync(process.argv[1]).toString('base64'));
const { fixtures, intro, result } = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const f of fixtures) assert.equal(displayText(f.text, {notice:f.notice}), f.expected);
for (let i = 1; i <= intro.length; i++) {
  assert.equal(displayText(intro.slice(0,i), {streaming:true}), '');
  assert.equal(displayText(result + '\\n\\n' + intro.slice(0,i), {streaming:true}), result);
}
console.log('22 parity fixtures and all introduction stream boundaries passed');
'''
        run = subprocess.run(['node', '--input-type=module', '-e', script,
                              str(PROJECT_ROOT / 'dashboard/message-policy.js')],
                             input=json.dumps({'fixtures': fixtures, 'intro': INTRO, 'result': RESULT}),
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_bridge_hides_before_storage_or_push(self):
        bridge = load_module('hermes_mini_bridge', PROJECT_ROOT / 'bridge.py')
        with mock.patch.object(bridge, '_resolve_session_id', side_effect=AssertionError('must not access DB')):
            for text in ['♻ Gateway restarted successfully. Your session continues.',
                         '💡 First-time tip — use /busy queue.']:
                self.assertTrue(bridge.deliver_text(text)['success'])

    def test_push_preview_uses_visible_text_and_suppresses_empty_intro(self):
        hooks = load_module('hermes_mini_hooks', PROJECT_ROOT / '__init__.py')
        store = mock.Mock()
        with mock.patch.object(hooks, '_app_chat', return_value=('chat', 'Side chat')), \
             mock.patch.object(hooks, '_push', return_value=store):
            hooks._post_llm_call(session_id='chat', assistant_response=INTRO)
            store.notify.assert_not_called()
            hooks._post_llm_call(session_id='chat', assistant_response=RESULT + '\n\n' + INTRO)
            self.assertEqual(store.notify.call_count, 1)
            self.assertNotIn('/help', store.notify.call_args.args[2])

    def test_inbox_hides_legacy_notice_and_preserves_mixed_answer(self):
        try:
            api = load_module('hermes_mini_policy_api', PROJECT_ROOT / 'dashboard/plugin_api.py')
        except ImportError:
            self.skipTest('FastAPI unavailable')
        row = {'id': 1, 'session_id': 'chat', 'role': 'assistant', 'display_kind': '',
               'content': RESULT + '\n\n' + INTRO, 'display_content': None,
               'display_metadata': '{}', 'timestamp': 1, 'finish_reason': 'stop', 'tool_calls': None}
        with mock.patch.object(api, '_home_id', return_value=''):
            item = api._inbox_item(row, {'chat': 'Photos'})
            self.assertIsNotNone(item)
            self.assertNotIn('/help', item['text'])
            row.update(role='user', display_kind='job_delivery', content='[Scheduled job result]\n♻ Gateway restarted successfully.')
            self.assertIsNone(api._inbox_item(row, {}))

    def test_inbox_marks_main_chat_rows_home(self):
        try:
            api = load_module('hermes_mini_policy_api_home', PROJECT_ROOT / 'dashboard/plugin_api.py')
        except ImportError:
            self.skipTest('FastAPI unavailable')
        row = {'id': 1, 'session_id': 'main', 'role': 'assistant', 'display_kind': '',
               'content': 'Morning summary.', 'display_content': None,
               'display_metadata': '{}', 'timestamp': 1, 'finish_reason': 'stop', 'tool_calls': None}
        with mock.patch.object(api, '_home_id', return_value='main'):
            self.assertTrue(api._inbox_item(row, {})['home'])
            row.update(session_id='side')
            item = api._inbox_item(row, {'side': 'Photos'})
            self.assertFalse(item['home'])
            self.assertEqual(item['thread'], 'Photos')

    def test_turn_guidance_is_app_scoped_and_present_on_existing_chats(self):
        hooks = load_module('hermes_mini_hooks', PROJECT_ROOT / '__init__.py')
        with mock.patch.object(hooks, '_in_app_chat', return_value=False):
            self.assertIsNone(hooks._pre_llm_call(session_id='other'))
        with mock.patch.object(hooks, '_in_app_chat', return_value=True), \
             mock.patch.object(hooks, '_app_chat', return_value=None):
            context = hooks._pre_llm_call(session_id='existing')['context']
            self.assertIn('no slash-command interface', context)
            self.assertIn('first-contact introductions', context)
