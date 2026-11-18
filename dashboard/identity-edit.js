// Name and picture editor: tapping the agent's picture or name in the header opens it. The name and picture are
// Hermes's own (the profile's hermes-bots title and assets/avatar), so they are saved through Hermes's profile
// methods over the gateway, the way Hermes's desktop app saves them; the app never writes Hermes's files.
//   profiles.list {include_sessions:false}  -> each profile's ui_meta and ui_meta_revisions (to keep the other fields)
//   profiles.set_asset {name, asset:"avatar", data:<data URL>}   PNG/JPEG/WebP up to 2MB
//   profiles.configure {name, ui_meta:{"hermes-bots":{...}}, ui_meta_expected_revisions}  compare-and-swap
// The dialog follows the rename and confirm dialogs: popover card over a scrim, one history entry, Escape closes.

import { openPopover, closePopover } from "./toast.js";

const $ = (id) => document.getElementById(id);
const PICTURE_PX = 512; // square, centre-cropped: plenty for a 112px circle at 3x, far under Hermes's 2MB cap
const MAX_DATA_URL = 1_400_000; // the app shows a Hermes picture up to 1.5MB (mini_core._HERMES_AVATAR_MAX_BYTES)
const PLACEHOLDER = "avatar-placeholder.png";

// A picked image as a square data URL: WebP where the browser can encode it, else PNG, else JPEG when PNG is too big.
export async function squarePicture(file, size = PICTURE_PX) {
  const image = await loadImage(file);
  const side = Math.min(image.width, image.height);
  if (!side) throw new Error("That picture could not be read.");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(size, side);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.source, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, canvas.width,
    canvas.height);
  image.close();
  let data = canvas.toDataURL("image/webp", 0.9);
  if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/png");
  if (data.length > MAX_DATA_URL) data = canvas.toDataURL("image/jpeg", 0.88);
  return data;
}

