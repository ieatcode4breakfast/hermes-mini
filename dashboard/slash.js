// The "/" picker: typing "/" at the start of a word in the message box lists the agent's skills and schedules above
// it. Picking one puts it in the draft as an inline pill (app.js addPill), the same pill a schedule's "Add to message"
// makes. Skills come from Hermes's skill list (GET /api/skills: enabled skills only, the same set Hermes accepts as
// "/name" commands), schedules from GET /api/cron/jobs (the Scheduled panel's rows). Both are fetched when the picker
// opens and kept for a minute while it is used.
//
// Also here: describeSkillInvocation, the JS twin of Hermes's agent/skill_commands.py describe_skill_invocation. A
// message sent with skills is stored as the expanded skill text; the transcript shows it as the skill pills and the
// person's own words instead.
import { openPopover, closePopover } from "./toast.js";
import { scheduleRows } from "./schedules.js";

export const SKILL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const CACHE_MS = 60_000;
const MAX_PER_GROUP = 40;

// The "/word" the caret is in, or null: a slash at the start of the text or after whitespace, then no whitespace or
// slash up to the caret. "/usr/lo" is a path, not a query.
export function slashQuery(value, caret) {
  const before = String(value || "").slice(0, caret);
  const m = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

// Lower case, with dashes, underscores and runs of spaces as one space: "weekly-review" matches "weekly rev".
function norm(value) {
  return String(value || "").toLowerCase().replace(/[-_\s]+/g, " ").trim();
}

// 0: the name starts with the query, 1: a word in it does, 2: the name contains it, 3: the description does.
function score(query, name, description = "") {
  if (!query) return 0;
  const n = norm(name);
  if (n.startsWith(query)) return 0;
  if (n.split(" ").some((word) => word.startsWith(query))) return 1;
  if (n.includes(query)) return 2;
  if (norm(description).includes(query)) return 3;
  return -1;
}

// The picker's two lists for a query: skills (best match first, then most used, then by name) and schedules (best
// match first, then in the Scheduled panel's order).
export function slashMatches(query, skills, schedules) {
  const q = norm(query);
  const rankedSkills = (skills || [])
    .map((skill) => ({ skill, s: score(q, skill.name, skill.description) }))
    .filter((hit) => hit.s >= 0)
    .sort((a, b) => a.s - b.s || (b.skill.usage || 0) - (a.skill.usage || 0) || a.skill.name.localeCompare(b.skill.name))
    .slice(0, MAX_PER_GROUP)
    .map((hit) => hit.skill);
  const rankedSchedules = (schedules || [])
    .map((row, i) => ({ row, i, s: score(q, row.title) }))
    .filter((hit) => hit.s >= 0 && hit.s < 3)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, MAX_PER_GROUP)
    .map((hit) => hit.row);
  return { skills: rankedSkills, schedules: rankedSchedules };
}

// Hermes's GET /api/skills rows as the picker's skills: enabled ones only, with name, description and use count.
export function skillRows(data) {
  const rows = [];
  for (const skill of Array.isArray(data) ? data : []) {
    if (!skill || typeof skill !== "object" || skill.enabled === false) continue;
    const name = String(skill.name || "").trim();
    if (!name) continue;
    rows.push({ name, description: String(skill.description || "").trim(), usage: Number(skill.usage) || 0 });
  }
  return rows;
}

// agent/skill_commands.py: the markers a "/skill" message is expanded with. They must match Hermes byte for byte.
const SKILL_PREFIX = "[IMPORTANT: The user has invoked the ";
const SKILL_NAME = /^\[IMPORTANT: The user has invoked the "([^"]*)"/;
const SINGLE_MARKER = "The full skill content is loaded below.]";
const SINGLE_INSTRUCTION = "The user has provided the following instruction alongside the skill invocation: ";
const RUNTIME_NOTE = "\n\n[Runtime note:";
const BUNDLE_MARKER = " skill bundle,";
const BUNDLE_INSTRUCTION = "\nUser instruction: ";
const BUNDLE_FIRST_BLOCK = "\n\n[Loaded as part of the ";
const EXCERPT_JOINT = "\x1e";

