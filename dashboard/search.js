// Search: one field over the app's chats, both chat titles and the visible text of the person's and the agent's
// messages. Every query reads plugin_api.py /search, which resolves hits against state.db with the Inbox's own scope
// and visibility rules - so a hit is always something the chat draws. A chat hit opens that chat; a message hit opens
// it at that message (app.js openTarget, with the Loading message... toast and the flash). Like the To-do, Schedules
// and Bookmarks panels: one history entry per open, a centred card on a computer and a full-screen page on a phone,
// with the Back arrow on the left.

const SEARCH_API = "/api/plugins/hermes-mini/search";
const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_EMPTY_TEXT = "Search chat titles and messages.";
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normaliseChat(raw) {
  return {
    session_id: String((raw && raw.session_id) || ""),
    title: String((raw && raw.title) || "") || "Untitled",
    home: Boolean(raw && raw.home),
    ts: Number((raw && raw.ts) || 0),
  };
}

function normaliseMessage(raw) {
  return {
    id: Number(raw && raw.id),
    session_id: String((raw && raw.session_id) || ""),
    thread: String((raw && raw.thread) || "") || "Chat",
    home: Boolean(raw && raw.home),
    role: String((raw && raw.role) || "assistant"),
    ts: Number((raw && raw.ts) || 0),
    snippet: String((raw && raw.snippet) || ""),
  };
}

