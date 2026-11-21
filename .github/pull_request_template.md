## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## Checklist

See [CONTRIBUTING.md](https://github.com/ieatcode4breakfast/hermes-mini/blob/main/CONTRIBUTING.md#what-a-good-change-includes) for the reasoning behind each item.

- [ ] A test that would fail without this change
- [ ] No personal material (names, domains, avatars or installation paths that belong to one person)
- [ ] No writes into the plugin package; anything persisted lives under `$HERMES_HOME`
- [ ] No new dependency (except optional lazy imports that degrade to a hidden control), and no build step
- [ ] Docs updated (`README.md` for visible behaviour, `CHANGELOG.md` for tested/untested status)
- [ ] `HERMES_HOME="$(mktemp -d)" python3 -m unittest discover -s tests -t .` passes
- [ ] `hermes plugins doctor . --ci` passes
- [ ] `hermes plugins validate .` passes
