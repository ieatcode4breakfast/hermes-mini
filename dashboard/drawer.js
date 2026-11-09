// Chat drawer: the left-hand list of Hermes chats (New chat, a Pinned group, date groups, the row menu).
// This module owns the drawer's DOM, its history entry, swipe, focus trap and pagination. It never talks to the
// WebSocket or changes threads itself: app.js passes in the data and actions it needs (see createDrawer's deps).

import { confirmDialog } from "./confirm.js";

const PAGE_SIZE = 40;
const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;
const SWIPE_CLOSE_RATIO = 0.35;
// Scheduled runs and internal workers stay out of the list. Child/subagent runs are already hidden by the server's
// default listing (exclude_children), and branch/compression children are kept on purpose, so no client filter here.
const HIDDEN_SOURCES = ["cron", "oneshot", "tool", "kanban"];
// Only chats the person can reply to are listed: the sources the app resumes (app.js RESUMABLE_SOURCES), plus the home
// thread. Everything else (Discord, desktop, CLI, ...) would open read-only, so the drawer leaves it out. The server
// filters by these too (sources=...), and isListed() is the client-side guard.
const REPLYABLE_SOURCES = new Set(["tui"]);
const REPLYABLE_CSV = [...REPLYABLE_SOURCES].join(",");
const HOME_TITLE = "Hermes Mini"; // app.js THREAD_TITLE
// The label on the home row: the install's optional external home label (<meta name="home-label">, filled from
// the plugin's settings), else the agent's own name (app.js reads the same tags). setHomeLabel keeps the two in
// step when the identity changes at runtime.
let homeLabel = document.querySelector('meta[name="home-label"]')?.content
  || document.querySelector('meta[name="agent-name"]')?.content || "Mini";
// The PWA's own family of sessions: no source badge on these.
const NATIVE_SOURCES = new Set(["tui"]);
const SOURCE_LABELS = {
  discord: "Discord",
  cli: "CLI",
  telegram: "Telegram",
  slack: "Slack",
  whatsapp: "WhatsApp",
  signal: "Signal",
  matrix: "Matrix",
  email: "Email",
  desktop: "Desktop",
  gui: "App",
};
const DAY_MS = 86400000;
// The pin glyph on a pinned row (upright; the row menu's Pin item is the same mark, tilted).
const PIN_PATHS = ["M8 3h8", "M9.5 3v7L7 13h10l-2.5-3V3", "M12 13v8"];
// The main chat's reset glyph: a circular arrow. Stroked (style.css sets stroke), grey like the other row icons.

export function sourceLabel(source) {
  if (!source) return "";
  return SOURCE_LABELS[source] || source.charAt(0).toUpperCase() + source.slice(1);
}

