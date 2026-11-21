// To-do list panel. The list is the app's own data, kept by plugin_api.py at /api/plugins/hermes-mini/
// todos; this module owns the dialog's DOM, the count badge and the optimistic checkbox, and nothing else in the app
// depends on it. Every change re-renders from the list the server returns, so two devices converge.
// The history entry follows confirm.js exactly: one entry is pushed on open, every in-app close consumes it with
// history.back(), and a Back press pops it and only closes this panel, so Back never leaves the app.

import { confirmDialog } from "./confirm.js";
import { showToast, openPopover, closePopover } from "./toast.js";

const TODOS_API = "/api/plugins/hermes-mini/todos";

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgIcon(paths) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const CHECK_ICON = ["M5 12l4.5 4.5L19 7"];
const GRIP_ICON = ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"];
const DELETE_ICON = ["M6 6l12 12", "M18 6L6 18"];
const PLUS_ICON = ["M12 5v14", "M5 12h14"];
const EYE_ICON = [
  "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z",
  "M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z",
];
const EYE_OFF_ICON = [
  "M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68",
  "M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61",
  "M9.88 9.88a3 3 0 1 0 4.24 4.24",
  "M2 2l20 20",
];
const DOTS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></svg>';
const EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><path d="M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M2 2l20 20"/></svg>';

// The server's list, kept to the fields the panel uses. A missing or odd field never breaks a render. "indent" is one
// level of nesting at most: 1 is a child of the nearest open item above it, anything else is top
// level, so a list saved before nesting existed reads as flat.
function normalise(raw) {
  return {
    id: String(raw.id || ""),
    text: String(raw.text || ""),
    done: raw.done === true,
    created: Number(raw.created) || 0,
    done_at: raw.done === true && Number(raw.done_at) ? Number(raw.done_at) : null,
    indent: raw.indent === 1 ? 1 : 0,
    tracked: raw.tracked !== false,
  };
}

function listFrom(payload) {
  const raw = payload && Array.isArray(payload.items) ? payload.items : [];
  // A blank entry has text "" and is a real row, so only a missing id drops an item here.
  return raw.filter((item) => item && typeof item === "object").map(normalise).filter((item) => item.id);
}

