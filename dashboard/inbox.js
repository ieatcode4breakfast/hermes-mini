// Inbox panel: every agent message the app draws, across its chats, newest first.
// It stores nothing itself: each open reads the app's own sessions through plugin_api.py /inbox, so deleting a chat
// makes its rows vanish and no row can point at a message that is gone. The only thing kept is the server's per-message
// read tracker, which this module never writes text into.
// The panel mirrors To-do (todo.js): one history entry per open, the same centred card on a desktop and the same
// full-screen presentation with the active button on the left on a phone.

import { stripCronWrapper } from "./jobtext.js";

const INBOX_API = "/api/plugins/hermes-mini/inbox";
const PAGE = 50;
const TOP_PX = 4; // "at the top" is a few pixels: touch scrolls settle just off 0
const NEW_POLL_MS = 10000; // live head refresh while the panel is open
const BADGE_POLL_MS = 15000; // unread badge, only while the page is visible

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalise(raw) {
  return {
    id: Number(raw && raw.id),
    session_id: String((raw && raw.session_id) || ""),
    thread: String((raw && raw.thread) || ""),
    home: Boolean(raw && raw.home),
    ts: Number((raw && raw.ts) || 0),
    text: String((raw && raw.text) || ""),
    read: Boolean(raw && raw.read),
  };
}

// The chat list's home icon (drawer.js rowEl), so a main-chat message reads the same in both places.
const HOME_PATHS = ["M3 11l9-7 9 7", "M5 10v10h14V10"];
function homeIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("inbox-home");
  for (const d of HOME_PATHS) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function listFrom(payload) {
  const raw = payload && Array.isArray(payload.items) ? payload.items : [];
  return raw.map(normalise).filter((item) => Number.isInteger(item.id) && item.id > 0 && item.session_id);
}

// Today / Yesterday / "Mon 3 Nov" (the spec's wording; the app has no other long-date label to reuse).
function dayStamp(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts, now = new Date()) {
  const d = new Date(ts * 1000);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const gap = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (gap === 0) return "Today";
  if (gap === 1) return "Yesterday";
  const weekday = d.toLocaleDateString([], { weekday: "short" });
  const month = d.toLocaleDateString([], { month: "short" });
  return `${weekday} ${d.getDate()} ${month}`;
}

