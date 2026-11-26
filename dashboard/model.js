// Model picker: a control on the message card and a bottom sheet behind it. Everything here is a restyle
// of Hermes's own gateway methods; the app keeps no model state of its own beyond what the open chat reports.
//   model.options {session_id?, include_unconfigured?, refresh?}  providers, their models, prices and capabilities
//   config.set {session_id, key:"model", value:"<model> --provider <slug>[ --global]", confirm_expensive_model?}
//       -> {value, confirm_required, confirm_message, deferred?}  (a switch during a reply is queued for the next turn)
//   config.set {session_id, key:"reasoning", value:"none|low|medium|high|xhigh|max"}  and  {key:"fast", value:"on|off"}
//   model.save_key {slug, api_key} -> {provider}   model.disconnect {slug}
//   A draft starts on the current default, then uses the same guarded config.set as an existing chat.
// The chip reads `info` from session.create/session.resume results and from session.info events.
// API keys are only ever held in the password field until Save; nothing here touches browser storage.

import { openPopover, closePopover, showPersistentToast } from "./toast.js";
import { displayModelName } from "./model-name.js";

const EFFORTS = [["none", "Off"], ["low", "Low"], ["medium", "Med"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"]];
const LONG_PRESS_MS = 550;
const NOUS_SIGN_IN = "Sign in to Nous Portal in Hermes.";
// Same model families Hermes warns about. The gateway supplies any additional warnings after switching.
const HERMES_CHAT_MODEL = /(?:^|[/:])hermes[-_ ]?[34](?:[-_.:]|$)/i;

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

// "deepseek/deepseek-v4.1-flash" -> "DeepSeek v4.1 Flash" (model-name.js). Display only: the id is what is sent.
export function shortModel(model) {
  return displayModelName(model);
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

function displaySwitchWarning(message) {
  // Rewrite the two known gateway blocks. Keep other warnings and fall back to the server text if its format changes.
  return message
    .replace(/^!!! EXPENSIVE MODEL WARNING !!!$[\s\S]*?^Confirm only if you intend to use this model\.$/gm, (block) => {
      const input = block.match(/^Input tokens: (.+)$/m)?.[1];
      const output = block.match(/^Output tokens: (.+)$/m)?.[1];
      if (!input || !output) return block;
      const rate = (value) => value.replace(/\/M$/, " per million tokens");
      const suggestion = block.includes("did you mean to select openai/gpt-5.5?")
        ? "\n\nIf you meant to pick GPT-5.5, cancel and select it from the list."
        : "";
      return `This model is expensive to use.\n\nInput (what the model reads): ${rate(input)}\nOutput (what it generates): ${rate(output)}${suggestion}`;
    })
    .replace(/^!!! LARGE CONTEXT MODEL SWITCH !!!$[\s\S]*?^Confirm only if you intend to switch now\.$/gm, (block) => {
      const tokens = block.match(/^This session holds ~([\d,]+) tokens of context\.$/m)?.[1];
      if (!tokens) return block;
      return `This chat has about ${tokens} tokens of history. After you switch, the model reads that history again. Your provider charges its full input rate for that history on the next reply.`;
    });
}

export function createModelPicker({ rpc, api, getSid, isDraft, isBusy, confirmDialog, showToast, chip }) {
  const info = { model: "", provider: "", reasoning: "", fast: false };
  let pendingPick = null;
  let settled = false;
  let draftPick = null;
  let draftDefault = null;
  let draftEffort = "";
  let draftSeq = 0;
  let draftLoad = null;
  let options = null; // last model.options payload for the current target
  let optionsKey = "";
  let loading = null;
  let loadingKey = "";
  let sheet = null;
  let parts = null;
  let view = 0;
  let picking = false;

  function targetKey() {
    return isDraft() ? "__draft__" : (getSid() || "__none__");
  }
  function pickerError(viewAtStart, message, error) {
    if (viewAtStart === view) showPersistentToast(message, { detail: errorText(error) });
  }

  // ---------- chip ----------

  function selectedModel() {
    if (isDraft() && draftPick) return draftPick;
    if (pendingPick?.sid === getSid()) return pendingPick;
    return info;
  }

  function providerLabel(slug) {
    if (!slug) return "";
    const row = (options?.providers || []).find((entry) => entry.slug === slug);
    return row?.name || slug;
  }

  // previewEffort: the slider's level while it is being dragged, shown in the title line before it is sent.
  function paintChip(previewEffort) {
    const { model, provider } = selectedModel();
    const effort = previewEffort || (isDraft() && draftEffort ? draftEffort : info.reasoning);
    if (parts) {
      parts.current.textContent = [providerLabel(provider), shortModel(model), effortLabel(effort), info.fast ? "Fast" : ""]
        .filter(Boolean)
        .join(" · ");
    }
    if (!chip) return;
    chip.hidden = !settled && !model;
    const name = chip.querySelector(".model-tab-name");
    if (name) name.textContent = shortModel(model) || "Model";
    const meta = chip.querySelector(".model-tab-meta");
    if (meta) {
      const bits = [effortLabel(effort), info.fast ? "⚡" : ""].filter(Boolean);
      meta.textContent = bits.join(" ");
      meta.hidden = !bits.length;
    }
    chip.setAttribute("aria-label", `Model: ${shortModel(model) || "default"}${effort ? `, reasoning ${effortLabel(effort)}` : ""}`);
  }

  // session.info payload (event or create/resume result). Lazy infos carry only model/provider, so
  // switching to another chat passes replace:true to clear the previous chat's reasoning/fast state.
  function setInfo(payload, { replace = false } = {}) {
    if (!payload || typeof payload !== "object") return;
    if (replace) {
      draftSeq += 1;
      info.reasoning = "";
      info.fast = false;
      if ("model" in payload) {
        info.model = "";
        info.provider = "";
      }
    }
    if ("model" in payload) settled = true;
    if (typeof payload.model === "string" && payload.model) {
      info.model = payload.model;
    }
    if (typeof payload.provider === "string" && payload.provider) info.provider = payload.provider;
    if (typeof payload.reasoning_effort === "string") info.reasoning = payload.reasoning_effort;
    if (typeof payload.fast === "boolean") info.fast = payload.fast;
    if (pendingPick?.sid !== getSid() || payload.running === false) pendingPick = null;
    paintChip();
    if (sheet && sheet.classList.contains("open")) renderList();
  }

  // A New chat on screen: show the profile default (or the pick already made for this draft).
  async function showDraft() {
    const seq = ++draftSeq;
    pendingPick = null;
    info.reasoning = "";
    info.fast = false;
    if (!draftPick) {
      info.model = "";
      info.provider = "";
    }
    paintChip();
    const run = (async () => {
      try {
        const [payload, reasoningRes] = await Promise.all([
          loadOptions(false),
          rpc("config.get", { key: "reasoning" }, 15000).catch(() => null),
        ]);
        if (!isDraft() || seq !== draftSeq) return;
        settled = true;
        const reasoning = typeof reasoningRes?.value === "string" ? reasoningRes.value : "";
        draftDefault = payload.model || reasoning
          ? { model: payload.model || "", provider: payload.provider || "", reasoning }
          : null;
        if (!draftPick) {
          info.model = payload.model || "";
          info.provider = payload.provider || "";
        }
        if (!draftEffort && reasoning) info.reasoning = reasoning;
      } catch {
        /* not connected yet: the chip stays clean until a chat attaches */
      }
      if (isDraft() && seq === draftSeq) paintChip();
    })();
    const pending = run.finally(() => {
      if (draftLoad === pending) draftLoad = null;
    });
    draftLoad = pending;
    return pending;
  }

  async function ensureDraftDefault() {
    if (draftPick || draftDefault?.model) return;
    if (draftLoad) {
      await draftLoad;
      return;
    }
    await showDraft();
  }

  function resetDraft() {
    draftPick = null;
    draftDefault = null;
    draftEffort = "";
  }

  function draftCreateParams() {
    const params = {};
    if (!draftPick && draftDefault?.model) {
      params.model = draftDefault.model;
      if (draftDefault.provider) params.provider = draftDefault.provider;
    }
    const effort = draftEffort || draftDefault?.reasoning || "";
    if (effort) params.reasoning_effort = effort;
    return params;
  }

  async function defaultCreateParams() {
    try {
      const [payload, reasoningRes] = await Promise.all([
        rpc("model.options", { explicit_only: true }, 60000).catch(() => null),
        rpc("config.get", { key: "reasoning" }, 15000).catch(() => null),
      ]);
      const params = {};
      if (typeof payload?.model === "string" && payload.model) {
        params.model = payload.model;
        if (typeof payload.provider === "string" && payload.provider) params.provider = payload.provider;
      }
      if (typeof reasoningRes?.value === "string" && reasoningRes.value) {
        params.reasoning_effort = reasoningRes.value;
      }
      return params;
    } catch {
      /* fall back to Hermes default if options cannot be read yet */
    }
    return {};
  }

  async function applyDraftModel(sid, isCurrent) {
    const pick = draftPick;
    const effort = draftEffort;
    const applied = {};
    if (effort) applied.reasoning_effort = effort;
    else if (draftDefault?.reasoning) applied.reasoning_effort = draftDefault.reasoning;

    if (pick) {
      const stillDraft = () => isCurrent() && draftPick === pick;

      // This read waits for Hermes's agent build. A switch with an explicit provider can otherwise race a cold build.
      try {
        await rpc("approval.pending", { session_id: sid }, 35000);
      } catch (error) {
        // Hermes’s guarded switch can recover a failed default model once initialization has settled.
        if (error.code !== 5032 || /still starting/i.test(error.message)) throw error;
      }
      if (!stillDraft()) return null;
      const result = await requestModelSwitch(pick.model, pick.provider, sid, stillDraft);
      if (!result) return null;
      if (result.deferred || !result.value) throw new Error("Hermes hasn’t switched to the selected model yet.");
      const warning = extraWarning(result, HERMES_CHAT_MODEL.test(pick.model));
      if (warning) showPersistentToast("Model switched with a warning.", { detail: warning, tone: "neutral" });
      applied.model = result.value;
      applied.provider = pick.provider;
    }

    if (effort) {
      if (!isCurrent()) return null;
      const res = await rpc("config.set", { session_id: sid, key: "reasoning", value: effort, scope: "global" }).catch(() => null);
      if (typeof res?.value === "string" && res.value) applied.reasoning_effort = res.value;
    }
    return applied;
  }

  // ---------- data ----------

  function loadOptions(refresh, includeUnconfigured = false) {
    const sid = isDraft() ? "" : getSid();
    const key = sid || "__draft__";
    // Use Hermes’s explicitly configured inventory for both the picker and setup list.
    const params = { explicit_only: true };
    if (sid) params.session_id = sid;
    if (refresh) params.refresh = true;
    if (includeUnconfigured) params.include_unconfigured = true;
    if (!includeUnconfigured && !refresh && loading && loadingKey === key) return loading;
    const call = rpc("model.options", params, 60000).then((payload) => {
      const data = payload || { providers: [] };
      if (!includeUnconfigured && targetKey() === key) {
        options = data;
        optionsKey = key;
      }
      return data;
    });
    if (!includeUnconfigured) {
      loadingKey = key;
      const pending = call.finally(() => {
        if (loading === pending) {
          loading = null;
          loadingKey = "";
        }
      });
      loading = pending;
      return pending;
    }
    return call;
  }

  function currentCaps() {
    const provider = (options?.providers || []).find((row) => row.slug === info.provider);
    return provider?.capabilities?.[info.model] || null;
  }

  // ---------- switching ----------

  function extraWarning(result, compatibilityShown) {
    return String(result?.warning || "").split(" | ").filter((text) =>
      !compatibilityShown || !text.startsWith("Nous Research Hermes 3 & 4 models are NOT agentic")
    ).join(" | ");
  }

  async function requestModelSwitch(model, provider, sid, isCurrent, confirmed = false) {
    const selection = provider ? `${model} --provider ${provider}` : model;
    const params = { session_id: sid, key: "model", value: `${selection} --global` };
    if (confirmed) params.confirm_expensive_model = true;
    const result = (await rpc("config.set", params, 60000)) || {};
    if (!isCurrent()) return null;
    if (!result.confirm_required) return result;

    if (confirmed) throw new Error("Hermes didn’t accept the confirmation.");
    const warning = result.confirm_message || result.warning || "Switching models may increase the cost of this chat.";
    const ok = await confirmDialog({
      title: "Switch model?",
      message: displaySwitchWarning(warning),
      confirmLabel: "Switch",
    });
    if (!ok || !isCurrent()) return null;
    return requestModelSwitch(model, provider, sid, isCurrent, true);
  }

  async function switchModel(model, provider) {
    const sid = getSid();
    const pickerView = view;
    const result = await requestModelSwitch(model, provider, sid, () => sid === getSid() && pickerView === view);
    if (!result) return null;
    if (result.deferred) {
      pendingPick = { model, provider, sid };
    } else {
      info.model = String(result.value || model);
      if (provider) info.provider = provider;
      pendingPick = null;
    }
    paintChip();
    return result;
  }

  async function pickModel(model, provider) {
    if (picking) return;
    const viewAtStart = view;
    const sid = getSid();
    const draft = isDraft();
    const compatibilityWarning = HERMES_CHAT_MODEL.test(model);
    picking = true;
    try {
      if (compatibilityWarning) {
        const ok = await confirmDialog({
          title: "Switch to this model?",
          message: "Hermes 3 and 4 are chat models. They don’t support the tool calls Hermes Agent needs for tasks.",
          confirmLabel: "Switch",
        });
        if (!ok || viewAtStart !== view || draft !== isDraft() || sid !== getSid()) return;
      }
      if (draft) {
        draftPick = { model, provider };
        info.model = model;
        info.provider = provider;
        paintChip();
        close();
        return;
      }
      if (!sid) {
        showPersistentToast("The chat isn’t connected yet. Try again when it reconnects.");
        return;
      }
      const result = await switchModel(model, provider);
      if (!result || viewAtStart !== view) return;
      const warning = extraWarning(result, compatibilityWarning);
      if (warning) {
        showPersistentToast("Model switched with a warning.", { detail: warning, tone: "neutral" });
      } else {
        close();
      }
    } catch (error) {
      if (draft !== isDraft() || sid !== getSid()) return;
      const detail = errorText(error);
      const name = (options?.providers || []).find((row) => row.slug === provider)?.name || "This provider";
      if (/is not connected: no API key or login/i.test(detail)) {
        if (provider === "nous") {
          if (viewAtStart === view) showPersistentToast(NOUS_SIGN_IN, { detail: detail.split(/\bDetails:\s*/, 2)[1] });
        } else {
          pickerError(viewAtStart, `${name} isn’t connected. Open Providers to set it up.`, error);
        }
      } else {
        pickerError(viewAtStart, "Couldn’t switch models. Try again or choose another model.", error);
      }
    } finally {
      picking = false;
    }
  }

  async function setEffort(word) {
    const viewAtStart = view;
    if (isDraft()) {
      draftEffort = word;
      paintChip();
      renderControls();
      return;
    }
    const sid = getSid();
    if (!sid) return;
    try {
      const result = await rpc("config.set", { session_id: sid, key: "reasoning", value: word, scope: "global" });
      if (isDraft() || getSid() !== sid) return;
      info.reasoning = String(result?.value || word);
      paintChip();
      renderControls();
    } catch (error) {
      if (isDraft() || getSid() !== sid) return;
      pickerError(viewAtStart, "Couldn’t change the reasoning level.", error);
      paintChip();
      renderControls();
    }
  }

  async function setFast(on) {
    const viewAtStart = view;
    const sid = getSid();
    if (isDraft() || !sid) return;
    try {
      const result = await rpc("config.set", { session_id: sid, key: "fast", value: on ? "on" : "off" });
      if (isDraft() || getSid() !== sid) return;
      info.fast = String(result?.value || "") === "fast" || String(result?.value || "") === "ultrafast";
      paintChip();
    } catch (error) {
      if (isDraft() || getSid() !== sid) return;
      pickerError(viewAtStart, "Couldn’t change Fast mode.", error);
    }
    renderControls();
  }

  // ---------- sheet ----------

  function build() {
    sheet = node("div", "model-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Model");
    sheet.setAttribute("popover", "manual");
    const scrim = node("div", "scrim model-scrim");
    scrim.setAttribute("popover", "manual");
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
    // A small pill button at the right under the list: "Providers +".
    const add = node("button", "model-add");
    add.append(node("span", "", "Providers"));
    add.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>');
    add.type = "button";
    add.addEventListener("click", () => void openAdd());

    const controls = node("div", "model-controls");
    // Reasoning sits under the title: the label with a slider beside it over Hermes's levels. The level itself shows
    // in the title line (model · level), so there is no separate value here; dragging previews it there and letting go
    // sends it.
    const effortRow = node("div", "model-row model-effort");
    effortRow.append(node("span", "model-row-label", "Reasoning"));
    // A level meter instead of a range input: five bars rising in height (low..max); none filled is Off. Tap a bar or
    // drag across them; the title line previews the level while the finger is down and it is sent on release. The zone
    // left of the first bar's left edge (not its middle) is Off, and tapping the only lit bar turns it off too.
    const effort = node("div", "model-meter");
    effort.tabIndex = 0;
    effort.setAttribute("role", "slider");
    effort.setAttribute("aria-label", "Reasoning effort");
    effort.setAttribute("aria-valuemin", "0");
    effort.setAttribute("aria-valuemax", String(EFFORTS.length - 1));
    for (let k = 1; k < EFFORTS.length; k += 1) effort.append(node("span", "model-meter-bar"));
    const showLevel = (index) => {
      [...effort.children].forEach((bar, k) => bar.classList.toggle("on", k < index));
      effort.dataset.level = String(index);
      effort.setAttribute("aria-valuenow", String(index));
      effort.setAttribute("aria-valuetext", EFFORTS[index][1]);
    };
    // Level under the finger, measured against the bars themselves (the box is wider, for an easy target): left of the
    // first bar is Off; otherwise the first bar whose right edge (plus half the gap) is past the finger.
    const levelAt = (x) => {
      const bars = [...effort.children].map((bar) => bar.getBoundingClientRect());
      if (x < bars[0].left) return 0;
      for (let k = 0; k < bars.length; k += 1) {
        const next = bars[k + 1];
        if (!next || x < (bars[k].right + next.left) / 2) return k + 1;
      }
      return bars.length;
    };
    let drag = null; // { start, moved }
    effort.addEventListener("pointerdown", (event) => {
      try {
        effort.setPointerCapture(event.pointerId);
      } catch {
        /* capture is a nicety: without it the drag still works while the finger stays over the meter */
      }
      drag = { start: Number(effort.dataset.level || 0), moved: false };
      const index = levelAt(event.clientX);
      showLevel(index);
      paintChip(EFFORTS[index][0]);
    });
    effort.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const index = levelAt(event.clientX);
      if (index !== Number(effort.dataset.level)) drag.moved = true;
      showLevel(index);
      paintChip(EFFORTS[index][0]);
    });
    const finish = () => {
      if (!drag) return;
      let index = Number(effort.dataset.level || 0);
      if (!drag.moved && index === 1 && drag.start === 1) index = 0; // tap the only lit bar: Off
      const changed = index !== drag.start;
      drag = null;
      showLevel(index);
      if (changed) void setEffort(EFFORTS[index][0]);
      else paintChip();
    };
    effort.addEventListener("pointerup", finish);
    effort.addEventListener("pointercancel", finish);
    effort.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const index = Math.max(0, Math.min(EFFORTS.length - 1, Number(effort.dataset.level || 0) + step));
      showLevel(index);
      void setEffort(EFFORTS[index][0]);
    });
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
    parts = { scrim, back, title, current, refresh, search, list, effort, effortRow, controls, fast, fastRow, pick, addPane };
  }

  function showPane(which) {
    view += 1;
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
    [...parts.effort.children].forEach((bar, k) => bar.classList.toggle("on", k < index));
    parts.effort.dataset.level = String(index);
    parts.effort.setAttribute("aria-valuenow", String(index));
    parts.effort.setAttribute("aria-valuetext", effort ? EFFORTS[index][1] : "Default");
    const caps = currentCaps();
    parts.effortRow.hidden = caps ? caps.reasoning === false : false;
    // Fast mode is a live-session setting and only some models have it (capabilities.fast).
    parts.fastRow.hidden = isDraft() || !(caps && caps.fast);
    parts.controls.hidden = parts.fastRow.hidden; // fast mode is its only row: no empty divider without it
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
    const current = selectedModel();
    const ordered = [...rows].sort((a, b) => Number(b.slug === current.provider) - Number(a.slug === current.provider));
    for (const row of ordered) {
      // The search matches the id, the friendly name, or the provider.
      const models = (row.models || []).filter((m) => !query || m.toLowerCase().includes(query) ||
        displayModelName(m).toLowerCase().includes(query) || row.name.toLowerCase().includes(query));
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
        const label = node("span", "model-option-name", displayModelName(model));
        label.title = model; // the exact id, for telling look-alikes apart
        item.append(label);
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
    const viewAtStart = view;
    const targetAtStart = targetKey();
    if (refresh) parts.refresh.classList.add("spin");
    try {
      await loadOptions(refresh);
    } catch (error) {
      if (targetKey() === targetAtStart) {
        pickerError(viewAtStart, "Couldn’t load models. Use Refresh models to try again.", error);
      }
    } finally {
      parts.refresh.classList.remove("spin");
    }
    if (viewAtStart === view && targetKey() === targetAtStart) {
      paintChip();
      renderList();
    }
  }

  async function disconnect(row) {
    const viewAtStart = view;
    const ok = await confirmDialog({
      title: `Disconnect ${row.name || row.slug}?`,
      message: "Hermes removes this provider's saved credentials. Chats using it stop working until it is added again.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok || viewAtStart !== view) return;
    try {
      await rpc("model.disconnect", { slug: row.slug });
      showToast("Disconnected", "success");
      await reload(false);
    } catch (error) {
      pickerError(viewAtStart, "Couldn’t disconnect the provider.", error);
    }
  }

  async function openAdd() {
    showPane("add");
    const viewAtStart = view;
    const pane = parts.addPane;
    pane.replaceChildren(node("p", "model-empty", "Loading…"));
    let payload, keyFields;
    try {
      [payload, keyFields] = await Promise.all([
        loadOptions(false, true),
        api("/api/plugins/hermes-mini/provider-key-fields").catch(() => null),
      ]);
    } catch (error) {
      if (viewAtStart === view) pane.replaceChildren();
      pickerError(viewAtStart, "Couldn’t load providers. Go back and try again.", error);
      return;
    }
    if (viewAtStart !== view) return;
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
    const all = rows.map((row) => ({ row, card: providerCard(row, keyFields?.providers) }));
    const none = node("p", "model-empty", "No providers match.");
    const filter = () => {
      const query = search.value.trim().toLowerCase();
      const shown = all.filter(({ row }) => !query || `${row.name || ""} ${row.slug}`.toLowerCase().includes(query));
      cards.replaceChildren(...shown.map(({ card }) => card), ...(shown.length ? [] : [none]));
    };
    search.addEventListener("input", filter);
    filter();
  }

  function providerCard(row, keyFields) {
    const card = node("section", "model-group provider-card");
    const header = node("button", "model-provider");
    header.type = "button";
    header.append(node("span", "model-provider-name", row.name || row.slug));
    const connected = row.authenticated === true;
    if (connected) header.append(node("span", "provider-connected", row.is_current ? "· In use" : "· Connected"));
    const body = node("div", "provider-body");
    header.addEventListener("click", () => {
      const next = !card.classList.contains("open");
      card.classList.toggle("open", next);
      if (next) body.querySelector("input")?.focus();
    });
    const custom = isCustomProvider(row);
    const catalogField = keyFields && Object.hasOwn(keyFields, row.slug) ? keyFields[row.slug] : "";
    const keyField = catalogField || (row.auth_type === "api_key" ? row.key_env : "");
    if (!custom && keyField && (!row.auth_type || row.auth_type === "api_key")) {
      const form = node("form", "provider-form");
      const label = node("label", "provider-label", connected ? "A key is already saved" : keyField);
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
        const viewAtStart = view;
        try {
          await rpc("model.save_key", { slug: row.slug, api_key: key }, 60000);
          showToast(`${row.name || row.slug} ${connected ? "updated" : "added"}`, "success");
          if (viewAtStart === view) showPane("pick");
          await reload(false);
        } catch (error) {
          pickerError(viewAtStart, "Couldn’t save the provider key. Check it and try again.", error);
        } finally {
          save.disabled = false;
        }
      });
      body.append(form);
    } else {
      body.append(setupNote(row, custom, connected));
    }
    card.append(header, body);
    return card;
  }

  // Your own endpoint: Hermes' generic "custom" entry and every `custom:<name>` one from config.yaml. Hermes'
  // key save only knows its built-in providers, so a key box here could never work.
  function isCustomProvider(row) {
    const slug = String(row.slug || "").toLowerCase();
    return Boolean(row.is_user_defined) || slug === "custom" || slug.startsWith("custom:");
  }

  // Hermes handles setup for custom endpoints and providers without a declared API-key method.
  function setupNote(row, custom, connected) {
    const name = row.name || row.slug;
    const note = node("div", "provider-note");
    const oauth = String(row.auth_type || "").startsWith("oauth");
    const title = row.slug === "nous" && !connected ? NOUS_SIGN_IN : "Manage in Hermes";
    note.append(node("p", "provider-note-title", title));
    let text;
    if (custom && connected) text = `${name} is your own endpoint. Change its address or key on the computer that runs Hermes: run`;
    else if (custom) text = "Use your own OpenAI-compatible endpoint. Add it on the computer that runs Hermes: run";
    else if (!connected && (oauth || row.slug === "nous")) text = "On the computer that runs Hermes, sign in through the provider setup menu. Run";
    else text = "On the computer that runs Hermes, open the provider setup menu. Run";
    const line = node("p", "provider-note-text", `${text} `);
    const command = node("button", "provider-command", "hermes model");
    command.type = "button";
    command.setAttribute("aria-label", "Copy the command hermes model");
    command.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("hermes model");
        showToast("Copied", "success");
      } catch {
        showToast("Could not copy", "error");
      }
    });
    line.append(command, document.createTextNode(custom ? (connected ? " or edit config.yaml." : " and pick Custom endpoint.") : ` and pick ${name}.`));
    note.append(line);
    return note;
  }

  async function open() {
    if (!sheet) build();
    showPane("pick");
    paintChip(); // fills the current-model label beside the title
    parts.search.value = "";
    renderList();
    // Top layer (popover), scrim first so the sheet sits directly above its own dim.
    openPopover(parts.scrim);
    openPopover(sheet);
    parts.scrim.classList.add("open");
    sheet.classList.add("open");
    chip?.setAttribute("aria-expanded", "true");
    await reload(false);
  }

  function close() {
    if (!sheet) return;
    sheet.classList.remove("open");
    parts.scrim.classList.remove("open");
    // Out of the top layer once the slide-out has played (220ms).
    closePopover(parts.scrim, 260);
    closePopover(sheet, 260);
    chip?.setAttribute("aria-expanded", "false");
    showPane("pick");
  }

  chip?.addEventListener("click", () => void open());
  paintChip();

  return { setInfo, showDraft, ensureDraftDefault, resetDraft, draftCreateParams, defaultCreateParams, applyDraftModel, close, isBusy };
}
