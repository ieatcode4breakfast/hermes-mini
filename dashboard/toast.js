// Toasts: one short word ("Copied", "Pasted") in a small pill near the bottom of the screen,
// above everything (the computer pane included), gone after 1.6 s. One at a time: a new toast replaces the old.
let node = null;
let hideTimer = 0;

// tone: "success" (green) or "error" (red) for a clearly good or bad result; leave it out for a neutral one.
export function showToast(text, tone = "") {
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.remove("show", "success", "error");
  if (tone === "success" || tone === "error") node.classList.add(tone);
  void node.offsetWidth; // restart the fade when a toast replaces a visible one
  node.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => node.classList.remove("show"), 1600);
}
