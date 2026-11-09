// Hermes Mini: mobile-first chat client for the Hermes dashboard. Vanilla ES module, no build step.
// Protocol mirrors web/src (gatewayClient.ts) and apps/shared (json-rpc-channel.ts, json-rpc-gateway.ts):
//  - WebSocket /api/ws?ticket=<single-use ticket from POST /api/auth/ws-ticket>
//  - newline-delimited JSON-RPC 2.0; event notifications have method "event"
//  - server->client requests (approval, clarify) carry a string id and are answered with a response frame,
//    except clarify answers, which lock per question through clarify.lock, and approval, which uses approval.respond
//  - after gateway.ready the client advertises client.capabilities {server_requests: true}, otherwise the
//    backend treats it as an old client and fails approvals and clarify immediately

import { render as renderMarkdown, enhance, copyText, makeCopyButton, COPY_ICON } from "./md.js";
import { createDrawer, sourceLabel } from "./drawer.js";
import { confirmDialog } from "./confirm.js";
import { createTodo } from "./todo.js";
import { createInbox } from "./inbox.js";
import { showToast } from "./toast.js";
import * as identityApi from "./identity.js";

// The agent name is the user's own: identity.js reads it from the plugin's authenticated /status route,
// where the server has already applied "saved override, then bot title, then display name, then named
// profile, then Hermes". Until that resolves the neutral "Hermes" is shown. The product name, which is what the
// tab title and the installed app carry, stays "Hermes Mini" and is separate from the agent name.
let AGENT = "Hermes";

// Internal stored title of the app's main chat (bridge.py HOME_TITLE). Only this app lists that row and it
// displays the external home label, so this key is never shown to a person.
const THREAD_TITLE = "Hermes Mini";
const STORE_KEY = "hermesMiniStoredId"; // the home thread (the one titled exactly THREAD_TITLE), as a fallback only
const VIEW_KEY = "hermesMiniViewedId"; // the chat on screen, so a reload comes back to it
const NEW_VIEW = "new"; // VIEW_KEY value for a New chat that was never sent (its id is saved only with its first message)
// Sources the PWA may resume and continue. Resuming writes to the session (it retires queued rows and can start an
// auto-continue turn), so every other source (Discord, Desktop, cron, ...) is only ever read, over REST.
const RESUMABLE_SOURCES = new Set(["tui"]);
const RPC_TIMEOUT_MS = 120000;
const CONNECT_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 25000;
const PING_TIMEOUT_MS = 10000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const MAX_IMAGE_EDGE = 2048;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10; // images and files combined, per message
const PASTE_COLLAPSE_LINES = 5; // Hermes TUI default (ui-tui/src/app/uiStore.ts pasteCollapseLines)
const PASTE_COLLAPSE_CHARS = 2000; // Hermes TUI default (pasteCollapseChars)
const NEAR_BOTTOM_PX = 120;

// The plugin is served under /dashboard-plugins/hermes-mini/; a reverse-proxy prefix (if any) sits in front of it.
const PREFIX = (() => {
  const at = location.pathname.indexOf("/dashboard-plugins/hermes-mini/");
  return at > 0 ? location.pathname.slice(0, at) : "";
})();

const $ = (id) => document.getElementById(id);
const els = {
  app: document.querySelector(".app"),
  log: $("log"),
  status: $("status"),
  caption: $("caption"),
  input: $("input"),
  micBtn: $("micBtn"),
  micIcon: $("micIcon"),
  micStopIcon: $("micStopIcon"),
  dictateHud: $("dictateHud"),
  dictateCancel: $("dictateCancel"),
  dictateViz: $("dictateViz"),
  dictateTimer: $("dictateTimer"),
  send: $("send"),
  sendIcon: $("sendIcon"),
  stopIcon: $("stopIcon"),
  attach: $("attach"),
  file: $("file"),
  tray: $("tray"),
  screenBtn: $("screenBtn"),
  todoBtn: $("todoBtn"),
  inboxBtn: $("inboxBtn"),
  readonlyText: $("readonlyText"),
  editBar: $("editBar"),
  editCancel: $("editCancel"),
  msgMenu: $("msgMenu"),
  msgMenuScrim: $("msgMenuScrim"),
};

// Everything a person sees or a screen reader announces follows the agent name, including the tab
// title. The installed app name stays "Hermes Mini", which is the product and not the agent.
function applyAgentBranding() {
  document.title = AGENT;
  const appName = document.querySelector('meta[name="application-name"]');
  if (appName) appName.content = "Hermes Mini";
  const name = document.querySelector(".identity .name");
  if (name) name.textContent = AGENT;
  if (els.input) els.input.placeholder = `Message ${AGENT}`;
  if (els.screenBtn) {
    els.screenBtn.setAttribute("aria-label", `${AGENT}'s Computer`);
    els.screenBtn.title = `${AGENT}'s Computer`;
  }
  const restartBtn = $("restartBtn");
  if (restartBtn) {
    restartBtn.setAttribute("aria-label", `Restart ${AGENT}`);
    restartBtn.title = `Restart ${AGENT}`;
  }
}

class AuthRedirect extends Error {}

// A chat that is gone (deleted, archived, or no longer resolvable). Falls back to the home thread.
class MissingSession extends Error {}

const savedView = safeStorageGet(VIEW_KEY);

const state = {
  ws: null,
  wsReady: false, // gateway.ready seen on the current socket
  connectionEpoch: 0, // bumped on every gateway.ready: display viewer ids are valid only for one RPC connection
  ready: false, // thread attached; sending allowed
  connecting: null,
  readyWaiter: null,
  homeId: safeStorageGet(STORE_KEY), // stored id of the home thread
  viewedId: savedView === NEW_VIEW ? null : savedView, // id of the chat on screen (the home thread unless another was picked)
  viewedUnsent: savedView === NEW_VIEW, // the chat on screen is a New chat that has not been sent yet
  viewedTitle: "", // title of the chat on screen, for the caption (empty on the home thread)
  storedId: null, // stored id of the chat on screen, as the REST history routes need it
  readOnly: false, // viewing a chat from another source: history only, no composer
  readOnlySource: "",
  switching: false, // a chat switch is in flight
  liveSid: null,
  viewedEmpty: false, // the chat on screen has no messages yet (a New chat that is not sent)
  creatingChat: null, // the in-flight New chat request, so a double press makes one chat
  pending: new Map(),
  reqSeq: 0,
  pingTimer: null,
  pingInFlight: false,
  reconnectTimer: null,
  backoffIdx: 0,
  streaming: false,
  turn: null, // { row, bubble, text, raf }
  narration: newNarrationState(),
  cards: new Map(), // server request id -> { el, method, params, ... }
  attachments: [], // { file, kind: "image" | "file", url }
  pastes: [], // collapsed large pastes: { label, text }. The label stays in the textarea and the text is swapped back in on send.
  sending: false,
  editing: null, // Edit & resend in progress: { row, saved } (see beginEdit)
  resettingMain: false, // a main-chat reset is between its confirmation and its finish
  composerLocked: false, // a reset deleted the old main but no replacement is attached: keep the composer disabled
};

// ---------- storage / small helpers ----------

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode or blocked storage: the thread id just is not remembered */
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text) {
  els.status.textContent = text || "";
}

function errorText(error) {
  return (error && error.message) || String(error);
}

function sysLine(text) {
  const row = el("div", "msg system");
  row.append(el("div", "note", text));
  els.log.append(row);
  scrollToBottom(true);
}

function nearBottom() {
  return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < NEAR_BOTTOM_PX;
}

// The click-to-bottom animation owns the scroll until it ends, so streaming's own near-bottom stick cannot
// snap to the end while the eased motion is still running.
let jumpAnim = null;

function scrollToBottom(force) {
  if (jumpAnim) return;
  if (force || nearBottom()) els.log.scrollTop = els.log.scrollHeight;
}

const emptyState = el("p", "empty-state", "How can I help you?");
emptyState.hidden = true;
els.log.append(emptyState);

const identityEl = document.querySelector(".identity");
const composerEl = document.querySelector(".composer");
const jumpEl = el("button", "jump-latest");
jumpEl.type = "button";
jumpEl.hidden = true;
jumpEl.tabIndex = -1;
jumpEl.setAttribute("aria-label", "Jump to latest message");
jumpEl.title = "Jump to latest message";
jumpEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
composerEl.append(jumpEl);

// The down-arrow appears once the chat is about two screens above the end, and fades out at anything closer.
// It stays in the DOM during the exit transition (pointer-events off, out of the tab order) so the fade can play.
const JUMP_VIEWS = 2;
const JUMP_FADE_MS = 180;
const JUMP_SCROLL_MS = 1000;
const JUMP_CANCEL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
let jumpRaf = 0;
let jumpHideTimer = 0;
function showJumpButton() {
  clearTimeout(jumpHideTimer);
  jumpHideTimer = 0;
  if (!jumpEl.hidden && jumpEl.classList.contains("shown")) return;
  jumpEl.hidden = false;
  jumpEl.tabIndex = 0;
  void jumpEl.offsetWidth; // commit display:flex at opacity 0, so the fade transitions instead of snapping
  jumpEl.classList.add("shown");
}
function hideJumpButton(immediate = false) {
  if (jumpEl.hidden && !jumpEl.classList.contains("shown")) return;
  jumpEl.classList.remove("shown");
  jumpEl.tabIndex = -1;
  clearTimeout(jumpHideTimer);
  if (immediate || reducedMotion()) {
    jumpHideTimer = 0;
    jumpEl.hidden = true;
    return;
  }
  jumpHideTimer = setTimeout(() => {
    jumpHideTimer = 0;
    jumpEl.hidden = true;
  }, JUMP_FADE_MS);
}
function updateJumpButton() {
  if (jumpAnim) return; // the arrow stays hidden for the jump it started
  const view = els.log.clientHeight;
  const away = els.log.scrollHeight - els.log.scrollTop - view;
  if (view > 0 && away >= view * JUMP_VIEWS) showJumpButton();
  else hideJumpButton();
}
function scheduleJumpUpdate() {
  if (jumpRaf) return;
  jumpRaf = requestAnimationFrame(() => {
    jumpRaf = 0;
    updateJumpButton();
  });
}
function cancelJumpScroll() {
  if (!jumpAnim) return;
  cancelAnimationFrame(jumpAnim.raf);
  jumpAnim = null;
}
function cancelJumpFromInput() {
  if (!jumpAnim) return;
  cancelJumpScroll();
  scheduleJumpUpdate();
}
function jumpToBottom() {
  cancelJumpScroll();
  const chatId = state.viewedId;
  const storedId = state.storedId;
  const startTop = els.log.scrollTop;
  const start = performance.now();
  jumpAnim = { raf: 0, chatId, storedId };
  const step = (now) => {
    if (!jumpAnim) return;
    if (state.viewedId !== chatId || state.storedId !== storedId) {
      jumpAnim = null; // the chat changed underneath the animation
      return;
    }
    const t = Math.min(1, (now - start) / JUMP_SCROLL_MS);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    const target = Math.max(0, els.log.scrollHeight - els.log.clientHeight); // follow a growing reply
    els.log.scrollTop = startTop + (target - startTop) * eased;
    if (t < 1) {
      jumpAnim.raf = requestAnimationFrame(step);
      return;
    }
    jumpAnim = null;
    els.log.scrollTop = els.log.scrollHeight; // settle on the real end
    updateJumpButton();
  };
  jumpAnim.raf = requestAnimationFrame(step);
}
jumpEl.addEventListener("click", () => {
  hideJumpButton(); // fade at once, and do not let it reappear while its own jump runs
  if (reducedMotion()) {
    cancelJumpScroll();
    els.log.scrollTop = els.log.scrollHeight;
    updateJumpButton();
    return;
  }
  jumpToBottom();
});
for (const event of ["wheel", "touchstart", "pointerdown"]) {
  els.log.addEventListener(event, cancelJumpFromInput, { passive: true }); // a real scroll gesture wins over ours
}
document.addEventListener("keydown", (event) => {
  if (!jumpAnim || !JUMP_CANCEL_KEYS.has(event.key)) return;
  const node = event.target;
  if (node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName))) return;
  cancelJumpFromInput();
});
if (typeof MutationObserver === "function") {
  new MutationObserver(scheduleJumpUpdate).observe(els.log, { childList: true, subtree: true, characterData: true });
}
els.log.addEventListener("load", scheduleJumpUpdate, true); // newly loaded pictures change the scroll height

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const GREET_GAP = 16; // px between the name pill and the greeting box
const ID_SCALE = 1.5; // the identity block's size in the empty state
const AVATAR_PX = 64; // avatar layout size (.avatar width and height)
const AV_OVERHANG = (ID_SCALE - 1) * AVATAR_PX / 2; // px the scaled avatar rises above its layout box (16)
const PILL_DROP = 9; // px the name pill moves down in the centred state (CSS translateY); keeps the header overlap ratio (14px of 64px becomes 21px of 96px)
let greetTimer = 0;
let flyTimer = 0;
let lowerTimer = 0;

// Places the identity block and the greeting as one group, centred between the header bottom and the composer top.
// Rest geometry comes from offsetLeft/offsetTop/offsetWidth/offsetHeight (layout values, not affected by transforms).
// The avatar is scaled by its own transform and the name pill is offset by CSS, so the block itself is not scaled.
// The greeting's horizontal centre is the reference, so the avatar lands exactly over it.
function layoutEmpty() {
  const topbar = identityEl.offsetParent; // .topbar (position absolute)
  const tb = topbar.getBoundingClientRect();
  const cb = emptyState.offsetParent; // .log, the greeting's containing block (position relative)
  const cbr = cb.getBoundingClientRect();
  const compTop = composerEl.getBoundingClientRect().top;
  const vis = identityEl.offsetHeight + AV_OVERHANG + PILL_DROP; // visual group height (104)
  const gh = emptyState.offsetHeight;
  const groupTop = (tb.bottom + compTop) / 2 - (vis + GREET_GAP + gh) / 2;
  const greetCx = cbr.left + cb.clientLeft + cb.clientWidth / 2;
  const restCx = tb.left + identityEl.offsetLeft + identityEl.offsetWidth / 2;
  const restTop = tb.top + identityEl.offsetTop;
  identityEl.style.setProperty("--id-dx", `${greetCx - restCx}px`);
  identityEl.style.setProperty("--id-dy", `${groupTop + AV_OVERHANG - restTop}px`);
  emptyState.style.top = `${groupTop + vis + GREET_GAP - cbr.top - cb.clientTop}px`;
}

function clearIdentityTimers() {
  clearTimeout(flyTimer);
  clearTimeout(lowerTimer);
}

// show: the greeting appears with the identity centred above it. opts.lower: the identity animates down from the header
// (New chat from a chat with history; skipped under reduced motion).
// !show: opts.fly (first message in an empty chat): the greeting fades out over 250ms and the identity flies to the header
// (skipped under reduced motion, which snaps). Otherwise everything snaps to rest with no animation.
function setEmptyState(show, opts = {}) {
  // A flight already in progress finishes on its own: other messages in the same send (the assistant turn) must not snap it.
  if (!show && !opts.fly && identityEl.classList.contains("flying")) return;
  state.viewedEmpty = show;
  clearTimeout(greetTimer);
  clearIdentityTimers();
  emptyState.classList.remove("leaving");
  if (show) {
    emptyState.hidden = false;
    identityEl.classList.remove("flying");
    layoutEmpty();
    const animate = Boolean(opts.lower) && !reducedMotion();
    identityEl.classList.toggle("lowering", animate);
    identityEl.classList.add("centred");
    if (animate) lowerTimer = setTimeout(() => identityEl.classList.remove("lowering"), 470);
    return;
  }
  if (opts.fly && !reducedMotion() && !emptyState.hidden) {
    emptyState.classList.add("leaving");
    greetTimer = setTimeout(() => {
      emptyState.hidden = true;
      emptyState.classList.remove("leaving");
    }, 250);
    identityEl.classList.remove("centred", "lowering");
    identityEl.classList.add("flying");
    flyTimer = setTimeout(() => identityEl.classList.remove("flying"), 700);
    return;
  }
  emptyState.hidden = true;
  identityEl.classList.remove("centred", "lowering", "flying");
}

function clearLog() {
  if (typeof cancelDictation === "function") cancelDictation(true);
  endEdit(); // a view reset ends an edit; the composer gets its draft back
  cancelJumpScroll(); // a jump never follows the view to another chat or a rebuilt history
  hideJumpButton(true);
  els.log.replaceChildren(emptyState);
}

// ---------- HTTP ----------

// A standalone plugin page is not the dashboard SPA, so the loopback session token is not
// injected into this document. Collect it once from the dashboard root; a gated deployment
// withholds it and the app falls back to cookie auth.
let sessionTokenPromise = null;
function sessionToken() {
  if (window.__HERMES_SESSION_TOKEN__) return Promise.resolve(window.__HERMES_SESSION_TOKEN__);
  if (!sessionTokenPromise) {
    sessionTokenPromise = fetch("/", { credentials: "include" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((html) => {
        const match = /__HERMES_SESSION_TOKEN__="([^"]+)"/.exec(html);
        const gated = /__HERMES_AUTH_REQUIRED__=(true|false)/.exec(html);
        if (gated) window.__HERMES_AUTH_REQUIRED__ = gated[1] === "true";
        window.__HERMES_SESSION_TOKEN__ = match ? match[1] : "";
        return window.__HERMES_SESSION_TOKEN__;
      })
      .catch(() => "");
  }
  return sessionTokenPromise;
}
window.__hermesMiniSessionToken = sessionToken;

async function api(path, init = {}) {
  const token = await sessionToken();
  const res = await fetch(PREFIX + path, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(token ? { "X-Hermes-Session-Token": token } : {}),
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON 401 */
    }
    const next = encodeURIComponent(location.pathname + location.search);
    location.assign(body.login_url || `${PREFIX}/login?next=${next}`);
    throw new AuthRedirect("login required");
  }
  if (!res.ok) {
    // Keep the server's own reason (for example "Session not found" or a title conflict) and the status code.
    let detail;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* no JSON body */
    }
    const error = new Error(typeof detail === "string" && detail ? detail : `HTTP ${res.status} on ${path}`);
    error.status = res.status;
    error.detail = detail;
    throw error;
  }
  return res.json();
}

function messageText(message) {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && part.type === "text" ? part.text || "" : ""))
      .join("")
      .trim();
  }
  return "";
}

// The rows the transcript shows, in order, with the text it shows. Mirrors Hermes's own desktop renderer
// (apps/desktop/src/lib/chat-messages/hydration.ts) so nothing model-facing leaks into a bubble (6 Nov 2026):
//   - the server's display_content wins over the raw content (steers, compaction carriers, commentary);
//   - rows typed display_kind "hidden" and model-only copies (display_metadata.model_only) are never drawn;
//   - Hermes's system notices (background task, model/personality switch, auto-continue) are not drawn at all;
//   - a failed-turn notice is returned only with { notices: true }, as kind "fail", for a small muted line;
//   - @image: refs become thumbnails and @file: refs file chips; attached-context and warning tails are dropped.
// Used by the history render and by the row-id lookup, so both see the same message rows.
// agent/prompt_builder.py STEER_MARKER_OPEN / STEER_MARKER_CLOSE (fallback when display_content is missing).
const STEER_WRAP = /\[OUT-OF-BAND USER MESSAGE\b[^\]]*\]\s*([\s\S]*?)\s*\[\/OUT-OF-BAND USER MESSAGE\]/g;
const HIDDEN_NOTICE_KINDS = new Set(["model_switch", "personality_switch", "auto_continue"]);
const FILE_REF = /@file:(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\S+))/g;
const OTHER_REF = /@(?:folder|url|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/g;
const ATTACHED_CONTEXT_TAIL = /(?:^|\n)--- Attached Context ---\s*\n[\s\S]*$/;
const CONTEXT_WARNINGS_TAIL = /(?:^|\n)--- Context Warnings ---[\s\S]*$/;
const LEGACY_HEARTBEAT = /^\[Background process \S+ heartbeat #\d+ /;
const JOB_PREFIX = /^\[Scheduled job result\]\s*/; // bridge.py PREFIX
// Gateway shutdown/restart notices delivered as job results before bridge.py dropped them.
const LIFECYCLE_NOTICE = /^\W{0,4}(?:Hermes is (?:shutting down|restarting)\b|Restarting gateway\b)/; // bridge.py _LIFECYCLE_NOTICE

function modelOnly(message) {
  let meta = message.display_metadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return false;
    }
  }
  return Boolean(meta && typeof meta === "object" && meta.model_only === true);
}

// gateway/response_filters.py LIVE_GATEWAY_SILENT_MARKERS: a whole reply meaning "chose not to answer". Never shown
//, live or from history. Edge punctuation (".NO_REPLY", "*NO_REPLY*") is tolerated.
const SILENT_MARKERS = new Set(["[SILENT]", "SILENT", "NO_REPLY", "NO REPLY", "[静默]", "静默", "[沉默]", "沉默"]);
function isSilenceMarker(text) {
  const value = String(text || "").trim().toUpperCase().split(/\s+/).join(" ").replace(/^[*_`.!?,;:'"]+|[*_`.!?,;:'"]+$/g, "");
  return SILENT_MARKERS.has(value);
}

// A saved clarify result, as the resolved Question card shows it. The tool row carries the answer JSON under
// content; anything unparseable is skipped silently. Approvals leave no row in history at all,
// so only a Question is rebuilt here.
function clarifyHistoryItems(message) {
  if (message.role !== "tool" || (message.tool_name || message.name) !== "clarify") return null;
  const raw = typeof message.content === "string" ? message.content : messageText(message);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.responses)) return null;
  const outcome = String(data.outcome || "");
  // A wait that ended on its own never had an answer to show: "Closed without an answer", not "Skipped".
  const closed = /^(?:cancelled|timed_out|timeout|expired)$/.test(outcome);
  const items = [];
  for (const response of data.responses) {
    if (!response || typeof response !== "object") continue;
    const status = response.status === "answered" ? "answered" : response.status === "skipped" && !closed ? "skipped" : "unanswered";
    items.push({
      question: String(response.question || ""),
      status,
      value: status === "answered" ? clarifyAnswerText(response.user_response) : "",
    });
  }
  return items.length ? items : null;
}

// A multi-select answer comes back as a list (or a JSON string of one): show it as one comma-separated answer.
function clarifyAnswerText(value) {
  let answer = value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) answer = parsed;
    } catch {
      /* plain typed text */
    }
  }
  return Array.isArray(answer) ? answer.map((item) => String(item)).join(", ") : String(answer ?? "");
}