export function createTodo({ api }) {
  const btn = $("todoBtn");
  const countEl = $("todoCount");
  const scrim = $("todoScrim");
  const dialog = $("todoDialog");
  const listEl = $("todoList");
  const closeBtn = $("todoClose");
  const confirmEl = $("confirmDialog");

  let open = false;
  let items = []; // last list the server returned, in stored order (newest open item first)
  let backPending = null; // promise: a history.back() from an in-app close is still in flight
  let resolveBack = null;

  // ---------- parent row menu (⋮): Track/Untrack and Delete, top-layer popover like schedules.js ----------
  const menuScrim = document.createElement("div");
  menuScrim.className = "scrim todo-menu-scrim";
  menuScrim.setAttribute("aria-hidden", "true");
  menuScrim.setAttribute("popover", "manual");
  const menuEl = document.createElement("div");
  menuEl.className = "row-menu todo-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.setAttribute("aria-label", "To-do actions");
  menuEl.setAttribute("popover", "manual");
  document.body.append(menuScrim, menuEl);
  let menu = null; // { item, anchor, row } while open
  let menuBack = null;
  let resolveMenuBack = null;

  function menuItem(label, iconSvg, pick, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `row-menu-item${danger ? " danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.innerHTML = `${iconSvg}<span>${label}</span>`;
    button.addEventListener("click", () => {
      void closeMenu().then(pick);
    });
    return button;
  }

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

  function openMenu(item, rowEl) {
    if (menu || item.pending || item.draft) return;
    if (menuBack) {
      menuBack.then(() => openMenu(item, rowEl));
      return;
    }
    const anchor = rowEl.querySelector(".todo-dots") || rowEl;
    menu = { item, anchor, row: rowEl };
    const tracked = item.tracked !== false;
    const choices = [
      menuItem(tracked ? "Untrack" : "Track", tracked ? EYE_OFF_SVG : EYE_SVG, () => void toggleTrack(item)),
      menuItem("Delete", TRASH_SVG, () => void remove(item), true),
    ];
    menuEl.replaceChildren(...choices);
    rowEl.classList.add("menu-open");
    anchor.setAttribute("aria-expanded", "true");
    openPopover(menuScrim);
    openPopover(menuEl);
    placeMenu(anchor);
    menuScrim.classList.add("open");
    menuEl.classList.add("open");
    if (!(history.state && history.state.hermesMiniTodoMenu === true)) history.pushState({ hermesMiniTodoMenu: true }, "");
    choices[0].focus({ preventScroll: true });
  }

  function closeMenu({ viaPop = false } = {}) {
    const m = menu;
    if (!m) return Promise.resolve();
    menu = null;
    m.row.classList.remove("menu-open");
    m.anchor.setAttribute("aria-expanded", "false");
    menuScrim.classList.remove("open");
    menuEl.classList.remove("open");
    closePopover(menuScrim, 160);
    closePopover(menuEl, 160);
    if (m.anchor.isConnected) m.anchor.focus({ preventScroll: true });
    if (renderHeld && !editing && !drag) render();
    if (!viaPop && history.state && history.state.hermesMiniTodoMenu === true) {
      menuBack = new Promise((resolve) => {
        resolveMenuBack = resolve;
      });
      history.back();
      return menuBack;
    }
    return Promise.resolve();
  }

  menuScrim.addEventListener("click", () => void closeMenu());
  menuEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void closeMenu();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const choices = [...menuEl.querySelectorAll(".row-menu-item")];
    const i = choices.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
      : (i + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
    choices[next].focus();
  });

  // ---------- blocks and sections ----------
  // A block is a parent (indent 0) plus the indent-1 rows directly below it. A block's section follows its parent, so a
  // ticked child stays in its active block and a block is never half in the active list and half in Done. The store is
  // one sequence of blocks, each where it was stored, so a block that comes back from Done lands in its old place
  // (rule 8); only the Done section is drawn in another order, most recently finished parent first (rule 7).
  function blocksOf(list = items) {
    const blocks = [];
    for (const item of list) {
      if (item.indent === 1 && blocks.length) blocks[blocks.length - 1].children.push(item);
      else blocks.push({ parent: item, children: [] });
    }
    return blocks;
  }

  function blockOf(item) {
    return blocksOf().find((block) => block.parent.id === item.id
      || block.children.some((child) => child.id === item.id)) || null;
  }

  function inActiveSection(item) {
    const block = blockOf(item);
    return Boolean(block) && !block.parent.done;
  }

  // Every row of the active section, in display order: each active block's parent and all its children, ticked ones
  // included, since a ticked child stays where it is (rule 1).
  function activeRows() {
    const rows = [];
    for (const block of blocksOf()) {
      if (block.parent.done) continue;
      rows.push(block.parent, ...block.children);
    }
    return rows;
  }

  function doneBlocks() {
    return blocksOf().filter((block) => block.parent.done)
      .sort((a, b) => (b.parent.done_at || 0) - (a.parent.done_at || 0));
  }

  function doneRows() {
    return doneBlocks().flatMap((block) => [block.parent, ...block.children]);
  }

  // ---------- rendering ----------

  function render() {
    // A server answer that lands mid-edit, mid-drag or with the row menu open must not pull the row out from under the
    // fingers or detach the menu's anchor: the skipped render runs as soon as that ends.
    if (editing || drag || menu) {
      renderHeld = true;
      return;
    }
    renderHeld = false;
    // A render replaces every row, so a grip press still waiting for its first move must not outlive its row.
    cancelPress();
    normaliseOpen();
    const active = blocksOf().filter((block) => !block.parent.done);
    const done = doneBlocks();

    // The badge counts tracked ACTIVE top-level items only: a child never counts, ticked or not, an untracked parent
    // is skipped, and a draft is not a to-do yet (rule 10, the person, 7 Nov 2026).
    const real = active.filter((block) => !block.parent.draft && block.parent.tracked !== false).length;
    countEl.textContent = real > 99 ? "99+" : String(real);
    countEl.hidden = real === 0;

    listEl.replaceChildren();
    for (const block of active) {
      listEl.append(row(block.parent, "active"));
      for (const child of block.children) listEl.append(row(child, "active"));
    }
    // "Add item" closes the open rows the way Keep does: a new one is typed in place rather than in a field above
    //. It sits directly after the last open item, before Done.
    listEl.append(addItemRow());
    // Done shows whole blocks, children nested under their parent like the active list (rule 7). Its count is the
    // number of items Clear would remove, so the label and the confirm agree.
    const doneCount = done.reduce((sum, block) => sum + 1 + block.children.length, 0);
    if (doneCount) {
      const section = el("div", "todo-done");
      const head = el("div", "todo-done-head");
      head.append(el("p", "todo-done-label", `Done (${doneCount})`));
      const clear = el("button", "todo-clear", "Clear");
      clear.type = "button";
      clear.addEventListener("click", () => void clearDone());
      head.append(clear);
      section.append(head);
      for (const block of done) {
        section.append(row(block.parent, "done"));
        for (const child of block.children) section.append(row(child, "done"));
      }
      listEl.append(section);
    }
  }

  // The empty grip slot and the "+" in the checkbox's place keep the row on the same grid as a to-do row.
  function addItemRow() {
    const node = el("button", "todo-additem");
    node.type = "button";
    node.setAttribute("aria-label", "Add item");
    const slot = el("span", "todo-grip slot");
    slot.setAttribute("aria-hidden", "true");
    const icon = el("span", "todo-additem-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.append(svgIcon(PLUS_ICON));
    node.append(slot, icon, el("span", "todo-additem-label", "Add item"));
    node.addEventListener("pointerdown", () => {
      // The same as a row's text: the blur commits the row being edited and re-renders, so the click would be lost.
      if (editing) pendingTap = { kind: "add", at: performance.now() };
    });
    node.addEventListener("click", startDraft);
    return node;
  }

  // One row, in whichever section it belongs to. A row of the active section always keeps its grip - a ticked child
  // can still be edited, dragged, unticked or un-nested (rule 11) - while Done's rows keep the empty slot and never
  // indent anything: Done has no grip.
  function row(item, section) {
    const draft = item.draft === true;
    const node = el("div", item.done ? "todo-row done" : "todo-row");
    node.dataset.id = item.id;
    // A child sits one step in under its parent in both sections, so Done keeps the nesting (rules 1 and 7).
    node.dataset.indent = item.indent === 1 ? "1" : "0";
    if (item.indent === 1) node.classList.add("indent");
    if (item.pending) node.classList.add("pending");
    if (draft) node.classList.add("draft");
    const check = el("button", item.done ? "todo-check checked" : "todo-check");
    check.type = "button";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", String(item.done));
    check.setAttribute("aria-label", item.done ? "Mark not done" : "Mark done");
    check.append(svgIcon(CHECK_ICON));
    if (draft) check.disabled = true; // it is not a to-do until it is committed
    check.addEventListener("click", () => {
      if (drag || performance.now() < suppressClickUntil) return; // the release of a drag that began on the box
      void toggle(item);
    });
    const text = el("span", "todo-text", item.text);
    // Tapping the text edits it in place; the circle and the x are buttons, so they never start either.
    text.addEventListener("pointerdown", (event) => {
      // Tapping another row while one edits: the blur commits that row and re-renders, which would eat the click. The
      // press is remembered and turned into the new edit after the commit.
      if (editing && editing.id !== item.id) {
        pendingTap = { kind: "text", item, x: event.clientX, y: event.clientY, at: performance.now() };
      }
    });
    text.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!open || item.pending || drag || performance.now() < suppressClickUntil) return;
      // Only one row edits at a time: moving to another row commits the first.
      if (editing) {
        if (editing.id === item.id) return;
        finishEdit(editing.span.textContent);
        if (editing) return;
      }
      startEdit(item, text, event);
    });
    if (section === "active" && item.indent === 0) {
      node.append(check, text);
      if (item.tracked === false) {
        const badge = el("span", "todo-untracked-icon");
        badge.setAttribute("aria-label", "Untracked");
        badge.title = "Untracked";
        badge.append(svgIcon(EYE_OFF_ICON));
        node.append(badge);
      }
      const dots = el("button", "todo-dots");
      dots.type = "button";
      dots.setAttribute("aria-label", "To-do actions");
      dots.setAttribute("aria-haspopup", "menu");
      dots.setAttribute("aria-expanded", "false");
      dots.title = "More";
      dots.innerHTML = DOTS_SVG;
      dots.addEventListener("pointerdown", () => {
        if (editing) pendingTap = { kind: "menu", item, at: performance.now() };
      });
      dots.addEventListener("click", (event) => {
        event.stopPropagation();
        if (drag || performance.now() < suppressClickUntil || item.draft || item.pending) return;
        openMenu(item, node);
      });
      node.append(dots);
    } else {
      const del = el("button", "todo-del");
      del.type = "button";
      del.setAttribute("aria-label", "Delete to-do");
      del.title = "Delete";
      del.append(svgIcon(DELETE_ICON));
      // Deleting the row being edited must not save it first: a draft's commit would replace its id, and the tap would
      // then miss and leave the row behind.
      del.addEventListener("pointerdown", () => {
        if (editing && editing.id === item.id) stopEdit();
      });
      del.addEventListener("click", () => void remove(item));
      node.append(check, text, del);
    }
    if (section === "active") {
      // On a mouse only the grip drags; on touch the checkbox is a drag handle too (press and move
      // drags, a plain tap still ticks). The grip is always shown, mouse and touch alike. A draft shows it but cannot be dragged until it is saved.
      const grip = el("span", "todo-grip");
      grip.setAttribute("aria-hidden", "true");
      grip.append(svgIcon(GRIP_ICON));
      grip.append(el("span", "todo-grip-hit"));
      node.prepend(grip);
      if (!draft) armDrag(node);
    } else {
      node.prepend(el("span", "todo-grip slot")); // empty slot: done circles line up with the open ones
    }
    return node;
  }

  // ---------- server calls ----------

  // Every change shows at once (optimistic), so taps can be as fast as you like. Requests may
  // overlap; each answer is the whole list, so an early answer would undo a later local change. The server's list is
  // only adopted once nothing else is in flight. A failure reloads the list from the server, the source of truth.
  let inflight = 0;
  let overlapped = false; // a request started while another was out: answers may be out of order, so re-read at the end

  function adopt(payload) {
    // A draft lives only in this panel, so a server list must not wipe it: each one is put back among the active rows
    // where it was (at the end, usually).
    const drafts = items.filter((item) => item.draft);
    const before = activeRows();
    items = listFrom(payload);
    if (drafts.length) {
      const active = activeRows();
      for (const draft of drafts) {
        const at = before.findIndex((item) => item.id === draft.id);
        active.splice(Math.max(0, Math.min(at < 0 ? active.length : at, active.length)), 0, draft);
      }
      items = [...active, ...doneRows()];
    }
    render();
  }

  // onPayload sees every successful answer, even one that is not adopted (a new row needs its id either way).
  async function send(path, init, onPayload = null) {
    if (inflight) overlapped = true;
    inflight += 1;
    try {
      const payload = await api(path, init);
      if (onPayload) onPayload(payload);
      if (inflight === 1 && !overlapped) adopt(payload);
      return true;
    } catch (error) {
      return error || new Error("failed");
    } finally {
      inflight -= 1;
      if (!inflight && overlapped) {
        overlapped = false;
        void refresh();
      }
    }
  }

  async function failed(message) {
    showToast(message, "error");
    if (!inflight) await refresh();
  }

  async function refresh() {
    try {
      const payload = await api(TODOS_API);
      if (!inflight) adopt(payload);
    } catch {
      // Offline or still signing in: keep the last count and list rather than showing an empty one.
    }
  }

  // Resolves once the optimistic writes have settled, so a row that was just saved has its server id before it is
  // edited (Backspace to the row above).
  function settle() {
    return new Promise((resolve) => {
      const tick = () => {
        if (inflight) setTimeout(tick, 50);
        else setTimeout(resolve, 20);
      };
      tick();
    });
  }

  // ---------- drafts: the "+ Add item" row ----------
  // Typing happens in the list itself, like a Keep checklist. A new row is saved the moment it appears, blank or not
  // (the person, 15 Nov 2026): it is a "draft" only until the server answers with its id, and then it is an ordinary
  // row - draggable at once - even while the caret is still in it. What is typed is saved when the row is left.
  // Enter splits a row at the caret, keeping the part above it and saving the part below as the next new row.

  let draftSeq = 0;

  function newDraft(text = "", indent = 0) {
    draftSeq += 1;
    return {
      id: `draft-${Date.now().toString(36)}-${draftSeq}`, text, done: false, created: 0, done_at: null,
      indent: indent === 1 ? 1 : 0, tracked: true, draft: true,
    };
  }

  function openNow() {
    return activeRows();
  }

  // One level of nesting. The list stores no parent ids: a child is a row at indent 1 and its
  // parent is the nearest row above it at indent 0, which is exactly what the server does too.
  function indentOf(item) {
    return item && item.indent === 1 ? 1 : 0;
  }

  // A child cannot be the first row of the active list: the server promotes it after every stored change, and the panel
  // mirrors that after its own local ones (a deleted parent's child, an untick) before it draws the list.
  function normaliseOpen() {
    if (items.length && items[0].indent === 1) items[0].indent = 0;
  }

  // A child cannot be the first row of the active list, so the top one never indents; a lone row has no parent to sit
  // under either. A ticked child may nest or un-nest like any other active row (rule 11). A top-level row that HAS
  // children may nest too: it becomes a child and its children stay at indent 1,
  // so they all join the block above - one level only.
  function canIndent(id) {
    const rows = openNow();
    return rows.length > 1 && Boolean(rows[0]) && rows[0].id !== id;
  }

  // A local change is laid out as the caller built it: the active rows first, then the done blocks in their stored
  // order. A server answer replaces the whole list anyway, so this only has to hold until the write lands.
  function setOpen(list) {
    const done = doneRows();
    items = [...list, ...done];
  }

  function openIndex(id) {
    return openNow().findIndex((item) => item.id === id);
  }

  function textSpanFor(id) {
    for (const node of listEl.querySelectorAll(".todo-row")) {
      if (node.dataset.id === id) return node.querySelector(".todo-text");
    }
    return null;
  }

  function editDraft(draft) {
    const span = textSpanFor(draft.id);
    if (span) startEdit(draft, span, null, 0); // a new row starts at its beginning, like Keep
  }

  // The "+ Add item" row: a draft at the bottom of the open rows, in edit mode with the caret in it.
  function startDraft() {
    if (!open || drag || editing) return; // the row being edited has already been committed by its blur
    const draft = newDraft();
    setOpen([...openNow(), draft]);
    render();
    listEl.scrollTop = listEl.scrollHeight;
    void postNew(draft, openIndex(draft.id));
    editDraft(draft);
  }

  // A new draft directly below a row, keeping that row's indent when it is a child. "+ Add item"
  // is always top level; only Enter (or Backspace in an emptied child) puts a draft under a child.
  function insertDraftBelow(id, text = "", indent = 0) {
    const draft = newDraft(text, indent);
    const open = openNow();
    const at = open.findIndex((item) => item.id === id);
    open.splice(at < 0 ? open.length : at + 1, 0, draft);
    setOpen(open);
    return draft;
  }

  // Saves a new row as soon as it exists, with whatever it holds now (usually nothing). The index is the row's position
  // among the open items right now, so a row added below an older one lands below it even while other saves are still
  // in the air. A failed save takes the row away again, since it never existed on the server.
  async function postNew(draft, index) {
    const sent = { text: draft.text, indent: indentOf(draft) };
    const result = await send(TODOS_API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sent.text, index, indent: sent.indent }),
    }, (payload) => landDraft(draft, payload, sent));
    if (result === true) return;
    if (draft.draft) {
      if (editing && editing.id === draft.id) stopEdit();
      items = items.filter((entry) => entry.id !== draft.id);
      render();
    }
    await failed(result.status === 409 ? "The to-do list is full" : "Couldn't add the to-do");
  }

  // The server's answer to a new row: the draft takes its real id in place - the model entry, the row on screen and the
  // edit in progress - so the caret never leaves it, and its grip arms at once. Whatever changed while the save was out
  // (text typed into a row already left, an indent) is sent as one PATCH; a row deleted meanwhile is deleted now.
  function landDraft(draft, payload, sent) {
    const list = payload && Array.isArray(payload.items) ? payload.items : [];
    let id = payload && typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      // An older server does not name the new row: the one id this panel has never seen is it.
      const known = new Set(items.map((entry) => entry.id));
      const fresh = list.filter((entry) => entry && entry.id && !known.has(String(entry.id)));
      if (fresh.length === 1) id = String(fresh[0].id);
    }
    if (!draft.draft) return;
    const tempId = draft.id;
    if (!id) {
      // Unknown: the server's list (which has the row) replaces the local one.
      if (editing && editing.id === tempId) stopEdit();
      items = items.filter((entry) => entry.id !== tempId);
      return;
    }
    draft.id = id;
    delete draft.draft;
    if (draft.discard) {
      payload.items = list.filter((entry) => !entry || String(entry.id) !== id);
      void send(`${TODOS_API}/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
    const node = rowNodeFor(tempId);
    if (node) {
      node.dataset.id = id;
      node.classList.remove("draft");
      const check = node.querySelector(".todo-check");
      if (check) check.disabled = false;
      if (inActiveSection(draft)) armDrag(node);
    }
    const typing = Boolean(editing && editing.id === tempId);
    if (typing) {
      editing.id = id;
      editing.draft = false;
      editing.text = sent.text; // what the server holds: leaving the row saves the difference
      if (editing.span) editing.span.setAttribute("aria-label", "Edit to-do");
    }
    const patch = {};
    if (!typing && draft.text !== sent.text) patch.text = draft.text;
    if (indentOf(draft) !== sent.indent) patch.indent = indentOf(draft);
    const stored = list.find((entry) => entry && String(entry.id) === id);
    if (stored) Object.assign(stored, patch); // the list about to be adopted shows the local values already
    if (Object.keys(patch).length) {
      void send(`${TODOS_API}/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      }).then((result) => (result === true ? null : failed("Couldn't save the to-do")));
    }
  }

  // Ticking, block by block, mirroring the server's rules in one place:
  //  - a parent carries its children with it: ticked, the whole block goes to Done; unticked, it all comes back;
  //  - a child ticks in place and stays in its active block, drawn ticked (rule 1);
  //  - the last unticked child ticked takes the parent with it, so the block closes (rule 2);
  //  - a child unticked in a done block reopens the block; its siblings keep their state (rule 5).
  // The local list changes at once and the returned PATCHes are the same changes for the server, so the two agree.
  // A draft or a row still being saved has no server id, so it changes locally and sends nothing. Reopening a done
  // block from a child sends only the child: unticking that child reopens its parent server-side too (rule 5), so a
  // second parent PATCH would untick the child's ticked siblings (rule 4).
  function applyToggle(item, done, stamp) {
    const holder = blockOf(item);
    if (!holder) return [];
    const targets = [item];
    let reopen = false;
    if (holder.parent.id === item.id) {
      for (const child of holder.children) targets.push(child);
    } else if (!done && holder.parent.done) {
      targets.push(holder.parent);
      reopen = true;
    } else if (done && !holder.parent.done && holder.children.every((child) => child.done || child.id === item.id)) {
      targets.push(holder.parent);
    }
    const ids = new Set(targets.map((entry) => entry.id));
    items = items.map((entry) => (ids.has(entry.id)
      ? { ...entry, done, done_at: done ? stamp : null }
      : entry));
    return targets
      .filter((entry) => !entry.draft && !entry.pending)
      .filter((entry) => !(reopen && entry.id === holder.parent.id))
      .map((entry) => ({ id: entry.id, body: { done } }));
  }

  async function toggle(item) {
    if (item.pending) return;
    const saves = applyToggle(item, !item.done, Math.floor(Date.now() / 1000));
    render();
    const results = await Promise.all(saves.map(({ id, body }) => send(`${TODOS_API}/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })));
    if (results.some((result) => result !== true)) await failed("Couldn't save the to-do");
  }

  async function toggleTrack(item) {
    const live = items.find((entry) => entry.id === item.id) || item;
    if (live.pending || live.draft) return;
    const next = live.tracked === false;
    items = items.map((entry) => (entry.id === item.id ? { ...entry, tracked: next } : entry));
    render();
    const result = await send(`${TODOS_API}/${encodeURIComponent(item.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracked: next }),
    });
    if (result !== true) await failed("Couldn't save the to-do");
  }

  async function remove(item) {
    if (item.pending) return;
    if (item.draft) {
      // Its save is still out: the row goes now and is deleted on the server once its id lands (landDraft).
      item.discard = true;
      items = items.filter((entry) => entry.id !== item.id);
      render();
      return;
    }
    // A deleted parent leaves its children behind as top-level rows: a child only exists under its parent
    //. The server's delete does the same.
    const holder = blockOf(item);
    if (holder && holder.parent.id === item.id) for (const child of holder.children) child.indent = 0;
    items = items.filter((entry) => entry.id !== item.id);
    render();
    const result = await send(`${TODOS_API}/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    // Already gone on the server (another device, or a double tap) is what we wanted anyway.
    if (result !== true && result.status !== 404) await failed("Couldn't delete the to-do");
  }

  // Clear removes whole done blocks - a parent and all its children - and the message counts the items going
  // (rule 9, the person, 7 Nov 2026). Ticked children of active blocks are not done blocks: they stay.
  async function clearDone() {
    const count = doneRows().length;
    if (!count) return;
    const ok = await confirmDialog({
      title: "Clear done items?",
      message: count === 1 ? "This removes 1 done item." : `This removes ${count} done items.`,
      confirmLabel: "Clear",
      danger: true,
    });
    if (!ok) return;
    items = blocksOf().filter((block) => !block.parent.done)
      .flatMap((block) => [block.parent, ...block.children]);
    render();
    const result = await send(`${TODOS_API}/clear-done`, { method: "POST" });
    if (result !== true) await failed("Couldn't clear the done items");
  }

  // ---------- inline edit ----------
  // The text itself becomes editable, so the row never jumps. Enter splits at the caret like a Keep checklist, leaving
  // the rest as the next draft below; leaving the field saves (trimmed; unchanged text sends nothing), Escape cancels,
  // an emptied existing row restores its old text and an emptied draft simply goes. Only one row edits at a time.

  let editing = null; // { id, text, item, draft, span } while a row's text is editable
  let renderHeld = false; // a render asked for mid-edit or mid-drag: run it as soon as that ends
  let pendingTap = null; // a press that lands on another row or on "+ Add item" while a row is editing

  // ---------- nesting while editing ----------
  // Tab/Shift+Tab and Backspace at the start of a child change the indent. The row is shifted in place (a class on its
  // own node), never re-rendered, so the caret stays where it was and no text is lost.

  function rowNodeFor(id) {
    for (const node of listEl.querySelectorAll(".todo-row")) if (node.dataset.id === id) return node;
    return null;
  }

  // Moves the row on screen and in the model at once. The save is the caller's, since a draft only keeps it until the
  // draft is committed (its POST carries the indent). Done's rows never indent - there is no grip there - but a ticked
  // child in the active list can be un-nested like any other row; it then becomes a done top-level row and moves to
  // Done (rule 11, the person, 7 Nov 2026).
  function showIndent(id, value) {
    const entry = items.find((item) => item.id === id);
    if (!entry || !inActiveSection(entry)) return false;
    entry.indent = value === 1 ? 1 : 0;
    const node = rowNodeFor(id);
    if (node) {
      node.classList.toggle("indent", entry.indent === 1);
      node.dataset.indent = String(entry.indent);
    }
    return true;
  }

  function stepIndent(value) {
    const state = editing;
    if (!state) return;
    const entry = items.find((item) => item.id === state.id);
    if (!entry || indentOf(entry) === value) return;
    const caret = caretOffset(state.span);
    if (!showIndent(state.id, value)) return;
    // A saved row sends the bare indent; the draft's goes out with its POST.
    if (!entry.draft) void saveIndent(entry.id, value);
    if (state.span.isConnected) {
      if (document.activeElement !== state.span) state.span.focus({ preventScroll: true });
      placeCaret(state.span, caret);
    }
  }

  async function saveIndent(id, indent) {
    const result = await send(`${TODOS_API}/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ indent }),
    });
    if (result !== true) await failed("Couldn't save the indent");
  }

  function startEdit(item, span, event = null, caretAt = null) {
    if (editing || drag || item.pending || !open) return;
    pendingTap = null;
    // A row re-rendered by a server answer leaves the click's span detached; edit the fresh one instead.
    if (!span || !span.isConnected) span = textSpanFor(item.id);
    if (!span) return;
    // The caret goes where the text was clicked, nothing selected; the end when that is unknown.
    let caret = caretAt == null ? item.text.length : Math.min(caretAt, item.text.length);
    if (caretAt == null && event && document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range && span.contains(range.startContainer)) caret = range.startOffset;
    } else if (caretAt == null && event && document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (pos && span.contains(pos.offsetNode)) caret = pos.offset;
    }
    // The text itself becomes editable (contenteditable), so nothing is swapped in and the line cannot move by a pixel
    //. Plain text only; Enter splits, leaving saves, Escape cancels (the panel's key handler).
    span.contentEditable = "plaintext-only";
    if (span.contentEditable !== "plaintext-only") span.contentEditable = "true"; // older engines
    span.spellcheck = false;
    span.setAttribute("role", "textbox");
    span.setAttribute("aria-label", item.draft ? "New to-do" : "Edit to-do");
    span.setAttribute("enterkeyhint", "next"); // phones: the soft keyboard's key is "next", like Keep
    span.classList.add("editing");
    const onKey = (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        splitEdit();
        return;
      }
      // Tab nests the row being edited, Shift+Tab brings it back out; the focus and the caret stay in it
      //. The first active row is never a child, and Done's rows never nest.
      if (event.key === "Tab") {
        const live = items.find((entry) => entry.id === item.id);
        if (!live) return;
        event.preventDefault();
        if (!inActiveSection(live)) return; // Done's rows keep their place: there is no grip there (rule 11)
        if (event.shiftKey) stepIndent(0);
        else if (canIndent(live.id)) stepIndent(1);
        return;
      }
      if (event.key === "Backspace" && caretOffset(span) === 0) {
        // Backspace in an empty row: it goes and the caret returns to the end of the row above.
        if (!span.textContent.length) {
          event.preventDefault();
          removeEmptyAndStepBack();
          return;
        }
        // Backspace at the very start of a non-empty child un-nests it rather than eating the text, like Keep
        //. A selection that merely starts at 0 still deletes, as usual. A ticked child in the
        // active list un-nests the same way (rule 11).
        const live = items.find((entry) => entry.id === item.id);
        const selection = window.getSelection();
        if (live && indentOf(live) === 1 && inActiveSection(live) && (!selection || selection.isCollapsed)) {
          event.preventDefault();
          stepIndent(0);
        }
      }
    };
    const onBlur = () => {
      if (!editing || editing.span !== span) return;
      const id = editing.id;
      finishEdit(span.textContent);
      // The press that took the focus away (another row, or "+ Add item") is carried out now that the first row is
      // committed; its click was lost to the re-render.
      resumePendingTap(id);
    };
    const onInput = () => {
      if (span.textContent.length > 500) {
        span.textContent = span.textContent.slice(0, 500); // the server's limit
        placeCaret(span, 500);
      }
      revealEditing();
    };
    span.addEventListener("keydown", onKey);
    span.addEventListener("blur", onBlur);
    span.addEventListener("input", onInput);
    editing = {
      // fresh: the row was created for this edit, so Escape takes it away again rather than restoring a text.
      id: item.id, text: item.text, item, draft: item.draft === true, fresh: item.draft === true, span,
      cleanup: () => {
        span.removeEventListener("keydown", onKey);
        span.removeEventListener("blur", onBlur);
        span.removeEventListener("input", onInput);
        span.removeAttribute("contenteditable");
        span.removeAttribute("role");
        span.removeAttribute("aria-label");
        span.removeAttribute("enterkeyhint");
        span.classList.remove("editing");
      },
    };
    span.focus({ preventScroll: true });
    placeCaret(span, caret);
    revealEditing();
    requestAnimationFrame(revealEditing);
    setTimeout(revealEditing, 120);
    setTimeout(revealEditing, 300);
  }

  // Scrolls listEl so the row being edited is fully and comfortably visible above the virtual keyboard.
  function revealEditing() {
    if (!open || !editing) return;
    const span = editing.span;
    if (!span || !span.isConnected) return;
    const row = span.closest(".todo-row") || span;
    const rb = row.getBoundingClientRect();
    const lb = listEl.getBoundingClientRect();
    if (lb.height <= 0) return;
    const margin = 28;
    if (rb.height >= lb.height - margin) {
      if (Math.abs(rb.top - (lb.top + 8)) > 1) {
        listEl.scrollTop += Math.ceil(rb.top - (lb.top + 8));
      }
    } else if (rb.bottom > lb.bottom - margin) {
      listEl.scrollTop += Math.ceil(rb.bottom - (lb.bottom - margin));
    } else if (rb.top < lb.top + margin) {
      listEl.scrollTop -= Math.ceil((lb.top + margin) - rb.top);
    }
  }

  function placeCaret(span, offset) {
    const node = span.firstChild;
    const range = document.createRange();
    if (node && node.nodeType === Node.TEXT_NODE) range.setStart(node, Math.min(offset, node.length));
    else range.setStart(span, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Where the caret sits in the row's text, in characters (the split point for Enter).
  function caretOffset(span) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return span.textContent.length;
    const range = selection.getRangeAt(0);
    if (!span.contains(range.startContainer)) return span.textContent.length;
    const before = range.cloneRange();
    before.selectNodeContents(span);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  }

  // Ends the edit without deciding anything: the caller owns what happens next.
  function stopEdit() {
    const state = editing;
    if (!state) return null;
    editing = null;
    state.cleanup();
    return state;
  }

  // Enter (or Shift+Enter) in any row: Keep's split. The row keeps the text before the caret and the text after it
  // becomes a new draft directly below, with the caret at its start.
  // With blanks allowed, an empty row still splits: the row above is saved as "" and a fresh draft opens below (rule
  // changed 7 Nov 2026). At the very start of a row that has text nothing sits above the caret, so the row keeps its
  // text whole and a fresh draft opens below it: Enter there adds a line like it does at the end (changed 10 Nov 2026).
  function splitEdit() {
    const state = editing;
    if (!state) return;
    const raw = state.span.textContent;
    const offset = caretOffset(state.span);
    const atStart = offset === 0 && Boolean(raw.trim());
    const after = atStart ? "" : raw.slice(offset).trim();
    const before = atStart ? raw.trim() : raw.slice(0, offset).trim();
    // The row's indent right now (Tab can have changed it): the new draft sits directly below at the same indent
    //.
    const indent = indentOf(items.find((entry) => entry.id === state.id) || state.item);
    stopEdit();
    if (state.draft) {
      // Its save is still out: the text is kept locally and landDraft sends it with the id.
      const entry = items.find((item) => item.id === state.id);
      if (entry) entry.text = before;
    } else if (before !== state.text) {
      void saveText(state.id, before);
    }
    const draft = insertDraftBelow(state.id, after, indent);
    render();
    void postNew(draft, openIndex(draft.id));
    editDraft(draft);
  }

  // Backspace in an empty row: it goes, and the caret goes to the end of the row above. A real
  // to-do is deleted on the server; a draft only ever existed here.
  function removeEmptyAndStepBack() {
    const state = stopEdit();
    if (!state) return;
    const open = openNow();
    const at = open.findIndex((entry) => entry.id === state.id);
    const prevIndex = at - 1;
    void remove(state.item); // a row still being saved goes at once and is deleted when its id lands
    if (prevIndex < 0) return;
    if (startEditingAt(prevIndex)) return;
    // The row above is still being saved: it becomes editable once the answer is in.
    if (inflight) {
      settle().then(() => {
        if (open && !editing) {
          render();
          startEditingAt(prevIndex);
        }
      });
    }
  }

  function startEditingAt(index) {
    const item = openNow()[index];
    if (!item || item.pending) return false;
    const span = textSpanFor(item.id);
    if (!span) return false;
    startEdit(item, span); // no click point: the caret goes to the end
    return true;
  }

  function resumePendingTap(committedId) {
    const tap = pendingTap;
    pendingTap = null;
    if (!tap || performance.now() - tap.at > 900 || !open || drag || editing) return;
    if (tap.kind === "add") {
      startDraft();
      return;
    }
    if (tap.kind === "menu") {
      const target = items.find((entry) => entry.id === tap.item.id && !entry.pending && !entry.draft);
      const targetRow = target ? rowNodeFor(target.id) : null;
      if (target && targetRow) openMenu(target, targetRow);
      return;
    }
    if (tap.item.id === committedId) return;
    const item = items.find((entry) => entry.id === tap.item.id && !entry.pending);
    if (!item) return;
    const span = textSpanFor(item.id);
    if (span) startEdit(item, span, { clientX: tap.x, clientY: tap.y });
  }

  function finishEdit(value) {
    const state = stopEdit();
    if (!state) return;
    if (value == null) {
      // Escape: a row made for this edit goes again (deleted on the server, saved or not yet); an existing row gets
      // its old text back.
      if (state.fresh) {
        void remove(state.item);
        return;
      }
      state.span.textContent = state.text;
      render();
      return;
    }
    const next = value.trim();
    if (state.draft) {
      // Left before its save came back: the text waits on the row and landDraft sends it with the id. A row left blank
      // stays a real blank entry; Backspace at 0 in an empty row deletes it.
      const entry = items.find((item) => item.id === state.id);
      if (entry) entry.text = next;
      render();
      return;
    }
    // An existing row emptied in place is saved empty too: "" is a value, not "cancel the edit".
    if (next === state.text) {
      state.span.textContent = state.text;
      render(); // flushes any render held back while typing
      return;
    }
    void saveText(state.id, next);
  }

  // Optimistic like every other change: the new text shows at once, the send()/failed() pair keeps overlapping requests
  // safe and reloads the list from the server if the save is refused.
  async function saveText(id, text) {
    items = items.map((entry) => (entry.id === id ? { ...entry, text } : entry));
    render();
    const result = await send(`${TODOS_API}/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    if (result !== true) await failed("Couldn't save the to-do");
  }

  // ---------- drag to sort the open rows ----------
  // Only open rows sort; done ones keep their section. On a mouse only the grip drags; on touch the checkbox is a drag
  // handle too (press and move drags, a plain tap still ticks). Pressing and moving a few pixels starts
  // the drag, mouse or finger; the rest of the row scrolls and edits as usual. The row follows the pointer, the other
  // open rows slide out of the way, the list scrolls near its edges, and the new order is sent once on release. The same
  // shape as the drawer's pinned-chat sort.
  // A parent drags its whole block - the children below it - along with it, and the pointer's sideways travel picks the
  // drop's indent: past one checkbox step to the right nests the row, to the left brings it out, and a drop at the very
  // top is always flat.
  const DRAG_START_PX = 4;
  const CHECK_DRAG_START_PX = 10; // a press on the checkbox: a tap that wobbles a little still ticks it
  const DRAG_INDENT_PX = 24; // how far sideways of the press point a drop changes the indent
  const SCROLL_EDGE_PX = 48;
  let drag = null; // the drag in progress
  let press = null; // the grip press being watched, before it becomes a drag
  let suppressClickUntil = 0; // a drag has just ended: the click that follows must not start an edit

  function armDrag(node) {
    node.addEventListener("pointerdown", (event) => {
      // One pending press at a time: a second finger, a non-primary pointer or another grip is ignored.
      if (!open || drag || press || node.classList.contains("pending")) return;
      if (event.isPrimary === false) return;
      if (event.button !== undefined && event.button !== 0) return;
      // On a touch screen the checkbox is a handle too: a press on it that moves drags the row, a plain tap still
      // ticks it (the person, 15 Nov 2026). A mouse drags by the grip only.
      const onCheck = event.pointerType !== "mouse" && Boolean(event.target.closest(".todo-check"));
      if (!onCheck && event.target.closest("button, input")) return; // the x (and, for a mouse, the box) keep their taps
      if (!onCheck && !event.target.closest(".todo-grip")) return;
      if (!onCheck) event.preventDefault(); // keep focus/caret stable until an actual drag begins
      node.classList.add("grip-armed");
      armPress(event, node, { capture: !onCheck, startPx: onCheck ? CHECK_DRAG_START_PX : DRAG_START_PX });
    });
  }

  // Watches one press until it becomes a drag (or a plain tap / a scroll). Only one pending press exists at a time, and
  // its cleanup is idempotent: release, cancel, lost capture, blur, a hidden tab and a panel close all land here safely.
  // capture: false for a press on the checkbox, so a plain tap still ends on the box and clicks it; the drag takes the
  // pointer once it starts (beginDrag).
  function armPress(event, node, { capture = true, startPx = DRAG_START_PX } = {}) {
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const touch = event.pointerType !== "mouse";
    const state = { cancel: () => {} };
    press = state;
    node.classList.add("grip-armed");
    const cleanup = ({ keepCapture = false } = {}) => {
      if (state.cleaned) return;
      state.cleaned = true;
      if (press === state) press = null;
      node.classList.remove("grip-armed");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      node.removeEventListener("lostpointercapture", onLost);
      // A drag about to start keeps the pointer; releasing it here would fire lostpointercapture and cancel that drag.
      if (!keepCapture) {
        try {
          if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
        } catch {
          /* the pointer may already be gone */
        }
      }
    };
    state.cancel = () => cleanup();
    const stop = (ev) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    };
    const onBlur = () => cleanup();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cleanup();
    };
    const onLost = (ev) => {
      if (ev.pointerId === pointerId && ev.target === node) cleanup(); // not a child's capture handing over (dragLost)
    };
    const move = (ev) => {
      if (ev.pointerId !== pointerId || state.cleaned || drag) return;
      // The panel may have closed or a render replaced the row while this press was pending: never start a drag then.
      if (!open || !node.isConnected) {
        cleanup();
        return;
      }
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Pressed on the grip: the drag starts on the first real move either way, since sideways travel now picks the
      // indent. The grip has touch-action: none, so the list never scrolls under the finger.
      if (Math.abs(dy) > startPx || Math.abs(dx) > startPx) {
        cleanup({ keepCapture: true });
        beginDrag(node, pointerId, startX, startY, ev.clientX, ev.clientY, touch);
      }
    };
    if (capture) {
      try {
        node.setPointerCapture(pointerId);
      } catch {
        /* capture is best effort */
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    node.addEventListener("lostpointercapture", onLost);
  }

  // pressX/pressY are where the finger went down. Both the sideways travel (the indent) and the row's movement are
  // measured from there, so the distance the finger covered before the drag started is not lost: the row stays under
  // the finger instead of trailing it by that much for the whole drag (measured on Android, 15 Nov 2026). nowX/nowY
  // are where the finger is as the drag starts, so the first frame already puts the row there.
  function beginDrag(node, pointerId, pressX, pressY, nowX, nowY, touch) {
    // The press left the pointer captured for this hand-off; if the drag cannot start, give it back.
    const release = () => {
      try {
        if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
      } catch {
        /* the pointer may already be gone */
      }
    };
    if (!open || !node.isConnected) {
      release();
      return; // closed or re-rendered since the press began
    }
    const rows = [...listEl.querySelectorAll(":scope > .todo-row")];
    const from = rows.indexOf(node);
    if (from < 0) {
      release();
      return;
    }
    const isIndented = (row) => row.classList.contains("indent");
    const fromIndent = isIndented(node) ? 1 : 0;
    // A parent takes its block with it: the children straight below it, one level only. A child
    // drags alone.
    const block = [node];
    if (!fromIndent) {
      for (let i = from + 1; i < rows.length && isIndented(rows[i]); i += 1) block.push(rows[i]);
    }
    const listRect = listEl.getBoundingClientRect();
    const scroll = listEl.scrollTop;
    const contentTop = (other) => other.getBoundingClientRect().top - listRect.top + scroll;
    const box = node.getBoundingClientRect();
    const blockHeight = block.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    drag = {
      node, block, pointerId, from, fromIndent,
      pressX,
      startY: pressY,
      startContentY: pressY - listRect.top + scroll,
      startScroll: scroll,
      top0: box.top,
      listTop: listRect.top,
      center: contentTop(node) + blockHeight / 2,
      blockHeight,
      rowHeight: box.height,
      others: rows
        .filter((other) => !block.includes(other))
        .map((other) => ({
          node: other,
          // Its place in the full row list, which is what the slide maths below is in.
          at: rows.indexOf(other),
          center: contentTop(other) + other.getBoundingClientRect().height / 2,
        })),
      insertAt: from,
      lastX: nowX,
      lastY: nowY,
      liveIndent: fromIndent,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      raf: 0,
    };
    if (editing) {
      pendingTap = null;
      const activeSpan = editing.span;
      activeSpan.blur();
      if (editing) finishEdit(activeSpan.textContent);
    }
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    suppressClickUntil = performance.now() + 400;
    node.classList.add("dragging");
    listEl.classList.add("dragging");
    document.body.classList.add("todo-dragging");
    try {
      node.setPointerCapture(pointerId);
    } catch {
      /* capture is best effort */
    }
    if (touch) navigator.vibrate?.(10);
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragEnd);
    window.addEventListener("pointercancel", dragCancel);
    window.addEventListener("blur", dragBlur);
    document.addEventListener("visibilitychange", dragVisibility);
    node.addEventListener("lostpointercapture", dragLost);
    document.addEventListener("touchmove", blockTouch, { passive: false });
    document.addEventListener("contextmenu", blockMenu);
    drag.raf = requestAnimationFrame(tickDrag);
  }

  // Cancelable so a finger that is dragging cannot scroll the page underneath (added once the long press has started).
  // Only a cancelable touchmove is cancelled: on the grip (touch-action: none) Chrome sends them uncancelable, and
  // cancelling one anyway only logs an [Intervention] warning per move.
  function blockTouch(event) {
    if (drag && event.cancelable) event.preventDefault();
  }

  // A long press on a phone would otherwise open the browser's own menu over the drag.
  function blockMenu(event) {
    if (drag) event.preventDefault();
  }

  function dragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    applyDrag();
  }

  // Auto-scrolls while the pointer sits near an edge, and keeps the drop slot live without needing a fresh move event.
  function tickDrag() {
    if (!drag) return;
    const rect = listEl.getBoundingClientRect();
    let step = 0;
    if (drag.lastY < rect.top + SCROLL_EDGE_PX) step = -Math.ceil((rect.top + SCROLL_EDGE_PX - drag.lastY) / 4);
    else if (drag.lastY > rect.bottom - SCROLL_EDGE_PX) step = Math.ceil((drag.lastY - (rect.bottom - SCROLL_EDGE_PX)) / 4);
    if (step) listEl.scrollTop += step;
    applyDrag();
    drag.raf = requestAnimationFrame(tickDrag);
  }

  // The dragged row (or the whole block) follows the pointer; the others slide to open the drop slot. Both stay inside
  // the list's box, since the list clips its overflow and a row dragged past the top edge would vanish.
  function applyDrag() {
    const state = drag;
    if (!state) return;
    const scroll = listEl.scrollTop;
    const rect = listEl.getBoundingClientRect();
    const layoutTop = state.top0 - (scroll - state.startScroll);
    let dy = state.lastY - state.startY;
    dy = Math.max(rect.top - layoutTop, Math.min(rect.bottom - state.blockHeight - layoutTop, dy));
    for (const row of state.block) row.style.transform = `translateY(${dy}px)`;
    const contentY = state.lastY - state.listTop + scroll;
    const centre = state.center + (contentY - state.startContentY);
    let insertAt = 0;
    for (const other of state.others) if (other.center < centre) insertAt += 1;
    state.insertAt = insertAt;
    // A row's place among the others once the block is out of the list, and where it ends up once the block is dropped
    // in. The distance between the two is how many row heights it slides.
    for (const other of state.others) {
      const compacted = other.at < state.from ? other.at : other.at - state.block.length;
      const movedTo = compacted < insertAt ? compacted : compacted + state.block.length;
      const shift = movedTo - other.at;
      other.node.style.transition = state.reduced ? "none" : "transform 160ms ease";
      other.node.style.transform = shift ? `translateY(${shift * state.rowHeight}px)` : "";
    }
    // The live indent: right nests, left brings out, a drop at the very top is always flat. A block that brings its
    // children nests too: the parent becomes indent 1 and its children keep
    // indent 1, so they all join the block above - one level only, never two.
    const dx = state.lastX - state.pressX;
    let want = state.fromIndent;
    if (insertAt === 0) want = 0;
    else if (dx > DRAG_INDENT_PX) want = 1;
    else if (dx < -DRAG_INDENT_PX) want = 0;
    if (want !== state.liveIndent) {
      state.liveIndent = want;
      state.node.classList.toggle("indent", want === 1);
      state.node.dataset.indent = String(want);
    }
  }

  function dragEnd(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    finishDrag(true);
  }

  // The browser took the pointer away (a scroll, a system gesture): put the rows back where they were.
  function dragCancel(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    finishDrag(false);
  }

  function cancelDrag() {
    if (drag) finishDrag(false);
  }

  // The window lost focus, the tab went hidden or the browser took the pointer: undo the drag and never save it.
  function dragBlur() {
    if (drag) finishDrag(false);
  }

  function dragVisibility() {
    if (drag && document.visibilityState === "hidden") finishDrag(false);
  }

  // Only the row losing the pointer cancels. lostpointercapture bubbles, so the checkbox's own (implicit, touch)
  // capture handing over to the row when the drag takes the pointer arrives here too - that is the drag starting, not
  // ending; cancelling on it killed every drag begun on the box (logged on a phone, 15 Nov 2026).
  function dragLost(event) {
    if (!drag || event.pointerId !== drag.pointerId || event.target !== drag.node) return;
    finishDrag(false);
  }

  // A pending press is not a drag yet: a close, a render or a lost pointer just drops it without saving.
  function cancelPress() {
    if (press) press.cancel();
  }

  function finishDrag(commit) {
    const state = drag;
    if (!state) return;
    drag = null;
    // The click the browser sends after the pointer is released must never start an edit, however long the drag was.
    suppressClickUntil = performance.now() + 400;
    if (state.raf) cancelAnimationFrame(state.raf);
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragEnd);
    window.removeEventListener("pointercancel", dragCancel);
    window.removeEventListener("blur", dragBlur);
    document.removeEventListener("visibilitychange", dragVisibility);
    state.node.removeEventListener("lostpointercapture", dragLost);
    document.removeEventListener("touchmove", blockTouch);
    document.removeEventListener("contextmenu", blockMenu);
    try {
      state.node.releasePointerCapture(state.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    const before = state.node.getBoundingClientRect(); // where the row is now, transform included
    if (commit && state.insertAt !== state.from) {
      // Neighbours move, never the dragged rows: the block is re-inserted once, in its own order, before the marker.
      const others = [...listEl.querySelectorAll(":scope > .todo-row")].filter((row) => !state.block.includes(row));
      const marker = others[state.insertAt] || null;
      const addItem = listEl.querySelector(".todo-additem");
      const done = listEl.querySelector(".todo-done");
      for (const row of state.block) {
        if (marker) listEl.insertBefore(row, marker);
        else if (addItem) listEl.insertBefore(row, addItem);
        else if (done) listEl.insertBefore(row, done);
        else listEl.append(row);
      }
    }
    state.node.classList.remove("dragging");
    listEl.classList.remove("dragging");
    document.body.classList.remove("todo-dragging");
    // A cancelled drag puts the row's indent back as well as its place.
    if (!commit && state.liveIndent !== state.fromIndent) {
      state.liveIndent = state.fromIndent;
      state.node.classList.toggle("indent", state.fromIndent === 1);
      state.node.dataset.indent = String(state.fromIndent);
    }
    for (const other of state.others) {
      other.node.style.transition = "none";
      other.node.style.transform = "";
    }
    for (const row of state.block) {
      row.style.transition = "none";
      row.style.transform = "";
    }
    void state.node.offsetHeight; // settle the new layout before measuring the snap
    const after = state.node.getBoundingClientRect();
    const snap = before.top - after.top;
    // A block lands where it was headed in one step; a single row glides in, which also covers a cancel with Escape.
    if (state.block.length === 1 && !state.reduced && Math.abs(snap) > 1) {
      state.node.style.transform = `translateY(${snap}px)`;
      void state.node.offsetHeight;
      state.node.style.transition = "transform 180ms ease";
      state.node.style.transform = "";
      state.node.addEventListener("transitionend", () => {
        state.node.style.transition = "";
      }, { once: true });
    } else {
      state.node.style.transition = "";
    }
    const moved = state.insertAt !== state.from;
    const nested = state.liveIndent !== state.fromIndent;
    if (commit && (moved || nested)) void saveOrder();
    else if (renderHeld) render(); // a server answer that arrived mid-drag is shown only now
  }

  // The DOM is already in the new order and shows each row's dropped indent, so this only brings the model in line and
  // sends the active ids and their indents in one write: every row of the active section in
  // display order with its indent - a ticked child included, since it is still one of those rows - with the done
  // blocks kept after them in their stored order. A draft has no server id and is not sent; its indent stays local
  // until it is committed.
  async function saveOrder() {
    const rows = [...listEl.querySelectorAll(":scope > .todo-row")];
    const byId = new Map(openNow().map((item) => [item.id, item]));
    const active = rows
      .filter((node) => node.dataset.id && byId.has(node.dataset.id))
      .map((node) => ({ ...byId.get(node.dataset.id), indent: node.classList.contains("indent") ? 1 : 0 }));
    const done = doneRows();
    items = [...active, ...done];
    normaliseOpen();
    const activeIds = active.map((item) => item.id).filter((id) => !id.startsWith("draft-"));
    const indents = {};
    for (const item of active) if (!item.draft) indents[item.id] = indentOf(item);
    const result = await send(`${TODOS_API}/order`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: activeIds, indents }),
    });
    if (result !== true) await failed("Couldn't save the order");
  }

  // ---------- open / close, with one history entry per open ----------

  // Centres the card in the visual viewport, so the on-screen keyboard on a phone never hides the add row.
  function place() {
    const vv = window.visualViewport;
    dialog.style.left = `${vv ? vv.offsetLeft + vv.width / 2 : window.innerWidth / 2}px`;
    dialog.style.top = `${vv ? vv.offsetTop + vv.height / 2 : window.innerHeight / 2}px`;
    // Full screen on phones (style.css): pinned to the visible area, so the keyboard shrinks it instead of covering it.
    dialog.style.setProperty("--todo-vt", `${vv ? vv.offsetTop : 0}px`);
    dialog.style.setProperty("--todo-vh", `${vv ? vv.height : window.innerHeight}px`);
  }

  function openPanel() {
    if (open) return;
    if (backPending) {
      // The previous close's history.back() has not landed yet; open once it has, so the entries stay in step.
      backPending.then(openPanel);
      return;
    }
    open = true;
    place();
    render();
    scrim.classList.add("open");
    dialog.classList.add("open");
    document.body.classList.add("todo-open");
    btn.setAttribute("aria-expanded", "true");
    if (!(history.state && history.state.hermesMiniTodo === true)) history.pushState({ hermesMiniTodo: true }, "");
    // Focus the panel, not the input: opening must not pop the phone keyboard. Escape and Tab
    // still work from here.
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
    requestAnimationFrame(() => {
      if (open) dialog.focus({ preventScroll: true });
    });
    void refresh();
  }

  // Closes the panel. An in-app close consumes the history entry it pushed; a Back-button close has popped it. Returns
  // a promise that settles once the entry is gone, so another panel can open without racing this one's history.back().
  function closePanel({ viaPop = false } = {}) {
    if (!open) return Promise.resolve();
    if (menu && !viaPop) return closeMenu().then(() => closePanel());
    if (menu) void closeMenu({ viaPop: true });
    if (drag) finishDrag(false);
    cancelPress();
    if (editing) finishEdit(editing.span.textContent); // closing saves the text the same way leaving the field does
    open = false;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    document.body.classList.remove("todo-open");
    btn.setAttribute("aria-expanded", "false");
    btn.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniTodo === true) {
      backPending = new Promise((resolve) => {
        resolveBack = resolve;
      });
      history.back();
      return backPending;
    }
    return Promise.resolve();
  }

  // ---------- events ----------

  closeBtn.addEventListener("click", () => closePanel());
  $("todoBack").addEventListener("click", () => closePanel());
  scrim.addEventListener("click", () => closePanel());

  const rePlaceMenu = () => {
    if (menu && menu.anchor.isConnected) placeMenu(menu.anchor);
  };
  window.addEventListener("resize", rePlaceMenu);
  if (window.visualViewport) {
    const reposition = () => {
      if (open) {
        place();
        if (editing) revealEditing();
      }
      rePlaceMenu();
    };
    window.visualViewport.addEventListener("resize", reposition);
    window.visualViewport.addEventListener("scroll", reposition);
  }

  // Its own history entry. The popstate from our history.back() only settles the pending close; a Back press closes the
  // panel and leaves whatever is underneath open.
  window.addEventListener("popstate", (event) => {
    if (resolveMenuBack) {
      const resolve = resolveMenuBack;
      resolveMenuBack = null;
      menuBack = null;
      resolve();
      event.stopImmediatePropagation();
      return;
    }
    if (menu && !(event.state && event.state.hermesMiniTodoMenu === true)) {
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
    if (open && !(event.state && event.state.hermesMiniTodo === true)) {
      closePanel({ viaPop: true });
      event.stopImmediatePropagation();
    }
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (!open) return;
      // While a row is being edited or dragged, Escape undoes only that and leaves the panel open, so it is handled here
      // before the panel's own Escape below.
      if (editing) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finishEdit(null);
        }
        return;
      }
      if (drag) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelDrag();
        }
        return;
      }
      if (menu) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void closeMenu();
        }
        return;
      }
      // The confirm dialog is above this one and handles its own keys (confirm.js); leave Escape and Tab to it.
      if (confirmEl && confirmEl.classList.contains("open")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
        return;
      }
      if (event.key === "Tab") {
        // Focus stays inside the panel while it is open.
        const nodes = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled])")];
        if (!nodes.length) return;
        event.preventDefault();
        const index = nodes.indexOf(document.activeElement);
        const next = event.shiftKey
          ? (index <= 0 ? nodes.length - 1 : index - 1)
          : (index === -1 || index === nodes.length - 1 ? 0 : index + 1);
        nodes[next].focus({ preventScroll: true });
      }
    },
    true,
  );

  return { open: openPanel, close: closePanel, refresh, isOpen: () => open };
}
