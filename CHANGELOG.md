# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Edit profile: the first button in the Tools tray opens a card to change her name and picture. It saves through
  Hermes's own profile methods (`profiles.set_asset`, and `profiles.configure` as a compare-and-swap that keeps the
  profile's other display fields), so Hermes and every client that asks it see the change. A picture uploaded
  through the app's old setup is dropped once a new one is saved. Hermes's desktop app keeps its own copy of a
  picture it has already shown, so it shows the old one until the picture is picked there too.
- The Inbox still opens from the agent's picture or name, with the unread count on the picture. On a phone it
  opens as a full page, like the To-do and Schedules pages, with a Back button.
- Artifacts: a new row under Schedules in the chats panel lists the pictures, files and links the agent produced
  in the app's chats (new `artifacts.js`, `artifact_index.py`, and a read-only `GET /artifacts` route). Tabs, search,
  a picture grid with the full-screen viewer, file downloads, Open chat and Copy path/link. Links count only when the
  agent wrote them in a reply; command output adds pictures and documents but not links, tool state or logs. A local
  file that no longer exists is left out, and each path or link is listed once, from the chat where it first
  appeared. The extraction rules follow Hermes's desktop app, made stricter. Needs a dashboard restart to load.
- Schedules is a row directly under the main chat in the chats panel; its clock button left the Tools tray, which
  now holds Edit profile, Computer and To-do.
