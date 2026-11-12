// Hermes Mini service worker: caches the app shell (same-scope static files only). Everything else,
// including /api/, /auth/, /login and the WebSocket, is never intercepted.
//
// The core shell is required: if any file in CORE is missing the whole install fails loudly, which is
// correct because those files are the app. The computer viewer and its noVNC runtime are OPTIONAL_CORE:
// each is precached on its own, and a failure there is ignored, so a desktop module that is absent can
// never fail the app install. They are fetched on demand the first time the viewer opens anyway.
const CACHE = "hermes-mini-v39";
const SCOPE_PATH = new URL("./", self.location.href).pathname;
// The app is served at /dashboard-plugins/hermes-mini/ but its API lives at /api/plugins/hermes-mini/
// (any reverse-proxy prefix in front of both is preserved). Same split app.js makes for PREFIX.
const API_BASE = (() => {
  const marker = "/dashboard-plugins/hermes-mini/";
  const at = SCOPE_PATH.indexOf(marker);
  return `${at > 0 ? SCOPE_PATH.slice(0, at) : ""}/api/plugins/hermes-mini/`;
})();
const CORE = [
  "index.html",
  "style.css",
  "app.js",
  "jobtext.js",
  "message-policy.js",
  "identity.js",
  "drawer.js",
  "confirm.js",
  "todo.js",
  "inbox.js",
  "toast.js",
  "md.js",
  "media-path.js",
  "model.js",
  "pwa.json",
  "favicon-64.png",
  "avatar-placeholder.png",
  "icon-192.png",
  "badge-96.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "vendor/marked.esm.js",
  "vendor/purify.es.mjs",
  "vendor/highlight/core.min.js",
  "vendor/highlight/languages/bash.min.js",
  "vendor/highlight/languages/shell.min.js",
  "vendor/highlight/languages/python.min.js",
  "vendor/highlight/languages/javascript.min.js",
  "vendor/highlight/languages/typescript.min.js",
  "vendor/highlight/languages/json.min.js",
  "vendor/highlight/languages/yaml.min.js",
  "vendor/highlight/languages/sql.min.js",
  "vendor/highlight/languages/xml.min.js",
  "vendor/highlight/languages/css.min.js",
  "vendor/highlight/languages/diff.min.js",
  "vendor/highlight/languages/markdown.min.js",
  "vendor/highlight/languages/go.min.js",
  "vendor/highlight/languages/rust.min.js",
];
// Optional desktop viewer. Every module rfb.js imports is listed so the viewer also opens offline, but
// these never block the core install.
const OPTIONAL_CORE = [
  "computer/screen.css",
  "computer/screen.js",
  "computer/trackpad.js",
  "computer/markup.js",
  "computer/vendor/novnc/core/base64.js",
  "computer/vendor/novnc/core/crypto/aes.js",
  "computer/vendor/novnc/core/crypto/bigint.js",
  "computer/vendor/novnc/core/crypto/crypto.js",
  "computer/vendor/novnc/core/crypto/des.js",
  "computer/vendor/novnc/core/crypto/dh.js",
  "computer/vendor/novnc/core/crypto/md5.js",
  "computer/vendor/novnc/core/crypto/rsa.js",
  "computer/vendor/novnc/core/decoders/copyrect.js",
  "computer/vendor/novnc/core/decoders/h264.js",
  "computer/vendor/novnc/core/decoders/hextile.js",
  "computer/vendor/novnc/core/decoders/jpeg.js",
  "computer/vendor/novnc/core/decoders/raw.js",
  "computer/vendor/novnc/core/decoders/rre.js",
  "computer/vendor/novnc/core/decoders/tight.js",
  "computer/vendor/novnc/core/decoders/tightpng.js",
  "computer/vendor/novnc/core/decoders/zlib.js",
  "computer/vendor/novnc/core/decoders/zrle.js",
  "computer/vendor/novnc/core/deflator.js",
  "computer/vendor/novnc/core/display.js",
  "computer/vendor/novnc/core/encodings.js",
  "computer/vendor/novnc/core/inflator.js",
  "computer/vendor/novnc/core/input/domkeytable.js",
  "computer/vendor/novnc/core/input/fixedkeys.js",
  "computer/vendor/novnc/core/input/gesturehandler.js",
  "computer/vendor/novnc/core/input/keyboard.js",
  "computer/vendor/novnc/core/input/keysym.js",
  "computer/vendor/novnc/core/input/keysymdef.js",
  "computer/vendor/novnc/core/input/util.js",
  "computer/vendor/novnc/core/input/vkeys.js",
  "computer/vendor/novnc/core/input/xtscancodes.js",
  "computer/vendor/novnc/core/ra2.js",
  "computer/vendor/novnc/core/rfb.js",
  "computer/vendor/novnc/core/util/browser.js",
  "computer/vendor/novnc/core/util/cursor.js",
  "computer/vendor/novnc/core/util/element.js",
  "computer/vendor/novnc/core/util/events.js",
  "computer/vendor/novnc/core/util/eventtarget.js",
  "computer/vendor/novnc/core/util/int.js",
  "computer/vendor/novnc/core/util/logging.js",
  "computer/vendor/novnc/core/util/strings.js",
  "computer/vendor/novnc/core/websock.js",
  "computer/vendor/novnc/vendor/pako/lib/utils/common.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/adler32.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/constants.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/crc32.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/deflate.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/gzheader.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/inffast.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/inflate.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/inftrees.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/messages.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/trees.js",
  "computer/vendor/novnc/vendor/pako/lib/zlib/zstream.js",
];
const SHELL_SET = new Set([...CORE, ...OPTIONAL_CORE]);

