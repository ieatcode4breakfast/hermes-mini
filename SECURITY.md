# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue or pull request.

- Use the repository host's private vulnerability reporting (GitHub's "Report a vulnerability" on
  the Security tab) if it is available for this project.
- If it is not, contact the maintainer through the same channel by which you obtained this project,
  and include "SECURITY" in the subject.

There is no monitored security email address to publish here, and none is invented. A dedicated
contact will be listed when one exists.

Please include:

- the affected file or route, and the version or commit,
- what an attacker can do, and what they need to start (a dashboard session? a push subscription?),
- steps to reproduce, and any proof-of-concept you are comfortable sharing.

You will get an acknowledgement, an assessment, and a coordinated-disclosure plan. Please give a
reasonable window to ship a fix before publishing details.

## Supported versions

The project is pre-1.0 (`0.1.x`). Fixes go to the latest release only, and the current Hermes tested
version is named in `README.md`. An older Hermes may lack the plugin hooks or routes this app builds
on; that is a compatibility problem, not a security one.

## Security model (what this project assumes)

Hermes Mini is a **client for one Hermes install**. It does not add an authentication system of its
own and does not weaken the one Hermes has.

- **Every app route is mounted under Hermes' authenticated `/api`.** The dashboard's own session
  cookie (or the OAuth/reverse-proxy gate the operator configured) protects
  `/api/plugins/hermes-mini/**` exactly as it protects the rest of `/api`. A request without a valid
  Hermes session is refused by Hermes before it reaches this plugin.
- **The plugin backend routes are mounted by Hermes only for an enabled plugin**, and Hermes
  re-checks that on every request.
- **The app never receives a secret.** No API key, token or credential value is sent to the browser;
  capabilities are reported as booleans only.
- **Push is opt-in and constrained.** The VAPID key is generated only when a person turns
  notifications on. Subscription endpoints must be HTTPS and must belong to a known push service
  (FCM, Mozilla, Apple, Windows); this prevents the route being used to POST to arbitrary hosts.
  Notification payloads are encrypted to the subscription's own keys.
- **Desktops are authorized by Hermes.** The computer viewer uses Hermes' own display WebSocket
  (single-use ticket per attach) and control lease. Clipboard reads and writes are refused unless
  the caller currently holds control (`tools.bot_desktop.lease.human_holds`). Watchers cannot read or
  set the holder's clipboard.
- **Uploads are validated by content, not by filename.** Profile pictures are accepted only if their
  bytes decode as PNG/JPEG/WebP within size and dimension limits. The stored filename is generated
  server-side, from a fixed alphabet, inside the assets directory. SVG and other active formats are
  refused, so an uploaded "image" cannot become a script.
- **The package is not writable at runtime.** Settings, pictures and state live outside the plugin
  directory, so a compromised app cannot rewrite its own code. A guard also blocks an agent turn
  running inside an app chat from writing to the plugin directory.
- **Path handling is resolved, not concatenated.** A request path may not escape the assets
  directory, and no absolute or `..` file path from a client is trusted.

## Out of scope

- Misconfiguration of Hermes itself (an open dashboard with no auth on a public interface). Secure
  the dashboard — bind it to loopback or put it behind your own authentication — before exposing it.
- Access a person already has through their own authenticated dashboard session. The app is that
  session; it does not intend to separate one authenticated dashboard user from another.
- Denial of service by the person who controls the host or the Hermes process.
- Vulnerabilities in Hermes itself or in a bundled third-party library. Report those upstream (see
  `THIRD_PARTY_NOTICES.md` for the libraries and versions).

## Handling secrets

If you believe a secret was exposed in this repository, treat it as compromised, rotate it, and
report it privately. The project's contribution rules forbid reading `.env`, `auth.json` or private
keys, and forbid logging their values.
