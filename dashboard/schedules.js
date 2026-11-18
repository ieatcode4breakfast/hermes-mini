// Schedules: the agent's scheduled jobs, opened from the Tools tray. It reads Hermes's own cron list (GET
// /api/cron/jobs) on every open. Each row says what the job is, when it runs in plain words, and when it runs next; a
// job running right now says so. Each row's ⋮ menu (also a right click, or a long press on touch) offers: Add to
// message (the job goes into the draft at the caret as an inline pill), Pause/Resume, and Delete (asks first).
// Pause, resume and delete go through Hermes's own routes. Nothing else is editable here.

import { confirmDialog } from "./confirm.js";
import { showToast, openPopover, closePopover } from "./toast.js";

const $ = (id) => document.getElementById(id);
const MENTION_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const RESUME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></svg>';
const DOTS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const LONG_PRESS_MS = 480;

// What the agent receives for a schedule added to a message: its name and its job id, in a tag the app turns back into
// a pill in the sent bubble and in history (app.js SCHEDULE_REF). A "]" in a name would end the tag early, so it is
// swapped for ")".
export function mentionText(item) {
  return `[Schedule: ${String(item.title).replace(/\]/g, ")")} · job ${item.id}]`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "assistant-debrief-morning" -> "Assistant debrief morning". A job with no name falls back to its instruction.
export function jobTitle(job) {
  const name = String(job.name || "").trim();
  if (name) {
    const words = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  const prompt = String(job.prompt || "").trim().split("\n")[0];
  return prompt.length > 60 ? `${prompt.slice(0, 57).trimEnd()}…` : prompt || "Scheduled job";
}

function clock(hour, minute) {
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

function ordinal(n) {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${tail}`;
}

// "1,3-5" -> [1, 3, 4, 5]; null for anything else (steps, names, "*").
function numbers(field, min, max) {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(field)) return null;
  const out = [];
  for (const part of field.split(",")) {
    const [a, b = a] = part.split("-").map(Number);
    if (a < min || b > max || a > b) return null;
    for (let n = a; n <= b; n += 1) out.push(n);
  }
  return out;
}

function list(words) {
  return words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function cronDays(dom, mon, dow) {
  if (dom === "*" && mon === "*") {
    if (dow === "*") return "Every day";
    const days = numbers(dow, 0, 7);
    if (!days) return null;
    const set = [...new Set(days.map((d) => d % 7))].sort();
    const key = set.join(",");
    if (key === "1,2,3,4,5") return "Weekdays";
    if (key === "0,6") return "Weekends";
    if (set.length === 1) return `${DAYS[set[0]]}s`;
    const short = set.map((d) => DAYS[d].slice(0, 3));
    if (set.length >= 3 && set.at(-1) - set[0] === set.length - 1) return `${short[0]}–${short.at(-1)}`;
    return list(short);
  }
  if (dow !== "*") return null;
  const dates = numbers(dom, 1, 31);
  if (!dates) return null;
  const span = dates.length > 1 && dates.at(-1) - dates[0] === dates.length - 1
    ? `${dates[0]}–${dates.at(-1)}` : dates.join(", ");
  if (mon === "*") return `Monthly on the ${dates.length === 1 ? ordinal(dates[0]) : list(dates.map(ordinal))}`;
  const months = numbers(mon, 1, 12);
  if (!months || months.length !== 1) return null;
  return `On ${MONTHS[months[0] - 1]} ${span}`;
}

// A five-field cron expression in plain words, or "" when it is not one of the everyday shapes.
export function cronWords(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return "";
  const [min, hour, dom, mon, dow] = parts;
  const days = cronDays(dom, mon, dow);
  if (!days) return "";
  const prefix = days === "Every day" ? "" : `${days}, `;
  const step = (field) => (/^\*\/(\d+)$/.exec(field) || [])[1];
  if (hour === "*" || step(hour)) {
    let freq;
    if (min === "*" && hour === "*") freq = "every minute";
    else if (step(min) && hour === "*") freq = `every ${step(min)} minutes`;
    else if (/^\d+$/.test(min) && hour === "*") freq = "every hour";
    else if (/^\d+$/.test(min) && step(hour)) freq = `every ${step(hour)} hours`;
    else return "";
    return prefix ? `${prefix}${freq}` : freq.charAt(0).toUpperCase() + freq.slice(1);
  }
  const minutes = numbers(min, 0, 59);
  const hours = numbers(hour, 0, 23);
  if (!minutes || !hours) return "";
  const times = [];
  for (const h of hours) for (const m of minutes) times.push([h, m]);
  times.sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
  if (times.length > 3) return `${prefix}${times.length} times a day`;
  return `${days} at ${list(times.map(([h, m]) => clock(h, m)))}`;
}

function intervalWords(minutes) {
  const n = Number(minutes) || 0;
  if (n <= 0) return "";
  if (n % 1440 === 0) return n === 1440 ? "Every day" : `Every ${n / 1440} days`;
  if (n % 60 === 0) return n === 60 ? "Every hour" : `Every ${n / 60} hours`;
  return n === 1 ? "Every minute" : `Every ${n} minutes`;
}

export function scheduleWords(job) {
  const schedule = job.schedule || {};
  if (schedule.kind === "once") return "One time";
  if (schedule.kind === "interval") return intervalWords(schedule.minutes) || "Repeats";
  if (schedule.kind === "cron") return cronWords(schedule.expr) || "Custom schedule";
  return "Custom schedule";
}

// "Today, 9:00 pm", "Tomorrow, 3:00 am", "Friday, 7:45 am", "Nov 28, 9:00 am", in this device's time.
export function whenWords(iso, now = new Date()) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const time = clock(date.getHours(), date.getMinutes());
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86400000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days > 1 && days < 7) return `${DAYS[date.getDay()]}, ${time}`;
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${time}`;
}

export function isRunning(job) {
  return Boolean(job.run_claim || job.fire_claim);
}

// The rows the sheet shows: running first, then by next run, paused last. Finished one-time jobs are left out.
export function scheduleRows(jobs, now = new Date()) {
  const rows = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== "object") continue;
    const paused = job.state === "paused" || job.enabled === false;
    const running = isRunning(job);
    if (!running && (job.state === "completed" || (!paused && !job.next_run_at))) continue;
    const next = paused ? null : new Date(job.next_run_at || 0);
    rows.push({
      id: String(job.id || ""),
      title: jobTitle(job),
      when: scheduleWords(job),
      next: paused || running ? "" : whenWords(job.next_run_at, now),
      running,
      paused,
      failed: Boolean(job.last_status) && job.last_status !== "ok" && !running,
      order: running ? -Infinity : paused ? Infinity : next.getTime(),
    });
  }
  rows.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return rows;
}

export function createSchedules({ api, mention = null }) {
  const btn = $("schedBtn");
  const scrim = $("schedScrim");
  const dialog = $("schedDialog");
  const listEl = $("schedList");
  const emptyEl = $("schedEmpty");

  let open = false;
  let loadSeq = 0;
  let backPending = null; // a history.back() from an in-app close is still in flight
  let resolveBack = null;

  const busy = new Set(); // job ids with a pause, resume or delete in flight

  // ---------- the row menu: the chat list's ⋮ card (style.css .row-menu), filled per row ----------
  const menuScrim = document.createElement("div");
  menuScrim.className = "scrim sched-menu-scrim";
  menuScrim.setAttribute("aria-hidden", "true");
  menuScrim.setAttribute("popover", "manual");
  const menuEl = document.createElement("div");
  menuEl.className = "row-menu sched-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.setAttribute("aria-label", "Schedule actions");
  menuEl.setAttribute("popover", "manual");
  document.body.append(menuScrim, menuEl);
  let menu = null; // { item, anchor, row } while open
  let pressOpenedAt = 0; // when a long press opened the menu: the lifting finger's click must not close it
  let menuBack = null;
  let resolveMenuBack = null;

  function menuItem(label, icon, pick, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `row-menu-item${danger ? " danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.innerHTML = `${icon}<span>${label}</span>`;
    button.addEventListener("click", () => {
      if (Date.now() - pressOpenedAt < 600) return; // the long press's own lift, not a choice
      void closeMenu().then(pick);
    });
    return button;
  }

  // Under the ⋮ (right edges together), flipped above it near the bottom, kept 8px inside the screen.
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

  function openMenu(item, row) {
    if (menu || busy.has(item.id)) return;
    if (menuBack) {
      menuBack.then(() => openMenu(item, row));
      return;
    }
    const anchor = row.querySelector(".sched-dots") || row;
    menu = { item, anchor, row };
    const items = [];
    if (mention && mention.available()) items.push(menuItem("Add to message", MENTION_ICON, () => addToMessage(item)));
    items.push(menuItem(item.paused ? "Resume" : "Pause", item.paused ? RESUME_ICON : PAUSE_ICON, () => togglePause(item)));
    items.push(menuItem("Delete", DELETE_ICON, () => void remove(item), true));
    menuEl.replaceChildren(...items);
    row.classList.add("menu-open");
    anchor.setAttribute("aria-expanded", "true");
    // Top layer first (still in its closed state), so its size can be measured before it is placed.
    openPopover(menuScrim);
    openPopover(menuEl);
    placeMenu(anchor);
    menuScrim.classList.add("open");
    menuEl.classList.add("open");
    if (!(history.state && history.state.hermesMiniSchedMenu === true)) history.pushState({ hermesMiniSchedMenu: true }, "");
    items[0].focus({ preventScroll: true });
  }

  function closeMenu({ viaPop = false } = {}) {
    const m = menu;
    if (!m) return Promise.resolve();
    menu = null;
    m.row.classList.remove("menu-open");
    m.anchor.setAttribute("aria-expanded", "false");
    menuScrim.classList.remove("open");
    menuEl.classList.remove("open");
    // Out of the top layer once the fade-out has played.
    closePopover(menuScrim, 160);
    closePopover(menuEl, 160);
    if (m.anchor.isConnected) m.anchor.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniSchedMenu === true) {
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
    const items = [...menuEl.querySelectorAll(".row-menu-item")];
    const i = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });

  // ---------- actions ----------
  async function act(item, run, failure) {
    if (busy.has(item.id)) return;
    busy.add(item.id);
    render();
    try {
      await run();
    } catch {
      showToast(failure, "error");
    } finally {
      busy.delete(item.id);
      await refresh();
    }
  }

  function togglePause(item) {
    const verb = item.paused ? "resume" : "pause";
    void act(item, () => api(`/api/cron/jobs/${encodeURIComponent(item.id)}/${verb}`, { method: "POST" }),
      item.paused ? "Couldn't resume that schedule" : "Couldn't pause that schedule");
  }

  async function remove(item) {
    const ok = await confirmDialog({
      title: "Delete schedule?",
      message: `"${item.title}" won't run again.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    void act(item, () => api(`/api/cron/jobs/${encodeURIComponent(item.id)}`, { method: "DELETE" }),
      "Couldn't delete that schedule");
  }

  // Closes the panel and adds the job to the draft at the caret, as an inline pill (app.js addMention).
  async function addToMessage(item) {
    await closePanel();
    mention.add({ id: item.id, title: item.title });
  }

  let rows = [];
  function render() {
    listEl.replaceChildren(...rows.map(row));
  }

  function row(item) {
    const node = document.createElement("div");
    node.className = `sched-row${item.paused ? " paused" : ""}${item.running ? " running" : ""}${busy.has(item.id) ? " busy" : ""}`;
    const text = document.createElement("div");
    text.className = "sched-text";
    const title = document.createElement("div");
    title.className = "sched-name";
    title.textContent = item.title;
    const meta = document.createElement("div");
    meta.className = "sched-meta";
    const when = document.createElement("span");
    when.textContent = item.when;
    meta.append(when);
    const status = document.createElement("span");
    status.className = "sched-status";
    if (item.running) status.textContent = "Running now";
    else if (item.paused) status.textContent = "Paused";
    else if (item.next) status.textContent = `Next: ${item.next}`;
    if (status.textContent) meta.append(status);
    text.append(title, meta);
    if (item.failed) {
      const note = document.createElement("div");
      note.className = "sched-failed";
      note.textContent = "Last run didn't finish";
      text.append(note);
    }
    node.append(text);
    if (!item.id) return node;
    const dots = document.createElement("button");
    dots.type = "button";
    dots.className = "sched-dots";
    dots.setAttribute("aria-label", `Options for ${item.title}`);
    dots.setAttribute("aria-haspopup", "menu");
    dots.setAttribute("aria-expanded", "false");
    dots.innerHTML = DOTS_ICON;
    dots.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(item, node);
    });
    node.append(dots);
    // The chat list's other ways in: a right click, or a long press on touch (a move of more than 8px is a scroll).
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(item, node);
    });
    let press = null;
    node.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || event.target.closest(".sched-dots")) return;
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
    return node;
  }

  function show(message, list = []) {
    rows = list;
    render();
    emptyEl.textContent = message;
    emptyEl.hidden = !message;
  }

  async function refresh() {
    const seq = ++loadSeq;
    if (!listEl.childElementCount) show("Loading…");
    try {
      const data = await api("/api/cron/jobs");
      if (seq !== loadSeq) return;
      const list = scheduleRows(Array.isArray(data) ? data : (data && data.jobs) || []);
      show(list.length ? "" : "Nothing scheduled", list);
    } catch {
      if (seq !== loadSeq) return;
      if (!listEl.childElementCount) show("Couldn't load schedules");
    }
  }

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
    document.body.classList.add("sched-open");
    btn.setAttribute("aria-expanded", "true");
    if (!(history.state && history.state.hermesMiniSched === true)) history.pushState({ hermesMiniSched: true }, "");
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
    requestAnimationFrame(() => {
      if (open) dialog.focus({ preventScroll: true });
    });
    void refresh();
  }

  function closePanel({ viaPop = false } = {}) {
    if (!open) return Promise.resolve();
    if (menu && !viaPop) return closeMenu().then(() => closePanel());
    if (menu) void closeMenu({ viaPop: true });
    open = false;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    document.body.classList.remove("sched-open");
    btn.setAttribute("aria-expanded", "false");
    // Back to the Schedules row when it is on screen (a docked panel); with the panel closed, to the panel's button.
    const back = btn.offsetParent ? btn : document.getElementById("menuBtn");
    if (back && back.offsetParent) back.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniSched === true) {
      backPending = new Promise((resolve) => {
        resolveBack = resolve;
      });
      history.back();
      return backPending;
    }
    return Promise.resolve();
  }

  $("schedClose").addEventListener("click", () => closePanel());
  $("schedBack").addEventListener("click", () => closePanel());
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
    if (menu && !(event.state && event.state.hermesMiniSchedMenu === true)) {
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
    if (open && !(event.state && event.state.hermesMiniSched === true)) {
      closePanel({ viaPop: true });
      event.stopImmediatePropagation();
    }
  });

  return { open: openPanel, close: closePanel, isOpen: () => open, refresh };
}