function chatEntries(messages, { notices = false } = {}) {
  const entries = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const clarify = clarifyHistoryItems(message);
      if (clarify) entries.push({ message, text: "", images: [], files: [], kind: "clarify", clarify });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const kind = message.display_kind || "";
    if (kind === "hidden" || modelOnly(message)) continue;
    // Hermes' injected system notices (background task finished, etc.) are not shown at all.
    if (message.role === "user" && (NOTICE_KINDS.has(kind) || HIDDEN_NOTICE_KINDS.has(kind))) continue;
    const raw = typeof message.display_content === "string" ? message.display_content.trim() : messageText(message);
    if (kind === "failed_turn") {
      // Hermes closing a failed turn, not the agent speaking: a small muted line.
      if (notices && raw) entries.push({ message, text: raw, images: [], files: [], kind: "fail" });
      continue;
    }
    if (kind === "job_delivery") {
      // A scheduled job's output, stored by the bridge (bridge.py) as a labelled user-role row so the model
      // keeps strict alternation. Drawn on the agent's side, marked as a job.
      const body = raw.replace(JOB_PREFIX, "").trim();
      if (body && !LIFECYCLE_NOTICE.test(body)) entries.push({ message: { ...message, role: "assistant" }, text: body, images: [], files: [], kind: "job" });
      continue;
    }
    if (message.role === "user" && LEGACY_HEARTBEAT.test(raw)) continue;
    const images = [];
    const files = [];
    let text = raw;
    if (message.role === "user") {
      text = text.replace(ATTACHED_CONTEXT_TAIL, "").replace(CONTEXT_WARNINGS_TAIL, "");
      // The server appends an internal @image: reference to a prompt that carried an image (rendered as a thumbnail) and
      // an @file: reference for an attached file (rendered as a chip). Pull them out, then treat the rest as the text.
      for (const m of text.matchAll(/@image:(\S+)/g)) images.push(m[1]);
      for (const m of text.matchAll(FILE_REF)) files.push(m[1] || m[2] || m[3] || m[4]);
      text = text.replace(/@image:\S+/g, "").replace(FILE_REF, "").replace(OTHER_REF, "");
      // A steer stored without the server's display_content still carries the out-of-band markers.
      text = text.replace(STEER_WRAP, "$1");
    }
    text = text.trim();
    if (!text && !images.length && !files.length) continue; // empty assistant tool-call stubs and similar
    if (message.role === "assistant" && isSilenceMarker(text)) continue;
    // Hermes concatenates multiple mid-turn steers during one tool batch with newlines into a single steer row;
    // split them back into individual user bubbles so history matches how they were sent live.
    if (message.role === "user" && (kind === "steer" || STEER_WRAP.test(raw)) && text.includes("\n")) {
      for (const line of text.split("\n").map((part) => part.trim()).filter(Boolean)) {
        entries.push({ message, text: line, images: [], files: [] });
      }
      continue;
    }
    entries.push({ message, text, images, files });
  }
  return entries;
}

// A stored user message that carried an image or a file. Edit resends text only, so it is not offered for these.
function carriesAttachments(message) {
  const content = message.content;
  if (Array.isArray(content) && content.some((part) => part && typeof part === "object" && part.type !== "text")) return true;
  return /@(image|file):/.test(messageText(message));
}

// Text equality for matching a message against the server's copy: whitespace runs count as one space.
function sameText(a, b) {
  const squash = (value) => String(value || "").replace(/\s+/g, " ").trim();
  return squash(a) === squash(b);
}

// ---------- JSON-RPC over WebSocket ----------

function sendFrame(frame) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("not connected");
  ws.send(JSON.stringify(frame));
}

function rpc(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("not connected"));
  }
  const id = `v${++state.reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`timed out: ${method}`));
    }, timeoutMs);
    state.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      sendFrame({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function onFrame(frame) {
  if (!frame || typeof frame !== "object") return;
  if (frame.method === "event") {
    onEvent(frame.params || {});
    return;
  }
  if (typeof frame.method === "string") {
    // A server->client request (frame.id is a string) or some other notification we do not handle.
    if (frame.id !== undefined && frame.id !== null) {
      const params = frame.params || {};
      if (belongsToView(params)) {
        onServerRequest(frame.id, frame.method, params);
      } else if (frame.method === "approval" || frame.method === "clarify") {
        // Another chat is waiting on an answer. Leave it pending: it shows up again when that chat is reopened
        // (the server reports open requests on resume), and this line says why the agent has paused.
        setStatus("Waiting for your answer in another chat");
      }
    }
    return;
  }
  if (frame.id !== undefined && frame.id !== null) {
    const call = state.pending.get(frame.id);
    if (!call) return;
    state.pending.delete(frame.id);
    if (frame.error) {
      const error = new Error(frame.error.message || "RPC failed");
      // Keep the JSON-RPC code/data: display.* feature-detection needs -32601 ("unknown method"), and a bare message
      // loses the distinction on gateways that word it differently.
      error.code = frame.error.code;
      error.data = frame.error.data;
      call.reject(error);
    } else {
      call.resolve(frame.result);
    }
  }
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    state.ws = ws;
    state.wsReady = false;
    const waiter = { resolve, reject, ws };
    state.readyWaiter = waiter;
    const timer = setTimeout(() => {
      failWaiter(new Error("gateway did not become ready"));
      dropSocket(ws);
    }, CONNECT_TIMEOUT_MS);

    function failWaiter(error) {
      if (state.readyWaiter !== waiter) return;
      state.readyWaiter = null;
      clearTimeout(timer);
      reject(error);
    }
    waiter.succeed = () => {
      if (state.readyWaiter !== waiter) return;
      state.readyWaiter = null;
      clearTimeout(timer);
      resolve();
    };

    ws.onmessage = (event) => {
      if (state.ws !== ws) return;
      for (const line of String(event.data).split("\n")) {
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        onFrame(frame);
      }
    };
    ws.onerror = () => {
      failWaiter(new Error("WebSocket error before the gateway was ready"));
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      failWaiter(new Error("WebSocket closed before the gateway was ready"));
      onSocketClosed(ws);
    };
  });
}

function onGatewayReady(payload) {
  state.wsReady = true;
  state.connectionEpoch += 1;
  // The backend treats a client that never advertises this as too old to answer server requests.
  rpc("client.capabilities", { server_requests: true }).catch(() => undefined);
  if (state.readyWaiter) state.readyWaiter.succeed();
  startPing();
  // The bot screen keeps its own display.* viewer identity; a new RPC connection mints a fresh one.
  botScreen?.onRpcReady();
  void payload;
}

// Reconnect, heartbeat and close handling.

function dropSocket(ws) {
  if (state.ws !== ws) return;
  state.ws = null;
  try {
    ws.close();
  } catch {
    /* already closed */
  }
  onSocketClosed(ws);
}

function onSocketClosed(ws) {
  if (state.ws === ws) state.ws = null;
  const wasReady = state.wsReady;
  state.wsReady = false;
  state.ready = false;
  stopPing();
  for (const call of state.pending.values()) call.reject(new Error("connection lost"));
  state.pending.clear();
  botScreen?.onRpcDisconnected();
  if (wasReady) {
    noteOffline();
    scheduleReconnect();
  }
}

// Connection trouble stays silent unless it lasts: short drops and retries show nothing; one red toast after a full minute without reaching the agent.
const OFFLINE_WARN_MS = 60_000;
function noteOffline() {
  if (!state.offlineSince) state.offlineSince = Date.now();
  if (!state.offlineWarned && Date.now() - state.offlineSince >= OFFLINE_WARN_MS) {
    state.offlineWarned = true;
    showToast(`Can't reach ${AGENT}. Still trying…`, "error");
  }
}
function noteOnline() {
  state.offlineSince = 0;
  state.offlineWarned = false;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = BACKOFF_MS[Math.min(state.backoffIdx, BACKOFF_MS.length - 1)];
  state.backoffIdx += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void reconnect();
  }, delay);
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.pingInFlight) return;
    const ws = state.ws;
    state.pingInFlight = true;
    rpc("gateway.ping", {}, PING_TIMEOUT_MS)
      .catch(() => {
        // No answer: treat the socket as dead so we reconnect instead of hanging.
        dropSocket(ws);
      })
      .finally(() => {
        state.pingInFlight = false;
      });
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = null;
  state.pingInFlight = false;
}

async function connect() {
  if (state.connecting) return state.connecting;
  state.connecting = (async () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let query;
    if (window.__HERMES_AUTH_REQUIRED__) {
      const { ticket } = await api("/api/auth/ws-ticket", { method: "POST" });
      query = `ticket=${encodeURIComponent(ticket)}`;
    } else {
      // Loopback dashboards authorize the socket with the session token; only gated
      // deployments mint single-use tickets. The dashboard SPA does the same.
      query = `token=${encodeURIComponent(await sessionToken())}`;
    }
    await openSocket(`${proto}//${location.host}${PREFIX}/api/ws?${query}`);
  })().finally(() => {
    state.connecting = null;
  });
  return state.connecting;
}

// Thread attach: find or create the main chat thread, resume it, then load its history.

// The SERVER decides which thread is current, so every device (phone, PC) shows the same conversation:
// the current thread is the one session titled exactly THREAD_TITLE (titles are UNIQUE in state.db).
// localStorage only remembers it as a fallback when the lookup fails.
async function currentServerThreadId() {
  const row = await currentServerThreadRow();
  return row ? row.id : null;
}

// The same lookup as currentServerThreadId, but the whole session.list row (id, title, message_count, ...), or null.
async function currentServerThreadRow() {
  const listed = await rpc("session.list", { title: THREAD_TITLE, limit: 20 });
  return (
    (listed.sessions || [])
      .filter((row) => row.title === THREAD_TITLE)
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null
  );
}

// Give a just-created session its title NOW (session.title persists the row immediately), so other devices
// find it before its first message. If another device won the race, adopt that thread instead.
async function claimTitle(liveSid) {
  try {
    await rpc("session.title", { session_id: liveSid, title: THREAD_TITLE });
    return null;
  } catch (error) {
    const owner = errorText(error).match(/already in use by session (\S+)/);
    if (owner) return owner[1];
    throw error;
  }
}

// Creates the home thread and makes it live here. Callers decide whether it is the chat on screen.
async function createThread() {
  const created = await rpc("session.create", { title: THREAD_TITLE });
  const owner = await claimTitle(created.session_id);
  if (owner) {
    // Lost the race: hide the empty row this attempt left behind, then adopt the winner's thread.
    await rpc("session.archive", { session_id: created.stored_session_id, archived: true }).catch(() => {});
    state.homeId = owner;
    safeStorageSet(STORE_KEY, owner);
    return false; // resume the other device's thread
  }
  state.liveSid = created.session_id;
  state.homeId = created.stored_session_id;
  safeStorageSet(STORE_KEY, state.homeId);
  registerAppChat(state.homeId);
  return true;
}

// Tags a chat as started in the app (plugin_api.py /app-chats, the person 7 Nov 2026): the chat list and notifications
// only cover tagged chats, so a terminal or dashboard-page chat never shows up here. Idempotent and fire-and-forget;
// sending a message re-tags the chat, so one failed call heals itself.
function registerAppChat(id) {
  if (!id) return;
  api("/api/plugins/hermes-mini/app-chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }).then((data) => { if (data && data.added) drawerApi.addAppChat(id); }).catch(() => {});
}

// Finds the home thread on the server (the one titled THREAD_TITLE), or creates it. Returns true when created.
async function ensureHome() {
  let serverId;
  try {
    serverId = await currentServerThreadId();
  } catch (error) {
    if (state.homeId) return false; // lookup failed: keep the remembered home thread
    throw error;
  }
  if (serverId) {
    state.homeId = serverId;
    safeStorageSet(STORE_KEY, serverId);
    return false;
  }
  return createThread();
}

// When the app comes back to the foreground, follow a New chat made on another device. The home pointer always
// follows the server. The chat on screen only moves when it was the home thread: a chat picked from the drawer
// stays put.
async function syncThread() {
  if (state.streaming || state.switching || state.resettingMain || !(state.ready || state.readOnly)) return;
  let serverId;
  try {
    serverId = await currentServerThreadId();
  } catch {
    return;
  }
  if (!serverId || serverId === state.homeId) return;
  const wasHome = state.viewedId === state.homeId;
  state.homeId = serverId;
  safeStorageSet(STORE_KEY, serverId);
  updateCaption();
  if (!wasHome) return;
  state.ready = false;
  for (const id of [...state.cards.keys()]) removeCard(id);
  state.viewedUnsent = false;
  state.viewedId = serverId;
  persistView();
  await attachThread();
}

// Remembers the chat on screen for a reload. An unsent New chat is remembered as NEW_VIEW, never by its id.
function persistView() {
  safeStorageSet(VIEW_KEY, state.viewedUnsent ? NEW_VIEW : state.viewedId);
}

// Starts an untitled chat on the server and shows it: empty log, greeting, composer ready. Used by New chat and,
// silently, when an unsent chat is no longer live after a reload or reconnect. RPC errors are thrown to the caller.
async function openFreshChat(opts = {}) {
  const created = await rpc("session.create", {});
  registerAppChat(created.stored_session_id);
  state.viewedId = created.stored_session_id;
  state.viewedUnsent = true;
  persistView();
  state.storedId = created.stored_session_id;
  state.liveSid = created.session_id;
  state.viewedTitle = "";
  state.streaming = false;
  state.turn = null;
  for (const id of [...state.cards.keys()]) removeCard(id);
  clearLog();
  setEmptyState(true, { lower: Boolean(opts.lower) });
  setReadOnly(false);
  updateCaption();
  state.composerLocked = false;
  state.ready = true;
  updateComposer();
}

// The New chat that was never sent has no saved row, so it can be resumed only while its runtime is still live.
// If it is still live and still empty, it stays on screen. Otherwise a fresh New chat opens silently. No note either way.
async function attachUnsent() {
  if (state.viewedId) {
    try {
      const resumed = await rpc("session.resume", { session_id: state.viewedId });
      if (Number(resumed.message_count) === 0) {
        state.liveSid = resumed.session_id;
        state.storedId = state.viewedId;
        state.viewedTitle = "";
        state.streaming = false;
        state.turn = null;
        for (const id of [...state.cards.keys()]) removeCard(id);
        clearLog();
        setEmptyState(true);
        setReadOnly(false);
        updateCaption();
        state.composerLocked = false;
        state.ready = true;
        updateComposer();
        return;
      }
    } catch (error) {
      if (error instanceof AuthRedirect || isConnectionError(error)) throw error;
      // Not found (the chat was never saved) or any other refusal: open a fresh New chat below.
    }
  }
  await openFreshChat();
}

// Attaches the chat on screen: the one remembered in state.viewedId, or the home thread. A chat that no longer
// exists, was archived, or is not an app chat (not resumable) falls back to the home thread with a note.
// Connection errors are rethrown so the reconnect logic handles them.
async function attachThread() {
  setEmptyState(false);
  const fresh = await ensureHome();
  if (state.viewedUnsent) {
    await attachUnsent();
    return;
  }
  if (fresh) state.viewedId = state.homeId; // a brand-new home thread is the chat on screen
  const wanted = state.viewedId;
  if (wanted && wanted !== state.homeId) {
    try {
      await attachSession(wanted);
      return;
    } catch (error) {
      if (error instanceof AuthRedirect || isConnectionError(error)) throw error;
      // A chat that is gone, archived or not an app chat falls back to the main chat silently.
      // Any other failure is still shown.
      if (!isMissing(error)) sysLine(`Could not open that chat: ${errorText(error)}. Showing ${AGENT}.`);
    }
  }
  state.viewedId = state.homeId;
  state.viewedUnsent = false;
  persistView();
  await attachHome(fresh);
}

function isMissing(error) {
  return error instanceof MissingSession || error.status === 404 || /not found/i.test(errorText(error));
}

// Network and socket failures: retried by the reconnect logic, never shown as a bad chat.
function isConnectionError(error) {
  if (error instanceof TypeError) return true;
  return /not connected|connection lost|timed out|did not become ready|WebSocket/i.test(errorText(error));
}

// The home thread: resume it (unless it was just created) and load its history.
async function attachHome(fresh) {
  let running = false;
  let openRequests = [];
  let messageCount = 0;
  if (!fresh) {
    try {
      const resumed = await rpc("session.resume", { session_id: state.homeId });
      state.liveSid = resumed.session_id;
      running = Boolean(resumed.running);
      openRequests = resumed.open_requests || [];
      messageCount = Number(resumed.message_count) || 0;
    } catch (error) {
      if (!/not found/i.test(errorText(error))) throw error;
      // The stored home thread no longer exists on the server: start a fresh one.
      state.homeId = null;
      safeStorageSet(STORE_KEY, null);
      return attachThread();
    }
  }
  state.storedId = state.homeId;
  state.viewedTitle = "";
  setReadOnly(false);
  updateCaption();
  await loadHistory(messageCount);
  finishAttach(openRequests, running);
}

// Another chat picked from the drawer (or remembered across a reload). Only resumable sources open here, like the
// home thread. The drawer lists no other source, so a remembered chat from one falls back to home (attachThread).
async function attachSession(id) {
  const meta = await api(`/api/sessions/${encodeURIComponent(id)}`);
  if (!meta || meta.archived) throw new MissingSession("This chat is archived.");
  if (!RESUMABLE_SOURCES.has(meta.source)) throw new MissingSession(`This chat does not open in ${AGENT}.`);
  state.viewedTitle = meta.title || meta.preview || "";
  const resumed = await rpc("session.resume", { session_id: id });
  state.storedId = id;
  state.liveSid = resumed.session_id;
  state.ready = false;
  setReadOnly(false);
  updateCaption();
  await loadHistory(Number(resumed.message_count) || 0);
  finishAttach(resumed.open_requests || [], Boolean(resumed.running));
  if (!pendingTarget) restoreScroll(id); // a deep link places its own message instead
}

function finishAttach(openRequests, running) {
  // Cards whose request the server no longer reports as open are stale.
  const openIds = new Set(openRequests.map((req) => req.id));
  for (const id of [...state.cards.keys()]) {
    if (!openIds.has(id)) removeCard(id);
  }
  for (const req of openRequests) onServerRequest(req.id, req.method, req.params || {});
  if (els.status.textContent.startsWith("Waiting for your answer")) setStatus("");
  state.streaming = Boolean(running);
  if (running) touchTurn();
  state.composerLocked = false;
  state.ready = true;
  updateComposer();
}

// Read-only chats show a slim bar where the composer is.
function setReadOnly(on, source = "") {
  state.readOnly = on;
  state.readOnlySource = on ? source : "";
  els.app.classList.toggle("read-only", on);
  if (on) els.readonlyText.textContent = source ? `Read-only · from ${sourceLabel(source)}` : "Read-only";
  syncActionAvailability();
}

// The caption names the chat on screen, but only when it is not the home thread.
function updateCaption() {
  const away = Boolean(state.viewedId) && state.viewedId !== state.homeId;
  els.app.classList.toggle("has-caption", away);
  els.caption.hidden = !away;
  els.caption.textContent = away ? state.viewedTitle || "Untitled" : "";
  // On the main chat the name pill shows the agent's name plus the drawer's home icon.
  const onMain = Boolean(state.viewedId) && state.viewedId === state.homeId;
  const name = document.querySelector(".identity .name");
  if (name) {
    name.textContent = AGENT;
    if (onMain) {
      name.insertAdjacentHTML("beforeend",
        '<svg class="name-home" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>');
    }
  }
}

// Scroll position per chat: leaving a chat remembers where you were, coming back restores it.
const scrollMemory = new Map();

function rememberScroll() {
  if (state.viewedId) scrollMemory.set(state.viewedId, els.log.scrollTop);
}

function restoreScroll(id) {
  const top = scrollMemory.get(id);
  if (top !== undefined) els.log.scrollTop = top;
}

// Switches the chat on screen (drawer selection, Delete of the open chat). Chats get a live runtime like the home
// thread.
async function switchSession(id) {
  if (!id || id === state.viewedId || state.switching || state.resettingMain) return;
  if (!state.wsReady) {
    sysLine("Not connected yet. Try again in a moment.");
    return;
  }
  state.switching = true;
  rememberScroll();
  state.viewedUnsent = false;
  const leaving = state.viewedId;
  state.viewedId = id;
  persistView();
  drawerApi.markSeen(id); // opening a chat is what clears its unread dot
  // The chat being left was on screen until now, so everything in it so far was seen: a job result or background
  // follow-up that landed while it was open must not come back as a dot (ghost-dot fix, 7 Nov 2026).
  if (leaving) drawerApi.markSeen(leaving);
  state.viewedTitle = "";
  state.ready = false;
  state.streaming = false;
  state.turn = null;
  for (const cardId of [...state.cards.keys()]) removeCard(cardId);
  setEmptyState(false);
  clearLog();
  updateComposer();
  try {
    await attachThread();
  } catch (error) {
    if (!(error instanceof AuthRedirect)) sysLine(`Could not open that chat: ${errorText(error)}`);
  } finally {
    state.switching = false;
    setStatus("");
    refreshDockedDrawer(); // docked: move the current-chat highlight and any new/renamed rows
  }
}

// Renames a chat. The open chat goes through session.title on its live id. Any other chat is renamed by stored id
// through the revision-checked mutation the desktop uses, so renaming never has to resume it.
async function renameSession(item, title) {
  // Titles are unique. The server would hand a name over from an EMPTY chat that holds it (its "ghost" rule), so
  // refuse every taken name here instead: an exact-title lookup, no resume.
  const holders = await rpc("session.list", { title });
  const holder = (holders.sessions || []).find((row) => row.title === title && row.id !== item.id && row.resolved_id !== item.id);
  if (holder) throw new Error("Another chat already uses that name.");
  if (item.id === state.viewedId && state.liveSid && state.ready && !state.readOnly) {
    await rpc("session.title", { session_id: state.liveSid, title });
  } else {
    const snapshot = await api(`/api/sessions/${encodeURIComponent(item.id)}/mutation-snapshot`);
    if (!snapshot.exists) throw new Error("Session not found");
    await api(`/api/sessions/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: newRequestId(),
        expected_revision: snapshot.runtime_revision,
        expected_generation: snapshot.runtime_generation,
        title,
      }),
    });
  }
  if (item.id === state.viewedId) {
    state.viewedTitle = title;
    updateCaption();
  }
}

// Permanently deletes a chat with the revision-fenced REST DELETE (the same one the desktop app uses; the snapshot
// supplies the fence). A chat that is already gone counts as deleted. Shared by Delete and the main-chat reset, so
// both take the same safe path and neither can force a busy turn. A refusal throws a readable message.
async function deleteSessionFenced(id) {
  try {
    const snapshot = await api(`/api/sessions/${encodeURIComponent(id)}/mutation-snapshot`);
    if (snapshot.exists) {
      const query = new URLSearchParams({
        request_id: newRequestId(),
        expected_revision: String(snapshot.runtime_revision),
      });
      if (snapshot.runtime_generation !== null && snapshot.runtime_generation !== undefined) {
        query.set("expected_generation", String(snapshot.runtime_generation));
      }
      await api(`/api/sessions/${encodeURIComponent(id)}?${query}`, { method: "DELETE" });
    }
  } catch (error) {
    throw new Error(sessionErrorText(error, "delete"));
  }
}

// Deleting the chat on screen moves the view to the home thread.
async function deleteSession(item) {
  await deleteSessionFenced(item.id);
  if (item.id === state.viewedId) await switchSession(state.homeId);
}

// Resets the main chat: after the drawer's confirmation, verify this device still points at the server's current
// title holder, delete it through the same fenced mutation as Delete, forget the old local pointers, then let
// ensureHome create (or adopt) the fresh main chat thread and attach it, empty. Other chats are untouched.
// A refusal before the delete leaves the old main chat exactly as it was. A failure after the delete says so plainly
// and leaves the app able to retry; it never claims the old chat survived.
async function resetMainChat(item) {
  if (state.resettingMain) throw new Error("The main chat is already being reset.");
  if (!item || !item.id) throw new Error("Could not reset the main chat: it is no longer in the list.");
  if (!state.wsReady || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected yet. Try again in a moment.");
  }
  if (state.streaming || state.sending || state.switching) {
    throw new Error("The main chat is busy right now. Let its reply finish, then try again.");
  }
  const previousReady = state.ready;
  state.resettingMain = true;
  state.switching = true; // this operation owns the view and the runtime while it runs
  state.ready = false;
  updateComposer();
  let deleted = false;
  try {
    // Other devices share this one home thread, so the drawer row may be stale. Only delete the id the SERVER still
    // holds; a replacement main chat made elsewhere is never deleted by this reset.
    let holder;
    try {
      holder = await currentServerThreadRow();
    } catch (error) {
      throw new Error(`Could not check the main chat: ${errorText(error)}`);
    }
    if (!holder || holder.id !== item.id) {
      throw new Error("The main chat changed on another device, so it was not reset. Open the drawer and try again.");
    }
    await deleteSessionFenced(item.id);
    deleted = true;
    // The old thread is gone: forget its ids before the fresh one is created, so nothing can select it again and the
    // deleted transcript cannot stay on screen while the new main is being made.
    if (state.homeId === item.id) {
      state.homeId = null;
      safeStorageSet(STORE_KEY, null);
    }
    const wasViewing = state.viewedId === item.id;
    state.viewedId = null;
    state.viewedUnsent = false;
    state.viewedTitle = "";
    state.storedId = null;
    state.liveSid = null;
    state.streaming = false;
    state.turn = null;
    if (wasViewing) {
      endEdit(); // an edit in the old main chat belongs to its composer state
      clearComposer(); // the old main chat's draft, attachments and pastes go with it
    }
    clearLog(); // the deleted chat's messages must never be shown again, even if the create fails below
    setEmptyState(false);
    for (const id of [...state.cards.keys()]) removeCard(id);
    persistView();
    await attachThread(); // ensureHome creates or adopts the fresh title holder, and attachHome shows it empty
    state.composerLocked = false;
    await drawerApi.refresh();
  } catch (error) {
    if (deleted) {
      // Exact state: the old main chat is gone and no replacement is attached. Keep the composer locked and say so;
      // a retry (or a reload) recovers. The old chat is never claimed to have survived.
      state.composerLocked = true;
      await drawerApi.refresh().catch(() => {});
      throw new Error(
        `The old main chat was deleted, but the new one could not be opened: ${errorText(error)}. Try reset again, or reload ${AGENT}.`,
      );
    }
    // Nothing was deleted, so restore the readiness the refusal found.
    state.ready = previousReady;
    throw error;
  } finally {
    state.switching = false;
    state.resettingMain = false;
    updateComposer();
  }
}

// Pins or unpins a chat with the same revision-fenced PATCH and snapshot as rename. The pin is a durable sidebar flag:
// the drawer's Pinned group comes from it. A refusal throws a readable message for the drawer's note; the chat stays.
async function pinSession(item, pinned) {
  try {
    const snapshot = await api(`/api/sessions/${encodeURIComponent(item.id)}/mutation-snapshot`);
    if (!snapshot.exists) throw new Error("Session not found");
    await api(`/api/sessions/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: newRequestId(),
        expected_revision: snapshot.runtime_revision,
        expected_generation: snapshot.runtime_generation,
        pinned,
      }),
    });
  } catch (error) {
    throw new Error(sessionErrorText(error, pinned ? "pin" : "unpin"));
  }
}

