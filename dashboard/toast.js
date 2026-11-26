// Transient feedback and dismissible error toasts share the same placement above open panels.

// Every menu, popup window and toast is drawn in the browser's top layer with the Popover API
// (popover="manual"), so no z-index and no stacking context can put one behind another element. The app keeps
// its own open/close logic (classes, [hidden], Escape, history): these helpers only mirror that state into the
// top layer. A browser without the API gets the old layered drawing, and nothing else changes.
const popoverReady = (el) => Boolean(el) && el.hasAttribute("popover")
  && typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

const hideTimers = new WeakMap();

// Puts el in the top layer while it is still in its closed state (opacity 0, visibility hidden), so the
// caller's .open or [hidden] change right after it still animates in.
export function openPopover(el) {
  if (!popoverReady(el)) return;
  const pending = hideTimers.get(el);
  if (pending) {
    clearTimeout(pending);
    hideTimers.delete(el);
  }
  if (el.matches(":popover-open")) return;
  try {
    el.showPopover();
  } catch {
    return; // not connected, or a state the browser refuses: the old layering still shows it
  }
  void el.offsetWidth;
  if (persistentToast?.classList.contains("show")) reopenPopover(persistentToast);
}

// Takes el out of the top layer once its close transition has played (delay in ms, 0 = now). A reopen before
// then cancels the timer, so a quick open-close-open never loses the popover.
export function closePopover(el, delay = 0) {
  if (!popoverReady(el)) return;
  const pending = hideTimers.get(el);
  if (pending) clearTimeout(pending);
  const hide = () => {
    hideTimers.delete(el);
    if (!el.matches(":popover-open")) return;
    try {
      el.hidePopover();
    } catch {
      /* already gone */
    }
  };
  if (delay > 0) hideTimers.set(el, setTimeout(hide, delay));
  else hide();
}

// Hide then show, so el becomes the last (topmost) thing in the top layer: a toast shown while a dialog is
// open must be visible above it.
export function reopenPopover(el) {
  if (!popoverReady(el)) return;
  const pending = hideTimers.get(el);
  if (pending) {
    clearTimeout(pending);
    hideTimers.delete(el);
  }
  if (el.matches(":popover-open")) {
    try {
      el.hidePopover();
    } catch {
      /* gone between the check and the call */
    }
  }
  try {
    el.showPopover();
  } catch {
    return;
  }
  void el.offsetWidth;
}

function toastDetails(detail) {
  const disclosure = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Details";
  const text = document.createElement("p");
  text.textContent = detail;
  disclosure.append(summary, text);
  return disclosure;
}

export function inlineNotice() {
  const box = document.createElement("div");
  box.className = "inline-notice";
  box.hidden = true;
  const copy = document.createElement("p");
  copy.setAttribute("role", "status");
  box.append(copy);

  return {
    box,
    show(message = "", { detail } = {}) {
      box.hidden = !message;
      copy.textContent = message;
      copy.nextElementSibling?.remove();
      if (detail && detail !== message) box.append(toastDetails(detail));
    },
  };
}

let persistentToast = null;
let persistentCopy = null;
let persistentDetails = null;
let returnFocus = null;

export function showPersistentToast(text, { detail, tone = "error" } = {}) {
  if (!persistentToast) {
    persistentToast = document.createElement("div");
    persistentToast.className = "toast toast-persistent";
    persistentToast.setAttribute("popover", "manual");
    persistentCopy = document.createElement("div");
    persistentCopy.setAttribute("role", "status");
    persistentCopy.setAttribute("aria-atomic", "true");
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "toast-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss message");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", (event) => {
      persistentToast.classList.remove("show");
      persistentToast.hidden = true;
      closePopover(persistentToast);
      if (event.detail === 0 && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    });
    persistentToast.append(persistentCopy, dismiss);
    document.body.append(persistentToast);
  }

  if (!persistentToast.contains(document.activeElement)) returnFocus = document.activeElement;
  persistentToast.hidden = false;
  persistentToast.dataset.tone = tone;
  persistentCopy.textContent = text;
  persistentDetails?.remove();
  persistentDetails = detail && detail !== text ? toastDetails(detail) : null;
  if (persistentDetails) persistentToast.append(persistentDetails);
  reopenPopover(persistentToast);
  persistentToast.classList.add("show");
}

let node = null;
let textNode = null;
let hideTimer = 0;

// tone: "success" (green) or "error" (red) for a clearly good or bad result; leave it out for a neutral one.
export function showToast(text, tone = "") {
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    node.setAttribute("popover", "manual");
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    textNode = document.createElement("span");
    textNode.className = "toast-text";
    node.append(textNode);
    document.body.append(node);
  }
  textNode.textContent = text;
  node.classList.remove("show", "success", "error", "toast-wrapped");
  if (tone === "success" || tone === "error") node.classList.add(tone);
  // Last in the top layer (above any open dialog), then faded in from its closed state.
  reopenPopover(node);
  const wrapped = textNode.offsetHeight > parseFloat(getComputedStyle(textNode).lineHeight) + 1;
  node.classList.toggle("toast-wrapped", wrapped);
  node.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    node.classList.remove("show");
    closePopover(node, 300); // keep it in the top layer while the fade-out plays
  }, wrapped ? 3200 : 1600);
}
