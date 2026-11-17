"""Password, secret and vault prompt cards (dashboard/prompts.js + app.js).

Hermes asks for a credential with one of these server->client requests and waits on the JSON-RPC answer, so a
client that draws no card leaves the turn hanging. The card's text, its fields and the answer frame are pure
rules in prompts.js; app.js draws the card, clears the values on submit or skip, and drops the fields once the
request is answered.
"""

from __future__ import annotations

import shutil
import subprocess
import unittest

from tests.support import DASHBOARD

SCRIPT = r'''
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const p = await import(pathToFileURL(process.argv[1]).href);

// Exactly the six prompt methods, and nothing else.
for (const method of ['sudo', 'display.install.sudo', 'secret', 'vault.unlock_prompt', 'vault.save_login', 'vault.code']) {
  assert.equal(p.isPromptMethod(method), true, method);
}
for (const method of ['approval', 'clarify', 'connection.request', '', 'vault']) {
  assert.equal(p.isPromptMethod(method), false, method);
}

// Only a trimmed https link is ever opened.
assert.equal(p.safeHttpsUrl(' https://example.com/help '), 'https://example.com/help');
assert.equal(p.safeHttpsUrl('http://example.com/'), '');
assert.equal(p.safeHttpsUrl('javascript:alert(1)'), '');
assert.equal(p.safeHttpsUrl('https://example.com/a b'), '');
assert.equal(p.safeHttpsUrl(''), '');

// sudo with a command: the command is shown above one masked field.
const sudo = p.describePrompt('sudo', { command: 'apt-get install -y ffmpeg' });
assert.equal(sudo.title, 'Administrator password');
assert.equal(sudo.command, 'apt-get install -y ffmpeg');
assert.equal(sudo.description, 'Enter your sudo password to run this command for this session.');
assert.deepEqual(sudo.fields, [
  { name: 'value', label: 'Sudo password', placeholder: 'sudo password', masked: true, required: true, autocomplete: 'off' },
]);
assert.equal(sudo.submitLabel, 'Submit');
assert.equal(sudo.skipLabel, 'Skip');
assert.equal(sudo.sentOutcome, 'Password sent');
assert.equal(sudo.skippedOutcome, 'Skipped');
assert.equal(sudo.cancelledOutcome, 'Closed without an answer');
assert.equal(sudo.sentInsteadOutcome, 'Prompt skipped — you sent a message instead');

// sudo without a command says so and shows no command box.
const bare = p.describePrompt('sudo', {});
assert.equal(bare.command, '');
assert.equal(bare.description, 'This agent did not provide the command. Skip if you cannot verify it in the conversation.');
assert.deepEqual(bare.fields, sudo.fields);

// display.install.sudo is the app installing the Bot Screen, not a chat's command.
const install = p.describePrompt('display.install.sudo', { profile_key: 'default' });
assert.equal(install.title, 'Administrator password');
assert.equal(install.description, 'Hermes needs your sudo password to install the Bot Screen packages on the gateway host.');
assert.deepEqual(install.fields, sudo.fields);
assert.equal(install.sentOutcome, 'Password sent');
assert.equal(install.sentInsteadOutcome, 'Prompt skipped — you sent a message instead');

// secret names the env var, the skill and the tool that needs it.
const secret = p.describePrompt('secret', {
  env_var: 'OPENAI_API_KEY',
  prompt: 'Paste your OpenAI key.',
  metadata: { skill_name: 'image-gen', required_for: 'generate_image', help: 'https://platform.openai.com/api-keys' },
});
assert.equal(secret.title, 'Secret required');
assert.equal(secret.subtitle, 'Skill: image-gen (generate_image)');
assert.equal(secret.badge, 'OPENAI_API_KEY');
assert.equal(secret.description, 'Paste your OpenAI key.');
assert.equal(secret.helpUrl, 'https://platform.openai.com/api-keys');
assert.equal(secret.helpText, '');
assert.deepEqual(secret.fields, [
  { name: 'value', label: 'OPENAI_API_KEY', placeholder: 'secret value', masked: true, required: true, autocomplete: 'off' },
]);
assert.equal(secret.submitLabel, 'Submit');
assert.equal(secret.skipLabel, 'Skip');
assert.equal(secret.sentOutcome, 'Saved OPENAI_API_KEY');
assert.equal(secret.skippedOutcome, 'Skipped');
assert.equal(secret.cancelledOutcome, 'Closed without an answer');
assert.equal(secret.sentInsteadOutcome, 'Secret skipped — you sent a message instead');

// A help string that is not an https link is shown as text, never linked.
const plain = p.describePrompt('secret', { env_var: 'TOKEN', metadata: { help: 'Ask your admin for this.' } });
assert.equal(plain.helpUrl, '');
assert.equal(plain.helpText, 'Ask your admin for this.');
assert.equal(plain.subtitle, '');
assert.equal(plain.description, 'Enter value for TOKEN');

// Skill without a tool, tool without a skill, and neither: each piece stands alone.
assert.equal(p.describePrompt('secret', { env_var: 'K', metadata: { skill_name: 'mail' } }).subtitle, 'Skill: mail');
assert.equal(p.describePrompt('secret', { metadata: { required_for: 'search' } }).subtitle, 'search');
assert.equal(p.describePrompt('secret', {}).description, 'Hermes needs a credential to continue.');
assert.equal(p.describePrompt('secret', {}).fields[0].label, 'Secret');
assert.equal(p.describePrompt('secret', {}).sentOutcome, 'Secret saved');

// The vault asks for its master password once per session.
const unlock = p.describePrompt('vault.unlock_prompt', { backend: 'bitwarden', display_name: 'Bitwarden' });
assert.equal(unlock.title, 'Unlock Bitwarden');
assert.equal(unlock.description, 'Enter your master password to unlock Bitwarden for this session. It goes straight to the vault and is never saved in chat.');
assert.deepEqual(unlock.fields, [
  { name: 'value', label: 'Master password', placeholder: 'Master password', masked: true, required: true, autocomplete: 'off' },
]);
assert.equal(unlock.submitLabel, 'Unlock');
assert.equal(unlock.skipLabel, 'Keep locked');
assert.equal(unlock.sentOutcome, 'Unlocked');
assert.equal(unlock.skippedOutcome, 'Kept locked');
assert.equal(unlock.sentInsteadOutcome, 'Unlock skipped — you sent a message instead');
assert.equal(p.describePrompt('vault.unlock_prompt', { backend: 'onepassword' }).title, 'Unlock onepassword');
assert.equal(p.describePrompt('vault.unlock_prompt', {}).title, 'Unlock password vault');

// A missing login is saved with an optional identifier and a required password.
const save = p.describePrompt('vault.save_login', { origin: 'https://mail.example.com/login', site: 'Mail' });
assert.equal(save.title, 'Save Mail login?');
assert.equal(save.description, 'Hermes reached a sign-in page at https://mail.example.com/login and has no saved login for it. It is encrypted on the machine without the model seeing your password.');
assert.deepEqual(save.fields.map((f) => [f.name, f.masked, f.required]), [['identifier', false, false], ['password', true, true]]);
assert.equal(save.submitLabel, 'Save & sign in');
assert.equal(save.skipLabel, "Don't save");
assert.equal(save.sentOutcome, 'Login saved for Mail');
assert.equal(save.skippedOutcome, 'Not saved');
assert.equal(save.sentInsteadOutcome, 'Login prompt skipped — you sent a message instead');
const noOrigin = p.describePrompt('vault.save_login', { site: 'Bank' });
assert.equal(noOrigin.description, 'Enter your login for Bank. It is encrypted on the machine without the model seeing your password.');
assert.equal(p.describePrompt('vault.save_login', { origin: 'https://x.example/' }).title, 'Save https://x.example/ login?');
assert.equal(p.describePrompt('vault.save_login', {}).title, 'Save this site login?');

// A one-time code is not masked, and the site's hint is the second sentence.
const code = p.describePrompt('vault.code', { site: 'Bank', hint: 'Sent by SMS.' });
assert.equal(code.title, 'Verification code for Bank');
assert.equal(code.description, 'Bank is asking for a one-time code. Sent by SMS.');
assert.deepEqual(code.fields, [
  { name: 'value', label: 'Code', placeholder: 'One-time code', masked: false, required: true, autocomplete: 'one-time-code' },
]);
assert.equal(code.submitLabel, 'Enter code');
assert.equal(code.skipLabel, 'Skip');
assert.equal(code.sentOutcome, 'Code sent');
assert.equal(code.sentInsteadOutcome, 'Code skipped — you sent a message instead');
assert.equal(p.describePrompt('vault.code', {}).title, 'Verification code');
assert.equal(p.describePrompt('vault.code', {}).description, 'This site is asking for a one-time code.');

// A method that is not a prompt has no card.
assert.equal(p.describePrompt('approval', {}), null);

// Skip is an empty value, whichever method asked.
for (const method of ['sudo', 'display.install.sudo', 'secret', 'vault.unlock_prompt', 'vault.save_login', 'vault.code']) {
  assert.deepEqual(p.buildPromptResult(method, null), { value: '' }, method);
}
assert.deepEqual(p.buildPromptResult('sudo', undefined), { value: '' });

// Spaces inside a password are part of it: it is never trimmed.
assert.deepEqual(p.buildPromptResult('sudo', { value: '  hunter 2  ' }), { value: '  hunter 2  ' });
assert.deepEqual(p.buildPromptResult('display.install.sudo', { value: 'pw ' }), { value: 'pw ' });
assert.deepEqual(p.buildPromptResult('vault.unlock_prompt', { value: ' master ' }), { value: ' master ' });
assert.equal(p.buildPromptResult('sudo', { value: '' }), null);
assert.equal(p.buildPromptResult('sudo', {}), null);

// Secrets and codes are trimmed, and an empty one is not an answer.
assert.deepEqual(p.buildPromptResult('secret', { value: '  sk-abc  ' }), { value: 'sk-abc' });
assert.equal(p.buildPromptResult('secret', { value: '   ' }), null);
assert.deepEqual(p.buildPromptResult('vault.code', { value: ' 123456 ' }), { value: '123456' });
assert.equal(p.buildPromptResult('vault.code', { value: '' }), null);

// A saved login is JSON: the password keeps its spaces, the identifier is trimmed.
assert.deepEqual(
  p.buildPromptResult('vault.save_login', { identifier: '  me@example.com ', password: ' pass word ' }),
  { value: JSON.stringify({ identifier: 'me@example.com', password: ' pass word ' }) },
);
assert.deepEqual(
  p.buildPromptResult('vault.save_login', { password: 'only-pass' }),
  { value: JSON.stringify({ identifier: '', password: 'only-pass' }) },
);
// A login needs a password; an identifier alone is not enough.
assert.equal(p.buildPromptResult('vault.save_login', { identifier: 'me@example.com' }), null);
assert.equal(p.buildPromptResult('vault.save_login', { identifier: 'me@example.com', password: '' }), null);
'''


class PromptCardRulesTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the browser module")
    def test_rules(self):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT, str(DASHBOARD / "prompts.js")],
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)


class PromptCardWiringTest(unittest.TestCase):
    def setUp(self):
        self.app = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    def test_the_module_is_imported_and_both_card_shown_and_answered(self):
        self.assertIn('import * as promptCards from "./prompts.js";', self.app)
        request = self.app.split("function onServerRequest(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("promptCards.isPromptMethod(method)", request)
        self.assertIn("showPromptCard(id, method, params);", request)
        show = self.app.split("function showPromptCard(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("promptCards.describePrompt(method, params)", show)
        self.assertIn("rejectServerRequest(id, -32601", show)
        self.assertIn("setEmptyState(false);", show)
        self.assertIn("sealTurnForCard();", show)
        self.assertIn("state.cards.set(id, entry);", show)
        # A masked field can be revealed and hidden again.
        self.assertIn('input.type = shown ? "password" : "text";', show)
        self.assertIn('eye.textContent = shown ? "Show" : "Hide";', show)

    def test_an_app_level_sudo_install_ignores_the_chat_on_screen(self):
        frame = self.app.split("function onFrame(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('belongsToView(params) || frame.method === "display.install.sudo"', frame)
        # Another chat's prompt still says why the agent paused.
        self.assertIn("promptCards.isPromptMethod(frame.method)", frame)
        self.assertIn('setStatus("Waiting for your answer in another chat");', frame)

    def test_a_withdrawn_or_steered_prompt_is_closed_with_an_empty_answer(self):
        cancel = self.app.split('case "request.cancel": {', 1)[1].split("case ", 1)[0]
        self.assertIn("promptCards.isPromptMethod(card.method)", cancel)
        self.assertIn('resolvePromptCard(card, "cancelled")', cancel)
        close = self.app.split("function closeOpenCards(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("promptCards.isPromptMethod(card.method)", close)
        self.assertIn("promptCards.buildPromptResult(card.method, null)", close)
        self.assertIn('resolvePromptCard(card, "sent_instead")', close)

    def test_values_are_cleared_on_answer_and_the_fields_leave_the_card(self):
        show = self.app.split("function showPromptCard(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("for (const item of inputs) item.input.value = \"\";", show)
        self.assertIn("answerServerRequest(id, result);", show)
        self.assertIn("promptCards.buildPromptResult(method, null)", show)
        resolve = self.app.split("function resolvePromptCard(", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn('entry.el.classList.add("resolved")', resolve)
        self.assertIn('querySelector(".prompt-fields")', resolve)
        self.assertIn('querySelector(".actions")', resolve)
        self.assertIn("spec.sentOutcome", resolve)
        self.assertIn("spec.sentInsteadOutcome", resolve)

    def test_service_worker_precaches_the_module(self):
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"prompts.js"', sw.split("const CORE = [", 1)[1].split("];", 1)[0])


if __name__ == "__main__":
    unittest.main()