// The server's refusal reasons (the mutation fence's codes) as sentences a person can act on.
function sessionErrorText(error, action) {
  const reason = error && typeof error.detail === "string" ? error.detail : "";
  if (/session_busy|unknown_execution/.test(reason)) return "This chat is busy right now. Let its reply finish, then try again.";
  if (/revision_conflict/.test(reason)) return "This chat changed elsewhere. Try again.";
  if (/runtime_draining|storage_unavailable/.test(reason)) return `${AGENT}'s backend is busy. Try again in a moment.`;
  if (/client_upgrade_required/.test(reason)) return "This app is out of sync with the Hermes backend. Reload it, then try again.";
  return `Could not ${action} this chat: ${errorText(error)}`;
}

function newRequestId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Whether a server request (approval, clarify) belongs to the chat on screen.
function belongsToView(params) {
  if (state.readOnly) return false; // a read-only chat has no live runtime here, so nothing is asked of it
  return !state.liveSid || !params.session_id || params.session_id === state.liveSid;
}

// History pages: include_compacted=true, or rows Hermes compacted (summarised for the model) vanish from the chat
// even though they are stored. The server returns at most 500 rows per page, newest first, and tool rows count toward that, so a
// busy chat shows only a few bubbles from page one. Older pages load as you scroll to the top.
const HISTORY_PAGE = 500;
const older = { sid: null, offset: 0, minId: Infinity, done: true, busy: false, gen: 0 };

function renderHistoryEntries(messages) {
  for (const { message, text, images, files, kind, clarify } of chatEntries(messages, { notices: true })) {
    if (kind === "clarify") {
      // The saved question(s) come back where they were asked, as the resolved card.
      addResolvedClarify(clarify);
      continue;
    }
    if (kind === "fail") {
      addFailLine(text);
      continue;
    }
    // The durable row id (messages.id) and the stored time come with each row; both feed Edit and Branch.
    const meta = {
      rowId: Number.isInteger(message.id) ? message.id : null,
      ts: Number(message.timestamp) || 0,
      attached: carriesAttachments(message),
      images,
      files,
    };
    if (message.role === "user") addUserBubble(text, [], false, meta);
    else if (kind === "job") addJobBubble(text, meta);
    else addAssistantBubble(text, meta);
  }
}

function lowestRowId(messages) {
  let low = Infinity;
  for (const m of messages) if (Number.isInteger(m.id) && m.id < low) low = m.id;
  return low;
}

async function loadHistory(messageCount = null) {
  // An empty thread has no transcript to fetch (the REST page 404s until its first message).
  let data = { messages: [] };
  if (messageCount !== 0) {
    data = await api(`/api/sessions/${encodeURIComponent(state.storedId)}/messages?limit=${HISTORY_PAGE}&order=latest&include_compacted=true`);
  }
  state.turn = null;
  clearLog();
  const rows = data.messages || [];
  older.gen += 1;
  older.sid = state.storedId;
  older.offset = HISTORY_PAGE;
  older.minId = lowestRowId(rows);
  older.done = rows.length === 0;
  older.busy = false;
  renderHistoryEntries(rows);
  // A chat opens at its newest message, so that is the one seen first (Inbox read tracker, the person, 8 Nov 2026). A deep
  // link lands on its own message instead; the visible-row observer marks that one.
  if (!pendingTarget) markInboxNewest();
  // Only unanswered cards come back from the log after a repaint; a resolved one is redrawn from history (a Question)
  // or has no record at all (an Approval), so appending it here would double it.
  for (const card of state.cards.values()) if (!card.resolved) els.log.append(card.el);
  setEmptyState(els.log.childElementCount === 1);
  // A deep link wants its own message on screen, not the end of the chat: it loads the pages it needs and centres the
  // message itself, so the end-of-chat scroll and the fill would only yank the view away.
  if (!pendingTarget) scrollToBottom(true);
  drawerApi.markSeen(state.viewedId); // the chat on screen counts as read once its history is in
  if (!pendingTarget) void fillOlder(); // a page that is mostly tool rows may not fill the screen: keep loading until it scrolls
}

// Loads the next older page and puts its bubbles above the current ones, keeping what is on screen where it is.
// Rows at or above the oldest row already shown are skipped, so a reply that arrived meanwhile (which shifts the
// server's offsets) never duplicates a bubble. Returns true when something was added.
async function loadOlder() {
  if (older.done || older.busy || !older.sid || older.sid !== state.storedId) return false;
  older.busy = true;
  const gen = older.gen;
  try {
    const data = await api(
      `/api/sessions/${encodeURIComponent(older.sid)}/messages?limit=${HISTORY_PAGE}&order=latest&include_compacted=true&offset=${older.offset}`,
    );
    if (gen !== older.gen) return false; // the chat changed or reloaded meanwhile
    const rows = (data.messages || []).filter((m) => !Number.isInteger(m.id) || m.id < older.minId);
    older.offset += HISTORY_PAGE;
    if (!(data.messages || []).length) {
      older.done = true;
      return false;
    }
    if (!rows.length) return true; // a page of rows already shown: the next one is older
    older.minId = Math.min(older.minId, lowestRowId(rows));
    const prevHeight = els.log.scrollHeight;
    const prevTop = els.log.scrollTop;
    const marker = els.log.lastChild;
    renderHistoryEntries(rows);
    // The render appended at the end; move the new nodes to the top, just under the hidden greeting.
    const added = [];
    for (let node = marker ? marker.nextSibling : els.log.firstChild; node; node = node.nextSibling) added.push(node);
    const frag = document.createDocumentFragment();
    for (const node of added) frag.append(node);
    els.log.insertBefore(frag, emptyState.nextSibling);
    els.log.scrollTop = prevTop + (els.log.scrollHeight - prevHeight);
    if (added.length) setEmptyState(false);
    return true;
  } catch {
    return false; // a failed page is retried on the next scroll to the top
  } finally {
    if (gen === older.gen) older.busy = false;
  }
}

// Keeps loading older pages while the top of the chat is in reach and the screen is not yet filled.
async function fillOlder() {
  for (let i = 0; i < 20; i += 1) {
    const reach = els.log.scrollTop < 400 || els.log.scrollHeight <= els.log.clientHeight + 400;
    if (!reach || older.done) return;
    if (!(await loadOlder())) return;
  }
}

els.log.addEventListener("scroll", () => {
  scheduleJumpUpdate();
  if (els.log.scrollTop < 400) void fillOlder();
}, { passive: true });

// ---------- deep links: a notification opens the message it was about ----------
// A push carries the stored row id of the message when the hook knows it (a scheduled job result), and otherwise the
// reply's opening characters as `match` plus the time it was sent. The target outlives the chat switch and its history
// load, then the row is centred and flashed. When nothing matches, the app says so and stays where it was.
const DEEPLINK_TS_WINDOW = 600; // a match candidate more than ~10 min from the notification is another reply
const DEEPLINK_PAGES = 20; // older pages to walk before calling a message gone
const FLASH_MS = 1600; // matches the toast: long enough to find, short enough not to linger
let pendingTarget = null; // the message the deep link is looking for, while its chat opens
let flashTimer = 0;
let deeplinkRun = 0; // bumps per deep link, so a slower earlier one cannot scroll a newer view

const squashSpace = (value) => String(value || "").replace(/\s+/g, " ").trim();

// The target in a push message or an #session=... hash; null when the notification points at no message at all (an
// approval or a question opens the chat at the bottom, where its card is).
function targetFrom(value) {
  if (!value) return null;
  const raw = value.message_id ?? value.msg;
  const match = typeof value.match === "string" ? value.match.trim() : "";
  const ts = Number(value.ts) || 0;
  const id = Number(raw);
  if (raw !== undefined && raw !== null && raw !== "" && Number.isFinite(id)) return { messageId: id, match, ts };
  return match ? { messageId: null, match, ts } : null;
}

// The row a target names. By row id when the push carried one; otherwise the assistant row whose text starts with the
// match, or is the start of it when the row is shorter, or contains it when a tool preamble comes first. Two replies
// can open the same way, so the one nearest the notification's time wins, and one further away than the window is
// treated as a different message. When a turn is active or streaming, falls back to the in-progress turn bubble.
function findTargetRow(target) {
  const rows = chatRows();
  if (target.messageId !== null) {
    const found = rows.find((row) => Number(row.hermesMiniMsg.rowId) === target.messageId);
    if (found) return found;
    if (state.turn && state.turn.row) {
      const maxId = rows.reduce((max, r) => Math.max(max, Number(r.hermesMiniMsg?.rowId) || 0), 0);
      if (target.messageId >= maxId) {
        state.turn.row.hermesMiniMsg.rowId = target.messageId;
        return state.turn.row;
      }
    }
    return null;
  }
  const wanted = squashSpace(target.match);
  if (!wanted) return null;
  if (state.turn && state.turn.row) {
    const turnText = squashSpace(state.turn.text || "");
    if (turnText && (turnText.startsWith(wanted) || wanted.startsWith(turnText) || turnText.includes(wanted))) {
      return state.turn.row;
    }
  }
  const candidates = rows.filter((row) => {
    const meta = row.hermesMiniMsg;
    if (meta.role !== "assistant") return false;
    const text = squashSpace(meta.text);
    return Boolean(text) && (text.startsWith(wanted) || wanted.startsWith(text) || text.includes(wanted));
  });
  if (candidates.length < 2 || !target.ts) return candidates[0] || null;
  let best = null;
  let bestGap = Infinity;
  for (const row of candidates) {
    const gap = Math.abs((Number(row.hermesMiniMsg.ts) || 0) - target.ts);
    if (gap < bestGap) {
      best = row;
      bestGap = gap;
    }
  }
  return bestGap <= DEEPLINK_TS_WINDOW ? best : null;
}

// Reaches back through the loaded pages until the target shows up or the chat runs out. fillOlder() is no help: it
// stops as soon as the screen is full, which happens long before an old message is in.
async function loadUntilFound(target) {
  for (let page = 0; page < DEEPLINK_PAGES; page += 1) {
    const found = findTargetRow(target);
    if (found) return found;
    if (older.done) return null;
    if (older.busy) {
      // fillOlder() is fetching the page we want next; let it land instead of asking again and again.
      await new Promise((resolve) => setTimeout(resolve, 60));
      continue;
    }
    await loadOlder();
  }
  return findTargetRow(target);
}

function flashRow(row) {
  row.classList.remove("flash");
  void row.offsetWidth; // restart the glow when the same message is opened twice
  row.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => row.classList.remove("flash"), FLASH_MS);
}

// The log is the scroll container, so scrollIntoView moves the chat and not the page. Reduced motion gets the same
// jump without the easing (style.css turns the glow into a plain outline).
// A jump, not a smooth scroll: a long smooth scroll to an older page was cut
// short by the log's own scroll anchoring after the prepend. The position is applied again after two frames, once
// late layout (images, the anchoring pass) has settled.
// The start of the message lands ~1/5th down the screen so the floating avatar never covers it.
async function revealRow(row) {
  const log = els.log;
  const place = () => {
    if (!row.isConnected) return;
    const rb = row.getBoundingClientRect();
    const lb = log.getBoundingClientRect();
    const targetTop = lb.top + Math.round((lb.height || window.innerHeight) * 0.2);
    const want = log.scrollTop + (rb.top - targetTop);
    log.scrollTop = Math.max(0, Math.min(want, log.scrollHeight - log.clientHeight));
  };
  place();
  flashRow(row);
  for (let i = 0; i < 2; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  place();
}

// A tap can land while the socket is still coming up (a cold open, a reconnect). Wait for gateway.ready, but not
// forever: when it never comes, the app's own reconnect flow reports the outage and the toast covers the rest.
async function waitForSocket(ms = 5000) {
  const until = Date.now() + ms;
  while (!state.wsReady && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  return state.wsReady;
}

// A tap can land while a chat switch is still starting. switchSession() refuses a second switch, so a deep link
// that ignored that would read the chat being left and call its message missing.
async function waitForSwitch(ms = 5000) {
  const until = Date.now() + ms;
  while (state.switching && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
}

// Opens the chat a notification named, then its message. A chat that is gone falls back to what the app shows anyway
// (the main chat) and still says the message was not found, because it was in the chat that is missing.
async function openTarget(id, target) {
  // An approval or a question carries no message: its card is at the bottom, where the chat opens.
  if (!target) {
    try {
      await waitForSocket();
      await openPushedSession(id);
    } catch {
      /* the app's own attach/reconnect path reports a chat it cannot open */
    }
    return false;
  }
  const run = ++deeplinkRun;
  pendingTarget = target;
  try {
    await waitForSocket();
    if (run !== deeplinkRun) return false;
    await openPushedSession(id);
    await waitForSwitch();
    if (run !== deeplinkRun) return false;
    if (state.viewedId !== id && !state.switching) {
      // The switch that was already running belonged to another tap: open the target now.
      await openPushedSession(id);
      await waitForSwitch();
      if (run !== deeplinkRun) return false;
    }
    let row = null;
    if (state.viewedId === id) {
      if (!state.turn) {
        // A reply that just finished is still a live row with no durable id, and the history page
        // loaded before it existed does not have it. Rebuild the page from history so the target is
        // found by its stored row id (Inbox) or stored text (notification).
        try {
          await loadHistory();
        } catch {
          /* fall back to the rows already on screen */
        }
        if (run !== deeplinkRun) return false;
      }
      row = await loadUntilFound(target);
      if (run !== deeplinkRun) return false;
    }
    if (!row) {
      showToast("Message not found", "error");
      return false;
    }
    await revealRow(row);
    return true;
  } catch {
    if (run === deeplinkRun) showToast("Message not found", "error");
    return false;
  } finally {
    if (run === deeplinkRun) pendingTarget = null;
  }
}

async function reconnect() {
  if (state.connecting) return;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN && (state.ready || state.readOnly)) return;
  try {
    await connect();
    await attachThread();
    await openSessionFromHash(); // a push opened this window while we were offline
    state.backoffIdx = 0;
    noteOnline();
    setStatus("");
    refreshDockedDrawer(); // the home thread may have just been adopted: the docked list needs its home row
  } catch (error) {
    if (error instanceof AuthRedirect) return;
    if (state.ws) dropSocket(state.ws);
    noteOffline();
    scheduleReconnect();
  }
}

// ---------- rendering: messages and streaming ----------

function addUserBubble(text, attachments, animateIn = false, meta = {}) {
  const row = el("div", "msg user");
  // Pictures go above the bubble, right-aligned, in the same .media block a reply uses: local blob URLs for a send,
  // server paths for a stored message. A picture-only message has no bubble at all.
  const sources = [];
  for (const item of attachments) if (item.url) sources.push({ url: item.url, alt: item.file ? item.file.name : "" });
  for (const path of meta.images || []) sources.push({ path });
  const media = renderMedia(sources);
  if (media) row.append(media);
  // Attached files (not pictures) as chips above the bubble: the name from a send, the stored path from history.
  const names = [];
  for (const item of attachments) if (item.kind !== "image" && item.file) names.push(item.file.name);
  for (const path of meta.files || []) names.push(String(path).split("/").pop() || String(path));
  if (names.length) {
    const chips = el("div", "file-chips");
    for (const name of names) {
      const chip = el("span", "file-chip");
      chip.insertAdjacentHTML("beforeend",
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>');
      chip.append(el("span", "file-chip-name", name));
      chip.title = name;
      chips.append(chip);
    }
    row.append(chips);
  }
  if (text) {
    const bubble = el("div", "bubble");
    const body = el("span", "bubble-text");
    body.append(document.createTextNode(text));
    bubble.append(body);
    row.append(bubble);
  }
  row.hermesMiniMsg = messageRecord("user", text, meta, attachments.length > 0 || (meta.images || []).length > 0);
  addMessageActions(row);
  const fly = animateIn && state.viewedEmpty;
  row.classList.toggle("first-in", fly);
  setEmptyState(false, { fly });
  els.log.append(row);
  const bubble = row.querySelector(".bubble");
  if (bubble) fitLongBubble(bubble);
  return bubble;
}

// Long messages of yours fold to a few lines with a chevron at the bottom right that unfolds them,
// like Gemini. Only the chevron toggles; a tap anywhere else on the message keeps its usual behaviour (time row on
// touch, long-press menu). A message folds when it runs past LONG_LINES lines and then shows FOLD_LINES.
const LONG_LINES = 7;
const FOLD_LINES = 5;
const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function fitLongBubble(bubble) {
  const body = bubble.querySelector(".bubble-text");
  if (!body) return;
  const lineHeight = parseFloat(getComputedStyle(body).lineHeight) || 22;
  // Measure the full text, whatever its current fold.
  const wasCollapsed = bubble.classList.contains("collapsed");
  bubble.classList.remove("collapsed");
  const long = body.scrollHeight > lineHeight * LONG_LINES + 2;
  bubble.style.setProperty("--fold-h", `${Math.round(lineHeight * FOLD_LINES)}px`);
  bubble.classList.toggle("long", long);
  let toggle = bubble.querySelector(":scope > .bubble-toggle");
  if (!long) {
    if (toggle) toggle.remove();
    return;
  }
  if (!toggle) {
    toggle = el("button", "bubble-toggle");
    toggle.type = "button";
    toggle.innerHTML = CHEVRON_DOWN;
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const collapsed = bubble.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? "Show full message" : "Show less");
    });
    bubble.append(toggle);
    bubble.classList.add("collapsed"); // a new long message starts folded
  } else if (wasCollapsed) {
    bubble.classList.add("collapsed");
  }
  const collapsed = bubble.classList.contains("collapsed");
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Show full message" : "Show less");
}

// The chat column changes width (window resize, docked computer, the resize seam): re-measure which messages are long.
if (typeof ResizeObserver === "function") {
  let lastLogWidth = 0;
  new ResizeObserver(() => {
    scheduleJumpUpdate();
    const width = els.log.clientWidth;
    if (width === lastLogWidth) return;
    lastLogWidth = width;
    for (const bubble of els.log.querySelectorAll(".msg.user > .bubble")) fitLongBubble(bubble);
  }).observe(els.log);
}

// Hermes injects system notices as user-role turns. The server marks them with display_kind (gateway/response_filters.py,
// MACHINERY_DISPLAY_KINDS). They render as a muted centred line that expands on tap, never as a user bubble.
const NOTICE_KINDS = new Set(["internal_notification", "process_complete", "async_delegation_complete"]);

function noticeLabel(text) {
  const head = ((text.match(/^\[([^\]]*)\]/) || [, ""])[1].split(" — ")[0]).toUpperCase();
  if (head.includes("DELEGATION")) return "Background task finished";
  if (head.includes("PROCESS") || head.includes("BACKGROUND")) return "Background process update";
  return "System notice";
}

// A failed-turn notice from history ("Your request was not processed…"): a small muted line, not a agent bubble.
function addFailLine(text) {
  const row = el("div", "msg system fail-line");
  row.append(el("div", "note", text));
  els.log.append(row);
  return row;
}

function addNoticeLine(text) {
  const row = el("div", "notice");
  const toggle = el("button", "notice-toggle", noticeLabel(text));
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const body = el("div", "notice-body", text);
  body.hidden = true;
  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
  });
  row.append(toggle, body);
  els.log.append(row);
  return row;
}

// A scheduled job's output: an ordinary agent bubble with no label; the row keeps a "job" class.
function addJobBubble(text, meta = {}) {
  const bubble = addAssistantBubble(text, meta);
  bubble.closest(".msg").classList.add("job");
  return bubble;
}

