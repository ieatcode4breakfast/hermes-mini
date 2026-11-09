// the computer: the phone screen as a laptop trackpad. Active only on touch, while you are
// in control. Every touch on the desktop is taken here (capture phase, so noVNC's own direct-touch gestures never see
// it) and turned into relative pointer input:
//   one finger slide        move the pointer (faster swipes travel further)
//   one finger tap          left click; two quick taps double-click
//   tap, then touch + slide drag (tap-and-a-half); also tap, then touch + hold, then slide
//   long press              right click
//   two finger tap          right click
//   two finger slide        scroll the remote app (natural, like the phone); while zoomed in, pan the view instead
//   pinch out / in          zoom the whole screen on the phone, centred on the pointer (1x to 6x, local only:
//                           the remote desktop is not resized). The view also follows the pointer to its edges.
//   three finger tap        middle click
// The pointer is drawn by noVNC's software cursor at the remote position, so it shows where a click will land.
//
// It drives noVNC's internal pointer helpers (_handleMouseMove, _handleMouseButton, _cursor.move). They are private to
// the vendored noVNC 1.7.0 and checked before use, so a future noVNC simply leaves the trackpad off.

const TAP_MS = 250; // a touch shorter than this, that barely moved, is a tap
const TAP_SLOP = 10; // px a tap may wander
const DRAG_GAP_MS = 320; // a touch this soon after a tap, near it, can start a drag
const LONG_PRESS_MS = 550;
const SCROLL_STEP = 22; // finger px per wheel notch
const MAX_ZOOM = 6;
const EDGE = 16; // screen px the pointer keeps from the view's edge before the zoomed view follows it
const BTN_LEFT = 1;
const BTN_MIDDLE = 2;
const BTN_RIGHT = 4;
const WHEEL_UP = 1 << 3;
const WHEEL_DOWN = 1 << 4;
const WHEEL_LEFT = 1 << 5;
const WHEEL_RIGHT = 1 << 6;

