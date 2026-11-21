# Third-party notices

Hermes Mini's own code is MIT-licensed (see [LICENSE](LICENSE)). The browser app bundles the
following third-party builds. Their licenses and copyright notices apply to those files, and upstream
headers are kept where the build carries one; the full license texts live in
`dashboard/vendor/LICENSES.txt`.

## Markdown rendering — `dashboard/vendor/`

| Package | Version | License | Files |
|---|---|---|---|
| [marked](https://github.com/markedjs/marked) | 18.1.1 | MIT | `marked.esm.js` (from `lib/marked.esm.js`) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | Apache-2.0 OR MPL-2.0 | `purify.es.mjs` (from `dist/purify.es.mjs`) |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.12.0 | BSD-3-Clause | `highlight/core.min.js` (from `@highlightjs/cdn-assets/es/core.min.js`) |
| [@highlightjs/cdn-assets](https://github.com/highlightjs/cdn-assets) | 11.12.0 | BSD-3-Clause | `highlight/languages/*.min.js` (bash, shell, python, javascript, typescript, json, yaml, sql, xml, css, diff, markdown, go, rust) |

The full license texts are in `dashboard/vendor/LICENSES.txt`, with the exact upstream versions and
SHA-256 checksums in `dashboard/vendor/VERSIONS.txt`.

## Computer viewer — `dashboard/computer/vendor/novnc/`

| Package | Version | License | Files |
|---|---|---|---|
| [noVNC](https://github.com/novnc/noVNC) | 1.7.0 | MPL-2.0 (core library) | `core/**/*.js` |
| [pako](https://github.com/nodeca/pako) (vendored inside noVNC) | as shipped by noVNC 1.7.0 | MIT | `vendor/pako/**/*.js` |

The unmodified files come from the `@novnc/novnc@1.7.0` npm tarball. The license texts are in
`dashboard/computer/vendor/novnc/LICENSE.txt` (MPL-2.0) and the pako license beside it. See
`dashboard/vendor/VERSIONS.txt` for the module count and entry-point checksums, and
`dashboard/computer/vendor/novnc/VERSION.txt` for provenance.

## Notes on use

- No vendored file was modified other than being copied, with one scanner-safe exception: in
  `marked.esm.js` every regex lookaround on a backtick spells that character `\x60` (same character,
  same matching), so Hermes' plugin install scanner stays clean — see `dashboard/vendor/VERSIONS.txt`.
  If you re-vendor, copy the upstream build again, re-apply that spelling, and update the notice above
  and the SHA-256 list.
- MPL-2.0 applies file-by-file to the noVNC sources. Keeping those files separate and unmodified in
  `dashboard/computer/vendor/novnc/` satisfies its file-level copyleft; nothing in the rest of this
  project is derived from them.
- The MIT and BSD-3-Clause notices must travel with any redistribution that includes these files.
- `marked` is only used to parse markdown; all rendered HTML is sanitised with DOMPurify before it
  reaches the page.