export function createInbox({ api, formatTime, openMessage, isPhone }) {
  const btn = $("inboxBtn");
  const countEl = $("inboxCount");
  const scrim = $("inboxScrim");
  const dialog = $("inboxDialog");
  const listEl = $("inboxList");
  const emptyEl = $("inboxEmpty");
  // The empty state names this install's agent ("No messages from Hermes yet" when no name is set),
  // like the rest of the app's text.
  const agentName = document.querySelector('meta[name="agent-name"]')?.content || "Hermes";
  emptyEl.textContent = `No messages from ${agentName} yet`;
  // All | Unread tabs. Unread asks the server for unread rows only (?unread=1), so it pages the
  // same way All does. A row read while the Unread tab is showing stays until the list reloads.
  const tabAll = $("inboxTabAll");
  const tabUnread = $("inboxTabUnread");
  let filter = "all";
  const feedQuery = () => (filter === "unread" ? "&unread=1" : "");
  const emptyText = () => (filter === "unread" ? "No unread messages" : `No messages from ${agentName} yet`);
  const closeBtn = $("inboxClose");
  const markAllBtn = $("inboxMarkAll");
  const newBtn = $("inboxNew");
  const sentinelEl = el("div", "inbox-sentinel");
  sentinelEl.setAttribute("aria-hidden", "true");

  let open = false;
  let loaded = false;
  let items = []; // normalised server rows, newest first
  let next = null; // cursor for the next older page, null at the end
  let loading = false;
  let headBusy = false;
  let unread = 0;
  let newAvailable = false;
  let backPending = null;
  let resolveBack = null;

  // ---------- rendering ----------

  function rowNode(item) {
    const row = el("button", `inbox-row ${item.read ? "read" : "unread"}`);
    row.type = "button";
    row.dataset.id = String(item.id);
    const top = el("div", "inbox-row-top");
    if (item.home) top.append(homeIcon());
    top.append(el("span", "inbox-thread", item.thread));
    const label = formatTime(item.ts);
    if (label) {
      const time = el("time", "inbox-time", label);
      time.dateTime = new Date(item.ts * 1000).toISOString();
      top.append(time);
    }
    row.append(top, el("div", "inbox-text", stripCronWrapper(item.text)));
    row.addEventListener("click", () => void activate(item));
    return row;
  }

  function dateNode(ts) {
    return el("div", "inbox-date", dayLabel(ts));
  }

  function setEmpty() {
    emptyEl.hidden = loaded ? items.length > 0 : true;
    listEl.hidden = loaded ? items.length === 0 : true;
  }

  function renderAll() {
    listEl.replaceChildren();
    let last = null;
    for (const item of items) {
      const key = dayStamp(item.ts);
      if (key !== last) {
        listEl.append(dateNode(item.ts));
        last = key;
      }
      listEl.append(rowNode(item));
    }
    if (items.length) listEl.append(sentinelEl);
    loaded = true;
    setEmpty();
  }

  // Paging appends; a date header is added only when the day changes from the row above, so a page boundary in the
  // middle of a day does not repeat it.
  function appendPage(page) {
    if (!page.length) return;
    const from = items.length;
    items = items.concat(page);
    let last = from ? dayStamp(items[from - 1].ts) : null;
    sentinelEl.remove();
    for (let at = from; at < items.length; at += 1) {
      const item = items[at];
      const key = dayStamp(item.ts);
      if (key !== last) {
        listEl.append(dateNode(item.ts));
        last = key;
      }
      listEl.append(rowNode(item));
    }
    listEl.append(sentinelEl);
    loaded = true;
    setEmpty();
  }

  function syncReadMarks() {
    for (const node of listEl.querySelectorAll(".inbox-row")) {
      const item = items.find((entry) => String(entry.id) === node.dataset.id);
      if (!item) continue;
      node.classList.toggle("read", item.read);
      node.classList.toggle("unread", !item.read);
    }
  }

  // ---------- data ----------

  // The head is the newest page. If new items arrive while the list is scrolled away from the top, the list stays put
  // and the "New" pill appears instead of yanking the view.
  async function loadHead({ reset = false } = {}) {
    if (headBusy) return;
    headBusy = true;
    try {
      const data = await api(`${INBOX_API}?limit=${PAGE}${feedQuery()}`);
      const fresh = listFrom(data);
      if (reset || !items.length) {
        items = fresh;
        next = typeof data.next === "string" ? data.next : null;
        renderAll();
        return;
      }
      const newest = items[0];
      const incoming = Boolean(fresh[0]) && (!newest || fresh[0].id > newest.id);
      if (!incoming) {
        // Read marks may have changed on another device: merge them without dropping paged-in older rows.
        for (const entry of fresh) {
          const item = items.find((row) => row.id === entry.id);
          if (item) item.read = entry.read;
        }
        // A head row that is no longer in the feed means its chat was deleted: at the top, rebuild from the server.
        const headIds = new Set(fresh.map((entry) => entry.id));
        const stale = fresh.length ? items.slice(0, fresh.length).some((item) => !headIds.has(item.id))
          : items.length > 0;
        if (stale && listEl.scrollTop <= TOP_PX) {
          items = fresh;
          next = typeof data.next === "string" ? data.next : null;
          renderAll();
        } else {
          syncReadMarks();
        }
        return;
      }
      if (listEl.scrollTop <= TOP_PX) {
        items = fresh;
        next = typeof data.next === "string" ? data.next : null;
        renderAll();
        listEl.scrollTop = 0;
      } else {
        newAvailable = true;
        newBtn.hidden = false;
      }
    } catch {
      // Offline or still signing in: keep the last feed rather than emptying it.
    } finally {
      headBusy = false;
    }
  }

  async function loadMore() {
    if (loading || next === null || next === undefined || !open) return;
    loading = true;
    try {
      const data = await api(`${INBOX_API}?limit=${PAGE}&before=${encodeURIComponent(next)}${feedQuery()}`);
      const page = listFrom(data);
      next = typeof data.next === "string" ? data.next : null;
      appendPage(page);
      // A short feed with more to come may not fill the screen: keep the sentinel in reach.
      if (next !== null && listEl.scrollHeight <= listEl.clientHeight + 240) void loadMore();
    } catch {
      /* the next scroll retries */
    } finally {
      loading = false;
    }
  }

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadMore();
  }, { root: listEl, rootMargin: "240px 0px" });
  observer.observe(sentinelEl);

  // ---------- badge ----------

  function setUnread(count) {
    unread = count;
    countEl.textContent = count > 99 ? "99+" : String(count);
    countEl.hidden = count === 0;
    markAllBtn.disabled = count === 0;
    // A closed envelope while anything is unread, the open tray once all is read.
    for (const id of ["inboxBtn", "inboxBack"]) document.getElementById(id)?.classList.toggle("has-unread", count > 0);
  }

  async function refreshBadge() {
    try {
      const data = await api(`${INBOX_API}/unread-count`);
      setUnread(Number(data && data.count) || 0);
    } catch {
      /* keep the last count: the next poll retries */
    }
  }

  // ---------- actions ----------

  async function markRead(ids) {
    try {
      await api(`${INBOX_API}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    } catch {
      /* the row still reads as read here; the next view retries */
    }
  }

  // Tapping a row: mark it read, close the panel (on every screen since it hangs over the chat; the person, 8 Nov 2026),
  // then open the chat at that message (the notification deep link).
  async function activate(item) {
    if (!item.read) {
      item.read = true;
      syncReadMarks();
      await markRead([item.id]);
    }
    await closePanel();
    try {
      await openMessage(item.session_id, item.id);
    } catch {
      /* openTarget reports a message it cannot find */
    }
    void refreshBadge();
  }

  async function markAll() {
    if (!unread) return;
    markAllBtn.disabled = true;
    try {
      // {} lets the server cover the whole feed right now, not only what has been scrolled into view.
      const data = await api(`${INBOX_API}/read-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const watermark = Number(data && data.watermark) || 0;
      for (const item of items) if (item.id <= watermark) item.read = true;
      syncReadMarks();
      setUnread(0);
      if (filter === "unread") void loadHead({ reset: true }); // everything on the Unread tab is read now
    } catch {
      markAllBtn.disabled = unread === 0;
    }
  }

  // ---------- open / close, with one history entry per open ----------

  // The panel hangs from the agent's photo: its top sits just under the photo and name, a small
  // pointer on its top edge points at the photo, and it reaches down to the bottom of the visual viewport (a phone's
  // keyboard included). Phones get the full width; wider screens a card up to half the active screen width (min 440px)
  // centred on the photo, kept on screen.
  function place() {
    const vv = window.visualViewport;
    const vLeft = vv ? vv.offsetLeft : 0;
    const vTop = vv ? vv.offsetTop : 0;
    const vWidth = vv ? vv.width : window.innerWidth;
    const vHeight = vv ? vv.height : window.innerHeight;
    const photo = btn.querySelector(".avatar") || btn;
    const anchor = photo.getBoundingClientRect();
    const whole = btn.getBoundingClientRect();
    const centre = anchor.left + anchor.width / 2;
    const top = Math.max(vTop + 8, whole.bottom + 12);
    const phone = window.matchMedia("(max-width: 640px)").matches;
    const width = phone ? vWidth : Math.min(Math.max(440, Math.round(vWidth * 0.5)), vWidth - 32);
    const left = phone ? vLeft : Math.min(Math.max(vLeft + 16, centre - width / 2), vLeft + vWidth - 16 - width);
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
    dialog.style.width = `${width}px`;
    dialog.style.height = `${Math.max(200, vTop + vHeight - top - (phone ? 0 : 16))}px`;
    dialog.style.setProperty("--caret-x", `${Math.round(centre - left)}px`);
  }

  function openPanel() {
    if (open) return;
    if (backPending) {
      // The previous close's history.back() has not landed yet; open once it has, so the entries stay in step.
      backPending.then(openPanel);
      return;
    }
    open = true;
    items = [];
    next = null;
    loaded = false;
    newAvailable = false;
    newBtn.hidden = true;
    listEl.replaceChildren();
    listEl.hidden = true;
    emptyEl.hidden = true;
    place();
    scrim.classList.add("open");
    dialog.classList.add("open");
    document.body.classList.add("inbox-open");
    btn.setAttribute("aria-expanded", "true");
    if (!(history.state && history.state.hermesMiniInbox === true)) history.pushState({ hermesMiniInbox: true }, "");
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
    requestAnimationFrame(() => {
      if (open) dialog.focus({ preventScroll: true });
    });
    void Promise.all([loadHead({ reset: true }), refreshBadge()]);
  }

  // An in-app close consumes the history entry it pushed; a Back-button close has already popped it. Returns a promise
  // that settles once the entry is gone, so another panel can open without racing this one's history.back().
  function closePanel({ viaPop = false } = {}) {
    if (!open) return Promise.resolve();
    open = false;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    document.body.classList.remove("inbox-open");
    btn.setAttribute("aria-expanded", "false");
    btn.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniInbox === true) {
      backPending = new Promise((resolve) => {
        resolveBack = resolve;
      });
      history.back();
      return backPending;
    }
    return Promise.resolve();
  }

  function messageComplete() {
    void refreshBadge();
    if (open) void loadHead();
  }

  // ---------- events ----------

  closeBtn.addEventListener("click", () => void closePanel());
  scrim.addEventListener("click", () => void closePanel());
  markAllBtn.addEventListener("click", () => void markAll());
  function setFilter(next) {
    if (next === filter) return;
    filter = next;
    for (const [tab, name] of [[tabAll, "all"], [tabUnread, "unread"]]) {
      tab.classList.toggle("active", filter === name);
      tab.setAttribute("aria-selected", String(filter === name));
    }
    emptyEl.textContent = emptyText();
    newAvailable = false;
    newBtn.hidden = true;
    listEl.scrollTop = 0;
    void loadHead({ reset: true });
  }
  tabAll.addEventListener("click", () => setFilter("all"));
  tabUnread.addEventListener("click", () => setFilter("unread"));
  newBtn.addEventListener("click", () => {
    newAvailable = false;
    newBtn.hidden = true;
    listEl.scrollTop = 0;
    void loadHead({ reset: true });
  });

  const reposition = () => {
    if (open) place();
  };
  window.addEventListener("resize", reposition);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", reposition);
    window.visualViewport.addEventListener("scroll", reposition);
  }

  // Its own history entry. The popstate from our history.back() only settles the pending close; a Back press closes
  // the panel and leaves whatever is underneath open (same shape as todo.js).
  window.addEventListener("popstate", (event) => {
    if (resolveBack) {
      const resolve = resolveBack;
      resolveBack = null;
      backPending = null;
      resolve();
      event.stopImmediatePropagation();
      return;
    }
    if (open && !(event.state && event.state.hermesMiniInbox === true)) {
      void closePanel({ viaPop: true });
      event.stopImmediatePropagation();
    }
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void closePanel();
        return;
      }
      if (event.key === "Tab") {
        const nodes = [...dialog.querySelectorAll("button:not([disabled])")];
        if (!nodes.length) return;
        event.preventDefault();
        const index = nodes.indexOf(document.activeElement);
        const nextNode = event.shiftKey
          ? (index <= 0 ? nodes.length - 1 : index - 1)
          : (index === -1 || index === nodes.length - 1 ? 0 : index + 1);
        nodes[nextNode].focus({ preventScroll: true });
      }
    },
    true,
  );

  // The badge poll (only while visible) and the open panel's head poll.
  setInterval(() => {
    if (!document.hidden) void refreshBadge();
  }, BADGE_POLL_MS);
  setInterval(() => {
    if (open) void loadHead();
  }, NEW_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void refreshBadge();
    if (open) void loadHead();
  });

  return {
    open: openPanel,
    close: closePanel,
    refresh: refreshBadge,
    refreshBadge,
    messageComplete,
    isOpen: () => open,
  };
}
