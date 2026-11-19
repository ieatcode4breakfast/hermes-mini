// Artifacts: the pictures, files and links the agent produced across the app's chats, newest first. Every open reads
// plugin_api.py's /artifacts route; the panel stores nothing and changes nothing. A picture opens the full-screen
// viewer, a file downloads through the chat's own open (app.js openFile), a link opens in a new tab. Each row's ⋮ menu
// (also a right click, or a long press on a picture) opens the chat the artifact came from or copies its path or link.
// It mirrors To-do and Schedules: one history entry per open, the same centred card on a computer and the same
// full-screen presentation, with the Back arrow on the left, on a phone.

import { openPopover, closePopover } from "./toast.js";

const ARTIFACTS_API = "/api/plugins/hermes-mini/artifacts";
const $ = (id) => document.getElementById(id);
const DOTS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const CHAT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
const LONG_PRESS_MS = 480;
// What the All tab shows of each kind; its "See all N" opens that kind's tab with everything.
const PREVIEW = { image: 8, file: 5, link: 5 };
const TITLES = { image: "Images", file: "Files", link: "Links" };
const KINDS = ["image", "file", "link"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The only remote address a picture may load from. Only an explicit https:// value qualifies: a local path (absolute
// or ~/...) is never resolved against the page, and any other scheme returns "", so it never reaches an <img> source.
function httpsSource(value) {
  const text = String(value || "").trim();
  if (!/^https:\/\//i.test(text)) return "";
  try {
    return new URL(text).href;
  } catch {
    return "";
  }
}

// "report.final.PDF" -> "PDF"; a file without a suffix reads as FILE.
function extension(value) {
  const name = String(value || "").split(/[?#]/)[0].split("/").pop() || "";
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match ? match[1].toUpperCase() : "FILE";
}

function normalise(raw, index) {
  const kind = raw && (raw.kind === "image" || raw.kind === "link") ? raw.kind : "file";
  return {
    key: `${String((raw && raw.id) || "")}-${index}`,
    kind,
    value: String((raw && raw.value) || ""),
    label: String((raw && raw.label) || (raw && raw.value) || ""),
    session_id: String((raw && raw.session_id) || ""),
    message_id: Number((raw && raw.message_id) || 0),
    ts: Number((raw && raw.ts) || 0),
    thread: String((raw && raw.thread) || ""),
  };
}

export function createArtifacts({ api, openViewer, fetchMedia, openFile, openMessage, formatTime, showToast }) {
  const btn = $("artBtn");
  const scrim = $("artScrim");
  const dialog = $("artDialog");
  const body = $("artBody");
  const search = $("artSearch");
  const tabs = [...document.querySelectorAll('#artTabs [role="tab"]')];

  let open = false;
  let loadSeq = 0;
  let backPending = null; // a history.back() from an in-app close is still in flight
  let resolveBack = null;
  let items = [];
  let truncated = false;
  let query = "";
  let tab = "all";
  let viewerTiles = []; // the picture tiles on screen, in order, each with its loaded source
  let observer = null;

  // ---------- the row menu: the chat list's ⋮ card (style.css .row-menu), filled per artifact ----------
  const menuScrim = document.createElement("div");
  menuScrim.className = "scrim art-menu-scrim";
  menuScrim.setAttribute("aria-hidden", "true");
  menuScrim.setAttribute("popover", "manual");
  const menuEl = document.createElement("div");
  menuEl.className = "row-menu art-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.setAttribute("aria-label", "Artifact actions");
  menuEl.setAttribute("popover", "manual");
  document.body.append(menuScrim, menuEl);
  let menu = null; // { item, anchor, node } while open
  let pressOpenedAt = 0; // when a long press opened the menu: the lifting finger's click must not act
  let menuBack = null;
  let resolveMenuBack = null;

  // `now`: run the action inside the tap itself, before the menu closes. Copying needs that: iPhone Safari only lets a
  // page write the clipboard during the user's tap, and closing the menu first waits for a history step.
  function menuItem(label, icon, pick, { now = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row-menu-item";
    button.setAttribute("role", "menuitem");
    button.innerHTML = `${icon}<span>${label}</span>`;
    button.addEventListener("click", () => {
      if (Date.now() - pressOpenedAt < 600) return; // the long press's own lift, not a choice
      if (now) {
        pick();
        void closeMenu();
        return;
      }
      void closeMenu().then(pick);
    });
    return button;
  }

  // Under the anchor (right edges together), flipped above it near the bottom, kept 8px inside the screen.
  function placeMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = menuEl.offsetWidth;
    const h = menuEl.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  }

  function openMenu(item, node) {
    if (menu) return;
    if (menuBack) {
      menuBack.then(() => openMenu(item, node));
      return;
    }
    const anchor = node.querySelector(".art-dots") || node;
    menu = { item, anchor, node };
    menuEl.replaceChildren(
      menuItem("Open chat", CHAT_ICON, () => openChat(item)),
      menuItem(item.kind === "link" ? "Copy link" : "Copy path", COPY_ICON, () => void copy(item.value), { now: true }),
    );
    node.classList.add("menu-open");
    anchor.setAttribute("aria-expanded", "true");
    // Top layer first (still in its closed state), so its size can be measured before it is placed.
    openPopover(menuScrim);
    openPopover(menuEl);
    placeMenu(anchor);
    menuScrim.classList.add("open");
    menuEl.classList.add("open");
    if (!(history.state && history.state.hermesMiniArtMenu === true)) history.pushState({ hermesMiniArtMenu: true }, "");
    menuEl.querySelector(".row-menu-item").focus({ preventScroll: true });
  }

  function closeMenu({ viaPop = false } = {}) {
    const m = menu;
    if (!m) return Promise.resolve();
    menu = null;
    m.node.classList.remove("menu-open");
    m.anchor.setAttribute("aria-expanded", "false");
    menuScrim.classList.remove("open");
    menuEl.classList.remove("open");
    // Out of the top layer once the fade-out has played.
    closePopover(menuScrim, 160);
    closePopover(menuEl, 160);
    if (m.anchor.isConnected) m.anchor.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniArtMenu === true) {
      menuBack = new Promise((resolve) => {
        resolveMenuBack = resolve;
      });
      history.back();
      return menuBack;
    }
    return Promise.resolve();
  }

  menuScrim.addEventListener("click", () => {
    if (Date.now() - pressOpenedAt < 600) return; // the long press's own lift lands here
    void closeMenu();
  });
  menuEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      void closeMenu();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const list = [...menuEl.querySelectorAll(".row-menu-item")];
    const i = list.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1
      : (i + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    list[next].focus();
  });

  // ---------- actions ----------
  async function openChat(item) {
    await closePanel();
    if (item.session_id) void openMessage(item.session_id, item.message_id);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      if (typeof showToast === "function") showToast("Copied");
    } catch {
      if (typeof showToast === "function") showToast("Couldn't copy", "error");
    }
  }

  // ---------- pictures ----------
  function clearTiles() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    viewerTiles = [];
  }

  function failTile(entry) {
    entry.node.classList.add("failed");
    entry.label.hidden = false;
  }

  // Lazy: a tile asks for its picture only when it is near the viewport (IntersectionObserver below).
  function loadTile(entry) {
    if (entry.loading) return;
    entry.loading = true;
    const value = entry.item.value;
    const remote = httpsSource(value);
    // A value with a URL scheme that is not https is not a path this Hermes can read, so nothing is loaded for it.
    const isPath = !/^[a-z][a-z0-9+.-]*:/i.test(value);
    const source = remote ? Promise.resolve(remote)
      : isPath ? Promise.resolve(fetchMedia(entry.item.value)) : Promise.resolve("");
    source
      .then((url) => (typeof url === "string" && (url.startsWith("data:image/") || (remote && url === remote))
        ? url : ""))
      .then((url) => {
        if (!url) {
          failTile(entry);
          return;
        }
        entry.url = url;
        entry.img.src = url;
        entry.node.classList.add("loaded");
      })
      .catch(() => failTile(entry));
  }

  function observeTiles(entries, byNode) {
    if (typeof IntersectionObserver !== "function") {
      for (const entry of entries) loadTile(entry);
      return;
    }
    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        observer.unobserve(record.target);
        const entry = byNode.get(record.target);
        if (entry) loadTile(entry);
      }
    }, { root: body, rootMargin: "200px" });
    for (const entry of entries) observer.observe(entry.node);
  }

  function tile(item) {
    const node = el("button", "art-tile");
    node.type = "button";
    node.setAttribute("aria-label", item.label || "Picture");
    const img = el("img");
    img.alt = "";
    img.decoding = "async";
    const label = el("span", "art-tile-label", item.label);
    label.hidden = true;
    node.append(img, label);
    const entry = { item, node, img, label, url: "", loading: false };
    img.addEventListener("error", () => failTile(entry));
    viewerTiles.push(entry);
    node.addEventListener("click", () => {
      if (Date.now() - pressOpenedAt < 600) return;
      const loaded = viewerTiles.filter((one) => one.url);
      const index = loaded.indexOf(entry);
      if (index < 0) return;
      openViewer(loaded.map((one) => ({ url: one.url, alt: one.item.label })), index);
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(item, node);
    });
    addLongPress(node, item);
    return entry;
  }

  function imageGrid(list) {
    const grid = el("div", "art-grid");
    const entries = [];
    const byNode = new Map();
    for (const item of list) {
      const entry = tile(item);
      entries.push(entry);
      byNode.set(entry.node, entry);
      grid.append(entry.node);
    }
    observeTiles(entries, byNode);
    return grid;
  }

  // ---------- files and links ----------
  function row(item) {
    const node = el("div", "art-row");
    const main = el("button", "art-row-main");
    main.type = "button";
    main.setAttribute("aria-label", item.kind === "link" ? `Open ${item.label}` : `Download ${item.label}`);
    const icon = el("span", "art-row-icon");
    if (item.kind === "link") icon.innerHTML = LINK_ICON;
    else icon.textContent = extension(item.value);
    const text = el("span", "art-row-text");
    text.append(el("span", "art-row-title", item.label));
    const when = typeof formatTime === "function" ? formatTime(item.ts) : "";
    text.append(el("span", "art-row-meta", [item.thread || "Chat", when].filter(Boolean).join(" · ")));
    main.append(icon, text);
    main.addEventListener("click", () => {
      if (Date.now() - pressOpenedAt < 600) return;
      if (item.kind === "link") window.open(item.value, "_blank", "noopener");
      else openFile(item.value, item.label);
    });
    const dots = el("button", "art-dots");
    dots.type = "button";
    dots.setAttribute("aria-label", `Options for ${item.label}`);
    dots.setAttribute("aria-haspopup", "menu");
    dots.setAttribute("aria-expanded", "false");
    dots.innerHTML = DOTS_ICON;
    dots.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(item, node);
    });
    node.append(main, dots);
    // The chat list's other ways in: a right click, or a long press on touch (a move of more than 8px is a scroll).
    node.addEventListener("contextmenu", (event) => {
      if (event.target.closest(".art-dots")) return;
      event.preventDefault();
      openMenu(item, node);
    });
    addLongPress(node, item, ".art-dots");
    return node;
  }

  function addLongPress(node, item, skip = "") {
    let press = null;
    node.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || (skip && event.target.closest(skip))) return;
      const start = { x: event.clientX, y: event.clientY };
      press = { start, timer: setTimeout(() => {
        press = null;
        try {
          navigator.vibrate?.(10);
        } catch {
          /* optional */
        }
        pressOpenedAt = Date.now();
        openMenu(item, node);
      }, LONG_PRESS_MS) };
    });
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    node.addEventListener("pointermove", (event) => {
      if (press && Math.hypot(event.clientX - press.start.x, event.clientY - press.start.y) > 8) cancel();
    });
    node.addEventListener("pointerup", cancel);
    node.addEventListener("pointercancel", cancel);
  }

  // ---------- rendering ----------
  function state(message, { retry = false } = {}) {
    const box = el("div", "art-state");
    box.setAttribute("role", "status");
    box.append(el("p", "art-state-text", message));
    if (retry) {
      const button = el("button", "art-retry", "Retry");
      button.type = "button";
      button.addEventListener("click", () => void refresh());
      box.append(button);
    }
    return box;
  }

  function section(kind, list, full) {
    const wrap = el("section", "art-section");
    const head = el("div", "art-sec-head");
    const title = el("h3", "art-sec-title");
    title.append(`${TITLES[kind]} `, el("span", "art-sec-count", String(list.length)));
    head.append(title);
    const shown = full ? list : list.slice(0, PREVIEW[kind]);
    if (!full) {
      const seeAll = el("button", "art-seeall", `See all ${list.length}`);
      seeAll.type = "button";
      seeAll.addEventListener("click", () => setTab(kind));
      head.append(seeAll);
    }
    wrap.append(head);
    if (kind === "image") {
      wrap.append(imageGrid(shown));
    } else {
      const rows = el("div", "art-rows");
      rows.append(...shown.map(row));
      wrap.append(rows);
    }
    return wrap;
  }

  function updateTabs(total, groups) {
    for (const button of tabs) {
      const key = button.dataset.tab;
      const count = key === "all" ? total : groups[key].length;
      button.querySelector(".art-tab-count").textContent = String(count);
    }
  }

  function render() {
    clearTiles();
    const q = query.trim().toLowerCase();
    const visible = items.filter((item) => !q
      || item.label.toLowerCase().includes(q)
      || item.value.toLowerCase().includes(q)
      || item.thread.toLowerCase().includes(q));
    const groups = { image: [], file: [], link: [] };
    for (const item of visible) groups[item.kind].push(item);
    updateTabs(visible.length, groups);

    const nodes = [];
    if (!visible.length) {
      nodes.push(state(items.length ? "No matches" : "Pictures, files and links from your chats show up here."));
    } else if (tab === "all") {
      for (const kind of KINDS) {
        if (groups[kind].length) nodes.push(section(kind, groups[kind], false));
      }
    } else if (!groups[tab].length) {
      nodes.push(state("No matches"));
    } else {
      nodes.push(section(tab, groups[tab], true));
    }
    if (truncated) nodes.push(el("p", "art-note", "Showing the most recent items"));
    body.replaceChildren(...nodes);
  }

  function setTab(key, { focus = false } = {}) {
    tab = key;
    for (const button of tabs) {
      const selected = button.dataset.tab === key;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (!selected) continue;
      body.setAttribute("aria-labelledby", button.id);
      if (focus) button.focus({ preventScroll: true });
    }
    body.scrollTop = 0;
    render();
  }

  for (const button of tabs) {
    button.tabIndex = button.dataset.tab === tab ? 0 : -1;
    button.addEventListener("click", () => setTab(button.dataset.tab));
  }
  $("artTabs").addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let next = null;
    if (step !== undefined) next = (index + step + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    setTab(tabs[next].dataset.tab, { focus: true });
  });
  search.addEventListener("input", () => {
    query = search.value;
    render();
  });

  async function refresh() {
    const seq = ++loadSeq;
    if (!items.length) body.replaceChildren(state("Loading…"));
    try {
      const data = await api(ARTIFACTS_API);
      if (seq !== loadSeq) return;
      const raw = data && Array.isArray(data.items) ? data.items : [];
      items = raw.map(normalise);
      truncated = Boolean(data && data.truncated);
      render();
    } catch {
      if (seq !== loadSeq) return;
      clearTiles();
      items = [];
      truncated = false;
      updateTabs(0, { image: [], file: [], link: [] });
      body.replaceChildren(state("Couldn't load artifacts", { retry: true }));
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
    document.body.classList.add("art-open");
    btn.setAttribute("aria-expanded", "true");
    if (!(history.state && history.state.hermesMiniArt === true)) history.pushState({ hermesMiniArt: true }, "");
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
    requestAnimationFrame(() => {
      if (open) dialog.focus({ preventScroll: true });
    });
    body.scrollTop = 0;
    void refresh();
  }

  function closePanel({ viaPop = false } = {}) {
    if (!open) return Promise.resolve();
    if (menu && !viaPop) return closeMenu().then(() => closePanel());
    if (menu) void closeMenu({ viaPop: true });
    open = false;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    document.body.classList.remove("art-open");
    btn.setAttribute("aria-expanded", "false");
    // Back to the Artifacts row when it is on screen (a docked chats panel); otherwise to the chats button.
    const back = btn.offsetParent ? btn : document.getElementById("menuBtn");
    if (back && back.offsetParent) back.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniArt === true) {
      backPending = new Promise((resolve) => {
        resolveBack = resolve;
      });
      history.back();
      return backPending;
    }
    return Promise.resolve();
  }

  $("artClose").addEventListener("click", () => closePanel());
  $("artBack").addEventListener("click", () => closePanel());
  scrim.addEventListener("click", () => closePanel());
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", () => open && place());
  // The menu is fixed-position in the top layer: re-place it too if the window or the visible area changes.
  const rePlaceMenu = () => {
    if (menu) placeMenu(menu.anchor);
  };
  window.addEventListener("resize", rePlaceMenu);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", rePlaceMenu);
    window.visualViewport.addEventListener("scroll", rePlaceMenu);
  }
  window.addEventListener("popstate", (event) => {
    if (resolveMenuBack) {
      const resolve = resolveMenuBack;
      resolveMenuBack = null;
      menuBack = null;
      resolve();
      event.stopImmediatePropagation();
      return;
    }
    if (menu && !(event.state && event.state.hermesMiniArtMenu === true)) {
      void closeMenu({ viaPop: true });
      event.stopImmediatePropagation();
      return;
    }
    if (resolveBack) {
      const resolve = resolveBack;
      resolveBack = null;
      backPending = null;
      resolve();
      event.stopImmediatePropagation();
      return;
    }
    if (open && !(event.state && event.state.hermesMiniArt === true)) {
      closePanel({ viaPop: true });
      event.stopImmediatePropagation();
    }
  });

  setTab("all");

  return { open: openPanel, close: closePanel, isOpen: () => open, refresh };
}
