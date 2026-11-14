// Schedules: a read-only list of the agent's scheduled jobs, opened from the button above the Computer button.
// It reads Hermes's own cron list (GET /api/cron/jobs) on every open and changes nothing. Each row says what the job
// is, when it runs in plain words, and when it runs next; a job running right now says so.

const $ = (id) => document.getElementById(id);

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

export function createSchedules({ api }) {
  const btn = $("schedBtn");
  const scrim = $("schedScrim");
  const dialog = $("schedDialog");
  const listEl = $("schedList");
  const emptyEl = $("schedEmpty");

  let open = false;
  let loadSeq = 0;
  let backPending = null; // a history.back() from an in-app close is still in flight
  let resolveBack = null;

  function row(item) {
    const node = document.createElement("div");
    node.className = `sched-row${item.paused ? " paused" : ""}${item.running ? " running" : ""}`;
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
    node.append(title, meta);
    if (item.failed) {
      const note = document.createElement("div");
      note.className = "sched-failed";
      note.textContent = "Last run didn't finish";
      node.append(note);
    }
    return node;
  }

  function show(message, rows = []) {
    listEl.replaceChildren(...rows.map(row));
    emptyEl.textContent = message;
    emptyEl.hidden = !message;
  }

  async function refresh() {
    const seq = ++loadSeq;
    if (!listEl.childElementCount) show("Loading…");
    try {
      const data = await api("/api/cron/jobs");
      if (seq !== loadSeq) return;
      const rows = scheduleRows(Array.isArray(data) ? data : (data && data.jobs) || []);
      show(rows.length ? "" : "Nothing scheduled", rows);
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
    open = false;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    document.body.classList.remove("sched-open");
    btn.setAttribute("aria-expanded", "false");
    btn.focus({ preventScroll: true });
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
  window.addEventListener("popstate", (event) => {
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