- Friendly model names: the model chip, the model sheet, the picker and the "Switched to" line read
  "DeepSeek v4.1 Flash" instead of `deepseek-v4.1-flash` (new `model-name.js`, following Hermes's desktop app).
  The picker search matches the name or the id, and the id is still what is sent.
- Inline prompt cards (new `prompts.js`) for passwords, secrets, and vault requests (`sudo`,
  `display.install.sudo`, `secret`, `vault.unlock_prompt`, `vault.save_login`, and `vault.code`). Each card masks
  secret inputs with a Show/Hide toggle, offers Skip, answers over JSON-RPC without putting values in chat
  history, and skips cleanly if you send a message instead.
- A "connect an app" card for Hermes' `manage_connections` tool: each app with its state, Open (the sign-in link),
  Allow (a local install or enable) and Skip, plus Done to stop waiting. It updates as Hermes reports progress and
  comes back after a reload. Before, the tool waited for a card the app never showed, so the reply hung for up to
  ten minutes. Credentials an install asks for still have to be entered in Hermes' desktop app.

### Changed

- Question sets: Skip skips only the question on screen (the agent is told that one was skipped) instead of
  closing the whole set. Back reopens the previous question with its answer marked, and a set of two or more
  ends on a review step listing every answer with Change; the last answer is only sent on Submit, so any answer
  can be changed until then. A single question still sends at once. Front end only (new `clarify.js`).
- A reply with tool rounds is drawn live the way a reload draws it: text written before a tool call becomes its own
  bubble, and commentary Hermes sends beside tool calls without streaming it (`message.interim`) now appears live
  instead of only after a reload.
- "Pick any that apply" questions take several answers: choices toggle, typed text is one more item, and Next (or
  Send) sends the list.
- Dictation adds the spaces a keyboard would: before the dictated text when the text before the cursor needs one, and
  after it so typing or dictating again just continues.
- Long pauses for compaction ("Summarizing the earlier conversation…") or a resumed turn ("Resuming interrupted
  turn…") show in the narration line.

### Fixed

- A passage no longer appears twice in a reply when Hermes re-sends part of it (a retried model call). The app
  uses the turn, segment and offset Hermes stamps on every streamed chunk and keeps only text it has not shown.
- Reloading mid-reply no longer cuts the reply off: the text streamed so far comes back in one bubble and the rest
  continues in it.
- A chat whose session Hermes closed (idle timeout, eviction) reopens by itself instead of showing typing dots
  forever and failing every send.
- An approval Hermes withdraws (`approval.cancelled`) closes its card instead of leaving buttons that error.
- A hidden diagnostic turn is no longer drawn for a moment and then gone after a reload.
- Old chats no longer show internal `[System: …]` rows or Discord routing notes as your own message, matching
  Hermes' own history view.
- A password or secret card no longer says it was sent when the connection dropped as you tapped Submit; it stays
  open and says it was not sent.
- A message that failed to send no longer stays in the chat looking sent; its text is back in the box.
- A reply that starts "The connection to …" (about a database, say) is no longer replaced with the "could not finish
  this reply" notice; only Hermes' own two connection-failure wordings are. Browser and Python copies alike.
- A turn that fails with no reply text now says so in plain words instead of leaving the message unanswered.
- A scheduled-job result delivered to a chat other than the main chat appears while that chat is open, not only
  after a reload.

## [0.2.1] — 2026-11-16

### Added

- A test that checks every piece of Hermes the plugin uses (imports, attributes read from Hermes modules,
  declared hooks, `ctx` calls) still exists in the Hermes it runs against. The plugin's Hermes calls fail
  soft, so without it a Hermes update that removed one would only show as a quietly missing feature.
- Restart lines in the main chat: "<agent> is restarting · 8:41 PM" when the gateway stops and "<agent> is back ·
  8:41 PM" when it starts, as small centred lines between the messages. A restart from the app's Restart button writes
  its "restarting" line before anything stops, so it shows at once; a restart from elsewhere shows when the chat is next
  opened. The lines are not chat messages: the model never sees them and they reach neither the Inbox nor a
  notification (new `GET /gateway-events`; stored in `gateway-events.json` in the plugin's data folder). Needs a
  dashboard and a gateway restart.

### Changed

- With the computer view open beside the chat, the round buttons on the right (Tools, Schedules, Computer, To-do)
  sit in the window's top-right corner, over the computer pane, instead of between the chat and the computer.
- Uses Hermes' public plugin API in four more places, so fewer parts of the plugin can break on a Hermes update:
  the narration line goes through `agent.plugin_llm` on the plugin's own auxiliary task (now set to low reasoning
  there, since the call carries none), the chat a hook call belongs to falls back to the session identity
  (`gateway.session_context.get_session_env`), the profile name comes from `hermes_constants.profile_name_for_home`,
  and settings files use `hermes_yaml.safe_load` / `safe_dump`. Nothing changes in the app. Needs a dashboard and a
  gateway restart.

## [0.2.0] — 2026-11-15

### Added

- Screenshots: a gallery in the README (phone and desktop, dark and light, sample data) with a short
  demo clip, from `docs/media/`, which also holds a 1280x640 banner for the plugin catalog.
- Inline audio player. An audio file a reply attaches with `MEDIA:` (mp3, m4a, aac, ogg, opus, wav, flac)
  shows as a voice-note pill: play/pause, a waveform you tap or drag to seek, the time, and download.
  The waveform and length come from a new `GET /audio-meta` route (decoded with ffmpeg, from PATH or
  Hermes' own tools directory, and cached per file), so they draw before anything loads; the sound is
  fetched on the first play, seek or download, and that one copy is shared by every player for the
  same file while the page is open (the three most recent files are kept). When the player cannot work (no ffmpeg, a file ffmpeg cannot read, a format
  the browser cannot play) the card falls back to the plain download card. Needs a dashboard restart.
- Schedules panel. A clock button lists the agent's scheduled jobs (read from Hermes' cron list on each
  open): the job's name, when it runs in plain words ("Every day at 7:45 am", "Weekdays at 1:00 pm",
  "Every 30 minutes") and when it runs next, running jobs first and paused ones last. Each row's ⋮ menu
  (also a right click, or a long press) offers Add to message, Pause/Resume and Delete (which asks
  first); pause, resume and delete go through Hermes' own cron routes.
- Add to message puts the schedule into the draft at the cursor as an inline pill (a clock and the
  name); Backspace removes it whole. The agent receives `[Schedule: <name> · job <id>]` in its place,
  and the sent bubble and history draw that as the same pill.
- Tools tray. A hammer-and-screwdriver button at the top of the right column folds the Schedules,
  Computer and To-do buttons up into it and slides them back out, staggered; it is tinted and its icon
  turns while they are out. Folded by default, remembered per device; folded, it carries the open to-do
  count.
- The quiet line that says what the agent is doing now names skill work: "Reading a skill…" when
  it opens one, "Looking through your skills…" when it lists them, and "Updating skills…" when it
  changes one.
- Inbox messages can be marked read or unread without opening them. On a phone, swipe a message
  right: the strip it uncovers says "Mark read" (red) or "Mark unread" (blue), fades to the full
  colour once letting go would act, and the phone gives a short buzz. With a mouse, hovering a message shows an
  envelope button at its right edge that does the same. Marking a message unread works for anything,
  including messages under "Mark all as read"; the server keeps those in an `unread` list in
  `inbox-read.json`. A message marked unread by hand stays unread until it is marked read by hand:
  tapping it in the Inbox, the envelope button, or "Mark all as read". Seeing it in the chat does not
  clear it.
- Mark unread on a reply, from its action row in the chat or its long-press menu. The reply comes
  back unread in the Inbox, and the button then reads Mark read, which clears the mark again. The
  chat asks a new `GET /inbox/state` route for those few messages, so the button always says what
  the Inbox shows. Needs a dashboard restart.
- Model and provider picker. A tab on the input box's top edge shows the chat's model and
  reasoning level; it opens a sheet listing Hermes's connected providers and their models (search,
  prices where Hermes has them), a five-bar reasoning level meter (tap or drag; none lit is Off) and
  fast mode where the model supports it. A pick
  switches the chat and becomes the default for new chats. A "Providers +" button opens a screen that lists every provider
  Hermes supports, with search, and saves or updates an API key through Hermes; sign-in providers show
  Hermes's own setup note. Everything goes through Hermes's own gateway methods; the app keeps no model
  state. A model switch shows in the chat as a muted line.
