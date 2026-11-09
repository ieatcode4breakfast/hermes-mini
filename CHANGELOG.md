# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
