// Bookmarks: the agent replies the person kept across the app's chats, newest bookmark first. The store is
// plugin_api.py's /bookmarks (one small file of message ids); every open reads the route, which resolves each id
// against the chat history and leaves out a reply whose chat or message is gone. The panel also owns the ids the
// chat's action rows ask for. Like the To-do and Schedules panels: one history entry per open, a centred card on a
// computer and a full-screen page, with the Back arrow on the left, on a phone.

const BOOKMARKS_API = "/api/plugins/hermes-mini/bookmarks";
const $ = (id) => document.getElementById(id);
const BOOKMARKED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

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
    ts: Number((raw && raw.ts) || 0),
    text: String((raw && raw.text) || ""),
    bookmarked_at: Number((raw && raw.bookmarked_at) || 0),
  };
}

export function createBookmarks({ api, openMessage, formatTime, showToast, onChange }) {
  const btn = $("bookmarkBtn");
  const scrim = $("bmScrim");
  const dialog = $("bmDialog");
  const list = $("bmList");
  const empty = $("bmEmpty");

  let open = false;
  let loadSeq = 0;
  let backPending = null; // a history.back() from an in-app close is still in flight
  let resolveBack = null;
  let items = [];
  let ids = new Set();

  function changed() {
    if (typeof onChange === "function") onChange();
  }

  function has(id) {
    return ids.has(Number(id));
  }

  async function refreshIds() {
    try {
      const data = await api(`${BOOKMARKS_API}/ids`);
      const rawIds = data && Array.isArray(data.ids) ? data.ids : [];
      ids = new Set(rawIds.map(Number).filter((value) => Number.isInteger(value) && value > 0));
    } catch {
      /* offline: the buttons keep what they last knew */
    }
    return ids;
  }

  async function add(id) {
    await api(BOOKMARKS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: Number(id) }),
    });
    ids.add(Number(id));
    changed();
  }

  async function remove(id) {
    await api(`${BOOKMARKS_API}/${encodeURIComponent(id)}`, { method: "DELETE" });
    ids.delete(Number(id));
    changed();
  }

  // ---------- rendering ----------
  function state(message, { retry = false } = {}) {
    const box = el("div", "bm-state");
    box.setAttribute("role", "status");
    box.append(el("p", "bm-state-text", message));
    if (retry) {
      const button = el("button", "bm-retry", "Retry");
      button.type = "button";
      button.addEventListener("click", () => void refresh());
      box.append(button);
    }
    return box;
  }

  function showEmpty() {
    list.replaceChildren();
    empty.hidden = false;
  }

  async function removeRow(item, node, button) {
    button.disabled = true;
    try {
      await remove(item.id);
    } catch {
      button.disabled = false;
      if (typeof showToast === "function") showToast("Could not remove bookmark", "error");
      return;
    }
    if (typeof showToast === "function") showToast("Bookmark removed");
    node.remove();
    items = items.filter((one) => one.id !== item.id);
    if (!items.length) showEmpty();
  }

  function row(item) {
    const node = el("div", "bm-row");
    const main = el("button", "bm-row-main");
    main.type = "button";
    main.setAttribute("aria-label", `Open in chat: ${item.thread || "Chat"}`);
    const head = el("span", "bm-row-head");
    head.append(el("span", "bm-row-title", item.thread || "Chat"));
    const when = typeof formatTime === "function" ? formatTime(item.ts) : "";
    if (when) head.append(el("span", "bm-row-time", when));
    main.append(head, el("span", "bm-row-preview", item.text));
    main.addEventListener("click", () => {
      void closePanel().then(() => {
        if (item.session_id) openMessage(item.session_id, item.id);
      });
    });
    const removeButton = el("button", "bm-remove");
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", "Remove bookmark");
    removeButton.title = "Remove bookmark";
    removeButton.innerHTML = BOOKMARKED_ICON;
    removeButton.addEventListener("click", () => void removeRow(item, node, removeButton));
    node.append(main, removeButton);
    return node;
  }

  function render() {
    empty.hidden = true;
    if (!items.length) {
      showEmpty();
      return;
    }
    list.replaceChildren(...items.map(row));
  }

  async function refresh() {
    const seq = ++loadSeq;
    if (!items.length) {
      empty.hidden = true;
      list.replaceChildren(state("Loading…"));
    }
    try {
      const data = await api(BOOKMARKS_API);
      if (seq !== loadSeq) return;
      const raw = data && Array.isArray(data.items) ? data.items : [];
      items = raw.map(normalise).filter((item) => Number.isInteger(item.id) && item.id > 0);
      render();
    } catch {
      if (seq !== loadSeq) return;
      items = [];
      empty.hidden = true;
      list.replaceChildren(state("Couldn't load bookmarks", { retry: true }));
    }
  }

  // ---------- open / close, with one history entry per open ----------
  function place() {
    const vv = window.visualViewport;
    dialog.style.setProperty("--todo-vt", `${vv ? vv.offsetTop : 0}px`);
    dialog.style.setProperty("--todo-vh", `${vv ? vv.height : window.innerHeight}px`);
  }

  function openPanel() {
    if (open) return;
    if (backPending) {
      backPending.then(openPanel);
      return;
    }
    open = true;
    place();
    scrim.classList.add("open");
    dialog.classList.add("open");
    document.body.classList.add("bm-open");
    btn.setAttribute("aria-expanded", "true");
    if (!(history.state && history.state.hermesMiniBookmarks === true)) {
      history.pushState({ hermesMiniBookmarks: true }, "");
    }
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
    requestAnimationFrame(() => {
      if (open) dialog.focus({ preventScroll: true });
    });
    empty.hidden = true;
    list.scrollTop = 0;
    void refresh();
  }

  function closePanel({ viaPop = false } = {}) {
    if (!open) return Promise.resolve();
    open = false;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    document.body.classList.remove("bm-open");
    btn.setAttribute("aria-expanded", "false");
    // Back to the Bookmarks button while the tray is out; otherwise to the Tools button that folded it away.
    const back = document.body.classList.contains("tools-open") ? btn : $("toolsBtn");
    if (back) back.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniBookmarks === true) {
      backPending = new Promise((resolve) => {
        resolveBack = resolve;
      });
      history.back();
      return backPending;
    }
    return Promise.resolve();
  }

  $("bmClose").addEventListener("click", () => closePanel());
  $("bmBack").addEventListener("click", () => closePanel());
  scrim.addEventListener("click", () => closePanel());
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", () => open && place());
  window.addEventListener("popstate", (event) => {
    if (resolveBack) {
      const resolve = resolveBack;
      resolveBack = null;
      backPending = null;
      resolve();
      event.stopImmediatePropagation();
      return;
    }
    if (open && !(event.state && event.state.hermesMiniBookmarks === true)) {
      closePanel({ viaPop: true });
      event.stopImmediatePropagation();
    }
  });

  showEmpty();

  return { open: openPanel, close: closePanel, isOpen: () => open, ids: () => ids, has, add, remove, refreshIds };
}