- The picture viewer has a back button and a download button, and slides between pictures like a
  carousel. Pinch and double-tap zoom.
- The Inbox shows the chat list's home icon on main-chat messages.
- Replies place local `MEDIA:` pictures inline and other files as download cards; the card fetches
  the file only when tapped. The app prompt tells the agent how to attach files this way.
- Scheduled job results can now be delivered into the app: `hermes-mini:main`, a side chat by id or
  unique name, or bare `hermes-mini`; each result is stored as a message and pushes a notification.
- The plugin records its main chat as the platform's default delivery target the first time the app
  loads, so bare `hermes-mini` works without setup.
- App chats receive a system-prompt section (`hermes-mini.app`) describing the app, its chats,
  scheduled-job delivery and image handling; other surfaces do not.

### Changed

- Two reads of Hermes' session store now go through SessionDB's public methods (`get_messages`,
  `search_sessions`) instead of its private query helpers, as the plugin catalog asks. A scheduled job
  delivered to a chat by a differently-cased title now matches among the 1,000 most recent chats.
- On a computer, while the computer view is open, its button stays visible under Tools even with the tray folded.
- The chats panel has its own background shade (a touch darker than the page in light theme, a touch
  lighter in dark), so it reads as a separate column on a computer without a divider line.
- Menus, popup windows and toasts are now drawn in the browser's top layer (the Popover API, `popover="manual"`),
  so no z-index or parent stacking context can ever put one behind another element. This fixes the "+" attach
  menu being drawn behind the agent's picture in a new chat, and the same class of bug in the chat row menu,
  the message menu, the Schedules row menu, the rename and confirm dialogs, the model/provider sheet and toasts.
  They stack by open order, so a menu opened from inside a dialog or panel is above it, and a toast shown while
  a dialog is open is re-shown above it. Anything they were positioned against is measured on open and again on
  window or visual-viewport resize, and their look, open/close logic, Escape and Back handling, focus and
  animations are unchanged. The big side panels (chats, Inbox, To-do, Schedules) and the computer view stay in
  the page's own layering, which now uses one named z-index ladder instead of bare numbers. In a browser without
  the Popover API the old layered drawing is kept.
- To-dos: a new row ("Add item", or Enter in a row) is saved the moment it appears, blank or not,
  instead of when you leave it, and it can be dragged as soon as that save comes back, without
  tapping out first; what you type is saved when you leave the row. Escape or Backspace in a brand-new
  empty row still removes it. `POST /todos` now also returns the new row's `id` (the app falls back to
  finding the one new id when an older server leaves it out).
- To-dos on a touch screen: the press area of a row's drag grip now runs from the list's left edge up to
  the checkbox (53px instead of 40px), so a press anywhere left of the box starts the drag; a mouse keeps
  the old area and nothing moves on screen. On touch the checkbox is a handle too: press it and move to
  drag the row; a plain tap still ticks it. A dragged row now follows the finger from where it was
  pressed, instead of trailing it by however far the finger moved before the drag started. A drag begun
  on the box no longer cancels itself the moment it starts (the box's own touch capture handing over to
  the row was read as the browser taking the finger).
- README: says the app is tested thoroughly on Android but not yet on iPhone or iPad, and lists the known
  iPhone differences.
- README: the first install method is a prompt to paste into Hermes, which runs
  `hermes plugins install ieatcode4breakfast/hermes-mini --enable`, reports the app's address and then
  restarts the dashboard and gateway. The copy-and-enable steps follow as "Manual install".
- Providers +: a provider the app cannot connect gets a plain note instead of Hermes' terminal hint
  ("run `hermes model` to configure (oauth_external)"). One that signs in with an account (ChatGPT or
  Codex, Nous, xAI Grok OAuth, Qwen, MiniMax OAuth, AWS Bedrock, Vertex) says to run `hermes model` on the
  computer and pick it; the command is a chip that copies on tap. Custom endpoints (Hermes' generic
  "custom" entry and every `custom:<name>`) lose the key box, which Hermes' key save could never accept,
  and say where they are set up instead. Model picking is unchanged.
- The live narration line shimmers: a soft highlight slides across the text while the agent works,
  tuned separately for light and dark. With reduced motion it is plain text.
- A web picture (`https:`) that fails to load now shows its alt text in grey italics, like a local
  picture that could not be fetched, instead of the browser's broken-image icon.
- The computer viewer falls back to the name "Hermes", like the rest of the app, when no agent name is
  known (it said "Mini").
