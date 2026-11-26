// Hermes Mini: mobile-first chat client for the Hermes dashboard. Vanilla ES module, no build step.
// Protocol mirrors web/src (gatewayClient.ts) and apps/shared (json-rpc-channel.ts, json-rpc-gateway.ts):
//  - WebSocket /api/ws?ticket=<single-use ticket from POST /api/auth/ws-ticket>
//  - newline-delimited JSON-RPC 2.0; event notifications have method "event"
//  - server->client requests (approval, clarify, password/secret/vault prompts) carry a string id and are answered with a response frame,
//    except clarify answers, which lock per question through clarify.lock, and approval, which uses approval.respond
//  - after gateway.ready the client advertises client.capabilities {server_requests: true}, otherwise the
//    backend treats it as an old client and fails approvals and clarify immediately

import { displayText, failureText, turnFailureText } from "./message-policy.js";
import { localImagePath, mediaTags } from "./media-path.js";
import { render as renderMarkdown, enhance, copyText, makeCopyButton, COPY_ICON } from "./md.js";
import { createDrawer, sourceLabel } from "./drawer.js";
import { confirmDialog } from "./confirm.js";
import { createTodo } from "./todo.js";
import { createSchedules, mentionText } from "./schedules.js";
import { createInbox } from "./inbox.js";
import { createBookmarks } from "./bookmarks.js";
import { createActivity } from "./activity.js";
import { createSearch } from "./search.js";
import { showToast, openPopover, closePopover, reopenPopover, showPersistentToast } from "./toast.js";
import * as identityApi from "./identity.js";
import { stripCronWrapper } from "./jobtext.js";
import { createModelPicker } from "./model.js";
import { createApprovalPicker } from "./approvals.js";
import * as clarifyFlow from "./clarify.js";
import { dictationInsert } from "./dictation-text.js";
import * as conn from "./connections.js";
import * as promptCards from "./prompts.js";
import { createIdentityEditor } from "./identity-edit.js";
import { createSlashPicker, describeSkillInvocation, skillLabel, skillSlug, SKILL_ICON } from "./slash.js";
import { takeShared, SHARE_PARAM } from "./share-target.js";

// The agent name is the user's own: identity.js reads it from the plugin's authenticated /status route,
// where the server has already applied "bot title, then display name, then named profile, then
// Hermes". Until that resolves the neutral "Hermes" is shown. The product name, which is what the
// installed app carries, stays "Hermes Mini" and is separate from the agent name.
let AGENT = "Hermes";

// The old internal title of the main chat. It is read once, only to migrate an install whose registry
// predates the recorded home id; the home itself is an id, never a name.
const THREAD_TITLE = "Hermes Mini";
const STORE_KEY = "hermesMiniStoredId"; // the recorded home chat id, as a fallback only
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
  bookmarkBtn: $("bookmarkBtn"),
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
  hiddenTurn: false, // the running turn is display_kind "hidden" (message.start): nothing of it is drawn
  stream: null, // the running turn's chunk cursor { turnId, segment, applied } (streamChunk)
  historyRows: [], // the rows the last loadHistory drew, oldest first (seedInflight checks them)
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
  mentions: [], // schedules and skill pills added to the draft: { token, tag, title, kind }. " Name" stays in the textarea (drawn as a pill) and
  //               becomes the full "[Schedule: … · job …]" tag on send, like a collapsed paste.
  sending: false,
  editing: null, // Edit & resend in progress: { row, saved } (see beginEdit)
  resettingMain: false, // a main-chat reset is between its confirmation and its finish
  composerLocked: false, // a reset deleted the old main but no replacement is attached: keep the composer disabled
  stoppedByUser: false, // true when the user pressed Stop on the current turn
};

// A draft model pick is guarded before the first send creates the chat.
const modelUi = createModelPicker({
  rpc: (method, params, timeoutMs) => rpc(method, params, timeoutMs),
  api,
  getSid: () => state.liveSid,
  isDraft: () => state.viewedUnsent && !state.liveSid,
  isBusy: () => state.streaming,
  confirmDialog,
  showToast,
  chip: $("modelChip"),
});

// The approval mode icon tab on the input pill's top edge, right of the model tab, and its sheet (approvals.js).
const approvalUi = createApprovalPicker({
  rpc: (method, params, timeoutMs) => rpc(method, params, timeoutMs),
  confirmDialog,
  showToast,
  chip: $("approvalChip"),
});

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
const COMP_GAP = 20; // px between the greeting box and the two-row composer card
const COMP_REF_H = 98; // single-line two-row composer height so multiline growth expands downward without shifting the avatar
const ID_SCALE = 1.5; // the identity block's size in the empty state
const AVATAR_PX = 64; // avatar layout size (.avatar width and height)
const AV_OVERHANG = (ID_SCALE - 1) * AVATAR_PX / 2; // px the scaled avatar rises above its layout box (16)
const PILL_DROP = 9; // px the name pill moves down in the centred state (CSS translateY); keeps the header overlap ratio (14px of 64px becomes 21px of 96px)
let greetTimer = 0;
let flyTimer = 0;
let lowerTimer = 0;

// Places the identity block, greeting and composer as one group centred in the chat pane.
// Rest geometry comes from .log's bottom edge and offset* layout values (not affected by transforms on .composer or .identity).
// The avatar is scaled by its own transform and the name pill is offset by CSS, so the block itself is not scaled.
// The greeting's horizontal centre is the reference, so the avatar lands exactly over it.
function layoutEmpty() {
  const topbar = identityEl.offsetParent; // .topbar (position absolute)
  const tb = topbar.getBoundingClientRect();
  const cb = emptyState.offsetParent; // .log, the greeting's containing block (position relative)
  const cbr = cb.getBoundingClientRect();
  const compH = composerEl.offsetHeight;
  const appBottom = cbr.bottom + compH;
  const vis = identityEl.offsetHeight + AV_OVERHANG + PILL_DROP; // visual group height (104)
  const gh = emptyState.offsetHeight;
  const totalH = vis + GREET_GAP + gh + COMP_GAP + COMP_REF_H;
  const groupTop = Math.max(tb.bottom + 8, tb.bottom + (appBottom - tb.bottom - totalH) * 0.38);
  const greetCx = cbr.left + cb.clientLeft + cb.clientWidth / 2;
  const restCx = tb.left + identityEl.offsetLeft + identityEl.offsetWidth / 2;
  const restTop = tb.top + identityEl.offsetTop;
  identityEl.style.setProperty("--id-dx", `${greetCx - restCx}px`);
  identityEl.style.setProperty("--id-dy", `${groupTop + AV_OVERHANG - restTop}px`);
  emptyState.style.top = `${groupTop + vis + GREET_GAP - cbr.top - cb.clientTop}px`;
  const targetCompTop = groupTop + vis + GREET_GAP + gh + COMP_GAP;
  composerEl.style.setProperty("--comp-dy", `${Math.min(0, targetCompTop - cbr.bottom)}px`);
}

function clearIdentityTimers() {
  clearTimeout(flyTimer);
  clearTimeout(lowerTimer);
}

// show: the greeting appears with the identity and composer centred. opts.lower: they animate from their chat positions
// (New chat from a chat with history; skipped under reduced motion).
// !show: opts.fly (first message in an empty chat): the greeting fades out over 250ms, the identity flies to the header
// and the composer returns to the bottom (skipped under reduced motion, which snaps). Otherwise everything snaps to rest.
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
    composerEl.classList.remove("flying");
    layoutEmpty();
    const animate = Boolean(opts.lower) && !reducedMotion();
    identityEl.classList.toggle("lowering", animate);
    composerEl.classList.toggle("lowering", animate);
    identityEl.classList.add("centred");
    composerEl.classList.add("centred");
    if (animate) lowerTimer = setTimeout(() => {
      identityEl.classList.remove("lowering");
      composerEl.classList.remove("lowering");
    }, 470);
    return;
  }
  if (opts.fly && !reducedMotion() && !emptyState.hidden) {
    emptyState.classList.add("leaving");
    greetTimer = setTimeout(() => {
      emptyState.hidden = true;
      emptyState.classList.remove("leaving");
    }, 250);
    identityEl.classList.remove("centred", "lowering");
    composerEl.classList.remove("centred", "lowering");
    identityEl.classList.add("flying");
    composerEl.classList.add("flying");
    flyTimer = setTimeout(() => {
      identityEl.classList.remove("flying");
      composerEl.classList.remove("flying");
    }, 700);
    return;
  }
  emptyState.hidden = true;
  identityEl.classList.remove("centred", "lowering", "flying");
  composerEl.classList.remove("centred", "lowering", "flying");
}

function clearLog({ keepDictation = false } = {}) {
  if (!keepDictation) cancelDictation(true);
  endEdit(); // a view reset ends an edit; the composer gets its draft back
  cancelJumpScroll(); // a jump never follows the view to another chat or a rebuilt history
  hideJumpButton(true);
  if (typeof activity !== "undefined") activity.clearLogState();
  els.log.replaceChildren(emptyState);
}

function lastLogBubbleRow() {
  const activeRow = state.turn ? state.turn.row : null;
  for (let node = els.log.lastElementChild; node; node = node.previousElementSibling) {
    if (node !== activeRow && node.classList.contains("msg") && node.hermesMiniMsg?.text) return node;
  }
  return null;
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

// One authenticated fetch for JSON and file downloads: same token, same 401 redirect, same error detail.
async function apiFetch(path, init = {}) {
  const token = await sessionToken();
  const res = await fetch(PREFIX + path, {
    credentials: "include",
    ...init,
    headers: {
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
    // Hermes' 401 carries its login link, with the right prefix, but for an API request that link has no next= (a plain
    // "/login"), so after signing in Hermes would land on its own dashboard. The app's page is the place to come back
    // to, so next= is added whenever the link lacks one (Hermes accepts any same-origin page path as next).
    const login = new URL(body.login_url || `${PREFIX}/login`, location.origin);
    if (!login.searchParams.get("next")) login.searchParams.set("next", location.pathname + location.search);
    location.assign(login.pathname + login.search);
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
  return res;
}

async function api(path, init = {}) {
  const res = await apiFetch(path, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}) },
  });
  return res.json();
}