// Job results arrive outside any turn (the gateway writes them), so nothing streams them in. Pull the newest rows and
// append job results newer than the last row on screen. Runs on the bridge's push, on return to the app and after a
// reply finishes; skipped mid-reply and off the main chat.
let jobSyncBusy = false;
async function syncJobDeliveries() {
  if (jobSyncBusy || state.streaming || state.switching || !state.storedId || state.viewedId !== state.homeId) return;
  jobSyncBusy = true;
  const storedId = state.storedId;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(storedId)}/messages?limit=20&order=latest`);
    if (state.storedId !== storedId || state.streaming) return;
    const shownIds = new Set(chatRows().map((node) => Number(node.hermesMiniMsg.rowId)).filter(Number.isInteger));
    const lastShown = Math.max(0, ...shownIds);
    let added = false;
    for (const entry of chatEntries(data.messages || [])) {
      const id = Number(entry.message.id);
      if (entry.kind !== "job" || !Number.isInteger(id) || id <= lastShown || shownIds.has(id)) continue;
      addJobBubble(entry.text, { rowId: id, ts: Number(entry.message.timestamp) || 0, attached: false, images: [], files: [] });
      added = true;
    }
    if (added) scrollToBottom(false);
  } catch {
    /* the next trigger tries again */
  } finally {
    jobSyncBusy = false;
  }
}

function addAssistantBubble(text, meta = {}) {
  const row = el("div", "msg assistant");
  const bubble = el("div", "bubble");
  bubble.innerHTML = renderMarkdown(text);
  enhance(bubble);
  row.append(bubble);
  row.hermesMiniMsg = messageRecord("assistant", text, meta, false);
  addMessageActions(row);
  setEmptyState(false);
  els.log.append(row);
  watchInboxRow(row); // read by seeing it in chat (Inbox, the person, 8 Nov 2026)
  attachMedia(bubble, text);
  return bubble;
}

// ---------- message actions: copy, edit & resend, branch ----------
// Each message has an action row under it. A reply gets Copy and Branch, then its time; a user message gets its time,
// then Copy and Edit, right-aligned. The row always takes its height, so nothing moves when the buttons appear; with a
// mouse the buttons and the time fade in on hover, and a touch device shows only the time (the long-press menu below
// carries the actions). Every row keeps a small record on the element (hermesMiniMsg):
// role, text shown, durable row id (null until known), time in epoch seconds (0 = unknown), and whether it had attachments.

const ICON_ATTRS = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ICON_EDIT = `<svg ${ICON_ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const ICON_BRANCH = `<svg ${ICON_ATTRS}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
const nowSec = () => Date.now() / 1000;
let shownBusy = false; // the streaming state the action buttons were last synced to

function messageRecord(role, text, meta, hasAttachments) {
  return {
    role,
    text,
    rowId: Number.isInteger(meta.rowId) ? meta.rowId : null,
    ts: meta.ts !== undefined ? meta.ts : nowSec(),
    attached: Boolean(hasAttachments || meta.attached),
  };
}

// "3:16 PM" today, "Nov 4, 3:16 PM" earlier this year, "Nov 4, 2025, 3:16 PM" in an earlier year. Local, 12-hour.
function messageTimeLabel(ts, now = new Date()) {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  const clock = { hour: "numeric", minute: "2-digit", hour12: true };
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return date.toLocaleTimeString([], clock);
  const day = { month: "short", day: "numeric", ...clock };
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleString([], day);
  return date.toLocaleString([], { year: "numeric", ...day });
}

function timeEl(ts) {
  const label = messageTimeLabel(ts);
  if (!label) return null;
  const node = el("time", "msg-time", label);
  node.dateTime = new Date(ts * 1000).toISOString();
  return node;
}

function actionButton(action, label, icon, onClick) {
  const button = el("button", "msg-act");
  button.type = "button";
  button.dataset.action = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  button.addEventListener("click", onClick);
  return button;
}

function addMessageActions(row) {
  const meta = row.hermesMiniMsg;
  const bar = el("div", "msg-actions");
  const copy = makeCopyButton("msg-copy msg-act", () => copyText(meta.text));
  copy.disabled = !meta.text;
  const time = timeEl(meta.ts);
  // Icons sit on the outer edge, the time on the inner side: user rows read [icons] time (right-aligned),
  // Agent rows read time [icons] (left-aligned).
  if (meta.role === "user") {
    bar.append(copy, actionButton("edit", "Edit message", ICON_EDIT, () => beginEdit(row)));
    if (time) bar.append(time);
  } else {
    if (time) bar.append(time);
    bar.append(copy, actionButton("branch", "Branch from this reply", ICON_BRANCH, () => branchFrom(row)));
  }
  row.append(bar);
  syncActionAvailability(bar);
}

// Edit is offered for a typed user message only. A message that carried an image or a file is not resent by an edit.
function editable(meta) {
  return meta.role === "user" && !meta.attached && Boolean(meta.text);
}

// Edit and Branch are off while a reply streams, and Branch is off in a read-only chat. A switch does not count: rows
// built while a chat opens must not come out disabled (the in-flight Branch press disables its own button instead).
function syncActionAvailability(root = els.log) {
  const busy = state.streaming;
  for (const button of root.querySelectorAll(".msg-act[data-action]")) {
    const meta = button.closest(".msg").hermesMiniMsg;
    if (button.dataset.action === "edit") {
      button.disabled = busy || state.readOnly || !editable(meta);
      button.title = meta.attached ? "Messages with attachments can't be edited" : "Edit message";
    } else {
      button.disabled = busy || state.readOnly;
    }
  }
}

// ---------- message menu (touch long press) and select mode ----------
// On a touch device a long press (450 ms, cancelled by a 10 px move or by lifting) on a message's bubble opens the
// same actions the row's buttons offer, anchored at the press point. The menu is the drawer's row-menu card (same
// look), built on demand: Copy, then Edit (user) or Branch (reply), then Select text, each with its icon on the left.
// It reuses the history pattern: one entry pushed on open, consumed by every in-app close. Select text puts that one
// message into native selection mode so Android's handles and copy toolbar appear.

const ICON_SELECT = `<svg ${ICON_ATTRS}><path d="M5 4v16"/><path d="M3 4h4"/><path d="M3 20h4"/><path d="M12 4h9"/><path d="M12 12h9"/><path d="M12 20h9"/></svg>`;

let msgMenu = null; // { row, prevFocus } while the menu is open
let msgMenuBack = null; // promise: a history.back() from an in-app menu close is still in flight
let resolveMsgMenuBack = null;
let selectingRow = null; // the message in select mode, if any
let longPressAt = 0; // when the last long-press menu opened, so its trailing click can be swallowed
let pressTimer = 0;
let pressStart = null; // { x, y, row } while a touch press is being watched
let selectScrollTimer = 0;

function msgMenuItem(label, icon, pick) {
  const item = el("button", "row-menu-item msg-menu-item");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.innerHTML = `${icon}<span>${label}</span>`;
  item.addEventListener("click", () => {
    closeMsgMenu();
    pick();
  });
  return item;
}

function openMsgMenu(row, x, y) {
  const meta = row.hermesMiniMsg;
  if (!meta || !row.isConnected) return;
  if (msgMenu) return;
  if (msgMenuBack) {
    msgMenuBack.then(() => openMsgMenu(row, x, y)); // the previous close's history.back() has not landed yet
    return;
  }
  leaveSelectMode();
  const caret = caretAt(x, y); // taken now: once the scrim and menu are up, hit-testing finds them, not the text
  msgMenu = { row, prevFocus: document.activeElement };
  const busy = state.streaming;
  els.msgMenu.innerHTML = "";
  const items = [];
  items.push(msgMenuItem("Copy", COPY_ICON, () => {
    copyText(meta.text); // copyText shows the "Copied" toast
  }));
  if (meta.role === "user") {
    if (editable(meta) && !busy && !state.readOnly) {
      items.push(msgMenuItem("Edit", ICON_EDIT, () => beginEdit(row)));
    }
  } else if (!busy && !state.readOnly) {
    items.push(msgMenuItem("Branch", ICON_BRANCH, () => branchFrom(row)));
  }
  items.push(msgMenuItem("Select text", ICON_SELECT, () => enterSelectMode(row, caret)));
  els.msgMenu.append(...items);

  row.classList.add("msg-menu-open");
  els.msgMenuScrim.classList.add("open");
  els.msgMenu.classList.add("open");
  placeMsgMenu(x, y);
  if (!(history.state && history.state.hermesMiniMsgMenu === true)) history.pushState({ hermesMiniMsgMenu: true }, "");
  items[0].focus({ preventScroll: true });
  try {
    navigator.vibrate?.(10);
  } catch {
    /* vibrate is optional */
  }
}

// Places the card near the press point, fully on screen and above the composer. It flips above the finger when there
// is no room below, and is clamped 12 px from the sides.
function placeMsgMenu(x, y) {
  const margin = 12;
  const gap = 8;
  const composerTop = composerEl ? composerEl.getBoundingClientRect().top : window.innerHeight;
  const limit = Math.min(window.innerHeight, composerTop) - gap;
  const w = els.msgMenu.offsetWidth;
  const h = els.msgMenu.offsetHeight;
  let top = y + gap;
  if (top + h > limit) top = y - gap - h;
  top = Math.min(Math.max(margin, top), Math.max(margin, limit - h));
  const left = Math.min(Math.max(margin, x - 8), Math.max(margin, window.innerWidth - w - margin));
  els.msgMenu.style.left = `${left}px`;
  els.msgMenu.style.top = `${top}px`;
}

// Closes the menu. An in-app close consumes the entry the menu pushed; a Back press has popped it already. Focus goes
// back to wherever it was before the menu opened.
function closeMsgMenu({ viaPop = false } = {}) {
  const m = msgMenu;
  if (!m) return Promise.resolve();
  msgMenu = null;
  m.row.classList.remove("msg-menu-open");
  els.msgMenuScrim.classList.remove("open");
  els.msgMenu.classList.remove("open");
  if (!viaPop && m.prevFocus && m.prevFocus.isConnected && typeof m.prevFocus.focus === "function") {
    m.prevFocus.focus({ preventScroll: true });
  }
  if (!viaPop && history.state && history.state.hermesMiniMsgMenu === true) {
    msgMenuBack = new Promise((resolve) => {
      resolveMsgMenuBack = resolve;
    });
    history.back();
    return msgMenuBack;
  }
  return Promise.resolve();
}

// Arrow keys, Home and End move between the menu's items (Enter and Space activate the focused one natively).
function moveMsgMenuFocus(event) {
  const items = [...els.msgMenu.querySelectorAll(".msg-menu-item")];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  let next;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (event.key === "ArrowDown" || event.key === "ArrowRight") next = index < 0 || index === items.length - 1 ? 0 : index + 1;
  else next = index <= 0 ? items.length - 1 : index - 1;
  event.preventDefault();
  items[next].focus({ preventScroll: true });
}

// Select text: only this message becomes selectable, and the word under the long-press point is selected (falling back
// to the whole message), so Android shows its handles and the user can drag them wider.
function caretAt(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      return range;
    }
  } catch {
    /* no caret: the whole message is selected instead */
  }
  return null;
}

function enterSelectMode(row, caret) {
  leaveSelectMode();
  row.classList.add("selecting");
  selectingRow = row;
  const target = row.querySelector(".bubble") || row;
  const selection = document.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  if (caret && target.contains(caret.startContainer) && caret.startContainer.nodeType === Node.TEXT_NODE) {
    caret.collapse(true);
    selection.addRange(caret);
    try {
      selection.modify("move", "backward", "word");
      selection.modify("extend", "forward", "word");
      // "forward word" can take the trailing space with it; trim it so only the word is highlighted.
      const text = selection.toString();
      const trailing = text.length - text.trimEnd().length;
      for (let i = 0; i < trailing; i += 1) selection.modify("extend", "backward", "character");
      if (selection.toString().trim()) return;
    } catch {
      /* fall through to the whole message */
    }
    selection.removeAllRanges();
  }
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.addRange(range);
}

function leaveSelectMode() {
  if (selectingRow) selectingRow.classList.remove("selecting");
  selectingRow = null;
}

els.msgMenuScrim.addEventListener("click", () => closeMsgMenu());
els.msgMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMsgMenu();
    return;
  }
  if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) moveMsgMenuFocus(event);
});

// Long press on a message bubble or text. Touch only; a move over 10 px or a lift cancels it. A message in select mode
// is left to native selection. The click that follows a long press is swallowed so links and images do not open.
els.log.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch" || event.button !== 0) return;
  const row = event.target.closest(".msg");
  if (!row || !row.hermesMiniMsg || row.classList.contains("selecting")) return;
  if (!event.target.closest(".bubble") || event.target.closest(".bubble-toggle")) return;
  clearTimeout(pressTimer);
  pressStart = { x: event.clientX, y: event.clientY, row };
  pressTimer = setTimeout(() => {
    const p = pressStart;
    pressStart = null;
    if (!p) return;
    longPressAt = Date.now();
    openMsgMenu(p.row, p.x, p.y);
  }, 450);
});
els.log.addEventListener(
  "pointermove",
  (event) => {
    if (!pressStart || event.pointerType !== "touch") return;
    if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) {
      clearTimeout(pressTimer);
      pressStart = null;
    }
  },
  { passive: true },
);
for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
  els.log.addEventListener(type, () => {
    clearTimeout(pressTimer);
    pressStart = null;
  }, { passive: true });
}
els.log.addEventListener(
  "click",
  (event) => {
    if (Date.now() - longPressAt < 600) {
      event.preventDefault();
      event.stopPropagation();
      longPressAt = 0;
    }
  },
  true,
);

// ---------- tap a message to reveal its action icons (touch) ----------
// On a touch layout the time is always visible (style.css) and a plain tap on a message's bubble reveals that
// message's icon buttons. Only one message shows its icons at a time; tapping the same message again hides them.
// A mouse layout is untouched: its hover reveal is still style.css. A press that becomes a long press (the menu), a
// scroll (over 10 px), a link, image or button tap, a selection, or select mode all leave the icon row alone.
let revealedTimeRow = null; // the message whose time row is open, if any
let tapTrace = null; // { x, y, moved } while a touch press is being watched for this tap gesture

// Follows the last input (index.html sets data-input), like style.css.
function touchLayout() {
  return document.documentElement.dataset.input === "touch";
}

function messageTimeNode(row) {
  return row.querySelector(":scope > .msg-actions .msg-time");
}

function showMessageTime(row) {
  if (revealedTimeRow && revealedTimeRow !== row) revealedTimeRow.classList.remove("time-open");
  if (revealedTimeRow === row) {
    row.classList.remove("time-open");
    revealedTimeRow = null;
    return;
  }
  row.classList.add("time-open");
  revealedTimeRow = row;
}

function selectionActive() {
  const selection = document.getSelection();
  return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed);
}

els.log.addEventListener("pointerdown", (event) => {
  if (!touchLayout() || event.button !== 0) return;
  tapTrace = { x: event.clientX, y: event.clientY, moved: false };
});
els.log.addEventListener(
  "pointermove",
  (event) => {
    if (!tapTrace || event.pointerType !== "touch") return;
    if (Math.hypot(event.clientX - tapTrace.x, event.clientY - tapTrace.y) > 10) tapTrace.moved = true;
  },
  { passive: true },
);
els.log.addEventListener("pointerup", (event) => {
  if (!tapTrace) return;
  if (Math.hypot(event.clientX - tapTrace.x, event.clientY - tapTrace.y) > 10) tapTrace.moved = true;
});
els.log.addEventListener("pointercancel", () => {
  tapTrace = null;
});
els.log.addEventListener("click", (event) => {
  if (!touchLayout()) return;
  const trace = tapTrace;
  tapTrace = null;
  if (!trace || trace.moved) return;
  const row = event.target.closest(".msg");
  if (!row || !row.hermesMiniMsg || row.classList.contains("selecting")) return;
  if (!event.target.closest(".bubble")) return;
  // Links, pictures (a thumbnail opens the viewer) and buttons (Copy, Edit, Branch, the code copy button) keep their press.
  if (event.target.closest("a, img, .media, button, .code-copy, .msg-actions")) return;
  if (!row.querySelector(":scope > .msg-actions")) return; // nothing to reveal: no action row
  if (selectionActive()) return;
  showMessageTime(row);
});
els.log.addEventListener("contextmenu", (event) => {
  if (!event.target.closest(".msg") || event.target.closest(".msg.selecting")) return;
  if (touchLayout()) event.preventDefault();
});

// Select mode ends when the selection empties or moves outside the message, and after a scroll once it is cleared.
document.addEventListener("selectionchange", () => {
  if (!selectingRow) return;
  const selection = document.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    selection.isCollapsed ||
    !selectingRow.contains(selection.anchorNode) ||
    !selectingRow.contains(selection.focusNode)
  ) {
    leaveSelectMode();
  }
});
els.log.addEventListener(
  "scroll",
  () => {
    clearTimeout(selectScrollTimer);
    selectScrollTimer = setTimeout(() => {
      if (!selectingRow) return;
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) leaveSelectMode();
    }, 150);
  },
  { passive: true },
);

// The message menu's own history entry. Its popstate from our history.back() only settles the pending close; a Back
// press closes the menu and leaves whatever is underneath.
window.addEventListener("popstate", (event) => {
  if (resolveMsgMenuBack) {
    const resolve = resolveMsgMenuBack;
    resolveMsgMenuBack = null;
    msgMenuBack = null;
    resolve();
    return;
  }
  if (msgMenu && !(event.state && event.state.hermesMiniMsgMenu === true)) closeMsgMenu({ viaPop: true });
});

// The message rows on screen, in order. System lines, notices and approval cards are not message rows.
function chatRows() {
  return [...els.log.children].filter((node) => node.hermesMiniMsg);
}

// Finds the durable row id of a message that has none yet (one sent or streamed in this session). The latest history is
// read, and the match is made by role and text: the k-th same-text message on screen must be the k-th same-text row on
// the server, and the counts must agree. For assistant replies with tool preambles, matches the suffix of the combined
// text or the turn's latest assistant row. Retries briefly to absorb SQLite commit latency.
async function resolveRowId(row, attempts = 3) {
  const meta = row.hermesMiniMsg;
  if (meta.rowId) return meta.rowId;
  const sameInView = chatRows().filter((node) => node.hermesMiniMsg.role === meta.role && sameText(node.hermesMiniMsg.text, meta.text));
  const index = sameInView.indexOf(row);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(state.storedId)}/messages?limit=500&order=latest&include_compacted=true`);
      const allRoleStored = chatEntries(data.messages || []).filter((entry) => entry.message.role === meta.role);

      // 1. Direct match by sameText
      const exactMatches = allRoleStored.filter((entry) => sameText(entry.text, meta.text));
      if (index >= 0 && exactMatches.length === sameInView.length) {
        const id = Number(exactMatches[index].message.id);
        if (Number.isInteger(id) && id > 0) {
          meta.rowId = id;
          return id;
        }
      }

      // 2. Assistant fallback: preamble-joined text (turn.prefix + text) or latest turn reply
      if (meta.role === "assistant" && allRoleStored.length > 0) {
        const wanted = squashSpace(meta.text);
        const candidates = allRoleStored.filter((entry) => {
          const entryText = squashSpace(entry.text);
          return Boolean(entryText) && (wanted.endsWith(entryText) || entryText.endsWith(wanted) || wanted.startsWith(entryText));
        });
        if (candidates.length > 0) {
          const best = candidates.at(-1);
          const id = Number(best.message.id);
          if (Number.isInteger(id) && id > 0) {
            meta.rowId = id;
            return id;
          }
        }
      }
    } catch {
      /* retry on transient error */
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }

  throw new Error("this message is not saved in the chat yet. Try again in a moment.");
}

// The whole transcript in order, page by page, compacted history included: the rows a branch is counted over.
// Shows the newest saved message of yours when another device sent it, above the reply that is now streaming. The row
// is written as the turn starts, so a few short retries cover the race. Nothing is added when the newest saved
// message is already the last one on screen (same row id, or same text for a row sent here).
async function showRemoteUserMessage(attempt = 0) {
  const storedId = state.storedId;
  if (!storedId) return;
  let data;
  try {
    data = await api(`/api/sessions/${encodeURIComponent(storedId)}/messages?limit=20&order=latest`);
  } catch {
    return;
  }
  if (state.storedId !== storedId) return; // switched chats meanwhile
  const users = chatEntries(data.messages || []).filter(
    (entry) => entry.message.role === "user" && entry.message.display_kind !== "steer",
  );
  const latest = users.at(-1);
  // Compare against EVERY user bubble on screen, newest first: the new turn's row may not
  // be saved yet, so the newest stored message can be an older one already shown, which was drawn a second time.
  const shownUsers = chatRows().filter((node) => node.hermesMiniMsg.role === "user");
  const pendingSteers = shownUsers.filter((node) => node.hermesMiniSteer);
  if (latest && pendingSteers.length > 1 && sameText(pendingSteers.map((node) => node.hermesMiniMsg.text).join("\n"), latest.text)) {
    for (const node of pendingSteers) {
      node.hermesMiniSteer = false;
      if (Number.isInteger(latest.message.id)) node.hermesMiniMsg.rowId = latest.message.id;
      els.log.append(node);
    }
    const turn = state.turn;
    if (turn && turn.row && turn.row.isConnected) els.log.append(turn.row);
    scrollToBottom(true);
    return;
  }
  const match = latest && [...shownUsers].reverse().find((node) =>
    (node.hermesMiniMsg.rowId && Number(node.hermesMiniMsg.rowId) === Number(latest.message.id))
    || (!node.hermesMiniMsg.rowId && sameText(node.hermesMiniMsg.text, latest.text)));
  if (match && match.hermesMiniSteer) {
    // A message sent as a steer that the server ran as its own turn: move it below the reply it was drawn above.
    match.hermesMiniSteer = false;
    if (Number.isInteger(latest.message.id)) match.hermesMiniMsg.rowId = latest.message.id;
    els.log.append(match);
    const turn = state.turn;
    if (turn && turn.row && turn.row.isConnected) els.log.append(turn.row);
    scrollToBottom(true);
    return;
  }
  if (!latest || match) {
    if (attempt < 3) setTimeout(() => void showRemoteUserMessage(attempt + 1), 700);
    return;
  }
  const meta = {
    rowId: Number.isInteger(latest.message.id) ? latest.message.id : null,
    ts: Number(latest.message.timestamp) || 0,
    attached: carriesAttachments(latest.message),
    images: latest.images,
    files: latest.files,
  };
  addUserBubble(latest.text, [], false, meta);
  // The reply that started streaming belongs under the message that prompted it.
  const turn = state.turn;
  if (turn && turn.row && turn.row.isConnected) els.log.append(turn.row);
  scrollToBottom(true);
}

async function fetchTranscript() {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const page = await api(
      `/api/sessions/${encodeURIComponent(state.storedId)}/messages?limit=500&offset=${offset}&order=oldest&include_compacted=true`,
    );
    const rows = page.messages || [];
    all.push(...rows);
    if (rows.length < 500) return all;
  }
}

// The rows the server copies into a branch: user and assistant rows that have text (the server does not drop the
// notice rows here, so they are counted too; the branch is checked against the reply afterwards).
function branchRows(rows) {
  return rows.filter((message) => (message.role === "user" || message.role === "assistant") && messageText(message).length > 0);
}

// Edit: the message's text goes into the composer under an "Edit message" bar. The draft that was there is kept
// aside and comes back when the edit ends (Cancel, Escape, or a successful send).
function beginEdit(row) {
  const meta = row.hermesMiniMsg;
  if (!editable(meta) || !row.isConnected || state.streaming || state.sending || state.switching) return;
  if (!state.ready || state.readOnly) return;
  if (state.editing) endEdit();
  state.editing = { row, saved: { text: els.input.value, attachments: state.attachments, pastes: state.pastes } };
  state.attachments = [];
  state.pastes = [];
  renderTray();
  row.classList.add("editing");
  els.editBar.hidden = false;
  els.input.value = meta.text;
  autosize();
  els.input.focus();
  els.input.setSelectionRange(meta.text.length, meta.text.length);
  syncActionAvailability();
}

// Leaves edit mode and puts the composer back as it was: its draft, attachments and collapsed pastes.
function endEdit() {
  const edit = state.editing;
  if (!edit) return;
  state.editing = null;
  edit.row.classList.remove("editing");
  els.editBar.hidden = true;
  els.input.value = edit.saved.text;
  state.attachments = edit.saved.attachments;
  state.pastes = edit.saved.pastes;
  renderTray();
  autosize();
}

// Cancel and Escape. Not while the edited text is being sent.
function cancelEdit() {
  if (!state.editing || state.sending) return;
  endEdit();
}