function cutAfter(content, marker, stop, last) {
  const at = last ? content.lastIndexOf(marker) : content.indexOf(marker);
  if (at < 0) return null;
  return content.slice(at + marker.length).split(stop)[0].trim() || null;
}

// A stored skill message as { names, text }: the skills it loaded ("humanizer", or each of a stacked "/a /b") and the
// person's own words, whitespace runs as one space (Hermes describe_skill_invocation). null for any other message.
export function describeSkillInvocation(content) {
  if (typeof content !== "string" || !content.startsWith(SKILL_PREFIX)) return null;
  const m = SKILL_NAME.exec(content);
  const name = (m ? m[1] : "").trim();
  let instruction = null;
  if (content.includes(BUNDLE_MARKER)) instruction = cutAfter(content, BUNDLE_INSTRUCTION, BUNDLE_FIRST_BLOCK, false);
  else if (content.includes(SINGLE_MARKER)) instruction = cutAfter(content, SINGLE_INSTRUCTION, RUNTIME_NOTE, true);
  const text = instruction ? instruction.split(EXCERPT_JOINT)[0].split(/\s+/).filter(Boolean).join(" ") : "";
  const names = !name ? [] : name.startsWith("/")
    ? name.split(/\s+/).filter(Boolean).map((part) => part.replace(/^\/+/, "")).filter(Boolean)
    : [name];
  if (!names.length && !text) return null;
  return { names, text };
}

// The same message as one line, the way Hermes's own apps show it: "/humanizer fix this".
export function skillLabel(info) {
  return [...info.names.map((name) => `/${name}`), info.text].filter(Boolean).join(" ");
}