// { source, width, height, close } for drawImage: an ImageBitmap (EXIF rotation applied), or a decoded <img>.
async function loadImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      /* fall through to an <img>: some browsers reject the options or the format here */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } catch {
    throw new Error("That picture could not be read.");
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function createIdentityEditor({ rpc, identityApi, api, showToast }) {
  const trigger = $("identityBtn");
  const scrim = $("identityScrim");
  const dialog = $("identityDialog");
  const pick = $("identityPick");
  const preview = $("identityPreview");
  const file = $("identityFile");
  const nameInput = $("identityName");
  const errorEl = $("identityError");
  const cancelBtn = $("identityCancel");
  const saveBtn = $("identitySave");

  let open = false;
  let busy = false;
  let picture = ""; // a new picture's data URL, "" while unchanged
  let startName = "";
  let backPending = null;
  let resolveBack = null;

  const cleanName = (value) => String(value || "").split(/\s+/).filter(Boolean).join(" ").slice(0, 60);
  const changed = () => Boolean(picture) || (cleanName(nameInput.value) && cleanName(nameInput.value) !== startName);

  function sync() {
    saveBtn.disabled = busy || !changed();
    nameInput.setAttribute("aria-invalid", cleanName(nameInput.value) ? "false" : "true");
  }

  function showError(text) {
    errorEl.textContent = text || "";
    errorEl.hidden = !text;
  }

  function openEditor() {
    if (open) return;
    if (backPending) {
      backPending.then(openEditor);
      return;
    }
    open = true;
    busy = false;
    picture = "";
    startName = identityApi.currentName();
    nameInput.value = startName;
    preview.src = identityApi.identity().avatar_url || PLACEHOLDER;
    showError("");
    dialog.classList.remove("busy");
    sync();
    openPopover(scrim);
    openPopover(dialog);
    scrim.classList.add("open");
    dialog.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    if (!(history.state && history.state.hermesMiniIdentity === true)) history.pushState({ hermesMiniIdentity: true }, "");
    // No keyboard pops up on a phone just from opening: focus the card, not the name field.
    requestAnimationFrame(() => {
      if (open) cancelBtn.focus({ preventScroll: true });
    });
  }

  function closeEditor({ viaPop = false } = {}) {
    if (!open) return;
    open = false;
    scrim.classList.remove("open");
    dialog.classList.remove("open");
    closePopover(scrim, 240);
    closePopover(dialog, 200);
    trigger.setAttribute("aria-expanded", "false");
    file.value = "";
    trigger.focus({ preventScroll: true });
    if (!viaPop && history.state && history.state.hermesMiniIdentity === true) {
      backPending = new Promise((resolve) => {
        resolveBack = resolve;
      });
      history.back();
    }
  }

  // The profile's hermes-bots entry and its revision, read fresh before each write: the entry carries other fields
  // (picture kind, screen settings) that must survive, and the revision makes the write a compare-and-swap.
  async function readBots(profile) {
    const data = await rpc("profiles.list", { include_sessions: false });
    const row = (data?.profiles || []).find((p) => p.name === profile || (profile === "default" && p.is_default));
    const meta = row?.ui_meta && typeof row.ui_meta === "object" ? row.ui_meta : {};
    const bots = meta["hermes-bots"] && typeof meta["hermes-bots"] === "object" ? meta["hermes-bots"] : {};
    const revision = Number(row?.ui_meta_revisions?.["hermes-bots"]) || 0;
    return { bots, revision };
  }

  async function writeBots(profile, patch) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { bots, revision } = await readBots(profile);
      const reply = await rpc("profiles.configure", {
        name: profile,
        ui_meta: { "hermes-bots": { ...bots, ...patch } },
        ui_meta_expected_revisions: { "hermes-bots": revision },
      });
      if (reply?.applied?.ui_meta) return;
      if (!reply?.applied?.ui_meta_conflicts) break; // not a race: a real failure
    }
    throw new Error("Hermes did not save the name.");
  }

  async function save() {
    if (busy || !changed()) return;
    const name = cleanName(nameInput.value);
    if (!name) {
      showError("Enter a name.");
      nameInput.focus();
      return;
    }
    busy = true;
    dialog.classList.add("busy");
    showError("");
    sync();
    const profile = identityApi.identity().profile || "default";
    try {
      const patch = {};
      if (picture) {
        await rpc("profiles.set_asset", { name: profile, asset: "avatar", data: picture });
        patch.imageKind = "photo"; // Hermes shows the stored photo, not another kind of picture
        if (identityApi.identity().has_custom_avatar) {
          // A picture uploaded through the app's old setup would still win over the new one: drop it.
          await api("/api/plugins/hermes-mini/identity/forget-upload", { method: "POST" });
        }
      }
      if (name !== startName) patch.title = name;
      if (Object.keys(patch).length) await writeBots(profile, patch);
      await identityApi.loadStatus();
      busy = false;
      closeEditor();
      trigger.classList.remove("just-saved");
      void trigger.offsetWidth; // restart the pop
      trigger.classList.add("just-saved");
      showToast("Saved", "success");
    } catch (error) {
      busy = false;
      dialog.classList.remove("busy");
      const text = error && error.message ? error.message : "";
      showError(/not connected|connection lost|timed out/i.test(text)
        ? "Not saved — the connection dropped. Try again in a moment."
        : `Not saved${text ? `: ${text}` : "."}`);
      sync();
    }
  }

  pick.addEventListener("click", () => {
    if (!busy) file.click();
  });
  file.addEventListener("change", async () => {
    const chosen = file.files && file.files[0];
    file.value = "";
    if (!chosen) return;
    showError("");
    try {
      picture = await squarePicture(chosen);
      preview.src = picture;
      pick.classList.remove("fresh");
      void pick.offsetWidth;
      pick.classList.add("fresh");
    } catch (error) {
      showError(error && error.message ? error.message : "That picture could not be read.");
    }
    sync();
  });
  nameInput.addEventListener("input", () => {
    showError("");
    sync();
  });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void save();
    }
  });
  cancelBtn.addEventListener("click", () => closeEditor());
  saveBtn.addEventListener("click", () => void save());
  scrim.addEventListener("click", () => {
    if (!busy) closeEditor();
  });
  trigger.addEventListener("click", () => (open ? closeEditor() : openEditor()));
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openEditor();
  });
  trigger.addEventListener("animationend", () => trigger.classList.remove("just-saved"));

  window.addEventListener("popstate", (event) => {
    if (resolveBack) {
      const resolve = resolveBack;
      resolveBack = null;
      backPending = null;
      resolve();
      event.stopImmediatePropagation();
      return;
    }
    if (open && !(event.state && event.state.hermesMiniIdentity === true)) {
      closeEditor({ viaPop: true });
      event.stopImmediatePropagation();
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (open && event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopPropagation();
        closeEditor();
      }
    },
    true,
  );

  return { open: openEditor, close: closeEditor, isOpen: () => open };
}