// Sends the edited text. The server cuts the chat at this message's row id and submits the new text: the message, its
// reply and everything after are removed, and the new text gets a fresh reply. Side effects of the removed turns are
// not undone. A cut that removes more than one user turn asks first and sends the explicit consent the server wants.
async function submitEdit() {
  const edit = state.editing;
  if (!edit || state.sending) return;
  const row = edit.row;
  const text = expandPastes(els.input.value).trim();
  if (!text) return;
  if (state.attachments.length) {
    sysLine("Remove the attachments first. An edit resends the text only.");
    return;
  }
  if (!row.isConnected) {
    endEdit();
    sysLine("That message is no longer in the chat.");
    return;
  }
  if (!state.ready || !state.liveSid) {
    sysLine("Not connected yet. Try again in a moment.");
    return;
  }
  const rows = chatRows();
  const at = rows.indexOf(row);
  const after = rows.length - at - 1;
  const userTurns = rows.slice(at).filter((node) => node.hermesMiniMsg.role === "user").length;
  const deep = userTurns > 1;
  if (deep) {
    const proceed = await confirmDialog({
      title: "Edit message?",
      message: `This also removes the ${after} message${after === 1 ? "" : "s"} after it.`,
      confirmLabel: "Edit",
      danger: true,
    });
    if (!proceed) return;
  }
  const sid = state.liveSid;
  state.sending = true;
  try {
    const rowId = await resolveRowId(row);
    state.localStartAt = Date.now(); // the message.start that follows is ours, not another device's
    await rpc("prompt.submit", {
      session_id: sid,
      text,
      confirm_truncate: true,
      truncate_before_row_id: rowId,
      ...(deep ? { confirm_deep_truncate: true } : {}),
    });
  } catch (error) {
    sysLine(`Could not edit this message: ${errorText(error)}`);
    return;
  } finally {
    state.sending = false;
  }
  if (state.editing === edit) endEdit();
  if (!row.isConnected || state.liveSid !== sid) return; // the view moved on while the edit was in flight
  removeFrom(row);
  addUserBubble(text, [], false, { ts: nowSec() });
  state.streaming = true;
  scheduleTurnPaint(ensureTurn());
  updateComposer();
  scrollToBottom(true);
}

// Removes a message and everything after it from the view, with any approval or clarify card that sat below it.
function removeFrom(row) {
  let node = row;
  while (node) {
    const next = node.nextElementSibling;
    for (const [id, card] of state.cards) {
      if (card.el === node) state.cards.delete(id);
    }
    node.remove();
    node = next;
  }
}

// Branch: a new chat with the conversation through this reply. session.branch copies the first `count` rows of the
// transcript (count = the reply's position, through its row id). The copy is checked against the reply before the app
// switches to it, and a copy that does not match is archived again. The chat on screen is not changed.
async function branchFrom(row) {
  const meta = row.hermesMiniMsg;
  if (state.streaming || state.sending || state.switching || state.editing || state.readOnly) return;
  if (!state.ready || !state.liveSid || !row.isConnected) return;
  // Confirm first. Not a danger action: nothing is lost.
  const proceed = await confirmDialog({
    title: "Branch from here?",
    message: "This opens a new chat with the conversation up to this reply. This chat stays as it is.",
    confirmLabel: "Branch",
  });
  if (!proceed) return;
  // The chat may have changed while the window was open (a reply started, a switch, a disconnect).
  if (state.streaming || state.sending || state.switching || state.editing || state.readOnly) return;
  if (!state.ready || !state.liveSid || !row.isConnected) return;
  state.switching = true;
  const pressed = row.querySelector('[data-action="branch"]');
  if (pressed) pressed.disabled = true;
  showToast("Branching…");
  let branchId = null;
  try {
    const rowId = await resolveRowId(row);
    const rows = branchRows(await fetchTranscript());
    const index = rows.findIndex((message) => Number(message.id) === rowId);
    if (index < 0) throw new Error("this reply is not in the saved chat yet. Try again in a moment.");
    const count = index + 1;
    const copy = await rpc("session.branch", {
      session_id: state.liveSid,
      idempotency_key: newRequestId(),
      count, // the server's SessionBranchParams take only count (through_message_id is rejected as an extra input)
    });
    branchId = copy.stored_session_id;
    registerAppChat(branchId);
    const last = (copy.messages || []).at(-1);
    if (copy.message_count !== count || !last || last.role !== "assistant" || !sameText(last.text, meta.text)) {
      await rpc("session.archive", { session_id: branchId, archived: true }).catch(() => undefined);
      branchId = null;
      throw new Error("the copy did not match this reply, so it was removed.");
    }
  } catch (error) {
    if (!(error instanceof AuthRedirect)) {
      sysLine(`Could not branch: ${errorText(error)}`);
      showToast("Branch failed", "error");
    }
  }
  state.switching = false;
  syncActionAvailability();
  if (!branchId) {
    setStatus("");
    return;
  }
  drawerApi.refresh(); // the new chat is in the list the next time the drawer opens
  await switchSession(branchId);
  showToast("Branch successful", "success");
}

// Inline images: the TUI channel has no attachment path, so any absolute image path in a finished reply
// (bare, in `code`, or as MEDIA:/path) is fetched through the dashboard's authenticated
// /api/fs/read-data-url (the desktop app's path renderer) and shown under the text. Tap = full screen.
const MEDIA_PATH_RE = /(?:^|[\s`'"(\[]|MEDIA:)((?:\/|~\/)[^\s`'"<>()\[\]]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s`'")\].,;:!?])/gi;
const mediaCache = new Map(); // path -> Promise<dataUrl|null>

function mediaPaths(text) {
  const found = [];
  for (const m of String(text || "").matchAll(MEDIA_PATH_RE)) {
    if (!found.includes(m[1])) found.push(m[1]);
    if (found.length === 9) break;
  }
  return found;
}

function fetchMedia(path) {
  if (!mediaCache.has(path)) {
    const q = encodeURIComponent(path);
    const p = api(`/api/fs/read-data-url?path=${q}`)
      .then((r) => r.dataUrl)
      .catch(() => api(`/api/media?path=${q}`).then((r) => r.data_url))
      .then((url) => (typeof url === "string" && url.startsWith("data:image/") ? url : null))
      .catch(() => null);
    mediaCache.set(path, p);
  }
  return mediaCache.get(path);
}

// One renderer for inline pictures, shared by the agent's replies and the person's own messages. A source is either
// { path } (a server path, fetched through fetchMedia) or { url } (a local blob/data URL, shown at once), plus an
// optional alt. It returns the .media block: small square thumbnails, a 2-up/3-up grid for several, tap = viewer.
// A server file that fails to load drops its thumbnail; when every one fails the block removes itself.
function renderMedia(sources) {
  const items = (sources || []).filter((source) => source && (source.path || source.url));
  if (!items.length) return null;
  const wrap = el("div", "media");
  const layout = () => {
    const n = wrap.querySelectorAll("img:not([hidden])").length;
    wrap.classList.toggle("grid", n > 1);
    wrap.classList.toggle("three", n > 2 && n !== 4);
  };
  const gallery = () => [...wrap.querySelectorAll("img:not([hidden])")].map((node) => ({ url: node.src, alt: node.alt }));
  for (const source of items) {
    const img = el("img", "media-img");
    img.alt = source.alt || (source.path ? source.path.split("/").pop() : "image");
    img.addEventListener("click", () => {
      const shown = gallery();
      openViewer(shown, Math.max(0, shown.findIndex((item) => item.url === img.src)));
    });
    if (source.url) {
      img.src = source.url; // a local blob or data URL: visible immediately, no fetch and no flash
      wrap.append(img);
      continue;
    }
    img.hidden = true;
    wrap.append(img);
    fetchMedia(source.path).then((url) => {
      if (!url) {
        img.remove();
        if (!wrap.children.length) wrap.remove();
        layout();
        return;
      }
      const near = nearBottom();
      img.src = url;
      img.hidden = false;
      layout();
      img.addEventListener("load", () => { if (near) scrollToBottom(true); }, { once: true });
    });
  }
  layout();
  return wrap;
}

function attachMedia(bubble, text) {
  const paths = mediaPaths(text);
  if (!paths.length) return;
  const wrap = renderMedia(paths.map((path) => ({ path })));
  if (wrap) bubble.append(wrap);
  // fetchMedia is cached, so this reuses the thumbnail's own request.
  for (const path of paths) fetchMedia(path).then((url) => { if (url) hideMediaPath(bubble, path); });
}

// Once a picture shows, its file path is noise: drop the path from the reply text (with a MEDIA: prefix, a `code`
// span, a link or a code block that held only the path), then any line or list item left empty. A path that fails
// to load stays visible. The stored message and Copy keep the full text.
function hideMediaPath(bubble, path) {
  const emptied = new Set();
  const bare = (text) => text.trim().replace(/^MEDIA:\s*/, "");
  for (const node of bubble.querySelectorAll("code, a")) {
    if (node.closest(".media") || !node.isConnected || bare(node.textContent) !== path) continue;
    const before = node.previousSibling;
    if (before && before.nodeType === Node.TEXT_NODE) before.nodeValue = before.nodeValue.replace(/MEDIA:\s*$/, "");
    const block = node.closest(".code-block");
    const target = block && bare(block.querySelector("pre").textContent) === path ? block : node;
    emptied.add(target.parentElement);
    target.remove();
  }
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeValue.includes(path) && !node.parentElement.closest(".media, pre")) hits.push(node);
  }
  for (const node of hits) {
    node.nodeValue = node.nodeValue.split(`MEDIA:${path}`).join("").split(path).join("");
    emptied.add(node.parentElement);
  }
  // Empty means no words left, or (for a list item) only a "Label:" that pointed at the path.
  const empty = (node) => !node.textContent.replace(/[\s:–—-]+/g, "")
    || (node.tagName === "LI" && /^[^:\n]{1,40}:\s*$/.test(node.textContent.trim()));
  for (let node of emptied) {
    while (node && node !== bubble && bubble.contains(node) && !node.querySelector("img, video, button") && empty(node)) {
      const parent = node.parentElement;
      node.remove();
      node = parent;
    }
  }
}

// Full-screen viewer: swipe left/right (or arrow keys) between a reply's images, tap to close.
// Opening pushes one history entry, so the Back button closes the viewer instead of leaving the app. Any in-app
// close consumes that entry again with history.back().
function openViewer(items, start) {
  let index = start;
  let closed = false;
  const overlay = el("div", "viewer");
  const img = el("img");
  const count = el("div", "count");
  overlay.append(img, count);
  if (items.length > 1) {
    const prevBtn = el("button", "viewer-arrow prev");
    prevBtn.type = "button";
    prevBtn.setAttribute("aria-label", "Previous image");
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      step(-1);
    });

    const nextBtn = el("button", "viewer-arrow next");
    nextBtn.type = "button";
    nextBtn.setAttribute("aria-label", "Next image");
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      step(1);
    });

    overlay.append(prevBtn, nextBtn);
  }
  const show = () => {
    img.src = items[index].url;
    img.alt = items[index].alt;
    count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : "";
  };
  const step = (delta) => {
    index = (index + delta + items.length) % items.length;
    show();
  };
  const teardown = () => {
    closed = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPop);
  };
  // In-app close (tap, Escape): remove the overlay, then consume the entry this viewer pushed.
  const close = () => {
    if (closed) return;
    const pushed = history.state?.hermesMiniViewer === true;
    teardown();
    if (pushed) history.back();
  };
  // Back button: the browser has already popped the viewer's entry, so only the overlay needs removing.
  // A popstate landing on another viewer's entry is the echo of an earlier in-app close; ignore it.
  const onPop = (event) => {
    if (event.state?.hermesMiniViewer === true) return;
    if (!closed) teardown();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowRight") step(1);
    else if (event.key === "ArrowLeft") step(-1);
  };
  let startX = null;
  let swiped = false;
  overlay.addEventListener("touchstart", (event) => { startX = event.touches[0].clientX; swiped = false; }, { passive: true });
  overlay.addEventListener("touchend", (event) => {
    if (startX === null || items.length < 2) return;
    const dx = event.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) {
      swiped = true;
      step(dx < 0 ? 1 : -1);
    }
  });
  overlay.addEventListener("click", (event) => {
    if (swiped) { swiped = false; return; }
    if (event.target.closest(".viewer-arrow")) return;
    close();
  });
  document.addEventListener("keydown", onKey);
  window.addEventListener("popstate", onPop);
  history.pushState({ hermesMiniViewer: true }, "");
  show();
  document.body.append(overlay);
}

// Markdown images (img.md-img): clicking any rendered markdown picture opens the full-screen viewer
// with that message's inline markdown pictures, kept separate from attached media.
els.log.addEventListener("click", (event) => {
  const img = event.target.closest("img.md-img");
  if (!img || !img.isConnected || !els.log.contains(img)) return;
  const src = img.currentSrc || img.src;
  if (!src) return;
  event.preventDefault();
  const bubble = img.closest(".bubble") || img.closest(".msg") || els.log;
  const images = [...bubble.querySelectorAll("img.md-img")].filter((node) => node.src);
  const items = images.map((node) => ({ url: node.currentSrc || node.src, alt: node.alt || "image" }));
  const start = Math.max(0, images.indexOf(img));
  openViewer(items, start);
});

function ensureTurn() {
  if (!state.turn) {
    const row = el("div", "msg assistant");
    const bubble = el("div", "bubble");
    // The reply text is re-rendered into `content` on every paint; `status` (typing dots + narration) is a
    // separate node that is never detached while the turn streams, so the dots' CSS animation keeps running
    // (re-creating it on each paint restarted the animation many times a second and it looked frozen).
    const content = el("div", "turn-content");
    const status = el("div", "turn-status");
    const typing = el("span", "typing");
    typing.append(el("i"), el("i"), el("i"));
    const narration = el("span", "narration");
    narration.setAttribute("aria-live", "polite");
    narration.hidden = true;
    status.append(typing, narration);
    bubble.append(content, status);
    row.append(bubble);
    row.hermesMiniMsg = messageRecord("assistant", "", {}, false); // the time is now; the text is filled in when it finishes
    setEmptyState(false);
    els.log.append(row);
    state.turn = { row, bubble, content, status, text: "", prefix: "", raf: 0, timer: 0, lastPaint: 0, narrationVisible: false, narration };
    paintTurn(state.turn);
  }
  return state.turn;
}

function paintTurn(turn) {
  const near = nearBottom();
  turn.content.textContent = "";
  if (turn.text) {
    turn.content.insertAdjacentHTML("beforeend", renderMarkdown(turn.text));
    enhance(turn.content);
  }
  turn.status.hidden = !state.streaming;
  turn.narration.hidden = !(turn.narrationVisible && turn.narration.textContent);
  if (!turn.text && !state.streaming) turn.row.remove();
  if (near) scrollToBottom(true);
}

// Streaming deltas arrive many times a second, and each paint re-renders the whole reply. Paints are spaced at
// least STREAM_PAINT_MS apart (measured: a 9 KB reply takes ~15 ms to render), which also keeps the DOM stable
// long enough for a tap on a Copy button to land.
const STREAM_PAINT_MS = 60;

function scheduleTurnPaint(turn) {
  if (turn.raf || turn.timer) return;
  const wait = Math.max(0, STREAM_PAINT_MS - (performance.now() - (turn.lastPaint || 0)));
  turn.timer = setTimeout(() => {
    turn.timer = 0;
    turn.raf = requestAnimationFrame(() => {
      turn.raf = 0;
      turn.lastPaint = performance.now();
      paintTurn(turn);
    });
  }, wait);
}

function touchTurn() {
  if (!state.streaming) return;
  scheduleTurnPaint(ensureTurn());
}

function finishTurn() {
  const turn = state.turn;
  state.streaming = false;
  setTimeout(() => void syncJobDeliveries(), 800); // a job result that arrived mid-reply
  // Narration belongs to this turn: stop the loop, drop any in-flight answer, and clear the line.
  const n = state.narration;
  n.token += 1;
  clearTimeout(n.timer);
  n.timer = 0;
  hideNarration();
  if (turn) {
    if (turn.raf) cancelAnimationFrame(turn.raf);
    if (turn.timer) clearTimeout(turn.timer);
    turn.raf = 0;
    turn.timer = 0;
    paintTurn(turn);
    turn.status.remove(); // the finished reply keeps only its text
    if (turn.text) {
      turn.row.hermesMiniMsg.text = turn.text;
      attachMedia(turn.bubble, turn.text);
      if (!turn.row.querySelector(":scope > .msg-actions")) addMessageActions(turn.row);
      // A reply that just finished on screen has no row id yet; the Inbox still counts it as seen.
      if (!Number.isInteger(turn.row.hermesMiniMsg.rowId) && !state.readOnly && state.storedId) {
        resolveRowId(turn.row).then((rowId) => {
          if (Number.isInteger(rowId) && rowId > 0) {
            markInboxRead(rowId, { immediate: true });
            watchInboxRow(turn.row);
          }
        }).catch(() => {});
      }
    }
  }
  state.turn = null;
  updateComposer();
  drawerApi.markSeen(state.viewedId); // a reply that finished on screen is read
  refreshDockedDrawer(); // a finished reply may have set the chat's title
}

// ---------- narration ----------
// While the agent works, one muted line says what she is doing. Layer 1 is instant and local: a tool
// name mapped to a plain-English present participle. Layer 2 replaces it with a small model's line,
// throttled (see NARRATION_*), and never invents results. Raw tool names, args and paths never show.

const NARRATION_TOOL_LABELS = [
  ["ibkr_", "Checking your brokerage account…"],
  ["actual_", "Looking at your budget…"],
  ["gog_gmail", "Reading your email…"],
  ["gog_calendar", "Checking your calendar…"],
  ["gog_drive", "Opening your Google files…"],
  ["gog_docs", "Opening your Google files…"],
  ["gog_sheets", "Opening your Google files…"],
  ["gog_slides", "Opening your Google files…"],
  ["run_command", "Running a quick command…"],
  ["terminal", "Running a quick command…"],
  ["web_search", "Searching the web…"],
  ["x_search", "Searching the web…"],
  ["web_extract", "Reading a webpage…"],
  ["web_fetch", "Reading a webpage…"],
  ["browser_", "Looking at a webpage…"],
  ["read_file", "Reading a file…"],
  ["write_file", "Updating a file…"],
  ["patch", "Updating a file…"],
  ["search_files", "Looking through your files…"],
  ["hindsight_recall", "Remembering what we talked about…"],
  ["hindsight_retain", "Remembering what we talked about…"],
  ["delegate_task", "Handing part of this to a helper…"],
  ["session_search", "Looking through past chats…"],
  ["vision_analyze", "Looking at the image…"],
  ["image_generate", "Making an image…"],
  ["cronjob_manage", "Checking your schedules…"],
  ["notion", "Checking Notion…"],
  ["memory", "Keeping track of this…"],
  ["todo_", "Keeping track of this…"],
];

function narrationLabel(name) {
  const lower = String(name || "").toLowerCase();
  for (const [prefix, label] of NARRATION_TOOL_LABELS) {
    if (lower.startsWith(prefix)) return label;
  }
  return ""; // unknown tool: keep whatever line is showing (no generic "Working on it" filler; the person, 6 Nov 2026)
}

const NARRATION_INTERVAL_MS = 4500;
// No per-turn cap: the narrator runs for as long as the turn does. It only calls
// when something new happened, and skips ticks while the page is hidden, since each open screen narrates for itself.
const NARRATION_MAX_EVENTS = 12;

function newNarrationState() {
  return {
    token: 0,
    request: "",
    events: [],
    thinking: "",
    dirty: false,
    calls: 0,
    timer: 0,
    inflight: false,
    previous: [],
    fadeTimer: 0,
  };
}

function narrationPrefersReducedMotion() {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function narrationPush(event) {
  const n = state.narration;
  n.events.push(event);
  if (n.events.length > NARRATION_MAX_EVENTS) n.events = n.events.slice(-NARRATION_MAX_EVENTS);
  n.dirty = true;
  scheduleNarration();
}

function showNarration(text, turn) {
  if (!text || /^\s*working on it\b/i.test(text)) return; // never show the generic filler, from either layer
  const n = state.narration;
  const paint = (node) => {
    node.textContent = text;
    turn.narrationVisible = true;
    node.hidden = false;
  };
  const node = turn.narration;
  turn.narrationVisible = true;
  if (narrationPrefersReducedMotion() || !node.textContent || node.textContent === text) {
    paint(node);
    return;
  }
  // 200ms cross-fade: 100ms out, swap, 100ms back in.
  node.classList.add("fading");
  clearTimeout(n.fadeTimer);
  n.fadeTimer = setTimeout(() => {
    node.classList.remove("fading");
    paint(node);
  }, 100);
}

function hideNarration() {
  const n = state.narration;
  clearTimeout(n.fadeTimer);
  n.fadeTimer = 0;
  const turn = state.turn;
  if (turn) {
    turn.narrationVisible = false;
    turn.narration.textContent = "";
    turn.narration.hidden = true;
  }
}

function scheduleNarration() {
  const n = state.narration;
  if (n.timer || !state.streaming) return;
  n.timer = setTimeout(() => {
    n.timer = 0;
    if (!state.streaming) return;
    if (n.dirty && !n.inflight && !document.hidden) void requestNarration();
    scheduleNarration();
  }, NARRATION_INTERVAL_MS);
}

async function requestNarration() {
  const n = state.narration;
  const token = n.token;
  const events = n.events.slice(-NARRATION_MAX_EVENTS);
  if (n.thinking) events.push({ kind: "thinking", text: n.thinking.slice(-400) });
  n.inflight = true;
  n.calls += 1;
  n.dirty = false;
  try {
    const data = await api("/api/plugins/hermes-mini/narrate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        request: n.request.slice(0, 300),
        events,
        previous: n.previous.slice(-3),
      }),
    });
    if (token !== n.token || !state.streaming) return;
    const line = typeof data?.line === "string" ? data.line.trim() : "";
    if (!line) return;
    n.previous.push(line);
    if (n.previous.length > 3) n.previous.shift();
    const turn = state.turn;
    if (turn) showNarration(line, turn);
  } catch {
    /* narration is cosmetic: a failed call just leaves the Layer 1 label */
  } finally {
    n.inflight = false;
  }
}

// ---------- events ----------

