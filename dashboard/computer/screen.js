// Computer: a full-viewport noVNC viewer for the agent's headless desktop.
// The JSON-RPC leg rides the host page's authenticated /api/ws connection (deps.rpc: app.js or computer.js) (display.* methods). The RFB leg is a
// sibling WebSocket to /api/display/ws, minted per attach by display.observe (single-use ticket, 30 s). The backend owns
// runtime + lease; this module only asks for the lease when the person actually inputs and gives it back after 20 s of
// quiet.

import KeyTable from "./vendor/novnc/core/input/keysym.js";
import { createTrackpad } from "./trackpad.js";
import { showToast } from "../toast.js";
import { botScreenHtml } from "./markup.js";

// Works from either page that hosts it: the chat app or the standalone computer page.
const PREFIX = (() => {
  const at = location.pathname.indexOf("/dashboard-plugins/");
  return at > 0 ? location.pathname.slice(0, at) : "";
})();

const $ = (id) => document.getElementById(id);

// Mirrors hermes_cli/web_routers/display.py and screen-pane.tsx.
const CLOSE_CONTROL_TAKEN = 4000;
const CLOSE_BAD_TICKET = 4401;
const CLOSE_STOPPED = 4001;
const EVICTION_WINDOW_MS = 10_000;
const MAX_RAPID_EVICTIONS = 3;
const NET_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const MAX_PASTE_CUT_TEXT = 256 * 1024;
const RPC_SHORT_MS = 15000;
// Auto take-over and auto hand-back: any deliberate input while watching takes control, and 20 s
// of quiet while holding gives it back, with the last 5 s drawn as a ring on Hand Back.
const IDLE_HAND_BACK_MS = 20_000;
const COUNTDOWN_MS = 5_000;
const TAKE_NUDGE_MS = 4_000; // after "the agent is working", the next tap within this still takes over
// Floating ownership/action row placement. noVNC letterboxes its real canvas inside #bsHost, so the row
// is anchored to the rendered canvas, not to the stage box: bottom edge just above the image, sides
// aligned to the image with a small inset.
const FLOAT_GAP_PX = 7; // vertical gap between the image's bottom and the row's top
const FLOAT_INSET_PX = 8; // horizontal inset from the image's left/right edges
const PAD_TOP_PX = 8; // phones with a trackpad: gap above the picture
const PAD_GAP_PX = 16; // gap under the trackpad
const PAD_MIN_PX = 140; // shorter than this (landscape, keyboard up) and the pad hides; the picture centres again
const FLOAT_CLEARANCE_PX = 44; // small bottom band kept free in #bsHost under a live image for the row

function displayUrl(ticket, path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const raw = String(path || "/api/display/ws");
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const url = new URL(`${proto}//${location.host}${PREFIX}${withSlash}`);
  url.searchParams.set("display_ticket", ticket);
  return url.toString();
}

function isDisplayUnavailable(error) {
  const record = error && typeof error === "object" ? error : {};
  if (record.code === -32601 || (record.data && record.data.code === "method_not_found")) return true;
  const text = String(record.message || error || "").toLowerCase();
  // Current gateways say "unknown method: display.status"; older ones say "method not found".
  return (
    text.includes("unknown method") ||
    text.includes("method not found") ||
    text.includes("method-not-found") ||
    text.includes("-32601")
  );
}

// The agent whose computer this is (deps.agentName; the host page passes the user's agent name).
let AGENT = "Mini";

function readableError(error) {
  const message = String((error && error.message) || error || "");
  if (isDisplayUnavailable(error)) return `${AGENT}'s Computer isn't available on this Hermes version.`;
  if (/not connected|connection lost|timed out|offline|websocket/i.test(message)) {
    return "Couldn't reach Hermes. Check the connection and try again.";
  }
  if (/not running|display\.start/i.test(message)) return "The bot's desktop is stopped.";
  if (/viewer_id|minted for this connection/i.test(message)) {
    return "This viewer lost its control identity. Reconnect, then take over again.";
  }
  if (/human holds|viewer_mismatch|another viewer/i.test(message)) {
    return "Another viewer has control. Tap again to take over.";
  }
  return message || `Something went wrong with ${AGENT}'s Computer.`;
}

function keysymForChar(char) {
  const cp = char.codePointAt(0);
  if (char === "\n" || char === "\r") return KeyTable.XK_Return;
  if (char === "\t") return KeyTable.XK_Tab;
  if (char === "\b") return KeyTable.XK_BackSpace;
  if (cp < 0x20) return null;
  // X11 Unicode keysyms: Latin-1 is its own code point, everything else is 0x01000000 + code point.
  return cp <= 0xff ? cp : 0x01000000 + cp;
}

// Follows the last input, like style.css and app.js (index.html sets data-input).
function touchLayout() {
  return document.documentElement.dataset.input === "touch";
}

async function viewerHash(viewerId) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewerId));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 12);
  } catch {
    // SubtleCrypto is unavailable outside a secure context; the badge then shows the conservative state.
    return null;
  }
}

