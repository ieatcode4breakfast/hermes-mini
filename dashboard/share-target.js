// Android's share sheet (Web Share Target). The installed app is listed when someone shares text, a link, pictures or
// files (pwa.json share_target). Android posts the share to share-target inside the app's scope; the service worker
// (sw.js receiveShare) keeps it in the SHARE_CACHE cache and opens the app with ?shared=1, and the app takes it from
// there into the message box (app.js receiveShared). Nothing reaches the server until the person sends the message.

export const SHARE_CACHE = "hermes-mini-share"; // never "hermes-mini-v…": sw.js activate deletes those
export const SHARE_PARAM = "shared";
export const SHARE_MAX_AGE_MS = 60 * 60 * 1000; // a share not picked up within the hour is dropped

// The words a share brings: its title, text and link, one per line, leaving out any that repeats another (a browser
// sends the page title plus the link; many apps put the link inside the text too).
export function sharedText({ title = "", text = "", url = "" } = {}) {
  const parts = [title, text, url].map((part) => String(part || "").trim()).filter(Boolean);
  const kept = [];
  for (const part of parts) {
    if (kept.some((other) => other.includes(part))) continue;
    for (let i = kept.length - 1; i >= 0; i -= 1) if (part.includes(kept[i])) kept.splice(i, 1);
    kept.push(part);
  }
  return kept.join("\n");
}

// The share the service worker kept, as { text, files }, removed from the cache as it is taken. null when there is none
// or it is older than SHARE_MAX_AGE_MS.
export async function takeShared(cacheStorage = globalThis.caches, now = Date.now()) {
  if (!cacheStorage) return null;
  const cache = await cacheStorage.open(SHARE_CACHE);
  const keys = await cache.keys();
  const metaKey = keys.find((request) => new URL(request.url).pathname.endsWith("/__share/meta"));
  let meta = null;
  try {
    if (metaKey) meta = await (await cache.match(metaKey)).json();
  } catch {
    meta = null;
  }
  const files = [];
  if (meta && now - Number(meta.at || 0) <= SHARE_MAX_AGE_MS) {
    for (const entry of Array.isArray(meta.files) ? meta.files : []) {
      const hit = await cache.match(entry.key);
      if (!hit) continue;
      const blob = await hit.blob();
      files.push(new File([blob], String(entry.name || "shared"), {
        type: String(entry.type || blob.type || ""),
        lastModified: Number(entry.lastModified) || now,
      }));
    }
  } else {
    meta = null;
  }
  await Promise.all(keys.map((request) => cache.delete(request)));
  if (!meta) return null;
  const text = sharedText(meta);
  return text || files.length ? { text, files } : null;
}