// The picker. input: the message box; anchor: the box's row (the picker sits above it, as wide as it);
// enabled(): whether the draft may take pills now; onPick(item): put the picked { kind, ... } in at the caret.
export function createSlashPicker({ input, anchor, api, enabled, onPick }) {
  const menu = document.createElement("div");
  menu.className = "slash-menu";
  menu.id = "slashMenu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Skills and schedules");
  menu.setAttribute("popover", "manual");
  menu.hidden = true;
  document.body.append(menu);

  let skills = null;
  let schedules = null;
  let loadedAt = 0;
  let loading = null;
  let failed = false;
  let current = null; // { start, query } while open
  let items = []; // the rows on screen, in order: { kind, el, data }
  let active = 0;
  let dismissed = null; // the "/" position Escape closed: stays closed until the caret leaves that word

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const [skillData, jobData] = await Promise.allSettled([api("/api/skills"), api("/api/cron/jobs")]);
      failed = skillData.status === "rejected" && jobData.status === "rejected";
      skills = skillData.status === "fulfilled" ? skillRows(skillData.value) : skills || [];
      const jobs = jobData.status === "fulfilled" ? jobData.value : null;
      schedules = jobs ? scheduleRows(Array.isArray(jobs) ? jobs : jobs.jobs || []) : schedules || [];
      loadedAt = Date.now();
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  function place() {
    const r = anchor.getBoundingClientRect();
    const edge = 8;
    const width = Math.min(Math.max(r.width, 260), window.innerWidth - edge * 2, 460);
    const left = Math.min(Math.max(edge, r.left), window.innerWidth - width - edge);
    const room = Math.max(120, r.top - 10 - edge);
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.min(340, room)}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(edge, r.top - 10 - menu.offsetHeight)}px`;
  }

  function row(kind, data) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item slash-item";
    button.setAttribute("role", "option");
    const icon = document.createElement("span");
    icon.className = "menu-icon";
    icon.insertAdjacentHTML("beforeend", kind === "skill" ? SKILL_ICON : CLOCK_ICON);
    const text = document.createElement("span");
    text.className = "slash-text";
    const name = document.createElement("span");
    name.className = "slash-name";
    name.textContent = kind === "skill" ? data.name : data.title;
    const desc = document.createElement("span");
    desc.className = "slash-desc";
    desc.textContent = kind === "skill" ? data.description : [data.when, data.paused ? "Paused" : data.next].filter(Boolean).join(" · ");
    text.append(name, desc);
    button.append(icon, text);
    // The box keeps the focus (and a phone its keyboard): the pick happens on click.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => pick({ kind, data }));
    return button;
  }

  function group(label) {
    const head = document.createElement("div");
    head.className = "slash-group";
    head.textContent = label;
    return head;
  }

  function render() {
    menu.replaceChildren();
    items = [];
    if (!skills && !schedules) {
      menu.append(Object.assign(document.createElement("div"), { className: "slash-empty", textContent: "Loading…" }));
      return;
    }
    const found = slashMatches(current.query, skills, schedules);
    if (found.skills.length) {
      menu.append(group("Skills"));
      for (const skill of found.skills) items.push({ kind: "skill", data: skill, el: menu.appendChild(row("skill", skill)) });
    }
    if (found.schedules.length) {
      menu.append(group("Scheduled"));
      for (const job of found.schedules) items.push({ kind: "schedule", data: job, el: menu.appendChild(row("schedule", job)) });
    }
    if (!items.length) {
      const words = failed ? "Could not load skills and schedules." : current.query ? "No skills or schedules match." : "No skills or schedules yet.";
      menu.append(Object.assign(document.createElement("div"), { className: "slash-empty", textContent: words }));
    }
    active = Math.min(active, Math.max(0, items.length - 1));
    markActive(false);
  }

  function markActive(scroll = true) {
    items.forEach((item, i) => {
      item.el.classList.toggle("active", i === active);
      item.el.setAttribute("aria-selected", String(i === active));
    });
    if (scroll && items[active]) items[active].el.scrollIntoView({ block: "nearest" });
  }

  function open(query) {
    const fresh = !current || current.start !== query.start;
    current = query;
    if (fresh) active = 0;
    if (menu.hidden) {
      menu.hidden = false;
      openPopover(menu);
    }
    render();
    place();
    if (!loading && (!loadedAt || Date.now() - loadedAt > CACHE_MS)) {
      void load().then(() => {
        if (current) {
          render();
          place();
        }
      });
    }
  }

  function close() {
    current = null;
    items = [];
    if (menu.hidden) return;
    menu.hidden = true;
    closePopover(menu);
  }

  function pick(item) {
    if (!current) return;
    const value = input.value;
    // The whole word after the slash goes, also the part right of the caret ("/hu|man" picks over "/human").
    let end = current.start + 1;
    while (end < value.length && !/\s/.test(value[end])) end += 1;
    input.setRangeText("", current.start, end, "end");
    close();
    onPick(item.kind === "skill" ? { kind: "skill", name: item.data.name } : { kind: "schedule", job: item.data });
  }

  // Called after every edit and caret move: open, update or close for the word the caret is in.
  function sync() {
    const caret = input.selectionStart;
    const query = enabled() && caret === input.selectionEnd && document.activeElement === input
      ? slashQuery(input.value, caret) : null;
    if (dismissed !== null && (!query || query.start !== dismissed)) dismissed = null;
    if (!query || query.start === dismissed) return close();
    open(query);
  }

  // Capture, so these keys are the picker's before the box's own Enter handling (send) sees them.
  input.addEventListener("keydown", (event) => {
    if (!current || event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!items.length) return;
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      markActive();
    } else if ((event.key === "Enter" || event.key === "Tab") && items.length && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pick(items[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismissed = current.start;
      close();
    }
  }, { capture: true });
  input.addEventListener("input", sync);
  input.addEventListener("click", sync);
  input.addEventListener("keyup", (event) => {
    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
      if (!(current && (event.key === "ArrowDown" || event.key === "ArrowUp"))) sync();
    }
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== input) close();
  }, 0));
  const replace = () => {
    if (current) place();
  };
  window.addEventListener("resize", replace);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", replace);
    window.visualViewport.addEventListener("scroll", replace);
  }

  return { sync, close, isOpen: () => Boolean(current) };
}

// The "/name" Hermes registers a skill under (agent/skill_commands.py slugify_skill_name): "Code Review" -> "code-review".
export function skillSlug(name) {
  return String(name || "").toLowerCase().replace(/[ _]/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
