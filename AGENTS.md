# Contributor constraints

This repository is a **Hermes plugin**. These rules are not style preferences; they are what keeps
the plugin installable, replaceable and honest. Read them before changing anything.

## 1. Plugin only — never Hermes core

- Do not edit, patch, monkeypatch, wrap or `setattr` anything in the Hermes source tree, the installed
  runtime, `sys.modules`, or a registry owned by Hermes. Use documented plugin surfaces:
  `register_hook`, `register_auxiliary_task`, `register_platform`, the dashboard `router`, and the
  documented helpers those paths are allowed to call.
- If a hook or helper you need is genuinely missing, open an issue upstream. Do not add a private
  seam here and hope it survives an upgrade.
- The plugin must load through Hermes' own discovery (`hermes plugins doctor`) with no changes to the
  Hermes checkout.

## 2. The package is immutable at runtime

- The plugin directory is replaceable code and bundled defaults. Nothing at runtime may write into
  it: no settings, no keys, no logs, no caches, no generated files.
- Settings live in `$HERMES_HOME/hermes-mini/config.yaml`, your picture in
  `$HERMES_HOME/hermes-mini/assets/`, and state in `$HERMES_HOME/data/hermes-mini/`.
- The one Hermes-owned configuration file the plugin may write is `$HERMES_HOME/config.yaml`,
  through Hermes' documented config load/save API, and only to record
  `platforms.hermes-mini.home_channel`; in that same write it marks the platform enabled if it has
  no `enabled` key. It writes the home channel once, only when none is present, and touches nothing
  else there.
- Resolve paths per call through `mini_core.hermes_home()` (which uses Hermes' own resolver). Never
  hard-code `~/.hermes`, `/root/...`, the current working directory, or a profile name.
- A test asserts the package is byte-identical after normal operation with the directory read-only.
  Keep it passing.

## 3. Scoped identity and data

- The agent name follows: the selected bot's title (default profile first, then the serving
  profile), then the profile's display name, then a named profile id, then `Hermes`. The generic
  `default`/`custom` profile names are never shown as a person's agent name.
- Saving a name or picture must never rename a Hermes bot or profile, and must never touch any file
  Hermes owns — the one exception is the delivery default in section 2.
- Everything is per profile. A request served for another profile must read that profile's settings,
  or nothing at all — never another profile's.

## 4. No secrets, ever

- Never read `.env`, `auth.json`, private keys, or any credential file directly, and never print or
  log one.
- Secrets come from Hermes' credential store / environment through the supported seams, and the
  browser never receives a secret value.
- Push keys are generated **only** when a person explicitly turns notifications on. Importing a
  module, reading a public key, or probing a capability must not create a key.

## 5. Network and external effects

- Tests must be offline and mocked. No test may spend money, register a push subscription, send a
  message, or change an account.
- The dictation route delegates to Hermes' configured provider; it may not hard-code a provider URL
  or read a provider key itself.
- A push endpoint is accepted only over HTTPS and only for known push services.

## 6. UI: plain JavaScript, no build step

- Keep the app a set of ES modules and plain CSS loaded directly by the browser. No bundler, no
  framework, no generated build output checked in.
- The optional computer viewer is an internal module. Import it lazily; the app shell and the
  service worker's core install must succeed without it.
- Preserve accessibility: labels on controls, live regions for status, keyboard support, and focus
  management in dialogs.
- Text a person reads uses the agent's own name or the product name `Hermes Mini`; internal
  identifiers, storage keys and routes are separate and may differ.

## 7. Documentation and metadata

- Don't add invented URLs, owners, build badges or repository names. If something is not hosted
  somewhere real, say nothing about where it is hosted.
- Describe tested behaviour as tested and untested behaviour as untested. The README and CHANGELOG
  keep that list current.
- Keep third-party attribution intact: add a notice entry whenever you bundle a library, and keep the
  original license text beside it.

## 8. Testing

Run the suite exactly as [CONTRIBUTING.md](CONTRIBUTING.md) describes, against a disposable
`HERMES_HOME`. A change is not done until:

```bash
python3 -m unittest discover -s tests -t .          # whole suite
hermes plugins doctor . --ci                        # real plugin contract
hermes plugins validate .                           # catalog admission
```

all pass, and `node --check` is clean for every changed `.js` file.
