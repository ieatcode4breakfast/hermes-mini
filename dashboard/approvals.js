// Approval mode picker: an icon-only tab on the input pill's top edge, right of the model tab, and a bottom sheet behind it, matching model.js.
// Everything goes through Hermes's own gateway config methods (profile-scoped, immediate, no restarts):
//   config.get {key: "approvals.mode"} -> {value: "manual"|"smart"|"off"}
//   config.set {key: "approvals.mode", value: "manual"|"smart"|"off"} -> {key, value}

import { openPopover, closePopover } from "./toast.js";

export const APPROVAL_MODES = [
  {
    value: "manual",
    label: "Manual",
    description: "Ask before running risky commands.",
    danger: false,
  },
  {
    value: "smart",
    label: "Smart",
    description: "Automatically review risky commands, allowing safe ones and blocking dangerous ones.",
    danger: false,
  },
  {
    value: "off",
    label: "Off",
    description: "Run commands without asking for approval. Explicit deny rules still apply.",
    danger: true,
  },
];

const VALID = new Set(APPROVAL_MODES.map((m) => m.value));

const SHIELD_MANUAL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';
const SHIELD_SMART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M13 8l-3 4h4l-3 4"/></svg>';
const SHIELD_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.69 14a6.9 6.9 0 0 0 .31-2V5l-8-3-3.16 1.18"/><path d="M4.73 4.73L4 5v7c0 6 8 10 8 10a20.29 20.29 0 0 0 5.62-4.38"/><path d="M2 2l20 20"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4.5 4.5L19 7"/></svg>';
const CLOSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function modeInfo(value) {
  return APPROVAL_MODES.find((m) => m.value === value) || APPROVAL_MODES[0];
}

function errorText(error) {
  return (error && (error.message || String(error))) || "Could not update approval mode";
}

export function createApprovalPicker({ rpc, confirmDialog, showToast, chip }) {
  let mode = "";
  let saving = false;
  let sheet = null;
  let parts = null;

  function paintChip() {
    if (!chip) return;
    if (!VALID.has(mode)) {
      chip.hidden = true;
      return;
    }
    const info = modeInfo(mode);
    const isOff = info.value === "off";
    const icon = chip.querySelector(".approval-tab-icon");
    const label = chip.querySelector(".approval-tab-label");
    if (icon) icon.innerHTML = isOff ? SHIELD_OFF_SVG : info.value === "smart" ? SHIELD_SMART_SVG : SHIELD_MANUAL_SVG;
    if (label) label.textContent = info.label;
    chip.classList.toggle("is-off", isOff);
    chip.setAttribute("aria-label", `Approvals: ${info.label}`);
    chip.title = `Approvals: ${info.label}`;
    chip.hidden = false;
    if (parts) renderOptions();
  }

  async function refresh() {
    try {
      const result = await rpc("config.get", { key: "approvals.mode" });
      const value = String((result && result.value) || "").trim().toLowerCase();
      if (VALID.has(value)) {
        mode = value;
        paintChip();
      }
    } catch {
      // Offline or older gateway without config.get: keep the last known state (or stay hidden).
    }
  }

  function build() {
    const scrim = node("div", "scrim");
    scrim.setAttribute("aria-hidden", "true");
    scrim.setAttribute("popover", "manual");

    sheet = node("div", "model-sheet approval-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Approval mode");
    sheet.setAttribute("popover", "manual");

    const head = node("div", "model-head");
    const titleWrap = node("div", "model-title-wrap");
    titleWrap.append(node("h2", "model-title", "Approvals"));
    const closeBtn = node("button", "model-close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = CLOSE_SVG;
    closeBtn.addEventListener("click", close);
    head.append(titleWrap, closeBtn);

    const list = node("div", "approval-list");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "Approval mode");

    sheet.append(head, list);
    document.body.append(scrim, sheet);
    parts = { scrim, list };

    scrim.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !sheet.classList.contains("open")) return;
      const confirmEl = document.getElementById("confirmDialog");
      if (confirmEl && confirmEl.classList.contains("open")) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    });
  }

  function renderOptions() {
    if (!parts) return;
    parts.list.replaceChildren();
    for (const item of APPROVAL_MODES) {
      const selected = mode === item.value;
      const btn = node("button", `approval-option${selected ? " selected" : ""}${item.danger ? " danger" : ""}`);
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(selected));
      btn.disabled = saving;

      const copy = node("span", "approval-option-copy");
      copy.append(
        node("span", "approval-option-title", item.label),
        node("span", "approval-option-desc", item.description),
      );
      const check = node("span", "approval-option-check");
      check.setAttribute("aria-hidden", "true");
      if (selected) check.innerHTML = CHECK_SVG;

      btn.append(copy, check);
      btn.addEventListener("click", () => void pick(item.value));
      parts.list.append(btn);
    }
  }

  async function pick(nextMode) {
    if (saving || !VALID.has(nextMode)) return;
    if (nextMode === mode) {
      close();
      return;
    }
    if (nextMode === "off") {
      const ok = await confirmDialog({
        title: "Turn off approvals?",
        message: "Commands will run without asking for your approval first. Explicit deny rules in Hermes still apply.",
        confirmLabel: "Turn off",
        danger: true,
      });
      if (!ok) return;
    }
    saving = true;
    renderOptions();
    try {
      const result = await rpc("config.set", { key: "approvals.mode", value: nextMode });
      const saved = String((result && result.value) || nextMode).trim().toLowerCase();
      if (VALID.has(saved)) mode = saved;
      paintChip();
      const label = modeInfo(mode).label;
      showToast(mode === "off" ? "Approvals off" : `Approvals: ${label}`, mode === "off" ? "error" : "success");
      close();
    } catch (error) {
      showToast(errorText(error), "error");
    } finally {
      saving = false;
      renderOptions();
    }
  }

  async function open() {
    if (!sheet) build();
    renderOptions();
    openPopover(parts.scrim);
    openPopover(sheet);
    parts.scrim.classList.add("open");
    sheet.classList.add("open");
    chip?.setAttribute("aria-expanded", "true");
    void refresh();
  }

  function close() {
    if (!sheet) return;
    sheet.classList.remove("open");
    parts.scrim.classList.remove("open");
    closePopover(parts.scrim, 260);
    closePopover(sheet, 260);
    chip?.setAttribute("aria-expanded", "false");
  }

  chip?.addEventListener("click", () => void open());
  paintChip();

  return { refresh, open, close, getMode: () => mode };
}
