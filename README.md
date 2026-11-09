# Hermes Mini

A mobile-first chat app for your own [Hermes](https://hermes-agent.nousresearch.com/) agent.

Hermes Mini is a single Hermes plugin that serves a fast, installable web app for talking to your
agent from a phone, tablet or desktop: multiple chats, an inbox, to-dos, live progress lines,
steering, optional push notifications, dictation, and an optional bundled view of your agent's
desktop.

- **Product name**: Hermes Mini (the app's title, bookmark and install name).
- **Agent name**: the name your Hermes bot already has — the default profile's bot title first, then
  the serving profile's — with **Hermes** as the fallback when none is set.
- **One plugin**: settings and state live outside the plugin, so updating the code never touches them.

## Requirements

| | |
|---|---|
| Hermes Agent | **v0.23.0** tested (commit `2bd378ed1b8d`). The plugin uses documented plugin, dashboard and state APIs. |
| Python | Whatever Hermes runs (Hermes v0.23.0 ships Python 3.14 here; 3.11+ is expected to work). |
| Browser | A current Chrome, Safari, Firefox or Edge. The app is a plain ES-module page with no build step. |
| Optional | `cryptography` + `httpx` for push; `Pillow` for image dimension checks; a Hermes-configured speech-to-text provider for dictation; Hermes' Bot Desktop for the computer view. |

Nothing in this list is installed by the plugin. Optional pieces degrade to a hidden control, never
a broken app.

## Install

Hermes Mini is a directory plugin: `plugin.yaml` plus `register(ctx)` (hooks) plus a
`dashboard/` folder (the app page and its backend routes). Put the folder where Hermes looks for
user plugins and enable it:

```bash
cp -r hermes-mini "$HERMES_HOME/plugins/hermes-mini"
hermes plugins list                  # shows: hermes-mini  not enabled
hermes plugins enable hermes-mini    # shows: enabled
```

`$HERMES_HOME` is your Hermes home (usually `~/.hermes`; a profile home is
`~/.hermes/profiles/<name>`). This install path was verified end to end: a plain directory drop-in
is discovered by Hermes, reported as `not enabled`, then becomes `enabled` and is listed as a `user`
plugin.

Check that Hermes accepts it before enabling:

```bash
hermes plugins doctor "$HERMES_HOME/plugins/hermes-mini" --ci
hermes plugins validate "$HERMES_HOME/plugins/hermes-mini"
```

If your Hermes build supports installing from a local Git checkout, that also works and additionally
records install provenance:

```bash
git clone /path/to/hermes-mini /path/to/hermes-mini.git   # or use your own checkout
hermes plugins install file:///path/to/hermes-mini.git --no-enable
hermes plugins enable hermes-mini
```

This route needs a Git repository, so it does not apply to a plain copied folder (a project
downloaded without a `.git` directory).

Remove it with `hermes plugins remove hermes-mini`, or by deleting the directory. That removes the
code; your settings, picture and app data are left in place (see
[Settings, state and profiles](#settings-state-and-profiles)).

## Open the app

Hermes serves dashboard plugins from the dashboard process. Start it (this is the ordinary Hermes
dashboard, not something Hermes Mini adds):

```bash
hermes dashboard
```

Then open:

```
http://127.0.0.1:9119/dashboard-plugins/hermes-mini/index.html
```

Use `--host`/`--port` if you started the dashboard differently; the path after the origin is fixed
by the plugin's folder name. Hermes' dashboard authentication (its normal session cookie, or an
OAuth/reverse-proxy gate you have configured) protects the page and every `/api/plugins/hermes-mini/`
route. Bookmark it, or use your browser's "Install app" / "Add to Home Screen".

You do not need to open the default dashboard page first.

## First run

There is none. Open the app and it is ready to use: the header and composer take the name Hermes
already has for the bot — the default profile's bot title, then the serving profile's, then its
display name or a named profile id, and finally **Hermes**. The app never renames the agent, and it
stores no name or picture of its own.

If Hermes has no model configured yet, the chat says so and links to the Hermes docs; history,
to-dos and the inbox still work.

Opening the app, reading the page, and every capability probe are pure reads.

### Configure a model

Hermes Mini does not configure providers. Use Hermes itself, for example `hermes model` or the
dashboard's Config page. See the [Hermes documentation](https://hermes-agent.nousresearch.com/docs/).
Until a model is configured the chat shows a friendly message rather than failing.

## What's in it

- **Chats**: multiple conversations, a main chat, new chat, rename, pin (with a shared manual
  order), delete, reset of the main chat, and a read-only view of a chat that belongs to another
  source.
- **Inbox**: every agent message across the app's chats, newest first, with unread tracking.
- **To-dos**: one shared list, nesting one level, drag to sort, clear finished.
- **Live streaming**: replies appear as they arrive, with a short quiet narration line and
  tool-step progress. Narration uses Hermes' auxiliary model slots and stays silent if that is not
  configured.
- **Steering**: send while a reply is running to steer the current turn.
- **Approvals and questions**: answer them in the app; the same cards can be answered from a push
  notification.
- **Attachments**: photos, files and pasted text, with a collapsed view for long pastes.
- **Markdown**: GitHub-flavoured markdown with sanitised HTML and syntax highlighting.
- **Edit and branch**: edit and resend your message, or branch a conversation.
- **Dictation**: record and insert at the caret, through whatever speech-to-text provider Hermes is
  configured to use.
- **Notifications** (optional): Web Push for approvals, questions and finished replies, with
  per-chat mute.
- **Computer** (optional): a phone-friendly live view of your agent's desktop, with take-over,
  hand-back, a trackpad and clipboard, gated by Hermes' own display tickets and control lease.

## Optional features and how they degrade

| Feature | Needs | Without it |
|---|---|---|
| Dictation | An STT provider configured in Hermes; a browser that can record. | The microphone is hidden. The `/dictate` route also answers with a clear message. |
| Notifications | `cryptography` and `httpx` importable by Hermes, a browser with Push, and your click on the bell. | The bell is hidden. Chat is unaffected. |
| Computer | Hermes' Bot Desktop supported and installed on this host (`tools.bot_desktop`). | The computer button is hidden. Chat and to-dos still work. |
| Live narration | A Hermes auxiliary model (Hermes' `title_generation` inheritance). | The narration line is simply absent. |

A failed capability probe makes the app keep the control visible rather than hide something that
might work. The server always enforces the real rule: a disabled feature returns an error, it does
not quietly succeed.

## Settings, state and profiles

The plugin directory is replaceable code. Everything you change lives outside it, under the Hermes
home of the profile serving the request, resolved with Hermes' own helper at request time:

| Path | Contents |
|---|---|
| `$HERMES_HOME/hermes-mini/config.yaml` | Your agent name, home label, uploaded picture's filename, first-run completion, optional public URL and push contact. |
| `$HERMES_HOME/hermes-mini/assets/` | Your uploaded picture. |
| `$HERMES_HOME/data/hermes-mini/` | App state: to-dos, pin order, seen markers, inbox read state, app-chat registry, push key and subscriptions. |

`config.yaml` is written atomically with mode `0600`, and unknown keys are dropped. Everything is
per profile: a second Hermes profile gets its own name, picture and data, and one profile's app never
reads another's.

Every app chat carries a built-in turn rule: acknowledge the newest message and say in one line
what happens next before starting work. It rides along with every user message **in an app chat
only** (and its subagents), never in Discord, cron, or another channel.

An optional file at `$HERMES_HOME/data/hermes-mini/app-instructions.md` is appended to that rule.
Use it for extra operator instructions; the built-in acknowledgement stays.

During a long turn, the plugin also asks the agent for a short progress update every four minutes,
or every ten tool calls, so a phone user is not left watching a silent screen. It applies to app
chats only and skips delegated subagents.

## Push notifications

Turning notifications on is the only thing that creates the VAPID key pair, and it happens the first
time you press the bell and confirm. The key and your subscription stay in
`$HERMES_HOME/data/hermes-mini/push/`. Only known push services (FCM, Mozilla, Apple, Windows) are
accepted as subscription endpoints, and the request must be HTTPS.

The VAPID `sub` claim uses, in order: your configured push contact, your configured public URL,
Hermes' configured dashboard/gateway public URL, then the origin the request came from. No personal
domain is baked into the source.

## Computer view

The viewer is built into this plugin (`dashboard/computer/`), including its noVNC runtime under
`dashboard/computer/vendor/novnc/`. It loads only when you first tap the computer button; the app
shell and its service worker install without it. The viewer uses Hermes' own `/api/display/ws`
(display tickets and control leases) and the plugin's `/api/plugins/hermes-mini/computer/clipboard`
routes, which are limited to the person currently holding control.

Hermes Mini does not start a desktop, install desktop packages, or run one in the background. If
Bot Desktop is not set up, the button is hidden.

## Troubleshooting

- **The page 404s.** The dashboard must be the process serving it, and the folder must be named
  `hermes-mini`. Check `hermes plugins list` and that `dashboard/manifest.json` is present.
- **Everything 401s or redirects to a login.** That is Hermes' dashboard auth; sign in through the
  dashboard first.
- **"Not connected yet".** The WebSocket to the Hermes gateway is down. Check the gateway is running;
  the app retries on its own.
- **No microphone.** No STT provider is configured, or the browser cannot record. Configure STT in
  Hermes (see the Hermes docs), then reload.
- **No bell.** `cryptography`/`httpx` are missing from Hermes' environment, or the browser does not
  support Push.
- **No computer button.** Bot Desktop is unsupported or not installed on this host.
- **The name is `Hermes`.** No bot title, display name or named profile exists yet. Set a bot name
  in Hermes and the app picks it up on the next load.

## Verified, and not

Tested here against the real Hermes runtime: the plugin loads through Hermes' discovery and
`register(ctx)`; the manifest passes `hermes plugins doctor` and `hermes plugins validate`; every
app route in the suite; settings/identity/avatar validation; push key opt-in and endpoint gating;
dictation delegation to Hermes' provider with a mocked provider; the app-chat scoping and the
self-edit guard; the browser module graph and service-worker asset list.

Not verified here, and worth trying yourself: a real desktop session through Bot Desktop, a real push
delivery to a device, a real speech-to-text transcription, and the app's appearance in a specific
browser. Those require services and credentials this project does not ship. See
[CHANGELOG.md](CHANGELOG.md) for the honest status list.

## Documentation

- [AGENTS.md](AGENTS.md) — contributor constraints (plugin only, no core edits, external state).
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to run the tests and what a change should include.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — bundled libraries and their licenses.
- [CHANGELOG.md](CHANGELOG.md) — status and history.

## License

MIT for the original project code; see [LICENSE](LICENSE). Bundled third-party code keeps its own
license — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