// The query's words, longest first so a shorter word never wins the first split of a longer one.
function queryTerms(query) {
  return [...new Set(String(query || "").toLowerCase().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
}

// Highlights every match of the query's terms in `text`, strictly with text nodes and <mark> elements: chat and message
// text is never parsed as HTML.
function highlight(value, query) {
  const text = String(value || "");
  const frag = document.createDocumentFragment();
  const terms = queryTerms(query);
  if (!terms.length) {
    frag.append(document.createTextNode(text));
    return frag;
  }
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    let hit = -1;
    let length = 0;
    for (const term of terms) {
      const found = lower.indexOf(term, at);
      if (found < 0 || (hit >= 0 && found >= hit)) continue;
      hit = found;
      length = term.length;
    }
    if (hit < 0) {
      frag.append(document.createTextNode(text.slice(at)));
      break;
    }
    if (hit > at) frag.append(document.createTextNode(text.slice(at, hit)));
    const mark = document.createElement("mark");
    mark.className = "search-hit";
    mark.textContent = text.slice(hit, hit + length);
    frag.append(mark);
    at = hit + length;
  }
  return frag;
}

export function createSearch({ api, openSession, openMessage, formatTime }) {
  const app = document.querySelector(".app");
  const btn = $("searchBtn");
  const scrim = $("searchScrim");
  const dialog = $("searchDialog");
  const input = $("searchInput");
  const clearBtn = $("searchClear");
  const results = $("searchResults");
  const empty = $("searchEmpty");

  let open = false;
  let loadSeq = 0;
  let debounceTimer = 0;
  let backPending = null; // a history.back() from an in-app close is still in flight
  let resolveBack = null;

  function place() {
    const vv = window.visualViewport;
    dialog.style.setProperty("--todo-vt", `${vv ? vv.offsetTop : 0}px`);
    dialog.style.setProperty("--todo-vh", `${vv ? vv.height : window.innerHeight}px`);
  }

  function resetResults() {
    results.replaceChildren();
    empty.textContent = SEARCH_EMPTY_TEXT;
    empty.hidden = false;
  }

  // ---------- rendering ----------
  function state(message, { retry = false } = {}) {
    const box = el("div", "bm-state");
    box.setAttribute("role", "status");
    box.append(el("p", "bm-state-text", message));
    if (retry) {
      const button = el("button", "bm-retry", "Retry");
      button.type = "button";
      button.addEventListener("click", () => void runSearch());
      box.append(button);
    }
    return box;
  }

  function groupHead(label) {
    return el("h3", "search-group-head", label);
  }

  function chatRow(item, query) {
    const row = el("button", "search-row search-chat");
    row.type = "button";
    row.setAttribute("aria-label", `Open chat: ${item.title}`);
    const head = el("span", "search-row-head");
    if (item.home) {
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      icon.classList.add("search-home");
      for (const d of ["M3 11l9-7 9 7", "M5 10v10h14V10"]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        icon.append(path);
      }
      head.append(icon);
    }
    const title = el("span", "search-row-title");
    title.append(highlight(item.title, query));
    head.append(title);
    const when = typeof formatTime === "function" ? formatTime(item.ts) : "";
    if (when) head.append(el("span", "search-row-time", when));
    row.append(head);
    row.addEventListener("click", () => {
      void closePanel().then(() => openSession(item.session_id));
    });
    return row;
  }

  function messageRow(item, query) {
    const row = el("button", "search-row search-msg");
    row.type = "button";
    row.setAttribute("aria-label", `Open message in ${item.thread}`);
    const head = el("span", "search-row-head");
    head.append(el("span", "search-row-title", item.thread));
    const when = typeof formatTime === "function" ? formatTime(item.ts) : "";
    if (when) head.append(el("span", "search-row-time", when));
    const snippet = el("span", "search-row-preview");
    if (item.role === "user") snippet.append(el("span", "search-who", "You: "));
    snippet.append(highlight(item.snippet, query));
    row.append(head, snippet);
    row.addEventListener("click", () => {
      void closePanel().then(() => openMessage(item.session_id, item.id));
    });
    return row;
  }

  function group(label, items, build) {
    const section = el("section", "search-group");
    section.setAttribute("aria-label", label);
    section.append(groupHead(label), ...items.map(build));
    return section;
  }

  function render(chats, messages, query) {
    results.replaceChildren();
    const hasResults = chats.length > 0 || messages.length > 0;
    empty.hidden = hasResults;
    if (!hasResults) {
      empty.textContent = "No matches";
      return;
    }
    const sections = [];
    if (chats.length) sections.push(group("Chats", chats, (item) => chatRow(item, query)));
    if (messages.length) sections.push(group("Messages", messages, (item) => messageRow(item, query)));
    results.append(...sections);
  }

  async function runSearch() {
    const query = input.value.trim();
    clearBtn.hidden = !input.value;
    if (!query) {
      loadSeq += 1;
      resetResults();
      return;
    }
    const seq = ++loadSeq;
    if (!results.querySelector(".search-group")) {
      results.replaceChildren(state("Searching…"));
      empty.hidden = true;
    }
    try {
      const data = await api(`${SEARCH_API}?q=${encodeURIComponent(query)}`);
      if (seq !== loadSeq) return;
      const chats = (data && Array.isArray(data.chats) ? data.chats : []).map(normaliseChat).filter((item) => item.session_id);
      const messages = (data && Array.isArray(data.messages) ? data.messages : [])
        .map(normaliseMessage).filter((item) => Number.isInteger(item.id) && item.session_id);
      render(chats, messages, query);
    } catch {
      if (seq !== loadSeq) return;
      empty.hidden = true;
      results.replaceChildren(state("Could not search chats.", { retry: true }));
    }
  }

  function debounced() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      void runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  function clearInput() {
    clearTimeout(debounceTimer);
    debounceTimer = 0;
    loadSeq += 1;
    input.value = "";
    clearBtn.hidden = true;
    resetResults();
    input.focus({ preventScroll: true });
  }

  // ---------- open / close, with one history entry per open ----------
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
    if (app) app.inert = true;
    btn.setAttribute("aria-expanded", "true");
    if (!(history.state && history.state.hermesMiniSearch === true)) {
      history.pushState({ hermesMiniSearch: true }, "");
    }
    requestAnimationFrame(() => {
      if (!open) return;
      input.focus({ preventScroll: true });
      if (input.value) input.select();
    });
  }

  function closePanel({ viaPop = false } = {}) {
    if (!open) return Promise.resolve();
    open = false;
    clearTimeout(debounceTimer);
    debounceTimer = 0;
    loadSeq += 1;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    if (app) app.inert = false;
    btn.setAttribute("aria-expanded", "false");
    input.value = "";
    clearBtn.hidden = true;
    resetResults();
    // Back to the Search row when it is on screen (a docked drawer); with the drawer closed, to the Chats button.
    const back = btn.offsetParent ? btn : $("menuBtn");
    if (back && back.offsetParent) back.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniSearch === true) {
      backPending = new Promise((resolve) => {
        resolveBack = resolve;
      });
      history.back();
      return backPending;
    }
    return Promise.resolve();
  }

  // A query is typed at once; Escape clears it first (a second Escape closes the panel). Enter searches immediately.
  input.addEventListener("input", () => {
    clearBtn.hidden = !input.value;
    debounced();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      clearTimeout(debounceTimer);
      debounceTimer = 0;
      void runSearch();
    }
  });
  clearBtn.addEventListener("click", () => clearInput());
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (input.value) clearInput();
    else void closePanel();
  });
  $("searchBack").addEventListener("click", () => closePanel());
  $("searchClose").addEventListener("click", () => closePanel());
  scrim.addEventListener("click", () => closePanel());
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
    if (open && !(event.state && event.state.hermesMiniSearch === true)) {
      void closePanel({ viaPop: true });
      event.stopImmediatePropagation();
    }
  });

  resetResults();

  return { open: openPanel, close: closePanel, isOpen: () => open };
}
