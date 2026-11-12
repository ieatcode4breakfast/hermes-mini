// Model picker: a tab on the input box's top edge and a bottom sheet behind it. Everything here is a restyle
// of Hermes's own gateway methods; the app keeps no model state of its own beyond what the open chat reports.
//   model.options {session_id?, include_unconfigured?, refresh?}  providers, their models, prices and capabilities
//   config.set {session_id, key:"model", value:"<model> --provider <slug>[ --global]", confirm_expensive_model?}
//       -> {value, confirm_required, confirm_message, deferred?}  (a switch during a reply is queued for the next turn)
//   config.set {session_id, key:"reasoning", value:"none|low|medium|high|xhigh|max"}  and  {key:"fast", value:"on|off"}
//   model.save_key {slug, api_key} -> {provider}   model.disconnect {slug}
//   session.create {model, provider, reasoning_effort}  a New chat's pick is sent as create overrides (app.js asks
//       createParams() when it makes the session), the same per-session route the Hermes composer uses.
// The chip reads `info` from session.create/session.resume results and from session.info events.
// API keys are only ever held in the password field until Save; nothing here touches browser storage.

const EFFORTS = [["none", "Off"], ["low", "Low"], ["medium", "Med"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"]];
const LONG_PRESS_MS = 550;

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

// "deepseek/deepseek-v4.1-flash" -> "deepseek-v4.1-flash": the vendor prefix only repeats the provider.
export function shortModel(model) {
  const id = String(model || "").trim();
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

function effortLabel(effort) {
  const hit = EFFORTS.find(([word]) => word === effort);
  return hit ? hit[1] : effort ? String(effort) : "";
}

function priceText(price) {
  if (!price || typeof price !== "object") return "";
  if (price.free) return "free";
  const fmt = (v) => (v === null || v === undefined || v === "" ? "" : String(v).startsWith("$") ? String(v) : `$${v}`);
  const input = fmt(price.input);
  const output = fmt(price.output);
  return input || output ? `${input || "–"} / ${output || "–"}` : "";
}

function errorText(error) {
  return (error && (error.message || String(error))) || "Something went wrong";
}

export function createModelPicker({ rpc, getSid, isDraft, isBusy, confirmDialog, showToast, chip }) {
  const info = { model: "", provider: "", reasoning: "", fast: false, pending: "" };
  let draftPick = null; // { model, provider, global } chosen on a New chat, sent with session.create
  let draftEffort = "";
  let options = null; // last model.options payload
  let loading = null;
  let sheet = null;
  let parts = null;

  // ---------- chip ----------

  // previewEffort: the slider's level while it is being dragged, shown in the title line before it is sent.
  function paintChip(previewEffort) {
    const model = draftPick && isDraft() ? draftPick.model : info.model;
    const effort = previewEffort || (isDraft() && draftEffort ? draftEffort : info.reasoning);
    if (parts) parts.current.textContent = [shortModel(model), effortLabel(effort), info.fast ? "Fast" : ""].filter(Boolean).join(" · ");
    if (!chip) return;
    const name = chip.querySelector(".model-tab-name");
    if (name) name.textContent = info.pending ? `→ ${shortModel(info.pending)}` : shortModel(model) || "Model";
    const meta = chip.querySelector(".model-tab-meta");
    if (meta) {
      const bits = info.pending ? ["after this reply"] : [effortLabel(effort), info.fast ? "⚡" : ""].filter(Boolean);
      meta.textContent = bits.join(" ");
      meta.hidden = !bits.length;
    }
    chip.setAttribute("aria-label", `Model: ${shortModel(model) || "default"}${effort ? `, reasoning ${effortLabel(effort)}` : ""}${
      info.pending ? `; switching to ${shortModel(info.pending)} after this reply` : ""}`);
  }

  // session.info payload (event or create/resume result). Lazy infos carry only model/provider.
  function setInfo(payload) {
    if (!payload || typeof payload !== "object") return;
    if (typeof payload.model === "string" && payload.model) {
      if (info.pending && payload.model === info.pending && !payload.running) info.pending = "";
      info.model = payload.model;
    }
    if (typeof payload.provider === "string" && payload.provider) info.provider = payload.provider;
    if (typeof payload.reasoning_effort === "string") info.reasoning = payload.reasoning_effort;
    if (typeof payload.fast === "boolean") info.fast = payload.fast;
    if (payload.running === false) info.pending = "";
    paintChip();
    if (sheet && sheet.classList.contains("open")) renderList();
  }

  // A New chat on screen: show the profile default (or the pick already made for this draft).
  async function showDraft() {
    info.pending = "";
    info.fast = false;
    try {
      const payload = await loadOptions(false);
      if (!draftPick) {
        info.model = payload.model || "";
        info.provider = payload.provider || "";
      }
    } catch {
      /* not connected yet: the chip keeps its last text until a chat attaches */
    }
    paintChip();
  }

  function resetDraft() {
    draftPick = null;
    draftEffort = "";
  }

  // session.create overrides for a New chat's first message.
  function createParams() {
    const params = {};
    if (draftPick) {
      params.model = draftPick.model;
      if (draftPick.provider) params.provider = draftPick.provider;
    }
    if (draftEffort) params.reasoning_effort = draftEffort;
    return params;
  }

  // After session.create for a draft: a "make default" pick still has to be written to config.
  async function afterCreate() {
    const pick = draftPick;
    resetDraft();
    if (pick && pick.global) await switchModel(pick.model, pick.provider, true).catch(() => {});
  }

  // ---------- data ----------

  function loadOptions(refresh, includeUnconfigured = false) {
    const sid = isDraft() ? "" : getSid();
    const params = {};
    if (sid) params.session_id = sid;
    if (refresh) params.refresh = true;
    if (includeUnconfigured) params.include_unconfigured = true;
    if (!includeUnconfigured && !refresh && loading) return loading;
    const call = rpc("model.options", params, 60000).then((payload) => {
      if (!includeUnconfigured) options = payload || { providers: [] };
      return payload || { providers: [] };
    });
    if (!includeUnconfigured) {
      loading = call.finally(() => {
        loading = null;
      });
      return loading;
    }
    return call;
  }

  function currentCaps() {
    const provider = (options?.providers || []).find((row) => row.slug === info.provider);
    return provider?.capabilities?.[info.model] || null;
  }

  // ---------- switching ----------

  async function switchModel(model, provider, global, confirmed = false) {
    const sid = getSid();
    let value = provider ? `${model} --provider ${provider}` : model;
    if (global) value += " --global";
    const params = { session_id: sid, key: "model", value };
    if (confirmed) params.confirm_expensive_model = true;
    const result = (await rpc("config.set", params, 60000)) || {};
    if (result.confirm_required) {
      const ok = await confirmDialog({
        title: "Switch model?",
        message: result.confirm_message || result.warning || "This model costs more than usual.",
        confirmLabel: "Switch",
      });
      if (!ok) return false;
      return switchModel(model, provider, global, true);
    }
    if (result.deferred) {
      info.pending = model;
    } else {
      info.model = String(result.value || model);
      if (provider) info.provider = provider;
      info.pending = "";
    }
    if (result.warning && !result.confirm_required) showToast(String(result.warning));
    paintChip();
    return true;
  }

  async function pickModel(model, provider) {
    // Whatever is picked also becomes the default for new chats (--global), like `/model --global`.
    const global = true;
    if (isDraft()) {
      draftPick = { model, provider, global };
      info.model = model;
      info.provider = provider;
      paintChip();
      close();
      return;
    }
    if (!getSid()) {
      showToast("Not connected", "error");
      return;
    }
    try {
      if (await switchModel(model, provider, global)) {
        // Silent on success: the tab shows the new model (or "→ X after this reply" when queued).
        close();
      }
    } catch (error) {
      showToast(errorText(error), "error");
    }
  }

  async function setEffort(word) {
    if (isDraft()) {
      draftEffort = word;
      paintChip();
      renderControls();
      return;
    }
    try {
      const result = await rpc("config.set", { session_id: getSid(), key: "reasoning", value: word });
      info.reasoning = String(result?.value || word);
      paintChip();
      renderControls();
    } catch (error) {
      showToast(errorText(error), "error");
    }
  }

  async function setFast(on) {
    try {
      const result = await rpc("config.set", { session_id: getSid(), key: "fast", value: on ? "on" : "off" });
      info.fast = String(result?.value || "") === "fast" || String(result?.value || "") === "ultrafast";
      paintChip();
    } catch (error) {
      showToast(errorText(error), "error");
    }
    renderControls();
  }

  // ---------- sheet ----------

  function build() {
    sheet = node("div", "model-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Model");
    const scrim = node("div", "scrim model-scrim");
    scrim.addEventListener("click", close);

    const head = node("div", "model-head");
    const back = node("button", "model-back", "‹");
    back.type = "button";
    back.setAttribute("aria-label", "Back");
    back.hidden = true;
    back.addEventListener("click", () => showPane("pick"));
    const titleWrap = node("div", "model-title-wrap");
    const title = node("h2", "model-title", "Model");
    const current = node("span", "model-current");
    titleWrap.append(title, current);
    const refresh = node("button", "model-refresh");
    refresh.type = "button";
    refresh.setAttribute("aria-label", "Refresh models");
    refresh.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>';
    refresh.addEventListener("click", () => void reload(true));
    const shut = node("button", "model-close", "×");
    shut.type = "button";
    shut.setAttribute("aria-label", "Close");
    shut.addEventListener("click", close);
    head.append(back, titleWrap, refresh, shut);

    const search = node("input", "model-search");
    search.type = "search";
    search.placeholder = "Search models";
    search.setAttribute("aria-label", "Search models");
    search.addEventListener("input", renderList);

    const list = node("div", "model-list");
    const add = node("button", "model-add", "Providers and keys");
    add.type = "button";
    add.addEventListener("click", () => void openAdd());

    const controls = node("div", "model-controls");
    // Reasoning sits under the title: the label with a slider beside it over Hermes's levels. The level itself shows
    // in the title line (model · level), so there is no separate value here; dragging previews it there and letting go
    // sends it.
    const effortRow = node("div", "model-row model-effort");
    effortRow.append(node("span", "model-row-label", "Reasoning"));
    const effort = node("input", "model-slider");
    effort.type = "range";
    effort.min = "0";
    effort.max = String(EFFORTS.length - 1);
    effort.step = "1";
    effort.setAttribute("aria-label", "Reasoning effort");
    effort.addEventListener("input", () => {
      const label = EFFORTS[Number(effort.value)][1];
      effort.setAttribute("aria-valuetext", label);
      paintChip(EFFORTS[Number(effort.value)][0]);
    });
    effort.addEventListener("change", () => void setEffort(EFFORTS[Number(effort.value)][0]));
    effortRow.append(effort);
    const fastRow = node("label", "model-row model-fast-row");
    fastRow.append(node("span", "model-row-label", "Fast mode"));
    const fast = node("input", "model-switch");
    fast.type = "checkbox";
    fast.addEventListener("change", () => void setFast(fast.checked));
    fastRow.append(fast);
    controls.append(fastRow);

    const pick = node("div", "model-pane model-pane-pick");
    pick.append(effortRow, search, list, add, controls);
    const addPane = node("div", "model-pane model-pane-add");
    addPane.hidden = true;

    sheet.append(head, pick, addPane);
    document.body.append(scrim, sheet);
    sheet.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    parts = { scrim, back, title, current, refresh, search, list, effort, effortRow, fast, fastRow, pick, addPane };
  }

  function showPane(which) {
    const adding = which === "add";
    parts.pick.hidden = adding;
    parts.addPane.hidden = !adding;
    parts.back.hidden = !adding;
    parts.refresh.hidden = adding;
    parts.title.textContent = adding ? "Providers" : "Model";
    parts.current.hidden = adding;
    if (!adding) parts.addPane.replaceChildren();
  }

  function renderControls() {
    if (!parts) return;
    const effort = isDraft() && draftEffort ? draftEffort : info.reasoning;
    const index = Math.max(0, EFFORTS.findIndex(([word]) => word === (effort || "")));
    parts.effort.value = String(index);
    parts.effort.setAttribute("aria-valuetext", effort ? EFFORTS[index][1] : "Default");
    const caps = currentCaps();
    parts.effortRow.hidden = caps ? caps.reasoning === false : false;
    // Fast mode is a live-session setting and only some models have it (capabilities.fast).
    parts.fastRow.hidden = isDraft() || !(caps && caps.fast);
    parts.fast.checked = Boolean(info.fast);
  }

  function addLongPress(target, run) {
    let timer = 0;
    const cancel = () => clearTimeout(timer);
    target.addEventListener("pointerdown", () => {
      cancel();
      timer = setTimeout(() => {
        timer = 0;
        target.dataset.longPressed = "1";
        run();
      }, LONG_PRESS_MS);
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) target.addEventListener(type, cancel);
    target.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      cancel();
      run();
    });
  }

  function renderList() {
    if (!parts) return;
    const list = parts.list;
    list.replaceChildren();
    const rows = (options?.providers || []).filter((row) => row.authenticated !== false && (row.models || []).length);
    if (!rows.length) {
      list.append(node("p", "model-empty", options ? "No providers are connected." : "Loading…"));
      renderControls();
      return;
    }
    const query = parts.search.value.trim().toLowerCase();
    const current = isDraft() && draftPick ? draftPick : { model: info.model, provider: info.provider };
    const ordered = [...rows].sort((a, b) => Number(b.slug === current.provider) - Number(a.slug === current.provider));
    for (const row of ordered) {
      const models = (row.models || []).filter((m) => !query || m.toLowerCase().includes(query) || row.name.toLowerCase().includes(query));
      if (query && !models.length) continue;
      const group = node("section", "model-group");
      const open = Boolean(query); // collapsed by default; a search opens the groups it matches
      group.classList.toggle("open", open);
      const header = node("button", "model-provider");
      header.type = "button";
      header.setAttribute("aria-expanded", open ? "true" : "false");
      header.append(node("span", "model-provider-name", row.name || row.slug));
      header.addEventListener("click", () => {
        if (header.dataset.longPressed) {
          delete header.dataset.longPressed;
          return;
        }
        const next = !group.classList.contains("open");
        group.classList.toggle("open", next);
        header.setAttribute("aria-expanded", next ? "true" : "false");
      });
      addLongPress(header, () => void disconnect(row));
      const body = node("div", "model-options");
      const unavailable = new Set(row.unavailable_models || []);
      for (const model of models) {
        const item = node("button", "model-option");
        item.type = "button";
        const on = model === current.model && row.slug === current.provider;
        item.classList.toggle("on", on);
        if (on) item.setAttribute("aria-current", "true");
        item.disabled = unavailable.has(model);
        item.append(node("span", "model-option-name", model));
        const price = priceText(row.pricing?.[model]);
        if (price) item.append(node("span", "model-option-price", price));
        item.addEventListener("click", () => void pickModel(model, row.slug));
        body.append(item);
      }
      group.append(header, body);
      list.append(group);
    }
    if (!list.children.length) list.append(node("p", "model-empty", "No models match."));
    renderControls();
  }

  async function reload(refresh) {
    if (refresh) parts.refresh.classList.add("spin");
    try {
      await loadOptions(refresh);
    } catch (error) {
      showToast(errorText(error), "error");
    } finally {
      parts.refresh.classList.remove("spin");
    }
    renderList();
  }

  async function disconnect(row) {
    const ok = await confirmDialog({
      title: `Disconnect ${row.name || row.slug}?`,
      message: "Hermes removes this provider's saved credentials. Chats using it stop working until it is added again.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    try {
      await rpc("model.disconnect", { slug: row.slug });
      showToast("Disconnected", "success");
      await reload(false);
    } catch (error) {
      showToast(errorText(error), "error");
    }
  }

  async function openAdd() {
    showPane("add");
    const pane = parts.addPane;
    pane.replaceChildren(node("p", "model-empty", "Loading…"));
    let payload;
    try {
      payload = await loadOptions(false, true);
    } catch (error) {
      pane.replaceChildren(node("p", "model-empty", errorText(error)));
      return;
    }
    pane.replaceChildren();
    const search = node("input", "model-search");
    search.type = "search";
    search.placeholder = "Search providers";
    search.setAttribute("aria-label", "Search providers");
    const cards = node("div", "model-list");
    pane.append(search, cards);
    // Every provider Hermes lists, connected ones included (marked, with Update instead of Save), in Hermes's order.
    const rows = payload.providers || [];
    if (!rows.length) {
      cards.append(node("p", "model-empty", "Hermes lists no providers."));
      return;
    }
    const all = rows.map((row) => ({ row, card: providerCard(row) }));
    const none = node("p", "model-empty", "No providers match.");
    const filter = () => {
      const query = search.value.trim().toLowerCase();
      const shown = all.filter(({ row }) => !query || `${row.name || ""} ${row.slug}`.toLowerCase().includes(query));
      cards.replaceChildren(...shown.map(({ card }) => card), ...(shown.length ? [] : [none]));
    };
    search.addEventListener("input", filter);
    filter();
  }

  function providerCard(row) {
    const card = node("section", "model-group provider-card");
    const header = node("button", "model-provider");
    header.type = "button";
    header.append(node("span", "model-provider-name", row.name || row.slug));
    const connected = row.authenticated !== false;
    if (connected) header.append(node("span", "provider-connected", row.is_current ? "· In use" : "· Connected"));
    const body = node("div", "provider-body");
    header.addEventListener("click", () => {
      const next = !card.classList.contains("open");
      card.classList.toggle("open", next);
      if (next) body.querySelector("input")?.focus();
    });
    if (row.auth_type === "api_key" || (connected && !row.auth_type)) {
      const form = node("form", "provider-form");
      const label = node("label", "provider-label", connected ? `${row.key_env || "API key"} · a key is already saved` : row.key_env || "API key");
      const input = node("input", "provider-key");
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = connected ? "Paste a new key to replace it" : "Paste API key";
      input.setAttribute("aria-label", `${row.name || row.slug} API key`);
      label.append(input);
      const save = node("button", "provider-save", connected ? "Update" : "Save");
      save.type = "submit";
      form.append(label, save);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const key = input.value.trim();
        input.value = ""; // the key leaves the page in this one request and is not kept anywhere
        if (!key) return;
        save.disabled = true;
        try {
          await rpc("model.save_key", { slug: row.slug, api_key: key }, 60000);
          showToast(`${row.name || row.slug} ${connected ? "updated" : "added"}`, "success");
          showPane("pick");
          await reload(false);
        } catch (error) {
          showToast(errorText(error), "error");
        } finally {
          save.disabled = false;
        }
      });
      body.append(form);
    } else {
      body.append(node("p", "provider-note", row.warning || "Set this provider up with `hermes model` on the computer."));
    }
    card.append(header, body);
    return card;
  }

  async function open() {
    if (!sheet) build();
    showPane("pick");
    paintChip(); // fills the current-model label beside the title
    parts.search.value = "";
    renderList();
    parts.scrim.classList.add("open");
    sheet.classList.add("open");
    chip?.setAttribute("aria-expanded", "true");
    await reload(false);
  }

  function close() {
    if (!sheet) return;
    sheet.classList.remove("open");
    parts.scrim.classList.remove("open");
    chip?.setAttribute("aria-expanded", "false");
    showPane("pick");
  }

  chip?.addEventListener("click", () => void open());
  paintChip();

  return { setInfo, showDraft, resetDraft, createParams, afterCreate, close, isBusy };
}