function onEvent(event) {
  const type = event.type;
  const payload = event.payload || {};
  if (type === "gateway.ready") {
    onGatewayReady(payload);
    return;
  }
  // The bot screen is profile-wide state, not a chat event: handle it before the read-only/view filters so another
  // viewer's lease or a start/stop made elsewhere still paints correctly, and never let it reach the chat log.
  if (type === "display.lease" || type === "display.status") {
    botScreen?.onDisplayEvent(type, payload);
    return;
  }
  // A read-only chat has no live runtime here: any event on this socket belongs to another chat.
  if (state.readOnly) return;
  if (event.session_id && state.liveSid && event.session_id !== state.liveSid) return;

  switch (type) {
    case "message.start": {
      // A turn this device did not submit: the message came from another device (phone, computer, terminal). Hermes
      // sends no event with its text, so fetch it from the saved chat and show it.
      const local = Date.now() - (state.localStartAt || 0) < 20000;
      state.localStartAt = 0;
      if (!local) void showRemoteUserMessage();
      state.streaming = true;
      const n = state.narration;
      n.token += 1;
      n.events = [];
      n.thinking = "";
      n.dirty = false;
      n.calls = 0;
      n.inflight = false;
      clearTimeout(n.timer);
      n.timer = 0;
      scheduleTurnPaint(ensureTurn());
      updateComposer();
      break;
    }
    case "message.delta": {
      if (typeof payload.text !== "string" || !payload.text) break;
      state.streaming = true;
      const turn = ensureTurn();
      // Assistant text has started: the narration line steps aside until the next tool round.
      hideNarration();
      turn.text += payload.text;
      scheduleTurnPaint(turn);
      updateComposer();
      break;
    }
    case "message.complete": {
      const text = typeof payload.text === "string" && payload.text.trim() ? payload.text : null;
      if (text && isSilenceMarker(text)) {
        // "NO_REPLY" and friends: the agent chose not to answer (usually a background-task check-in). Show nothing.
        const turn = state.turn;
        if (turn && turn.row) turn.row.remove();
        state.turn = null;
        finishTurn();
        inbox.messageComplete(); // a finished turn is new Inbox activity
        break;
      }
      if (text) {
        const turn = ensureTurn();
        turn.text = turn.prefix && turn.prefix.trim() !== text.trim() ? turn.prefix + text : text;
      }
      if (typeof payload.warning === "string" && payload.warning) sysLine(payload.warning);
      finishTurn();
      inbox.messageComplete(); // refresh the Inbox head and badge
      break;
    }
    case "error": {
      sysLine(payload.message || "Something went wrong.");
      finishTurn();
      break;
    }
    case "tool.start": {
      // Activity only keeps the typing indicator alive. Tool names are never shown. Separate text segments.
      const turn = state.turn || (state.streaming ? ensureTurn() : null);
      if (turn && turn.text) {
        if (!turn.text.endsWith("\n")) turn.text += "\n\n";
        turn.prefix = turn.text;
      }
      if (turn) showNarration(narrationLabel(payload.name), turn);
      narrationPush({
        kind: "tool",
        name: String(payload.name || ""),
        args: JSON.stringify(payload.args || {}).slice(0, 200),
        status: "running",
      });
      touchTurn();
      break;
    }
    case "tool.complete": {
      // Hermes drains pending steers at the end of a tool batch; steers sent after the last tool.complete roll over
      // to the next turn and keep hermesMiniSteer=true so showRemoteUserMessage moves them below the finished reply.
      for (const node of chatRows()) if (node.hermesMiniSteer) node.hermesMiniSteer = false;
      narrationPush({
        kind: "tool",
        name: String(payload.name || ""),
        args: JSON.stringify(payload.args || {}).slice(0, 200),
        status: "done",
        ...(payload.summary ? { summary: String(payload.summary).slice(0, 200) } : {}),
      });
      touchTurn();
      break;
    }
    case "reasoning.delta":
    case "thinking.delta": {
      if (typeof payload.text === "string" && payload.text) {
        const n = state.narration;
        n.thinking = (n.thinking + payload.text).slice(-400);
        n.dirty = true;
        scheduleNarration();
      }
      touchTurn();
      break;
    }
    case "tool.progress":
    case "status.update":
      touchTurn();
      break;
    case "request.cancel": {
      // A withdrawn request stays as the record of what happened: resolved cards are left alone, an unanswered one is
      // kept in place with the closed look.
      const card = payload.id ? state.cards.get(payload.id) : null;
      if (!card || card.resolved) break;
      if (card.method === "clarify") resolveClarify(card, "cancelled");
      else if (card.method === "approval") resolveApproval(card, null);
      break;
    }
    case "session.replay_gap": {
      if (state.ready) void loadHistory().catch(() => undefined);
      break;
    }
    default:
      break;
  }
}

function updateComposer() {
  const busy = state.streaming;
  const dictating = Boolean(state.dictating || state.transcribing);
  // While the agent works, typed text steers her: the button stays Send. It turns into Stop only when
  // the box is empty and dictation is not active, so a running task can still be stopped.
  const stopMode = busy && !els.input.value.trim() && !dictating;
  // A main-chat reset replaces the live runtime: lock the composer until the reset either attaches the new main or
  // fails. A failed reset after the delete leaves composerLocked set, so a null runtime can never be sent to.
  const locked = state.resettingMain || state.composerLocked;
  els.send.classList.toggle("stop", stopMode);
  els.send.setAttribute("aria-label", stopMode ? "Stop" : busy ? "Send (steers the current task)" : "Send");
  // The icons are <svg>: SVGElement has no .hidden property (assigning it only made a JS expando), so the attribute is
  // set directly. Before this the button worked as Stop but kept drawing the Send arrow.
  els.sendIcon.toggleAttribute("hidden", stopMode);
  els.stopIcon.toggleAttribute("hidden", !stopMode);
  els.send.disabled = locked || Boolean(state.transcribing);
  els.input.disabled = locked;
  els.input.readOnly = dictating;
  els.attach.disabled = locked || dictating;
  if (els.micBtn) els.micBtn.disabled = locked || Boolean(state.transcribing);
  // Edit and Branch follow the streaming state; the buttons are re-synced only when it changes, not on every delta.
  if (busy !== shownBusy) {
    shownBusy = busy;
    syncActionAvailability();
  }
}

// ---------- server requests: approval and clarify ----------

function removeCard(id) {
  const card = state.cards.get(id);
  if (!card) return;
  card.el.remove();
  state.cards.delete(id);
}

// An answered card stays in the chat as a compact record: muted look, no controls, the outcome in plain text
//. The entry stays in state.cards marked resolved, so a resumed open_requests list cannot
// re-open it.
const APPROVAL_OUTCOMES = {
  once: "Approved once",
  session: "Approved for this chat",
  always: "Always allowed",
  deny: "Denied",
};

function respondApproval(entry, choice) {
  return rpc("approval.respond", {
    session_id: entry.params.session_id || state.liveSid,
    request_id: entry.params.request_id,
    choice,
  });
}

function resolveApproval(entry, choice, notice) {
  if (!entry || entry.resolved) return;
  entry.resolved = true;
  entry.el.classList.add("resolved");
  const actions = entry.el.querySelector(".actions");
  if (actions) actions.remove();
  entry.el.append(el("p", "resolved-outcome", notice || APPROVAL_OUTCOMES[choice] || "Closed without an answer"));
}

// The same resolved Question card serves the live card and a history row: every question, then its answer.
function fillResolvedClarify(card, items, notice) {
  card.classList.add("resolved");
  card.replaceChildren();
  card.append(el("h2", "", items.length > 1 ? "Questions" : "Question"));
  for (const item of items) {
    card.append(el("p", "resolved-question", item.question));
    const row = el("p", "resolved-answer");
    if (item.status === "answered") {
      row.append(el("span", "resolved-label", "You chose"));
      row.append(el("span", "resolved-value", item.value));
    } else {
      row.append(el("span", "resolved-value resolved-note", item.status === "skipped" ? "Skipped" : "Closed without an answer"));
    }
    card.append(row);
  }
  if (notice) card.append(el("p", "resolved-outcome", notice));
}

// A live card splits the reply around it: the text written so far stays above the card as its
// own bubble, and whatever the agent writes after the answer starts a new bubble below it, the order a refresh
// draws from history. Before this the reply kept streaming into the bubble above the card. The turn itself keeps
// running (streaming, narration, Stop); only state.turn is let go, so the next delta's ensureTurn() appends a new
// row after the card. message.complete then fills that new row with the final text, which is the post-card part.
function sealTurnForCard() {
  const turn = state.turn;
  if (!turn) return;
  if (turn.raf) cancelAnimationFrame(turn.raf);
  if (turn.timer) clearTimeout(turn.timer);
  turn.raf = 0;
  turn.timer = 0;
  hideNarration();
  const text = turn.text.trim();
  if (!text) {
    turn.row.remove(); // only the typing dots so far: nothing to keep
  } else {
    turn.text = text;
    paintTurn(turn);
    turn.status.remove();
    turn.row.hermesMiniMsg.text = text;
    attachMedia(turn.bubble, text);
    if (!turn.row.querySelector(":scope > .msg-actions")) addMessageActions(turn.row);
  }
  state.turn = null;
}

function addResolvedClarify(items) {
  const card = el("div", "card clarify resolved");
  fillResolvedClarify(card, items);
  els.log.append(card);
  return card;
}

function resolveClarify(entry, outcome, notice) {
  if (!entry || entry.resolved) return;
  entry.resolved = true;
  fillResolvedClarify(
    entry.el,
    entry.questions.map((question) => {
      const value = entry.locked[question.qid];
      if (value !== undefined) return { question: question.question, status: "answered", value: clarifyAnswerText(value) };
      return { question: question.question, status: outcome === "skipped" ? "skipped" : "unanswered" };
    }),
    notice,
  );
}

// A message sent while a card waits kills the card: the tool would otherwise block the turn
// forever. The steer goes first, so Hermes reads it inside the closed tool's own result.
// Wording per card.
const QUESTION_SENT_INSTEAD = "Question skipped — you sent a message instead";
const APPROVAL_SENT_INSTEAD = "Approval skipped — you sent a message instead";

function openCards() {
  return [...state.cards.values()].filter((card) => !card.resolved);
}

function closeOpenCards() {
  for (const [id, card] of [...state.cards]) {
    if (card.resolved) continue;
    if (card.method === "clarify") {
      // No answers is cancel-all; answers already locked per question stay locked server-side.
      answerServerRequest(id, { outcome: "cancelled" });
      resolveClarify(card, "skipped", QUESTION_SENT_INSTEAD);
    } else if (card.method === "approval") {
      respondApproval(card, "deny").catch(() => {}); // the Deny button's own RPC
      resolveApproval(card, "deny", APPROVAL_SENT_INSTEAD);
    }
  }
}

function rejectServerRequest(id, code, message) {
  try {
    sendFrame({ jsonrpc: "2.0", id, error: { code, message } });
  } catch {
    /* connection gone: the backend withdraws the request itself */
  }
}

// Answers an open server request without a preceding RPC (clarify's result frame, and cancel-all).
function answerServerRequest(id, result) {
  try {
    sendFrame({ jsonrpc: "2.0", id, result });
  } catch {
    /* connection gone: the backend withdraws the request itself */
  }
}

function onServerRequest(id, method, params) {
  if (state.cards.has(id)) return;
  if (method === "approval") {
    showApproval(id, params);
    return;
  }
  if (method === "clarify") {
    showClarify(id, params);
    return;
  }
  // Anything we cannot answer gets method-not-found so the backend does not wait out its deadline.
  rejectServerRequest(id, -32601, `no handler for server request: ${method}`);
}

function showApproval(id, params) {
  const card = el("div", "card approval");
  card.append(el("h2", "", "Approval needed"));
  if (params.description) card.append(el("p", "", String(params.description)));
  if (params.command) card.append(el("pre", "", String(params.command)));
  const actions = el("div", "actions");
  const deny = el("button", "btn danger", "Deny");
  const approve = el("button", "btn primary", "Approve once");
  // The server lists what this request allows: "session" approves this kind of action for the
  // rest of the chat, "always" adds it to Hermes's permanent allowlist. Shown only when offered.
  const offered = Array.isArray(params.choices) ? params.choices : ["once", "deny"];
  const extra = [];
  if (offered.includes("session")) extra.push(["session", el("button", "btn", "This chat")]);
  if (offered.includes("always")) extra.push(["always", el("button", "btn", "Always")]);
  actions.append(deny, approve, ...extra.map(([, button]) => button));
  card.append(actions);
  setEmptyState(false);
  sealTurnForCard();
  els.log.append(card);
  const entry = { el: card, method: "approval", params };
  state.cards.set(id, entry);

  const buttons = [deny, approve, ...extra.map(([, button]) => button)];
  const answer = async (choice) => {
    for (const button of buttons) button.disabled = true;
    try {
      await respondApproval(entry, choice);
      resolveApproval(entry, choice);
    } catch (error) {
      for (const button of buttons) button.disabled = false;
      sysLine(`Could not send approval: ${errorText(error)}`);
    }
  };
  approve.addEventListener("click", () => answer("once"));
  for (const [choice, button] of extra) button.addEventListener("click", () => answer(choice));
  deny.addEventListener("click", () => answer("deny"));
  scrollToBottom(true);
}

function bareChoice(choice) {
  const suffix = "(Recommended)";
  return choice.endsWith(suffix) ? choice.slice(0, -suffix.length).trim() : choice;
}

function showClarify(id, params) {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (!questions.length) {
    rejectServerRequest(id, -32602, "clarify request had no questions");
    return;
  }
  const locked = params.answers && typeof params.answers === "object" ? params.answers : {};
  const card = el("div", "card clarify");
  setEmptyState(false);
  sealTurnForCard();
  els.log.append(card);
  const entry = { el: card, method: "clarify", params, questions, locked, index: 0 };
  state.cards.set(id, entry);
  entry.index = Math.max(
    0,
    questions.findIndex((q) => !(q.qid in locked)),
  );
  renderClarify(id, entry);
  scrollToBottom(true);
}

function renderClarify(id, entry) {
  const { el: card, questions } = entry;
  card.replaceChildren();
  const question = questions[entry.index];
  const header = questions.length > 1 ? `Question ${entry.index + 1} of ${questions.length}` : "Question";
  card.append(el("h2", "", header));
  card.append(el("p", "", question.question));

  const busy = { value: false };
  const choices = Array.isArray(question.choices) ? question.choices.filter((c) => typeof c === "string") : [];
  if (choices.length) {
    const actions = el("div", "actions");
    for (const choice of choices) {
      const button = el("button", "btn", choice);
      button.addEventListener("click", () => {
        if (!busy.value) void submitClarify(id, entry, bareChoice(choice), busy);
      });
      actions.append(button);
    }
    card.append(actions);
  }

  const row = el("div", "answer-row");
  const input = el("input");
  input.type = "text";
  input.placeholder = choices.length ? "Or type an answer" : "Type an answer";
  input.enterKeyHint = "send";
  const send = el("button", "btn primary", "Send");
  const skip = el("button", "btn", "Skip");
  row.append(input, send);
  card.append(row);
  const actions = el("div", "actions");
  actions.append(skip);
  card.append(actions);

  const submitText = () => {
    const text = input.value.trim();
    if (text && !busy.value) void submitClarify(id, entry, text, busy);
  };
  send.addEventListener("click", submitText);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submitText();
    }
  });
  skip.addEventListener("click", () => {
    if (busy.value) return;
    // A response without answers is cancel-all: answers locked so far stand, the rest show as skipped.
    answerServerRequest(id, {});
    resolveClarify(entry, "skipped");
  });
}

async function submitClarify(id, entry, answer, busy) {
  const question = entry.questions[entry.index];
  busy.value = true;
  const value = question.multi_select ? JSON.stringify([answer]) : answer;
  try {
    const reply = await rpc("clarify.lock", { request_id: id, question_id: question.qid, answer: value });
    // The wait itself ended (expired): nothing was locked now, and the card closes as it stood.
    if (reply.status === "expired") {
      resolveClarify(entry, "cancelled");
      return;
    }
    entry.locked[question.qid] = value;
    const remaining = Array.isArray(reply.remaining) ? reply.remaining : [];
    if (remaining.length === 0) {
      resolveClarify(entry, "submitted");
      return;
    }
    const next = entry.questions.findIndex((q) => remaining.includes(q.qid));
    entry.index = next >= 0 ? next : entry.index;
    renderClarify(id, entry);
  } catch (error) {
    busy.value = false;
    sysLine(`Could not send answer: ${errorText(error)}`);
  }
}

// ---------- composer: attachments ----------

