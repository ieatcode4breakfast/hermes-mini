// Toasts: one short word ("Copied", "Pasted") in a small pill near the bottom of the screen,
// above everything (the computer pane included), gone after 1.6 s. One at a time: a new toast replaces the old.

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

let node = null;
let hideTimer = 0;

// tone: "success" (green) or "error" (red) for a clearly good or bad result; leave it out for a neutral one.
export function showToast(text, tone = "") {
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    node.setAttribute("popover", "manual");
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.remove("show", "success", "error");
  if (tone === "success" || tone === "error") node.classList.add(tone);
  // Last in the top layer (above any open dialog), then faded in from its closed state.
  reopenPopover(node);
  node.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    node.classList.remove("show");
    closePopover(node, 300); // keep it in the top layer while the fade-out plays
  }, 1600);
}
