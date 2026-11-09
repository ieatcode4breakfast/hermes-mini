# Third-party notices

Hermes Mini's own code is MIT-licensed (see [LICENSE](LICENSE)). The browser app bundles the
following unmodified third-party builds. Their licenses and copyright notices apply to those files,
and each file keeps its own license header.

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
`dashboard/computer/vendor/novnc/LICENSE.txt` (MPL-2.0) and the pako license beside it; the file
manifest and version are in `dashboard/computer/vendor/novnc/VERSION.txt`.

## Notes on use

- No vendored file was modified other than being copied. If you re-vendor, copy the upstream build
  again and update the notice above and the SHA-256 list.
- MPL-2.0 applies file-by-file to the noVNC sources. Keeping those files separate and unmodified in
  `dashboard/computer/vendor/novnc/` satisfies its file-level copyleft; nothing in the rest of this
  project is derived from them.
- The MIT and BSD-3-Clause notices must travel with any redistribution that includes these files.
- `marked` is only used to parse markdown; all rendered HTML is sanitised with DOMPurify before it
  reaches the page.