- Push: the VAPID subject is the app's push contact or public URL, else Hermes' configured public
  URL, else the reserved `.invalid` address. The unused request-origin parameter is gone.

- Scrollbars: on desktop the slim bars show only while the pointer is over their area; on phones
  Chrome's own bar is off until the area scrolls and goes again shortly after (it used to show as soon
  as a list opened and stay until the first scroll).
- The "Restarting" notice stays up until the app has reconnected to the new gateway, and its dots
  animate.
- The narration line says "Working…" while a shell command runs.
- Copying out of the computer reads the remote selection without xclip.
- New chat stays a local draft until its first message; empty chats are hidden from the list.
- Edit stays visible while the agent works; the attach button reads as disabled while dictating.
- A picture pasted into the chat field stays in the chat; Enter at the start of a to-do keeps its
  text and opens a new line below.
- The to-do panel stays over the docked computer, and the to-do drag press is steadier on phones.
- Motion across the app is smoother and quicker.
- Added app-scoped onboarding guidance and presentation filters for known introductions, routine
  gateway notices, command tips and canned failure instructions. Covers streaming, transcript
  display, inbox and push previews. Offline parity and integration tests exercise these paths;
  real phone/PWA and live gateway delivery verification still require a manual check.


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

- Inbox previews and notification text keep the characters markdown did not use for formatting:
  `column_total` no longer reads `columntotal`, and `2*3`, `~/notes`, `a > b`, `#42` and `a|b` come through
  as written. Bold, italics, strikethrough, code marks, headings, quotes, rules and table pipes are still
  removed. Needs a dashboard restart (Inbox) and a gateway restart (notifications).
- The computer view's background follows a theme change while it is open, instead of keeping the colour of
  the theme it opened in.
- The "+" attach menu opens over the agent's picture in a new chat instead of behind it.
- A login-protected dashboard no longer logs a failed WebSocket (`/api/ws?token=`) on every load: the app
  learns whether the dashboard is gated before it picks the ticket or the token, instead of after.
- On iPhone and iPad, tapping the message box no longer zooms the page in. Safari zooms into text under
  16px; the message box now uses 16px on Apple touch devices only, so Android is unchanged.
- `hermes plugins install` no longer stops on a "caution" verdict that asks to force the install. Hermes'
  scanner read a backtick lookahead in the bundled marked (`(?!` + backtick) as a skill's inline-shell
  snippet, its only high finding. Those lookarounds are now written with `\x60`, the same character, so
  the scan is clean (the remaining findings are informational) and the install goes through.
- Signing in from the app comes back to the app. Hermes' login link for a data request carries no
  return address, so after the login page Hermes landed on its own dashboard; the app now adds its own
  page as the return address whenever the link lacks one.
- On a phone, "Nothing scheduled" (and "Loading…") sits in the middle of the Schedules panel instead
  of at the bottom.
- Dictation started while the app is still opening is no longer cut off when the chat history loads.
  Startup is also quicker: the sign-in check, the connection and the agent's name now load at the same
  time instead of one after another.
- The model tab on the message box stays hidden until the app knows the current model, so it no
  longer flashes empty while the page opens.
- The Inbox and the model sheet now paint in front of the docked computer pane instead of under its
  right edge. Only the cards' stacking changed; the pane and the Inbox's photo and name keep their
  places.
- Scheduled job results no longer turn into one big message from you. When you reply right after
  job results, Hermes folds them and your reply into one stored message and drops the job label, so
  the app drew it all as your bubble and the job results left the Inbox. The app now looks up the
  originals Hermes keeps: the job results are drawn on the agent's side again, your reply as its own
  bubble, and the Inbox lists the job results again.
- Already-read replies no longer come back as unread in the Inbox. When Hermes compacts a long chat
  it writes the messages it keeps back out under new ids; the Inbox kept read state by id, so every
  compaction brought a batch of read replies back. A copy now counts as read when its original was
  (same chat, same Hermes message id).
- A reply that finishes while the app is in the background no longer marks its chat read; a chat
  only counts as read while the app is on screen.
- Tapping a notification after a while away no longer says "Message not found" for a message that
  is there. The app now checks that its connection is alive before reading the chat; a connection
  that died in the background left the reply looking unfinished, so the chat was not reloaded.
- Scheduled-job delivery now registers with the gateway; a stray package-path import had skipped the
  platform registration, so job results had no destination.
- Chat-name delivery matches case-insensitively when the name is unique, never delivers to an
  archived chat by id, and falls back to the main chat for a missing, renamed, archived or ambiguous
  target.
- The home chat is now the id the app recorded, not whichever session carries the `Hermes Mini`
  title. A terminal, desktop or Discord chat that takes the title can no longer capture the main
  chat; resetting the main chat records the replacement id.

### Removed

- `dashboard/computer/computer.css` and the computer viewer's standalone-page mode: no page in the
  plugin used them.

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