function requestFor(name) {
  // cache: "reload" bypasses the browser's HTTP cache, so a new version never precaches yesterday's files.
  return new Request(new URL(name, self.location.href).href, { cache: "reload" });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        // Core: all-or-nothing.
        await cache.addAll(CORE.map(requestFor));
        // Optional: each file on its own, failures ignored.
        await Promise.all(
          OPTIONAL_CORE.map((name) => cache.add(requestFor(name)).catch(() => undefined)),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("hermes-mini-v") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  let name;
  if (url.pathname.startsWith(SCOPE_PATH)) name = url.pathname.slice(SCOPE_PATH.length) || "index.html";
  else return;
  if (!SHELL_SET.has(name)) return; // not a shell file: let the browser go to the network

  // Network first (revalidating past the HTTP cache), so a change on the server shows on the next load. The
  // cached copy is the fallback when offline or when the network takes longer than 4 s.
  event.respondWith(
    caches.open(CACHE).then((cache) => {
      const network = fetch(request, { cache: "no-cache" }).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      });
      const fallback = () => cache.match(request).then((hit) => hit || network);
      const timeout = new Promise((resolve) => setTimeout(resolve, 4000)).then(fallback);
      return Promise.race([network.catch(fallback), timeout]);
    }),
  );
});

// Closes the reply and job notifications for one chat. Approval and question notifications stay: they still need an
// answer. The app calls the same thing through the registration when a chat is opened (drawer.js markSeen).
const DISMISSABLE_KINDS = new Set(["reply", "job"]);
async function closeChatNotifications(sessionId) {
  if (!sessionId) return;
  const shown = await self.registration.getNotifications();
  for (const notification of shown) {
    const data = notification.data || {};
    if (data.session_id === sessionId && DISMISSABLE_KINDS.has(data.kind)) notification.close();
  }
}

// Push arrives even when no tab is open. If the app is visibly focused it already shows the approval card,
// question or reply, so the notification is skipped to avoid announcing what the person is looking at.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Hermes Mini";
  const kind = data.kind || "";
  const tag = data.tag || "hermes-mini";
  // The chat was read somewhere (push_store.dismiss): close its reply/job notifications here and show nothing.
  if (kind === "dismiss") {
    event.waitUntil(closeChatNotifications(data.session_id || ""));
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // A scheduled job's result (bridge.py): an open app pulls it into the chat straight away.
      if (kind === "job") for (const client of windows) client.postMessage({ type: "hermes-mini-job" });
      if (windows.some((client) => client.visibilityState === "visible" && client.focused)) return;
      await self.registration.showNotification(title, {
        body: data.body || "",
        tag,
        renotify: true,
        // icon: the payload's icon when one is sent, else the app portrait. badge: the status-bar glyph,
        // which Android paints white from the alpha channel only.
        icon: data.icon || "icon-192.png",
        badge: "badge-96.png?v=2",
        data: {
          session_id: data.session_id || "",
          kind,
          session_key: data.session_key || "",
          // What the tap should open on: the stored row id (a job result), else the reply's opening.
          message_id: data.message_id === undefined ? null : data.message_id,
          match: data.match || "",
          ts: data.ts || 0,
        },
        actions:
          kind === "approval"
            ? [
                { action: "approve", title: "Approve" },
                { action: "deny", title: "Deny" },
              ]
            : [],
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  notification.close();

  // Approve/Deny answer the pending approval exactly like the in-app card; there is nothing to open.
  if (event.action === "approve" || event.action === "deny") {
    event.waitUntil(
      fetch(`${API_BASE}push/approval`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_key: data.session_key || "",
          choice: event.action === "approve" ? "once" : "deny",
        }),
      }).catch(() => {}),
    );
    return;
  }

  // A tap elsewhere opens (or focuses) that chat, on the message the notification was about when the push
  // carried a target (a job's row id, a reply's opening).
  event.waitUntil(
    (async () => {
      const target = {};
      if (data.message_id !== null && data.message_id !== undefined && data.message_id !== "") target.message_id = data.message_id;
      if (data.match) target.match = data.match;
      if (data.ts) target.ts = data.ts;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((win) => win.visibilityState === "visible" && win.focused) || windows[0];
      if (client) {
        await client.focus();
        client.postMessage({ type: "hermes-mini-open-session", session_id: data.session_id || "", ...target });
        return;
      }
      const hash = new URLSearchParams();
      if (data.session_id) hash.set("session", data.session_id);
      if (target.message_id !== undefined) hash.set("msg", String(target.message_id));
      if (target.match) hash.set("match", target.match);
      if (target.ts) hash.set("ts", String(target.ts));
      const suffix = hash.toString() ? `#${hash}` : "";
      await self.clients.openWindow(new URL(`index.html${suffix}`, self.location.href).href);
    })(),
  );
});