// canView: the viewer is showing a desktop (pinch-zoom and pan work then, even while only watching: they never touch
// the remote computer). isActive: you are in control (every other gesture needs that). onIntent: called once when a
// gesture while watching is a deliberate input (a tap, or a one-finger drag) so the host can take over and replay it;
// zoom and pan never call it.
export function createTrackpad({ host, pad = null, getRfb, isActive, canView = isActive, onTap, onIntent }) {
  let pos = null; // pointer in canvas CSS px
  let g = null; // the gesture in progress
  let lastTap = null; // { t, x, y } of the last one-finger tap, for tap-and-drag
  let longTimer = 0;
  // Local view zoom: the canvas is drawn translated by (tx, ty) and scaled by z, origin top left. pos stays in the
  // canvas's unzoomed CSS px, which is what noVNC's pointer helpers expect.
  const view = { z: 1, tx: 0, ty: 0 };

  function client() {
    const rfb = getRfb();
    if (!rfb || !rfb._canvas || typeof rfb._handleMouseMove !== "function" || typeof rfb._handleMouseButton !== "function") return null;
    return rfb;
  }

  function canvasRect(rfb) {
    return rfb._canvas.getBoundingClientRect();
  }

  // The canvas's own size, ignoring the zoom transform.
  function layoutSize(rfb) {
    return { w: rfb._canvas.offsetWidth || 1, h: rfb._canvas.offsetHeight || 1 };
  }

  function ensurePos(rfb) {
    const r = canvasRect(rfb);
    const { w, h } = layoutSize(rfb);
    if (!pos) {
      const mp = rfb._mousePos;
      pos = mp && typeof mp.x === "number" ? { x: mp.x, y: mp.y } : { x: w / 2, y: h / 2 };
    }
    pos.x = Math.min(Math.max(pos.x, 0), Math.max(0, w - 1));
    pos.y = Math.min(Math.max(pos.y, 0), Math.max(0, h - 1));
    return r;
  }

  // Keeps the zoomed picture covering its box (no empty edges) and draws it.
  function applyView(rfb) {
    const { w, h } = layoutSize(rfb);
    view.z = Math.min(Math.max(view.z, 1), MAX_ZOOM);
    view.tx = Math.min(0, Math.max(w - w * view.z, view.tx));
    view.ty = Math.min(0, Math.max(h - h * view.z, view.ty));
    const c = rfb._canvas;
    c.style.transformOrigin = "0 0";
    c.style.transform = view.z === 1 ? "" : `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
    // Zoomed, the crop rounds the corners; the canvas's own radius would scale up with it.
    c.style.borderRadius = view.z === 1 ? "" : "0";
    // Crop to the picture's own box: zooming magnifies inside the same rectangle instead of
    // spilling over the empty bands around it. The clip sits on noVNC's screen element, the canvas's parent.
    const parent = c.parentElement;
    if (!parent) return;
    if (view.z === 1) {
      parent.style.clipPath = "";
      return;
    }
    const pr = parent.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    const left = cr.left - view.tx - pr.left;
    const top = cr.top - view.ty - pr.top;
    const right = pr.width - left - w;
    const bottom = pr.height - top - h;
    const px = (v) => `${Math.max(0, Math.round(v))}px`;
    parent.style.clipPath = `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round 18px)`;
  }

  // Zooms to z keeping the pointer's spot fixed on screen.
  // anchor: the point that stays fixed, in unzoomed canvas px. In control it is the pointer; while watching (no
  // pointer of yours) it is the spot between the fingers.
  function zoomTo(rfb, z, anchor = null) {
    ensurePos(rfb);
    const a = anchor || pos;
    const nz = Math.min(Math.max(z, 1), MAX_ZOOM);
    view.tx += a.x * (view.z - nz);
    view.ty += a.y * (view.z - nz);
    view.z = nz;
    applyView(rfb);
    if (!anchor) showPointer(rfb);
  }

  // A screen point as unzoomed canvas px.
  function toCanvas(rfb, x, y) {
    const r = canvasRect(rfb);
    return { x: (x - r.left) / view.z, y: (y - r.top) / view.z };
  }

  // The middle of the visible picture, as unzoomed canvas px (the pinch anchor for a watcher pinching on the pad).
  function viewCentre(rfb) {
    const c = rfb._canvas.parentElement || rfb._canvas;
    const r = c.getBoundingClientRect();
    return toCanvas(rfb, r.left + r.width / 2, r.top + r.height / 2);
  }

  // While zoomed, pans just enough to keep the pointer inside the visible part of the picture.
  function followPointer(rfb) {
    if (view.z === 1) return;
    const { w, h } = layoutSize(rfb);
    const sx = view.tx + pos.x * view.z;
    const sy = view.ty + pos.y * view.z;
    if (sx < EDGE) view.tx += EDGE - sx;
    else if (sx > w - EDGE) view.tx -= sx - (w - EDGE);
    if (sy < EDGE) view.ty += EDGE - sy;
    else if (sy > h - EDGE) view.ty -= sy - (h - EDGE);
    applyView(rfb);
  }

  // noVNC draws the touch pointer at the remote cursor's full pixel size, which looks oversized next to a desktop
  // scaled down to fit the phone. Draw it at the desktop's scale instead, so it is the same size
  // as the pointer in the picture, with the hotspot (the arrow's tip) on the click position.
  function showPointer(rfb) {
    const r = ensurePos(rfb);
    const cursor = rfb._cursor;
    if (!cursor || typeof cursor.move !== "function") return;
    const scale = ((rfb._display && rfb._display.scale) || 1) * view.z;
    const img = cursor._canvas;
    const hot = cursor._hotSpot || { x: 0, y: 0 };
    if (img && img.width && img.height) {
      img.style.width = `${img.width * scale}px`;
      img.style.height = `${img.height * scale}px`;
    }
    cursor.move(r.left + (pos.x - hot.x * scale / view.z) * view.z, r.top + (pos.y - hot.y * scale / view.z) * view.z);
  }

  function moveBy(rfb, dx, dy, dt) {
    ensurePos(rfb);
    const { w, h } = layoutSize(rfb);
    // Pointer acceleration: slow slides are precise, quick flicks cross the screen. Zoomed in, the same slide covers
    // less of the desktop, so the pointer moves at the same speed on the phone screen.
    const speed = Math.hypot(dx, dy) / Math.max(dt, 1); // px per ms
    const gain = (1 + Math.min(speed * 1.6, 2.4)) / view.z;
    pos.x = Math.min(Math.max(pos.x + dx * gain, 0), Math.max(0, w - 1));
    pos.y = Math.min(Math.max(pos.y + dy * gain, 0), Math.max(0, h - 1));
    rfb._handleMouseMove(pos.x, pos.y);
    followPointer(rfb);
    showPointer(rfb);
  }

  function buttons(rfb, mask) {
    ensurePos(rfb);
    rfb._handleMouseButton(pos.x, pos.y, mask);
  }

  function click(rfb, button) {
    buttons(rfb, button);
    buttons(rfb, 0);
  }

  function wheel(rfb, bit, notches) {
    for (let i = 0; i < notches; i += 1) {
      buttons(rfb, bit);
      buttons(rfb, 0);
    }
  }

  // Two fingers down: the gesture becomes a scroll or a pinch, decided by the first clear movement.
  function armTwo(touches, c) {
    if (touches.length !== 2) return;
    g.two = null;
    g.c0 = c;
    g.d0 = spread(touches);
    g.z0 = view.z;
  }

  function spread(touches) {
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY) || 1;
  }

  function clearLong() {
    if (longTimer) clearTimeout(longTimer);
    longTimer = 0;
  }

  function centroid(touches) {
    let x = 0;
    let y = 0;
    for (const t of touches) {
      x += t.clientX;
      y += t.clientY;
    }
    return { x: x / touches.length, y: y / touches.length };
  }

  function onStart(event) {
    if (!canView()) return;
    const rfb = client();
    if (!rfb) return;
    event.preventDefault();
    event.stopPropagation();
    const now = event.timeStamp;
    const touches = event.touches;
    if (!g) {
      const t = touches[0];
      const nearTap = lastTap && now - lastTap.t < DRAG_GAP_MS && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 60;
      g = {
        start: now,
        last: now,
        sx: t.clientX,
        sy: t.clientY,
        lx: t.clientX,
        ly: t.clientY,
        maxFingers: touches.length,
        moved: false,
        dragArmed: Boolean(nearTap), // the second touch of tap-and-drag
        dragging: false,
        longFired: false,
        scrollX: 0,
        scrollY: 0,
        control: isActive(), // false: watching, so only zoom and pan
        intent: false, // the watching gesture already asked the host to take over
        onPad: Boolean(pad && event.currentTarget === pad), // the separate pad: finger spots are not desktop spots
      };
      if (!g.control) g.dragArmed = false;
      lastTap = null;
      if (touches.length > 1) {
        // Several fingers landed together: anchor on their centre.
        const c = centroid(touches);
        Object.assign(g, { sx: c.x, sy: c.y, lx: c.x, ly: c.y });
        armTwo(touches, c);
      }
      clearLong();
      if (!g.control) return;
      showPointer(rfb);
      longTimer = setTimeout(() => {
        longTimer = 0;
        if (!g || g.moved || g.maxFingers !== 1) return;
        if (g.dragArmed) {
          // tap, then touch and hold: press now, the slide that follows drags
          g.dragging = true;
          buttons(rfb, BTN_LEFT);
        } else {
          g.longFired = true;
          click(rfb, BTN_RIGHT);
        }
      }, g.dragArmed ? 220 : LONG_PRESS_MS);
    } else {
      g.maxFingers = Math.max(g.maxFingers, touches.length);
      const c = centroid(touches);
      g.lx = c.x;
      g.ly = c.y;
      clearLong();
      // A new finger moves the centroid; measure tap slop from here so a two-finger tap still counts as a tap.
      if (!g.moved) {
        g.sx = c.x;
        g.sy = c.y;
      }
      armTwo(touches, c);
    }
  }

  function onMove(event) {
    if (!g) return;
    const rfb = client();
    if (!rfb) return;
    event.preventDefault();
    event.stopPropagation();
    const touches = event.touches;
    if (!touches.length) return;
    // Control landed mid-gesture (an auto take-over): from now on this same gesture drives the remote.
    if (!g.control && isActive()) g.control = true;
    const c = touches.length === 1 ? { x: touches[0].clientX, y: touches[0].clientY } : centroid(touches);
    const dx = c.x - g.lx;
    const dy = c.y - g.ly;
    const dt = event.timeStamp - g.last;
    g.lx = c.x;
    g.ly = c.y;
    g.last = event.timeStamp;
    if (touches.length === 2 && !g.two && g.d0) {
      const pinchBy = Math.abs(spread(touches) - g.d0);
      const travel = Math.hypot(c.x - g.c0.x, c.y - g.c0.y);
      if (pinchBy > 24 && pinchBy > travel) g.two = "pinch";
      else if (travel > 14) g.two = "scroll";
      if (g.two) {
        g.moved = true; // a pinch or scroll is never a tap
        clearLong();
      }
    }
    if (!g.moved && Math.hypot(c.x - g.sx, c.y - g.sy) > TAP_SLOP) {
      g.moved = true;
      clearLong();
      // Watching: one finger actually travelling is a deliberate drag, not a view gesture (pinch and pan take two),
      // so the host takes over and this same gesture keeps driving from the next move.
      if (!g.control && !g.intent && touches.length === 1 && g.maxFingers === 1) {
        g.intent = true;
        if (onIntent) onIntent({ type: "move" });
      }
      if (g.dragArmed && !g.dragging && touches.length === 1) {
        g.dragging = true;
        buttons(rfb, BTN_LEFT);
      }
    }
    if (!g.moved) return;
    if (touches.length === 1 && g.maxFingers === 1) {
      if (g.control) moveBy(rfb, dx, dy, dt);
    } else if (touches.length === 2) {
      const d = spread(touches);
      if (g.two === "pinch") {
        zoomTo(rfb, g.z0 * (d / g.d0), g.control ? null : (g.onPad ? viewCentre(rfb) : toCanvas(rfb, c.x, c.y)));
        return;
      }
      if (g.two !== "scroll") return;
      if (view.z > 1) {
        // Zoomed in: two fingers move the picture, which follows the fingers.
        view.tx += dx;
        view.ty += dy;
        applyView(rfb);
        if (g.control) showPointer(rfb);
        return;
      }
      if (!g.control) return; // watching: scrolling would act on the computer
      // Natural scrolling: content follows the fingers, so fingers up = wheel down.
      g.scrollY += dy;
      g.scrollX += dx;
      const ny = Math.trunc(g.scrollY / SCROLL_STEP);
      const nx = Math.trunc(g.scrollX / SCROLL_STEP);
      if (ny) {
        wheel(rfb, ny < 0 ? WHEEL_DOWN : WHEEL_UP, Math.abs(ny));
        g.scrollY -= ny * SCROLL_STEP;
      }
      if (nx) {
        wheel(rfb, nx < 0 ? WHEEL_RIGHT : WHEEL_LEFT, Math.abs(nx));
        g.scrollX -= nx * SCROLL_STEP;
      }
    }
  }

  function onEnd(event) {
    if (!g) return;
    const rfb = client();
    event.preventDefault();
    event.stopPropagation();
    if (event.touches.length) {
      // A finger lifted but others remain: keep the gesture, re-anchor so the pointer does not jump.
      const c = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : centroid(event.touches);
      g.lx = c.x;
      g.ly = c.y;
      return;
    }
    clearLong();
    const done = g;
    g = null;
    if (!rfb) return;
    if (done.two === "pinch" && view.z < 1.08) zoomTo(rfb, 1, done.control ? null : { x: 0, y: 0 }); // snap to the whole screen
    if (!done.control) {
      // Watching: a tap is a deliberate click, so it takes over instead of doing nothing. A pinch,
      // scroll or pan never gets here (it sets moved/two), so a local view gesture never takes the lease. Speed does
      // not matter here: a slow tap is still a tap.
      if (!done.moved && !done.longFired && !done.two && !done.intent && done.maxFingers <= 3) {
        const button = done.maxFingers === 2 ? BTN_RIGHT : done.maxFingers === 3 ? BTN_MIDDLE : BTN_LEFT;
        if (onIntent) onIntent({ type: "click", button, x: done.sx, y: done.sy, onPad: done.onPad });
      }
      return;
    }
    if (done.dragging) {
      buttons(rfb, 0);
      return;
    }
    if (done.longFired || done.moved) return;
    const quick = event.timeStamp - done.start < (done.dragArmed ? TAP_MS + 150 : TAP_MS);
    if (!quick) return;
    if (done.maxFingers === 1) {
      click(rfb, BTN_LEFT);
      // Still inside the touchend (a user gesture), so the caller may raise the on-screen keyboard here.
      if (onTap) onTap(rfb, { double: Boolean(done.dragArmed) }); // dragArmed: this tap followed a tap (double tap)
      // A lone tap can start tap-and-drag; the second tap of a double-click cannot start a third.
      lastTap = done.dragArmed ? null : { t: event.timeStamp, x: done.sx, y: done.sy };
    } else if (done.maxFingers === 2) {
      click(rfb, BTN_RIGHT);
    } else if (done.maxFingers === 3) {
      click(rfb, BTN_MIDDLE);
    }
  }

  function onCancel(event) {
    if (!g) return;
    event.stopPropagation();
    clearLong();
    const rfb = client();
    if (g.dragging && rfb) buttons(rfb, 0);
    g = null;
  }

  const opts = { capture: true, passive: false };
  host.addEventListener("touchstart", onStart, opts);
  host.addEventListener("touchmove", onMove, opts);
  host.addEventListener("touchend", onEnd, opts);
  host.addEventListener("touchcancel", onCancel, opts);
  if (pad) {
    pad.addEventListener("touchstart", onStart, opts);
    pad.addEventListener("touchmove", onMove, opts);
    pad.addEventListener("touchend", onEnd, opts);
    pad.addEventListener("touchcancel", onCancel, opts);
  }

  return {
    // Forget the pointer (a new connection starts it from noVNC's last position or the centre).
    reset() {
      clearLong();
      g = null;
      lastTap = null;
      pos = null;
      this.resetZoom();
    },
    // Back to the whole screen (a new connection, or control handed back).
    resetZoom() {
      view.z = 1;
      view.tx = 0;
      view.ty = 0;
      const rfb = client();
      if (rfb) applyView(rfb);
    },
    // True while the view is zoomed in (the floating controls measure the picture without the zoom).
    zoomed() {
      return view.z !== 1;
    },
    // Puts the pointer on screen when control starts, so there is something to steer.
    show() {
      const rfb = client();
      if (rfb && isActive()) showPointer(rfb);
    },
    // Where the pointer sits, in unzoomed canvas CSS px: what a tap on the pad clicks once control lands
    //.
    pointer() {
      const rfb = client();
      if (!rfb) return null;
      ensurePos(rfb);
      return { x: pos.x, y: pos.y };
    },
  };
}

// Whether noVNC's current pointer image is a text I-beam, i.e. the tap landed on something you can type into. The
// image is the remote cursor shape the VNC server sends. An I-beam is narrow (well under half as wide as tall) and
// mirror-symmetric left to right; the arrow and the hand are neither.
export function pointerIsTextBeam(rfb) {
  const img = rfb && rfb._cursor && rfb._cursor._canvas;
  if (!img || !img.width || !img.height) return false;
  let data;
  try {
    data = img.getContext("2d").getImageData(0, 0, img.width, img.height).data;
  } catch {
    return false;
  }
  const w = img.width;
  const h = img.height;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return false;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bh < 10 || bw > bh * 0.55) return false;
  let same = 0;
  let total = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const a = data[(y * w + x) * 4 + 3] > 40;
      const b = data[(y * w + (maxX - (x - minX))) * 4 + 3] > 40;
      if (a || b) {
        total += 1;
        if (a === b) same += 1;
      }
    }
  }
  return total > 0 && same / total > 0.85;
}