function renderTray() {
  els.tray.replaceChildren();
  els.tray.hidden = state.attachments.length === 0;
  state.attachments.forEach((item, index) => {
    const box = el("div", "item");
    if (item.url) {
      const img = el("img");
      img.src = item.url;
      img.alt = item.file.name;
      // A full-size preview of one attachment. The button wraps only the picture, so the × stays its own action:
      // tapping the picture never removes (or sends) anything, and tapping × never opens the viewer.
      const view = el("button", "item-view");
      view.type = "button";
      view.setAttribute("aria-label", `View image ${item.file.name}`);
      view.append(img);
      view.addEventListener("click", () => {
        const gallery = state.attachments
          .filter((att) => att && att.kind === "image" && att.url)
          .map((att) => ({ url: att.url, alt: att.file.name }));
        openViewer(gallery, Math.max(0, gallery.findIndex((entry) => entry.url === item.url)));
      });
      box.append(view);
    } else {
      box.append(el("span", "", item.file.name));
    }
    const remove = el("button", "x", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${item.file.name}`);
    remove.addEventListener("click", () => {
      const [gone] = state.attachments.splice(index, 1);
      if (gone && gone.url) URL.revokeObjectURL(gone.url);
      renderTray();
    });
    box.append(remove);
    els.tray.append(box);
  });
}

function addFiles(fileList) {
  let overLimit = false;
  for (const file of fileList) {
    const isImage = file.type.startsWith("image/");
    if (!isImage && file.size > MAX_FILE_BYTES) {
      sysLine(`${file.name} is larger than 20 MB and was not attached.`);
      continue;
    }
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      overLimit = true;
      continue;
    }
    state.attachments.push({
      file,
      kind: isImage ? "image" : "file",
      url: isImage ? URL.createObjectURL(file) : null,
    });
  }
  if (overLimit) sysLine(`You can attach up to ${MAX_ATTACHMENTS} pictures and files per message.`);
  renderTray();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Downscale to at most MAX_IMAGE_EDGE on the longest side, re-encode as JPEG q=0.85, return base64.
async function imageToJpegBase64(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return blobToBase64(file); // undecodable here: send the original bytes and let the server handle it
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("could not encode image");
  return blobToBase64(blob);
}

function clearComposer() {
  // Object URLs stay alive here: a failed send restores these attachments and their thumbnails.
  els.input.value = "";
  autosize();
  state.attachments = [];
  state.pastes = [];
  renderTray();
}

// ---------- composer: paste and drop ----------

// Pasted text is handled the way the Hermes TUI handles it (ui-tui/src/lib/text.ts pasteTokenLabel,
// ui-tui/src/app/useComposerState.ts handleTextPaste). A large paste (PASTE_COLLAPSE_LINES lines or more, or
// PASTE_COLLAPSE_CHARS characters or more) becomes a "[[ preview .. [N lines] .. tail ]]" label in the textarea, and
// the full text is kept in state.pastes. Small text is left to the browser.
function pasteLabel(text, lineCount) {
  const one = text.replace(/\s+/g, " ").trim().replace(/\]\]/g, "] ]");
  const chip = `[${lineCount} lines]`;
  if (!one) return `[[ ${chip} ]]`;
  if (one.length <= 48) return `[[ ${one} ${chip} ]]`;
  const head = one.slice(0, 16).trimEnd();
  const tail = one.slice(-28).trimStart();
  return `[[ ${head}.. ${chip} .. ${tail} ]]`;
}

// The clean text and line count of a paste that must collapse, or null when it stays as typed text.
function collapsedPaste(text) {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const lines = clean.split("\n").length;
  if (lines < PASTE_COLLAPSE_LINES && clean.length < PASTE_COLLAPSE_CHARS) return null;
  return { clean, lines };
}

// Swap every tracked label still in the text for its full pasted text, in order. A label the user deleted is gone.
function expandPastes(value) {
  if (!state.pastes.length) return value;
  const queues = new Map();
  for (const paste of state.pastes) {
    const queue = queues.get(paste.label) || [];
    queue.push(paste.text);
    queues.set(paste.label, queue);
  }
  return value.replace(/\[\[[^\n]*?\]\]/g, (match) => {
    const queue = queues.get(match);
    return queue && queue.length ? queue.shift() : match;
  });
}

// Insert at the caret (or over the selection), then resize the textarea. A space is added on a side that touches a
// word, as the TUI's insertAtCursor does, so a label pasted after "retry" does not run into it.
function insertIntoComposer(text) {
  const input = els.input;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const before = start > 0 ? input.value.charAt(start - 1) : "";
  const after = input.value.charAt(end);
  const lead = before && !/\s/.test(before) && !/^\s/.test(text) ? " " : "";
  const tail = after && !/\s/.test(after) && !/\s$/.test(text) ? " " : "";
  input.setRangeText(lead + text + tail, start, end, "end");
  autosize();
}

// Every File in a clipboard or drop transfer. The browser can expose one gesture's files twice: as kind:"file"
// items and as data.files. Their metadata (name, lastModified) is not guaranteed to agree between the two views,
// so merging them by a metadata key attached the same picture twice and, worse, collapsed distinct files that
// happened to share name/type/size/lastModified. The item list is the authoritative view of the gesture (it is
// what the paste or drop actually carried), so use it once it yields a file; fall back to data.files only when it
// yields none (no items, or an item whose getAsFile() returns null).
function filesFromTransfer(data) {
  const files = [];
  if (data && data.items) {
    for (const item of data.items) {
      if (!item || item.kind !== "file") continue;
      const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
      if (file) files.push(file);
    }
  }
  if (files.length) return files;
  if (data && data.files) {
    for (const file of data.files) if (file) files.push(file);
  }
  return files;
}

// A pasted URL, or the exact name of a pasted file, only refers to the attachment: it is not inserted as text.
const URL_ONLY_RE = /^(https?|file|blob):\/\/\S+$/i;
function isAttachmentReference(text, files) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  return URL_ONLY_RE.test(trimmed) || files.some((file) => file.name === trimmed);
}

// Images and files on the clipboard go to the tray through addFiles, the same path as the Photos and Files pickers
// (same 20 MB cap on files, same message). Plain text is pasted as-is without collapsing.
function handlePaste(event) {
  const data = event.clipboardData;
  if (!data) return;
  const files = filesFromTransfer(data);
  if (!files.length) return; // plain text: browser default paste as-is
  event.preventDefault();
  addFiles(files);
  const text = data.getData("text/plain") || "";
  if (!text || isAttachmentReference(text, files)) return;
  insertIntoComposer(text);
}
els.input.addEventListener("paste", handlePaste);

// Desktop drag and drop of files or images onto the chat or the composer. A tint marks the target (no border line).
// Only drags that carry files count, so text drags are untouched. The drop goes through addFiles.
let dragDepth = 0;
const dragHasFiles = (event) => Boolean(event.dataTransfer) && Array.from(event.dataTransfer.types || []).includes("Files");
function setDropTarget(on) {
  els.app.classList.toggle("drop-target", on);
}
document.addEventListener("dragenter", (event) => {
  if (!dragHasFiles(event) || state.readOnly) return;
  event.preventDefault();
  if (botScreen?.isOpen()) return; // the remote screen must not turn a file drag into a chat attachment
  dragDepth += 1;
  setDropTarget(true);
});
document.addEventListener("dragover", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault(); // without this the drop never fires, and the browser would open the file
  if (botScreen?.isOpen()) {
    event.dataTransfer.dropEffect = "none";
    return;
  }
  event.dataTransfer.dropEffect = state.readOnly ? "none" : "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!dragHasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropTarget(false);
});
document.addEventListener("drop", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault(); // never let the browser navigate to the dropped file
  dragDepth = 0;
  setDropTarget(false);
  if (state.readOnly || botScreen?.isOpen()) return;
  const files = filesFromTransfer(event.dataTransfer);
  if (files.length) addFiles(files);
});

// ---------- composer: send / stop ----------

async function send() {
  if (state.resettingMain || state.composerLocked) return; // the runtime is being replaced; never send to the old one
  if (state.streaming) return els.input.value.trim() ? steer() : stop();
  if (state.sending) return;
  if (state.editing) return submitEdit();
  const text = expandPastes(els.input.value).trim();
  const attachments = state.attachments.slice();
  if (!text && !attachments.length) return;
  if (!state.ready || !state.liveSid) {
    sysLine("Not connected yet. Try again in a moment.");
    return;
  }

  // No turn is running but a card is still open (edge case): closing it first releases the tool, then the text goes
  // as an ordinary message.
  if (openCards().length) closeOpenCards();

  state.sending = true;
  state.narration.request = text;
  const saved = { text: els.input.value, attachments, pastes: state.pastes.slice() };
  clearComposer();
  addUserBubble(text, attachments, true);
  state.streaming = true;
  scheduleTurnPaint(ensureTurn());
  updateComposer();
  scrollToBottom(true);

  try {
    const refs = [];
    for (const item of attachments) {
      if (item.kind === "image") {
        const content_base64 = await imageToJpegBase64(item.file);
        const stem = item.file.name.replace(/\.[^.]+$/, "") || "image";
        await rpc("image.attach_bytes", {
          session_id: state.liveSid,
          content_base64,
          filename: `${stem}.jpg`,
        });
      } else {
        const data_url = await readDataUrl(item.file);
        const attached = await rpc("file.attach", {
          session_id: state.liveSid,
          data_url,
          name: item.file.name,
        });
        if (attached && attached.ref_text) refs.push(attached.ref_text);
      }
    }
    const full = [text, ...refs].filter(Boolean).join("\n");
    state.localStartAt = Date.now(); // the message.start that follows is ours, not another device's
    await rpc("prompt.submit", { session_id: state.liveSid, text: full });
    registerAppChat(state.viewedId);
    if (state.viewedUnsent) {
      // The first message saves the chat on the server, so from now on its real id is remembered for a reload.
      state.viewedUnsent = false;
      persistView();
    }
  } catch (error) {
    // Nothing was submitted: give the text and attachments back so the user can retry.
    sysLine(`Send failed: ${errorText(error)}`);
    els.input.value = saved.text;
    autosize();
    state.attachments = saved.attachments;
    state.pastes = saved.pastes;
    renderTray();
    finishTurn();
  } finally {
    state.sending = false;
  }
}

// Sends the typed text into the running task without stopping it (session.steer: Hermes adds it to the next tool
// result, so the agent reads it mid-task). The message shows as a user bubble and the live reply continues below it.
// Attachments stay in the tray for a normal send after the turn. If the turn has just ended, the server answers
// "rejected" and the text is sent as an ordinary message instead.
async function steer() {
  if (state.sending || !state.liveSid) return;
  const text = expandPastes(els.input.value).trim();
  if (!text) return;
  const saved = { text: els.input.value, pastes: state.pastes.slice() };
  state.sending = true;
  els.input.value = "";
  state.pastes = [];
  autosize();
  updateComposer();
  let result;
  try {
    result = await rpc("session.steer", { session_id: state.liveSid, text });
  } catch (error) {
    sysLine(`Could not send: ${errorText(error)}`);
    els.input.value = saved.text;
    state.pastes = saved.pastes;
    autosize();
    state.sending = false;
    updateComposer();
    return;
  }
  state.sending = false;
  if (!result || result.status === "rejected") {
    // The task finished in the meantime: send it as a normal message once the turn has closed.
    els.input.value = saved.text;
    state.pastes = saved.pastes;
    autosize();
    updateComposer();
    if (!state.streaming) void send();
    return;
  }
  // The steer was delivered: a card waiting on the user is moot now, and the message replaces its answer. Steering
  // first means Hermes reads it inside the card's own tool result.
  if (openCards().length) closeOpenCards();
  sealTurnForCard();
  const steerBubble = addUserBubble(text, []);
  // Marked so that, if the server runs it as its own turn after all (the reply had just finished), the next turn's
  // start moves this bubble below that reply instead of drawing it again (showRemoteUserMessage).
  const steerRow = steerBubble && steerBubble.closest(".msg");
  if (steerRow) steerRow.hermesMiniSteer = true;
  scheduleTurnPaint(ensureTurn()); // the reply carries on in a new bubble under the message
  updateComposer();
  scrollToBottom(true);
}

async function stop() {
  if (!state.liveSid) return;
  try {
    await rpc("session.interrupt", { session_id: state.liveSid });
  } catch (error) {
    sysLine(`Could not stop: ${errorText(error)}`);
  }
}

// Grow with the text up to the CSS max-height (7 lines), then scroll inside with the scrollbar hidden.
// box-sizing is border-box, so the border has to be added to scrollHeight or the box is always 2px short.
function autosize() {
  const el = els.input;
  const row = el.closest(".row");
  // Gemini-style: once the text needs a second line, the box takes the composer's full width and
  // "+" / Send drop to a row underneath. The decision is always measured in the one-row layout (class off), so text
  // that fits only in the wider box cannot flip back and forth; the class toggles and the height settle in one
  // synchronous pass, so nothing paints in between.
  if (row) row.classList.remove("wide");
  el.style.height = "auto";
  const cs = getComputedStyle(el);
  const border = el.offsetHeight - el.clientHeight;
  const oneLine = (parseFloat(cs.lineHeight) || 20) + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const multi = el.value.includes("\n") || el.scrollHeight > oneLine + 2 || Boolean((state.dictating || state.transcribing) && el.value.length > 0);
  if (row && multi) {
    row.classList.add("wide");
    el.style.height = "auto";
  }
  const max = parseFloat(cs.maxHeight) || 162;
  const want = el.scrollHeight + border;
  el.style.height = `${Math.min(want, max)}px`;
  el.style.overflowY = want > max ? "auto" : "hidden";
}

// New chat starts a brand-new, untitled chat (Hermes titles it after the first message) and shows it at once. The
// main chat (state.homeId) is never renamed or replaced. Pressing New chat on an empty chat that was never sent keeps
// that chat and creates nothing.
function newChat() {
  if (state.resettingMain) return Promise.resolve(); // the reset owns the view and the next home thread
  if (state.creatingChat) return state.creatingChat;
  if (!state.ready && !state.readOnly) {
    sysLine("Not connected yet. Try again in a moment.");
    return Promise.resolve();
  }
  if (state.viewedId !== state.homeId && state.viewedEmpty && !state.readOnly) {
    els.input.focus();
    return Promise.resolve();
  }
  state.creatingChat = (async () => {
    const wasReady = state.ready;
    state.switching = true;
    state.ready = false;
    rememberScroll();
    try {
      await openFreshChat({ lower: true });
      els.input.focus();
    } catch (error) {
      state.ready = wasReady;
      sysLine(`Could not start a new chat: ${errorText(error)}`);
    } finally {
      state.switching = false;
      state.creatingChat = null;
    }
  })();
  return state.creatingChat;
}

// ---------- Voice dictation (Hermes' configured speech-to-text provider) ----------
const DICTATE_MAX_MS = 60_000;
let dictationRecorder = null;
let dictationStream = null;
let dictationChunks = [];
let dictationCaretStart = 0;
let dictationCaretEnd = 0;
let dictationSendAfter = false;
let dictationDiscarded = false;
let dictationDeadline = 0;
let dictationTimerId = 0;
let dictationAudioCtx = null;
let dictationAnalyser = null;
let dictationSource = null;
let dictationRafId = 0;
const lastInputCaret = { start: 0, end: 0, tracked: false };

function isDictationSupported() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

function recordInputCaret() {
  if (!els.input || state.dictating || state.transcribing) return;
  if (typeof els.input.selectionStart === "number") {
    lastInputCaret.start = els.input.selectionStart;
    lastInputCaret.end = typeof els.input.selectionEnd === "number" ? els.input.selectionEnd : els.input.selectionStart;
    lastInputCaret.tracked = true;
  }
}

for (const ev of ["input", "keyup", "mouseup", "touchend", "select", "focus"]) {
  els.input.addEventListener(ev, recordInputCaret, { passive: true });
}

function captureDictationCaret() {
  const len = els.input ? els.input.value.length : 0;
  if (document.activeElement === els.input && typeof els.input.selectionStart === "number") {
    dictationCaretStart = Math.min(els.input.selectionStart, len);
    dictationCaretEnd = Math.min(typeof els.input.selectionEnd === "number" ? els.input.selectionEnd : dictationCaretStart, len);
  } else if (lastInputCaret.tracked) {
    dictationCaretStart = Math.min(lastInputCaret.start, len);
    dictationCaretEnd = Math.min(lastInputCaret.end, len);
  } else {
    dictationCaretStart = len;
    dictationCaretEnd = len;
  }
}

function formatCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.min(60, Math.ceil(remainingMs / 1000)));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function updateDictationTimer() {
  if (!state.dictating) return;
  const remaining = Math.max(0, dictationDeadline - performance.now());
  const secLeft = Math.ceil(remaining / 1000);
  if (els.dictateTimer) {
    els.dictateTimer.textContent = formatCountdown(remaining);
    els.dictateTimer.classList.toggle("warn", secLeft <= 15 && secLeft > 5);
    els.dictateTimer.classList.toggle("crit", secLeft <= 5);
  }
  if (remaining <= 0) {
    stopDictation(false); // 1-minute max reached: auto-stop and insert
  }
}

function startVisualizer(stream) {
  stopVisualizer();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !els.dictateViz) return;
    dictationAudioCtx = new AudioCtx();
    if (dictationAudioCtx.state === "suspended") {
      void dictationAudioCtx.resume().catch(() => {});
    }
    dictationSource = dictationAudioCtx.createMediaStreamSource(stream);
    dictationAnalyser = dictationAudioCtx.createAnalyser();
    dictationAnalyser.fftSize = 64;
    dictationAnalyser.smoothingTimeConstant = 0.72;
    dictationSource.connect(dictationAnalyser);

    const freqData = new Uint8Array(dictationAnalyser.frequencyBinCount);
    const bars = els.dictateViz.querySelectorAll(".vbar");
    const bins = [1, 2, 4, 7, 12];

    const tick = () => {
      if (!state.dictating || !dictationAnalyser) return;
      dictationAnalyser.getByteFrequencyData(freqData);
      for (let i = 0; i < bars.length; i++) {
        const val = freqData[bins[i] || i] || 0;
        const h = Math.max(4, Math.min(22, Math.round(4 + (val / 255) * 18)));
        bars[i].style.height = `${h}px`;
      }
      dictationRafId = requestAnimationFrame(tick);
    };
    dictationRafId = requestAnimationFrame(tick);
  } catch {
    /* Web Audio visualizer is non-critical */
  }
}

function stopVisualizer() {
  if (dictationRafId) {
    cancelAnimationFrame(dictationRafId);
    dictationRafId = 0;
  }
  if (els.dictateViz) {
    for (const bar of els.dictateViz.querySelectorAll(".vbar")) {
      bar.style.height = "4px";
    }
  }
  try {
    if (dictationSource) dictationSource.disconnect();
  } catch {}
  dictationSource = null;
  try {
    if (dictationAnalyser) dictationAnalyser.disconnect();
  } catch {}
  dictationAnalyser = null;
  if (dictationAudioCtx) {
    try {
      if (dictationAudioCtx.state !== "closed") void dictationAudioCtx.close().catch(() => {});
    } catch {}
    dictationAudioCtx = null;
  }
}

function releaseDictationMedia() {
  if (dictationTimerId) {
    clearInterval(dictationTimerId);
    dictationTimerId = 0;
  }
  stopVisualizer();
  if (dictationStream) {
    for (const track of dictationStream.getTracks()) {
      try { track.stop(); } catch {}
    }
    dictationStream = null;
  }
}

function syncDictationUi() {
  const row = els.input ? els.input.closest(".row") : null;
  const active = Boolean(state.dictating || state.transcribing);
  if (row) row.classList.toggle("dictating", active);
  if (els.dictateHud) {
    els.dictateHud.hidden = !active;
    els.dictateHud.classList.toggle("transcribing", Boolean(state.transcribing));
  }
  if (els.micBtn) {
    els.micBtn.classList.toggle("recording", Boolean(state.dictating));
    els.micBtn.classList.toggle("transcribing", Boolean(state.transcribing));
    const label = state.dictating ? "Stop dictation" : state.transcribing ? "Transcribing…" : "Dictate";
    els.micBtn.setAttribute("aria-label", label);
    els.micBtn.title = label;
  }
  if (els.micIcon) els.micIcon.toggleAttribute("hidden", Boolean(state.dictating));
  if (els.micStopIcon) els.micStopIcon.toggleAttribute("hidden", !state.dictating);
  updateComposer();
  autosize();
}

function insertDictatedText(rawText) {
  const clean = (rawText || "").trim();
  if (!clean || !els.input) return;
  const val = els.input.value;
  const start = Math.max(0, Math.min(dictationCaretStart, val.length));
  const end = Math.max(start, Math.min(dictationCaretEnd, val.length));
  const before = val.slice(0, start);
  const after = val.slice(end);

  const tail = (after.length > 0 && !/^\s/.test(after) && !/^[.,!?;:)\]}]/.test(after)) ? " " : "";
  const inserted = clean + tail;

  els.input.value = before + inserted + after;
  const newPos = start + inserted.length;
  lastInputCaret.start = newPos;
  lastInputCaret.end = newPos;
  lastInputCaret.tracked = true;
  try {
    els.input.setSelectionRange(newPos, newPos);
  } catch {}
  autosize();
  updateComposer();
  els.input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function startDictation() {
  if (!isDictationSupported()) {
    showToast("Microphone recording is not supported in this browser.", "error");
    return;
  }
  if (state.dictating || state.transcribing || state.resettingMain || state.composerLocked) return;
  captureDictationCaret();
  dictationDiscarded = false;
  dictationSendAfter = false;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showToast("Microphone access denied or unavailable.", "error");
    return;
  }

  dictationStream = stream;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/wav",
  ];
  const mimeType = candidates.find((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) || "";

  try {
    dictationRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    releaseDictationMedia();
    showToast("Could not start audio recorder.", "error");
    return;
  }

  dictationChunks = [];
  dictationRecorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) dictationChunks.push(e.data);
  });

  dictationRecorder.addEventListener("stop", async () => {
    const recMime = (dictationRecorder && dictationRecorder.mimeType) || mimeType || "audio/webm";
    dictationRecorder = null;
    releaseDictationMedia();

    if (dictationDiscarded) {
      dictationChunks = [];
      state.dictating = false;
      state.transcribing = false;
      syncDictationUi();
      return;
    }

    const blob = new Blob(dictationChunks, { type: recMime });
    dictationChunks = [];
    if (!blob || blob.size < 100) {
      state.dictating = false;
      state.transcribing = false;
      syncDictationUi();
      return;
    }

    state.dictating = false;
    state.transcribing = true;
    if (els.dictateTimer) {
      els.dictateTimer.textContent = "…";
      els.dictateTimer.classList.remove("warn", "crit");
    }
    syncDictationUi();

    const shouldSend = dictationSendAfter;
    dictationSendAfter = false;

    try {
      const res = await api("/api/plugins/hermes-mini/dictate", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      state.transcribing = false;
      syncDictationUi();

      if (!res || res.ok === false) {
        const msg = (res && res.error) || "Dictation failed.";
        showToast(msg, "error");
        return;
      }

      const text = (res.text || "").trim();
      if (text) {
        insertDictatedText(text);
        if (shouldSend) {
          if (els.input.value.trim() || state.attachments.length) {
            void send();
          }
        } else {
          els.input.focus();
          try {
            els.input.setSelectionRange(lastInputCaret.start, lastInputCaret.end);
          } catch {}
        }
      } else if (!shouldSend) {
        els.input.focus();
      }
    } catch (err) {
      state.transcribing = false;
      syncDictationUi();
      showToast(`Dictation failed: ${errorText(err)}`, "error");
    }
  });

  state.dictating = true;
  state.transcribing = false;
  dictationDeadline = performance.now() + DICTATE_MAX_MS;
  if (els.dictateTimer) {
    els.dictateTimer.textContent = "1:00";
    els.dictateTimer.classList.remove("warn", "crit");
  }
  els.input.blur();
  syncDictationUi();
  startVisualizer(stream);

  dictationRecorder.start();
  dictationTimerId = setInterval(updateDictationTimer, 200);
}

function stopDictation(andSend = false) {
  if (!state.dictating || !dictationRecorder) return;
  dictationSendAfter = Boolean(andSend);
  dictationDiscarded = false;
  if (dictationTimerId) {
    clearInterval(dictationTimerId);
    dictationTimerId = 0;
  }
  try {
    if (dictationRecorder.state !== "inactive") dictationRecorder.stop();
  } catch {
    releaseDictationMedia();
    state.dictating = false;
    syncDictationUi();
  }
}

function cancelDictation(silent = false) {
  if (!state.dictating && !dictationRecorder) return;
  dictationDiscarded = true;
  dictationSendAfter = false;
  if (dictationTimerId) {
    clearInterval(dictationTimerId);
    dictationTimerId = 0;
  }
  try {
    if (dictationRecorder && dictationRecorder.state !== "inactive") {
      dictationRecorder.stop();
    } else {
      releaseDictationMedia();
      state.dictating = false;
      state.transcribing = false;
      syncDictationUi();
    }
  } catch {
    releaseDictationMedia();
    state.dictating = false;
    state.transcribing = false;
    syncDictationUi();
  }
  if (!silent) {
    try {
      els.input.focus();
      els.input.setSelectionRange(dictationCaretStart, dictationCaretEnd);
    } catch {}
  }
}

// ---------- wiring ----------

if (els.micBtn) {
  // Hide only on a definite no: this browser cannot record. The server-side probe decides the other half
  // (no configured speech-to-text provider) via identity.js loadStatus(), which runs before first paint of
  // the composer; the /dictate route stays the real gate either way.
  if (!isDictationSupported()) {
    els.micBtn.hidden = true;
  } else {
    els.micBtn.addEventListener("pointerdown", (event) => {
      if (!state.dictating && !state.transcribing) {
        captureDictationCaret();
      }
      event.preventDefault();
    });
    els.micBtn.addEventListener("click", () => {
      if (state.dictating) stopDictation(false);
      else if (!state.transcribing) void startDictation();
    });
  }
}

if (els.dictateCancel) {
  els.dictateCancel.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });
  els.dictateCancel.addEventListener("click", () => {
    cancelDictation(false);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.dictating) {
    event.preventDefault();
    event.stopPropagation();
    cancelDictation(false);
  }
}, true);

els.send.addEventListener("pointerdown", (event) => {
  if (state.dictating) {
    event.preventDefault();
  }
});

els.send.addEventListener("click", (event) => {
  if (state.dictating) {
    event.preventDefault();
    event.stopPropagation();
    stopDictation(true); // Record + Send!
    return;
  }
  void send();
});

els.input.addEventListener("input", () => {
  autosize();
  if (state.streaming) updateComposer(); // Stop ⇄ Send as text appears or is cleared
});
// ---------- composer Enter key ----------
// A virtual-first device (a phone or tablet: no fine pointer) starts in virtual-keyboard mode: Enter is a newline and
// only the send button sends. Every other device, including a PC with a touchscreen (it has a mouse or touchpad), starts
// in physical-keyboard mode: Enter sends and Shift+Enter is a newline. On a virtual-first device the mode switches live:
// a real printable key (a Bluetooth keyboard) switches to physical, and an IME keydown (keyCode 229 or "Unidentified",
// which is how an on-screen keyboard types) switches back to virtual. The mode lives in memory only, never in storage.
const VIRTUAL_FIRST = !window.matchMedia("(any-pointer: fine)").matches;
let physicalKeys = !VIRTUAL_FIRST;

function trackKeyboard(event) {
  if (typeof event.key === "string" && event.key.length === 1) physicalKeys = true;
  else if (VIRTUAL_FIRST && (event.isComposing || event.keyCode === 229 || event.key === "Unidentified")) physicalKeys = false;
}

// Enter sends only when there is something to send and no reply is streaming (Enter would otherwise stop the reply).
function canSendNow() {
  return Boolean(els.input.value.trim() || state.attachments.length) && !state.streaming && !state.sending;
}

els.input.addEventListener("keydown", (event) => {
  trackKeyboard(event);
  // An IME is mid-composition (or the key is an IME key, keyCode 229): never send.
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  // Virtual-keyboard mode, Shift+Enter, or Ctrl/Meta/Alt+Enter: leave it to the default (a newline).
  if (!physicalKeys || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  // A reply is streaming: Enter steers it with the typed text, and never adds a stray newline.
  if (state.streaming || state.sending) {
    event.preventDefault();
    if (state.streaming && !state.sending && els.input.value.trim()) void steer();
    return;
  }
  if (!canSendNow()) return; // nothing to send yet: the default newline
  event.preventDefault();
  void send();
});

// "+" opens a small menu: Photos (accept="image/*", which makes Android Chrome open the system photo
// picker sheet) and Files (accept="application/octet-stream": opens the file manager directly with every type selectable,
// see index.html). Each item's click is a user
// activation, so it can open its file dialog directly.
const photoInput = document.getElementById("photo");
const attachMenu = document.getElementById("attachMenu");
function setMenu(open) {
  attachMenu.hidden = !open;
  els.attach.classList.toggle("open", open);
  els.attach.setAttribute("aria-expanded", String(open));
}
els.attach.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenu(attachMenu.hidden);
});
const cameraInput = document.getElementById("camera");
document.getElementById("takePhoto").addEventListener("click", () => {
  setMenu(false);
  cameraInput.click();
});
document.getElementById("pickPhoto").addEventListener("click", () => {
  setMenu(false);
  photoInput.click();
});
document.getElementById("pickFile").addEventListener("click", () => {
  setMenu(false);
  els.file.click();
});
document.addEventListener("click", (event) => {
  if (!attachMenu.hidden && !attachMenu.contains(event.target)) setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !attachMenu.hidden) setMenu(false);
});
for (const input of [cameraInput, photoInput, els.file]) {
  input.addEventListener("change", () => {
    addFiles(input.files || []);
    input.value = "";
  });
}


els.editCancel.addEventListener("click", () => cancelEdit());
// Escape ends an edit, unless the drawer, a row menu, the rename dialog or the attach menu is open: those handle Escape.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.editing || state.sending) return;
  const overlayOpen = $("drawer").classList.contains("open") || $("rowMenu").classList.contains("open")
    || $("renameDialog").classList.contains("open") || !attachMenu.hidden;
  if (!overlayOpen) cancelEdit();
});

// Appearance: System / Light / Dark from the switch at the bottom of the chats panel. "system"
// clears data-theme so the prefers-color-scheme rules apply; the choice is a per-device convenience in localStorage.
// index.html applies a saved choice before first paint.
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.dataset.theme = choice;
  else delete root.dataset.theme;
  const dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.content = choice === "light" || choice === "dark" ? (dark ? "#111214" : "#f5f5f7") : meta.media.includes("dark") ? "#111214" : "#f5f5f7";
  }
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.themeChoice === choice));
  }
}
let themeChoice = "system";
try {
  const saved = localStorage.getItem("hermesMiniTheme");
  if (saved === "light" || saved === "dark") themeChoice = saved;
} catch {
  // storage blocked: follow the system
}
applyTheme(themeChoice);
for (const button of document.querySelectorAll("[data-theme-choice]")) {
  button.addEventListener("click", () => {
    themeChoice = button.dataset.themeChoice;
    try {
      if (themeChoice === "system") localStorage.removeItem("hermesMiniTheme");
      else localStorage.setItem("hermesMiniTheme", themeChoice);
    } catch {
      // storage blocked: the choice lasts for this visit
    }
    applyTheme(themeChoice);
  });
}

// Docked layout: a wide window with a mouse gets three panes - the chats column on the left, the chat in
// the middle and the computer on the right. Phones and narrow windows keep the off-canvas drawer and the
// full-screen computer exactly as before. The modules receive isDocked through their deps so they never
// import this file.
const dockedQuery = window.matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)");
// With the computer open, the chats column stays only while there is room for all three panes: the 300px
// chats column, a readable chat (THREE_PANE_CHAT_MIN) and the computer's minimum (PANE_W_MIN). The state is
// dynamic: dragging the seam to enlarge the computer past the chat's minimum hides the column even on a wide
// window, freeing its 300px for the computer. app.js toggles body.computer-three-pane and CSS follows it.
const isDocked = () => dockedQuery.matches;

// The chats drawer (menu button, list, Pinned group, row menu) lives in drawer.js. It reads state through these
// callbacks and never changes threads by itself.
// The computer is the plugin's own optional module, loaded on first use: opening chat must never import it,
// so a missing or unfinished desktop cannot stop the app shell from installing. The controller is a thin
// proxy that queues nothing and simply no-ops until the module arrives.
const botScreen = {
  ready: null,
  isOpen: () => Boolean(botScreen.ready && botScreen.ready.isOpen()),
  open: () => ensureBotScreen().then((screen) => screen.open()),
  close: () => (botScreen.ready ? botScreen.ready.close() : Promise.resolve()),
  dockedChanged: (docked) => botScreen.ready?.dockedChanged(docked),
  onDisplayEvent: (type, payload) => botScreen.ready?.onDisplayEvent(type, payload),
  onRpcReady: () => botScreen.ready?.onRpcReady(),
  onRpcDisconnected: () => botScreen.ready?.onRpcDisconnected(),
};

function botScreenDeps() {
  return {
    rpc,
    isDocked,
    agentName: AGENT,
    // While a reply is streaming, an automatic take-over would refuse the agent's very next keystroke, so
    // the viewer asks first (a toast, then the next tap goes through).
    isAgentBusy: () => Boolean(state.streaming),
    getConnection: () => ({
      ready: Boolean(state.wsReady && state.ws && state.ws.readyState === WebSocket.OPEN),
      epoch: state.connectionEpoch,
    }),
  };
}

let botScreenLoading = null;
function ensureBotScreen() {
  if (botScreen.ready) return Promise.resolve(botScreen.ready);
  if (!botScreenLoading) {
    botScreenLoading = import("./computer/screen.js")
      .then(({ createBotScreen }) => {
        botScreen.ready = createBotScreen(botScreenDeps());
        return botScreen.ready;
      })
      .catch((error) => {
        botScreenLoading = null;
        showToast("The computer is unavailable right now", "error");
        throw error;
      });
  }
  return botScreenLoading;
}

// Docked: the Computer button is a toggle (a second click closes the pane). Otherwise it only opens.
els.screenBtn.addEventListener("click", () => {
  if (!botScreen.ready) {
    void ensureBotScreen().then(() => botScreen.open()).catch(() => {});
    return;
  }
  if (isDocked() && botScreen.isOpen()) void botScreen.close();
  else void botScreen.open();
});

// ---------- Inbox: read by seeing it in chat ----------
// The Inbox has its own per-message read tracker; these marks are the ONLY thing that writes to it, and the drawer's
// seen.json is never touched. A row counts as seen once 60% of it has been on screen for 600 ms; batches go out after
// about a second, so a fast scroll is one small POST instead of one per bubble.
const INBOX_READ_API = "/api/plugins/hermes-mini/inbox/read";
const INBOX_VISIBLE_RATIO = 0.6;
const INBOX_VISIBLE_MS = 600;
const INBOX_BATCH_MS = 1000;
const inboxReadIds = new Set();
const inboxRowTimers = new WeakMap();
const inboxSeenRows = new Set(); // message ids already handed to the Inbox tracker (ids, not elements: a Set)
let inboxReadTimer = 0;

function flushInboxReads() {
  inboxReadTimer = 0;
  if (!inboxReadIds.size) return;
  const ids = [...inboxReadIds];
  inboxReadIds.clear();
  api(INBOX_READ_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  }).then(() => inbox.refreshBadge()).catch(() => {});
}

function markInboxRead(rowId, { immediate = false } = {}) {
  if (!Number.isInteger(rowId) || inboxSeenRows.has(rowId)) return;
  inboxSeenRows.add(rowId);
  inboxReadIds.add(rowId);
  if (immediate) {
    clearTimeout(inboxReadTimer);
    flushInboxReads();
    return;
  }
  clearTimeout(inboxReadTimer);
  inboxReadTimer = setTimeout(flushInboxReads, INBOX_BATCH_MS);
}

// The newest agent bubble on screen when a chat opens (job results included: they are agent-side rows too).
function markInboxNewest() {
  if (state.readOnly) return;
  const rows = els.log.querySelectorAll(".msg.assistant");
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const id = rows[at].hermesMiniMsg && rows[at].hermesMiniMsg.rowId;
    if (Number.isInteger(id) && id > 0) {
      markInboxRead(id);
      return;
    }
  }
}

const inboxRowObserver = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const row = entry.target;
      const id = row.hermesMiniMsg && row.hermesMiniMsg.rowId;
      if (!Number.isInteger(id) || id <= 0) {
        continue;
      }
      if (entry.isIntersecting && entry.intersectionRatio >= INBOX_VISIBLE_RATIO) {
        if (inboxSeenRows.has(id) || inboxRowTimers.has(row)) continue;
        const timer = setTimeout(() => {
          inboxRowTimers.delete(row);
          if (row.isConnected) markInboxRead(id);
        }, INBOX_VISIBLE_MS);
        inboxRowTimers.set(row, timer);
      } else if (inboxRowTimers.has(row)) {
        clearTimeout(inboxRowTimers.get(row));
        inboxRowTimers.delete(row);
      }
    }
  }, { root: els.log, threshold: [0, INBOX_VISIBLE_RATIO] })
  : null;

function watchInboxRow(row) {
  if (inboxRowObserver) inboxRowObserver.observe(row);
}

// The to-do panel: its own data, kept by the plugin (todo.js owns the dialog and the history
// entry). The badge is filled at startup and whenever the app comes back to the foreground.
const todo = createTodo({ api });
// The Inbox panel: the app's own messages, read from the sessions on every open; inbox.js owns the
// dialog, the feed, the read marks and its history entry.
const inbox = createInbox({
  api,
  formatTime: messageTimeLabel, // the same "3:16 PM" / "Nov 4, 3:16 PM" the chat bubbles show
  isPhone: () => window.matchMedia("(max-width: 640px)").matches,
  openMessage: (sessionId, messageId) => openTarget(sessionId, { messageId, match: "", ts: 0 }),
});
// The two panels close each other, waiting for the first one's history entry so the two never race.
els.todoBtn.addEventListener("click", () => {
  void inbox.close().then(() => todo.open());
});
// the agent's photo and name are the Inbox's button: a tap opens it, a second tap closes it.
const toggleInbox = () => {
  if (inbox.isOpen()) void inbox.close();
  else void todo.close().then(() => inbox.open());
};
els.inboxBtn.addEventListener("click", toggleInbox);
els.inboxBtn.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleInbox();
});
void todo.refresh();
void inbox.refreshBadge();

// The chats panel is a column whenever the window is docked: always with the computer closed, and with it open only
// while app.js has decided all three panes still fit. Otherwise it tucks away and the hamburger brings it back as an
// overlay, like on a phone.
const drawerDocked = () => isDocked()
  && (!document.body.classList.contains("computer-docked")
      || document.body.classList.contains("computer-three-pane"));
const drawerApi = createDrawer({
  api,
  isDocked: drawerDocked,
  homeId: () => state.homeId,
  viewedId: () => state.viewedId,
  onSelect: (id) => switchSession(id),
  onNewChat: () => newChat(),
  rename: (item, title) => renameSession(item, title),
  delete: (item) => deleteSession(item),
  resetMainChat: (item) => resetMainChat(item),
  pin: (item, pinned) => pinSession(item, pinned),
});

// In docked mode the chat list never closes, so it has to stay current on its own: refresh it after a reply finishes
// and after switching chats (new titles and new chats appear without reopening anything).
function refreshDockedDrawer() {
  if (!isDocked()) return;
  void drawerApi.refresh();
}

// The drawer's list is on screen (docked, or open on a phone), so new activity should show up as unread dots without
// the person reopening it. Only refreshes rows: a push never marks anything seen by itself.
function refreshDrawerActivity() {
  if (drawerApi.isOpen()) void drawerApi.refresh();
}

// Working chats pulse in the list. While the list is on screen and the page visible, ask the
// gateway every 3 s which live sessions are mid-turn (session.active_list: working, starting, or waiting on an
// approval) and hand their stored ids to the drawer. The chat on screen also counts while it streams.
const BUSY_POLL_MS = 3000;
let busyPollBusy = false;
async function pollBusyChats() {
  if (busyPollBusy || document.hidden || !drawerApi.isOpen()) return;
  busyPollBusy = true;
  try {
    const ids = new Set();
    if (state.streaming && state.viewedId) ids.add(state.viewedId);
    const result = await rpc("session.active_list", {});
    for (const item of (result && result.sessions) || []) {
      if (item.status && item.status !== "idle" && item.session_key) ids.add(item.session_key);
    }
    drawerApi.setBusy(ids);
  } catch {
    /* offline or reconnecting: keep the last known state until the next poll */
  } finally {
    busyPollBusy = false;
  }
}
setInterval(pollBusyChats, BUSY_POLL_MS);

// ---------- Notifications ----------
// A notification tap or an Approve/Deny button arrives from the service worker (sw.js). The page owns chat
// switching, so the worker posts a message when a window is already open and otherwise opens ?#session=<id>.

const pushBtn = $("pushBtn");
const PUSH_API = "/api/plugins/hermes-mini";
let pushNoteTimer = 0;

async function openPushedSession(id) {
  if (!id) return;
  await waitForSwitch();
  if (id === state.homeId) {
    // The home thread is already loaded on most launches; only switch when another chat is on screen.
    if (state.viewedId !== state.homeId) await switchSession(state.homeId);
    return;
  }
  await switchSession(id);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    refreshDrawerActivity(); // a push means new activity: refresh the list (never mark it read)
    if (data.type === "hermes-mini-job") {
      void syncJobDeliveries();
      return;
    }
    if (data.type !== "hermes-mini-open-session") return;
    void openTarget(data.session_id, targetFrom(data));
  });
}

// A notification opened a fresh window with #session=<id> (and #msg/#match/#ts when the push knew its message): open
// that chat once the socket and home thread are attached, then drop the hash so a reload goes back to the remembered view.
async function openSessionFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const id = params.get("session");
  if (!id) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (!state.wsReady) return;
  await openTarget(id, targetFrom({
    msg: params.get("msg") ?? undefined,
    match: params.get("match") || "",
    ts: params.get("ts") || 0,
  }));
}

function base64UrlToBytes(value) {
  const normal = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function setPushState(on) {
  if (!pushBtn) return;
  const label = on ? "Notifications on" : "Notifications off";
  pushBtn.setAttribute("aria-pressed", on ? "true" : "false");
  pushBtn.title = label;
  pushBtn.setAttribute("aria-label", label);
}

// Notes use the chats panel's own note line, the same place the drawer reports failures.
function pushNote(text) {
  const noteEl = $("drawerNote");
  if (!noteEl) return;
  noteEl.textContent = text || "";
  clearTimeout(pushNoteTimer);
  if (text) pushNoteTimer = setTimeout(() => { noteEl.textContent = ""; }, 8000);
}

async function refreshPushState() {
  if (!pushBtn) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    setPushState(Boolean(subscription));
  } catch {
    setPushState(false);
  }
}

async function enablePush() {
  // requestPermission() must run inside the click handler; everything else waits behind it.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    pushNote("Notifications are blocked in your browser settings.");
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  // Read first: if the key already exists, reuse it. Only the person's explicit opt-in creates one.
  let { key } = await api(`${PUSH_API}/push/key`);
  if (!key) ({ key } = await api(`${PUSH_API}/push/key`, { method: "POST" }));
  if (!key) throw new Error("notifications are unavailable on the server");
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(key),
  });
  await api(`${PUSH_API}/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  await api(`${PUSH_API}/push/test`, { method: "POST" });
  setPushState(true);
}

async function disablePush() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await api(`${PUSH_API}/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  }
  setPushState(false);
}

if (pushBtn) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    pushBtn.hidden = true; // no Web Push here: the bell would be a dead button
  } else {
    pushBtn.addEventListener("click", async () => {
      const turningOff = pushBtn.getAttribute("aria-pressed") === "true";
      const proceed = await confirmDialog(turningOff
        ? { title: "Turn off notifications?", message: `This device stops getting ${AGENT}'s notifications.`, confirmLabel: "Turn off" }
        : { title: "Turn on notifications?", message: `This device gets a notification when ${AGENT} replies or needs you.`, confirmLabel: "Turn on" });
      if (!proceed) return;
      pushBtn.disabled = true;
      try {
        if (turningOff) await disablePush();
        else await enablePush();
      } catch (error) {
        pushNote(`Could not change notifications: ${errorText(error)}.`);
      } finally {
        pushBtn.disabled = false;
      }
    });
    void refreshPushState();
    // The capability probe may still be in flight when this block runs; identity.js reports its result
    // through this event. A definite "no" hides the bell; anything else leaves the browser check above.
    document.addEventListener("hermes-mini-capabilities", (event) => {
      const detail = event && event.detail ? event.detail : {};
      if (detail.push === false) pushBtn.hidden = true;
      if (detail.computer === false && els.screenBtn) els.screenBtn.hidden = true;
      if (detail.dictation === false && els.micBtn && isDictationSupported()) els.micBtn.hidden = true;
    });
  }
}

