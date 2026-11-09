// Hermes Mini identity bootstrap: read the profile's agent name, picture and capability flags from
// the plugin's authenticated routes, then apply them to the page and gate the optional controls.
//
// The app title/bookmark stays "Hermes Mini" (index.html). The agent name shown in the header, the
// composer placeholder, the drawer's home row and notifications is the user's own: an explicit saved
// override wins, then the selected bot's title, the profile display name or a named profile id, and
// finally "Mini". Nothing is written here — saving happens only from the setup sheet's Save button.
//
// Imported by app.js as a normal ES module, so there is exactly one place that talks to these routes.

const API = "/api/plugins/hermes-mini";

const state = {
  identity: {
    name: "Mini",
    name_source: "default",
    avatar_url: "",
    home_label: "Mini",
    onboarding_complete: false,
    has_custom_avatar: false,
  },
  features: { computer: true, push: true, dictation: true, model_configured: true },
  pendingAvatar: null,
  pendingPreviewUrl: "",
  onIdentity: null,
};

const $ = (id) => document.getElementById(id);

function apiJson(path, init = {}) {
  return fetch(API + path, {
    credentials: "include",
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}) },
  }).then(async (res) => {
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return body;
  });
}

export function currentName() {
  return state.identity.name || "Mini";
}

export function currentHomeLabel() {
  return state.identity.home_label || currentName();
}

export function identity() {
  return { ...state.identity };
}

export function features() {
  return { ...state.features };
}

function applyIdentityToPage() {
  const name = currentName();
  const homeLabel = currentHomeLabel();
  const nameEl = document.querySelector(".identity .name");
  if (nameEl) nameEl.textContent = name;
  document.title = "Hermes Mini";
  const appName = document.querySelector('meta[name="application-name"]');
  if (appName) appName.content = "Hermes Mini";
  const agentMeta = document.querySelector('meta[name="agent-name"]');
  if (agentMeta) agentMeta.content = name;
  const homeMeta = document.querySelector('meta[name="home-label"]');
  if (homeMeta) homeMeta.content = homeLabel;

  const avatar = $("agentAvatar");
  if (avatar) avatar.src = state.identity.avatar_url || "avatar-placeholder.svg";
  const input = $("input");
  if (input) input.placeholder = `Message ${name}`;
  const screenBtn = $("screenBtn");
  if (screenBtn) {
    screenBtn.setAttribute("aria-label", `${name}'s Computer`);
    screenBtn.title = `${name}'s Computer`;
  }
  const restartBtn = $("restartBtn");
  if (restartBtn) {
    restartBtn.setAttribute("aria-label", `Restart ${name}`);
    restartBtn.title = `Restart ${name}`;
  }
  // app.js owns the header/caption; it asks for a redraw after the identity changes.
  if (typeof state.onIdentity === "function") state.onIdentity({ name, homeLabel });
}

function applyCapabilities() {
  // Hide a control only on a definite "no". The server's own checks remain the real gate.
  if (state.features.dictation === false) {
    const mic = $("micBtn");
    if (mic) mic.hidden = true;
  }
  if (state.features.computer === false) {
    const computer = $("screenBtn");
    if (computer) computer.hidden = true;
  }
  if (state.features.push === false) {
    const push = $("pushBtn");
    if (push) push.hidden = true;
  }
  // app.js wires its own behaviour and may run its checks at a different moment; hand it the same verdict.
  document.dispatchEvent(new CustomEvent("hermes-mini-capabilities", { detail: { ...state.features } }));
}

export async function loadStatus() {
  try {
    const data = await apiJson("/status");
    if (data && typeof data === "object") {
      state.identity = {
        name: typeof data.name === "string" && data.name ? data.name : "Mini",
        name_source: data.name_source || "default",
        avatar_url: data.avatar_url || "",
        home_label: data.home_label || data.name || "Mini",
        onboarding_complete: data.onboarding_complete === true,
        has_custom_avatar: data.has_custom_avatar === true,
      };
      if (data.features && typeof data.features === "object") {
        state.features = { ...state.features, ...data.features };
      }
    }
  } catch {
    // The plugin routes may not be mounted yet (the dashboard hot-mounts them on first request) or the
    // network blipped. Keep the neutral defaults: the page still works, and the server remains the gate.
  }
  applyIdentityToPage();
  applyCapabilities();
  return identity();
}

function showProviderGuidance() {
  const note = $("setupProviderNote");
  if (!note) return;
  if (state.features.model_configured === false) {
    note.hidden = false;
    note.innerHTML =
      "Hermes has no model selected yet. You can finish this setup and start chatting once a " +
      "provider is configured; the chat will tell you if it is missing. Setup guide: " +
      '<a href="https://hermes-agent.nousresearch.com/docs/" target="_blank" rel="noopener noreferrer">hermes-agent.nousresearch.com/docs</a>.';
  } else {
    note.hidden = true;
    note.textContent = "";
  }
}

function clearPreview() {
  if (state.pendingPreviewUrl) {
    URL.revokeObjectURL(state.pendingPreviewUrl);
    state.pendingPreviewUrl = "";
  }
}

function resetSetupForm() {
  clearPreview();
  state.pendingAvatar = null;
  const preview = $("setupPreview");
  if (preview) preview.src = state.identity.avatar_url || "avatar-placeholder.svg";
  const name = $("setupName");
  if (name) name.value = state.identity.name || "Mini";
  const home = $("setupHomeLabel");
  const defaultHome = state.identity.home_label && state.identity.home_label !== (state.identity.name || "Mini");
  if (home) home.value = defaultHome ? state.identity.home_label : "";
  const err = $("setupError");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  const file = $("setupFile");
  if (file) file.value = "";
  showProviderGuidance();
}

