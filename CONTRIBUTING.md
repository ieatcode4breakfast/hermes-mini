# Contributing to Hermes Mini

Thanks for taking a look. Hermes Mini is a single Hermes plugin with a plain-JavaScript web app, so
contributions are usually small and self-contained.

Please read [AGENTS.md](AGENTS.md) first. It documents the constraints that keep the plugin
replaceable and safe (plugin-only, external state, no secrets) — a pull request that breaks one of
those will not be merged even if the feature is nice.

## Setting up

You need a Hermes install to run the app for real, but not to run the tests.

```bash
git clone <this repository> hermes-mini
cd hermes-mini
```

For a manual run, put the folder where Hermes looks for plugins and enable it:

```bash
cp -r . "$HERMES_HOME/plugins/hermes-mini"
hermes plugins doctor "$HERMES_HOME/plugins/hermes-mini" --ci
hermes plugins enable hermes-mini
hermes dashboard     # then open /dashboard-plugins/hermes-mini/index.html
```

## Running the tests

The suite is standard-library `unittest` and does not need a browser or a network. **Always point it
at a disposable home**; it must never touch your real `~/.hermes`:

```bash
HERMES_HOME="$(mktemp -d)" python3 -m unittest discover -s tests -t .
```

Route tests need FastAPI (Hermes ships it). Where the managed venv is available, run the suite with
the same interpreter Hermes uses so those tests are not skipped:

```bash
HERMES_AGENT_ROOT=/path/to/hermes-agent \
HERMES_HOME="$(mktemp -d)" \
  "$PYTHON" -m unittest discover -s tests -t . -v
```

Also run the two native checks — they exercise the real plugin contract and are the ones that catch
a manifest or registration mistake:

```bash
hermes plugins doctor . --ci
hermes plugins validate .
```

Indentation is 4 spaces for Python and 2 for JavaScript, matching the existing files. Lint the
scripts you changed:

```bash
node --check dashboard/app.js   # and any other changed module
```

## What a good change includes

- **A test that would fail without it.** The suite covers paths, settings, validation, routes,
  push gates, dictation delegation, hook scoping and the browser module graph; add to the closest
  file. Tests should exercise behaviour, not mirror the implementation.
- **No new personal material.** No names, domains, avatars or installation paths that belong to one
  person. Product text uses "Hermes Mini"; user text uses the agent's own name.
- **No writes into the plugin package.** If you need to persist something, it belongs under
  `$HERMES_HOME` and must be resolved per call.
- **No new dependency** unless it is already provided by Hermes or is an optional, lazy import that
  degrades to a hidden control. Do not add a build step.
- **Updated docs.** If behaviour a person can see changes, update `README.md`; if the honest
  tested/untested status changes, update `CHANGELOG.md`.
- **Intact attribution.** If you bundle a library, add it to `THIRD_PARTY_NOTICES.md` and keep its
  license file.

## Style

- Keep the plain-ES-module architecture. No framework, no bundler, no generated files in git.
- Comment *why* a non-obvious rule exists, not what a line does.
- Keep accessibility intact: labelled controls, live regions for status, keyboard paths through
  dialogs.
- Fail safe: an optional integration that cannot load hides its control; it never breaks the app
  shell or a chat turn.

## Reporting bugs and security issues

- Bugs and feature ideas: open an issue with the Hermes version, what you expected, and what
  happened. If it involves one optional feature, say whether it was configured.
- Security problems: follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Commits

```
type: concise subject line

Optional body explaining the why.
```

Types: `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`.