async function apiBlob(path, init = {}) {
  const res = await apiFetch(path, init);
  return res.blob();
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
const HIDDEN_NOTICE_KINDS = new Set(["personality_switch", "auto_continue"]);
const FILE_REF = /@file:(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\S+))/g;
const OTHER_REF = /@(?:folder|url|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/g;
const ATTACHED_CONTEXT_TAIL = /(?:^|\n)--- Attached Context ---\s*\n[\s\S]*$/;
const CONTEXT_WARNINGS_TAIL = /(?:^|\n)--- Context Warnings ---[\s\S]*$/;
const LEGACY_HEARTBEAT = /^\[Background process \S+ heartbeat #\d+ /;
// tui_gateway/session_history.py _DISCORD_TRIGGERING_NOTE_RE: a Discord routing note older gateways stored inside the
// person's own message. Hermes strips it for display; so do we.
const DISCORD_TRIGGERING_NOTE =
  /(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply\/react\/pin via the discord tools\.\]\n*/g;
const JOB_PREFIX = /^\[Scheduled job result\]\s*/; // bridge.py PREFIX
// A schedule mentioned in a message (schedules.js mentionText): "[Schedule: <name> · job <id>]". The user bubble draws
// it inline as a pill with the schedule's name (appendWithSchedules).
const SCHEDULE_REF = /\[Schedule: ([^\]\n]+?) · job ([\w-]+)\]/g;

// Text with any schedule tags drawn as inline pills.
function appendWithSchedules(parent, text) {
  let last = 0;
  for (const m of text.matchAll(SCHEDULE_REF)) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const pill = el("span", "sched-pill");
    pill.insertAdjacentHTML("beforeend", CLOCK_ICON);
    pill.append(el("span", "", m[1]));
    pill.title = `Schedule: ${m[1]}`;
    parent.append(pill);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}
const CLOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
// A skill a message was sent with (slash.js describeSkillInvocation): the same inline pill, with a bolt.
function skillPill(name) {
  const pill = el("span", "sched-pill skill-pill");
  pill.insertAdjacentHTML("beforeend", SKILL_ICON);
  pill.append(el("span", "", name));
  pill.title = `Skill: ${name}`;
  return pill;
}
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

// Hermes folds back-to-back user rows into one before a turn, and the fold drops the job label, so a run of job results
// followed by the person's reply comes back as one user row. The server names its originals (plugin_api.py
// _merged_job_parts); the row is drawn as those instead: job results on the agent's side under their own ids, the
// person's text as their own bubble under the folded row's id. Filled by loadHistory; row ids are unique per install.
const mergedParts = new Map();

async function loadMergedParts(sessionId) {
  try {
    const data = await api(`/api/plugins/hermes-mini/merged-jobs?session=${encodeURIComponent(sessionId)}`);
    for (const [rowId, parts] of Object.entries((data && data.rows) || {})) {
      if (Array.isArray(parts) && parts.length) mergedParts.set(Number(rowId), parts);
    }
  } catch {
    /* an older server or a failed read: folded rows are drawn as stored */
  }
}

function expandMerged(messages) {
  if (!mergedParts.size) return messages;
  const out = [];
  for (const message of messages) {
    const parts = message.role === "user" && !message.display_kind ? mergedParts.get(message.id) : null;
    if (!parts) {
      out.push(message);
      continue;
    }
    for (const part of parts) {
      out.push({ ...message, id: part.id, content: part.content, display_kind: part.display_kind || null,
        display_content: undefined, timestamp: part.timestamp ?? message.timestamp });
    }
  }
  return out;
}

function chatEntries(messages, { notices = false } = {}) {
  const entries = [];
  for (const message of expandMerged(messages)) {
    if (message.role === "tool") {
      const clarify = clarifyHistoryItems(message);
      if (clarify) entries.push({ message, text: "", images: [], files: [], kind: "clarify", clarify });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const kind = message.display_kind || "";
    if (kind === "hidden" || kind === "model_switch" || modelOnly(message)) continue;
    // Hermes' injected system notices (background task finished, etc.) are not shown at all.
    if (message.role === "user" && (NOTICE_KINDS.has(kind) || HIDDEN_NOTICE_KINDS.has(kind))) continue;
    const raw = typeof message.display_content === "string" ? message.display_content.trim() : messageText(message);
    if (kind === "failed_turn") {
      // Hermes closing a failed turn, not the agent speaking: a small muted line.
      if (notices && raw) entries.push({ message, text: failureText(raw), images: [], files: [], kind: "fail" });
      continue;
    }
    if (kind === "job_delivery") {
      // A scheduled job's output, stored by the bridge (bridge.py) as a labelled user-role row so the model
      // keeps strict alternation. Drawn on the agent's side, marked as a job.
      const body = displayText(stripCronWrapper(raw.replace(JOB_PREFIX, "").trim()), { notice: true });
      if (body && !LIFECYCLE_NOTICE.test(body)) entries.push({ message: { ...message, role: "assistant" }, text: body, images: [], files: [], kind: "job" });
      continue;
    }
    if (message.role === "user" && LEGACY_HEARTBEAT.test(raw)) continue;
    // tui_gateway/session_history.py _is_display_hidden_marker: a user row that opens with "[System:" is a gateway
    // notice stored as a user turn (older ones carry no display_kind), never the person's own words.
    if (message.role === "user" && (messageText(message).trimStart().startsWith("[System:") ||
      raw.trimStart().startsWith("[System:"))) continue;
    const images = [];
    const files = [];
    // A message sent with skills is stored as the expanded skill text (Hermes describe_skill_invocation): only the
    // skills and the person's own words are shown.
    const skill = message.role === "user" ? describeSkillInvocation(messageText(message)) : null;
    let text = message.role === "assistant" ? displayText(raw) : skill ? skill.text : raw;
    if (message.role === "user") {
      text = text.replace(ATTACHED_CONTEXT_TAIL, "").replace(CONTEXT_WARNINGS_TAIL, "").replace(DISCORD_TRIGGERING_NOTE, "$1");
      // The server appends an internal @image: reference to a prompt that carried an image (rendered as a thumbnail) and
      // an @file: reference for an attached file (rendered as a chip). Pull them out, then treat the rest as the text.
      for (const m of text.matchAll(/@image:(\S+)/g)) images.push(m[1]);
      for (const m of text.matchAll(FILE_REF)) files.push(m[1] || m[2] || m[3] || m[4]);
      text = text.replace(/@image:\S+/g, "").replace(FILE_REF, "").replace(OTHER_REF, "");
      // A steer stored without the server's display_content still carries the out-of-band markers.
      text = text.replace(STEER_WRAP, "$1");
    }
    text = text.trim();
    if (skill) {
      const info = { names: skill.names, text };
      entries.push({ message, text: skillLabel(info), images, files, skill: info });
      continue;
    }
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
  // A skill message too: Edit would resend its words without the skills.
  return /@(image|file):|\[Schedule: [^\]\n]+ · job /.test(messageText(message)) || Boolean(describeSkillInvocation(messageText(message)));
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
      // display.install.sudo is asked of the app itself (session_id ""), not of a chat: show it even while a New
      // chat draft or a read-only chat is on screen.
      if (belongsToView(params) || frame.method === "display.install.sudo") {
        onServerRequest(frame.id, frame.method, params);
      } else if (frame.method === "approval" || frame.method === "clarify" || promptCards.isPromptMethod(frame.method)) {
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
  void approvalUi.refresh();
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
    // Learn whether this dashboard is gated before choosing: sessionToken() reads that from the dashboard root, and
    // checking the flag first sent the very first socket of a gated install out with an empty token (a failed
    // connection in the console on every load, rescued only by the reconnect).
    const token = await sessionToken();
    let query;
    if (window.__HERMES_AUTH_REQUIRED__) {
      const { ticket } = await api("/api/auth/ws-ticket", { method: "POST" });
      query = `ticket=${encodeURIComponent(ticket)}`;
    } else {
      // Loopback dashboards authorize the socket with the session token; only gated
      // deployments mint single-use tickets. The dashboard SPA does the same.
      query = `token=${encodeURIComponent(token)}`;
    }
    await openSocket(`${proto}//${location.host}${PREFIX}/api/ws?${query}`);
  })().finally(() => {
    state.connecting = null;
  });
  return state.connecting;
}

// Thread attach: find or create the main chat thread, resume it, then load its history.

// The SERVER decides which thread is current, so every device (phone, PC) shows the same conversation:
// the id the app recorded as home. The home title is read once, only to migrate an install that predates
// the id. localStorage only remembers it as a fallback when the lookup fails.
async function currentServerThreadId() {
  const row = await currentServerThreadRow();
  return row ? row.id : null;
}

// The recorded home row, or null when there is none (or it is gone). The title is a migration fallback,
// and only for a chat already in the app registry, so a terminal or Discord chat that takes the title
// can never become home.
async function currentServerThreadRow() {
  const registry = await api("/api/plugins/hermes-mini/app-chats");
  const home = registry && typeof registry.home === "string" ? registry.home : "";
  if (home) {
    let row = null;
    try {
      row = await api(`/api/sessions/${encodeURIComponent(home)}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (row && !row.archived) return row;
    // The recorded home is gone: forget it so ensureHome can create a fresh one. Never follow a title.
    await api("/api/plugins/hermes-mini/app-chats/home", { method: "DELETE" }).catch(() => {});
    return null;
  }
  const listed = await rpc("session.list", { title: THREAD_TITLE, limit: 20 });
  const registered = new Set((registry && registry.ids) || []);
  const row = (listed.sessions || [])
    .filter((item) => item.title === THREAD_TITLE && registered.has(item.id) && !item.archived)
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null;
  if (row) {
    const winner = await registerAppChat(row.id, true); // record it once; the title stops mattering
    if (winner && winner !== row.id) {
      const adopted = await api(`/api/sessions/${encodeURIComponent(winner)}`).catch(() => null);
      if (adopted && !adopted.archived) return adopted;
    }
  }
  return row;
}

// Creates the home thread and makes it live here. Callers decide whether it is the chat on screen.
async function createThread() {
  const created = await rpc("session.create", {});
  if (!state.viewedUnsent) state.liveSid = created.session_id;
  state.homeId = created.stored_session_id;
  if (!state.viewedUnsent) modelUi.setInfo(created.info);
  safeStorageSet(STORE_KEY, state.homeId);
  const winner = await registerAppChat(state.homeId, true);
  if (winner && winner !== state.homeId) {
    // Another device claimed the home first: discard this empty row and adopt the winner.
    await rpc("session.archive", { session_id: created.stored_session_id, archived: true }).catch(() => {});
    state.homeId = winner;
    if (!state.viewedUnsent) state.liveSid = null;
    safeStorageSet(STORE_KEY, winner);
    return false; // resume the other device's thread
  }
  return true;
}

// Tags a chat as started in the app (plugin_api.py /app-chats). The home flag claims the main-chat id
// atomically and the response says which id won. Idempotent; sending a message re-tags the chat, so one
// failed call heals itself.
async function registerAppChat(id, home = false) {
  if (!id) return "";
  try {
    const data = await api("/api/plugins/hermes-mini/app-chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, home: Boolean(home) }),
    });
    if (data && data.added) drawerApi.addAppChat(id);
    return data && typeof data.home === "string" ? data.home : "";
  } catch {
    return "";
  }
}

// Registers a chat started from New chat: if no real main chat exists yet on the server (none recorded, or the
// startup placeholder was never saved), claim this chat as main chat; otherwise register it as a side chat.
async function registerNewChat(id) {
  if (!id) return;
  try {
    const existing = await currentServerThreadRow();
    if (!existing) {
      const winner = await registerAppChat(id, true);
      if (winner) {
        state.homeId = winner;
        safeStorageSet(STORE_KEY, winner);
        updateCaption();
        refreshDockedDrawer();
        return;
      }
    } else if (existing.id && existing.id !== state.homeId) {
      state.homeId = existing.id;
      safeStorageSet(STORE_KEY, existing.id);
      updateCaption();
    }
  } catch {
    /* lookup failed: still register the chat so it stays listed in the drawer */
  }
  await registerAppChat(id);
}

// Finds the recorded home thread on the server, or creates one. Returns true when created.
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

// A New chat is a local draft: no server session and no registry tag until the first message. It is shown at once,
// keeps the greeting and the composer, and is remembered as NEW_VIEW so a reload starts another draft.
let draftEpoch = 0;

function openDraft(opts = {}) {
  draftEpoch += 1;
  // The chat being left was on screen until now, so everything in it so far was seen.
  if (state.viewedId && !state.viewedUnsent) drawerApi.markSeen(state.viewedId);
  state.viewedId = null;
  state.viewedUnsent = true;
  state.storedId = null;
  state.liveSid = null;
  state.viewedTitle = "";
  state.streaming = false;
  state.turn = null;
  for (const id of [...state.cards.keys()]) removeCard(id);
  clearLog({ keepDictation: Boolean(opts.keepPick) });
  setEmptyState(true, { lower: Boolean(opts.lower) });
  setReadOnly(false);
  updateCaption();
  state.composerLocked = false;
  state.ready = true;
  updateComposer();
  persistView();
  refreshDockedDrawer();
  if (!opts.keepPick) modelUi.resetDraft();
  void modelUi.showDraft();
}

// Creates the real chat for the first message. The draft view is already on screen, so this only adds the session and
// its id; the composer keeps what the person typed. RPC errors are thrown to the caller.
async function openFreshChat() {
  const epoch = draftEpoch;
  const isCurrent = () => epoch === draftEpoch && state.viewedUnsent && !state.liveSid;
  const created = await rpc("session.create", modelUi.draftCreateParams());
  let selected;
  try {
    if (!isCurrent()) return false;
    selected = await modelUi.applyDraftModel(created.session_id, isCurrent);
    if (!selected || !isCurrent()) return false;
  } finally {
    if (!selected || !isCurrent()) void rpc("session.close", { session_id: created.session_id }).catch(() => {});
  }
  modelUi.resetDraft();
  modelUi.setInfo({ ...created.info, ...selected });
  state.viewedId = created.stored_session_id;
  state.viewedUnsent = true;
  state.storedId = created.stored_session_id;
  state.liveSid = created.session_id;
  state.viewedTitle = "";
  state.ready = true;
  await registerNewChat(created.stored_session_id);
  if (epoch !== draftEpoch || state.liveSid !== created.session_id) return false;
  persistView();
  updateCaption();
  return true;
}

// A New chat has no server id now: on boot or a reconnect it is simply a fresh draft.
async function attachUnsent() {
  openDraft({ keepPick: true });
}

// Attaches the chat on screen: the one remembered in state.viewedId, or the home thread. A chat that no longer
// exists, was archived, or is not an app chat (not resumable) falls back to the home thread with a note.
// Connection errors are rethrown so the reconnect logic handles them.
async function attachThread() {
  if (state.viewedUnsent) {
    await Promise.all([ensureHome(), attachUnsent()]);
    return;
  }
  setEmptyState(false);
  const fresh = await ensureHome();
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

// The live session id is dead (session.reclaimed, or a send that found no session): every send to it would fail and a
// running turn's dots would never stop. Resuming the stored chat gives it a fresh live session. A failure here goes
// through the ordinary reconnect path.
let reattachRun = null;
function reattachChat() {
  if (reattachRun) return reattachRun;
  reattachRun = (async () => {
    state.liveSid = null;
    state.ready = false;
    if (state.streaming) finishTurn();
    updateComposer();
    try {
      await attachThread();
    } catch (error) {
      if (error instanceof AuthRedirect) return;
      if (state.ws) dropSocket(state.ws);
      else scheduleReconnect();
    }
  })().finally(() => {
    reattachRun = null;
  });
  return reattachRun;
}

function isLostSession(error) {
  return /session not found/i.test(errorText(error));
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
  let pendingConnection = null;
  let inflight = null;
  let messageCount = 0;
  if (!fresh) {
    try {
      const resumed = await rpc("session.resume", { session_id: state.homeId });
      state.liveSid = resumed.session_id;
      modelUi.setInfo(resumed.info);
      running = Boolean(resumed.running);
      openRequests = resumed.open_requests || [];
      pendingConnection = resumed.pending_connection || null;
      inflight = resumed.inflight || null;
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
  finishAttach(openRequests, running, pendingConnection, inflight);
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
  modelUi.setInfo(resumed.info);
  state.ready = false;
  setReadOnly(false);
  updateCaption();
  await loadHistory(Number(resumed.message_count) || 0);
  finishAttach(resumed.open_requests || [], Boolean(resumed.running), resumed.pending_connection || null,
    resumed.inflight || null);
  if (!pendingTarget) restoreScroll(id); // a deep link places its own message instead
}

// A turn still running when the chat (re)attaches: draw the reply streamed so far, which the saved chat does not have
// yet, so the next chunks continue it instead of starting a cut-off bubble. Like Hermes's desktop, the text is the
// turn's flat inflight.assistant. Saved assistant rows already past the last user row cover its start; when they do
// not line up, nothing is drawn rather than drawing text twice.
function seedInflight(inflight) {
  if (!inflight || typeof inflight !== "object") return;
  if (inflight.display_kind === "hidden") {
    state.hiddenTurn = true;
    return;
  }
  let text = typeof inflight.assistant === "string" ? inflight.assistant : "";
  const rows = state.historyRows || [];
  let lastUser = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const saved = rows.slice(lastUser + 1).filter((row) => row.role === "assistant").map((row) => messageText(row));
  const covered = saved.join("");
  if (covered.trim()) {
    if (!text.startsWith(covered)) return;
    text = text.slice(covered.length);
  }
  // Chunks after this pick up their place from the first one that arrives (streamChunk adopts its turn).
  state.stream = { turnId: null, segment: 0, applied: 0 };
  if (!text.trim()) return;
  const turn = ensureTurn();
  turn.text = text.replace(/^\s+/, "");
  turn.seeded = true;
  scheduleTurnPaint(turn);
}

// Hermes stamps each streamed chunk with turn_id, segment (seals before it) and offset (UTF-16 units of that segment
// already sent; tui_gateway/stream_segments.py). A re-sent chunk (a retried model call re-streams its segment) must
// not paint twice: return only the part of the chunk not applied yet, and whether a new segment began without its
// message.interim. Unstamped chunks are appended as they come.
function streamChunk(stream, payload) {
  const text = payload.text;
  if (!stream || typeof payload.offset !== "number" || typeof payload.segment !== "number") return { text, seal: false };
  if (payload.turn_id && stream.turnId !== payload.turn_id) {
    // The first stamped chunk after a reattach (or of a turn whose message.start never came): everything before its
    // offset is already on screen.
    stream.turnId = payload.turn_id;
    stream.segment = payload.segment;
    stream.applied = payload.offset;
  }
  if (payload.segment < stream.segment) return { text: "", seal: false };
  let seal = false;
  if (payload.segment > stream.segment) {
    seal = true;
    stream.segment = payload.segment;
    stream.applied = 0;
  }
  const end = payload.offset + text.length;
  if (end <= stream.applied) return { text: "", seal };
  const fresh = payload.offset < stream.applied ? text.slice(stream.applied - payload.offset) : text;
  stream.applied = end;
  return { text: fresh, seal };
}

function finishAttach(openRequests, running, pendingConnection = null, inflight = null) {
  // Cards whose request the server no longer reports as open are stale.
  const openIds = new Set(openRequests.map((req) => req.id));
  for (const id of [...state.cards.keys()]) {
    if (!openIds.has(id)) removeCard(id);
  }
  for (const req of openRequests) onServerRequest(req.id, req.method, req.params || {});
  syncConnectionCards(pendingConnection);
  if (els.status.textContent.startsWith("Waiting for your answer")) setStatus("");
  state.streaming = Boolean(running);
  state.stream = null;
  if (running) seedInflight(inflight);
  if (running) touchTurn();
  if (running) activity.restoreLiveTree({ sid: state.storedId, insertBefore: state.turn ? state.turn.row : null });
  if (running && state.turn) paintTurn(state.turn);
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
  if (!id || id === state.viewedId || state.switching || state.sending || state.resettingMain) return;
  if (!state.wsReady) {
    sysLine("Not connected yet. Try again in a moment.");
    return;
  }
  state.switching = true;
  rememberScroll();
  const leaving = state.viewedId;
  const leavingUnsent = state.viewedUnsent;
  state.viewedUnsent = false;
  state.viewedId = id;
  persistView();
  drawerApi.markSeen(id, null, { clearManual: true }); // opening a chat is what clears its unread dot
  // The chat being left was on screen until now, so everything in it so far was seen: a job result or background
  // follow-up that landed while it was open must not come back as a dot (ghost-dot fix, 7 Nov 2026).
  if (leaving && !leavingUnsent) drawerApi.markSeen(leaving);
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

// Renames a chat directly through the gateway's revision-checked session.mutate RPC on the open WebSocket so
// renaming skips HTTP PATCH -> connect_gateway overhead. Falls back only when the gateway lacks session.mutate.
async function renameSession(item, title) {
  // Titles are unique. The server would hand a name over from an EMPTY chat that holds it (its "ghost" rule), so
  // refuse every taken name here instead: an exact-title lookup, no resume.
  const holders = await rpc("session.list", { title });
  const holder = (holders.sessions || []).find((row) => row.title === title && row.id !== item.id && row.resolved_id !== item.id);
  if (holder) throw new Error("Another chat already uses that name.");
  const mutateRename = async (expectedRevision, expectedGeneration) => {
    const params = {
      session_id: item.id,
      request_id: newRequestId(),
      expected_revision: expectedRevision,
      operation: "sidebar",
      payload: { title },
    };
    if (expectedGeneration !== null && expectedGeneration !== undefined) {
      params.expected_generation = expectedGeneration;
    }
    return rpc("session.mutate", params);
  };
  let result = null;
  try {
    const initRev = Number.isInteger(item.runtimeRevision) ? item.runtimeRevision : 0;
    const initGen = Number.isInteger(item.runtimeGeneration) ? item.runtimeGeneration : undefined;
    try {
      result = await mutateRename(initRev, initGen);
    } catch (error) {
      const data = error && error.data;
      const reason = (data && data.reason) || (error && error.message);
      if ((reason === "revision_conflict" || reason === "stale_generation") && data && Number.isInteger(data.revision)) {
        result = await mutateRename(
          data.revision,
          Number.isInteger(data.execution_generation) ? data.execution_generation : undefined,
        );
      } else {
        throw error;
      }
    }
  } catch (error) {
    const code = error && error.code;
    const msg = (error && error.message) || "";
    if (code !== -32601 && !/unknown_method/i.test(msg)) throw error;
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
  }
  if (result && typeof result === "object") {
    if (Number.isInteger(result.revision)) item.runtimeRevision = result.revision;
    if (Number.isInteger(result.execution_generation)) item.runtimeGeneration = result.execution_generation;
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
      await activity.deleteSession(id);
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

// Resets the main chat: after the drawer's confirmation, verify this device still points at the server's recorded
// home chat, delete it through the same fenced mutation as Delete, forget the old local pointers, then let
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
    // Forget the recorded home before creating the replacement; the new one claims its own id.
    await api("/api/plugins/hermes-mini/app-chats/home", { method: "DELETE" }).catch(() => {});
    // Keep the old home id while the replacement is created: the drawer draws the main row from it, and
    // clearing it here made the row flash out during the reset. createThread replaces it with the new id.
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
    await attachThread(); // ensureHome creates or adopts the fresh home chat, and attachHome shows it empty
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
  if (state.viewedUnsent && !state.liveSid) return false; // a draft has no runtime to ask anything of
  return !state.liveSid || !params.session_id || params.session_id === state.liveSid;
}

// History pages: include_compacted=true, or rows Hermes compacted (summarised for the model) vanish from the chat
// even though they are stored. The server returns at most 500 rows per page, newest first, and tool rows count toward that, so a
// busy chat shows only a few bubbles from page one. Older pages load as you scroll to the top.
const HISTORY_PAGE = 500;
const older = { sid: null, offset: 0, minId: Infinity, done: true, busy: false, gen: 0 };

function renderHistoryEntries(messages, { isOldestPage = false } = {}) {
  const rawEntries = chatEntries(messages, { notices: true });
  const prepared = rawEntries.map((entry) => ({
    ...entry,
    role: entry.message.role,
    rowId: Number.isInteger(entry.message.id) ? entry.message.id : null,
    ts: Number(entry.message.timestamp) || 0,
  }));
  activity.renderHistoryTrees(state.storedId, prepared, (entry) => {
    const { message, text, images, files, kind, clarify, skill, ts, rowId } = entry;
    if (kind === "clarify") {
      addResolvedClarify(clarify);
      return;
    }
    if (kind === "fail") {
      addFailLine(text);
      return;
    }
    const meta = {
      rowId,
      ts,
      attached: carriesAttachments(message),
      images,
      files,
      skill,
    };
    if (message.role === "user") addUserBubble(text, [], false, meta);
    else if (kind === "job") addJobBubble(text, meta);
    else addAssistantBubble(text, meta);
  }, { isOldestPage });
}

function lowestRowId(messages) {
  let low = Infinity;
  for (const m of messages) if (Number.isInteger(m.id) && m.id < low) low = m.id;
  return low;
}

async function loadHistory(messageCount = null) {
  // An empty thread has no transcript to fetch (the REST page 404s until its first message).
  let data = { messages: [] };
  const sid = !state.viewedUnsent ? state.storedId : null;
  const activityLoad = sid ? activity.loadSessionTrees(sid) : Promise.resolve([]);
  if (messageCount !== 0 && sid) {
    [data] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(sid)}/messages?limit=${HISTORY_PAGE}&order=latest&include_compacted=true`),
      loadMergedParts(sid),
      activityLoad,
    ]);
  } else {
    await activityLoad;
  }
  state.turn = null;
  clearLog({ keepDictation: true });
  const rows = data.messages || [];
  state.historyRows = rows;
  older.gen += 1;
  older.sid = state.storedId;
  older.offset = HISTORY_PAGE;
  older.minId = lowestRowId(rows);
  older.done = rows.length === 0;
  older.busy = false;
  renderHistoryEntries(rows, { isOldestPage: rows.length < HISTORY_PAGE });
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
  // The chat on screen counts as read once its history is in, but only when it is actually on screen: a reconnect in
  // the background must not read it; coming back to the app marks it.
  if (pageVisible()) drawerApi.markSeen(state.viewedId);
  if (!pendingTarget) void fillOlder(); // a page that is mostly tool rows may not fill the screen: keep loading until it scrolls
  // The rows are in, so their Mark unread / Mark read labels can be read from the Inbox tracker (its own route).
  void refreshInboxMarks();
  void bookmarks.refreshIds().then(refreshBookmarkMarks);
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
    const isOldestPage = (data.messages || []).length < HISTORY_PAGE;
    if (!(data.messages || []).length) {
      older.done = true;
      return false;
    }
    if (!rows.length) return true; // a page of rows already shown: the next one is older
    older.minId = Math.min(older.minId, lowestRowId(rows));
    const prevHeight = els.log.scrollHeight;
    const prevTop = els.log.scrollTop;
    const marker = els.log.lastChild;
    renderHistoryEntries(rows, { isOldestPage });
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

function pageVisible() {
  return document.visibilityState === "visible";
}

// A socket that died while the app was in the background still reads as ready until the heartbeat notices, and a
// reply that was streaming then never got its end: state.turn stays set, so a tap skipped the history reload and
// searched a chat that did not have the new reply yet ("Message not found"). Probe the socket first; a dead one is
// dropped, and the reconnect re-attaches the chat (fresh history, no stale turn) before the tap reads it.
const DEEPLINK_PING_MS = 2500;
async function ensureLiveSocket(ms = 10000) {
  const ws = state.ws;
  if (ws && state.wsReady) {
    try {
      await rpc("gateway.ping", {}, DEEPLINK_PING_MS);
      return true;
    } catch {
      if (state.ws === ws) {
        state.backoffIdx = 0; // reconnect at once: the person is waiting on this tap
        dropSocket(ws);
      }
    }
  }
  const until = Date.now() + ms;
  const settled = () => state.wsReady && (state.ready || state.readOnly) && !state.connecting;
  while (!settled() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  return settled();
}

// A tap can land while a chat switch is still starting. switchSession() refuses a second switch, so a deep link
// that ignored that would read the chat being left and call its message missing.
async function waitForSwitch(ms = 5000) {
  const until = Date.now() + ms;
  while (state.switching && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
}

// Opens the chat a notification named, then its message. A chat that is gone falls back to what the app shows anyway
// (the main chat) and still says the message was not found, because it was in the chat that is missing.
// Persistent pill while a deep link (notification, Inbox, Bookmark) is switching chats and paging history to find
// its target message. Reuses .restart-dots for the blinking "...". Dismissed as soon as the row flashes (no success
// toast: the flash is the confirmation), or before the error toast if the message cannot be found.
let jumpToast = null;
function showJumpNotice() {
  if (!jumpToast) {
    jumpToast = el("div", "toast jump-toast");
    jumpToast.setAttribute("popover", "manual");
    jumpToast.setAttribute("role", "status");
    jumpToast.setAttribute("aria-live", "polite");
    document.body.append(jumpToast);
  }
  if (!jumpToast.querySelector(".restart-dots")) {
    const dots = el("span", "restart-dots");
    dots.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) dots.append(el("span", "", "."));
    jumpToast.replaceChildren(document.createTextNode("Loading message"), dots);
  }
  reopenPopover(jumpToast);
  jumpToast.classList.add("show");
}
function hideJumpNotice() {
  if (!jumpToast) return;
  jumpToast.classList.remove("show");
  closePopover(jumpToast, 300);
}

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
  showJumpNotice();
  try {
    await ensureLiveSocket();
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
      hideJumpNotice();
      showToast("Message not found", "error");
      return false;
    }
    hideJumpNotice();
    await revealRow(row);
    return true;
  } catch {
    if (run === deeplinkRun) {
      hideJumpNotice();
      showToast("Message not found", "error");
    }
    return false;
  } finally {
    if (run === deeplinkRun) {
      pendingTarget = null;
      hideJumpNotice();
    }
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
    await receiveShared(); // Android's share sheet opened this window with something to send
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
    if (meta.skill) {
      // The skills as pills, then the words (which may still hold schedule pills).
      meta.skill.names.forEach((name, i) => {
        if (i) body.append(" ");
        body.append(skillPill(name));
      });
      if (meta.skill.text) {
        body.append(" ");
        appendWithSchedules(body, meta.skill.text);
      }
    } else {
      appendWithSchedules(body, text);
    }
    bubble.append(body);
    row.append(bubble);
  }
  row.hermesMiniMsg = messageRecord("user", text, meta, attachments.length > 0 || (meta.images || []).length > 0);
  addMessageActions(row);
  const fly = animateIn && state.viewedEmpty;
  row.classList.toggle("first-in", fly);
  row.classList.toggle("msg-in", animateIn && !fly); // entrance animation for a message sent just now (style.css)
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

// Job results arrive outside any turn (the gateway writes them), so nothing streams them in. A job may be delivered to
// the main chat or to a named one (bridge.py), and the push names no chat: pull the newest rows of the chat on screen and
// append job results newer than the last row on screen. Runs on the bridge's push, on return to the app and after a reply
// finishes; skipped mid-reply, in a draft, and while another chat is being opened.
let jobSyncBusy = false;
async function syncJobDeliveries() {
  if (jobSyncBusy || state.streaming || state.switching || !state.storedId) return;
  jobSyncBusy = true;
  const storedId = state.storedId;
  const viewedId = state.viewedId;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(storedId)}/messages?limit=20&order=latest`);
    // Another chat was opened (or the same one left and re-opened) meanwhile: those rows are not this chat's.
    if (state.storedId !== storedId || state.viewedId !== viewedId || state.streaming || state.switching) return;
    const shownIds = new Set(chatRows().map((node) => Number(node.hermesMiniMsg.rowId)).filter(Number.isInteger));
    const lastShown = Math.max(0, ...shownIds);
    let added = false;
    for (const entry of chatEntries(data.messages || [])) {
      const id = Number(entry.message.id);
      if (entry.kind !== "job" || !Number.isInteger(id) || id <= lastShown || shownIds.has(id)) continue;
      addJobBubble(entry.text, { rowId: id, ts: Number(entry.message.timestamp) || 0, attached: false, images: [], files: [] });
      added = true;
    }
    if (added) {
      scrollToBottom(false);
      void refreshInboxMarks(); // a job result appended just now also offers Mark unread / Mark read
      void bookmarks.refreshIds().then(refreshBookmarkMarks);
    }
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

// ---------- message actions: copy, edit & resend, branch, mark unread / mark read, bookmark ----------
// Each message has an action row under it. A reply gets its time, Copy, Branch, Mark unread (Mark read once it is held
// unread) and Bookmark / Remove bookmark; a user message gets Copy, Edit, then its time, right-aligned. The row always takes its
// height, so nothing moves when the buttons appear; with a mouse the buttons and the time fade in on hover, and a touch
// device shows only the time (the long-press menu below carries the actions). Every row keeps a small record on the
// element (hermesMiniMsg): role, text shown, durable row id (null until known), time in epoch seconds (0 = unknown),
// whether it had attachments, whether the Inbox holds it unread by hand (markedUnread), and whether it is bookmarked.

const ICON_ATTRS = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ICON_EDIT = `<svg ${ICON_ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const ICON_BRANCH = `<svg ${ICON_ATTRS}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
const ICON_UNREAD = `<svg ${ICON_ATTRS}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`;
const ICON_READ = `<svg ${ICON_ATTRS}><path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-5.2a2 2 0 0 1 2.4 0l8 5.2z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/></svg>`;
const ICON_BOOKMARK = `<svg ${ICON_ATTRS}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
const ICON_BOOKMARKED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
const nowSec = () => Date.now() / 1000;
let shownBusy = false; // the streaming state the action buttons were last synced to

function messageRecord(role, text, meta, hasAttachments) {
  return {
    role,
    text,
    rowId: Number.isInteger(meta.rowId) ? meta.rowId : null,
    ts: meta.ts !== undefined ? meta.ts : nowSec(),
    attached: Boolean(hasAttachments || meta.attached),
    markedUnread: false,
    bookmarked: false,
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
  // The time sits on the outer edge, the icons on the inner side: user rows read [icons] time (right-aligned),
  // Agent rows read time [icons] (left-aligned).
  if (meta.role === "user") {
    bar.append(copy, actionButton("edit", "Edit message", ICON_EDIT, () => beginEdit(row)));
    if (time) bar.append(time);
  } else {
    if (time) bar.append(time);
    bar.append(copy, actionButton("branch", "Branch from this reply", ICON_BRANCH, () => branchFrom(row)));
    bar.append(actionButton("unread", "Mark unread", ICON_UNREAD, () => toggleReplyUnread(row)));
    bar.append(actionButton("bookmark", "Bookmark", ICON_BOOKMARK, () => toggleReplyBookmark(row)));
  }
  row.append(bar);
  syncActionAvailability(bar);
}

// The unread button's label and icon follow the row's flag: a reply the Inbox holds unread offers Mark read, so a tap
// repeats nothing and clears the hold. syncActionAvailability keeps it current when refreshInboxMarks() learns the state.
function syncUnreadButton(button, meta) {
  const marked = Boolean(meta && meta.markedUnread);
  const label = marked ? "Mark read" : "Mark unread";
  button.title = label;
  button.setAttribute("aria-label", label);
  if (button.dataset.state !== (marked ? "read" : "unread")) {
    button.dataset.state = marked ? "read" : "unread";
    button.innerHTML = marked ? ICON_READ : ICON_UNREAD;
  }
}

// The bookmark button follows the reply's flag the same way: kept replies offer Remove bookmark with a filled icon.
function syncBookmarkButton(button, meta) {
  const marked = Boolean(meta && meta.bookmarked);
  const label = marked ? "Remove bookmark" : "Bookmark";
  button.title = label;
  button.setAttribute("aria-label", label);
  if (button.dataset.state !== (marked ? "bookmarked" : "bookmark")) {
    button.dataset.state = marked ? "bookmarked" : "bookmark";
    button.innerHTML = marked ? ICON_BOOKMARKED : ICON_BOOKMARK;
  }
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
      const row = button.closest(".msg");
      const pending = button.dataset.action === "unread" ? unreadBusy.has(row)
        : button.dataset.action === "bookmark" ? bookmarkBusy.has(row) : false;
      button.disabled = busy || state.readOnly || pending;
      if (button.dataset.action === "unread") syncUnreadButton(button, meta);
      if (button.dataset.action === "bookmark") syncBookmarkButton(button, meta);
    }
  }
}

// ---------- message menu (touch long press) and select mode ----------
// On a touch device a long press (450 ms, cancelled by a 10 px move or by lifting) on a message's bubble opens the
// same actions the row's buttons offer, anchored at the press point. The menu is the drawer's row-menu card (same
// look), built on demand: Copy, then Edit (user) or Branch, Mark unread / Mark read (reply, by the row's flag) and
// Bookmark / Remove bookmark, then Select text, each with its icon on the left.
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
  msgMenu = { row, prevFocus: document.activeElement, x, y };
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
    // The same toggle the action row offers: a reply held unread is marked read again from here.
    items.push(meta.markedUnread
      ? msgMenuItem("Mark read", ICON_READ, () => toggleReplyUnread(row))
      : msgMenuItem("Mark unread", ICON_UNREAD, () => toggleReplyUnread(row)));
    items.push(meta.bookmarked
      ? msgMenuItem("Remove bookmark", ICON_BOOKMARKED, () => toggleReplyBookmark(row))
      : msgMenuItem("Bookmark", ICON_BOOKMARK, () => toggleReplyBookmark(row)));
  }
  items.push(msgMenuItem("Select text", ICON_SELECT, () => enterSelectMode(row, caret)));
  els.msgMenu.append(...items);

  row.classList.add("msg-menu-open");
  // Top layer first (still in its closed state), so its size can be measured before it is placed.
  openPopover(els.msgMenuScrim);
  openPopover(els.msgMenu);
  placeMsgMenu(x, y);
  els.msgMenuScrim.classList.add("open");
  els.msgMenu.classList.add("open");
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
  // Out of the top layer once the fade-out has played.
  closePopover(els.msgMenuScrim, 160);
  closePopover(els.msgMenu, 160);
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
// Fixed-position in the top layer: follow the window and the visible area while it is open.
const rePlaceMsgMenu = () => {
  if (msgMenu) placeMsgMenu(msgMenu.x, msgMenu.y);
};
window.addEventListener("resize", rePlaceMsgMenu);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", rePlaceMsgMenu);
  window.visualViewport.addEventListener("scroll", rePlaceMsgMenu);
}
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
async function resolveRowId(row, attempts = 3, expectedSid = null) {
  const meta = row.hermesMiniMsg;
  if (meta.rowId) return meta.rowId;
  const sid = expectedSid || state.storedId;
  if (!sid) throw new Error("this message has no chat yet.");
  const sameInView = row.isConnected
    ? chatRows().filter((node) => node.hermesMiniMsg.role === meta.role && sameText(node.hermesMiniMsg.text, meta.text))
    : [];
  const index = sameInView.indexOf(row);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!row.isConnected || state.storedId !== sid) {
      throw new Error("chat changed");
    }
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(sid)}/messages?limit=500&order=latest&include_compacted=true`);
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

      // 2. Assistant fallback: a bubble whose text overlaps a stored row's (start or end) or the latest turn reply
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
    skill: latest.skill,
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
  state.editing = { row, saved: { text: els.input.value, attachments: state.attachments, pastes: state.pastes, mentions: state.mentions } };
  state.attachments = [];
  state.pastes = [];
  state.mentions = [];
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
  state.mentions = edit.saved.mentions || [];
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
  const editStoredId = state.storedId;
  const editTs = Number(row.hermesMiniMsg?.ts) || 0;
  const editSubmittedAt = Date.now() / 1000;
  state.sending = true;
  let truncatedAtRowId = null;
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
    truncatedAtRowId = rowId;
  } catch (error) {
    sysLine(`Could not edit this message: ${errorText(error)}`);
    return;
  } finally {
    state.sending = false;
  }
  if (editStoredId && truncatedAtRowId !== null) {
    void activity.pruneSessionFrom(editStoredId, { fromRowId: truncatedAtRowId, fromTs: editTs, beforeTs: editSubmittedAt });
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

// Mark unread / Mark read: one button that follows the reply's Inbox state. Mark unread brings the reply back unread in
// the Inbox; the mark is manual, so the read an on-screen row sends (plugin_api.py inbox_mark_read drops non-manual ids
// that are held) cannot undo it while the chat stays open, until it is read by hand or by Mark all. Mark read (shown
// once the reply is held unread, from /inbox/state) releases that hold. unreadBusy keeps a double press to one request.
const unreadBusy = new Set();
async function toggleReplyUnread(row) {
  const meta = row.hermesMiniMsg;
  if (!meta || unreadBusy.has(row)) return;
  if (state.streaming || state.sending || state.switching || state.editing || state.readOnly) return;
  const markingRead = Boolean(meta.markedUnread);
  unreadBusy.add(row);
  syncActionAvailability();
  try {
    const rowId = await resolveRowId(row);
    if (!rowId) throw new Error("this reply is not saved yet. Try again in a moment.");
    if (markingRead) {
      await inbox.markReadByHand(rowId);
      showToast("Marked read");
    } else {
      inboxReadIds.delete(rowId); // a queued automatic read would be refused anyway; do not send it
      await inbox.markUnread(rowId);
      showToast("Marked unread");
    }
    meta.markedUnread = !markingRead;
  } catch (error) {
    if (!(error instanceof AuthRedirect)) {
      sysLine(`Could not mark ${markingRead ? "read" : "unread"}: ${errorText(error)}`);
      showToast(`Could not mark ${markingRead ? "read" : "unread"}`, "error");
    }
  } finally {
    unreadBusy.delete(row);
    syncActionAvailability();
  }
}

// Bookmark / Remove bookmark: one button that follows the reply's stored flag. The reply's durable id is the
// bookmark, so it reads the same from every device; bookmarkBusy keeps a double press to one request.
const bookmarkBusy = new Set();
async function toggleReplyBookmark(row) {
  const meta = row.hermesMiniMsg;
  if (!meta || bookmarkBusy.has(row)) return;
  if (state.streaming || state.sending || state.switching || state.editing || state.readOnly) return;
  const removing = Boolean(meta.bookmarked);
  bookmarkBusy.add(row);
  syncActionAvailability();
  try {
    const rowId = await resolveRowId(row);
    if (!rowId) throw new Error("this reply is not saved yet. Try again in a moment.");
    if (removing) {
      await bookmarks.remove(rowId);
      showToast("Bookmark removed");
    } else {
      await bookmarks.add(rowId);
      showToast("Bookmarked");
    }
    meta.bookmarked = !removing;
  } catch (error) {
    if (!(error instanceof AuthRedirect)) {
      sysLine(`Could not ${removing ? "remove bookmark" : "bookmark"}: ${errorText(error)}`);
      showToast(removing ? "Could not remove bookmark" : "Could not bookmark", "error");
    }
  } finally {
    bookmarkBusy.delete(row);
    syncActionAvailability();
  }
}

// The action row's bookmark button follows the stored set: every reply on screen learns whether it is kept.
function refreshBookmarkMarks() {
  for (const row of chatRows()) {
    const meta = row.hermesMiniMsg;
    if (!meta || meta.role !== "assistant") continue;
    meta.bookmarked = Number.isInteger(meta.rowId) && meta.rowId > 0 ? bookmarks.has(meta.rowId) : false;
  }
  syncActionAvailability();
}

// Inline images: the TUI channel has no attachment path, so any absolute image path in a finished reply
// (bare, in `code`, or as MEDIA:/path) is fetched through the dashboard's authenticated
// /api/fs/read-data-url (the desktop app's path renderer) and shown under the text. Tap = full screen.
const MEDIA_PATH_RE = /(?:^|[\s`'"(\[]|MEDIA:)((?:\/|~\/)[^\s`'"<>()\[\]]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s`'")\].,;:!?])/gi;
const MAX_INLINE_MEDIA = 50; // a Markdown reply can put at most this many local pictures inline, same as the grid
const mediaCache = new Map(); // path -> Promise<dataUrl|null>