export function openSetup({ firstRun = false } = {}) {
  const dialog = $("setupDialog");
  const scrim = $("setupScrim");
  if (!dialog) return;
  resetSetupForm();
  const title = $("setupTitle");
  if (title) title.textContent = firstRun ? "Welcome to Hermes Mini" : "Your agent";
  const intro = $("setupIntro");
  if (intro) {
    intro.textContent = firstRun
      ? "Give your agent a name and a picture. Both are stored on this Hermes install, outside the app itself, so a later update keeps them."
      : "Change your agent's name or picture. Both are stored on this Hermes install, outside the app itself.";
  }
  const cancel = $("setupCancel");
  if (cancel) cancel.hidden = firstRun;
  const save = $("setupSave");
  if (save) save.textContent = firstRun ? "Get started" : "Save";
  dialog.hidden = false;
  if (scrim) scrim.classList.add("open");
  document.body.classList.add("setup-open");
  const focus = $("setupName");
  if (focus) setTimeout(() => focus.focus({ preventScroll: true }), 40);
}

function closeSetup() {
  const dialog = $("setupDialog");
  const scrim = $("setupScrim");
  if (dialog) dialog.hidden = true;
  if (scrim) scrim.classList.remove("open");
  document.body.classList.remove("setup-open");
  clearPreview();
  state.pendingAvatar = null;
}

function setupError(message) {
  const err = $("setupError");
  if (!err) return;
  err.textContent = message;
  err.hidden = !message;
}

async function pickAvatar(file) {
  setupError("");
  if (!file) return;
  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) {
    setupError("Use a PNG, JPEG or WebP image.");
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    setupError("That image is larger than 4 MB.");
    return;
  }
  const decoded = await new Promise((resolve) => {
    const probe = new Image();
    const url = URL.createObjectURL(file);
    probe.onload = () => {
      const ok = probe.naturalWidth >= 16 && probe.naturalHeight >= 16
        && probe.naturalWidth <= 2048 && probe.naturalHeight <= 2048;
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(false);
    };
    probe.src = url;
  });
  if (!decoded) {
    setupError("That file could not be read as an image, or its dimensions are outside 16–2048 px.");
    return;
  }
  state.pendingAvatar = file;
  clearPreview();
  state.pendingPreviewUrl = URL.createObjectURL(file);
  const preview = $("setupPreview");
  if (preview) preview.src = state.pendingPreviewUrl;
}

async function saveSettingsHomeLabel(homeLabel) {
  const value = homeLabel.trim();
  const current = state.identity.home_label || "";
  if (value === current || (!value && current === currentName())) return;
  try {
    await apiJson("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ home_label: value }),
    });
    state.identity.home_label = value || currentName();
  } catch {
    // A home label is cosmetic; the name and picture are already saved.
  }
}

async function saveSetup() {
  const nameInput = $("setupName");
  const homeInput = $("setupHomeLabel");
  const name = (nameInput && nameInput.value ? nameInput.value : "").trim();
  if (!name) {
    setupError("Enter a name for your agent.");
    if (nameInput) nameInput.focus();
    return;
  }
  if (!state.pendingAvatar && !state.identity.has_custom_avatar) {
    setupError("Choose a picture for your agent.");
    return;
  }
  const save = $("setupSave");
  if (save) save.disabled = true;
  setupError("");
  try {
    const query = new URLSearchParams({ name, complete: "1" });
    const init = { method: "POST", headers: {} };
    if (state.pendingAvatar) {
      init.headers["Content-Type"] = state.pendingAvatar.type || "application/octet-stream";
      init.body = await state.pendingAvatar.arrayBuffer();
    } else {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ name });
    }
    const saved = await apiJson(`/identity?${query.toString()}`, init);
    if (saved) {
      state.identity = {
        name: saved.name || name,
        name_source: saved.name_source || "app",
        avatar_url: saved.avatar_url || "",
        home_label: saved.home_label || saved.name || name,
        onboarding_complete: saved.onboarding_complete === true,
        has_custom_avatar: saved.has_custom_avatar === true,
      };
    }
    await saveSettingsHomeLabel(homeInput && homeInput.value ? homeInput.value : "");
    applyIdentityToPage();
    closeSetup();
  } catch (error) {
    setupError(error && error.message ? error.message : "Could not save your settings.");
  } finally {
    if (save) save.disabled = false;
  }
}

export function wire({ onIdentity } = {}) {
  if (typeof onIdentity === "function") state.onIdentity = onIdentity;
  const pick = $("setupPick");
  const file = $("setupFile");
  if (pick && file) {
    pick.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const chosen = file.files && file.files[0];
      if (chosen) void pickAvatar(chosen);
    });
  }
  const save = $("setupSave");
  if (save) save.addEventListener("click", () => void saveSetup());
  const cancel = $("setupCancel");
  if (cancel) cancel.addEventListener("click", () => closeSetup());
  const nameInput = $("setupName");
  if (nameInput) {
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveSetup();
      }
    });
  }
  const settingsBtn = $("settingsBtn");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => openSetup({ firstRun: !state.identity.onboarding_complete }));
  }
}

export async function boot() {
  await loadStatus();
  if (!state.identity.onboarding_complete) openSetup({ firstRun: true });
}