function startOfDay(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function groupLabel(ts, now = new Date()) {
  const ms = (ts || 0) * 1000;
  const sod = startOfDay(now);
  if (ms >= sod) return "Today";
  if (ms >= sod - DAY_MS) return "Yesterday";
  if (ms >= sod - 7 * DAY_MS) return "Previous 7 days";
  if (ms >= sod - 30 * DAY_MS) return "Previous 30 days";
  return "Older";
}

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgIcon(paths, size) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  if (size) svg.setAttribute("width", String(size));
  if (size) svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function normalize(raw) {
  const preview = String(raw.preview || "").replace(/\s+/g, " ").trim();
  return {
    id: raw.id || raw.session_id,
    title: String(raw.title || "").trim(),
    preview,
    source: raw.source || "",
    last_active: Number(raw.last_active || raw.session_started || raw.started_at || 0),
    pinned: Boolean(raw.pinned),
    archived: Boolean(raw.archived), // the pin back-fill can return an archived pinned row; the list never shows one
  };
}

// A normalized row the drawer lists: a chat the person can reply to, or the home thread (whatever its source).
// appChats is the app's own registry (plugin_api.py /app-chats): only chats the app started, so a terminal or
// dashboard-page chat with the same source stays out. Until it loads, or if it cannot, the
// source rule stands in, so the list is never empty because of it.
function isListed(item, homeId, appChats, viewedId) {
  if (item.id === homeId || item.id === viewedId) return true;
  if (!REPLYABLE_SOURCES.has(item.source)) return false;
  return !appChats || appChats.has(item.id);
}

function renameError(error) {
  const message = (error && error.message) || String(error);
  if (/already uses|already in use|already exists|unique|in use by/i.test(message)) return "Another chat already uses that name.";
  if (/revision|conflict|busy/i.test(message)) return "This chat changed elsewhere. Try again.";
  return `Could not rename: ${message}`;
}


export function createDrawer(deps) {
  const app = document.querySelector(".app");
  const menuBtn = $("menuBtn");
  const drawer = $("drawer");
  const scrim = $("scrim");
  const newBtn = $("drawerNew");
  const list = $("drawerList");
  const noteEl = $("drawerNote");
  const rowMenuScrim = $("rowMenuScrim");
  const rowMenu = $("rowMenu");
  const menuPin = $("rowMenuPin");
  const menuPinLabel = menuPin.querySelector("span");
  const menuMute = $("rowMenuMute");
  const menuMuteLabel = menuMute ? menuMute.querySelector("span") : null;
  const menuRename = $("rowMenuRename");
  const menuDelete = $("rowMenuDelete");
  const menuReset = $("rowMenuReset");
  const renameScrim = $("renameScrim");
  const renameDialog = $("renameDialog");
  const renameInput = $("renameInput");
  const renameErrorEl = $("renameError");
  const renameSubmit = $("renameSubmit");
  const renameCancel = $("renameCancel");

  const st = {
    open: false,
    rows: [], // rows from /api/sessions pages, in server order (most recent first)
    total: 0,
    next: 0, // offset of the next page
    exhausted: false, // a page came back empty: nothing further to load
    home: null, // the home row when it is not among the loaded pages
    loading: false,
    error: false,
    seq: 0, // bumped by every fetch so stale replies are dropped
    rename: null, // { item, draft, error, busy, prevFocus } while the rename dialog is open
    renameBack: null, // promise: a history.back() from an in-app rename close is still in flight
    resolveRenameBack: null,
    menu: null, // { item, row, prevFocus } while the row menu is open
    menuBack: null, // promise: a history.back() from an in-app menu close is still in flight
    resolveMenuBack: null,
    resetBusy: false, // a main-chat reset is being confirmed or is in flight
    pendingBack: null, // promise: a history.back() from an in-app close is still in flight
    resolveBack: null,
    prevFocus: null,
    suppressClick: false,
    appChats: null, // Set of chat ids the app started (plugin_api.py /app-chats); null until loaded
    pinOrder: [], // chat ids in the manual Pinned order (plugin_api.py /pin-order), shared across devices
    muted: new Set(), // chat ids with notifications muted (plugin_api.py /push/muted), shared across devices
    sorting: false, // the Pinned group is in Sort mode: drag handles on, taps do not open chats
    busy: new Set(), // chat ids with a reply in progress right now (setBusy, fed by app.js); their rows pulse
    seen: { since: 0, seen: {} }, // shared read markers (plugin_api.py /seen): chat id -> unix seconds
    seenLoaded: false, // the first /seen reply has not landed yet: show no dots rather than guess
  };

  // The saved Pinned order arrives once at start; the list re-renders when it lands.
  const PIN_ORDER_URL = "/api/plugins/hermes-mini/pin-order";
  deps.api(PIN_ORDER_URL).then((data) => {
    st.pinOrder = Array.isArray(data && data.order) ? data.order : [];
    if (st.rows.length) render({ keepScroll: true }); // before the first page there is nothing to reorder
  }).catch(() => {});

  // Muted sessions arrive once at start; shared across devices.
  const PUSH_MUTED_URL = "/api/plugins/hermes-mini/push/muted";
  const PUSH_MUTE_URL = "/api/plugins/hermes-mini/push/mute";
  deps.api(PUSH_MUTED_URL).then((data) => {
    st.muted = new Set(Array.isArray(data && data.muted) ? data.muted : []);
    if (st.rows.length) render({ keepScroll: true });
  }).catch(() => {});

  function isDevicePushEnabled() {
    const pushBtn = $("pushBtn");
    if (!pushBtn || pushBtn.hidden) return false;
    if (pushBtn.getAttribute("aria-pressed") !== "true") return false;
    if ("Notification" in window && Notification.permission !== "granted") return false;
    return true;
  }

  async function toggleMuted(item) {
    if (!item || !item.id) return;
    const shouldMute = !st.muted.has(item.id);
    if (shouldMute) st.muted.add(item.id);
    else st.muted.delete(item.id);
    render({ keepScroll: true });
    try {
      await deps.api(PUSH_MUTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: item.id, muted: shouldMute }),
      });
    } catch (err) {
      if (shouldMute) st.muted.delete(item.id);
      else st.muted.add(item.id);
      render({ keepScroll: true });
      note((err && err.message) || "Could not change notification setting.");
    }
  }

  // The unread markers arrive once at start too. They are merged rather than replaced, so a chat
  // read while the request was in flight keeps its newer local mark.
  const SEEN_URL = "/api/plugins/hermes-mini/seen";
  function mergeSeen(data) {
    const since = Number(data && data.since) || 0;
    const map = data && data.seen && typeof data.seen === "object" ? data.seen : {};
    const merged = {};
    for (const [id, at] of Object.entries(map)) merged[id] = Number(at) || 0;
    for (const [id, at] of Object.entries(st.seen.seen)) merged[id] = Math.max(merged[id] || 0, Number(at) || 0);
    st.seen = { since: Math.max(since, Number(st.seen.since) || 0), seen: merged };
  }
  deps.api(SEEN_URL).then((data) => {
    mergeSeen(data);
    st.seenLoaded = true;
    if (st.rows.length) render({ keepScroll: true });
  }).catch(() => {}); // no markers: no dots, never a guess

  // A row is unread while its latest activity is newer than the last time it was looked at. The chat on screen is never
  // unread: opening it is exactly what clears the mark.
  function isUnread(item) {
    // A chat mid-reply pulses instead: its tool steps bump last_active before any reply exists (ghost-dot fix).
    if (!st.seenLoaded || item.id === viewedId() || st.busy.has(item.id)) return false;
    const mark = Math.max(Number(st.seen.seen[item.id]) || 0, Number(st.seen.since) || 0);
    return item.last_active > mark;
  }

  // Records that a chat has been looked at. The local map updates now, so the dot clears at once, and the server keeps
  // the shared copy for the other devices. The mark is the chat's own latest activity or now, whichever is later, so a
  // slightly different clock on the phone can never leave a just-read chat looking unread.
  function markSeen(id, at = null) {
    if (!id) return;
    const row = st.rows.find((item) => item.id === id);
    const stamp = Math.floor(Math.max(Number(at) || 0, row ? row.last_active : 0, Date.now() / 1000));
    if ((Number(st.seen.seen[id]) || 0) >= stamp) return; // already recorded at least this far
    st.seen.seen[id] = stamp;
    if (st.open && st.rows.some((row) => row.id === id)) render({ keepScroll: true });
    deps.api(SEEN_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, at: stamp }),
    }).then((data) => {
      mergeSeen(data);
      st.seenLoaded = true;
      if (st.open) render({ keepScroll: true });
    }).catch(() => {}); // the local mark stands; the next view retries the PUT
  }

  function savePinOrder() {
    return deps.api(PIN_ORDER_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: st.pinOrder }),
    }).catch((error) => note((error && error.message) || "Could not save the pinned order."));
  }

  // Pinned chats in the manual order. A chat pinned before it had a place (or on another client) goes first, newest
  // first, like a fresh pin.
  function orderPinned(pinned) {
    const rank = new Map(st.pinOrder.map((id, index) => [id, index]));
    const fresh = pinned.filter((row) => !rank.has(row.id)).sort((a, b) => b.last_active - a.last_active);
    const placed = pinned.filter((row) => rank.has(row.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    return [...fresh, ...placed];
  }

  const sentinel = el("div", "list-sentinel");
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    },
    { root: list, rootMargin: "240px 0px" },
  );
  // The list's scrollbar (desktop) takes width from the rows. The drawer still publishes its width as --drawer-sb
  // (style.css); New chat now lives inside the padded list, so it shares the rows' right edge automatically.
  const listResize = new ResizeObserver(() => syncScrollbar());
  listResize.observe(list);

  const homeId = () => deps.homeId();
  const viewedId = () => deps.viewedId();
  const isHome = (item) => item.id === homeId();
  // Docked: the drawer is the permanent left column on a wide window (app.js owns the query and the body class).
  const isDocked = () => Boolean(deps.isDocked && deps.isDocked());

  function note(text) {
    noteEl.textContent = text || "";
  }

  // ---------- data ----------

  function fetchPage(offset) {
    return deps.api(
      `/api/sessions?limit=${PAGE_SIZE}&offset=${offset}&order=recent&archived=exclude&sources=${REPLYABLE_CSV}&exclude_sources=${HIDDEN_SOURCES.join(",")}`,
    );
  }

  // The app-chat registry, reloaded with every refresh so chats tagged on another device appear. A failed load keeps
  // the last good set (or the source-rule fallback when there never was one).
  function loadAppChats() {
    return deps.api("/api/plugins/hermes-mini/app-chats").then((data) => {
      if (data && Array.isArray(data.ids)) st.appChats = new Set(data.ids);
    }).catch(() => {});
  }

  // A chat this device just tagged: list it at once rather than after the next refresh.
  function addAppChat(id) {
    if (st.appChats && id) st.appChats.add(id);
  }

  async function refresh() {
    const seq = ++st.seq;
    st.loading = true;
    st.error = false;
    st.exhausted = false;
    if (!st.rows.length) render({ keepScroll: false });
    // Pull the read markers with the rows: a chat read on another device loses its dot here too.
    // The merge only ever raises marks, so this can never bring back a dot this device already cleared.
    void deps.api(SEEN_URL).then((data) => {
      mergeSeen(data);
      st.seenLoaded = true;
      if (st.open && st.rows.length) render({ keepScroll: true });
    }).catch(() => {});
    try {
      const [page] = await Promise.all([fetchPage(0), loadAppChats()]);
      if (seq !== st.seq) return;
      const raws = page.sessions || [];
      const home = homeId();
      st.rows = raws.map(normalize).filter((item) => isListed(item, home, st.appChats, viewedId()) && !item.archived);
      st.next = raws.length; // the offset counts server rows, listed or not
      st.total = Number(page.total) || raws.length;
      st.home = null;
      if (home && !st.rows.some((row) => row.id === home)) {
        // The home thread is normally the most recent row; when it is not on the first page, fetch just that row.
        st.home = await deps.api(`/api/sessions/${encodeURIComponent(home)}`).then(normalize).catch(() => null);
      }
      note("");
    } catch {
      if (seq !== st.seq) return;
      st.error = true;
      note("Could not load chats. Check the connection and try again.");
    } finally {
      if (seq === st.seq) st.loading = false;
      if (st.open) render({ keepScroll: true });
    }
  }

  async function loadMore() {
    if (st.loading || st.exhausted || st.next >= st.total) return;
    const seq = st.seq;
    st.loading = true;
    list.append(el("div", "list-more", "Loading…")); // no rebuild: keeps focus where it is
    try {
      // Keep fetching until a page's worth of chats is listed or the listing ends, so a page that comes back short
      // (rows the client-side guard drops) still fills the list.
      const home = homeId();
      const seen = new Set(st.rows.map((row) => row.id));
      let added = 0;
      while (seq === st.seq && added < PAGE_SIZE && !st.exhausted && st.next < st.total) {
        const page = await fetchPage(st.next);
        if (seq !== st.seq) return;
        const raws = page.sessions || [];
        // The listing's total can run ahead of the rows it returns, so an empty page is the real end of the list.
        if (!raws.length) {
          st.exhausted = true;
          break;
        }
        st.next += raws.length;
        for (const item of raws.map(normalize)) {
          if (!isListed(item, home, st.appChats, viewedId()) || item.archived || seen.has(item.id)) continue;
          seen.add(item.id);
          st.rows.push(item);
          added += 1;
        }
      }
    } catch {
      if (seq === st.seq) note("Could not load more chats.");
    } finally {
      if (seq === st.seq) st.loading = false;
      if (st.open && seq === st.seq) render({ keepScroll: true });
    }
  }

  // ---------- rendering ----------

  function syncScrollbar() {
    drawer.style.setProperty("--drawer-sb", `${Math.max(0, list.offsetWidth - list.clientWidth)}px`);
  }

  function skeleton(count) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) frag.append(el("div", "skel"));
    return frag;
  }

  function render({ keepScroll = true } = {}) {
    const keep = keepScroll ? list.scrollTop : 0;
    const active = document.activeElement;
    const focusKey = active && drawer.contains(active) ? (active.dataset.id ? `row:${active.dataset.id}` : active.id ? `id:${active.id}` : "") : "";
    list.replaceChildren();
    const now = new Date();
    renderBrowse(now);
    list.scrollTop = keep;
    syncScrollbar();
    if (st.rows.length) list.append(sentinel);
    if (focusKey) {
      const node = focusKey.startsWith("row:")
        ? list.querySelector(`[data-id="${CSS.escape(focusKey.slice(4))}"]`)
        : document.getElementById(focusKey.slice(3));
      if (node && node !== document.activeElement) node.focus({ preventScroll: true });
    }
  }

  function renderBrowse(now) {
    const home = homeId();
    if (st.loading && !st.rows.length && !st.home) {
      // Same row as a loaded list, so New chat stays reachable during the first fetch.
      list.append(newBtn);
      list.append(skeleton(7));
      return;
    }
    const homeItem = st.rows.find((row) => row.id === home) || st.home;
    const rest = st.rows.filter((row) => row.id !== home);
    if (homeItem) {
      const slot = el("div", "home-slot");
      slot.append(rowEl(homeItem));
      list.append(slot);
    }
    // New chat sits directly under the home row, above the first group, so it scrolls with the home row rather than
    // staying pinned above the list. The same singleton element (and its click handler) is re-appended on every
    // render; with no home row it heads the list.
    list.append(newBtn);
    if (!homeItem && !rest.length) {
      list.append(el("p", "drawer-empty", st.error ? "Could not load chats." : "No chats yet. Start one with New chat."));
      return;
    }
    // Pinned chats sit in their own group under the home row, in the manual order, kept out of the date groups.
    const pinned = orderPinned(rest.filter((row) => row.pinned));
    const others = rest.filter((row) => !row.pinned);
    if (pinned.length < 2) st.sorting = false;
    if (pinned.length) {
      const pinSection = el("section", "group pinned");
      if (st.sorting) pinSection.classList.add("sorting");
      pinSection.setAttribute("aria-label", "Pinned");
      const head = el("h3", "group-head pinned-head");
      head.append(el("span", "", "Pinned"));
      if (pinned.length >= 2) {
        // Up/down arrows to start sorting, "Done" to finish.
        const sortBtn = el("button", "group-action", st.sorting ? "Done" : "");
        sortBtn.type = "button";
        sortBtn.id = "pinnedSort";
        if (!st.sorting) {
          sortBtn.classList.add("icon");
          sortBtn.setAttribute("aria-label", "Sort pinned chats");
          sortBtn.title = "Sort pinned chats";
          sortBtn.append(svgIcon(["M7 20V4", "M3 8l4-4 4 4", "M17 4v16", "M13 16l4 4 4-4"], 16));
        }
        sortBtn.setAttribute("aria-pressed", String(st.sorting));
        sortBtn.addEventListener("click", () => {
          st.sorting = !st.sorting;
          render({ keepScroll: true });
        });
        head.append(sortBtn);
      }
      pinSection.append(head);
      for (const item of pinned) pinSection.append(rowEl(item));
      list.append(pinSection);
    }
    let section = null;
    let current = null;
    for (const item of others) {
      const name = groupLabel(item.last_active, now);
      if (name !== current) {
        current = name;
        section = el("section", "group");
        section.setAttribute("aria-label", name);
        section.append(el("h3", "group-head", name));
        list.append(section);
      }
      section.append(rowEl(item));
    }
    if (st.loading && st.rows.length) list.append(el("div", "list-more", "Loading…"));
  }

  function rowEl(item) {
    const home = isHome(item);
    const current = item.id === viewedId();
    const unread = isUnread(item);
    const row = el("button", "chat-row");
    row.type = "button";
    row.dataset.id = item.id;
    if (st.busy.has(item.id)) row.classList.add("working");
    if (current) {
      row.classList.add("current");
      row.setAttribute("aria-current", "true");
    }
    if (unread) row.classList.add("unread"); // bold title
    if (st.menu && st.menu.item.id === item.id) row.classList.add("menu-open");
    const main = el("div", "chat-main");
    const titleLine = el("div", "chat-title-line");
    // A small accent dot inside the row: before the title, which shifts right to make room; on the
    // main chat it follows the agent's name instead, so the home icon keeps its place.
    const dot = unread ? el("span", "chat-unread") : null;
    if (dot) dot.setAttribute("aria-hidden", "true");
    if (dot && !home) titleLine.append(dot);
    if (home) titleLine.append(svgIcon(["M3 11l9-7 9 7", "M5 10v10h14V10"], 18));
    const title = home ? homeLabel : item.title || item.preview || "Untitled";
    titleLine.append(el("span", "chat-title", title));
    if (dot && home) titleLine.append(dot);
    main.append(titleLine);
    const preview = item.title ? item.preview : "";
    if (preview && preview !== item.title) main.append(el("div", "chat-preview", preview));
    const meta = el("div", "chat-meta");
    // No time on a row: the stamp holds only the pin mark for a pinned chat.
    const stamp = el("div", "chat-stamp");
    // A pinned row's pin mark sits at the row end (a sibling of the row button, added below), not in the stamp.
    if (stamp.childNodes.length) meta.append(stamp);
    const badge = NATIVE_SOURCES.has(item.source) ? "" : sourceLabel(item.source);
    if (badge) meta.append(el("span", "chat-badge", badge));
    row.append(main, meta);
    row.setAttribute("aria-label", `${title}${badge ? `, from ${badge}` : ""}${item.pinned ? ", pinned" : ""}${st.muted.has(item.id) ? ", muted" : ""}${unread ? ", unread" : ""}`);

    const sorting = st.sorting && item.pinned && !home;
    row.addEventListener("click", () => {
      if (sorting) return; // Sort mode: rows move, they do not open
      if (st.suppressClick) {
        st.suppressClick = false;
        return;
      }
      select(item);
    });
    // Right click or long press opens the row menu. The home chat's menu has only Reset.
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!sorting) openMenu(item, row);
    });
    row.addEventListener("pointerdown", (event) => {
      st.suppressClick = false;
      if (!sorting) armLongPress(row, item, event);
    });
    // The ⋮ button is a sibling of the row button (never nested inside it). The wrapper is the positioning context
    // for the absolute button, and carries the menu-open state so the button stays visible while its menu is up.
    // The home row gets the same ⋮ as the others; its menu holds only Reset.
    const wrap = el("div", home ? "chat-row-wrap home-row-wrap" : "chat-row-wrap");
    if (st.menu && st.menu.item.id === item.id) wrap.classList.add("menu-open");
    wrap.append(row);
    if (sorting) {
      // Sort mode: a grip in place of the ⋮ button. Dragging it moves the row within the Pinned group.
      wrap.classList.add("sorting");
      const grip = el("span", "chat-grip");
      grip.setAttribute("aria-hidden", "true");
      grip.append(svgIcon(["M5 9h14", "M5 15h14"], 18));
      grip.addEventListener("pointerdown", (event) => startSortDrag(event, wrap));
      wrap.append(grip);
      return wrap;
    }
    if (item.pinned) {
      // The pin mark sits where the ⋮ button is and is not interactive; hovering the row swaps it for the ⋮. Unpin is in the row menu.
      wrap.classList.add("has-pin");
      const mark = el("span", "chat-pinmark");
      mark.setAttribute("aria-hidden", "true");
      mark.append(svgIcon(PIN_PATHS, 14));
      wrap.append(mark);
    }
    const dots = el("button", "chat-dots");
    dots.type = "button";
    dots.setAttribute("aria-label", "Chat options");
    dots.setAttribute("aria-haspopup", "menu");
    dots.setAttribute("aria-expanded", st.menu && st.menu.item.id === item.id ? "true" : "false");
    dots.append(dotsIcon());
    dots.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (st.menu && st.menu.row === row) {
        void closeMenu();
        return;
      }
      openMenu(item, row, dots);
    });
    dots.addEventListener("pointerdown", (event) => event.stopPropagation());
    wrap.append(dots);
    return wrap;
  }

  // Drags one pinned row by its grip. The row follows the pointer and the DOM order changes as it crosses a neighbour's
  // midpoint; on release the new order is saved. Pointer capture keeps a fast drag attached, and stopping propagation
  // keeps the drawer's swipe-to-close out of it.
  function startSortDrag(event, wrap) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const grip = event.currentTarget;
    const section = wrap.parentElement;
    const id = event.pointerId;
    try {
      grip.setPointerCapture(id);
    } catch {
      /* capture is best effort */
    }
    let lastY = event.clientY;
    let offset = 0;
    wrap.classList.add("dragging");
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      ev.preventDefault();
      offset += ev.clientY - lastY;
      lastY = ev.clientY;
      wrap.style.transform = `translateY(${offset}px)`;
      const rows = [...section.querySelectorAll(":scope > .chat-row-wrap")];
      const index = rows.indexOf(wrap);
      const prev = rows[index - 1];
      const next = rows[index + 1];
      const box = wrap.getBoundingClientRect(); // includes the transform just set
      const centre = box.top + box.height / 2;
      // Neighbours move, never the dragged row: re-inserting it would drop its pointer capture mid-drag.
      if (prev) {
        const p = prev.getBoundingClientRect();
        if (centre < p.top + p.height / 2) {
          section.insertBefore(prev, wrap.nextSibling);
          offset += p.height;
        }
      }
      if (next) {
        const n = next.getBoundingClientRect();
        if (centre > n.top + n.height / 2) {
          section.insertBefore(next, wrap);
          offset -= n.height;
        }
      }
      wrap.style.transform = `translateY(${offset}px)`;
    };
    const end = (ev) => {
      if (ev.pointerId !== id) return;
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      wrap.classList.remove("dragging");
      wrap.style.transform = "";
      const order = [...section.querySelectorAll(":scope > .chat-row-wrap > .chat-row")].map((row) => row.dataset.id);
      const rest = st.pinOrder.filter((pid) => !order.includes(pid));
      const next = [...order, ...rest];
      if (next.join("\n") !== st.pinOrder.join("\n")) {
        st.pinOrder = next;
        void savePinOrder();
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  // Three filled dots for the row's options button. Filled, not stroked (style.css sets the fill and stroke).
  function dotsIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    for (const cy of [5, 12, 19]) {
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", "12");
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", "2");
      svg.append(circle);
    }
    return svg;
  }

  // Touch long-press opens the same row menu as a right click. Moving more than a few pixels cancels it (a scroll).
  function armLongPress(row, item, event) {
    if (event.pointerType !== "touch") return;
    const start = { x: event.clientX, y: event.clientY };
    let timer = setTimeout(() => {
      timer = 0;
      st.suppressClick = true;
      openMenu(item, row);
    }, LONG_PRESS_MS);
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", cancel);
      row.removeEventListener("pointercancel", cancel);
      row.removeEventListener("pointerleave", cancel);
    };
    const move = (moveEvent) => {
      if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) > MOVE_CANCEL_PX) cancel();
    };
    row.addEventListener("pointermove", move);
    row.addEventListener("pointerup", cancel);
    row.addEventListener("pointercancel", cancel);
    row.addEventListener("pointerleave", cancel);
  }

  // ---------- selecting, renaming, deleting ----------

  function select(item) {
    closeDrawer();
    if (item.id !== viewedId()) deps.onSelect(item.id);
  }

  // Resets the main chat after confirmation. The row's button and its work stay guarded from the first click, so a
  // second press during the dialog or the request does nothing. app.js owns the delete/create work and reports a
  // refusal or a partial failure as a readable message, which lands in the note above the list.
  async function resetMain(item) {
    if (st.resetBusy) return;
    st.resetBusy = true;
    try {
      const proceed = await confirmDialog({
        title: "Reset main chat?",
        message: "This will clear and permanently delete the current main chat. This can't be undone.",
        confirmLabel: "Reset",
        danger: true,
      });
      if (!proceed) return;
      note("");
      await deps.resetMainChat(item);
    } catch (error) {
      note((error && error.message) || "Could not reset the main chat.");
    } finally {
      st.resetBusy = false;
    }
  }

  // Puts focus on a row of the list (by its chat id). Returns the row, or null when it is not listed.
  function focusRow(id) {
    const row = id ? list.querySelector(`[data-id="${CSS.escape(id)}"]`) : null;
    if (row) row.focus({ preventScroll: true });
    return row;
  }

  // ---------- rename dialog ----------
  // Opened from the row menu (the menu closes first). A centred dialog over a scrim. It pushes one history entry,
  // which Escape, the scrim, Cancel, a finished rename and the Android Back button all consume, so nothing stacks.
  // The server call is deps.rename, the same one the rename always made.

  function startRename(item) {
    if (st.rename) return;
    if (st.renameBack) {
      st.renameBack.then(() => startRename(item)); // the previous close's history.back() has not landed yet
      return;
    }
    st.rename = { item, draft: item.title, error: "", busy: false, prevFocus: document.activeElement };
    renameInput.value = item.title;
    renameInput.readOnly = false;
    renameDialog.classList.remove("busy");
    showRenameError("");
    updateRenameSubmit();
    placeRenameDialog();
    renameScrim.classList.add("open");
    renameDialog.classList.add("open");
    if (!(history.state && history.state.hermesMiniRename === true)) history.pushState({ hermesMiniRename: true }, "");
    requestAnimationFrame(() => {
      if (st.rename && st.rename.item === item) {
        renameInput.focus({ preventScroll: true });
        renameInput.select(); // the whole name is selected on open, so typing replaces it
      }
    });
  }

  // Closes the dialog. An in-app close consumes the history entry the dialog pushed; a Back-button close has popped it.
  // Focus goes back to the renamed row (the drawer stays open), or to wherever focus was before.
  function closeRename({ viaPop = false } = {}) {
    const r = st.rename;
    if (!r) return;
    st.rename = null;
    renameScrim.classList.remove("open");
    renameDialog.classList.remove("open");
    if (!focusRow(r.item.id) && r.prevFocus && r.prevFocus.isConnected) r.prevFocus.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniRename === true) {
      st.renameBack = new Promise((resolve) => {
        st.resolveRenameBack = resolve;
      });
      history.back();
    }
  }

  // Centres the dialog in the visual viewport, so the on-screen keyboard on a phone does not cover it.
  function placeRenameDialog() {
    const vv = window.visualViewport;
    renameDialog.style.left = `${vv ? vv.offsetLeft + vv.width / 2 : window.innerWidth / 2}px`;
    renameDialog.style.top = `${vv ? vv.offsetTop + vv.height / 2 : window.innerHeight / 2}px`;
  }

  function showRenameError(message) {
    if (st.rename) st.rename.error = message;
    renameErrorEl.textContent = message;
    renameErrorEl.hidden = !message;
    renameInput.setAttribute("aria-invalid", message ? "true" : "false");
  }

  // Rename is off while the name is empty, unchanged (or only spaces), or a save is pending.
  function updateRenameSubmit() {
    const r = st.rename;
    const title = r ? r.draft.trim() : "";
    renameSubmit.disabled = !r || r.busy || !title || title === r.item.title;
  }

  // While saving: the input is read-only and the Rename button shows a spinner. Cancel and Escape still close.
  function setRenameBusy(busy) {
    if (st.rename) st.rename.busy = busy;
    renameDialog.classList.toggle("busy", busy);
    renameInput.readOnly = busy;
    updateRenameSubmit();
  }

  // Enter or the Rename button. A name that is empty, unchanged or the reserved home title does not reach the server.
  async function commitRename() {
    const r = st.rename;
    if (!r || r.busy) return;
    const item = r.item;
    const title = r.draft.trim();
    if (!title || title === item.title) return;
    if (title === HOME_TITLE) {
      showRenameError("That name is reserved for the home chat.");
      return;
    }
    setRenameBusy(true);
    try {
      await deps.rename(item, title);
      item.title = title;
      render({ keepScroll: true });
      if (st.rename === r) closeRename();
    } catch (error) {
      if (st.rename === r) {
        setRenameBusy(false);
        showRenameError(renameError(error));
        renameInput.focus({ preventScroll: true });
      } else {
        note(renameError(error)); // the dialog was closed while saving: say why in the list's note instead
      }
    }
  }

  // Permanently deletes a chat after confirmation. Only the row is removed from the list (no page reload). A refusal
  // from the server leaves the row in place and says why in the note above the list.
  async function remove(item) {
    const proceed = await confirmDialog({
      title: "Delete chat?",
      message: "This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!proceed) return;
    try {
      await deps.delete(item);
    } catch (error) {
      note((error && error.message) || "Could not delete this chat.");
      return;
    }
    // The server's listing shifts up by one only when the row was among the pages already loaded.
    const wasLoaded = st.rows.some((row) => row.id === item.id);
    st.rows = st.rows.filter((row) => row.id !== item.id);
    st.total = Math.max(0, st.total - 1);
    if (wasLoaded) st.next = Math.max(0, st.next - 1);
    note("");
    render({ keepScroll: true });
  }

  // Pins or unpins a chat (the server call is deps.pin). The list updates in place, with no fetch: the row moves into or
  // out of the Pinned group. A refusal leaves the chat where it was and says why in the note above the list.
  async function setPinned(item, pinned) {
    try {
      await deps.pin(item, pinned);
    } catch (error) {
      note((error && error.message) || "Could not change the pin.");
      return;
    }
    for (const row of st.rows) if (row.id === item.id) row.pinned = pinned;
    // A new pin goes to the top of the manual order; an unpin leaves it.
    const kept = st.pinOrder.filter((id) => id !== item.id);
    st.pinOrder = pinned ? [item.id, ...kept] : kept;
    void savePinOrder();
    note("");
    render({ keepScroll: true });
  }

  // ---------- row menu (long press or right click on a chat row) ----------
  // A card anchored under the pressed row: its left edge on the row's, flipped above the row near the bottom of the
  // screen. The pressed row keeps a highlight. The menu pushes one history entry (like the rename dialog), which a tap
  // outside, Escape, a chosen item and the Android Back button all consume, so nothing stacks. Choosing an item closes
  // the menu first, then acts. The home chat has no menu.

  function openMenu(item, row, dots = null) {
    if (st.menu) return;
    if (st.menuBack) {
      st.menuBack.then(() => openMenu(item, row, dots)); // the previous close's history.back() has not landed yet
      return;
    }
    st.menu = { item, row, dots, prevFocus: document.activeElement };
    menuPinLabel.textContent = item.pinned ? "Unpin" : "Pin";
    const home = isHome(item);
    const pushOn = isDevicePushEnabled();
    menuPin.hidden = home;
    if (menuMute) {
      menuMute.hidden = !pushOn;
      if (pushOn) {
        const isMuted = st.muted.has(item.id);
        if (menuMuteLabel) menuMuteLabel.textContent = isMuted ? "Unmute notifications" : "Mute notifications";
        menuMute.setAttribute("data-muted", isMuted ? "true" : "false");
        menuMute.setAttribute("aria-label", isMuted ? "Unmute notifications" : "Mute notifications");
      }
    }
    menuRename.hidden = home;
    menuDelete.hidden = home;
    menuReset.hidden = !home;
    row.classList.add("menu-open");
    const wrap = row.closest(".chat-row-wrap");
    if (wrap) wrap.classList.add("menu-open");
    if (dots) dots.setAttribute("aria-expanded", "true");
    placeRowMenu(dots || row);
    rowMenuScrim.classList.add("open");
    rowMenu.classList.add("open");
    if (!(history.state && history.state.hermesMiniMenu === true)) history.pushState({ hermesMiniMenu: true }, "");
    const first = [menuPin, menuMute, menuRename, menuDelete, menuReset].find((btn) => btn && !btn.hidden);
    if (first) first.focus({ preventScroll: true });
  }

  // Puts the card under the anchor (the row, or the row's ⋮ button), left edges together. If it would run off the
  // bottom, it goes above the anchor instead. Either way it is clamped 8px inside the viewport, so the ⋮ variant may
  // extend past the drawer's right edge as long as it stays on screen.
  function placeRowMenu(anchor) {
    const gap = 6;
    const edge = 8;
    const r = anchor.getBoundingClientRect();
    const w = rowMenu.offsetWidth;
    const h = rowMenu.offsetHeight;
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - edge) top = Math.max(edge, r.top - gap - h);
    const left = Math.min(Math.max(edge, r.left), window.innerWidth - w - edge);
    rowMenu.style.left = `${left}px`;
    rowMenu.style.top = `${top}px`;
  }

  // Closes the menu. An in-app close consumes the entry the menu pushed (the returned promise settles once that has
  // happened); a Back press has popped it already. Focus goes back to the row, or to wherever focus was before.
  function closeMenu({ viaPop = false } = {}) {
    const m = st.menu;
    if (!m) return Promise.resolve();
    st.menu = null;
    m.row.classList.remove("menu-open");
    const wrap = m.row.closest(".chat-row-wrap");
    if (wrap) wrap.classList.remove("menu-open");
    if (m.dots) m.dots.setAttribute("aria-expanded", "false");
    rowMenuScrim.classList.remove("open");
    rowMenu.classList.remove("open");
    if (!focusRow(m.item.id) && m.prevFocus && m.prevFocus.isConnected) m.prevFocus.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniMenu === true) {
      st.menuBack = new Promise((resolve) => {
        st.resolveMenuBack = resolve;
      });
      history.back();
      return st.menuBack;
    }
    return Promise.resolve();
  }

  // Arrow keys, Home and End move between the menu's items (Enter and Space activate the focused one natively).
  function moveMenuFocus(event) {
    const items = [menuPin, menuMute, menuRename, menuDelete, menuReset].filter((item) => item && !item.hidden);
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = index < 0 || index === items.length - 1 ? 0 : index + 1;
    else next = index <= 0 ? items.length - 1 : index - 1;
    event.preventDefault();
    items[next].focus({ preventScroll: true });
  }

  menuPin.addEventListener("click", () => {
    const m = st.menu;
    if (!m) return;
    const item = m.item;
    const pinned = !item.pinned;
    void closeMenu().then(() => setPinned(item, pinned));
  });
  if (menuMute) {
    menuMute.addEventListener("click", () => {
      const m = st.menu;
      if (!m) return;
      const item = m.item;
      void closeMenu().then(() => toggleMuted(item));
    });
  }
  menuRename.addEventListener("click", () => {
    const m = st.menu;
    if (!m) return;
    const item = m.item;
    void closeMenu().then(() => startRename(item));
  });
  menuDelete.addEventListener("click", () => {
    const m = st.menu;
    if (!m) return;
    const item = m.item;
    void closeMenu().then(() => remove(item));
  });
  menuReset.addEventListener("click", () => {
    const m = st.menu;
    if (!m) return;
    const item = m.item;
    void closeMenu().then(() => resetMain(item));
  });
  rowMenuScrim.addEventListener("click", () => closeMenu());

  renameInput.addEventListener("input", () => {
    if (!st.rename) return;
    st.rename.draft = renameInput.value;
    if (st.rename.error) showRenameError("");
    updateRenameSubmit();
  });
  renameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void commitRename();
    }
  });
  renameSubmit.addEventListener("click", () => void commitRename());
  renameCancel.addEventListener("click", () => closeRename());
  renameScrim.addEventListener("click", () => closeRename());
  if (window.visualViewport) {
    // The keyboard shrinks the visual viewport: keep the dialog centred in what is still visible.
    window.visualViewport.addEventListener("resize", () => st.rename && placeRenameDialog());
    window.visualViewport.addEventListener("scroll", () => st.rename && placeRenameDialog());
  }

  // ---------- open / close, with one history entry per open ----------

  function openDrawer() {
    if (isDocked()) {
      // The chats column is always on screen: nothing to open, no scrim, no inert app, no history entry.
      st.open = true;
      return;
    }
    if (st.open) return;
    if (st.pendingBack) {
      // The previous close's history.back() has not landed yet; open once it has, so the entries stay in step.
      st.pendingBack.then(openDrawer);
      return;
    }
    st.open = true;
    st.prevFocus = document.activeElement;
    drawer.classList.add("open");
    scrim.classList.add("open");
    menuBtn.setAttribute("aria-expanded", "true");
    app.inert = true;
    if (!(history.state && history.state.hermesMiniDrawer === true)) history.pushState({ hermesMiniDrawer: true }, "");
    render({ keepScroll: false });
    void refresh();
    drawer.focus({ preventScroll: true });
  }

  function closeDrawer({ viaPop = false } = {}) {
    if (isDocked()) {
      // Docked: there is no overlay to close; keep the column (and paging) live.
      st.open = true;
      return st.pendingBack || Promise.resolve();
    }
    if (!st.open) return st.pendingBack || Promise.resolve();
    st.open = false;
    st.sorting = false;
    if (st.rename) closeRename({ viaPop: true }); // not reachable from the drawer's own controls, which the dialog covers
    if (st.menu) closeMenu({ viaPop: true }); // the menu is modal, so no tap reaches here with it open; drop its state
    drawer.classList.remove("open");
    scrim.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
    app.inert = false;
    // In-app close consumes the entry this drawer pushed. A Back-button close has already popped it.
    if (!viaPop && history.state && history.state.hermesMiniDrawer === true) {
      st.pendingBack = new Promise((resolve) => {
        st.resolveBack = resolve;
      });
      history.back();
    }
    const target = st.prevFocus && st.prevFocus.isConnected ? st.prevFocus : menuBtn;
    target.focus({ preventScroll: true });
    return st.pendingBack || Promise.resolve();
  }

  window.addEventListener("popstate", (event) => {
    // The popstate from our own history.back() only settles the pending close.
    if (st.resolveBack) {
      const resolve = st.resolveBack;
      st.resolveBack = null;
      st.pendingBack = null;
      resolve();
      return;
    }
    if (st.open && !(event.state && event.state.hermesMiniDrawer === true)) closeDrawer({ viaPop: true });
  });

  // The rename dialog's own entry. Its popstate from our history.back() settles the pending close; a Back press closes
  // the dialog and leaves the drawer open (the drawer's entry is underneath).
  window.addEventListener("popstate", (event) => {
    if (st.resolveRenameBack) {
      const resolve = st.resolveRenameBack;
      st.resolveRenameBack = null;
      st.renameBack = null;
      resolve();
      return;
    }
    if (st.rename && !(event.state && event.state.hermesMiniRename === true)) closeRename({ viaPop: true });
  });

  // The row menu's own entry. Its popstate from our history.back() settles the pending close; a Back press closes the
  // menu and leaves the drawer open (the drawer's entry is underneath).
  window.addEventListener("popstate", (event) => {
    if (st.resolveMenuBack) {
      const resolve = st.resolveMenuBack;
      st.resolveMenuBack = null;
      st.menuBack = null;
      resolve();
      return;
    }
    if (st.menu && !(event.state && event.state.hermesMiniMenu === true)) closeMenu({ viaPop: true });
  });

  // Tab cycles through the drawer (or the row menu, when it is open) in DOM order. The step is done here rather than
  // left to the browser, whose sequential order inside the scrolling list is not reliable enough to trap focus.
  // The container itself, or anything outside it, counts as "before the first control".
  function trapFocus(event) {
    const scope = st.rename ? renameDialog : st.menu ? rowMenu : drawer;
    const items = [...scope.querySelectorAll("button, input, [tabindex]:not([tabindex='-1'])")].filter((node) => !node.disabled);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (index <= 0 ? items.length - 1 : index - 1)
      : (index === -1 || index === items.length - 1 ? 0 : index + 1);
    items[next].focus();
  }

  document.addEventListener("keydown", (event) => {
    if (st.rename) {
      // The dialog is on top: Escape closes it (not the drawer behind it), and Tab stays inside it.
      if (event.key === "Escape") {
        event.preventDefault();
        closeRename();
      } else if (event.key === "Tab") {
        trapFocus(event);
      }
      return;
    }
    if (st.menu) {
      // The row menu is on top: Escape closes it (not the drawer), Tab stays inside it, arrows move between its items.
      if (event.key === "Escape") {
        event.preventDefault();
        void closeMenu();
      } else if (event.key === "Tab") {
        trapFocus(event);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        moveMenuFocus(event);
      }
      return;
    }
    if (!st.open || isDocked()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
    } else if (event.key === "Tab") {
      trapFocus(event);
    }
  });

  menuBtn.addEventListener("click", () => openDrawer());
  scrim.addEventListener("click", () => {
    if (swallowScrimClick) {
      swallowScrimClick = false;
      return;
    }
    closeDrawer();
  });
  newBtn.addEventListener("click", () => {
    closeDrawer();
    deps.onNewChat();
  });
  observer.observe(sentinel);

  // ---------- swipe left to close: the drawer follows the finger and snaps back or closes ----------
  // The same handlers serve a swipe that starts on the drawer and one that starts on the scrim beside it. A scrim
  // gesture that moves at all is not treated as a tap; a still tap closes as before.

  let drag = null;
  let swallowScrimClick = false;

  function startSwipe(event) {
    if (isDocked() || event.pointerType !== "touch" || !st.open) return;
    const fromScrim = event.currentTarget === scrim;
    if (fromScrim) swallowScrimClick = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, t: performance.now(), dx: 0, active: false, fromScrim };
  }

  function moveSwipe(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (drag.fromScrim) swallowScrimClick = true; // a moving scrim gesture is never a tap
      if (dx > 0 || Math.abs(dy) > Math.abs(dx)) {
        drag = null; // a rightward or vertical move is a scroll or nothing
        return;
      }
      drag.active = true;
      st.suppressClick = true;
      drawer.classList.add("dragging");
    }
    drag.dx = Math.min(0, dx);
    drawer.style.transform = `translateX(${drag.dx}px)`;
    scrim.style.opacity = String(Math.max(0, 1 + drag.dx / Math.max(1, drawer.offsetWidth)));
  }

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const finished = drag;
    drag = null;
    if (!finished.active) return;
    const elapsed = Math.max(1, performance.now() - finished.t);
    const fast = finished.dx < -20 && finished.dx / elapsed < -0.5;
    const shouldClose = -finished.dx > drawer.offsetWidth * SWIPE_CLOSE_RATIO || fast;
    drawer.classList.remove("dragging");
    drawer.style.transform = "";
    scrim.style.opacity = "";
    if (shouldClose) closeDrawer();
  };

  for (const surface of [drawer, scrim]) {
    surface.addEventListener("pointerdown", startSwipe);
    surface.addEventListener("pointermove", moveSwipe);
    surface.addEventListener("pointerup", endDrag);
    surface.addEventListener("pointercancel", endDrag);
  }

  // ---------- docked mode (app.js owns the query; this only reacts) ----------
  // Docked makes the drawer the permanent left column. Entering it ends any overlay state cleanly - scrim off, app not
  // inert, any {hermesMiniDrawer:true} entry consumed the way closeDrawer does - and loads the list once, because the
  // list is now always on screen. Leaving it returns to the closed off-canvas drawer.
  function dockedChanged(docked) {
    if (docked) {
      drag = null;
      swallowScrimClick = false;
      drawer.classList.remove("dragging");
      drawer.style.transform = "";
      scrim.style.opacity = "";
      scrim.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "true");
      drawer.setAttribute("aria-modal", "false"); // a permanent sidebar, not a modal dialog
      app.inert = false;
      st.open = true;
      if (history.state && history.state.hermesMiniDrawer === true) {
        st.pendingBack = new Promise((resolve) => {
          st.resolveBack = resolve;
        });
        history.back();
      }
      render({ keepScroll: true });
      void refresh();
      return;
    }
    // Back to an overlay drawer, closed. Silent: no focus jump (the computer may have just taken focus) and app.inert
    // is left to its owner. The column never pushed a history entry, so there is none to consume.
    st.open = false;
    drawer.classList.remove("open");
    scrim.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
    drawer.setAttribute("aria-modal", "true");
  }

  // Chats the agent is working in pulse in the list. Toggles the class on the rows already drawn,
  // so a poll never rebuilds the list.
  function setBusy(ids) {
    const next = new Set(ids);
    const finished = [...st.busy].some((id) => !next.has(id));
    const changed = finished || [...next].some((id) => !st.busy.has(id));
    st.busy = next;
    for (const row of list.querySelectorAll(".chat-row[data-id]")) row.classList.toggle("working", st.busy.has(row.dataset.id));
    // A chat that just finished may now be unread: reload the rows for its fresh last_active. One that just started
    // only loses its dot, which a redraw covers.
    if (finished) void refresh();
    else if (changed && st.rows.length) render({ keepScroll: true });
  }

  // setHomeLabel: the home row follows the agent name/home label without a reload (app.js calls it after the
  // identity loads or changes).
  function setHomeLabel(label) {
    const next = String(label || "").trim() || "Mini";
    if (next === homeLabel) return;
    homeLabel = next;
    void refresh();
  }

  return { open: openDrawer, close: closeDrawer, refresh, dockedChanged, markSeen, setBusy, addAppChat,
           setHomeLabel, isOpen: () => st.open };
}