function mediaPaths(text) {
  const found = [];
  for (const m of String(text || "").matchAll(MEDIA_PATH_RE)) {
    if (!found.includes(m[1])) found.push(m[1]);
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

const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const DOWNLOAD_ICON = '<svg class="file-attach-down" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 20h14"/></svg>';

// A file delivered with MEDIA: downloads only when tapped: the card is the whole attachment until then (card is optional).
async function openFile(path, name, card = null) {
  if (card && card.classList.contains("busy")) return;
  if (card) {
    card.classList.add("busy");
    card.disabled = true;
  }
  try {
    const blob = await apiBlob(`/api/fs/download?path=${encodeURIComponent(path)}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "attachment";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    showToast(error && error.status === 404 ? "File not found" : "Couldn't download that file", "error");
  } finally {
    if (card) {
      card.classList.remove("busy");
      card.disabled = false;
    }
  }
}

// Audio a reply attaches with MEDIA: plays inline: play/pause, a waveform you tap or drag to seek, the time, and a
// download button. The waveform and duration come from the plugin (ffmpeg) before anything loads; the sound itself
// is fetched only on the first play, seek or download, through the same authenticated route as a download, and that one
// copy is shared by every card for the same file (audioSource).
const AUDIO_EXT = /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const AUDIO_BAR_COUNT = 40;
const AUDIO_TYPES = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg",
  opus: 'audio/ogg; codecs="opus"', wav: "audio/wav", flac: "audio/flac",
};
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>';
const audioMetaCache = new Map();
let playingAudio = null; // the one card's <audio> that is playing: starting another pauses it

// One downloaded copy per audio file for the life of the page: every card that names the same path (twice in one
// reply, again in another message, or redrawn when a chat is reopened) plays and downloads that copy instead of
// fetching the file again. Only the AUDIO_KEEP most recently used files are kept; an older one is released once no
// card on screen still uses it. A failed fetch is forgotten, so the next tap tries again.
const AUDIO_KEEP = 3;
const audioSources = new Map(); // path -> { url: Promise<string> (blob: URL), cards: Set<card element> }

function audioSource(path, card) {
  let entry = audioSources.get(path);
  if (entry) {
    audioSources.delete(path); // re-insert: the Map's order is least to most recently used
  } else {
    entry = { cards: new Set(), url: null };
    entry.url = apiBlob(`/api/fs/download?path=${encodeURIComponent(path)}`).then((blob) => URL.createObjectURL(blob));
    entry.url.catch(() => { if (audioSources.get(path) === entry) audioSources.delete(path); });
  }
  audioSources.set(path, entry);
  entry.cards.add(card);
  for (const [key, old] of audioSources) {
    if (audioSources.size <= AUDIO_KEEP) break;
    if (old === entry || [...old.cards].some((node) => node.isConnected)) continue;
    audioSources.delete(key);
    old.url.then((url) => URL.revokeObjectURL(url), () => {});
  }
  return entry.url;
}

// The audio card's download button: saves the shared copy, fetching it only if no card has yet.
async function downloadAudio(path, name, button, card) {
  if (button.classList.contains("busy")) return;
  button.classList.add("busy");
  button.disabled = true;
  try {
    const link = document.createElement("a");
    link.href = await audioSource(path, card);
    link.download = name || "audio";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    showToast(error && error.status === 404 ? "File not found" : "Couldn't download that file", "error");
  } finally {
    button.classList.remove("busy");
    button.disabled = false;
  }
}

function audioMeta(path) {
  if (!audioMetaCache.has(path)) {
    const pending = api(`/api/plugins/hermes-mini/audio-meta?path=${encodeURIComponent(path)}`).catch(() => null);
    audioMetaCache.set(path, pending);
  }
  return audioMetaCache.get(path);
}

function clockText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

// The plain attachment: a download card. Also what an audio card falls back to when it cannot play.
function fileCard(path, name) {
  const card = el("button", "file-attach");
  card.type = "button";
  card.dataset.fileSrc = path;
  card.title = `Download ${name}`;
  card.setAttribute("aria-label", `Download ${name}`);
  card.innerHTML = `${FILE_ICON}<span class="file-attach-name"></span>${DOWNLOAD_ICON}`;
  card.querySelector(".file-attach-name").textContent = name;
  card.addEventListener("click", () => void openFile(path, name, card));
  return card;
}

// Anything the player cannot do (no ffmpeg on this Hermes, an older plugin API, an undecodable file, a format this
// browser will not play) turns the card back into the plain download card, in place.
function audioCard(path, name) {
  const card = el("div", "audio-card loading-meta");
  const fallBack = () => {
    if (card.isConnected) card.replaceWith(fileCard(path, name));
  };
  card.dataset.fileSrc = path;
  card.title = name;
  const play = el("button", "audio-play");
  play.type = "button";
  play.setAttribute("aria-label", `Play ${name}`);
  play.innerHTML = PLAY_ICON;
  const wave = el("div", "audio-wave");
  wave.setAttribute("role", "slider");
  wave.tabIndex = 0;
  wave.setAttribute("aria-label", `Seek ${name}`);
  wave.setAttribute("aria-valuemin", "0");
  const bars = [];
  for (let i = 0; i < AUDIO_BAR_COUNT; i += 1) {
    const bar = el("span", "audio-bar");
    bar.style.setProperty("--h", "0.18");
    bars.push(bar);
    wave.append(bar);
  }
  const time = el("span", "audio-time", "--:--");
  const down = el("button", "audio-down");
  down.type = "button";
  down.title = `Download ${name}`;
  down.setAttribute("aria-label", `Download ${name}`);
  down.innerHTML = DOWNLOAD_ICON;
  down.addEventListener("click", () => void downloadAudio(path, name, down, card));
  card.append(play, wave, time, down);

  let duration = NaN;
  let audio = null;
  let loading = null;
  let scrub = null; // fraction shown while a finger or mouse drags, before the seek lands

  const fraction = () => (scrub !== null ? scrub
    : audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0);
  const paint = () => {
    const f = fraction();
    const lit = Math.round(f * bars.length);
    bars.forEach((bar, i) => bar.classList.toggle("on", i < lit));
    const total = audio && Number.isFinite(audio.duration) ? audio.duration : duration;
    const started = scrub !== null || (audio && (audio.currentTime > 0 || !audio.paused));
    time.textContent = clockText(started ? f * total : total);
    wave.setAttribute("aria-valuemax", String(Math.round(total) || 0));
    wave.setAttribute("aria-valuenow", String(Math.round(f * total) || 0));
    wave.setAttribute("aria-valuetext", `${clockText(f * total)} of ${clockText(total)}`);
  };
  const setPlaying = (on) => {
    card.classList.toggle("playing", on);
    play.innerHTML = on ? PAUSE_ICON : PLAY_ICON;
    play.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${name}`);
  };

  audioMeta(path).then((meta) => {
    card.classList.remove("loading-meta");
    if (!meta || !Array.isArray(meta.peaks) || !(Number(meta.duration) > 0)) {
      fallBack();
      return;
    }
    if (typeof Audio !== "function" || !new Audio().canPlayType(AUDIO_TYPES[path.split(".").pop().toLowerCase()] || "")) {
      fallBack(); // this browser cannot decode the format (for example Opus on an older iPhone)
      return;
    }
    duration = Number(meta.duration);
    meta.peaks.slice(0, bars.length).forEach((peak, i) => {
      bars[i].style.setProperty("--h", String(Math.max(0.12, Math.min(1, Number(peak) || 0))));
    });
    paint();
  });

  const ensureAudio = () => {
    if (audio) return Promise.resolve(audio);
    if (loading) return loading;
    card.classList.add("loading");
    play.disabled = true;
    loading = audioSource(path, card)
      .then((url) => new Promise((resolve, reject) => {
        const node = new Audio();
        node.preload = "auto";
        node.addEventListener("loadedmetadata", () => resolve(node), { once: true });
        node.addEventListener("error", () => reject(new Error("unplayable")), { once: true });
        node.src = url;
      }))
      .then((node) => {
        audio = node;
        audio.addEventListener("timeupdate", () => {
          if (!card.isConnected) audio.pause(); // the message was redrawn: no sound without its controls
          else paint();
        });
        audio.addEventListener("play", () => {
          if (playingAudio && playingAudio !== audio) playingAudio.pause();
          playingAudio = audio;
          setPlaying(true);
        });
        audio.addEventListener("pause", () => { setPlaying(false); paint(); });
        audio.addEventListener("ended", () => { audio.currentTime = 0; setPlaying(false); paint(); });
        return audio;
      })
      .catch((error) => {
        loading = null;
        if (error && error.status === 404) showToast("Audio file not found", "error");
        else fallBack(); // fetched but unplayable here: offer the file instead
        throw error;
      })
      .finally(() => {
        card.classList.remove("loading");
        play.disabled = false;
      });
    return loading;
  };

  play.addEventListener("click", async () => {
    if (audio && !audio.paused) {
      audio.pause();
      return;
    }
    try {
      const node = await ensureAudio();
      await node.play();
    } catch {
      /* reported by ensureAudio, or the browser refused autoplay */
    }
  });

  const seekTo = async (f) => {
    try {
      const node = await ensureAudio();
      if (Number.isFinite(node.duration)) node.currentTime = Math.max(0, Math.min(1, f)) * node.duration;
      if (node.paused) await node.play();
    } catch {
      /* reported by ensureAudio */
    }
    scrub = null;
    paint();
  };
  const at = (event) => {
    const box = wave.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  };
  wave.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    wave.setPointerCapture(event.pointerId);
    card.classList.add("scrubbing");
    scrub = at(event);
    paint();
  });
  wave.addEventListener("pointermove", (event) => {
    if (scrub === null || !wave.hasPointerCapture(event.pointerId)) return;
    scrub = at(event);
    paint();
  });
  const release = (event) => {
    if (scrub === null) return;
    card.classList.remove("scrubbing");
    const f = event.type === "pointercancel" ? null : scrub;
    if (f === null) {
      scrub = null;
      paint();
      return;
    }
    void seekTo(f);
  };
  wave.addEventListener("pointerup", release);
  wave.addEventListener("pointercancel", release);
  wave.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const total = audio && Number.isFinite(audio.duration) ? audio.duration : duration;
    if (!Number.isFinite(total) || total <= 0) return;
    const now = audio ? audio.currentTime : 0;
    void seekTo(Math.max(0, Math.min(total, now + step)) / total);
  });
  return card;
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

