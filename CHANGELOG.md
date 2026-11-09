# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Scheduled job results can now be delivered into the app: `hermes-mini:main`, a side chat by id or
  unique name, or bare `hermes-mini`; each result is stored as a message and pushes a notification.
- The plugin records its main chat as the platform's default delivery target the first time the app
  loads, so bare `hermes-mini` works without setup.
- App chats receive a system-prompt section (`hermes-mini.app`) describing the app, its chats,
  scheduled-job delivery and image handling; other surfaces do not.

### Changed

- App chats now receive a separate style section: the point first, no code or file paths, no jargon
  unless explicitly asked, and then only the smallest piece that answers the question.
- The app instructions now tell the agent to use a session id for long-lived jobs and that a missing
  or renamed chat falls back to the main chat.
- App chats now ship with the acknowledgment rule built in: the agent acknowledges a new message
  and says in one line what happens next before starting work. An optional app-instructions file is
  appended to the rule instead of replacing it.
- Long app turns now ask the agent for a short progress update every four minutes, or every ten tool
  calls, so the person watching the app sees what is happening.
- The Computer view hides the "in control" label while the desktop is stopped; only Start Screen
  remains.
- Inbox and notification deep links now wait for an in-progress chat switch and reload the newest
  history page before searching, so a reply that just finished on screen is found by its stored row
  id. Notification text matching also accepts the pushed opening after a tool preamble.
- Desktop: with the computer open, the chats column, active chat and computer stay visible together
  only while the chat can be at least 600px wide and the computer at least 420px. Dragging the
  computer wider (or shrinking the window) hides the chats column; the chat expands into its place
  and the seam stays put. Dragging back right brings the column back the same way. The active chat
  keeps its 820px readable column: below that width it uses the full pane, above it the text centres
  with equal margins.
- New default artwork: the Hermes Mini portrait is the app icon, the browser tab icon, and the
  fallback profile picture when the Hermes profile has no picture of its own.
- The browser tab title shows the Hermes bot name instead of the product name.
- Removed the first-run welcome sheet and the settings editor. The app now always shows the Hermes
  bot name — the default profile's bot title first, then the serving profile's — with `Hermes` only
  when no name exists. No name or picture is stored by the app. The app now falls back to the
  bot's own profile picture when no picture was uploaded through it.

### Fixed

- Scheduled-job delivery now registers with the gateway; a stray package-path import had skipped the
  platform registration, so job results had no destination.
- Chat-name delivery matches case-insensitively when the name is unique, never delivers to an
  archived chat by id, and falls back to the main chat for a missing, renamed, archived or ambiguous
  target.
- The home chat is now the id the app recorded, not whichever session carries the `Hermes Mini`
  title. A terminal, desktop or Discord chat that takes the title can no longer capture the main
  chat; resetting the main chat records the replacement id.

## [0.1.0] — first release

The first standalone release of Hermes Mini: a single Hermes plugin that serves a mobile-first chat
app, with settings and data kept outside the package.

### Added

- **App shell**: multiple chats, a main chat, new chat, rename, pin with a shared manual order,
  delete, and reset of the main chat, over Hermes' own authenticated `/api/ws` and REST routes.
- **Inbox**: every agent message across the app's chats, newest first, with unread tracking.
- **To-dos**: one shared list with one level of nesting, drag to sort, and clear-finished.
- **Live streaming** with a quiet narration line (through Hermes' auxiliary model slots) and
  tool-step progress, plus steering while a reply runs.
- **Approvals and questions** answered in the app.
- **Markdown** rendering (sanitised) with syntax highlighting; attachments, long-paste collapsing,
  edit-and-resend and branching.
- **Dictation** through Hermes' configured speech-to-text provider. Recording UI, insert-at-caret,
  countdown, cancel and send behaviour are preserved; the route delegates to the provider who is
  actually configured instead of calling a fixed service.
- **Web Push** for approvals, questions and finished replies, with per-chat mute. The VAPID key is
  generated only on explicit opt-in; only known HTTPS push services are accepted as endpoints.
- **Computer view** bundled from the former separate desktop plugin: a phone-friendly noVNC viewer
  with take-over, hand-back, trackpad and clipboard (text and images), authorized by Hermes' display
  tickets and control lease. Loaded lazily; the app shell installs without it.
- **First-run identity**: the app prefills the agent name from the selected bot's title, the
  profile's display name, a named profile id, or `Mini`, and requires the user to confirm it and
  upload their own picture. Nothing is written before an explicit save.
- **External configuration and state**: `$HERMES_HOME/hermes-mini/config.yaml`,
  `$HERMES_HOME/hermes-mini/assets/`, and `$HERMES_HOME/data/hermes-mini/`, resolved per request
  for the active profile.
- **Capability route**: booleans only, authenticated, so the page can hide a control that would not
  work without ever exposing a key, path or setting.
- A scheduled-job delivery destination (`hermes-mini`) that stores job output in the app's main chat
  and notifies.
- Tests (`tests/`), native plugin checks, and this documentation set.

### Changed

- **Product identity.** The app is **Hermes Mini** (title, bookmark, install name, notifications when
  no agent name is set). The agent's own name and picture are the user's choice, separate from the
  product name. No personal name, avatar, home label or domain ships in the app.
- **No cross-plugin dependency.** The previous sibling computer plugin is internal, and the toast
  helper is local, so one plugin is all a user installs.
- **Portable paths.** Every path is resolved through Hermes' home helper. The gateway restart uses a
  resolved Hermes executable and the resolved home instead of a fixed user path.
- **Guarded optional surfaces.** Each of push, dictation and the computer is hidden only on a
  definite "no", and a failed probe keeps the control rather than hiding something that might work.

### Fixed

- A non-reentrant lock in the push store could deadlock when generating the VAPID key; it is now
  reentrant.
- The push key route no longer creates a key on read; only the explicit opt-in does.

### Verified

Checked against a real Hermes v0.23.0 runtime (`2bd378ed1b8d`):

- `hermes plugins doctor . --ci` passes (real discovery, manifest parse, `register(ctx)`).
- `hermes plugins validate .` passes (static checks, isolated capability probe, no core override).
- The full test suite passes against a disposable `HERMES_HOME`, including the app routes under
  FastAPI, settings/identity/avatar validation, push opt-in and endpoint gating, dictation
  delegation with a mocked provider, hook scoping, the self-edit guard, and the browser module graph
  and service-worker asset list.

### Not verified in this release

These need real services or devices and are called out rather than claimed:

- A live Bot Desktop session through the computer viewer (viewing, take-over/hand-back, clipboard).
- A real Web Push delivery to a phone.
- A real speech-to-text transcription (the delegation path is tested with a mocked provider).
- Push approval buttons resolving a genuinely pending gateway approval.
- The app's appearance in each specific browser, and one specific mobile OS's install prompt.
- Behaviour on Hermes versions other than the tested one.

### Known limitations

- The app runs inside an authenticated Hermes dashboard session; it does not add its own login and
  relies on Hermes to gate `/api`, as documented in `SECURITY.md`.
- Desktop packages, STT credentials and push libraries are external prerequisites and are not
  installed by this plugin.
