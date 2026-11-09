// Hermes Mini identity bootstrap: read the serving profile's agent name, picture and capability flags
// from the plugin's authenticated routes, then apply them to the page and gate the optional controls.
//
// The name is Hermes' own: the default profile's bot title, then the serving profile's bot title, then
// its display name or a named profile id, and finally "Hermes". The app never renames the agent.
//
// Imported by app.js as a normal ES module, so there is exactly one place that talks to these routes.

const API = "/api/plugins/hermes-mini";

const state = {
  identity: {
    name: "Hermes",
    name_source: "default",
    avatar_url: "",
    home_label: "Hermes",
    onboarding_complete: false,
    has_custom_avatar: false,
  },
  features: { computer: true, push: true, dictation: true, model_configured: true },
  onIdentity: null,
};

const $ = (id) => document.getElementById(id);

async function apiJson(path, init = {}) {
  const token = window.__hermesMiniSessionToken ? await window.__hermesMiniSessionToken() : "";
  const res = await fetch(API + path, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(token ? { "X-Hermes-Session-Token": token } : {}),
      ...(init.headers || {}),
    },
  });
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
}

export function currentName() {
  return state.identity.name || "Hermes";
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
  // The tab title is the bot's name; the product name stays the app's own.
  document.title = name;
  const appName = document.querySelector('meta[name="application-name"]');
  if (appName) appName.content = "Hermes Mini";
  const agentMeta = document.querySelector('meta[name="agent-name"]');
  if (agentMeta) agentMeta.content = name;
  const homeMeta = document.querySelector('meta[name="home-label"]');
  if (homeMeta) homeMeta.content = homeLabel;

  const avatar = $("agentAvatar");
  if (avatar) {
    avatar.src = state.identity.avatar_url || "avatar-placeholder.png";
    avatar.classList.remove("loading");
  }
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
        name: typeof data.name === "string" && data.name ? data.name : "Hermes",
        name_source: data.name_source || "default",
        avatar_url: data.avatar_url || "",
        home_label: data.home_label || data.name || "Hermes",
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

export function wire({ onIdentity } = {}) {
  if (typeof onIdentity === "function") state.onIdentity = onIdentity;
}

export async function boot() {
  await loadStatus();
}