// Hermes' native MEDIA:/path directive: turn each tag into the same kind of slot a local Markdown picture leaves,
// at the exact place it was written. Code samples keep their literal tag, as in the gateway.
function inlineMediaTags(bubble) {
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue.includes("MEDIA:")) continue;
    if (node.parentElement.closest("pre, code, a, .media, .md-media-slot")) continue;
    nodes.push(node);
  }
  for (const node of nodes) {
    const tags = mediaTags(node.nodeValue);
    if (!tags.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const tag of tags) {
      frag.append(document.createTextNode(node.nodeValue.slice(at, tag.start)));
      if (tag.kind === "file") {
        const name = tag.path.split("/").pop() || "file";
        frag.append(AUDIO_EXT.test(tag.path) ? audioCard(tag.path, name) : fileCard(tag.path, name));
      } else {
        const slot = el("span", "md-media-slot");
        slot.dataset.mdSrc = tag.path;
        slot.dataset.alt = tag.path.split("/").pop() || "image";
        slot.textContent = slot.dataset.alt;
        frag.append(slot);
      }
      at = tag.end;
    }
    frag.append(document.createTextNode(node.nodeValue.slice(at)));
    node.replaceWith(frag);
  }
}

// Pictures past this many in one reply are not fetched: say so under the message instead of dropping them silently.
function showMediaLimit(bubble, count) {
  if (count <= 0) return;
  bubble.append(el("div", "media-more", `This app's preview limit has been reached. ${count} picture${count === 1 ? "" : "s"} not shown.`));
}

const inlineMediaObserver = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const slot = entry.target;
      inlineMediaObserver.unobserve(slot);
      const load = slot._loadInlineMedia;
      delete slot._loadInlineMedia;
      if (typeof load === "function") load();
    }
  }, { root: null, rootMargin: "600px 0px" })
  : null;

function loadInlineMediaSlot(bubble, slot) {
  const path = slot.dataset.mdSrc;
  if (!path || !slot.isConnected) return;
  fetchMedia(path).then((url) => {
    if (!url || !slot.isConnected) return;
    const img = el("img", "md-img");
    img.src = url; // a data URL: no raw disk path in the page
    img.alt = slot.dataset.alt || path.split("/").pop() || "image";
    img.dataset.mdSrc = path;
    img.addEventListener("click", () => {
      // Every picture already in this message makes one gallery, inline and grid alike.
      const items = [...bubble.querySelectorAll("img.md-img, img.media-img")]
        .filter((node) => node.src && !node.hidden)
        .map((node) => ({ url: node.src, alt: node.alt }));
      openViewer(items, Math.max(0, items.findIndex((item) => item.url === img.src)));
    });
    slot.replaceWith(img);
  });
}

// A local picture written as Markdown keeps its place: md.js left a span with the path, filled here once the
// authenticated fetch returns a data URL. A failed fetch leaves the alt text; the rest of the message is untouched.
function hydrateInlineMedia(bubble, slots) {
  for (const slot of slots.slice(0, MAX_INLINE_MEDIA)) {
    const path = slot.dataset.mdSrc;
    if (!inlineMediaObserver || (path && mediaCache.has(path))) {
      loadInlineMediaSlot(bubble, slot);
      continue;
    }
    slot._loadInlineMedia = () => loadInlineMediaSlot(bubble, slot);
    inlineMediaObserver.observe(slot);
  }
}

// A web picture (https:) that fails to load becomes its alt text, styled like a local picture that could not be
// fetched, so a dead link leaves no broken-image icon. Inline data: pictures never fail this way and are left alone.
function webImageFallback(bubble) {
  for (const img of bubble.querySelectorAll("img.md-img")) {
    if (!/^https:/i.test(img.getAttribute("src") || "")) continue;
    const fallback = () => {
      if (!img.isConnected) return;
      const alt = el("span", "md-media-slot");
      alt.textContent = img.getAttribute("alt") || "image";
      img.replaceWith(alt);
    };
    img.addEventListener("error", fallback, { once: true }); // attached in the same task as the render: no miss
  }
}