export function createBotScreen(deps) {
  AGENT = String(deps.agentName || "Mini");
  const safeName = AGENT.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  if (!$("botScreen")) document.body.insertAdjacentHTML("beforeend", botScreenHtml(safeName));
  // Standalone (the computer page): the computer is the whole page, so it never closes, slides or touches
  // history. Inside the chat app it opens and closes as before.
  const standalone = Boolean(deps.standalone);
  const shell = $("botScreen");
  if (!shell) {
    const noop = () => undefined;
    return { open: noop, close: () => Promise.resolve(), isOpen: () => false, onDisplayEvent: noop, onRpcReady: noop, onRpcDisconnected: noop };
  }

  const app = document.querySelector(".app");
  const host = $("bsHost");
  const pad = $("bsPad");
  const helpBtn = $("bsHelp");
  const helpSheet = $("bsHelpSheet");
  // Phones (touch, not docked): the picture sits at the top and a visible trackpad fills the space below it.
  const touchQuery = window.matchMedia("(hover: none) and (pointer: coarse)");
  // Touch on the desktop works like a laptop trackpad while you are in control (trackpad.js).
  const trackpad = host
    ? createTrackpad({
      host,
      pad,
      getRfb: () => rfb,
      isActive: () => openFlag && Boolean(rfb) && iHold(),
      // Zoom and pan are local to the phone, so they work while only watching too.
      canView: () => openFlag && Boolean(rfb),
      // A tap or a drag while watching is a deliberate input: screen.js takes over, then replays it.
      onIntent: (intent) => onTrackpadIntent(intent),
      // No auto keyboard on text fields: the pointer shape cannot tell an input from page text, so
      // the keyboard button is the only way to raise it.
    })
    : null;
  // Turning the phone refits the picture; a zoom from the old layout would no longer line up.
  window.addEventListener("orientationchange", () => trackpad && trackpad.resetZoom());
  const stage = $("bsStage");
  const floatRow = $("bsFloat");
  const titleEl = $("bsTitle");
  const overlay = $("bsOverlay");
  const overlayTitle = $("bsOverlayTitle");
  const overlayBody = $("bsOverlayBody");
  const banner = $("bsBanner");
  const leaseBadge = $("bsLease");
  const backBtn = $("bsBack");
  const handbackBtn = $("bsHandback");
  const startBtn = $("bsStart");
  const keyboardBtn = $("bsKeyboard");
  const pasteBtn = $("bsPaste");
  const copyBtn = $("bsCopy");
  const reconnectBtn = $("bsReconnect");
  const kbd = $("bsKbd");
  const imagePick = $("bsImagePick");

  let openFlag = false;
  let phase = "loading"; // loading | connecting | attaching | live | stopped | unavailable | error
  // The picture comes first: the title and the control row stay hidden until a desktop image is on
  // screen, then fade in. Stopped, unavailable and error states show them at once, since Start/Refresh live there.
  let imageShown = false;
  function syncChromeWait() {
    if (!openFlag) return; // closing: the title and row ride out with the pane as they are
    const waiting = !imageShown && (phase === "loading" || phase === "connecting" || phase === "attaching" || phase === "live");
    shell.classList.toggle("bs-chrome-wait", waiting);
  }
  let status = null;
  let lease = null;
  let viewer = null; // { id, hash, epoch } minted by display.observe on THIS RPC connection
  let errorText = "";
  let unavailableText = "";
  let bannerText = "";
  let busy = false;
  let rfb = null;
  let socket = null;
  let generation = 0; // open/close lifetime
  let attachSeq = 0; // one attach attempt
  let statusSeq = 0;
  let leaseEventSeq = 0; // bump on every authoritative lease event; older status snapshots must not replace it
  let attaching = false;
  let dialedAt = 0;
  let rapidEvictions = 0;
  let badTicketRetries = 0;
  let lastBadTicketAt = 0;
  let networkRetries = 0;
  let retryTimer = null;
  let pasteTimer = null;
  let prevFocus = null;
  let slideAnim = null; // the running slide-out, so a quick reopen can cancel it
  let closeBack = null;
  let resolveCloseBack = null;
  let composing = false;
  let compositionCommittedAt = 0;
  let compositionCommittedText = "";
  let lastComposingValue = "";
  // Floating-row anchoring: coalesced rAF + observers that live only while the viewer is open.
  let floatRaf = 0;
  let hostObserver = null;
  let canvasObserver = null;
  let hostMutation = null;
  let observedCanvas = null;
  let hostInset = "";
  // Auto take-over / auto hand-back.
  let acquiring = false; // one display.lease.acquire at a time; input in between is dropped
  let takeWindowUntil = 0; // after the "agent is working" toast, input before this still takes over
  let idleTimer = null; // 20 s of quiet while holding
  let countdownTimer = null; // the last 5 s, drawn as a ring on Hand Back

  const conn = () => deps.getConnection() || { ready: false, epoch: 0 };
  const rpcReady = () => Boolean(conn().ready);
  // Docked: on a wide window the computer is a right-hand pane beside a still-usable chat, not a full-screen overlay.
  const docked = () => Boolean(deps.isDocked && deps.isDocked());
  // The header button is a back arrow in the overlay and an X that closes the pane when docked.
  const CLOSE_X = "M6 6l12 12M18 6L6 18";

  function syncBackButton() {
    const isDocked = docked();
    // Phones and narrow windows: the close control is the "active" monitor button, in the same spot as the chat's
    // Computer button, so the button that opened the computer also closes it. Docked hides it.
    const label = "Close computer";
    backBtn.setAttribute("aria-label", label);
    backBtn.setAttribute("title", label);
    const svg = backBtn.querySelector("svg");
    if (svg) {
      svg.innerHTML = isDocked
        ? `<path d="${CLOSE_X}"/>`
        : '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>';
    }
    // In docked mode the chat stays usable, so the pane is no longer a modal dialog.
    shell.setAttribute("aria-modal", isDocked ? "false" : "true");
  }

  function leaseIsMine() {
    return Boolean(lease && lease.holder === "human" && viewer && viewer.hash && lease.viewer_hash === viewer.hash);
  }

  function iHold() {
    // Authority is only meaningful on an open viewer whose id was minted by the current RPC connection, and while the
    // backend still says the desktop runs. A stale lease must never light the controls.
    return Boolean(
      openFlag &&
        rpcReady() &&
        viewer &&
        viewer.epoch === conn().epoch &&
        (!status || status.running !== false) &&
        leaseIsMine(),
    );
  }

  function humanOther() {
    return Boolean(lease && lease.holder === "human" && !leaseIsMine());
  }

  function syncLeaseInput() {
    if (rfb) rfb.viewOnly = !iHold();
    if (trackpad && iHold()) trackpad.show();
    if (!iHold()) {
      if (document.activeElement === kbd) kbd.blur();
    }
    syncIdle();
  }

  // ---------- auto hand-back ----------
  // The lease belongs to the person at the screen, not to a tab left open: 20 s of quiet while holding hands control
  // back to the agent, so her next action is never refused by a lease nobody is using.
  function clearIdleTimers() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (countdownTimer) clearTimeout(countdownTimer);
    countdownTimer = null;
    if (handbackBtn) handbackBtn.classList.remove("counting");
  }

  function armIdleTimer() {
    clearIdleTimers();
    if (!iHold()) return;
    // The quiet window ends with the ring: the countdown's 5 s are the tail of the same 20 s, so the hand-back lands
    // exactly 20 s after the last input, not 25.
    idleTimer = setTimeout(onIdleElapsed, IDLE_HAND_BACK_MS - COUNTDOWN_MS);
  }

  function onIdleElapsed() {
    idleTimer = null;
    if (!iHold()) return;
    // A raised keyboard is an unsent reply: never pull control while it is up, the field would lose focus mid-sentence.
    if (keyboardShown() || document.activeElement === kbd) {
      idleTimer = setTimeout(onIdleElapsed, IDLE_HAND_BACK_MS - COUNTDOWN_MS);
      return;
    }
    // The last 5 s are visible on the button, so the hand-back never surprises anyone.
    handbackBtn.classList.add("counting");
    countdownTimer = setTimeout(() => {
      countdownTimer = null;
      handbackBtn.classList.remove("counting");
      if (!iHold()) return;
      if (busy) {
        // A start or release is already in flight: wait out another quiet stretch instead of dropping the lease mid-way.
        idleTimer = setTimeout(onIdleElapsed, IDLE_HAND_BACK_MS - COUNTDOWN_MS);
        return;
      }
      void handBack();
    }, COUNTDOWN_MS);
  }

  // Keeps the idle timer in step with who holds control; safe to call any number of times (never restarts a live one).
  function syncIdle() {
    if (!openFlag || !iHold()) {
      clearIdleTimers();
      return;
    }
    if (!idleTimer && !countdownTimer) idleTimer = setTimeout(onIdleElapsed, IDLE_HAND_BACK_MS - COUNTDOWN_MS);
  }

  // Any input the person sends to the remote restarts the 20 s.
  function noteInput() {
    if (!iHold()) return;
    armIdleTimer();
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = null;
  }

  function scheduleRetry(delay, fn) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (openFlag) fn();
    }, delay);
  }

  function downUp(client, keysym, code) {
    client.sendKey(keysym, code, true);
    client.sendKey(keysym, code, false);
  }

  function sendKeyPress(keysym, code) {
    if (!rfb || !iHold()) return;
    downUp(rfb, keysym, code);
    noteInput();
  }

  function sendTextKeys(text) {
    if (!rfb || !iHold() || !text) return;
    for (const char of [...text]) {
      const keysym = keysymForChar(char);
      if (keysym !== null) downUp(rfb, keysym, "");
    }
    noteInput();
  }

  function sendPaste(text) {
    const value = String(text || "").slice(0, MAX_PASTE_CUT_TEXT);
    if (!value || !rfb || !iHold()) return;
    try {
      rfb.clipboardPasteFrom(value);
    } catch {
      return;
    }
    noteInput();
    // Clipboard delivery is asynchronous; Ctrl+V after a beat lands after the server has the selection.
    pressRemotePaste(50);
  }

  // The remote paste keystroke, reused by text and images. Clearing any pending press keeps one
  // paste from following another too closely.
  function pressRemotePaste(delay) {
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      pasteTimer = null;
      if (!rfb || !iHold()) return;
      rfb.sendKey(KeyTable.XK_Control_L, "ControlLeft", true);
      downUp(rfb, 0x76, "KeyV");
      rfb.sendKey(KeyTable.XK_Control_L, "ControlLeft", false);
    }, delay);
  }

  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    shell.style.setProperty("--bs-vh", `${vv.height}px`);
    shell.style.setProperty("--bs-vt", `${vv.offsetTop}px`);
  }

  function setPhase(next) {
    phase = next;
    syncChromeWait();
    renderChrome();
  }

  function setBanner(text) {
    bannerText = text || "";
    renderChrome();
  }

  function overlayForPhase() {
    if (phase === "loading") {
      return { title: "Checking the screen…", body: `Reading ${AGENT}'s desktop status.` };
    }
    if (phase === "unavailable") {
      return { title: "Screen unavailable", body: unavailableText };
    }
    if (phase === "stopped") {
      return {
        title: "Screen is stopped",
        body: (status && status.blocker) || `${AGENT}'s desktop is not running. Start it to watch the screen.`,
      };
    }
    if (phase === "error") {
      return { title: "Couldn't show the screen", body: errorText };
    }
    if ((phase === "attaching" || phase === "connecting") && !rfb) {
      return { title: "Connecting…", body: `Opening a live view of ${AGENT}'s desktop.` };
    }
    return null;
  }

  function renderChrome() {
    if (!openFlag) return;
    const hold = iHold();
    const other = humanOther();
    // A stopped desktop has no control to describe: hide the ownership label and leave only Start.
    const stopped = phase === "stopped" || !!(status && status.running === false);
    leaseBadge.hidden = stopped;

    leaseBadge.textContent = hold ? "You're in control" : other ? "Another viewer in control" : `${AGENT}'s in control`;
    leaseBadge.dataset.owner = hold ? "you" : other ? "other" : "agent";

    // No Take Over button: input itself takes over. Hand Back shows only while you hold control,
    // and its ring counts down the last 5 s before the automatic release.
    handbackBtn.hidden = !hold;
    handbackBtn.disabled = busy;
    if (!hold) handbackBtn.classList.remove("counting");

    startBtn.hidden = !(status && status.supported && status.installed && status.running === false);
    startBtn.disabled = busy;

    // Without control there is no remote keyboard, so hide it instead of spending scarce phone height on a dead control.
    keyboardBtn.hidden = !hold;
    keyboardBtn.disabled = !hold || !rfb;
    // Copy/Paste stay available while watching: pressing either takes control first, then runs.
    if (pasteBtn) {
      pasteBtn.hidden = !rfb;
      pasteBtn.disabled = !rfb || busy;
    }
    if (copyBtn) {
      copyBtn.hidden = !rfb;
      copyBtn.disabled = !rfb || busy;
    }
    reconnectBtn.disabled = busy || phase === "attaching";
    // Live or still connecting, the viewer reconnects by itself; the button only shows once that has given up (the
    // error and unavailable screens), where it is the "try again".
    reconnectBtn.hidden = !(phase === "error" || phase === "unavailable");

    const over = overlayForPhase();
    overlay.hidden = !over;
    if (over) {
      overlayTitle.textContent = over.title;
      overlayBody.textContent = over.body;
    }
    banner.hidden = !bannerText;
    banner.textContent = bannerText;
    // Ownership/actions can change the row's height; re-anchor it above the current image.
    scheduleFloatLayout();
  }

  function applyViewport() {
    if (!rfb) return;
    // The panel always fits the whole desktop; the remote resolution is never changed (resizeSession = false).
    rfb.scaleViewport = true;
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    rfb.resizeSession = false;
  }

  // ---------- floating row anchoring ----------
  // The real desktop image is noVNC's canvas inside #bsHost: it is centered (letterboxed) by noVNC's
  // flex + margin:auto layout, so the stage's own box says nothing about where the picture is. Measure
  // the canvas actually on screen; the remote framebuffer size is never used as a stand-in.

  function desktopCanvas() {
    if (!host) return null;
    let best = null;
    let bestArea = 0;
    for (const canvas of host.querySelectorAll("canvas")) {
      const style = getComputedStyle(canvas);
      // The software cursor overlay is a fixed-position canvas; it is not the desktop image.
      if (style.position === "fixed" || style.display === "none" || style.visibility === "hidden") continue;
      const rect = canvas.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = canvas;
      }
    }
    return best;
  }

  function applyFloatLayout() {
    if (!openFlag || !stage || !floatRow) return;
    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;

    const canvas = desktopCanvas();
    const probe = canvas ? canvas.getBoundingClientRect() : null;
    const hasImage = Boolean(probe && probe.width > 0 && probe.height > 0);

    // A constant band, only while an image exists: noVNC refits into the remaining host area, which
    // guarantees the row a place to sit above the image. A constant (never measured from the row or the
    // canvas) is what keeps the ResizeObserver from toggling this and looping.
    // Phones: the picture goes to the top so a trackpad surface can fill the rest. Its height comes from the desktop's
    // aspect and the stage width only (never from the drawn canvas), so this cannot loop with the ResizeObserver.
    let hostTop = hasImage ? FLOAT_CLEARANCE_PX : 0;
    let hostBottom = hostTop;
    let padBox = null;
    const fbW = rfb && rfb._fbWidth;
    const fbH = rfb && rfb._fbHeight;
    const dockedNow = docked();
    if (hasImage && touchQuery.matches && !dockedNow && fbW > 0 && fbH > 0) {
      const picH = Math.round(stageRect.width * fbH / fbW);
      // At most 40% of the screen tall: a taller pad only moves the thumb further. The pad
      // sits at the bottom and the picture right above it, so the spare room is at the top, away from the thumb.
      const screenH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const room = stageRect.height - (PAD_TOP_PX + picH + FLOAT_CLEARANCE_PX) - PAD_GAP_PX;
      const padH = Math.min(room, Math.round(screenH * 0.4));
      if (padH >= PAD_MIN_PX) {
        const padTop = stageRect.height - PAD_GAP_PX - padH;
        hostTop = padTop - FLOAT_CLEARANCE_PX - picH;
        hostBottom = stageRect.height - hostTop - picH;
        padBox = { top: padTop, height: padH };
      }
    }
    const insetKey = `${hostTop}/${hostBottom}`;
    if (insetKey !== hostInset) {
      hostInset = insetKey;
      stage.style.setProperty("--bs-host-top", `${hostTop}px`);
      stage.style.setProperty("--bs-host-bottom", `${hostBottom}px`);
    }
    if (pad) {
      pad.hidden = !padBox;
      if (helpBtn) helpBtn.hidden = !padBox;
      if (padBox) {
        stage.style.setProperty("--bs-pad-top", `${padBox.top}px`);
        stage.style.setProperty("--bs-pad-h", `${padBox.height}px`);
      }
    }

    if (imageShown !== hasImage) {
      imageShown = hasImage;
      syncChromeWait();
    }
    if (!hasImage) {
      if (titleEl) titleEl.style.transform = "";
      floatRow.classList.add("bs-float-fallback");
      stage.style.removeProperty("--bs-float-top");
      stage.style.removeProperty("--bs-float-left");
      stage.style.removeProperty("--bs-float-right");
      return;
    }

    // Re-read after the inset change: the host may already be shorter, so the canvas may have moved. The trackpad's
    // zoom is a transform on the canvas; measure the picture without it so the controls stay put while zoomed.
    const zoomTransform = canvas.style.transform;
    if (zoomTransform) canvas.style.transform = "";
    const image = canvas.getBoundingClientRect();
    if (zoomTransform) canvas.style.transform = zoomTransform;
    floatRow.classList.remove("bs-float-fallback");
    const top = Math.max(0, image.bottom - stageRect.top + FLOAT_GAP_PX); // the row sits under the picture
    const left = Math.max(0, image.left - stageRect.left + FLOAT_INSET_PX);
    const right = Math.max(0, stageRect.right - image.right + FLOAT_INSET_PX);
    stage.style.setProperty("--bs-float-top", `${top}px`);
    stage.style.setProperty("--bs-float-left", `${left}px`);
    stage.style.setProperty("--bs-float-right", `${right}px`);
    // The title rides down from the header to sit just above the centred picture.
    if (titleEl) {
      titleEl.style.transform = "";
      const titleRect = titleEl.getBoundingClientRect();
      const dy = Math.max(0, image.top - FLOAT_GAP_PX - titleRect.bottom);
      titleEl.style.transform = dy ? `translateY(${dy}px)` : "";
    }
  }

  function scheduleFloatLayout() {
    if (!openFlag || floatRaf) return;
    floatRaf = requestAnimationFrame(() => {
      floatRaf = 0;
      if (openFlag) applyFloatLayout();
    });
  }

  function watchCanvas() {
    if (!canvasObserver) return;
    const canvas = desktopCanvas();
    if (canvas === observedCanvas) return;
    if (observedCanvas) canvasObserver.unobserve(observedCanvas);
    observedCanvas = canvas;
    if (canvas) canvasObserver.observe(canvas);
  }

  function startFloatWatch() {
    stopFloatWatch();
    if (!stage || !host) return;
    if (typeof ResizeObserver === "function") {
      // Host resize covers window resize, rotation, the mobile keyboard (--bs-vh) and the reserved band.
      hostObserver = new ResizeObserver(scheduleFloatLayout);
      hostObserver.observe(host);
      // The canvas gets new CSS dimensions whenever noVNC refits after a resize or a framebuffer change.
      canvasObserver = new ResizeObserver(scheduleFloatLayout);
    }
    if (typeof MutationObserver === "function") {
      // A canvas appearing/disappearing is attach, reconnect or stop; follow the new one.
      hostMutation = new MutationObserver(() => {
        watchCanvas();
        scheduleFloatLayout();
      });
      hostMutation.observe(host, { childList: true, subtree: true });
    }
    watchCanvas();
    scheduleFloatLayout();
    settleFloat();
  }

  // noVNC can refit the canvas (first frame, framebuffer resize) without an event the observers see, which left the
  // floating row at the stage edges until the window was resized. Re-measure a few times while the picture settles.
  let settleTimers = [];
  function settleFloat() {
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = [150, 400, 800, 1500, 3000, 5000].map((ms) => setTimeout(() => {
      watchCanvas();
      scheduleFloatLayout();
    }, ms));
  }

  // keepLayout: leave the picture, title and control row where they are (the pane is sliding out); the next open's
  // startFloatWatch recomputes everything anyway.
  function stopFloatWatch({ keepLayout = false } = {}) {
    if (floatRaf) {
      cancelAnimationFrame(floatRaf);
      floatRaf = 0;
    }
    if (hostObserver) {
      hostObserver.disconnect();
      hostObserver = null;
    }
    if (canvasObserver) {
      canvasObserver.disconnect();
      canvasObserver = null;
    }
    if (hostMutation) {
      hostMutation.disconnect();
      hostMutation = null;
    }
    observedCanvas = null;
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = [];
    if (stage && !keepLayout) {
      stage.style.removeProperty("--bs-float-top");
      stage.style.removeProperty("--bs-float-left");
      stage.style.removeProperty("--bs-float-right");
      stage.style.removeProperty("--bs-host-top");
      stage.style.removeProperty("--bs-host-bottom");
      if (pad) pad.hidden = true;
      if (helpBtn) helpBtn.hidden = true;
      if (helpSheet) helpSheet.hidden = true;
      // The title keeps its place while the pane slides out; the next open hides it until the picture is back.
    }
    hostInset = "";
    if (floatRow) floatRow.classList.remove("bs-float-fallback");
  }

  function detachViewer({ handBack = false } = {}) {
    attachSeq += 1;
    attaching = false;
    clearIdleTimers();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = null;
    const ws = socket;
    const client = rfb;
    socket = null;
    rfb = null;
    // Intentional close: send 1000 before noVNC's disconnect so the bridge sees a clean viewer close (and releases our
    // lease) instead of noVNC's default 1006. Reconnect teardown intentionally leaves the lease in place.
    if (handBack && ws) {
      try {
        ws.close(1000, "viewer closed");
      } catch {
        /* already closed */
      }
    }
    if (client) {
      try {
        client.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    if (host) host.replaceChildren();
  }

  async function refreshStatus() {
    if (!openFlag) return;
    if (!rpcReady()) {
      setBanner("Waiting for Hermes to reconnect…");
      setPhase("connecting");
      return;
    }
    const seq = ++statusSeq;
    const leaseAt = leaseEventSeq;
    try {
      const next = await deps.rpc("display.status", {}, RPC_SHORT_MS);
      if (!openFlag || seq !== statusSeq) return;
      // A lease event that landed while this read was in flight is newer than the snapshot in the reply.
      applyStatus(leaseEventSeq === leaseAt ? next : { ...next, lease });
    } catch (error) {
      if (!openFlag || seq !== statusSeq) return;
      if (isDisplayUnavailable(error)) {
        unavailableText = readableError(error);
        setPhase("unavailable");
        return;
      }
      if (!rpcReady()) {
        setPhase("connecting");
        return;
      }
      errorText = readableError(error);
      setPhase("error");
    }
  }

  function applyStatus(next) {
    if (!next || !openFlag) return;
    status = { ...(status || {}), ...next };
    lease = next.lease || lease;
    syncLeaseInput();
    if (status.supported === false) {
      unavailableText = "This Hermes build does not support the bot desktop.";
      setPhase("unavailable");
      return;
    }
    if (status.installed === false) {
      unavailableText = "The bot desktop packages are not installed on this host.";
      setPhase("unavailable");
      return;
    }
    if (!status.running) {
      if (rfb || socket) detachViewer({ handBack: false });
      setPhase("stopped");
      return;
    }
    if (status.running && !rfb && !attaching && !retryTimer) {
      setPhase("connecting");
      void attach();
      return;
    }
    renderChrome();
  }

  async function attach(force = false) {
    if (!openFlag) return;
    if (!rpcReady()) {
      setPhase("connecting");
      setBanner("Waiting for Hermes to reconnect…");
      return;
    }
    if (!status || !status.running) {
      void refreshStatus();
      return;
    }
    if (attaching && !force) return;
    if (force) detachViewer({ handBack: false });
    attaching = true;
    const seq = ++attachSeq;
    const thisGeneration = generation;
    setBanner("");
    setPhase("attaching");

    try {
      // Load the client before dialing: noVNC's Websock installs its own onopen, so a socket opened while the dynamic
      // import is in flight would never hand it the open event.
      const module = await import("./vendor/novnc/core/rfb.js");
      const RFB = module.default;
      if (!openFlag || thisGeneration !== generation || seq !== attachSeq) return;
      if (!rpcReady()) return;

      const epoch = conn().epoch;
      if (viewer && viewer.epoch !== epoch) viewer = null;
      // A viewer id is honoured only on the RPC connection that minted it. Re-observing with this window's own id keeps
      // a reconnect bound to this pane; after an RPC reconnect it is gone, so the new observe mints a fresh identity.
      const leaseAt = leaseEventSeq;
      const observe = await deps.rpc("display.observe", viewer ? { viewer_id: viewer.id } : {}, RPC_SHORT_MS);
      if (!openFlag || thisGeneration !== generation || seq !== attachSeq) return;
      if (conn().epoch !== epoch || !rpcReady()) return;
      if (!observe || !observe.ticket) throw new Error("The screen did not return a stream ticket.");

      status = { ...(status || {}), ...observe };
      // The observe reply carries a status snapshot; a lease event that landed after the request is newer.
      if (leaseEventSeq === leaseAt) lease = observe.lease || lease;
      const hash = await viewerHash(observe.viewer_id);
      if (!openFlag || thisGeneration !== generation || seq !== attachSeq) return;
      if (conn().epoch !== epoch || !rpcReady()) return;
      viewer = { id: observe.viewer_id, hash, epoch };
      syncLeaseInput();

      const ws = new WebSocket(displayUrl(observe.ticket, observe.path));
      ws.binaryType = "arraybuffer";
      socket = ws;
      let closeCode = 0;
      let closeReason = "";
      // Register before noVNC installs its own onclose, so the close code is known when the disconnect event fires.
      ws.addEventListener("close", (event) => {
        closeCode = event.code;
        closeReason = event.reason || "";
      });

      dialedAt = Date.now();
      const client = new RFB(host, ws, { shared: true });
      rfb = client;
      if (trackpad) trackpad.reset();
      client.scaleViewport = true;
      client.clipViewport = false;
      client.dragViewport = false;
      client.resizeSession = false;
      client.focusOnClick = true;
      // Letterbox colour matches the app background, so the viewer reads as part of the app.
      client.background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#000000";
      client.qualityLevel = 7;
      client.compressionLevel = 2;
      client.viewOnly = !iHold();

      client.addEventListener("connect", () => {
        if (!openFlag || seq !== attachSeq) return;
        networkRetries = 0;
        setBanner("");
        setPhase("live");
        applyViewport();
        settleFloat(); // the first frames refit the canvas; keep the floating row on the picture's edges
      });
      client.addEventListener("disconnect", (event) => {
        if (!openFlag || seq !== attachSeq) return;
        onViewerDisconnected(closeCode, closeReason, event);
      });
    } catch (error) {
      if (!openFlag || thisGeneration !== generation || seq !== attachSeq) return;
      if (isDisplayUnavailable(error)) {
        unavailableText = readableError(error);
        setPhase("unavailable");
      } else if (/not running|display\.start/i.test(String(error && error.message))) {
        void refreshStatus();
      } else {
        errorText = readableError(error);
        setPhase("error");
      }
    } finally {
      if (seq === attachSeq) {
        attaching = false;
        renderChrome();
      }
    }
  }

  function onViewerDisconnected(closeCode, closeReason, event) {
    rfb = null;
    socket = null;
    attaching = false;
    clearIdleTimers();
    acquiring = false;
    takeWindowUntil = 0;
    const reason = closeReason || "";
    const clean = Boolean(event && event.detail && event.detail.clean);

    if (closeCode === CLOSE_CONTROL_TAKEN || /control-taken/i.test(reason)) {
      rapidEvictions = Date.now() - dialedAt < EVICTION_WINDOW_MS ? rapidEvictions + 1 : 1;
      if (rapidEvictions > MAX_RAPID_EVICTIONS) {
        errorText = "Another viewer keeps taking control. Reconnect to watch again.";
        setPhase("error");
      } else {
        setBanner("Another viewer took control. Reconnecting to watch…");
        setPhase("connecting");
        scheduleRetry(400, () => void attach(true));
      }
      return;
    }

    if (closeCode === CLOSE_BAD_TICKET) {
      // Consecutive expiry loops are bounded; an isolated expiry after a minute of real viewing gets a fresh budget.
      badTicketRetries = Date.now() - lastBadTicketAt < 60_000 ? badTicketRetries + 1 : 1;
      lastBadTicketAt = Date.now();
      if (badTicketRetries > 3) {
        errorText = "The screen ticket kept expiring. Reconnect to watch again.";
        setPhase("error");
        return;
      }
      setBanner("The screen ticket expired. Fetching a fresh one…");
      setPhase("connecting");
      scheduleRetry(300 * badTicketRetries, () => void attach(true));
      return;
    }

    if (closeCode === CLOSE_STOPPED) {
      status = { ...(status || {}), running: false };
      setPhase("stopped");
      void refreshStatus();
      return;
    }

    if (closeCode === 1000 || clean) {
      setPhase("connecting");
      void refreshStatus();
      return;
    }

    // Unexpected loss (network, suspend). Keep the lease on the server, keep this viewer id, and retry a bounded number
    // of times on this same RPC connection.
    networkRetries += 1;
    if (networkRetries > NET_BACKOFF_MS.length) {
      errorText = "The screen connection keeps dropping. Check the connection and try Reconnect.";
      setPhase("error");
      return;
    }
    setBanner("Screen connection lost. Reconnecting…");
    setPhase("connecting");
    scheduleRetry(NET_BACKOFF_MS[networkRetries - 1], () => void attach(true));
  }

  async function startScreen() {
    if (busy) return;
    const startGeneration = generation;
    busy = true;
    renderChrome();
    try {
      const next = await deps.rpc("display.start", {}, 120000);
      // A close/reopen while start was in flight owns the panel now; never paint this reply into it (and never stop the
      // desktop as a cleanup: starting was the user's explicit request).
      if (!openFlag || startGeneration !== generation) return;
      status = { ...(status || {}), ...next };
      lease = next.lease || lease;
      syncLeaseInput();
      setBanner("");
      setPhase("connecting");
      await attach();
    } catch (error) {
      if (openFlag && startGeneration === generation) setBanner(readableError(error));
    } finally {
      if (startGeneration === generation) {
        busy = false;
        renderChrome();
      }
    }
  }

  // ---------- auto take-over ----------
  // While watching, the first deliberate input takes control instead of doing nothing (and instead of hitting a desktop
  // the server refuses to let a viewer drive). The input itself is held back and replayed once the lease lands, so
  // noVNC never sees half a gesture.
  function canAutoTakeOver() {
    return Boolean(
      openFlag &&
        !busy &&
        rfb &&
        viewer &&
        phase === "live" &&
        rpcReady() &&
        viewer.epoch === conn().epoch &&
        (!status || status.running !== false),
    );
  }

  function autoTakeOver(replay) {
    if (iHold()) {
      if (replay) replay();
      return;
    }
    if (!canAutoTakeOver()) return;
    // Agent mid-reply: taking the lease now would refuse her next keystroke. Say so; the next input within the window
    // goes through anyway, since she may be waiting on the person rather than the other way round.
    if (deps.isAgentBusy && deps.isAgentBusy() && Date.now() >= takeWindowUntil) {
      takeWindowUntil = Date.now() + TAKE_NUDGE_MS;
      showToast(`${AGENT} is working — tap again to take over`);
      return;
    }
    if (acquiring) return; // one acquire in flight; input in between is dropped
    acquiring = true;
    void takeOver().then((ok) => {
      acquiring = false;
      if (ok && replay) replay();
    });
  }

  // A click or tap as noVNC itself would send it: move, press, release, in the canvas CSS pixels its helpers take.
  function clickRemote(x, y, bmask = 1) {
    if (!rfb || !iHold()) return;
    if (typeof rfb._handleMouseMove !== "function" || typeof rfb._handleMouseButton !== "function") return;
    rfb._handleMouseMove(x, y);
    rfb._handleMouseButton(x, y, bmask);
    rfb._handleMouseButton(x, y, 0);
    if (typeof rfb.focus === "function") rfb.focus({ preventScroll: true });
    noteInput();
  }

  function clickRemoteAtClient(clientX, clientY, bmask = 1) {
    const canvas = rfb && rfb._canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    clickRemote(clientX - rect.left, clientY - rect.top, bmask);
  }

  // A key exactly as the remote keyboard would have sent it (held, then released); `code` may be "".
  function keyRemote(keysym, code, focusCanvas = true) {
    if (!rfb || !iHold() || keysym === null) return;
    downUp(rfb, keysym, code || "");
    // The press that took control never reached noVNC, so put focus on the canvas for the keys that follow. On the
    // phone the hidden input keeps focus, or its on-screen keyboard would drop away mid-word.
    if (focusCanvas && typeof rfb.focus === "function") rfb.focus({ preventScroll: true });
    noteInput();
  }

  // Text typed into the hidden input while watching takes over first, then lands.
  function sendTextOrTakeOver(text) {
    if (!text) return;
    if (!iHold()) {
      autoTakeOver(() => sendTextKeys(text));
      return;
    }
    sendTextKeys(text);
  }

  // Trackpad gesture while watching: a tap is a click at that spot (or at the pad's pointer); a drag just starts
  // forwarding once the lease lands (trackpad.js adopts control mid-gesture).
  function onTrackpadIntent(intent) {
    if (!intent || !canAutoTakeOver()) return;
    if (intent.type === "move") {
      autoTakeOver(null);
      return;
    }
    if (intent.type !== "click") return;
    autoTakeOver(() => {
      if (intent.onPad) {
        const spot = trackpad && trackpad.pointer();
        if (spot) clickRemote(spot.x, spot.y, intent.button);
        return;
      }
      clickRemoteAtClient(intent.x, intent.y, intent.button);
    });
  }

  async function takeOver() {
    if (busy || !viewer) return false;
    const target = viewer;
    const takeGeneration = generation;
    busy = true;
    renderChrome();
    try {
      const result = await deps.rpc("display.lease.acquire", { viewer_id: target.id }, RPC_SHORT_MS);
      const current = openFlag && takeGeneration === generation && viewer && viewer.id === target.id && viewer.epoch === target.epoch;
      if (!current) {
        // The viewer was closed (or reincarnated on a new RPC connection) while acquire was in flight. If the server
        // granted control to the old viewer, hand it back best-effort; release with a viewer id is ignored unless that
        // viewer is still the holder, so it cannot yank control from someone who took over meanwhile.
        if (result && result.lease && result.lease.holder === "human" && rpcReady()) {
          // Backend ignores a release by a viewer that is no longer the holder, so this cannot yank control from a
          // newer controller; it only clears the grant that landed after this panel closed.
          deps.rpc("display.lease.release", { viewer_id: target.id }, 4000).catch(() => undefined);
        }
        return false;
      }
      lease = result.lease;
      // If SubtleCrypto is unavailable (an insecure origin), the grant itself proves this viewer's hash; adopt it so
      // control is still recognised after the acquire.
      if (viewer && !viewer.hash && lease.holder === "human" && lease.viewer_hash) viewer.hash = lease.viewer_hash;
      syncLeaseInput();
      if (!rfb) void attach();
      setBanner("");
      renderChrome();
      return iHold();
    } catch (error) {
      if (openFlag && takeGeneration === generation) setBanner(readableError(error));
      return false;
    } finally {
      if (takeGeneration === generation) {
        busy = false;
        renderChrome();
      }
    }
  }

  async function handBack() {
    if (busy || !iHold() || !viewer) return;
    const target = viewer;
    const handGeneration = generation;
    clearIdleTimers(); // the ring stops the moment it is pressed
    busy = true;
    renderChrome();
    try {
      const result = await deps.rpc("display.lease.release", { viewer_id: target.id }, RPC_SHORT_MS);
      if (!openFlag || handGeneration !== generation || !viewer || viewer.id !== target.id || viewer.epoch !== target.epoch) return;
      lease = result.lease;
      syncLeaseInput();
      setBanner("");
      renderChrome();
    } catch (error) {
      if (openFlag && handGeneration === generation) setBanner(readableError(error));
    } finally {
      if (handGeneration === generation) {
        busy = false;
        renderChrome();
        // Still ours (the release failed): start the quiet clock over instead of leaving control with no timer.
        syncIdle();
      }
    }
  }

  function manualReconnect() {
    if (busy) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    networkRetries = 0;
    badTicketRetries = 0;
    lastBadTicketAt = 0;
    rapidEvictions = 0;
    setBanner("");
    if (!rpcReady()) {
      setPhase("connecting");
      return;
    }
    if (!status || status.running === false || phase === "error") {
      void refreshStatus();
      return;
    }
    void attach(true);
  }

  function focusKeyboard() {
    if (!iHold() || !rfb) return;
    kbd.value = "";
    kbdFocusAt = performance.now();
    kbd.focus({ preventScroll: true });
    noteInput();
  }

  function openScreen() {
    if (openFlag) return Promise.resolve();
    if (closeBack) return closeBack.then(openScreen);
    openFlag = true;
    generation += 1;
    attachSeq += 1;
    phase = "loading";
    imageShown = false;
    syncChromeWait();
    status = null;
    lease = null;
    viewer = null;
    errorText = "";
    unavailableText = "";
    bannerText = "";
    busy = false;
    attaching = false;
    rapidEvictions = 0;
    badTicketRetries = 0;
    lastBadTicketAt = 0;
    networkRetries = 0;
    leaseEventSeq = 0;
    clearRetry();
    clearIdleTimers();
    acquiring = false;
    takeWindowUntil = 0;
    prevFocus = document.activeElement;
    if (slideAnim) slideAnim.cancel(); // reopened while still sliding out
    shell.classList.remove("bs-leaving-docked");
    dropFrozenFrame();
    slideAnim = null;
    shell.hidden = false;
    const enter = slide(true);
    if (enter) enter.onfinish = () => scheduleFloatLayout();
    // Docked: the chat keeps working, so .app is never inert; the pane sits to its right.
    if (app) app.inert = !docked();
    document.body.classList.add("bot-screen-open");
    document.body.classList.toggle("computer-docked", docked());
    syncBackButton();
    syncViewport();
    renderChrome();
    startFloatWatch();
    backBtn.focus({ preventScroll: true });
    if (!standalone && !(history.state && history.state.hermesMiniScreen === true)) history.pushState({ hermesMiniScreen: true }, "");
    if (rpcReady()) void refreshStatus();
    else setBanner("Waiting for Hermes to reconnect…");
    return Promise.resolve();
  }

  // Page-style transition: the viewer slides in from the right like a pushed page and slides
  // back out on close. Reduced motion skips it. Returns the Animation, or null when there is none.
  function slide(entering) {
    if (typeof shell.animate !== "function") return null;
    if (standalone || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
    const frames = [{ transform: "translateX(100%)" }, { transform: "translateX(0)" }];
    return shell.animate(entering ? frames : frames.reverse(), {
      duration: entering ? 320 : 240,
      easing: entering ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
    });
  }

  function freezeFrame() {
    dropFrozenFrame();
    const canvas = desktopCanvas();
    if (!canvas || !stage) return; // the still goes in the stage: closing empties the host
    try {
      const shot = document.createElement("img");
      shot.className = "bs-frozen";
      shot.alt = "";
      shot.src = canvas.toDataURL("image/jpeg", 0.8);
      const hr = stage.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      Object.assign(shot.style, {
        left: `${cr.left - hr.left}px`, top: `${cr.top - hr.top}px`, width: `${cr.width}px`, height: `${cr.height}px`,
      });
      stage.append(shot);
    } catch {
      // a tainted or lost canvas: slide out without the still
    }
  }

  function dropFrozenFrame() {
    if (stage) for (const node of stage.querySelectorAll(".bs-frozen")) node.remove();
  }

  function closeScreen({ viaPop = false } = {}) {
    if (standalone) return Promise.resolve();
    if (!openFlag) return closeBack || Promise.resolve();
    openFlag = false;
    generation += 1;
    attachSeq += 1;
    statusSeq += 1;
    attaching = false;
    clearRetry();
    clearIdleTimers();
    stopFloatWatch({ keepLayout: true });
    // Closing the stream removes noVNC's canvas at once; leave a still of the last frame in its place so the pane
    // slides out with the picture instead of empty. Removed once the pane is hidden or reopened.
    freezeFrame();
    const releasedViewer = viewer;
    const heldLease = leaseIsMine();
    if (document.activeElement === kbd) kbd.blur();
    // Close the stream first with a clean 1000: the bridge releases our lease on a clean viewer close even when the
    // release RPC below fails or the page is already going away.
    detachViewer({ handBack: true });
    if (heldLease && releasedViewer && rpcReady()) {
      deps.rpc("display.lease.release", { viewer_id: releasedViewer.id }, 4000).catch(() => undefined);
    }
    viewer = null;
    lease = null;
    status = null;
    phase = "loading";
    imageShown = false;
    errorText = "";
    unavailableText = "";
    bannerText = "";
    // Slides out to the right, then hides. A reopen during the slide cancels it (see openScreen).
    // Docked: the pane keeps its right-hand slot while it slides out, so it leaves to the right from where it was
    // instead of snapping to full width first.
    if (docked()) shell.classList.add("bs-leaving-docked");
    const out = slide(false);
    if (out) {
      slideAnim = out;
      out.onfinish = () => {
        if (slideAnim === out) slideAnim = null;
        shell.classList.remove("bs-leaving-docked");
        if (!openFlag) {
          shell.hidden = true;
          dropFrozenFrame();
        }
      };
    } else {
      shell.classList.remove("bs-leaving-docked");
      shell.hidden = true;
      dropFrozenFrame();
    }
    if (app) app.inert = false;
    document.body.classList.remove("bot-screen-open");
    document.body.classList.remove("computer-docked");
    if (!viaPop && history.state && history.state.hermesMiniScreen === true) {
      closeBack = new Promise((resolve) => {
        resolveCloseBack = resolve;
      });
      history.back();
    }
    const target = prevFocus && prevFocus.isConnected ? prevFocus : $("menuBtn");
    if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
    prevFocus = null;
    return closeBack || Promise.resolve();
  }

  // Crossing the breakpoint while the computer is open: docked makes it a right-hand pane beside a live chat (the app
  // is never inert), undocked returns it to the full-screen overlay with the chat locked behind it. The pane's new
  // width also needs the noVNC refit and floating control row recomputed now, not on the next window resize.
  function dockedChanged() {
    syncBackButton();
    if (!openFlag) {
      document.body.classList.remove("computer-docked");
      return;
    }
    document.body.classList.toggle("computer-docked", docked());
    if (app) app.inert = !docked();
    scheduleFloatLayout();
  }

  function onDisplayEvent(type, payload) {
    if (!openFlag || !payload) return;
    if (status && status.profile_key && payload.profile_key && payload.profile_key !== status.profile_key) return;
    if (type === "display.lease") {
      if (!payload.lease) return;
      lease = payload.lease;
      leaseEventSeq += 1;
      syncLeaseInput();
      renderChrome();
      return;
    }
    if (type === "display.status") {
      // This event is newer than any display.status read still in flight.
      statusSeq += 1;
      leaseEventSeq += 1;
      status = { ...(status || {}), ...payload };
      lease = payload.lease || lease;
      syncLeaseInput();
      if (payload.supported === false) {
        unavailableText = "This Hermes build does not support the bot desktop.";
        setPhase("unavailable");
        return;
      }
      if (payload.installed === false) {
        unavailableText = "The bot desktop packages are not installed on this host.";
        setPhase("unavailable");
        return;
      }
      if (!payload.running) {
        if (rfb || socket) detachViewer({ handBack: false });
        setPhase("stopped");
        return;
      }
      if (!rfb && !attaching && !retryTimer) {
        setPhase("connecting");
        void attach();
        return;
      }
      renderChrome();
    }
  }

  function onRpcReady() {
    if (!openFlag) return;
    // A new RPC connection cannot inherit the viewer id minted by the old one; drop it before anything asks to reobserve.
    if (viewer && viewer.epoch !== conn().epoch) viewer = null;
    badTicketRetries = 0;
    lastBadTicketAt = 0;
    networkRetries = 0;
    const hadStream = Boolean(rfb || socket);
    setBanner("");
    void (async () => {
      await refreshStatus();
      if (!openFlag) return;
      // Only replace a stream that survived the RPC drop. With no stream, refreshStatus already asked for a fresh attach.
      if (hadStream && status && status.running) void attach(true);
    })();
  }

  function onRpcDisconnected() {
    if (!openFlag) return;
    attachSeq += 1;
    statusSeq += 1;
    attaching = false;
    clearRetry();
    viewer = null; // authority belongs to the old RPC connection; a reconnect mints a fresh id
    syncLeaseInput();
    if (phase !== "stopped" && phase !== "unavailable") {
      setPhase("connecting");
      setBanner("Hermes connection lost. Reconnecting… input is paused.");
    } else {
      renderChrome();
    }
  }

  function trapFocus(event) {
    const scope = shell;
    const items = [...scope.querySelectorAll("button, input, textarea, [tabindex]:not([tabindex='-1'])")].filter(
      (node) => !node.disabled && !node.hidden && node.offsetParent !== null,
    );
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.shiftKey
      ? index <= 0
        ? items.length - 1
        : index - 1
      : index === -1 || index === items.length - 1
        ? 0
        : index + 1;
    items[next].focus({ preventScroll: true });
  }

  // ---------- listeners (registered once, independent of open/close) ----------

  backBtn.addEventListener("click", () => closeScreen());
  // A mouse press on the picture takes over and replays the click. Captured on the host and
  // stopped there, so noVNC never sees a press it would drop for want of the lease.
  if (host) {
    host.addEventListener("mousedown", (event) => {
      if (!openFlag || iHold()) return;
      if (event.button !== 0 && event.button !== 2) return;
      if (!canAutoTakeOver()) return;
      event.preventDefault();
      event.stopPropagation();
      const { clientX, clientY, button } = event;
      autoTakeOver(() => clickRemoteAtClient(clientX, clientY, button === 2 ? 4 : 1));
    }, true);
  }
  // Trackpad help: the ? opens a sheet of gestures; any tap closes it.
  if (helpBtn && helpSheet) {
    helpBtn.addEventListener("click", () => { helpSheet.hidden = false; });
    helpSheet.addEventListener("click", () => { helpSheet.hidden = true; });
  }
  // Anything the person sends to the remote restarts the 20 s hand-back clock. Local view gestures (a pinch on the
  // pad, the page scrolling outside the picture) never reach these surfaces.
  for (const surface of [host, pad]) {
    if (!surface) continue;
    for (const type of ["pointerdown", "pointermove", "touchstart", "touchmove", "wheel"]) {
      surface.addEventListener(type, () => noteInput(), { capture: true, passive: true });
    }
  }
  handbackBtn.addEventListener("click", () => void handBack());
  startBtn.addEventListener("click", () => void startScreen());
  // The keyboard button toggles: a second press hides the on-screen keyboard. Whether it was open
  // is read on press, before the tap can move focus off the hidden input; mousedown is cancelled so a mouse press
  // never steals that focus either.
  let kbdWasOpen = false;
  let kbdFocusAt = 0; // when the keyboard button last focused the hidden input
  // "Open" also needs the keyboard on screen: Android's own hide arrow dismisses it but leaves the input focused, and
  // that press must show it again, not hide nothing. The page uses interactive-widget=resizes-content, so innerHeight
  // shrinks with the keyboard too and cannot be the reference; the physical screen height can. A keyboard takes well
  // over a fifth of it.
  function keyboardShown() {
    if (document.activeElement !== kbd) return false;
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const full = (window.screen && window.screen.height) || 0;
    return !full || h < full * 0.78;
  }
  keyboardBtn.addEventListener("pointerdown", () => {
    kbdWasOpen = keyboardShown();
  });
  // Closing the keyboard with the phone's own down arrow leaves the hidden input focused, and Android then raises the
  // keyboard again on the next touch (the trackpad). Once the keyboard has been up and goes away, drop the focus, so
  // only the keyboard button brings it back.
  let kbdSeenUp = false;
  function checkKbdHidden() {
    if (document.activeElement !== kbd) {
      kbdSeenUp = false;
      return;
    }
    if (keyboardShown()) kbdSeenUp = true;
    else if (kbdSeenUp) {
      kbdSeenUp = false;
      kbd.blur();
    }
  }
  if (window.visualViewport) window.visualViewport.addEventListener("resize", checkKbdHidden);
  window.addEventListener("resize", checkKbdHidden);
  // Backstop: a touch anywhere on the computer while the hidden input is still focused but no keyboard is showing
  // means it was dismissed by the phone (down arrow, back) and a resize was missed. Drop the focus before Android can
  // raise the keyboard again. Runs in the capture phase on the whole page, ahead of the trackpad. The first second
  // after the button raises it is left alone, while the keyboard is still sliding up.
  shell.addEventListener("touchstart", () => {
    if (document.activeElement === kbd && !keyboardShown() && performance.now() - kbdFocusAt > 1000) kbd.blur();
  }, { capture: true, passive: true });
  kbd.addEventListener("blur", () => {
    kbdSeenUp = false;
    // The keyboard went away: the 20 s of quiet starts again from now, not from the last keystroke.
    if (iHold()) armIdleTimer();
  });
  keyboardBtn.addEventListener("mousedown", (event) => event.preventDefault());
  // ---------- clipboard ----------
  // Paste: your clipboard goes to the remote computer, then Ctrl+V is pressed there. Text rides RFB cut text
  // (sendPaste); images ride the plugin route, which puts them on the remote's CLIPBOARD selection as image/png
  //. Copy: her clipboard comes from the plugin route (the RFB stream never carries it: Hermes runs
  // Xvnc with -SendCutText=0) and lands on yours. Both need control: pressed while watching, they take it first, then
  // run (the server checks the same lease).
  const CLIPBOARD_URL = `${PREFIX}/api/plugins/hermes-mini/computer/clipboard`;
  const CLIPBOARD_IMAGE_URL = `${CLIPBOARD_URL}-image`;
  // Feedback is a toast, "Copied" or "Pasted"; text failures stay quiet, an image upload says so
  // in red.

  // The clipboard's picture, if the browser lets us read one. read() prompts or throws where the page has no
  // permission, and Safari/phones rarely expose files at all, so null simply means "fall through".
  async function clipboardImage() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") return null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = (item.types || []).find((candidate) => candidate.startsWith("image/"));
        if (type) return await item.getType(type);
      }
    } catch {
      // refused, or nothing usable: the text path, then the phone picker, get their turn
    }
    return null;
  }

  // Upload a picture to the remote clipboard, then ask the remote to paste it. Runs as the holder, taking control
  // first if the picker or an upload outlived the lease.
  async function pasteImage(blob) {
    if (!rfb || !blob) return;
    if (!iHold()) {
      autoTakeOver(() => void pasteImage(blob));
      return;
    }
    try {
      const res = await fetch(CLIPBOARD_IMAGE_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": blob.type || "image/png" },
        body: blob,
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      showToast("Couldn't paste the image", "error");
      return;
    }
    if (!rfb || !iHold()) return;
    noteInput();
    // xclip has just taken the remote selection; give it a moment before Ctrl+V asks for the contents.
    pressRemotePaste(150);
    showToast("Pasted");
  }

  // Phones: the file picker is the only way to reach a screenshot. Opened from pasteFromDevice when the clipboard
  // holds no text and no readable image, and only then, so text paste keeps its old behaviour.
  function openImagePicker() {
    if (!imagePick) return;
    imagePick.value = ""; // choosing the same screenshot twice still fires change
    imagePick.click();
  }
  if (imagePick) {
    imagePick.addEventListener("change", () => {
      const file = imagePick.files && imagePick.files[0];
      if (file) void pasteImage(file);
    });
  }

  async function pasteFromDevice() {
    if (!rfb) return;
    // Pressing Paste while watching takes control first, then pastes.
    if (!iHold()) {
      autoTakeOver(() => void pasteFromDevice());
      return;
    }
    const image = await clipboardImage();
    if (image) {
      await pasteImage(image);
      return;
    }
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = ""; // clipboard access refused
    }
    if (text) {
      sendPaste(text);
      showToast("Pasted");
      return;
    }
    // Neither an image nor text: on a phone, offer a screenshot instead. The standalone page does
    // not set data-input, so the coarse-pointer query covers it too.
    if (touchLayout() || (touchQuery && touchQuery.matches)) openImagePicker();
  }

  // A real paste event carries files where clipboard.read() is denied; files win over items,
  // and a text-only paste is left to the page as before.
  document.addEventListener("paste", (event) => {
    if (!openFlag || !rfb || !iHold()) return;
    const data = event.clipboardData;
    if (!data) return;
    let file = Array.from(data.files || []).find((candidate) => candidate.type.startsWith("image/"));
    if (!file) {
      for (const item of data.items || []) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          file = item.getAsFile();
          break;
        }
      }
    }
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    void pasteImage(file);
  }, true);

  async function readDesktop(which) {
    const res = await fetch(`${CLIPBOARD_URL}?which=${which}`, { credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const { text } = await res.json();
    return text || "";
  }

  // The Copy button takes what is highlighted on the desktop (highlighting alone never fills the clipboard on Linux),
  // falling back to the clipboard when nothing is highlighted. Ctrl/Cmd+C reads the clipboard the remote just filled.
  async function copyFromDesktop(options = {}) {
    const { quiet = false, selection = false } = options;
    if (!rfb) return;
    // Pressing Copy while watching takes control first, then copies; the server checks the lease.
    if (!iHold()) {
      autoTakeOver(() => void copyFromDesktop(options));
      return;
    }
    try {
      let text = selection ? await readDesktop("primary") : "";
      if (!text) text = await readDesktop("clipboard");
      if (!text) return;
      await navigator.clipboard.writeText(text);
      showToast("Copied");
    } catch {
      // the route refused (not in control) or the browser blocked the write: no toast
    }
  }

  if (pasteBtn) pasteBtn.addEventListener("click", () => void pasteFromDevice());
  if (copyBtn) copyBtn.addEventListener("click", () => void copyFromDesktop({ selection: true }));

  // A computer keyboard while you hold control: Ctrl/Cmd+V pastes YOUR clipboard (not whatever the remote last
  // copied), and Ctrl/Cmd+C lets the remote copy first, then brings the result over. Capture phase on the host, so
  // noVNC never sends the V itself (it would paste the remote's old clipboard before ours arrives).
  if (host) {
    host.addEventListener("keydown", (event) => {
      if (!rfb || !iHold() || event.repeat) return;
      const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "v") {
        event.preventDefault();
        event.stopPropagation();
        void pasteFromDevice();
      } else if (key === "c") {
        setTimeout(() => void copyFromDesktop({ quiet: true }), 300); // noVNC sends Ctrl+C; the remote copies
      }
    }, true);
  }

  keyboardBtn.addEventListener("click", () => {
    if (kbdWasOpen) {
      kbdWasOpen = false;
      kbd.blur();
      return;
    }
    if (document.activeElement === kbd) kbd.blur(); // focused but hidden: refocus so Android raises it again
    focusKeyboard();
  });
  // The keyboard button is lit while the on-screen keyboard is up.
  function syncKeyboardBtn() {
    const on = keyboardShown();
    keyboardBtn.classList.toggle("active", on);
    keyboardBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  kbd.addEventListener("focus", () => setTimeout(syncKeyboardBtn, 350));
  kbd.addEventListener("blur", syncKeyboardBtn);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", syncKeyboardBtn);
  reconnectBtn.addEventListener("click", () => manualReconnect());

  const keyMap = {
    Escape: [KeyTable.XK_Escape, "Escape"],
    Tab: [KeyTable.XK_Tab, "Tab"],
    Backspace: [KeyTable.XK_BackSpace, "Backspace"],
    Enter: [KeyTable.XK_Return, "Enter"],
    ArrowLeft: [KeyTable.XK_Left, "ArrowLeft"],
    ArrowUp: [KeyTable.XK_Up, "ArrowUp"],
    ArrowRight: [KeyTable.XK_Right, "ArrowRight"],
    ArrowDown: [KeyTable.XK_Down, "ArrowDown"],
    Delete: [KeyTable.XK_Delete, "Delete"],
    Home: [KeyTable.XK_Home, "Home"],
    End: [KeyTable.XK_End, "End"],
    PageUp: [KeyTable.XK_Page_Up, "PageUp"],
    PageDown: [KeyTable.XK_Page_Down, "PageDown"],
  };

  // The key a keydown would send to the remote, or null for keys that belong to the panel (Escape closes, Tab moves
  // focus) or the browser (Ctrl/Cmd/Alt shortcuts).
  function remoteKeyFor(event) {
    if (event.isComposing || event.keyCode === 229) return null;
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    if (event.key === "Escape" || event.key === "Tab" || event.key === "Shift" || event.key === "Control"
      || event.key === "Alt" || event.key === "Meta" || event.key === "CapsLock") return null;
    const entry = keyMap[event.key];
    if (entry) return { keysym: entry[0], code: entry[1] };
    if (typeof event.key === "string" && [...event.key].length === 1) {
      const keysym = keysymForChar(event.key);
      if (keysym !== null) return { keysym, code: event.code || "" };
    }
    return null;
  }

  // Typing while watching takes over too: the key is held back and sent once control lands.
  // On the shell in the capture phase, so it also works before the picture has ever been clicked (the header has focus).
  shell.addEventListener("keydown", (event) => {
    if (!openFlag || iHold() || event.defaultPrevented) return;
    const key = remoteKeyFor(event);
    if (!key || !canAutoTakeOver()) return;
    event.preventDefault();
    event.stopPropagation();
    const fromKeyboard = event.target === kbd;
    autoTakeOver(() => keyRemote(key.keysym, key.code, !fromKeyboard));
  }, true);
  // Keys the person sends while holding also restart the 20 s clock.
  shell.addEventListener("keydown", () => noteInput(), { capture: true, passive: true });

  kbd.addEventListener("compositionstart", () => {
    composing = true;
    lastComposingValue = "";
    compositionCommittedText = "";
    compositionCommittedAt = 0;
  });
  kbd.addEventListener("compositionend", (event) => {
    composing = false;
    // An empty compositionend is cancellation; unfinished pre-edit text must stay local.
    const text = typeof event.data === "string" ? event.data : kbd.value || lastComposingValue;
    kbd.value = "";
    compositionCommittedText = text;
    compositionCommittedAt = performance.now();
    lastComposingValue = "";
    if (text) sendTextOrTakeOver(text);
  });
  kbd.addEventListener("input", (event) => {
    if (composing || event.isComposing) {
      lastComposingValue = kbd.value;
      return;
    }
    // Some Android IMEs emit a final input after compositionend with the same committed text. Send it once.
    if (
      compositionCommittedText &&
      performance.now() - compositionCommittedAt < 80 &&
      (kbd.value === compositionCommittedText || kbd.value.endsWith(compositionCommittedText))
    ) {
      kbd.value = "";
      return;
    }
    const text = kbd.value;
    kbd.value = "";
    if (text) sendTextOrTakeOver(text);
  });
  // Android's soft keyboard often reports Backspace as keyCode 229 with no usable key value, then a beforeinput
  // deletion. Handling the edit here keeps delete/enter working on those IMEs (and on empty-value control keys).
  kbd.addEventListener("beforeinput", (event) => {
    if (!iHold() || !rfb || composing || event.isComposing) return;
    const type = event.inputType || "";
    if (type === "deleteContentBackward" || type === "deleteWordBackward" || type === "deleteSoftLineBackward") {
      event.preventDefault();
      sendKeyPress(KeyTable.XK_BackSpace, "Backspace");
      return;
    }
    if (type === "deleteContentForward" || type === "deleteWordForward") {
      event.preventDefault();
      sendKeyPress(KeyTable.XK_Delete, "Delete");
      return;
    }
    if (type === "insertLineBreak" || type === "insertParagraph") {
      event.preventDefault();
      sendKeyPress(KeyTable.XK_Return, "Enter");
    }
  });
  kbd.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const entry = keyMap[event.key];
    if (entry) {
      event.preventDefault();
      sendKeyPress(entry[0], entry[1]);
      return;
    }
    if ((event.ctrlKey || event.altKey) && typeof event.key === "string" && event.key.length === 1 && !event.metaKey) {
      event.preventDefault();
      if (!rfb || !iHold()) return;
      const modifiers = [];
      if (event.ctrlKey) modifiers.push({ keysym: KeyTable.XK_Control_L, code: "ControlLeft" });
      if (event.altKey) modifiers.push({ keysym: KeyTable.XK_Alt_L, code: "AltLeft" });
      for (const mod of modifiers) rfb.sendKey(mod.keysym, mod.code, true);
      const keysym = keysymForChar(event.key.toLowerCase());
      if (keysym !== null) downUp(rfb, keysym, "");
      for (const mod of modifiers.slice().reverse()) rfb.sendKey(mod.keysym, mod.code, false);
    }
  });
  kbd.addEventListener("paste", (event) => {
    const text = event.clipboardData && event.clipboardData.getData("text");
    if (!text) return;
    event.preventDefault();
    if (text.length > 160) sendPaste(text);
    else sendTextKeys(text);
  });

  shell.addEventListener("keydown", (event) => {
    // While the remote canvas holds control, keys (including Tab and Escape) belong to the remote. In watch mode the
    // canvas cannot use them, so the panel keeps its focus trap and Escape closes the viewer.
    const remoteOwnsKeys = event.target === kbd || (host.contains(event.target) && iHold());
    if (!remoteOwnsKeys && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeScreen();
      return;
    }
    if (!remoteOwnsKeys && event.key === "Tab" && !event.defaultPrevented) trapFocus(event);
    event.stopPropagation();
  });
  shell.addEventListener("keyup", (event) => event.stopPropagation());

  window.addEventListener("popstate", (event) => {
    if (resolveCloseBack) {
      const resolve = resolveCloseBack;
      resolveCloseBack = null;
      closeBack = null;
      resolve();
      return;
    }
    if (openFlag && !(event.state && event.state.hermesMiniScreen === true)) closeScreen({ viaPop: true });
  });

  window.addEventListener("resize", () => {
    if (openFlag) syncViewport();
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (openFlag) syncViewport();
    });
    window.visualViewport.addEventListener("scroll", () => {
      if (openFlag) syncViewport();
    });
  }

  syncBackButton();

  return {
    open: openScreen,
    close: closeScreen,
    isOpen: () => openFlag,
    dockedChanged,
    onDisplayEvent,
    onRpcReady,
    onRpcDisconnected,
  };
}
