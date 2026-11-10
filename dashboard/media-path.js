// Local media paths in chat text: one definition for the Markdown renderer (raster images only), Hermes' native
// MEDIA: directive (pictures and files), and the app's media pass (the bottom grid skips a path already inline).
//
// Accepted: /absolute, ~/home-relative, file:///absolute, and the app's own MEDIA: marker (stripped). A picture
// needs a raster extension; a MEDIA: file may be any type. Relative paths are not resolved: the browser cannot
// know the agent's working directory. Anything else is rejected so no raw file URL is ever put in the page.

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
const UNSAFE = /[\0-\x1f"'<>]/;
const MAX_PATH = 4096;

export function localMediaPath(src) {
  let value = String(src || "").trim().replace(/^MEDIA:\s*/i, "");
  if (!value) return "";
  if (/^file:\/\//i.test(value)) {
    value = value.slice("file://".length);
    if (!value.startsWith("/") || value.startsWith("//")) return "";
  }
  if (value.startsWith("//") || (!value.startsWith("/") && !value.startsWith("~/"))) return "";
  try {
    value = decodeURIComponent(value);
  } catch {
    /* a literal % is not an escape; keep the path as written */
  }
  if (!value || value.length > MAX_PATH || UNSAFE.test(value)) return "";
  return value;
}

export function localImagePath(src) {
  const value = localMediaPath(src);
  return value && IMAGE_EXT.test(value) ? value : "";
}

// Hermes' native attachment directive: `MEDIA:<path>` marks where a file belongs. The desktop renderer
// replaces the tag in place; this parser gives the app the same spans so it can do the same. Quoted forms may
// contain spaces; a bare form sheds the sentence punctuation that follows it. Images stay pictures; every
// other deliverable is a file card.
const MEDIA_TAG = /\bMEDIA:\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([^\s"'`*<>]+))/gi;

export function mediaTags(text) {
  const out = [];
  for (const match of String(text || "").matchAll(MEDIA_TAG)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    let raw = quoted ?? match[4] ?? "";
    if (quoted === undefined) raw = raw.replace(/[.,;:!?)\]}]+$/, "");
    let path = localMediaPath(raw);
    if (!path && quoted === undefined) path = localMediaPath(raw.replace(/[*_]+$/, "")); // **MEDIA:/x.png**
    if (!path) continue;
    out.push({ start: match.index, end: match.index + match[0].length, path, kind: IMAGE_EXT.test(path) ? "image" : "file" });
  }
  return out;
}