function attachMedia(bubble, text) {
  // MEDIA: directives keep their place, like Markdown local pictures; bare paths still form the bottom grid.
  webImageFallback(bubble);
  inlineMediaTags(bubble);
  const placed = [...bubble.querySelectorAll("[data-md-src]")];
  const inline = new Set(placed.map((node) => node.dataset.mdSrc));
  const slots = placed.filter((node) => node.classList.contains("md-media-slot"));
  hydrateInlineMedia(bubble, slots);
  const bare = [...new Set(mediaPaths(text).map(localImagePath).filter(Boolean))]
    .filter((path) => !inline.has(path));
  const paths = bare.slice(0, MAX_INLINE_MEDIA); // the grid keeps the same per-message limit as the inline pictures
  if (paths.length) {
    const wrap = renderMedia(paths.map((path) => ({ path })));
    if (wrap) bubble.append(wrap);
    // fetchMedia is cached, so this reuses the thumbnail's own request.
    for (const path of paths) fetchMedia(path).then((url) => { if (url) hideMediaPath(bubble, path); });
  }
  showMediaLimit(bubble, Math.max(0, slots.length - MAX_INLINE_MEDIA) + Math.max(0, bare.length - paths.length));
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

// Saves the picture the viewer is showing. Its URL is already loadable by this page (a blob:, data: or same-origin
// address carrying the dashboard session), so it is fetched as-is and handed to the browser as a download.
const PICTURE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/heic": "heic" };
function pictureFileName(item, type) {
  const named = (text) => /^[^\\/]+\.[a-z0-9]{2,5}$/i.test(text || "") ? text : "";
  let fromUrl = "";
  try {
    const url = new URL(item.url, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      fromUrl = named(decodeURIComponent((url.searchParams.get("path") || url.pathname).split("/").pop() || ""));
    }
  } catch { /* not a parseable URL: fall through */ }
  return named((item.alt || "").trim()) || fromUrl || `picture.${PICTURE_EXT[type] || "png"}`;
}
async function downloadPicture(item, button) {
  if (button.classList.contains("busy")) return;
  button.classList.add("busy");
  try {
    const response = await fetch(item.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = pictureFileName(item, blob.type);
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch {
    showToast("Couldn't download that picture", "error");
  } finally {
    button.classList.remove("busy");
  }
}

// Full-screen viewer: swipe left/right (or arrow keys) between a reply's images, pinch or double-tap to zoom, tap to close.
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
  const saveBtn = el("button", "viewer-save");
  saveBtn.type = "button";
  saveBtn.setAttribute("aria-label", "Download picture");
  saveBtn.title = "Download";
  saveBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 20h14"/></svg>';
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    downloadPicture(items[index], saveBtn);
  });
  overlay.append(saveBtn);
  const backBtn = el("button", "viewer-save viewer-back");
  backBtn.type = "button";
  backBtn.setAttribute("aria-label", "Back");
  backBtn.title = "Back";
  backBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/></svg>';
  backBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
  overlay.append(backBtn);
  const show = () => {
    resetZoom(false); // each picture starts at 1x
    img.src = items[index].url;
    img.alt = items[index].alt;
    count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : "";
    // Warm the neighbours so the next step has its picture ready to slide in.
    if (items.length > 1) for (const d of [1, -1]) new Image().src = items[(index + d + items.length) % items.length].url;
  };
  // Changing picture is a plain carousel slide: the old picture and the new one move together, the old one off one
  // edge while the new one comes in from the other. The outgoing picture is a throwaway copy, so the real <img> keeps
  // its zoom handling; the slide uses the separate `translate` property so it never fights the zoom transform. The
  // new picture is decoded first so it never slides in blank. A quick second step finishes the first at once;
  // reduced motion swaps without moving.
  const SLIDE_MS = 280;
  const SLIDE_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
  let stepToken = 0;
  let ghost = null;
  const dropGhost = () => { if (ghost) { ghost.remove(); ghost = null; } };
  const step = async (delta) => {
    index = (index + delta + items.length) % items.length;
    const token = ++stepToken;
    img.getAnimations().forEach((a) => a.finish());
    dropGhost();
    if (!img.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) { show(); return; }
    const dir = delta > 0 ? 1 : -1;
    const from = img.getBoundingClientRect();
    const old = img.cloneNode(false);
    old.removeAttribute("style");
    old.className = "viewer-ghost";
    old.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px`;
    const preload = new Image();
    preload.src = items[index].url;
    try { await preload.decode(); } catch { /* broken or slow: slide it in anyway */ }
    if (token !== stepToken || closed) return;
    ghost = old;
    overlay.append(ghost);
    show();
    const width = overlay.clientWidth;
    ghost.animate([{ translate: "0 0" }, { translate: `${-dir * width}px 0` }], { duration: SLIDE_MS, easing: SLIDE_EASE, fill: "forwards" })
      .finished.then(() => { if (ghost === old) dropGhost(); }, () => {});
    img.animate([{ translate: `${dir * width}px 0` }, { translate: "0 0" }], { duration: SLIDE_MS, easing: SLIDE_EASE });
  };
  const teardown = () => {
    closed = true;
    clearTimeout(tapTimer);
    dropGhost();
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
  // Touch gestures. Pinch zooms around the fingers (1x to 5x); one finger pans a zoomed picture; a double tap zooms in
  // on that spot or back out. At 1x a swipe changes picture and a single tap closes, as before. The picture's
  // transform is translate(tx, ty) scale(scale) around its centre, which is the overlay's centre.
  const MAX_ZOOM = 5;
  const DOUBLE_TAP_ZOOM = 2.5;
  const DOUBLE_TAP_MS = 250;
  let scale = 1, tx = 0, ty = 0;
  let gesture = null; // { mode: "pinch" | "pan" | "swipe", ... } while fingers are down
  let suppressClickUntil = 0; // a pinch, pan or swipe must not also count as a tap
  let lastTouchEnd = 0;
  let tapTimer = null;
  const centre = () => {
    const r = overlay.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  };
  // Keep the zoomed picture covering the screen: it can move only as far as its own overflow.
  const clampPan = () => {
    const c = centre();
    const maxX = Math.max(0, (img.offsetWidth * scale - c.w) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - c.h) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  };
  const apply = (ease) => {
    img.classList.toggle("easing", ease === true);
    img.style.transform = scale === 1 && tx === 0 && ty === 0 ? "" : `translate(${tx}px, ${ty}px) scale(${scale})`;
    overlay.classList.toggle("zoomed", scale > 1);
  };
  const resetZoom = (ease) => { scale = 1; tx = 0; ty = 0; apply(ease); };
  // Zoom to `next`, keeping the picture point under (px, py) where it is.
  const zoomAt = (next, px, py, ease) => {
    const c = centre();
    const qx = (px - c.x - tx) / scale, qy = (py - c.y - ty) / scale;
    scale = Math.min(MAX_ZOOM, Math.max(1, next));
    tx = px - c.x - qx * scale;
    ty = py - c.y - qy * scale;
    if (scale === 1) { tx = 0; ty = 0; }
    clampPan();
    apply(ease);
  };
  const pinchOf = (touches) => {
    const a = touches[0], b = touches[1];
    return { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  };
  const beginOne = (touch) => {
    gesture = { mode: scale > 1 ? "pan" : "swipe", x: touch.clientX, y: touch.clientY, tx, ty, moved: false };
  };
  overlay.addEventListener("touchstart", (event) => {
    if (event.target.closest(".viewer-arrow, .viewer-save")) return;
    if (event.touches.length >= 2) {
      const p = pinchOf(event.touches);
      const c = centre();
      gesture = { mode: "pinch", d: p.d, scale, qx: (p.x - c.x - tx) / scale, qy: (p.y - c.y - ty) / scale };
      clearTimeout(tapTimer); tapTimer = null;
    } else beginOne(event.touches[0]);
  }, { passive: true });
  overlay.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    if (gesture.mode === "pinch" && event.touches.length >= 2) {
      const p = pinchOf(event.touches);
      const c = centre();
      scale = Math.min(MAX_ZOOM, Math.max(1, gesture.scale * (p.d / gesture.d)));
      tx = p.x - c.x - gesture.qx * scale;
      ty = p.y - c.y - gesture.qy * scale;
      clampPan();
      apply(false);
    } else if (gesture.mode === "pan" && event.touches.length === 1) {
      const t = event.touches[0];
      const dx = t.clientX - gesture.x, dy = t.clientY - gesture.y;
      if (Math.hypot(dx, dy) > 6) gesture.moved = true;
      tx = gesture.tx + dx;
      ty = gesture.ty + dy;
      clampPan();
      apply(false);
    }
  }, { passive: true });
  const endTouch = (event) => {
    lastTouchEnd = Date.now();
    if (!gesture) return;
    if (gesture.mode === "pinch") {
      suppressClickUntil = Date.now() + 400;
      if (scale < 1.05) resetZoom(true);
      // One finger still down after a pinch: it carries on as a pan (never as a swipe to the next picture).
      if (event.touches.length === 1) { beginOne(event.touches[0]); gesture.mode = "pan"; gesture.moved = true; }
      else if (event.touches.length === 0) gesture = null;
      return;
    }
    if (event.touches.length > 0) return;
    const done = gesture;
    gesture = null;
    if (done.mode === "pan") {
      if (done.moved) suppressClickUntil = Date.now() + 400;
      return;
    }
    if (event.type === "touchcancel" || items.length < 2) return;
    const dx = event.changedTouches[0].clientX - done.x;
    if (Math.abs(dx) > 40) {
      suppressClickUntil = Date.now() + 400;
      step(dx < 0 ? 1 : -1);
    }
  };
  overlay.addEventListener("touchend", endTouch);
  overlay.addEventListener("touchcancel", endTouch);
  overlay.addEventListener("click", (event) => {
    if (event.target.closest(".viewer-arrow, .viewer-save")) return;
    if (Date.now() < suppressClickUntil) return;
    // A mouse click closes at once. A touch tap waits a moment for a second tap: two taps zoom, one closes.
    if (Date.now() - lastTouchEnd > 500) { close(); return; }
    if (tapTimer) {
      clearTimeout(tapTimer); tapTimer = null;
      if (scale > 1) resetZoom(true);
      else zoomAt(DOUBLE_TAP_ZOOM, event.clientX, event.clientY, true);
      return;
    }
    tapTimer = setTimeout(() => { tapTimer = null; close(); }, DOUBLE_TAP_MS);
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
    const row = el("div", "msg assistant msg-in");
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
    state.turn = { row, bubble, content, status, text: "", raf: 0, timer: 0, lastPaint: 0, narrationVisible: false, narration };
    paintTurn(state.turn);
  }
  return state.turn;
}

function paintTurn(turn) {
  const near = nearBottom();
  turn.content.textContent = "";
  if (turn.text) {
    turn.content.insertAdjacentHTML("beforeend", renderMarkdown(displayText(turn.text, { streaming: state.streaming })));
    enhance(turn.content);
  }
  const treeHidesWait = Boolean(
    state.streaming
    && typeof activity !== "undefined"
    && activity.hasActiveTree()
    && !turn.text
    && !(turn.narrationVisible && turn.narration.textContent)
  );
  turn.status.hidden = !state.streaming || treeHidesWait;
  turn.row.hidden = treeHidesWait;
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
  state.hiddenTurn = false;
  state.stream = null;
  state.sealedSegment = ""; // the bubble a tool round closed belongs to this turn only
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
    turn.text = displayText(turn.text);
    paintTurn(turn);
    turn.status.remove(); // the finished reply keeps only its text
    if (turn.text) {
      turn.row.hermesMiniMsg.text = turn.text;
      attachMedia(turn.bubble, turn.text);
      if (!turn.row.querySelector(":scope > .msg-actions")) addMessageActions(turn.row);
      if (activity.hasPendingAnchor()) {
        activity.attachBubbleAnchor({ rowEl: turn.row, text: turn.text, rowId: turn.row.hermesMiniMsg.rowId });
      }
      // A reply that just finished on screen has no row id yet; the Inbox still counts it as seen.
      if (!Number.isInteger(turn.row.hermesMiniMsg.rowId) && !state.readOnly && state.storedId) {
        const finishSid = state.storedId;
        resolveRowId(turn.row, 3, finishSid).then((rowId) => {
          if (Number.isInteger(rowId) && rowId > 0) {
            markInboxRead(rowId, { immediate: true });
            if (turn.row.isConnected) watchInboxRow(turn.row);
          }
        }).catch(() => {});
      }
    }
  }
  state.stoppedByUser = false;
  state.turn = null;
  updateComposer();
  // A reply that finished on screen is read. One that finished while the app was in the background is not: the page
  // keeps running for a while after it is left, and nobody saw the reply. Coming back to the app marks it.
  if (!state.viewedUnsent && pageVisible()) drawerApi.markSeen(state.viewedId);
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
  ["run_command", "Working…"],
  ["terminal", "Working…"],
  ["web_search", "Searching the web…"],
  ["x_search", "Searching the web…"],
  ["web_extract", "Reading a webpage…"],
  ["web_fetch", "Reading a webpage…"],
  ["browser_", "Looking at a webpage…"],
  ["read_file", "Reading a file…"],
  ["write_file", "Updating a file…"],
  ["patch", "Updating a file…"],
  ["skill_view", "Reading a skill…"],
  ["skills_list", "Looking through your skills…"],
  ["skill_manage", "Updating skills…"],
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
  if (activity.onStatusLine(text)) return;
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

// The status.update text worth showing a person, or "" (tui_gateway: _status_update, session_auto_continue).
function statusLine(payload) {
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text || text.length > 120 || text.includes("\n")) return "";
  if (payload.kind === "compacting") return "Summarizing the earlier conversation…"; // Hermes' own line is too long here
  if (payload.kind === "process" && /^Resuming interrupted turn\b/.test(text)) return text;
  return "";
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
  // A draft has no runtime either: ignore every chat event, including un-keyed ones.
  if (state.viewedUnsent && !state.liveSid) return;
  if (event.session_id && state.liveSid && event.session_id !== state.liveSid) return;
  if (type === "session.info") {
    modelUi.setInfo(payload);
    return;
  }

  switch (type) {
    case "message.start": {
      // The same turn's start sent again (a re-sent frame): the turn on screen is that turn, keep it.
      if (payload.turn_id && state.streaming && state.stream && state.stream.turnId === payload.turn_id) break;
      state.stream = { turnId: payload.turn_id || null, segment: 0, applied: 0 };
      // A turn this device did not submit: the message came from another device (phone, computer, terminal). Hermes
      // sends no event with its text, so fetch it from the saved chat and show it.
      const local = Date.now() - (state.localStartAt || 0) < 20000;
      state.localStartAt = 0;
      // A hidden turn (display_kind "hidden": model-facing scaffolding such as a diagnostic check) is never drawn; the
      // saved chat skips it too, so drawing it live made a reply that vanished on reload.
      state.hiddenTurn = payload.display_kind === "hidden";
      if (!local && !state.hiddenTurn) void showRemoteUserMessage();
      state.streaming = true;
      state.sealedSegment = "";
      state.stoppedByUser = false;
      activity.startTurn(payload.turn_id || null);
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
      if (state.hiddenTurn) {
        updateComposer();
        break;
      }
      const chunk = streamChunk(state.stream, payload);
      if (chunk.seal) sealSegment();
      if (!chunk.text) {
        updateComposer();
        break;
      }
      const turn = ensureTurn();
      if (activity.hasActiveTree()) activity.finalizeActiveForBubble({ rowEl: turn.row });
      // Assistant text has started: the narration line steps aside until the next tool round.
      hideNarration();
      turn.text += chunk.text;
      scheduleTurnPaint(turn);
      updateComposer();
      break;
    }
    case "message.complete": {
      const text = typeof payload.text === "string" && payload.text.trim() ? payload.text : null;
      if (state.hiddenTurn || (text && isSilenceMarker(text))) {
        // A hidden turn, or "NO_REPLY" and friends (the agent chose not to answer, usually a background-task
        // check-in): show nothing.
        const hidden = state.hiddenTurn;
        // Nothing will ever anchor these outlines to a reply: drop a hidden turn's outline with its DOM, and close a
        // silent completion in place so no spinner is left behind.
        if (hidden) activity.abandonActive({ removeDom: true });
        else if (activity.hasActiveTree()) activity.finalizeActiveForBubble({ rowEl: null, expectReply: false });
        const turn = state.turn;
        if (turn && turn.row) turn.row.remove();
        state.turn = null;
        finishTurn();
        if (!hidden) inbox.messageComplete(); // a finished turn is new Inbox activity
        break;
      }
      // The final text is the last segment only. When it repeats the bubble a tool round already closed (no text came
      // after the tools), or there is none, the trailing row holds just the typing dots and is dropped.
      const repeat = text && state.sealedSegment && squashSpace(displayText(text)) === squashSpace(state.sealedSegment);
      // A reply drawn from inflight after a reload holds the earlier segments too; keep it when it already ends with
      // the final text.
      const seededTail = text && state.turn && state.turn.seeded &&
        squashSpace(displayText(state.turn.text)).endsWith(squashSpace(displayText(text)));
      if (text && !repeat && !seededTail) {
        if (activity.hasActiveTree()) {
          activity.finalizeActiveForBubble({ rowEl: ensureTurn().row, matchText: displayText(text) });
        }
        ensureTurn().text = text;
      } else if (seededTail && state.turn) {
        // The reply is already on screen from inflight; finishTurn()'s attachBubbleAnchor then pins the outline to this
        // row by text and durable row id instead of guessing from the sealed segment.
        if (activity.hasActiveTree()) {
          activity.finalizeActiveForBubble({ rowEl: state.turn.row });
        }
      } else if (activity.hasActiveTree()) {
        if (state.stoppedByUser || payload.status === "aborted" || payload.status === "cancelled") {
          activity.markStopped({ afterEl: lastLogBubbleRow(), showNote: !text || Boolean(repeat) });
        } else {
          activity.finalizeActiveForBubble({ rowEl: null, expectReply: false });
        }
        if (state.sealedSegment && state.turn && !state.turn.text.trim()) {
          state.turn.row.remove();
          state.turn = null;
        }
      } else if (state.sealedSegment && state.turn && !state.turn.text.trim()) {
        state.turn.row.remove();
        state.turn = null;
      }
      if (typeof payload.warning === "string" && payload.warning) sysLine(failureText(payload.warning));
      // A failed turn with no text: say so instead of leaving the message with no reply at all.
      if (!text && payload.status === "error") sysLine(turnFailureText(payload.error));
      finishTurn();
      inbox.messageComplete(); // refresh the Inbox head and badge
      break;
    }
    case "message.interim": {
      // Commentary beside tool calls. Streamed text is already on screen, so this only closes its bubble; text that
      // was not streamed is drawn as its own finished bubble. Either way the next text starts a new bubble.
      const stream = state.stream;
      if (stream && typeof payload.segment === "number" && (!payload.turn_id || payload.turn_id === stream.turnId)) {
        if (payload.segment < stream.segment) break; // a seal already applied, sent again
        stream.segment = payload.segment + 1;
        stream.applied = 0;
      }
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text || isSilenceMarker(text) || state.hiddenTurn) break;
      if (!payload.already_streamed) {
        sealSegment();
        const interimTurn = ensureTurn();
        if (activity.hasActiveTree()) {
          activity.finalizeActiveForBubble({ rowEl: interimTurn.row, matchText: displayText(text) });
        }
        interimTurn.text = text;
      } else if (activity.hasActiveTree()) {
        const interimTurn = ensureTurn();
        activity.finalizeActiveForBubble({ rowEl: interimTurn.row, matchText: displayText(text) });
      }
      sealSegment();
      if (state.streaming) ensureTurn();
      touchTurn();
      break;
    }
    case "error": {
      if (activity.hasActiveTree()) {
        if (state.stoppedByUser) activity.markStopped({ afterEl: lastLogBubbleRow(), showNote: true });
        else activity.finalizeActiveForBubble({ rowEl: null, expectReply: false });
      }
      sysLine(failureText(payload.message || "Something went wrong."));
      finishTurn();
      break;
    }
    case "tool.start": {
      if (state.hiddenTurn) break;
      // Tool names are never shown. Text written before the tool becomes its own bubble (sealSegment).
      sealSegment();
      const turn = state.turn || (state.streaming ? ensureTurn() : null);
      const label = narrationLabel(payload.name);
      activity.ensureActiveTree({
        insertBefore: turn ? turn.row : null,
        afterEl: lastLogBubbleRow(),
        turnId: state.stream?.turnId || null,
        label,
      });
      activity.onToolStart(payload.name, payload.args, label, payload);
      if (state.turn) paintTurn(state.turn);
      touchTurn();
      break;
    }
    case "tool.complete": {
      if (state.hiddenTurn) break;
      // Hermes drains pending steers at the end of a tool batch; steers sent after the last tool.complete roll over
      // to the next turn and keep hermesMiniSteer=true so showRemoteUserMessage moves them below the finished reply.
      for (const node of chatRows()) if (node.hermesMiniSteer) node.hermesMiniSteer = false;
      activity.onToolComplete(payload.name, payload.args, payload.summary || "", payload);
      touchTurn();
      break;
    }
    case "reasoning.delta":
    case "thinking.delta": {
      if (state.hiddenTurn) break;
      if (typeof payload.text === "string" && payload.text) {
        activity.onThinking(payload.text);
      }
      touchTurn();
      break;
    }
    case "tool.progress":
      touchTurn();
      break;
    case "status.update": {
      if (state.hiddenTurn) break;
      // Most status lines (heartbeats, goal and loop verdicts, process notices) stay hidden. Compaction and a resumed
      // turn show in the narration line, so a long pause reads as work instead of a hung reply.
      const line = statusLine(payload);
      if (line && state.streaming) showNarration(line, ensureTurn());
      touchTurn();
      break;
    }
    case "connection.request":
    case "connection.update":
      showConnection(payload);
      touchTurn();
      break;
    case "request.cancel": {
      // A withdrawn request stays as the record of what happened: resolved cards are left alone, an unanswered one is
      // kept in place with the closed look.
      const card = payload.id ? state.cards.get(payload.id) : null;
      if (!card || card.resolved) break;
      if (card.method === "clarify") resolveClarify(card, "cancelled");
      else if (card.method === "approval") resolveApproval(card, null);
      else if (promptCards.isPromptMethod(card.method)) resolvePromptCard(card, "cancelled");
      break;
    }
    case "approval.cancelled": {
      // Hermes dropped pending approvals (interrupt, reap, teardown) and resolved them as deny. It is a broadcast, so
      // match this chat; an open card for a dropped request closes the same way as request.cancel.
      if (!isThisChat(payload)) break;
      const ids = new Set(Array.isArray(payload.request_ids) ? payload.request_ids.map(String) : []);
      for (const card of state.cards.values()) {
        if (card.resolved || card.method !== "approval") continue;
        // No ids at all (entries without one): every open approval card of this chat was dropped.
        if (!ids.size || ids.has(String(card.params.request_id || ""))) resolveApproval(card, null);
      }
      break;
    }
    case "session.reclaimed": {
      // Hermes closed this chat's live session (idle timeout, eviction, orphan reap) while the socket stayed open.
      if (isThisChat(payload)) void reattachChat();
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

// A broadcast (session-less) frame names its chat in the payload: the live runtime id or the stored chat id.
function isThisChat(payload) {
  const sid = String(payload.session_id || "");
  const stored = String(payload.stored_session_id || "");
  return Boolean((sid && sid === state.liveSid) || (stored && stored === state.storedId));
}

function updateComposer() {
  const busy = state.streaming;
  const dictating = Boolean(state.dictating || state.transcribing);
  // While the agent works, typed text steers her: the button stays Send. It turns into Stop only when
  // the box is empty and dictation is not active, so a running task can still be stopped. A draft with a skill pill
  // cannot steer (skills go with a new message), so it keeps Stop until the reply is done.
  const stopMode = busy && (!els.input.value.trim() || draftSkills().length > 0) && !dictating;
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
  els.log.classList.toggle("busy", busy); // style.css keeps a disabled Edit visible, faded, while a reply streams
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
  hideNarration();
  closeTurnRow(turn);
}

// A tool round closes the bubble written so far, and later text starts a new bubble: the same split a reload draws
// from history, which keeps one bubble per stored assistant row. The turn keeps running; the next row takes the
// typing dots and the narration line. Returns whether a bubble was closed.
function sealSegment() {
  const turn = state.turn;
  if (!turn || !turn.text.trim()) return false;
  state.sealedSegment = displayText(turn.text);
  closeTurnRow(turn);
  if (activity.hasPendingAnchor()) {
    activity.attachBubbleAnchor({ rowEl: turn.row, text: state.sealedSegment, rowId: turn.row.hermesMiniMsg?.rowId });
  }
  return true;
}

// Ends the live row of a turn as a finished bubble (or drops it when it holds only the typing dots) and lets go of
// state.turn, so the next ensureTurn() starts a new row below it.
function closeTurnRow(turn) {
  if (turn.raf) cancelAnimationFrame(turn.raf);
  if (turn.timer) clearTimeout(turn.timer);
  turn.raf = 0;
  turn.timer = 0;
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

// Only answers Hermes received count: one held for Submit and never sent shows as the card's outcome says.
function resolveClarify(entry, outcome, notice) {
  if (!entry || entry.resolved) return;
  entry.resolved = true;
  const { flow } = entry;
  fillResolvedClarify(
    entry.el,
    flow.questions.map((question) => {
      const value = flow.answers[question.qid];
      if (flow.sent.has(question.qid) && value !== undefined) {
        if (value === null) return { question: question.question, status: "skipped" };
        return { question: question.question, status: "answered", value: clarifyAnswerText(value) };
      }
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
    } else if (promptCards.isPromptMethod(card.method)) {
      // An empty answer closes the prompt; a steer that never carried the value is no answer at all.
      answerServerRequest(id, promptCards.buildPromptResult(card.method, null));
      resolvePromptCard(card, "sent_instead");
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

// Answers an open server request without a preceding RPC (clarify's result frame, and cancel-all). Returns whether
// the frame went out; a caller that shows "sent" checks it.
function answerServerRequest(id, result) {
  try {
    sendFrame({ jsonrpc: "2.0", id, result });
    return true;
  } catch {
    /* connection gone: the backend withdraws the request itself */
    return false;
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
  if (promptCards.isPromptMethod(method)) {
    showPromptCard(id, method, params);
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

// A password, secret or vault prompt: what Hermes asked for, one field per value (masked when it is a secret),
// and Submit / Skip. The values live in the card only long enough to be sent: submit and skip clear every input
// first, and the answered card drops its fields so no masked value stays in the DOM.
function showPromptCard(id, method, params) {
  const spec = promptCards.describePrompt(method, params);
  if (!spec) {
    rejectServerRequest(id, -32601, "no handler for server request: " + method);
    return;
  }
  const card = el("div", "card prompt-card");
  const entry = { el: card, method, params, spec, resolved: false };
  card.append(el("h2", "", spec.title));
  if (spec.subtitle) card.append(el("p", "prompt-subtitle", spec.subtitle));
  if (spec.badge) {
    const meta = el("div", "prompt-meta");
    meta.append(el("span", "prompt-badge", spec.badge));
    card.append(meta);
  }
  if (spec.description) card.append(el("p", "", spec.description));
  if (spec.command) card.append(el("pre", "", spec.command));
  if (spec.helpUrl) {
    const help = el("p", "prompt-help");
    const link = el("a", "", "Documentation / setup link");
    link.href = spec.helpUrl;
    link.target = "_blank";
    link.rel = "noopener";
    help.append(link);
    card.append(help);
  } else if (spec.helpText) {
    card.append(el("p", "prompt-help", spec.helpText));
  }

  const fields = el("div", "prompt-fields");
  const inputs = [];
  const currentValues = () => {
    const values = {};
    for (const item of inputs) values[item.name] = item.input.value;
    return values;
  };

  for (const field of spec.fields) {
    const wrap = el("div", "prompt-field");
    wrap.append(el("label", "", field.label));
    const box = el("div", "prompt-input-wrap");
    const input = el("input");
    input.type = field.masked ? "password" : "text";
    input.placeholder = field.placeholder || "";
    input.autocomplete = field.autocomplete || "off";
    input.setAttribute("autocapitalize", "off");
    input.spellcheck = false;
    box.append(input);
    if (field.masked) {
      const eye = el("button", "btn prompt-eye", "Show");
      eye.type = "button";
      eye.setAttribute("aria-label", "Show value");
      eye.setAttribute("aria-pressed", "false");
      eye.addEventListener("click", () => {
        const shown = input.type === "text";
        input.type = shown ? "password" : "text";
        eye.textContent = shown ? "Show" : "Hide";
        eye.setAttribute("aria-label", shown ? "Show value" : "Hide value");
        eye.setAttribute("aria-pressed", shown ? "false" : "true");
      });
      box.append(eye);
    }
    wrap.append(box);
    fields.append(wrap);
    inputs.push({ name: field.name, input });
  }
  card.append(fields);

  const actions = el("div", "actions");
  const skip = el("button", "btn", spec.skipLabel);
  skip.type = "button";
  const submit = el("button", "btn primary", spec.submitLabel);
  submit.type = "button";
  actions.append(skip, submit);
  card.append(actions);

  const failed = el("p", "prompt-error", PROMPT_NOT_SENT);
  failed.hidden = true;
  card.append(failed);
  const syncSubmit = () => {
    submit.disabled = promptCards.buildPromptResult(method, currentValues()) === null;
  };
  for (const item of inputs) {
    item.input.addEventListener("input", () => {
      failed.hidden = true;
      syncSubmit();
    });
    item.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const at = inputs.indexOf(item);
      if (at < inputs.length - 1) inputs[at + 1].input.focus();
      else if (!submit.disabled) submit.click();
    });
  }
  syncSubmit();

  const finish = (result, kind) => {
    if (entry.resolved) return;
    for (const item of inputs) item.input.value = "";
    if (!answerServerRequest(id, result)) {
      // Nothing reached Hermes: the card stays open (values cleared, as after a send) so it can be answered again
      // once the connection is back. If Hermes withdrew the request meanwhile, the reattach removes the card.
      failed.hidden = false;
      syncSubmit();
      return;
    }
    skip.disabled = true;
    submit.disabled = true;
    resolvePromptCard(entry, kind);
  };
  submit.addEventListener("click", () => {
    if (entry.resolved) return;
    const result = promptCards.buildPromptResult(method, currentValues());
    if (result) finish(result, "sent");
  });
  skip.addEventListener("click", () => finish(promptCards.buildPromptResult(method, null), "skipped"));

  setEmptyState(false);
  sealTurnForCard();
  els.log.append(card);
  state.cards.set(id, entry);
  scrollToBottom(true);
}

const PROMPT_NOT_SENT = "Not sent — the connection dropped. Enter it again once it's back.";

// Answered: the fields and buttons go, and the card keeps only how it ended.
function resolvePromptCard(entry, kind, customNotice) {
  if (!entry || entry.resolved) return;
  entry.resolved = true;
  entry.el.classList.add("resolved");
  const fields = entry.el.querySelector(".prompt-fields");
  if (fields) fields.remove();
  const actions = entry.el.querySelector(".actions");
  if (actions) actions.remove();
  const spec = entry.spec;
  const outcome =
    customNotice ||
    (kind === "sent"
      ? spec.sentOutcome
      : kind === "skipped"
        ? spec.skippedOutcome
        : kind === "sent_instead"
          ? spec.sentInsteadOutcome
          : spec.cancelledOutcome);
  entry.el.append(el("p", "resolved-outcome", outcome));
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
  const entry = { el: card, method: "clarify", params, flow: clarifyFlow.startFlow(questions, locked), busy: false };
  state.cards.set(id, entry);
  renderClarify(id, entry);
  scrollToBottom(true);
}

// A multi-select question takes one choice here, sent as a one-item list.
function clarifyWireValue(question, answer) {
  return question.multi_select ? JSON.stringify([answer]) : answer;
}

// One question at a time. Skip answers just this question; Back reopens the one before (or, after a Change,
// the review). A set of two or more ends on a review step, and nothing in it is final until Submit.
function renderClarify(id, entry) {
  if (entry.flow.reviewing) {
    renderClarifyReview(id, entry);
    return;
  }
  const { el: card, flow } = entry;
  card.replaceChildren();
  const question = clarifyFlow.currentQuestion(flow);
  const total = flow.questions.length;
  card.append(el("h2", "", total > 1 ? `Question ${flow.index + 1} of ${total}` : "Question"));
  card.append(el("p", "", question.question));

  // A reopened question shows its earlier answer: the matching choice is marked, typed text refills the box.
  const previous = clarifyFlow.currentAnswer(flow);
  const previousText = previous === undefined || previous === null ? "" : clarifyAnswerText(previous);
  const choices = Array.isArray(question.choices) ? question.choices.filter((c) => typeof c === "string") : [];
  if (question.multi_select) {
    renderMultiSelect(id, entry, question, choices, previous);
    return;
  }
  let matched = false;
  if (choices.length) {
    const actions = el("div", "actions");
    for (const choice of choices) {
      const button = el("button", "btn", choice);
      if (previousText && bareChoice(choice) === previousText) {
        button.classList.add("chosen");
        button.setAttribute("aria-pressed", "true");
        matched = true;
      }
      button.addEventListener("click", () => {
        void answerClarify(id, entry, clarifyWireValue(question, bareChoice(choice)));
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
  if (previousText && !matched) input.value = previousText;
  const send = el("button", "btn primary", "Send");
  row.append(clarifyAnswerField(input, send), send);
  card.append(row);

  card.append(clarifyNavRow(id, entry));

  const submitText = () => {
    const text = input.value.trim();
    if (text) void answerClarify(id, entry, clarifyWireValue(question, text));
  };
  send.addEventListener("click", submitText);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submitText();
    }
  });
}

// Back (to the previous question, or to the review after a Change) and Skip, shared by both kinds of question.
function clarifyNavRow(id, entry) {
  const { flow } = entry;
  const actions = el("div", "actions");
  if (flow.returnToReview || flow.index > 0) {
    const back = el("button", "btn", "Back");
    back.addEventListener("click", () => {
      if (entry.busy) return;
      if (flow.returnToReview) clarifyFlow.backToReview(flow);
      else clarifyFlow.goBack(flow);
      renderClarify(id, entry);
    });
    actions.append(back);
  }
  const skip = el("button", "btn", "Skip");
  skip.addEventListener("click", () => void answerClarify(id, entry, null));
  actions.append(skip);
  return actions;
}

// The earlier answer of a multi-select question as a list (it is sent as a JSON list; a plain string is one item).
function clarifyPicks(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* typed text */
  }
  return [String(value)];
}

// "Pick any that apply": a tap toggles a choice, typed text is one more item, and the primary button sends the list
// (Next when a review follows, else Send). Nothing is sent until that button.
function renderMultiSelect(id, entry, question, choices, previous) {
  const { el: card, flow } = entry;
  const earlier = clarifyPicks(previous);
  const picked = new Set(earlier.filter((item) => choices.some((choice) => bareChoice(choice) === item)));
  const typedBefore = earlier.filter((item) => !picked.has(item)).join(", ");
  card.append(el("p", "clarify-hint", "Pick any that apply."));
  const input = el("input");
  const send = el("button", "btn primary", clarifyFlow.hasReview(flow) ? "Next" : "Send");
  const refresh = () => {
    send.disabled = picked.size === 0 && !input.value.trim();
  };
  if (choices.length) {
    const options = el("div", "actions");
    for (const choice of choices) {
      const value = bareChoice(choice);
      const button = el("button", "btn", choice);
      const mark = () => {
        button.classList.toggle("chosen", picked.has(value));
        button.setAttribute("aria-pressed", picked.has(value) ? "true" : "false");
      };
      mark();
      button.addEventListener("click", () => {
        if (picked.has(value)) picked.delete(value);
        else picked.add(value);
        mark();
        refresh();
      });
      options.append(button);
    }
    card.append(options);
  }
  const row = el("div", "answer-row");
  input.type = "text";
  input.placeholder = choices.length ? "Add your own (optional)" : "Type an answer";
  input.enterKeyHint = "send";
  input.value = typedBefore;
  row.append(clarifyAnswerField(input, send), send);
  card.append(row);
  card.append(clarifyNavRow(id, entry));
  const submit = () => {
    const items = [...picked];
    const typed = input.value.trim();
    if (typed) items.push(typed);
    if (items.length) void answerClarify(id, entry, JSON.stringify(items));
  };
  send.addEventListener("click", submit);
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  refresh();
}

function renderClarifyReview(id, entry) {
  const { el: card, flow } = entry;
  card.replaceChildren();
  card.append(el("h2", "", "Your answers"));
  for (const [index, row] of clarifyFlow.answerRows(flow).entries()) {
    card.append(el("p", "resolved-question", row.question));
    const line = el("div", "review-answer");
    const skipped = row.status !== "answered";
    line.append(el("span", skipped ? "resolved-value resolved-note" : "resolved-value", skipped ? "Skipped" : clarifyAnswerText(row.value)));
    const change = el("button", "review-change", "Change");
    change.setAttribute("aria-label", `Change the answer to question ${index + 1}`);
    change.addEventListener("click", () => {
      if (entry.busy) return;
      clarifyFlow.changeAnswer(flow, index);
      renderClarify(id, entry);
    });
    line.append(change);
    card.append(line);
  }
  const actions = el("div", "actions");
  const submit = el("button", "btn primary", "Submit");
  submit.addEventListener("click", () => void runClarifyStep(id, entry, clarifyFlow.submitLocks));
  actions.append(submit);
  card.append(actions);
}

function answerClarify(id, entry, value) {
  return runClarifyStep(id, entry, (flow) => clarifyFlow.answerCurrent(flow, value));
}

// Applies one step to the flow and sends the locks it hands back. The lock that leaves nothing unanswered ends
// the set. A failed send puts the card back as it was, so the same tap can be tried again.
async function runClarifyStep(id, entry, step) {
  if (entry.busy || entry.resolved) return;
  entry.busy = true;
  const { flow } = entry;
  const saved = clarifyFlow.saveState(flow);
  const locks = step(flow);
  try {
    let remaining = null;
    for (const lock of locks) {
      const reply = await rpc("clarify.lock", { request_id: id, question_id: lock.qid, answer: lock.value });
      // The wait itself ended (expired): this answer was not taken, and the card closes as it stood.
      if (reply.status === "expired") {
        flow.sent.delete(lock.qid);
        resolveClarify(entry, "cancelled");
        return;
      }
      remaining = Array.isArray(reply.remaining) ? reply.remaining : [];
    }
    if (remaining !== null && remaining.length === 0) {
      resolveClarify(entry, "submitted");
      return;
    }
    // Hermes' own list of what is still open wins: anything it lacks is sent again on the next answer or Submit.
    if (remaining !== null) for (const qid of remaining) flow.sent.delete(qid);
    renderClarify(id, entry);
  } catch (error) {
    clarifyFlow.restoreState(flow, saved);
    renderClarify(id, entry);
    sysLine(`Could not send answer: ${errorText(error)}`);
  } finally {
    entry.busy = false;
  }
}

// ---------- "connect an app" card (manage_connections) ----------

// op_id -> { el, opId, payload, seq, resolved, busy }. Kept apart from state.cards: these are not server requests
// with a reply frame, they are answered through connection.respond.
const connCards = new Map();

// Opens the card, or brings it up to date. The first one for an operation splits the reply around it like the other
// cards; a settled operation leaves the card as a compact record.
function showConnection(payload) {
  const opId = typeof payload?.op_id === "string" ? payload.op_id : "";
  if (!opId || !Array.isArray(payload.targets)) return;
  let entry = connCards.get(opId);
  if (!entry) {
    if (conn.isSettled(payload)) return; // nothing to ask: the agent reports the outcome itself
    const card = el("div", "card connection");
    setEmptyState(false);
    sealTurnForCard();
    els.log.append(card);
    entry = { el: card, opId, payload, seq: Number(payload.seq), resolved: false, busy: false };
    connCards.set(opId, entry);
    scrollToBottom(true);
  } else {
    if (entry.resolved || !conn.isNewer(entry.seq, payload)) return;
    entry.payload = { ...entry.payload, ...payload };
    entry.seq = Number(payload.seq);
  }
  if (conn.isSettled(entry.payload)) entry.resolved = true;
  renderConnection(entry);
}

// After a reconnect: the operation Hermes still reports open comes back; any other open card is over.
function syncConnectionCards(pending) {
  for (const entry of connCards.values()) {
    if (entry.resolved || (pending && pending.op_id === entry.opId)) continue;
    entry.resolved = true;
    renderConnection(entry);
  }
  if (pending) showConnection(pending);
}

function renderConnection(entry) {
  const { el: card, payload } = entry;
  card.replaceChildren();
  card.classList.toggle("resolved", entry.resolved);
  card.append(el("h2", "", conn.cardTitle(payload)));
  for (const target of payload.targets) {
    const row = el("div", "conn-row");
    const text = el("div", "conn-text");
    text.append(el("span", "conn-name", conn.appName(target)));
    text.append(el("span", "conn-state", entry.resolved && !conn.isResolved(target) ? "Not connected" : conn.stateLabel(target)));
    row.append(text);
    if (!entry.resolved) {
      const buttons = el("div", "conn-buttons");
      for (const kind of conn.rowButtons(target)) {
        if (kind === "open") {
          const open = el("button", "btn primary", "Open");
          open.setAttribute("aria-label", `Sign in to ${conn.appName(target)}`);
          open.addEventListener("click", () => window.open(conn.openUrl(target), "_blank", "noopener"));
          buttons.append(open);
        } else if (kind === "allow") {
          const allow = el("button", "btn primary", "Allow");
          allow.addEventListener("click", () => void answerConnection(entry, conn.rowAnswer(target, "approved")));
          buttons.append(allow);
        } else {
          const skip = el("button", "btn", "Skip");
          skip.addEventListener("click", () => void answerConnection(entry, conn.rowAnswer(target, "skipped")));
          buttons.append(skip);
        }
      }
      if (buttons.childElementCount) row.append(buttons);
    }
    card.append(row);
  }
  if (!entry.resolved) {
    card.append(el("p", "conn-note", "Sign in, then come back here. The card updates by itself."));
    const actions = el("div", "actions");
    const done = el("button", "btn", "Done");
    done.addEventListener("click", () => void answerConnection(entry, conn.doneAnswer()));
    actions.append(done);
    card.append(actions);
  }
}

async function answerConnection(entry, result) {
  if (entry.busy || entry.resolved) return;
  entry.busy = true;
  for (const button of entry.el.querySelectorAll("button")) button.disabled = true;
  try {
    await rpc("connection.respond", {
      owner: { type: "session", session_id: state.liveSid },
      op_id: entry.opId,
      result,
    });
    // The card itself changes when Hermes sends the update that follows.
  } catch (error) {
    sysLine(`Could not send that: ${errorText(error)}`);
  } finally {
    entry.busy = false;
    if (!entry.resolved) for (const button of entry.el.querySelectorAll("button")) button.disabled = false;
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

let slashPicker = null; // the "/" picker (slash.js), set up with the draft pills below

function clearComposer() {
  // Object URLs stay alive here: a failed send restores these attachments and their thumbnails.
  els.input.value = "";
  autosize();
  state.attachments = [];
  state.pastes = [];
  state.mentions = [];
  renderTray();
  syncMentions();
  slashPicker?.close();
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

// ---------- schedule and skill pills in the draft ----------
// "Add to message", or a pick from the "/" picker (slash.js), puts an em space and the name at the caret. A layer laid exactly over the textarea (same box, font and
// wrapping, text invisible, pointer-events off) paints a pill under each mention and the clock icon over its em space,
// so it looks the way the sent bubble draws it (appendWithSchedules). A skill's pill has a bolt instead (kind "skill").
// Backspace right after a mention removes all of it. On send each schedule becomes its full tag (expandMentions) and
// the skills are sent through Hermes's skill command (skillSend).
const mentionLayer = el("div", "mention-layer");
mentionLayer.setAttribute("aria-hidden", "true");
els.input.closest(".row")?.append(mentionLayer);

function expandMentions(value) {
  let out = value;
  for (const m of [...state.mentions].sort((a, b) => b.token.length - a.token.length)) out = out.split(m.token).join(m.tag);
  return out;
}

function syncMentions() {
  const input = els.input;
  // Forget mentions whose text was edited away; an edited one is plain text from then on.
  if (state.mentions.length) state.mentions = state.mentions.filter((m) => input.value.includes(m.token));
  if (!state.mentions.length || !input.isConnected) {
    mentionLayer.hidden = true;
    return;
  }
  const cs = getComputedStyle(input);
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "borderLeftWidth", "boxSizing", "textIndent", "wordSpacing", "tabSize"]) mentionLayer.style[prop] = cs[prop];
  mentionLayer.style.left = `${input.offsetLeft}px`;
  mentionLayer.style.top = `${input.offsetTop}px`;
  mentionLayer.style.width = `${input.offsetWidth}px`;
  mentionLayer.style.height = `${input.offsetHeight}px`;
  const tokens = [...state.mentions].sort((a, b) => b.token.length - a.token.length).map((m) => m.token);
  mentionLayer.replaceChildren();
  const value = input.value;
  let i = 0;
  let plain = "";
  while (i < value.length) {
    const hit = tokens.find((token) => value.startsWith(token, i));
    if (!hit) {
      plain += value[i];
      i += 1;
      continue;
    }
    if (plain) mentionLayer.append(document.createTextNode(plain));
    plain = "";
    const mark = el("mark", "mention");
    const iconSpace = el("span", "mention-icon-space", MENTION_ICON_SPACE);
    const kind = state.mentions.find((m) => m.token === hit)?.kind;
    iconSpace.insertAdjacentHTML("beforeend", `<span class="mention-icon">${kind === "skill" ? SKILL_ICON : CLOCK_ICON}</span>`);
    mark.append(document.createTextNode(MENTION_LEAD), iconSpace, document.createTextNode(hit.slice(MENTION_LEAD.length + 1)));
    mentionLayer.append(mark);
    i += hit.length;
  }
  mentionLayer.append(document.createTextNode(`${plain}\u200b`)); // the zero-width tail keeps a trailing newline's line
  mentionLayer.scrollTop = input.scrollTop;
  mentionLayer.hidden = false;
}

// A mention in the textarea: thin space (the pill's left padding), em space (where the layer draws the clock), thin
// space (the gap before the name), the name, then thin + hair space (the right padding). Those widths match the sent
// pill's padding (style.css .sched-pill), and nobody types that run, so the token stays unique.
const MENTION_LEAD = "\u2009";
const MENTION_ICON_SPACE = "\u2003";
const MENTION_MARK = `${MENTION_LEAD}${MENTION_ICON_SPACE}\u2009`;
const MENTION_TRAIL = "\u2009\u200a";

function addMention(job) {
  addPill({ kind: "schedule", title: String(job.title || "Schedule"), tag: mentionText(job), id: job.id });
}

// A skill from the "/" picker: the same pill with a bolt. Its tag is the "/name" Hermes knows it by.
function addSkillMention(name) {
  addPill({ kind: "skill", title: name, tag: `/${skillSlug(name)}`, id: "skill" });
}

function addPill({ kind, title, tag, id }) {
  let token = `${MENTION_MARK}${title}${MENTION_TRAIL}`;
  if (state.mentions.some((m) => m.token === token && m.tag !== tag)) token = `${MENTION_MARK}${title} (${id})${MENTION_TRAIL}`;
  if (!state.mentions.some((m) => m.token === token)) state.mentions.push({ token, tag, title, kind });
  // Plain spaces around it where it would touch a word, and always one after it at the end of the text, so the caret
  // lands outside the pill (the padding spaces count as whitespace for insertIntoComposer, so they are added here).
  const input = els.input;
  const before = input.selectionStart > 0 ? input.value.charAt(input.selectionStart - 1) : "";
  const after = input.value.charAt(input.selectionEnd);
  insertIntoComposer(`${before && !/\s/.test(before) ? " " : ""}${token}${!after || !/\s/.test(after) ? " " : ""}`);
  syncMentions();
}

// The mention just before the caret, if the caret sits right after one: Backspace removes it whole.
function mentionBeforeCaret() {
  const input = els.input;
  if (input.selectionStart !== input.selectionEnd) return null;
  const before = input.value.slice(0, input.selectionStart);
  return state.mentions.find((m) => before.endsWith(m.token)) || null;
}

els.input.addEventListener("beforeinput", (event) => {
  if (event.inputType !== "deleteContentBackward") return;
  const m = mentionBeforeCaret();
  if (!m) return;
  event.preventDefault();
  const input = els.input;
  const end = input.selectionStart;
  let start = end - m.token.length;
  // The plain spaces added around it would be left doubled: take the one before it too.
  if (start > 0 && input.value.charAt(start - 1) === " " && (end >= input.value.length || input.value.charAt(end) === " ")) start -= 1;
  input.setRangeText("", start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
els.input.addEventListener("scroll", () => {
  mentionLayer.scrollTop = els.input.scrollTop;
}, { passive: true });
window.addEventListener("resize", () => syncMentions());

// "/" in the message box: skills and schedules to pick from (slash.js), put in as pills. Not while a message is being
// edited (an edit resends plain text) or in a chat that cannot be written to.
slashPicker = createSlashPicker({
  input: els.input,
  anchor: els.input.closest(".row") || els.input,
  api,
  enabled: () => !state.readOnly && !els.input.disabled && !state.editing && !state.composerLocked,
  onPick: (item) => {
    if (item.kind === "skill") addSkillMention(item.name);
    else addMention(item.job);
    els.input.focus();
    updateComposer(); // a skill pill turns a steering Send back into Stop
  },
});

// The skills in the draft, in the order they appear: [{ token, name, title }] (name: the command Hermes knows).
function draftSkills(value = els.input.value) {
  return state.mentions
    .filter((m) => m.kind === "skill" && value.includes(m.token))
    .sort((a, b) => value.indexOf(a.token) - value.indexOf(b.token))
    .map((m) => ({ token: m.token, name: m.tag.slice(1), title: m.title }));
}

// A draft with skills, as Hermes's skill command takes it: the skills (at most five, Hermes's limit) and the words.
// Pills at the start are only the skills; one further on stays in the sentence as the skill's name ("use humanizer on
// this"), and is loaded all the same.
function skillDraft(value) {
  const skills = draftSkills(value);
  let rest = value;
  for (;;) {
    const trimmed = rest.replace(/^[ \t\r\n]+/, ""); // not \s: that would eat the pill's own thin spaces
    const lead = skills.find((skill) => trimmed.startsWith(skill.token));
    if (!lead) break;
    rest = trimmed.slice(lead.token.length);
  }
  for (const skill of skills) rest = rest.split(skill.token).join(skill.title);
  const names = [...new Set(skills.map((skill) => skill.name))].slice(0, 5);
  return { names, text: expandMentions(rest).trim() };
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
  if (state.streaming) return els.input.value.trim() && !draftSkills().length ? steer() : stop();
  if (state.sending) return;
  if (state.editing) return submitEdit();
  const drafted = expandPastes(els.input.value);
  // Skills in the draft: Hermes's skill command builds the message (each skill's instructions and the person's words).
  const skill = draftSkills(drafted).length ? skillDraft(drafted) : null;
  const text = skill ? skillLabel(skill) : expandMentions(drafted).trim();
  const attachments = state.attachments.slice();
  const saved = { text: els.input.value, attachments, pastes: state.pastes.slice(), mentions: state.mentions.slice() };
  if (!text && !attachments.length) return;
  if (!state.ready) {
    sysLine("Not connected yet. Try again in a moment.");
    return;
  }
  if (!state.liveSid) {
    if (!state.viewedUnsent) {
      sysLine("Not connected yet. Try again in a moment.");
      return;
    }
    // A New chat is a draft: the first message is what creates the real chat.
    state.sending = true;
    try {
      if (!await openFreshChat()) {
        state.sending = false;
        updateComposer();
        return;
      }
    } catch (error) {
      state.sending = false;
      updateComposer();
      showPersistentToast("Couldn’t start the chat.", { detail: errorText(error) });
      return;
    }
  }

  // No turn is running but a card is still open (edge case): closing it first releases the tool, then the text goes
  // as an ordinary message.
  if (openCards().length) closeOpenCards();

  // The skill message is built before anything is shown, so a skill that will not load leaves the draft as it was.
  let outgoing = text;
  let skillInfo = null;
  if (skill) {
    state.sending = true;
    updateComposer();
    try {
      const [first, ...more] = skill.names;
      const arg = [...more.map((name) => `/${name}`), skill.text].filter(Boolean).join(" ");
      const result = await rpc("command.dispatch", { session_id: state.liveSid, name: first, arg });
      const message = result && typeof result.message === "string" ? result.message : "";
      if (!message || (result.type !== "skill" && result.type !== "send")) throw new Error("Hermes did not load it");
      outgoing = message;
      skillInfo = describeSkillInvocation(message) || { names: skill.names, text: skill.text };
    } catch (error) {
      state.sending = false;
      updateComposer();
      sysLine(`Could not load the skill: ${errorText(error)}`);
      return;
    }
  }

  state.sending = true;
  state.stoppedByUser = false;
  state.narration.request = text;
  activity.setRequest(text);
  clearComposer();
  addUserBubble(skillInfo ? skillLabel(skillInfo) : text, attachments, true, skillInfo ? { skill: skillInfo, attached: true } : {});
  const userRow = els.log.lastElementChild; // the optimistic bubble, removed if the send fails
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
    const full = [outgoing, ...refs].filter(Boolean).join("\n");
    state.localStartAt = Date.now(); // the message.start that follows is ours, not another device's
    await rpc("prompt.submit", { session_id: state.liveSid, text: full });
    const chatId = state.viewedId;
    if (state.viewedUnsent) {
      // The first message saves the chat on the server, so from now on its real id is remembered for a reload.
      state.viewedUnsent = false;
      persistView();
      refreshDockedDrawer();
    }
    void registerAppChat(chatId);
  } catch (error) {
    // Nothing was submitted: give the text and attachments back so the user can retry.
    const lost = isLostSession(error);
    sysLine(lost ? LOST_SESSION_TEXT : `Send failed: ${errorText(error)}`);
    els.input.value = saved.text;
    autosize();
    state.attachments = saved.attachments;
    state.pastes = saved.pastes;
    state.mentions = saved.mentions;
    renderTray();
    syncMentions();
    finishTurn();
    // The text is back in the box, so the bubble would only look sent when it was not (and vanish on a reload).
    userRow?.remove();
    // A first send that failed leaves a chat that never became real: back to the empty state.
    if (state.viewedUnsent) setEmptyState(true);
    if (lost) void reattachChat();
  } finally {
    state.sending = false;
  }
}

const LOST_SESSION_TEXT = "Not sent: Hermes had closed this chat. It's reopening, so send it again in a moment.";

// Sends the typed text into the running task without stopping it (session.steer: Hermes adds it to the next tool
// result, so the agent reads it mid-task). The message shows as a user bubble and the live reply continues below it.
// Attachments stay in the tray for a normal send after the turn. If the turn has just ended, the server answers
// "rejected" and the text is sent as an ordinary message instead.
async function steer() {
  if (state.sending || !state.liveSid) return;
  if (draftSkills().length) return; // skills go with a new message: the button shows Stop until the reply is done
  const text = expandMentions(expandPastes(els.input.value)).trim();
  if (!text) return;
  const saved = { text: els.input.value, pastes: state.pastes.slice(), mentions: state.mentions.slice() };
  state.sending = true;
  els.input.value = "";
  state.pastes = [];
  state.mentions = [];
  autosize();
  updateComposer();
  let result;
  try {
    result = await rpc("session.steer", { session_id: state.liveSid, text });
  } catch (error) {
    sysLine(`Could not send: ${errorText(error)}`);
    els.input.value = saved.text;
    state.pastes = saved.pastes;
    state.mentions = saved.mentions;
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
    state.mentions = saved.mentions;
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
  state.stoppedByUser = true;
  try {
    await rpc("session.interrupt", { session_id: state.liveSid });
  } catch (error) {
    state.stoppedByUser = false;
    sysLine(`Could not stop: ${errorText(error)}`);
  }
}

// Grow with the text up to the CSS max-height (7 lines), then scroll inside with the scrollbar hidden.
// box-sizing is border-box, so the border has to be added to scrollHeight or the box is always 2px short.
function autosize() {
  queueMicrotask(syncMentions);
  const el = els.input;
  if ((state.dictating || state.transcribing) && !el.value) {
    el.style.height = "";
    el.style.overflowY = "hidden";
    return;
  }
  el.style.height = "auto";
  const cs = getComputedStyle(el);
  const border = el.offsetHeight - el.clientHeight;
  const max = parseFloat(cs.maxHeight) || 170;
  const want = el.scrollHeight + border;
  el.style.height = `${Math.min(want, max)}px`;
  el.style.overflowY = want > max ? "auto" : "hidden";
}

// New chat opens a local draft, titled after the first message. The main chat (state.homeId) is never renamed or
// replaced. Pressing New chat on an empty draft keeps it and creates nothing.
function newChat() {
  if (state.resettingMain || state.sending || state.switching) return Promise.resolve(); // never move the view mid-send
  if (!state.ready && !state.readOnly) {
    sysLine("Not connected yet. Try again in a moment.");
    return Promise.resolve();
  }
  if (state.viewedId !== state.homeId && state.viewedEmpty && !state.readOnly) {
    els.input.focus();
    return Promise.resolve();
  }
  rememberScroll();
  openDraft({ lower: true });
  els.input.focus();
  return Promise.resolve();
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

  const { text: inserted, caret } = dictationInsert(before, clean, after);

  els.input.value = before + inserted + after;
  const newPos = start + caret;
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

function dictationFailure(result) {
  switch (result?.code) {
    case "no_provider": return "Dictation needs a speech service. Set one up in Hermes.";
    case "auth": return "Dictation couldn’t connect to the speech service. Check its setup in Hermes.";
    case "rate_limit": return "The speech service is busy. Try again in a moment.";
    case "too_large": return "That recording was too large. Try a shorter one.";
    case "timeout": return "Transcription timed out. Try again.";
    default: return "Couldn’t transcribe the recording. Try again.";
  }
}

async function startDictation() {
  if (!isDictationSupported()) {
    showPersistentToast("This browser doesn’t support dictation.");
    return;
  }
  if (state.dictating || state.transcribing || state.resettingMain || state.composerLocked) return;
  if (cardDictation) return; // a question card's mic is recording or transcribing
  const sid = state.liveSid;
  const reportError = (message) => {
    if (sid === state.liveSid) showPersistentToast(message);
  };
  captureDictationCaret();
  dictationDiscarded = false;
  dictationSendAfter = false;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    reportError("Couldn’t access the microphone. Check this site’s microphone permission and try again.");
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
    reportError("Couldn’t start recording. Try again.");
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
        reportError(dictationFailure(res));
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
      if (!(err instanceof AuthRedirect)) reportError(dictationFailure());
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

// ---------- Dictation in a question card ----------
// The card's answer box is one field like the composer's: the text box with the mic inside at its right end. A tap
// records: the text steps aside for the composer's recording strip (live bars, a one-minute countdown that turns amber
// then red, and a cancel x) and the mic becomes Stop. Stop transcribes through the same /dictate route and puts the
// text in at the caret, ready to edit; Send while recording stops, transcribes and sends, like the composer. Shown on
// the composer mic's terms; one recording at a time across the card and the composer; a card that moves on drops it.
let cardDictation = null; // the live session: see startCardDictation

const MIC_SVG = '<svg class="clarify-mic-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v4M8 23h8"/></svg>'
  + '<svg class="clarify-mic-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function clarifyAnswerField(input, send) {
  const field = el("div", "answer-field");
  field.append(input);
  if (!isDictationSupported()) return field;
  const features = typeof identityApi.features === "function" ? identityApi.features() : null;
  if (features && features.dictation === false) return field;

  // The composer's recording strip, built per card (the composer keeps its own).
  const hud = el("div", "dictate-hud clarify-hud");
  hud.hidden = true;
  const viz = el("div", "dictate-viz");
  viz.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 5; i++) viz.append(el("span", "vbar"));
  const timer = el("span", "dictate-timer", "1:00");
  timer.setAttribute("aria-live", "off");
  const cancel = el("button", "dictate-cancel");
  cancel.type = "button";
  cancel.setAttribute("aria-label", "Cancel dictation");
  cancel.title = "Cancel recording";
  cancel.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  hud.append(viz, timer, cancel);

  const mic = el("button", "clarify-mic");
  mic.type = "button";
  mic.innerHTML = MIC_SVG;
  field.append(hud, mic);
  const ui = { field, input, hud, viz, timer, mic, send };
  syncCardMic(ui, "idle");

  // Presses never take focus from the box, so its caret is still there to read.
  for (const button of [mic, cancel]) button.addEventListener("pointerdown", (event) => event.preventDefault());
  mic.addEventListener("click", () => {
    if (cardDictation && cardDictation.ui === ui) {
      if (!cardDictation.transcribing) stopCardDictation();
      return;
    }
    void startCardDictation(ui);
  });
  cancel.addEventListener("click", () => {
    if (cardDictation && cardDictation.ui === ui && !cardDictation.transcribing) stopCardDictation({ discard: true });
  });
  // Send while recording: stop, transcribe, then send (capture phase, ahead of the card's own Send handler).
  send.addEventListener("pointerdown", (event) => {
    if (cardDictation && cardDictation.ui === ui) event.preventDefault();
  });
  send.addEventListener("click", (event) => {
    if (!cardDictation || cardDictation.ui !== ui) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!cardDictation.transcribing) stopCardDictation({ send: true });
  }, true);
  return field;
}

function syncCardMic(ui, mode) {
  const active = mode === "recording" || mode === "transcribing";
  ui.field.classList.toggle("dictating", active);
  ui.hud.hidden = !active;
  ui.hud.classList.toggle("transcribing", mode === "transcribing");
  ui.mic.classList.toggle("recording", mode === "recording");
  ui.mic.classList.toggle("transcribing", mode === "transcribing");
  ui.mic.disabled = mode === "transcribing";
  ui.input.readOnly = active;
  const label = mode === "recording" ? "Stop dictation" : mode === "transcribing" ? "Transcribing…" : "Dictate";
  ui.mic.setAttribute("aria-label", label);
  ui.mic.title = label;
  if (mode === "recording") {
    ui.timer.textContent = "1:00";
    ui.timer.classList.remove("warn", "crit");
  } else if (mode === "transcribing") {
    ui.timer.textContent = "…";
    ui.timer.classList.remove("warn", "crit");
  }
  if (!active) for (const bar of ui.viz.querySelectorAll(".vbar")) bar.style.height = "4px";
}

async function startCardDictation(ui) {
  if (cardDictation || state.dictating || state.transcribing) {
    showPersistentToast("Finish the other dictation first.");
    return;
  }
  const { input } = ui;
  const len = input.value.length;
  const caret = document.activeElement === input && typeof input.selectionStart === "number"
    ? { start: Math.min(input.selectionStart, len), end: Math.min(input.selectionEnd ?? input.selectionStart, len) }
    : { start: len, end: len };
  const session = {
    ui, caret, recorder: null, stream: null, chunks: [], deadline: 0, timer: 0, watch: 0, raf: 0,
    audio: null, discarded: false, sendAfter: false, transcribing: false,
  };
  cardDictation = session;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    cardDictation = null;
    showPersistentToast("Couldn’t access the microphone. Check this site’s microphone permission and try again.");
    return;
  }
  session.stream = stream;
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav"];
  const mimeType = types.find((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) || "";
  try {
    session.recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    releaseCardDictation(session);
    showPersistentToast("Couldn’t start recording. Try again.");
    return;
  }
  session.recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) session.chunks.push(event.data);
  });
  session.recorder.addEventListener("stop", () => void finishCardDictation(session, mimeType));
  input.blur();
  syncCardMic(ui, "recording");
  startCardVisualizer(session);
  session.recorder.start();
  session.deadline = performance.now() + DICTATE_MAX_MS;
  // The countdown, the composer's: amber from 15 s, red and pulsing from 5 s, then it stops by itself.
  session.timer = setInterval(() => {
    const remaining = Math.max(0, session.deadline - performance.now());
    const secLeft = Math.ceil(remaining / 1000);
    ui.timer.textContent = formatCountdown(remaining);
    ui.timer.classList.toggle("warn", secLeft <= 15 && secLeft > 5);
    ui.timer.classList.toggle("crit", secLeft <= 5);
    if (remaining <= 0) stopCardDictation();
  }, 200);
  // The card was redrawn (Back, Skip, a choice, answered elsewhere): its box is gone, so drop the recording now.
  session.watch = setInterval(() => {
    if (!input.isConnected && cardDictation === session && !session.transcribing) stopCardDictation({ discard: true });
  }, 400);
}

function startCardVisualizer(session) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(session.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    session.audio = { ctx, source, analyser };
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = session.ui.viz.querySelectorAll(".vbar");
    const bins = [1, 2, 4, 7, 12];
    const tick = () => {
      if (cardDictation !== session || session.transcribing || !session.audio) return;
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < bars.length; i++) {
        const val = data[bins[i] || i] || 0;
        bars[i].style.height = `${Math.max(4, Math.min(22, Math.round(4 + (val / 255) * 18)))}px`;
      }
      session.raf = requestAnimationFrame(tick);
    };
    session.raf = requestAnimationFrame(tick);
  } catch {
    /* the bars are decoration */
  }
}

function stopCardMedia(session) {
  if (session.timer) clearInterval(session.timer);
  if (session.watch) clearInterval(session.watch);
  if (session.raf) cancelAnimationFrame(session.raf);
  session.timer = session.watch = session.raf = 0;
  if (session.audio) {
    try { session.audio.source.disconnect(); } catch {}
    try { session.audio.analyser.disconnect(); } catch {}
    try { if (session.audio.ctx.state !== "closed") void session.audio.ctx.close().catch(() => {}); } catch {}
    session.audio = null;
  }
  if (session.stream) {
    for (const track of session.stream.getTracks()) {
      try { track.stop(); } catch {}
    }
    session.stream = null;
  }
}

function stopCardDictation({ discard = false, send = false } = {}) {
  const session = cardDictation;
  if (!session || !session.recorder || session.transcribing) return;
  session.discarded = discard;
  session.sendAfter = send && !discard;
  try {
    if (session.recorder.state !== "inactive") session.recorder.stop();
    else releaseCardDictation(session);
  } catch {
    releaseCardDictation(session);
  }
}

function releaseCardDictation(session) {
  stopCardMedia(session);
  if (session.ui.field.isConnected) syncCardMic(session.ui, "idle");
  else session.ui.input.readOnly = false;
  if (cardDictation === session) cardDictation = null;
}

async function finishCardDictation(session, mimeType) {
  const type = (session.recorder && session.recorder.mimeType) || mimeType || "audio/webm";
  stopCardMedia(session);
  const blob = new Blob(session.chunks, { type });
  session.chunks = [];
  const { ui } = session;
  // Cancelled, too short, or the card moved on: nothing to transcribe.
  if (session.discarded || blob.size < 100 || !ui.input.isConnected) {
    releaseCardDictation(session);
    if (!session.discarded && ui.input.isConnected) ui.input.focus();
    return;
  }
  session.transcribing = true;
  syncCardMic(ui, "transcribing");
  let sendNow = false;
  try {
    const res = await api("/api/plugins/hermes-mini/dictate", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    if (!res || res.ok === false) {
      if (ui.input.isConnected) showPersistentToast(dictationFailure(res));
    } else {
      const text = String(res.text || "").trim();
      if (text && ui.input.isConnected) {
        const val = ui.input.value;
        const start = Math.max(0, Math.min(session.caret.start, val.length));
        const end = Math.max(start, Math.min(session.caret.end, val.length));
        const before = val.slice(0, start);
        const after = val.slice(end);
        const { text: inserted, caret } = dictationInsert(before, text, after);
        ui.input.value = before + inserted + after;
        session.caret = { start: start + caret, end: start + caret };
        sendNow = session.sendAfter;
      }
    }
  } catch (err) {
    if (!(err instanceof AuthRedirect) && ui.input.isConnected) showPersistentToast(dictationFailure());
  } finally {
    releaseCardDictation(session);
  }
  if (!ui.input.isConnected) return;
  ui.input.dispatchEvent(new Event("input", { bubbles: true })); // multi-select re-enables its button
  if (sendNow) {
    ui.send.click(); // the card's own Send: the same checks as a tap
    return;
  }
  ui.input.focus();
  try { ui.input.setSelectionRange(session.caret.start, session.caret.end); } catch {}
}

// Escape while a card records drops the recording, like the composer's.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && cardDictation && !cardDictation.transcribing) {
    event.preventDefault();
    event.stopPropagation();
    stopCardDictation({ discard: true });
  }
}, true);

// ---------- wiring ----------

if (els.micBtn) {
  // Hide only on a definite no: this browser cannot record. The server-side probe decides the other half
  // (no configured speech-to-text provider) via identity.js loadStatus(), which runs at boot; the
  // /dictate route stays the real gate either way.
  if (!isDictationSupported()) {
    els.micBtn.hidden = true;
  } else {
    els.micBtn.hidden = false; // browser can record; a definite server "no" hides it again
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
  syncMentions();
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
    if (state.streaming && !state.sending && els.input.value.trim() && !draftSkills().length) void steer();
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
// The menu is fixed-position in the top layer, so it is placed from the "+" button's box on screen: left edges
// together, its bottom 14px above the button (the old absolute offsets), kept 8px inside the window.
function placeAttachMenu() {
  const wrap = els.attach.parentElement || els.attach;
  const r = wrap.getBoundingClientRect();
  const rowRect = els.attach.closest(".row")?.getBoundingClientRect() || r;
  const edge = 8;
  const w = attachMenu.offsetWidth;
  const h = attachMenu.offsetHeight;
  const left = Math.min(Math.max(edge, r.left), Math.max(edge, window.innerWidth - w - edge));
  const top = Math.max(edge, Math.min(rowRect.top - 10 - h, window.innerHeight - h - edge));
  attachMenu.style.left = `${left}px`;
  attachMenu.style.top = `${top}px`;
}
function setMenu(open) {
  attachMenu.hidden = !open;
  els.attach.classList.toggle("open", open);
  els.attach.setAttribute("aria-expanded", String(open));
  // The top layer keeps the menu over the header. menu-open stays for browsers without the Popover API, where
  // lifting the whole composer is still what does it (style.css).
  els.attach.closest(".composer")?.classList.toggle("menu-open", open);
  if (open) {
    // Top layer first: while it is closed the browser keeps it display:none, so it can only be measured once shown.
    openPopover(attachMenu);
    placeAttachMenu();
  } else {
    closePopover(attachMenu);
  }
}
const rePlaceAttachMenu = () => {
  if (!attachMenu.hidden) placeAttachMenu();
};
window.addEventListener("resize", rePlaceAttachMenu);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", rePlaceAttachMenu);
  window.visualViewport.addEventListener("scroll", rePlaceAttachMenu);
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
// The Inbox has its own per-message read tracker: seeing a reply here marks it read, and the Inbox
// panel's own toggle writes the same tracker. The drawer's seen.json is never touched. A row counts
// as seen once 60% of it has been on screen for 600 ms; batches go out after about a second, so a
// fast scroll is one small POST instead of one per bubble.
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

// The action row's label follows the Inbox's own read state: a reply the Inbox holds unread shows Mark read. Only rows
// whose id is already known are asked for, in chunks the route's limit allows. Labels can be stale if another device
// changes the state while this chat is open, which is harmless: a tap repeats the current state (Mark unread on one
// already held, or Mark read on one already read). A failed read leaves every flag as it was and says nothing.
const INBOX_STATE_CHUNK = 200;
async function refreshInboxMarks() {
  const rows = chatRows().filter((row) => {
    const meta = row.hermesMiniMsg;
    return meta && meta.role === "assistant" && Number.isInteger(meta.rowId) && meta.rowId > 0;
  });
  const ids = [...new Set(rows.map((row) => row.hermesMiniMsg.rowId))];
  if (!ids.length) return;
  for (let start = 0; start < ids.length; start += INBOX_STATE_CHUNK) {
    const chunk = ids.slice(start, start + INBOX_STATE_CHUNK);
    const asked = new Set(chunk);
    let states;
    try {
      states = await inbox.readState(chunk);
    } catch {
      return;
    }
    for (const row of rows) {
      const rowId = row.hermesMiniMsg.rowId;
      if (!asked.has(rowId)) continue;
      const state = states[String(rowId)];
      row.hermesMiniMsg.markedUnread = Boolean(state && state.marked_unread);
    }
    syncActionAvailability();
  }
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
// The Bookmarks panel: the agent replies the person kept, read from /bookmarks on every open. The same module keeps the
// ids the action rows ask about, and a change made in the panel updates the chat on screen (bookmarks.js).
const bookmarks = createBookmarks({
  api,
  openMessage: (sessionId, messageId) => openTarget(sessionId, { messageId, match: "", ts: 0 }),
  formatTime: messageTimeLabel,
  showToast,
  onChange: refreshBookmarkMarks,
});
const activity = createActivity({
  el,
  logEl: els.log,
  api,
  displayText,
  nearBottom,
  scrollToBottom,
  getStoredId: () => state.storedId,
  resolveRowId: (row, sid) => resolveRowId(row, 3, sid),
  fetchMedia,
  openViewer,
  formatTime: messageTimeLabel,
});
// The Search panel: chat titles and message text across the app's chats, read from /search on every query. A chat hit
// opens that chat; a message hit opens it at that message through the same openTarget the Inbox uses.
const search = createSearch({
  api,
  formatTime: messageTimeLabel,
  openSession: (sessionId) => openTarget(sessionId, null),
  openMessage: (sessionId, messageId) => openTarget(sessionId, { messageId, match: "", ts: 0 }),
});
// Desktop scrollbars show only while the mouse is over their area, touch ones only while scrolling (style.css .sb-on). Every scrolling area under the
// pointer gets .sb-on - a code block in the chat lights both - and loses it when the pointer leaves it or the window.
// A class, not :hover: Chrome does not reliably repaint a styled scrollbar when only the hover state changes.
const SCROLL_AREAS = ".log, .drawer-list, .bubble pre, .card pre, .bubble .table-wrap, .tray, .bm-list, .todo-list, .inbox-list, .sched-list, .search-results";
let scrollbarsLit = [];
function lightScrollbars(target) {
  const next = [];
  for (let node = target instanceof Element ? target.closest(SCROLL_AREAS) : null; node; node = node.parentElement?.closest(SCROLL_AREAS)) {
    next.push(node);
  }
  for (const node of scrollbarsLit) if (!next.includes(node)) node.classList.remove("sb-on");
  for (const node of next) if (!node.classList.contains("sb-on")) node.classList.add("sb-on");
  scrollbarsLit = next;
}
if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "mouse") lightScrollbars(event.target);
  });
  document.documentElement.addEventListener("pointerleave", () => lightScrollbars(null));
  window.addEventListener("blur", () => lightScrollbars(null));
} else {
  // Touch: an area's bar shows while it scrolls and fades out 900 ms after the last scroll (style.css, touch block).
  const scrollFade = new WeakMap();
  document.addEventListener("scroll", (event) => {
    const area = event.target instanceof Element && event.target.matches(SCROLL_AREAS) ? event.target : null;
    if (!area) return;
    area.classList.add("sb-on");
    clearTimeout(scrollFade.get(area));
    scrollFade.set(area, setTimeout(() => area.classList.remove("sb-on"), 900));
  }, { capture: true, passive: true });
}

// Tools: folds the Edit profile, Computer, Bookmarks and To-do buttons into the Tools button and brings them back.
// Folded by default; the choice is remembered on this device. While folded, Tools repeats the open to-do count so it is
// not lost.
const TOOLS_KEY = "hermes-mini-tools-open";
const toolsBtn = document.getElementById("toolsBtn");
const toolsCount = document.getElementById("toolsCount");
const todoCountEl = document.getElementById("todoCount");
function syncToolsCount() {
  const show = !document.body.classList.contains("tools-open") && !todoCountEl.hidden && todoCountEl.textContent !== "";
  toolsCount.textContent = show ? todoCountEl.textContent : "";
  toolsCount.hidden = !show;
}
function setToolsOpen(openTools, { remember = true } = {}) {
  document.body.classList.toggle("tools-open", openTools);
  toolsBtn.setAttribute("aria-expanded", String(openTools));
  syncToolsCount();
  if (!remember) return;
  try {
    if (openTools) localStorage.setItem(TOOLS_KEY, "1");
    else localStorage.removeItem(TOOLS_KEY);
  } catch {
    /* a private window: the choice lasts until reload */
  }
}
let toolsRemembered = false;
try {
  toolsRemembered = localStorage.getItem(TOOLS_KEY) === "1";
} catch {
  /* unavailable storage: start folded */
}
setToolsOpen(toolsRemembered, { remember: false });
toolsBtn.addEventListener("click", () => setToolsOpen(!document.body.classList.contains("tools-open")));
new MutationObserver(syncToolsCount).observe(todoCountEl, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });

// The Scheduled panel: Hermes's scheduled jobs, fetched on every open; pause, resume, delete and
// add-to-message go through it (schedules.js).
const schedules = createSchedules({
  api,
  // "Add to message": the job goes into the message being written, ready to discuss or change it.
  mention: {
    available: () => !state.readOnly && !els.input.disabled,
    // The schedule goes in at the caret as an inline pill (addMention); the full tag is sent.
    add: (job) => {
      addMention(job);
      els.input.focus();
    },
  },
});
// The panels close each other, waiting for each one's history entry so they never race.
els.todoBtn.addEventListener("click", () => {
  void inbox.close().then(() => schedules.close()).then(() => bookmarks.close()).then(() => search.close())
    .then(() => todo.open());
});
// The Bookmarks tool, directly above To-do: a second tap closes the panel.
els.bookmarkBtn.addEventListener("click", () => {
  if (bookmarks.isOpen()) {
    void bookmarks.close();
    return;
  }
  void inbox.close().then(() => todo.close()).then(() => schedules.close()).then(() => search.close())
    .then(() => bookmarks.open());
});
// The agent's picture and name are the Inbox's button: a tap opens it, a second tap closes it.
const toggleInbox = () => {
  if (inbox.isOpen()) {
    void inbox.close();
    return;
  }
  void todo.close().then(() => schedules.close()).then(() => bookmarks.close()).then(() => search.close())
    .then(() => inbox.open());
};
els.inboxBtn.addEventListener("click", toggleInbox);
els.inboxBtn.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleInbox();
});
// The Scheduled row in the chats panel opens Scheduled, and a second tap closes it. On a phone the panel is an
// overlay, so it steps aside first; a docked panel stays.
document.getElementById("schedBtn").addEventListener("click", () => {
  if (schedules.isOpen()) {
    void schedules.close();
    return;
  }
  const panel = drawerApi.isOpen() && !isDocked() ? drawerApi.close() : Promise.resolve();
  void Promise.resolve(panel).then(() => todo.close()).then(() => inbox.close()).then(() => bookmarks.close())
    .then(() => search.close()).then(() => schedules.open());
});
// The Search row under New chat opens Search, and a second tap closes it. On a phone it steps the drawer aside first;
// a docked drawer stays.
document.getElementById("searchBtn").addEventListener("click", () => {
  if (search.isOpen()) {
    void search.close();
    return;
  }
  const panel = drawerApi.isOpen() && !isDocked() ? drawerApi.close() : Promise.resolve();
  void Promise.resolve(panel).then(() => todo.close()).then(() => inbox.close()).then(() => schedules.close())
    .then(() => bookmarks.close()).then(() => search.open());
});
// Edit profile, the first button in the Tools tray, opens the name and picture editor (identity-edit.js).
createIdentityEditor({ rpc, identityApi, api, showToast });
void todo.refresh();
void inbox.refreshBadge();
// The action rows' bookmark buttons learn the stored set before the first chat is drawn, and again as chats load.
void bookmarks.refreshIds().then(refreshBookmarkMarks);

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

// Android's share sheet opened the app with ?shared=1 (sw.js receiveShare kept the share): its text and link go into the
// message box and its pictures and files into the tray, in the chat on screen, ready to add a word and send. A chat that
// cannot be written to gives way to the main chat. The flag is dropped first, so a reload never takes it twice.
async function receiveShared() {
  const params = new URLSearchParams(location.search);
  if (!params.has(SHARE_PARAM)) return;
  params.delete(SHARE_PARAM);
  const query = params.toString();
  history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
  let shared = null;
  try {
    shared = await takeShared();
  } catch (error) {
    sysLine(`Could not open what was shared: ${errorText(error)}`);
    return;
  }
  if (!shared) return;
  if ((state.readOnly || els.input.disabled) && state.homeId && state.viewedId !== state.homeId) {
    await switchSession(state.homeId);
  }
  if (shared.files.length) addFiles(shared.files);
  if (shared.text) {
    const input = els.input;
    input.setSelectionRange(input.value.length, input.value.length);
    insertIntoComposer(input.value.trim() ? `\n${shared.text}` : shared.text);
  }
  updateComposer();
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
    pushBtn.hidden = false; // browser supports Web Push; a definite server "no" hides it again
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

// The restart pill: it stays from the click until this app has attached to the new process, so a long restart never
// looks finished. It is its own element, so a transient toast cannot replace it.
let restartToast = null;
function showRestartNotice() {
  if (!restartToast) {
    restartToast = el("div", "toast restart-toast");
    restartToast.setAttribute("popover", "manual");
    restartToast.setAttribute("role", "status");
    restartToast.setAttribute("aria-live", "polite");
    document.body.append(restartToast);
  }
  // "Restarting" plus three dots that blink in turn (style.css .restart-dots); screen readers hear just "Restarting".
  if (!restartToast.querySelector(".restart-dots")) {
    const dots = el("span", "restart-dots");
    dots.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) dots.append(el("span", "", "."));
    restartToast.replaceChildren(document.createTextNode("Restarting"), dots);
  }
  reopenPopover(restartToast); // top layer, above any dialog that is open
  restartToast.classList.add("show");
}
function hideRestartNotice() {
  if (!restartToast) return;
  restartToast.classList.remove("show");
  closePopover(restartToast, 300); // stay in the top layer while the fade-out plays
}

// Gateway restart: confirm, ask the server to restart it detached, then watch the gateway state
// until a new process is running and this app has connected to it. Green toast when it is back, red if it is not back
// within 150 s.
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
      showRestartNotice();
      // The button restarts the gateway and then the dashboard (plugin_api.py _restart_all_command): done when both report a
      // new pid AND this app is attached to the new gateway. Reads fail while the dashboard is down; the loop just
      // waits. The pill stays up for the whole loop.
      const before = res.pid_before;
      const dashBefore = res.dashboard_pid_before;
      const deadline = Date.now() + 150_000;
      let back = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        try {
          const now = await api("/api/plugins/hermes-mini/gateway/status");
          const connected = Boolean(state.wsReady && state.ws && state.ws.readyState === WebSocket.OPEN && state.ready);
          if (connected && now.state === "running" && now.pid && now.pid !== before && (!dashBefore || (now.dashboard_pid && now.dashboard_pid !== dashBefore))) {
            back = true;
            break;
          }
        } catch {
          /* the dashboard is restarting too; a failed read just waits for the next one */
        }
      }
      hideRestartNotice();
      showToast(back ? "Restarted" : "Restart didn't finish", back ? "success" : "error");
    } catch (error) {
      hideRestartNotice();
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

// Drag the seam between the chat and the docked computer to resize them. While the computer is
// docked the chat keeps at least its readable 600px and the computer at least 420px; the width is a
// per-device convenience in localStorage.
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
    if (state.viewedId && !state.viewedUnsent) drawerApi.markSeen(state.viewedId);
    return;
  }
  // Back on the page: the chat on screen is read, and the list picks up activity that arrived meanwhile.
  if (state.viewedId && !state.viewedUnsent) drawerApi.markSeen(state.viewedId);
  activity.onVisibilityChange();
  refreshDrawerActivity();
  void todo.refresh(); // to-dos may have changed on another device while the app was away
  if (state.wsReady) void approvalUi.refresh();
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

if (state.viewedUnsent) setEmptyState(true);
updateComposer();
autosize();

// Boot: read the agent's identity/feature flags, confirm we are signed in (a 401 redirects to the dashboard
// login), and open the WebSocket in parallel, then attach the thread. Identity is a read (the status route also
// records the default delivery target once).
(async () => {
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
  const bootIdentity = identityApi.boot().then(() => {
    AGENT = identityApi.currentName();
    applyAgentBranding();
  }).catch(() => {
    applyAgentBranding();
  });
  // Status must already read "Connecting…" while the sign-in check and socket handshake run.
  try {
    await Promise.all([
      api("/api/sessions?limit=1"),
      connect(),
      bootIdentity,
    ]);
  } catch (error) {
    if (state.ws) dropSocket(state.ws);
    if (error instanceof AuthRedirect) return;
    noteOffline();
    scheduleReconnect();
    return;
  }
  try {
    await attachThread();
    await openSessionFromHash(); // a notification may have opened this window on a specific chat
    await receiveShared(); // Android's share sheet opened this window with something to send
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
