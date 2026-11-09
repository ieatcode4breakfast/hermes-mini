// Shared confirm dialog: one in-app alertdialog used wherever the app used to call window.confirm.
// confirmDialog({ title, message, confirmLabel, danger }) returns a Promise<boolean> (true = confirmed).
// It follows the rename dialog's history pattern: one entry is pushed on open, and every in-app close consumes it
// with history.back(); a Back press pops it and only closes the dialog. The popstate handler is registered at module
// load, before drawer.js and app.js register theirs, so while the dialog is open it settles the event itself and
// stops it reaching the overlays underneath.

const $ = (id) => document.getElementById(id);

let scrim = null;
let dialog = null;
let titleEl = null;
let messageEl = null;
let cancelBtn = null;
let okBtn = null;

let active = null; // { resolve, prevFocus } while the dialog is open
let backPending = null; // promise: a history.back() from an in-app close is still in flight
let resolveBack = null;

function init() {
  if (dialog) return;
  scrim = $("confirmScrim");
  dialog = $("confirmDialog");
  titleEl = $("confirmTitle");
  messageEl = $("confirmMessage");
  cancelBtn = $("confirmCancel");
  okBtn = $("confirmOk");

  cancelBtn.addEventListener("click", () => close(false));
  okBtn.addEventListener("click", () => close(true));
  scrim.addEventListener("click", () => close(false));
}

export function confirmDialog({ title = "", message = "", confirmLabel = "Confirm", danger = false } = {}) {
  init();
  if (active) return Promise.resolve(false); // only one dialog at a time
  if (backPending) return backPending.then(() => confirmDialog({ title, message, confirmLabel, danger }));
  return open({ title, message, confirmLabel, danger });
}

function open({ title, message, confirmLabel, danger }) {
  titleEl.textContent = title;
  messageEl.textContent = message;
  okBtn.textContent = confirmLabel || "Confirm";
  okBtn.classList.toggle("danger", Boolean(danger));

  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  active = { resolve, prevFocus: document.activeElement };

  scrim.classList.add("open");
  dialog.classList.add("open");
  if (!(history.state && history.state.hermesMiniConfirm === true)) history.pushState({ hermesMiniConfirm: true }, "");
  requestAnimationFrame(() => {
    if (active) cancelBtn.focus({ preventScroll: true }); // Cancel first: Enter cancels, never confirms by accident
  });
  return promise;
}

// Closes the dialog. An in-app close consumes the history entry the dialog pushed; a Back-button close has popped it.
// Focus returns to whatever was focused before the dialog opened.
function close(result, { viaPop = false } = {}) {
  const a = active;
  if (!a) return;
  active = null;
  scrim.classList.remove("open");
  dialog.classList.remove("open");
  if (a.prevFocus && a.prevFocus.isConnected && typeof a.prevFocus.focus === "function") {
    a.prevFocus.focus({ preventScroll: true });
  }
  if (!viaPop && history.state && history.state.hermesMiniConfirm === true) {
    backPending = new Promise((resolve) => {
      resolveBack = resolve;
    });
    history.back();
  }
  a.resolve(result);
}

// The dialog's own history entry. Its popstate from our history.back() only settles the pending close; a Back press
// closes the dialog and leaves whatever is underneath (drawer, row menu, rename) open.
window.addEventListener("popstate", (event) => {
  if (resolveBack) {
    const resolve = resolveBack;
    resolveBack = null;
    backPending = null;
    resolve();
    event.stopImmediatePropagation();
    return;
  }
  if (active && !(event.state && event.state.hermesMiniConfirm === true)) {
    close(false, { viaPop: true });
    event.stopImmediatePropagation();
  }
});

document.addEventListener(
  "keydown",
  (event) => {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(false);
      return;
    }
    if (event.key === "Tab") {
      // Focus stays between Cancel and the confirm button while the dialog is open.
      event.preventDefault();
      event.stopPropagation();
      const items = [cancelBtn, okBtn].filter((node) => !node.disabled);
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? items.length - 1 : index - 1)
        : (index === -1 || index === items.length - 1 ? 0 : index + 1);
      items[next].focus({ preventScroll: true });
      return;
    }
    // Keep the row menu's arrow-key navigation underneath from moving focus behind the dialog.
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) event.stopPropagation();
  },
  true,
);