// Gateway restart: confirm, ask the server to restart it detached, then watch the gateway state
// until a new process is running. Green toast when it is back, red if it is not back within 90 s.
const restartBtn = $("restartBtn");
if (restartBtn) {
  restartBtn.addEventListener("click", async () => {
    if (restartBtn.classList.contains("busy")) return;
    let status = { active_agents: 0 };
    try {
      status = await api("/api/plugins/hermes-mini/gateway/status");
    } catch {
      /* unknown: the confirm still asks */
    }
    const busy = Number(status.active_agents) || 0;
    const proceed = await confirmDialog({
      title: `Restart ${AGENT}?`,
      message: busy
        ? `${busy} reply${busy === 1 ? " is" : "s are"} in progress and will be cut off. ${AGENT} pauses for a few seconds.`
        : `${AGENT} pauses for a few seconds while it restarts.`,
      confirmLabel: "Restart",
      danger: busy > 0,
    });
    if (!proceed) return;
    restartBtn.classList.add("busy");
    restartBtn.disabled = true;
    try {
      const res = await api("/api/plugins/hermes-mini/gateway/restart", { method: "POST" });
      showToast("Restarting…");
      // The button restarts the gateway and then the dashboard (plugin_api.py _RESTART_ALL): done when both report a
      // new pid. Reads fail while the dashboard is down; the loop just waits.
      const before = res.pid_before;
      const dashBefore = res.dashboard_pid_before;
      const deadline = Date.now() + 150_000;
      let back = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        try {
          const now = await api("/api/plugins/hermes-mini/gateway/status");
          if (now.state === "running" && now.pid && now.pid !== before && (!dashBefore || (now.dashboard_pid && now.dashboard_pid !== dashBefore))) {
            back = true;
            break;
          }
        } catch {
          /* the dashboard is restarting too; a failed read just waits for the next one */
        }
      }
      showToast(back ? "Restarted" : "Restart didn't finish", back ? "success" : "error");
    } catch (error) {
      showToast(error && error.status === 429 ? "A restart was just requested" : "Couldn't restart", "error");
    } finally {
      restartBtn.classList.remove("busy");
      restartBtn.disabled = false;
    }
  });
}

// Crossing the breakpoint live: the drawer drops its overlay state (scrim, inert, history entry) and becomes a
// column, or returns to the closed off-canvas drawer; the computer pane re-slots if it is open. layoutEmpty keeps the
// empty-chat greeting centred now that .app changed width without a window resize.
function applyDockedLayout() {
  const docked = dockedQuery.matches;
  document.body.classList.toggle("docked", docked);
  // A window or docked-layout change re-evaluates the default fit; a deliberate seam drag can still hide
  // the chats column afterwards.
  wantThreePane = true;
  applyThreePane();
  botScreen.dockedChanged(docked);
  // Keep the seam width inside the new limits instead of letting the pane spill past the window. With no
  // saved width yet, clamp the 440px default so the three-pane chat is at least THREE_PANE_CHAT_MIN.
  setChatWidth(currentChatWidth());
  if (state.viewedEmpty) layoutEmpty();
}

// Drag the seam between the chat and the docked computer to resize them. The chat keeps at least
// 320px and the computer at least 420px; the width is a per-device convenience in localStorage.
const CHAT_W_MIN = 320;
// Three panes only make sense when the chat itself stays readable; below this the chats column hides.
const THREE_PANE_CHAT_MIN = 600;
const PANE_W_MIN = 420;
// The chats column keeps its 300px only while it is actually beside an open computer; otherwise the chat
// starts at the window edge and the seam offset is zero.
const drawerOffset = () => (document.body.classList.contains("computer-docked") && drawerDocked() ? 300 : 0);
function setChatWidth(px) {
  // Whenever the computer is open the chat keeps its readable minimum, even after the chats column tucks
  // away; the computer takes whatever is left but never below its own minimum.
  const min = document.body.classList.contains("computer-docked") ? THREE_PANE_CHAT_MIN : CHAT_W_MIN;
  const max = Math.max(min, window.innerWidth - PANE_W_MIN - drawerOffset());
  const width = Math.round(Math.min(Math.max(px, min), max));
  document.documentElement.style.setProperty("--chat-w", `${width}px`);
  return width;
}
const currentChatWidth = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-w")) || 440;

// Three panes need the 300px chats column, a readable chat and the computer's minimum. The user can also
// drag the seam past the chat's minimum: that hides the chats column and hands its 300px to the computer.
let wantThreePane = true;
let drawerWasDocked = null;
let wasComputerDocked = document.body.classList.contains("computer-docked");

function threePaneAllowed() {
  if (!isDocked() || !document.body.classList.contains("computer-docked")) return false;
  // If the panel is hidden, showing it takes 300px from the chat; test the width the chat would have
  // afterwards, not the wider hidden chat.
  const panelOn = document.body.classList.contains("computer-three-pane");
  const chat = Math.max(currentChatWidth() - (panelOn ? 0 : 300), THREE_PANE_CHAT_MIN);
  return window.innerWidth >= 300 + chat + PANE_W_MIN;
}

function applyThreePane() {
  const wasOn = document.body.classList.contains("computer-three-pane");
  const seam = drawerOffset() + currentChatWidth();
  const on = wantThreePane && threePaneAllowed();
  if (wasOn !== on) document.body.classList.toggle("computer-three-pane", on);
  // Showing or hiding the column changes the chat's left edge, not its right edge (the seam). With the
  // computer open, hand the 300px to/from the chat so the seam stays exactly where it was.
  if (on !== wasOn && document.body.classList.contains("computer-docked")) {
    setChatWidth(seam - drawerOffset());
  }
  const now = drawerDocked();
  if (now !== drawerWasDocked) {
    drawerWasDocked = now;
    drawerApi.dockedChanged(now);
  }
}
try {
  const saved = Number(localStorage.getItem("hermesMiniChatWidth"));
  if (saved) setChatWidth(saved);
} catch {
  // storage blocked: the default width
}
{
  const split = document.getElementById("paneSplit");
  let drag = null;
  split.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    split.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId };
    document.body.classList.add("pane-resizing");
  });
  split.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    // The seam is the chat's right edge. The panel only changes the chat's left edge, so the seam stays
    // under the pointer: hiding the panel grows the chat to the left, showing it shrinks the chat back.
    const boundary = Math.round(event.clientX);
    const hadPanel = drawerOffset() > 0;
    if (hadPanel && boundary < 300 + THREE_PANE_CHAT_MIN) {
      wantThreePane = false;
      applyThreePane();
    } else if (!hadPanel
               && window.innerWidth >= 300 + THREE_PANE_CHAT_MIN + PANE_W_MIN
               && boundary >= 300 + THREE_PANE_CHAT_MIN
               && window.innerWidth - boundary >= PANE_W_MIN) {
      wantThreePane = true;
      applyThreePane();
    }
    drag.width = setChatWidth(boundary - drawerOffset());
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    document.body.classList.remove("pane-resizing");
    try {
      if (drag.width) localStorage.setItem("hermesMiniChatWidth", String(drag.width));
    } catch {
      // storage blocked: the width lasts for this visit
    }
    drag = null;
  };
  split.addEventListener("pointerup", end);
  split.addEventListener("pointercancel", end);
  // A double click puts the default split back.
  split.addEventListener("dblclick", () => {
    document.documentElement.style.removeProperty("--chat-w");
    try {
      localStorage.removeItem("hermesMiniChatWidth");
    } catch {
      // storage blocked
    }
  });
  // A narrower window keeps both panes above their minimums, and a wider one can bring the chats column
  // back after it was hidden by dragging the computer wider.
  window.addEventListener("resize", () => {
    if (document.body.classList.contains("computer-docked")) wantThreePane = true;
    applyThreePane();
    setChatWidth(currentChatWidth());
  });
}

// The computer opening or closing (body.computer-docked) switches the chats panel between column and overlay.
// It also changes how much room the chat seam may take; opening a fresh computer starts from the default fit.
new MutationObserver(() => {
  const isOpen = document.body.classList.contains("computer-docked");
  if (isOpen !== wasComputerDocked) {
    wasComputerDocked = isOpen;
    wantThreePane = true;
  }
  applyThreePane();
  setChatWidth(currentChatWidth());
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

if (typeof dockedQuery.addEventListener === "function") dockedQuery.addEventListener("change", applyDockedLayout);
else if (typeof dockedQuery.addListener === "function") dockedQuery.addListener(applyDockedLayout); // older Safari
applyDockedLayout();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    // Leaving the app: what was on screen up to now was seen, wherever it came from (ghost-dot fix, 7 Nov 2026).
    if (state.viewedId) drawerApi.markSeen(state.viewedId);
    return;
  }
  // Back on the page: the chat on screen is read, and the list picks up activity that arrived meanwhile
  //.
  if (state.viewedId) drawerApi.markSeen(state.viewedId);
  refreshDrawerActivity();
  void todo.refresh(); // to-dos may have changed on another device while the app was away
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    state.backoffIdx = 0;
    noteOnline();
    void reconnect();
  } else {
    // Probe the socket now instead of waiting for the next heartbeat tick.
    const ws = state.ws;
    rpc("gateway.ping", {}, PING_TIMEOUT_MS).then(
      () => syncThread().then(refreshDockedDrawer).then(syncJobDeliveries).catch((error) => sysLine(`Could not refresh the chat: ${errorText(error)}`)),
      () => {
        if (ws) dropSocket(ws);
      },
    );
  }
});

window.addEventListener("online", () => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    state.backoffIdx = 0;
    noteOnline();
    void reconnect();
  }
});

const refreshEmptyLayout = () => {
  if (state.viewedEmpty) layoutEmpty();
  scheduleJumpUpdate();
};
window.addEventListener("resize", refreshEmptyLayout);
window.addEventListener("orientationchange", refreshEmptyLayout);
window.visualViewport?.addEventListener("resize", refreshEmptyLayout);
new ResizeObserver(refreshEmptyLayout).observe(composerEl);

updateComposer();
autosize();

// Boot: read the agent's identity and the feature flags first, so the page shows the user's own name and only
// the controls that work, then confirm we are signed in (a 401 redirects to the dashboard login), then connect
// and attach the thread. Identity is a pure read; the setup sheet it may open writes only on Save.
(async () => {
  try {
    identityApi.wire({
      onIdentity: ({ name, homeLabel }) => {
        AGENT = name || "Hermes";
        const meta = document.querySelector('meta[name="home-label"]');
        if (meta) meta.content = homeLabel || AGENT;
        applyAgentBranding();
        updateCaption();
        if (drawerApi && typeof drawerApi.setHomeLabel === "function") drawerApi.setHomeLabel(homeLabel || AGENT);
      },
    });
    await identityApi.boot();
    AGENT = identityApi.currentName();
  } catch {
    // Identity is best effort: the neutral defaults keep the page usable.
  }
  applyAgentBranding();
  // Status must already read "Connecting…" while the sign-in check runs: an empty status reads as "attached".
  try {
    await api("/api/sessions?limit=1");
  } catch (error) {
    if (error instanceof AuthRedirect) return;
    noteOffline();
    scheduleReconnect();
    return;
  }
  try {
    await connect();
    await attachThread();
    await openSessionFromHash(); // a notification may have opened this window on a specific chat
    state.backoffIdx = 0;
    noteOnline();
    setStatus("");
    refreshDockedDrawer(); // the home thread may have just been adopted: the docked list needs its home row
  } catch (error) {
    if (error instanceof AuthRedirect) return;
    if (state.ws) dropSocket(state.ws);
    noteOffline();
    scheduleReconnect();
  }
})();
