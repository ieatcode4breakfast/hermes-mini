"""Hermes Mini app backend — mounted at /api/plugins/hermes-mini/.

The chat itself rides Hermes' own authenticated ``/api/ws`` and REST routes; this router adds the
app's own data (to-dos, pins, seen markers, inbox read state, bookmarks, search, the app-chat registry,
the folded-job lookup, gateway events and audio metadata), identity and settings, capability
advertisement, live narration, Web Push, dictation and the gateway restart. It also records the
app's main chat as the platform's default scheduled-job delivery target once, so a bare
``hermes-mini`` address has a destination. The dashboard's dashboard-auth dependency is
attached by ``web_server_dashboard._mount_one_plugin_api`` (the same cookie auth as the rest of
``/api``), so this file only has to be a FastAPI ``router``.

Every path is resolved per call from Hermes' own home resolver (``mini_core``), so the package is
never written to and the active profile decides where data lives.

It must never break the chat: narration failures answer ``{"line": null}`` and log a warning.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Shared plugin modules
# ---------------------------------------------------------------------------
# Hermes imports the hook package and this dashboard module separately, so sibling modules are
# loaded by file path under fixed names instead of relying on a package path only one importer has.
def _sibling(name: str, filename: str):
    import importlib.util
    import sys

    module = sys.modules.get(name)
    if module is not None:
        return module
    path = Path(__file__).resolve().parent.parent / filename
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


core = _sibling("hermes_mini_core", "mini_core.py")
_policy = _sibling("hermes_mini_message_policy", "message_policy.py")

MAX_BODY_BYTES = 8 * 1024
MAX_NARRATE_BODY_BYTES = 16 * 1024
MAX_EVENTS = 12
MAX_TREE_PREVIOUS = 20
MAX_REQUEST_CHARS = 300
MAX_ARG_CHARS = 200
MAX_THINKING_CHARS = 400
MAX_LINE_CHARS = 90
MAX_TREE_TITLE_CHARS = 90
MAX_TREE_STEP_CHARS = 110


def _narration_system_prompt() -> str:
    return (
        f"You narrate, for a non-technical person, what their assistant {core.agent_identity()['name']} is doing right now. "
        "Write ONE short line, at most 10 words, present continuous, ending with an ellipsis, warm and "
        "plain (e.g. 'Comparing tonight's prices with your last statement…'). No tool names, code, file "
        "paths, IDs or jargon. Say only what the activity shows; never invent results or numbers. Don't "
        "repeat the previous lines; describe the newest step. Output only the line."
    )


def _narration_tree_system_prompt(has_title: bool) -> str:
    name = core.agent_identity()["name"]
    base = (
        f"You narrate a collapsible task outline for a non-technical person watching their assistant {name}. "
        "Write plain everyday English in present continuous tense (for example, 'Comparing features of popular "
        "self-hosted applications' or 'Checking Bitwarden Docker memory usage and mobile app notes'). "
        "Never use tool names, code, URLs, file paths, IDs, or jargon, never invent results or numbers, and "
        "never end lines with ellipses or periods. "
    )
    if not has_title:
        return (
            base
            + 'Output ONLY valid JSON matching {"title": "<overall task title, 4-8 words>", '
            '"step": "<current specific subject or milestone, 5-12 words>"}.'
        )
    return (
        base
        + "Compare the newest activity against the steps already listed. "
        "Only add a new row when the assistant has clearly moved to a NEW subject, item, source, or distinct phase "
        '(such as finishing one app/item and starting the next, or shifting to writing the comparison). '
        "If it is still doing follow-up checks on the SAME subject already listed, stay quiet. "
        'Output ONLY valid JSON: either {"step": "<new subject/milestone, 5-12 words>"} or {"step": null}.'
    )


NARRATION_MAX_TOKENS = 120
NARRATION_TIMEOUT = 10.0

# Web Push endpoints we accept. Everything else is refused so this route cannot be used to make the
# dashboard POST to arbitrary hosts.
PUSH_HOSTS = (
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
)
PUSH_CHOICES = {"once", "session", "always", "deny"}

_PUSH_LOCK = threading.Lock()


def _push_store():
    return _sibling("hermes_mini_push", "push_store.py")


def _endpoint_allowed(endpoint: str) -> bool:
    if not endpoint or not endpoint.startswith("https://"):
        return False
    try:
        host = (urlsplit(endpoint).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    if not host:
        return False
    if any(host == allowed or host.endswith("." + allowed) for allowed in PUSH_HOSTS):
        return True
    return host == "push.apple.com" or host.endswith(".push.apple.com")


def _subscription_from_body(body: dict[str, Any], user_agent: str) -> dict[str, Any] | None:
    endpoint = str(body.get("endpoint") or "").strip()
    keys = body.get("keys")
    if not _endpoint_allowed(endpoint) or not isinstance(keys, dict):
        return None
    store = _push_store()
    p256dh = str(keys.get("p256dh") or "")
    auth = str(keys.get("auth") or "")
    try:
        public = store.b64url_decode(p256dh)
        secret = store.b64url_decode(auth)
    except Exception:  # noqa: BLE001 - malformed base64url is just an invalid subscription
        return None
    # Uncompressed P-256 point is 65 bytes and starts with 0x04; the auth secret is exactly 16.
    if len(public) != 65 or public[0] != 0x04 or len(secret) != 16:
        return None
    return {
        "endpoint": endpoint,
        "keys": {"p256dh": p256dh, "auth": auth},
        "user_agent": user_agent[:300],
    }


async def _json_body(request: Request) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        log.warning("push: body too large (%d bytes)", len(raw))
        return None, JSONResponse({"detail": "body too large"}, status_code=413)
    try:
        body = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError):
        return None, JSONResponse({"detail": "invalid json"}, status_code=400)
    if not isinstance(body, dict):
        return None, JSONResponse({"detail": "invalid json"}, status_code=400)
    return body, None


def _null(status_code: int = 200) -> JSONResponse:
    return JSONResponse({"line": None}, status_code=status_code)


def _clip(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    value = value.strip()
    return value[:limit]


def _clean_line(raw: Any) -> str | None:
    """First line, no markdown/quote wrapper, <= 90 chars, ending in an ellipsis."""
    if not isinstance(raw, str):
        return None
    text = raw.replace("\r", "\n").split("\n", 1)[0].strip()
    text = text.lstrip("#>*-• ").strip()
    text = text.strip("\"'`“”‘’*_ ").strip()
    if not text:
        return None
    text = " ".join(text.split())
    if text.endswith("..."):
        text = text[:-3].rstrip()
    if text.endswith("…"):
        text = text[:-1].rstrip()
    if len(text) > MAX_LINE_CHARS - 1:
        text = text[: MAX_LINE_CHARS - 1].rstrip()
    if not text:
        return None
    return text + "…"


def _build_user_message(body: dict[str, Any]) -> str:
    parts: list[str] = []
    request = _clip(body.get("request"), MAX_REQUEST_CHARS)
    if request:
        parts.append(f"The person asked: {request}")
    lines: list[str] = []
    events = body.get("events")
    if isinstance(events, list):
        for event in events[-MAX_EVENTS:]:
            if not isinstance(event, dict):
                continue
            kind = _clip(event.get("kind"), 20)
            if kind == "thinking":
                thought = _clip(event.get("text"), MAX_THINKING_CHARS)
                if thought:
                    lines.append(f"- {core.agent_identity()['name']} is thinking: {thought}")
                continue
            name = _clip(event.get("name"), 80)
            if not name:
                continue
            status = _clip(event.get("status"), 20) or "running"
            args = _clip(event.get("args"), MAX_ARG_CHARS)
            summary = _clip(event.get("summary"), MAX_ARG_CHARS)
            line = f"- tool {name} ({status})"
            if args:
                line += f" args={args}"
            if summary:
                line += f" summary={summary}"
            lines.append(line)
    if lines:
        parts.append("Recent activity, oldest first:\n" + "\n".join(lines))
    previous = body.get("previous")
    if isinstance(previous, list):
        kept = [_clip(item, MAX_LINE_CHARS) for item in previous[-3:]]
        kept = [item for item in kept if item]
        if kept:
            parts.append("Already shown (do not repeat):\n" + "\n".join(f"- {item}" for item in kept))
    return "\n\n".join(parts) or "The assistant is working, between steps."


def _clean_activity_line(raw: Any, limit: int = MAX_TREE_STEP_CHARS) -> str | None:
    """First non-empty line, stripped of markdown/quote wrappers and trailing ellipses/periods."""
    if not isinstance(raw, str):
        return None
    for line in raw.replace("\r", "\n").split("\n"):
        text = line.strip().lstrip("#>*-• ").strip().strip("\"'`“”‘’*_ ").strip()
        if text:
            break
    else:
        return None
    text = " ".join(text.split())
    while text.endswith(("...", "…", ".")):
        if text.endswith("..."):
            text = text[:-3].rstrip()
        else:
            text = text[:-1].rstrip()
    if not text or text.lower().startswith("working on it"):
        return None
    if text.lower() in {"null", "none", "no_change", "no change", "same"}:
        return None
    if len(text) > limit:
        text = text[:limit].rstrip()
    return text or None


def _norm_step_key(text: str) -> str:
    return " ".join(text.lower().rstrip(".,… ").split())


def _build_tree_user_message(body: dict[str, Any]) -> str:
    parts: list[str] = []
    request = _clip(body.get("request"), MAX_REQUEST_CHARS)
    if request:
        parts.append(f"The person asked: {request}")
    title = _clean_activity_line(body.get("title"), MAX_TREE_TITLE_CHARS)
    if title:
        parts.append(f"Current task title: {title}")
    previous = body.get("previous")
    if isinstance(previous, list):
        kept = [_clean_activity_line(item, MAX_TREE_STEP_CHARS) for item in previous[-MAX_TREE_PREVIOUS:]]
        kept = [item for item in kept if item]
        if kept:
            parts.append(
                "Steps already shown in this tree (do not repeat or rephrase the same subject):\n"
                + "\n".join(f"- {item}" for item in kept)
            )
    lines: list[str] = []
    events = body.get("events")
    if isinstance(events, list):
        for event in events[-MAX_EVENTS:]:
            if not isinstance(event, dict):
                continue
            kind = _clip(event.get("kind"), 20)
            if kind == "thinking":
                thought = _clip(event.get("text"), MAX_THINKING_CHARS)
                if thought:
                    lines.append(f"- {core.agent_identity()['name']} is thinking: {thought}")
                continue
            name = _clip(event.get("name"), 80)
            if not name:
                continue
            status = _clip(event.get("status"), 20) or "running"
            args = _clip(event.get("args"), MAX_ARG_CHARS)
            summary = _clip(event.get("summary"), MAX_ARG_CHARS)
            line = f"- tool {name} ({status})"
            if args:
                line += f" args={args}"
            if summary:
                line += f" summary={summary}"
            lines.append(line)
    if lines:
        parts.append("Newest activity, oldest first:\n" + "\n".join(lines))
    return "\n\n".join(parts) or "The assistant is working."


def _parse_tree_narration(raw: Any, *, has_title: bool, previous: list[str]) -> tuple[str | None, str | None]:
    if not isinstance(raw, str):
        return None, None
    text = raw.strip()
    if not text:
        return None, None
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text).strip()
    data: dict[str, Any] | None = None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            data = parsed
    except ValueError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            try:
                parsed = json.loads(text[start : end + 1])
                if isinstance(parsed, dict):
                    data = parsed
            except ValueError:
                data = None

    seen = {_norm_step_key(item) for item in previous if isinstance(item, str) and item.strip()}
    if data is not None:
        title = None if has_title else _clean_activity_line(data.get("title"), MAX_TREE_TITLE_CHARS)
        step = _clean_activity_line(data.get("step"), MAX_TREE_STEP_CHARS)
        if step and _norm_step_key(step) in seen:
            step = None
        return title, step

    step = _clean_activity_line(text, MAX_TREE_STEP_CHARS)
    if step and _norm_step_key(step) in seen:
        step = None
    return None, step


@router.post("/narrate")
async def narrate(request: Request):
    tree_mode = False
    try:
        raw = await request.body()
        if len(raw) > MAX_NARRATE_BODY_BYTES:
            log.warning("narrate: body too large (%d bytes)", len(raw))
            return _null(413)
        try:
            body = json.loads(raw or b"{}")
        except (ValueError, UnicodeDecodeError):
            return _null(400)
        if not isinstance(body, dict):
            return _null(400)

        tree_mode = body.get("mode") == "tree"
        events = body.get("events")
        has_events = isinstance(events, list) and any(isinstance(e, dict) and (e.get("name") or e.get("text")) for e in events)
        if not has_events:
            return JSONResponse({"title": None, "step": None, "line": None}) if tree_mode else _null()

        from agent.plugin_llm import PluginLlm  # public plugin API: the host's model access for plugins

        has_title = bool(_clean_activity_line(body.get("title"), MAX_TREE_TITLE_CHARS)) if tree_mode else False
        previous = [str(p) for p in (body.get("previous") or []) if isinstance(p, str)][-MAX_TREE_PREVIOUS:]
        sys_prompt = _narration_tree_system_prompt(has_title) if tree_mode else _narration_system_prompt()
        user_prompt = _build_tree_user_message(body) if tree_mode else _build_user_message(body)

        # On the plugin's own auxiliary task (registered in __init__.py, low reasoning), so the call follows the
        # route the person picked for it and no override is needed.
        result = await PluginLlm(plugin_id=core.PLUGIN_ID).acomplete(
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=NARRATION_MAX_TOKENS,
            timeout=NARRATION_TIMEOUT,
            task="hermes_mini_narration",
            purpose="narration",
        )
        content = result.text
        if tree_mode:
            title, step = _parse_tree_narration(content, has_title=has_title, previous=previous)
            return JSONResponse({"title": title, "step": step, "line": step})

        line = _clean_line(content)
        if not line:
            log.warning("narrate: model returned no usable line")
            return _null()
        return JSONResponse({"line": line})
    except Exception as exc:  # noqa: BLE001 - narration must never surface as an error to the client
        log.warning("narrate failed: %s", exc)
        return JSONResponse({"title": None, "step": None, "line": None}) if tree_mode else _null()


# ---------- Web Push ----------


# ---------- pinned chat order ----------
# Hermes keeps only a pinned flag per chat, no order, so the drawer's manual order lives here, shared by every device.

MAX_PINNED_IDS = 200
_PIN_LOCK = threading.Lock()


def _pin_order_path() -> Path:
    return core.data_file("pin-order.json")


def _read_pin_order() -> list[str]:
    try:
        data = json.loads(_pin_order_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception as exc:  # noqa: BLE001 - a bad file means "no saved order", never a broken drawer
        log.warning("pin order unreadable: %s", exc)
        return []
    order = data.get("order") if isinstance(data, dict) else None
    return [str(x) for x in order if isinstance(x, str) and x][:MAX_PINNED_IDS] if isinstance(order, list) else []


@router.get("/pin-order")
async def get_pin_order():
    return JSONResponse({"order": _read_pin_order()})


@router.put("/pin-order")
async def put_pin_order(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    order = body.get("order")
    if not isinstance(order, list) or not all(isinstance(x, str) and 0 < len(x) <= 200 for x in order):
        return JSONResponse({"detail": "order must be a list of chat ids"}, status_code=400)
    clean = list(dict.fromkeys(order))[:MAX_PINNED_IDS]
    try:
        with _PIN_LOCK:
            path = _pin_order_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"order": clean}), encoding="utf-8")
            tmp.replace(path)
    except Exception as exc:  # noqa: BLE001
        log.warning("pin order save failed: %s", exc)
        return JSONResponse({"detail": "could not save the order"}, status_code=500)
    return JSONResponse({"order": clean})


# ---------- app chat registry ----------
# The chats the app started (app_chats.py, shared with the push hooks). The drawer lists only these plus the main chat.


def _app_chats():
    return _sibling("hermes_mini_app_chats", "app_chats.py")


def _home_id() -> str:
    """The recorded main-chat id, or '' when none is claimed yet."""
    try:
        return _app_chats().home()
    except Exception:  # noqa: BLE001 - the registry is optional for every read path
        return ""


@router.get("/app-chats")
async def get_app_chats():
    try:
        chats = _app_chats()
        return JSONResponse({"ids": sorted(chats.ids()), "home": chats.home()})
    except Exception as exc:  # noqa: BLE001 - the drawer falls back to its source rule
        log.warning("app-chats read failed: %s", exc)
        return JSONResponse({"detail": "registry unavailable"}, status_code=503)


@router.post("/app-chats")
async def add_app_chat(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    session_id = body.get("id")
    if not isinstance(session_id, str) or not 0 < len(session_id) <= 200:
        return JSONResponse({"detail": "id must be a chat id"}, status_code=400)
    claim = bool(body.get("home"))
    try:
        chats = _app_chats()
        added = chats.add(session_id)
        current = chats.claim_home(session_id) if claim else chats.home()
    except Exception as exc:  # noqa: BLE001
        log.warning("app-chats write failed: %s", exc)
        return JSONResponse({"detail": "registry unavailable"}, status_code=503)
    return JSONResponse({"ok": True, "added": added, "home": current})


@router.delete("/app-chats/home")
async def clear_app_home():
    try:
        chats = _app_chats()
        old_home = chats.home()
        chats.set_home("")
    except Exception as exc:  # noqa: BLE001
        log.warning("app-chats home clear failed: %s", exc)
        return JSONResponse({"detail": "registry unavailable"}, status_code=503)
    try:
        core.clear_gateway_events()
    except OSError as exc:
        log.warning("gateway events clear failed: %s", exc)
    if old_home:
        try:
            _delete_session_activity(old_home)
        except Exception as exc:  # noqa: BLE001
            log.warning("activity clear failed: %s", exc)
    return JSONResponse({"ok": True, "home": ""})


# ---------- unread markers ----------
# A chat is unread while its last activity is newer than the last time it was looked at. The map lives here so every
# device agrees: reading a chat on the phone clears its dot on the desktop too. "since" is when the store was first
# created, so chats that already existed start out read rather than all showing a dot.

MAX_SEEN_IDS = 2000
_SEEN_LOCK = threading.Lock()


def _seen_path() -> Path:
    return core.data_file("seen.json")


def _read_seen() -> dict[str, Any] | None:
    """The shared map, or None when there is no readable file yet (a first run, or a corrupt one)."""
    try:
        data = json.loads(_seen_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001 - a bad file means "nothing seen yet", never a broken drawer
        log.warning("seen store unreadable: %s", exc)
        return None
    if not isinstance(data, dict):
        return None
    since = data.get("since")
    seen_raw = data.get("seen")
    seen: dict[str, int] = {}
    if isinstance(seen_raw, dict):
        for key, value in seen_raw.items():
            if isinstance(key, str) and key and isinstance(value, (int, float)) and not isinstance(value, bool):
                seen[key] = int(value)
    unread_raw = data.get("unread")
    unread: list[str] = []
    if isinstance(unread_raw, list):
        seen_unread: set[str] = set()
        for item in unread_raw:
            if isinstance(item, str) and 0 < len(item) <= 200 and item not in seen_unread:
                seen_unread.add(item)
                unread.append(item)
                if len(unread) >= MAX_SEEN_IDS:
                    break
    return {
        "since": int(since) if isinstance(since, (int, float)) and not isinstance(since, bool) else 0,
        "seen": seen,
        "unread": unread,
    }


def _write_seen(data: dict[str, Any]) -> None:
    path = _seen_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


@router.get("/seen")
async def get_seen():
    with _SEEN_LOCK:
        data = _read_seen()
        if data is None:
            # First ever read: everything that already exists counts as read.
            data = {"since": int(time.time()), "seen": {}, "unread": []}
            try:
                _write_seen(data)
            except Exception as exc:  # noqa: BLE001 - the answer still works, the next GET retries the file
                log.warning("seen store create failed: %s", exc)
        return JSONResponse(data)


@router.put("/seen")
async def put_seen(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    session_id = body.get("id")
    at = body.get("at")
    if not isinstance(session_id, str) or not 0 < len(session_id) <= 200:
        return JSONResponse({"detail": "id must be a chat id"}, status_code=400)
    if isinstance(at, bool) or not isinstance(at, (int, float)) or at != at or at in (float("inf"), float("-inf")):
        return JSONResponse({"detail": "at must be a unix time in seconds"}, status_code=400)
    stamp = int(at)
    try:
        with _SEEN_LOCK:
            data = _read_seen()
            if data is None:
                now = int(time.time())
                data = {"since": now, "seen": {}, "unread": []}
            seen = data["seen"]
            seen[session_id] = max(int(seen.get(session_id) or 0), stamp)
            if len(seen) > MAX_SEEN_IDS:
                # Keep the most recently read chats: an old id can always be re-read and re-added.
                kept = sorted(seen.items(), key=lambda item: item[1], reverse=True)[:MAX_SEEN_IDS]
                data["seen"] = seen = dict(kept)
            _write_seen(data)
    except Exception as exc:  # noqa: BLE001
        log.warning("seen store save failed: %s", exc)
        return JSONResponse({"detail": "could not save the seen marker"}, status_code=500)
    return JSONResponse(data)


@router.post("/seen/unread")
async def set_chat_unread(request: Request):
    """Marks a chat session manually unread (shows its dot even if already read) or clears it."""
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    session_id = body.get("id")
    if not isinstance(session_id, str) or not 0 < len(session_id) <= 200:
        return JSONResponse({"detail": "id must be a chat id"}, status_code=400)
    unread = body.get("unread", True)
    if not isinstance(unread, bool):
        return JSONResponse({"detail": "unread must be true or false"}, status_code=400)
    at = body.get("at")
    if "at" in body and (
        isinstance(at, bool) or not isinstance(at, (int, float)) or at != at or at in (float("inf"), float("-inf"))
    ):
        return JSONResponse({"detail": "at must be a unix time in seconds"}, status_code=400)
    try:
        with _SEEN_LOCK:
            now = int(time.time())
            data = _read_seen()
            if data is None:
                data = {"since": now, "seen": {}, "unread": []}
            manual = [cid for cid in data.get("unread", []) if cid != session_id]
            if unread:
                manual.append(session_id)
                if len(manual) > MAX_SEEN_IDS:
                    manual = manual[-MAX_SEEN_IDS:]
            else:
                seen = data["seen"]
                stamp = max(int(at) if at is not None else 0, now)
                seen[session_id] = max(int(seen.get(session_id) or 0), stamp)
                if len(seen) > MAX_SEEN_IDS:
                    kept = sorted(seen.items(), key=lambda item: item[1], reverse=True)[:MAX_SEEN_IDS]
                    data["seen"] = dict(kept)
            data["unread"] = manual
            _write_seen(data)
    except Exception as exc:  # noqa: BLE001
        log.warning("seen unread save failed: %s", exc)
        return JSONResponse({"detail": "could not save the unread state"}, status_code=500)
    return JSONResponse(data)


# ---------- Inbox ----------
# One feed of every agent bubble the app draws, across the chats it lists. The Inbox stores no messages of its own:
# every read comes from state.db (read-only), so deleting a chat makes its rows disappear and nothing is unopenable.
# What it DOES store is identity and read state only (message ids), in its own file - never text - so the drawer's
# unread markers (seen.json) and this tracker stay independent.


INBOX_PAGE = 50
INBOX_MAX_TEXT = 400
INBOX_MAX_READ_IDS = 50000
INBOX_MAX_POST_IDS = 1000
INBOX_MAX_STATE_IDS = 200
_INBOX_LOCK = threading.Lock()

# app.js chatEntries() constants, ported verbatim (each used by the rule it belongs to below).
JOB_PREFIX = re.compile(r"^\[Scheduled job result\]\s*")  # app.js JOB_PREFIX (bridge.py PREFIX)
LIFECYCLE_NOTICE = re.compile(r"^\W{0,4}(?:Hermes is (?:shutting down|restarting)\b|Restarting gateway\b)")  # app.js LIFECYCLE_NOTICE
SILENCE_MARKERS = {"[SILENT]", "SILENT", "NO_REPLY", "NO REPLY", "[静默]", "静默", "[沉默]", "沉默"}  # app.js SILENT_MARKERS
# app.js MEDIA_PATH_RE: the image paths attachMedia draws as thumbnails (bare, `code`, or MEDIA:/path). An image the
# chat shows becomes the word "Photo" here, since the Inbox draws text only.
MEDIA_PATH_RE = re.compile(
    r"(?:^|[\s`'\"(\[]|MEDIA:)((?:/|~/)[^\s`'\"<>()\[\]]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s`'\")\].,;:!?])",
    re.IGNORECASE,
)
IMAGE_MD_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK_MD_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def _state_db_path() -> Path:
    return core.hermes_home() / "state.db"


def _inbox_read_path() -> Path:
    return core.data_file("inbox-read.json")


def _inbox_conn() -> sqlite3.Connection:
    """A read-only handle to state.db; no other code shares it."""
    conn = sqlite3.connect(f"file:{_state_db_path()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _app_chat_ids() -> set[str]:
    """The app's own chat registry (app_chats.py). A seam for the server tests, which use a temp registry."""
    try:
        return set(_app_chats().ids())
    except Exception as exc:  # noqa: BLE001 - the main chat still feeds the Inbox when the registry cannot load
        log.warning("inbox: app-chat registry unavailable: %s", exc)
        return set()


def _scope_titles(conn: sqlite3.Connection) -> dict[str, str]:
    """The chats the app lists: the registry plus the recorded main chat, existing and not archived.

    Mirrors drawer.js isListed()/fetchPage(): only archived=exclude rows survive. The home is the id the app recorded,
    not whichever session happens to carry the home title; missing ids never come back, so a deleted chat's rows
    vanish from the feed.
    """
    registered = _app_chat_ids()
    home = _home_id()
    titles: dict[str, str] = {}
    for row in conn.execute("SELECT id, title, archived FROM sessions"):
        if row["archived"]:
            continue
        title = str(row["title"] or "")
        if row["id"] in registered or (home and row["id"] == home):
            titles[str(row["id"])] = title
    return titles


def _content_text(value: Any) -> str:
    """app.js messageText(): plain content or the text parts of a structured content list."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for part in value:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text") or ""))
        return "".join(parts)
    return ""


# agent/context_compressor.py: a compaction handoff summary is either standalone (hidden in the transcript) or merged
# around a preserved tail message ([PRIOR CONTEXT ...] before [END OF PRIOR CONTEXT ...], or after the end marker).
_COMPACTION_PRIOR_HEADER = "[PRIOR CONTEXT — for reference only; not a new message]"
_COMPACTION_MERGED_DELIMITER = "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]"
_COMPACTION_END_MARKER = "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---"
_COMPACTION_PREFIXES = ("[CONTEXT COMPACTION — REFERENCE ONLY]", "[CONTEXT SUMMARY —")


def _unwrap_compaction_summary(text: str, summary_flag: bool = False) -> str:
    """hermes_cli/web_routers/sessions.py _project_for_display(): a merged compaction carrier shows only its prior
    message; a standalone summary is hidden (empty)."""
    stripped = text.strip()
    if _COMPACTION_MERGED_DELIMITER in stripped:
        prior = stripped.split(_COMPACTION_MERGED_DELIMITER, 1)[0].strip()
        if prior.startswith(_COMPACTION_PRIOR_HEADER):
            prior = prior[len(_COMPACTION_PRIOR_HEADER):].strip()
        return prior
    if summary_flag or stripped.startswith(_COMPACTION_PREFIXES):
        if _COMPACTION_END_MARKER in stripped:
            return stripped.split(_COMPACTION_END_MARKER, 1)[1].strip()
        if stripped.startswith(_COMPACTION_PREFIXES):
            return ""
    return stripped


def _row_text(row: sqlite3.Row) -> str:
    """app.js chatEntries(): the decoded stored ``content``, trimmed (without the app's ``display_content`` layer)."""
    raw = row["content"]
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8", "replace")
    text = _content_text(raw) if isinstance(raw, (str, list)) else ("" if raw is None else str(raw))
    if isinstance(text, str) and text.startswith("\x00json:"):
        text = text[6:]
    if isinstance(text, str) and text[:1] in ("[", "{"):
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, (list, dict)):
            text = _content_text(parsed)
    summary_flag = bool(row["_compressed_summary"]) if "_compressed_summary" in row.keys() else False
    return _unwrap_compaction_summary(text.strip(), summary_flag)


def _model_only(value: Any) -> bool:
    """app.js modelOnly(): display_metadata.model_only === true."""
    meta = value
    if isinstance(meta, (bytes, bytearray)):
        meta = bytes(meta).decode("utf-8", "replace")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except (ValueError, TypeError):
            return False
    return isinstance(meta, dict) and meta.get("model_only") is True


def _is_silence_marker(text: str) -> bool:
    """app.js isSilenceMarker(): the whole reply means "chose not to answer", edge punctuation tolerated."""
    value = re.sub(r"\s+", " ", str(text or "").strip()).upper()
    value = re.sub(r"^[*_`.!?,;:'\"]+|[*_`.!?,;:'\"]+$", "", value)
    return value in SILENCE_MARKERS


def _search_plain_text(text: str) -> str:
    """Markdown stripped, whitespace collapsed; an inline image becomes "Photo". Never truncated."""
    value = IMAGE_MD_RE.sub(" Photo ", str(text or ""))
    value = MEDIA_PATH_RE.sub(" Photo ", value)
    value = LINK_MD_RE.sub(r"\1", value)
    value = core.plain_markdown(value)  # only marks that format; `column_total` keeps its underscore
    value = re.sub(r"(?m)^\s{0,3}(?:[-+*]|\d+\.)\s+", "", value)  # list bullets
    return re.sub(r"\s+", " ", value).strip()


def _plain_text(text: str) -> str:
    """The Inbox's preview: _search_plain_text, capped at INBOX_MAX_TEXT."""
    return _search_plain_text(text)[:INBOX_MAX_TEXT]


def _inbox_item(row: sqlite3.Row, titles: dict[str, str]) -> dict[str, Any] | None:
    """One row the chat draws as an agent bubble, or None (app.js chatEntries)."""
    role = str(row["role"] or "")
    kind = str(row["display_kind"] or "")
    if role == "user":
        # app.js: kind job_delivery is drawn on the agent's side, body = text minus the job prefix, lifecycle notices
        # skipped. Every other user row is the person's own message (excluded).
        if kind != "job_delivery":
            return None
        body = core.strip_cron_wrapper(JOB_PREFIX.sub("", _row_text(row), count=1).strip())
        body = _policy.display_text(body, notice=True)
        if not body or LIFECYCLE_NOTICE.match(body):
            return None
        text = body
    elif role == "assistant":
        # app.js: display_kind hidden and model-only copies are never drawn; failed_turn is a muted line, not a bubble;
        # an empty stub is dropped; a silence marker is never shown; active-turn tool steps are excluded.
        if kind in ("hidden", "failed_turn") or _model_only(row["display_metadata"]):
            return None
        if "finish_reason" in row.keys() and str(row["finish_reason"] or "") == "tool_calls":
            return None
        if "tool_calls" in row.keys():
            tc = row["tool_calls"]
            if tc and str(tc) not in ("", "[]"):
                return None
        text = _policy.display_text(_row_text(row))
        if not text or _is_silence_marker(text):
            return None
    else:
        return None  # tool rows, system rows: never bubbles
    plain = _plain_text(text)
    if not plain:
        return None
    title = titles.get(str(row["session_id"]), "")
    # The main chat reads as the chat list's home row does (the external home label, else the agent name).
    home = str(row["session_id"]) == _home_id()
    thread = core.agent_identity()["home_label"] if home else (title or "Untitled")
    return {
        "id": int(row["id"]),
        "session_id": str(row["session_id"]),
        "thread": thread,
        "home": home,  # the app draws the chat list's home icon beside the main chat's name
        "ts": float(row["timestamp"] or 0),
        "text": plain,
    }


def _has_message_uid(conn: sqlite3.Connection) -> bool:
    """Whether this state.db carries Hermes's stable per-message identity (an older schema may not)."""
    try:
        return any(row[1] == "message_uid" for row in conn.execute("PRAGMA table_info(messages)"))
    except sqlite3.Error:
        return False


# Hermes folds back-to-back user rows into one before a turn (agent/agent_runtime_helpers.py _merge_consecutive_users).
# Job results stored by the bridge are user rows, so the person's reply after a run of job results folds them all into
# one row, and the fold drops the job classification on purpose (Hermes keeps the person's turn addressable). The
# app would draw that row as one bubble from the person. The originals stay in state.db, inactive: the survivor names
# them by message_uid (its own uid, then absorbed_message_uids in text order). The chat redraws a merged row from
# them (/merged-jobs) and the Inbox lists the job originals again (_candidate_rows).
_MERGED_SURVIVOR_SQL = ("s.role = 'user' AND s.display_kind IS NULL AND s.absorbed_message_uids IS NOT NULL"
                        " AND (s.active = 1 OR s.compacted = 1)")
MERGED_MAX_ROWS = 500


def _has_absorbed_uids(conn: sqlite3.Connection) -> bool:
    try:
        return any(row[1] == "absorbed_message_uids" for row in conn.execute("PRAGMA table_info(messages)"))
    except sqlite3.Error:
        return False


def _merged_survivors(conn: sqlite3.Connection, session_ids: list[str]) -> list[tuple[sqlite3.Row, list[str]]]:
    """Active folded user rows in these chats, each with its constituents' uids in text order."""
    if not session_ids or not _has_message_uid(conn) or not _has_absorbed_uids(conn):
        return []
    marks = ",".join("?" for _ in session_ids)
    rows = conn.execute(
        f"SELECT s.id, s.session_id, s.message_uid, s.absorbed_message_uids FROM messages s"
        f" WHERE s.session_id IN ({marks}) AND {_MERGED_SURVIVOR_SQL} ORDER BY s.id DESC LIMIT ?",
        [*session_ids, MERGED_MAX_ROWS]).fetchall()
    out = []
    for row in rows:
        try:
            absorbed = json.loads(row["absorbed_message_uids"])
        except (ValueError, TypeError):
            continue
        uids = [row["message_uid"], *(absorbed if isinstance(absorbed, list) else [])]
        if len(uids) > 1 and all(isinstance(uid, str) and uid for uid in uids):
            out.append((row, uids))
    return out


def _constituent_rows(conn: sqlite3.Connection, session_id: str, uids: list[str], survivor_id: int) -> dict[str, sqlite3.Row]:
    """uid -> the earliest unfolded row carrying it (the original as it was stored)."""
    marks = ",".join("?" for _ in uids)
    found: dict[str, sqlite3.Row] = {}
    for row in conn.execute(
            f"SELECT id, message_uid, role, content, display_kind, timestamp, active, compacted FROM messages"
            f" WHERE session_id = ? AND message_uid IN ({marks}) AND absorbed_message_uids IS NULL AND id != ?"
            f" ORDER BY id ASC", [session_id, *uids, survivor_id]):
        found.setdefault(row["message_uid"], row)
    return found


def _merged_job_ids(conn: sqlite3.Connection, session_ids: list[str]) -> list[int]:
    """Ids of job results that live on only inside a folded row: the Inbox lists these originals."""
    ids: list[int] = []
    for survivor, uids in _merged_survivors(conn, session_ids):
        marks = ",".join("?" for _ in uids)
        jobs = conn.execute(
            f"SELECT id, message_uid, active, compacted FROM messages WHERE session_id = ? AND message_uid IN ({marks})"
            " AND role = 'user' AND display_kind = 'job_delivery' ORDER BY id ASC",
            [survivor["session_id"], *uids]).fetchall()
        shown = {row["message_uid"] for row in jobs if row["active"] or row["compacted"]}  # already in the feed
        first: dict[str, int] = {}
        for row in jobs:
            first.setdefault(row["message_uid"], int(row["id"]))
        ids.extend(row_id for uid, row_id in first.items() if uid not in shown)
    return sorted(set(ids))


def _merged_job_parts(conn: sqlite3.Connection, session_id: str) -> dict[str, list[dict[str, Any]]]:
    """Folded rows in one chat that swallowed a job result, as their originals (app.js expandMerged).

    A job part keeps its original id (the one its notification and Inbox entry name); every other part keeps the
    folded row's id, the one Hermes addresses that turn by. A row whose originals are not all found is left alone.
    """
    out: dict[str, list[dict[str, Any]]] = {}
    for survivor, uids in _merged_survivors(conn, [session_id]):
        originals = _constituent_rows(conn, session_id, uids, int(survivor["id"]))
        if len(originals) != len(set(uids)):
            continue
        parts: list[dict[str, Any]] = []
        for uid in dict.fromkeys(uids):
            row = originals[uid]
            content = row["content"]
            if not isinstance(content, str) or content.startswith("\x00"):
                parts = []  # multimodal or undecodable: draw the folded row as Hermes stored it
                break
            job = row["display_kind"] == "job_delivery"
            parts.append({
                "id": int(row["id"]) if job else int(survivor["id"]),
                "display_kind": row["display_kind"],
                "content": content,
                "timestamp": row["timestamp"],
            })
        if parts and any(part["display_kind"] == "job_delivery" for part in parts):
            out[str(survivor["id"])] = parts
    return out


def _read_copies(conn: sqlite3.Connection, rows: list[sqlite3.Row], watermark: int, read: set[int],
                 unread: set[int] | None = None) -> set[int]:
    """Ids among ``rows`` whose message was already read under another row id.

    Context compaction writes the messages it keeps back out as new rows: new ids, same chat, same ``message_uid``
    and timestamp, with the originals left inactive. Read state is kept by row id, so without this every compaction
    brought a batch of already-read replies back as unread. Only rows that look unread by id are looked up, one
    query per chat (the (session_id, id) index), so the badge stays cheap to poll. A row marked unread on purpose
    (``unread``) is never a read copy, and neither is a copy of one.
    """
    unread = unread or set()
    wanted: dict[str, dict[str, list[int]]] = {}
    for row in rows:
        row_id = int(row["id"])
        if row_id <= watermark or row_id in read or row_id in unread:
            continue
        uid = row["message_uid"] if "message_uid" in row.keys() else None
        if uid:
            wanted.setdefault(str(row["session_id"]), {}).setdefault(str(uid), []).append(row_id)
    found: set[int] = set()
    for session_id, by_uid in wanted.items():
        uids = list(by_uid)
        for start in range(0, len(uids), 500):
            chunk = uids[start:start + 500]
            marks = ",".join("?" for _ in chunk)
            for other_id, uid in conn.execute(
                f"SELECT id, message_uid FROM messages WHERE session_id = ? AND message_uid IN ({marks})",
                [session_id, *chunk],
            ):
                other_id = int(other_id)
                if other_id not in unread and (other_id <= watermark or other_id in read):
                    found.update(row_id for row_id in by_uid.get(str(uid), []) if row_id != other_id)
    return found


def _message_keys(conn: sqlite3.Connection, ids: Any) -> dict[int, tuple[str, str]]:
    """Row id -> (chat, message_uid) for the given rows: the identity that survives a compaction rewrite."""
    ids = sorted({int(value) for value in ids})
    if not ids or not _has_message_uid(conn):
        return {}
    keys: dict[int, tuple[str, str]] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" for _ in chunk)
        for row_id, session_id, uid in conn.execute(
            f"SELECT id, session_id, message_uid FROM messages WHERE id IN ({marks})", chunk,
        ):
            if uid:
                keys[int(row_id)] = (str(session_id), str(uid))
    return keys


def _held_keys(conn: sqlite3.Connection, unread: set[int]) -> set[tuple[str, str]]:
    """The messages marked unread by hand, as (chat, message_uid): a compaction copy of one is held unread too."""
    return set(_message_keys(conn, unread).values())


def _is_held(row: sqlite3.Row, unread: set[int], held: set[tuple[str, str]]) -> bool:
    if int(row["id"]) in unread:
        return True
    uid = row["message_uid"] if "message_uid" in row.keys() else None
    return bool(uid) and (str(row["session_id"]), str(uid)) in held


def _read_flags(row: sqlite3.Row, *, watermark: int, read: set[int], unread: set[int],
                held: set[tuple[str, str]], copies: set[int]) -> tuple[bool, bool]:
    """The feed's read rule for one row: (read, marked_unread).

    Marked unread by hand wins; otherwise a row is read when it is at or under the Mark-all watermark, in the read
    list, or a compaction copy of a message read under another id (_read_copies). `held` is _held_keys().
    """
    on_hold = _is_held(row, unread, held)
    row_id = int(row["id"])
    return not on_hold and (row_id <= watermark or row_id in read or row_id in copies), on_hold


def _candidate_rows(conn: sqlite3.Connection, session_ids: list[str], *, before: tuple[float, int] | None = None,
                    id_gt: int | None = None, id_lt: int | None = None, limit: int = 200, by_id: bool = False,
                    asc: bool = False, only_ids: list[int] | None = None) -> list[sqlite3.Row]:
    """The SQL half of chatEntries: only the row shapes that can be a agent bubble, in feed order.

    active/compacted matches the history route's display read (hermes_state_messages._DISPLAY_ACTIVE_CLAUSE:
    "active = 1 OR compacted = 1"), so an undone row is not drawn here either. Excludes intermediate tool-call
    preambles and rows belonging to an active turn lease.
    """
    if not session_ids:
        return []
    marks = ",".join("?" for _ in session_ids)
    now = time.time()
    uid = "m.message_uid" if _has_message_uid(conn) else "NULL AS message_uid"
    # Job results folded into the person's next message (_merged_job_ids) are listed by their originals.
    merged = _merged_job_ids(conn, session_ids)
    folded = f" OR m.id IN ({','.join('?' for _ in merged)})" if merged else ""
    sql = (
        "SELECT m.id, m.session_id, m.role, m.content, m.display_kind, m.display_metadata, m.timestamp, m.finish_reason, m.tool_calls,"
        f" {uid}"
        f" FROM messages m WHERE m.session_id IN ({marks})"
        " AND (((m.active = 1 OR m.compacted = 1)"
        " AND ((m.role = 'assistant' AND COALESCE(m.display_kind, '') NOT IN ('hidden', 'failed_turn')"
        "       AND (m.finish_reason IS NULL OR m.finish_reason != 'tool_calls')"
        "       AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]'))"
        "      OR (m.role = 'user' AND m.display_kind = 'job_delivery')))"
        f"{folded})"
        " AND NOT EXISTS ("
        "     SELECT 1 FROM session_turn_leases stl"
        "     WHERE stl.conversation_id = m.session_id"
        "       AND stl.expires_at > ?"
        "       AND m.timestamp >= stl.acquired_at - 1.0"
        " )"
    )
    params: list[Any] = list(session_ids) + merged + [now]
    if before is not None:
        sql += " AND (m.timestamp < ? OR (m.timestamp = ? AND m.id < ?))"
        params.extend([before[0], before[0], before[1]])
    if id_gt is not None:
        sql += " AND m.id > ?"
        params.append(id_gt)
    if id_lt is not None:
        sql += " AND m.id < ?"
        params.append(id_lt)
    if only_ids is not None:
        if not only_ids:
            return []
        sql += f" AND m.id IN ({','.join('?' for _ in only_ids)})"
        params.extend(only_ids)
    if by_id:
        sql += " ORDER BY m.id ASC" if asc else " ORDER BY m.id DESC"
    else:
        sql += " ORDER BY m.timestamp DESC, m.id DESC"
    sql += " LIMIT ?"
    params.append(limit)
    return conn.execute(sql, params).fetchall()


def _parse_cursor(value: Any) -> tuple[float, int] | None:
    if not isinstance(value, str) or ":" not in value:
        return None
    ts, _, raw_id = value.rpartition(":")
    try:
        return float(ts), int(raw_id)
    except (ValueError, TypeError):
        return None


def _feed_page(conn: sqlite3.Connection, titles: dict[str, str], before: tuple[float, int] | None,
               limit: int, watermark: int = 0, read: set[int] | None = None,
               unread_only: bool = False, unread: set[int] | None = None) -> tuple[list[dict[str, Any]], str | None]:
    """Newest first, paging until `limit` qualifying rows are found or the chat history runs out.

    Every item carries its `read` flag: marked unread on purpose (`unread`) wins; otherwise at or under the Mark-all
    watermark, in the read list, or a compaction copy of a message read under another id (_read_copies). `unread_only`
    is the Unread tab; it also ends the scan once a whole batch of raw rows sits at or under the watermark (unless a
    row under it was marked unread), so it never walks the whole history to fill a page."""
    read = read or set()
    unread = unread or set()
    held = _held_keys(conn, unread)
    marked_below = any(value <= watermark for value in unread)
    items: list[dict[str, Any]] = []
    cursor = before
    exhausted = True
    while len(items) < limit:
        rows = _candidate_rows(conn, list(titles), before=cursor, limit=200)
        if not rows:
            return items, None
        copies = _read_copies(conn, rows, watermark, read, unread)
        for at, row in enumerate(rows):
            item = _inbox_item(row, titles)
            cursor = (float(row["timestamp"] or 0), int(row["id"]))
            if item is not None:
                # Marked unread by hand is held until marked read by hand; otherwise the watermark, the read list or a
                # read compaction copy makes it read. _read_flags is the one place that rule lives (the state route too).
                item["read"], item["marked_unread"] = _read_flags(
                    row, watermark=watermark, read=read, unread=unread, held=held, copies=copies)
            if item is not None and not (unread_only and item["read"]):
                items.append(item)
                if len(items) >= limit:
                    # More raw rows in this batch, or a full batch, may hold older qualifying rows.
                    exhausted = at + 1 >= len(rows) and len(rows) < 200
                    return items, (None if exhausted else f"{cursor[0]}:{cursor[1]}")
        if len(rows) < 200:
            return items, None
        if unread_only and not marked_below and all(int(row["id"]) <= watermark for row in rows):
            return items, None
    return items, None


def _read_inbox_state() -> dict[str, Any]:
    """{"watermark": max id read by Mark all, "read": [ids above it], "unread": [ids marked unread on purpose]}.

    `unread` overrides everything else (the watermark, the read list, a read compaction copy): it is how a person marks
    a message unread again. A bad file reads as an empty tracker."""
    empty = {"watermark": 0, "read": [], "unread": []}
    try:
        data = json.loads(_inbox_read_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty
    except Exception as exc:  # noqa: BLE001 - a bad file means "nothing read", never a broken Inbox
        log.warning("inbox read store unreadable: %s", exc)
        return empty
    if not isinstance(data, dict):
        return empty
    raw_mark = data.get("watermark")
    watermark = int(raw_mark) if isinstance(raw_mark, (int, float)) and not isinstance(raw_mark, bool) and raw_mark > 0 else 0

    def ids(name: str, above: int) -> list[int]:
        raw = data.get(name)
        if not isinstance(raw, list):
            return []
        return sorted({value for value in raw if isinstance(value, int) and not isinstance(value, bool) and value > above})

    return {"watermark": watermark, "read": ids("read", watermark), "unread": ids("unread", 0)}


def _write_inbox_state(data: dict[str, Any]) -> None:
    path = _inbox_read_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def _prune_inbox_state(conn: sqlite3.Connection, data: dict[str, Any]) -> None:
    """Occasionally drop ids whose message no longer exists (a deleted chat), keeping the file small."""
    ids = data.get("read") or []
    if len(ids) <= 1000:
        return
    marks = ",".join("?" for _ in ids)
    try:
        existing = {int(row[0]) for row in conn.execute(f"SELECT id FROM messages WHERE id IN ({marks})", ids)}
    except sqlite3.Error:
        return
    data["read"] = [value for value in ids if value in existing]


def _max_feed_id(conn: sqlite3.Connection, titles: dict[str, str]) -> int:
    """The newest id Mark all can cover: the max id currently in the feed (qualifying rows only)."""
    cursor = None
    while True:
        rows = _candidate_rows(conn, list(titles), id_lt=cursor, limit=500, by_id=True)
        if not rows:
            return 0
        for row in rows:
            if _inbox_item(row, titles) is not None:
                return int(row["id"])
        cursor = int(rows[-1]["id"])  # DESC: the smallest id in the batch, the next batch starts below it


def _unread_count(conn: sqlite3.Connection, titles: dict[str, str], state: dict[str, Any]) -> int:
    """Feed items above the watermark that are not in the read list, nor compaction copies of a read message. Cheap
    enough to poll: the SQL prefilters, and the scan stops at 1000 (past what the 99+ badge ever shows)."""
    watermark = int(state.get("watermark") or 0)
    read = set(state.get("read") or [])
    unread = set(state.get("unread") or [])
    held = _held_keys(conn, unread)
    count = 0
    # Messages under the watermark that were marked unread on purpose; the scan below starts above it.
    below = sorted(value for value in unread if value <= watermark)
    for start in range(0, len(below), 500):
        for row in _candidate_rows(conn, list(titles), only_ids=below[start:start + 500], limit=500, by_id=True):
            if _inbox_item(row, titles) is not None:
                count += 1
    cursor = watermark
    while count < 1000:
        rows = _candidate_rows(conn, list(titles), id_gt=cursor, limit=500, by_id=True, asc=True)
        if not rows:
            break
        copies = _read_copies(conn, rows, watermark, read, unread)
        for row in rows:
            cursor = int(row["id"])
            if _read_flags(row, watermark=watermark, read=read, unread=unread, held=held, copies=copies)[0]:
                continue
            if _inbox_item(row, titles) is None:
                continue
            count += 1
            if count >= 1000:
                break
        if len(rows) < 500:
            break
    return count


@router.get("/inbox")
async def get_inbox(before: str | None = None, limit: int = INBOX_PAGE, unread: int = 0):
    cursor = _parse_cursor(before) if before else None
    if before and cursor is None:
        return JSONResponse({"detail": "before must be a <timestamp>:<id> cursor"}, status_code=400)
    try:
        page_size = max(1, min(int(limit), 100))
    except (TypeError, ValueError):
        page_size = INBOX_PAGE
    try:
        with _INBOX_LOCK:
            state = _read_inbox_state()
        watermark = int(state.get("watermark") or 0)
        read_ids = set(state.get("read") or [])
        conn = _inbox_conn()
        try:
            titles = _scope_titles(conn)
            # ?unread=1: the Unread tab, the same unread rule the badge counts.
            items, next_cursor = _feed_page(conn, titles, cursor, page_size, watermark=watermark, read=read_ids,
                                            unread_only=bool(unread), unread=set(state.get("unread") or []))
        finally:
            conn.close()
    except sqlite3.Error as exc:
        log.warning("inbox read failed: %s", exc)
        return JSONResponse({"detail": "inbox unavailable"}, status_code=503)
    return JSONResponse({"items": items, "next": next_cursor})


@router.get("/inbox/state")
async def get_inbox_state(ids: str = ""):
    """The read state of specific messages, by row id: {"states": {"<id>": {"read": ..., "marked_unread": ...}}}.

    The chat's own action row asks this so a reply held unread shows Mark read instead of Mark unread. The flags come
    from the feed's own rule (_read_flags), so the button and the Inbox can never disagree. Ids that are not an Inbox
    message (deleted, another chat, not a drawn bubble) are simply omitted.
    """
    wanted: list[int] = []
    for part in ids.split(",") if ids else []:
        part = part.strip()
        if not (part.isascii() and part.isdigit()) or int(part) <= 0:
            return JSONResponse({"detail": "ids must be comma-separated whole message ids"}, status_code=400)
        wanted.append(int(part))
    if not wanted:
        return JSONResponse({"detail": "ids must be comma-separated whole message ids"}, status_code=400)
    if len(wanted) > INBOX_MAX_STATE_IDS:
        return JSONResponse({"detail": f"ids must be at most {INBOX_MAX_STATE_IDS} message ids"}, status_code=400)
    wanted = sorted(set(wanted))
    try:
        with _INBOX_LOCK:
            state = _read_inbox_state()
        watermark = int(state.get("watermark") or 0)
        read_ids = set(state.get("read") or [])
        unread = set(state.get("unread") or [])
        conn = _inbox_conn()
        try:
            titles = _scope_titles(conn)
            held = _held_keys(conn, unread)
            rows = _candidate_rows(conn, list(titles), only_ids=wanted, limit=len(wanted), by_id=True)
            copies = _read_copies(conn, rows, watermark, read_ids, unread)
            states: dict[str, dict[str, bool]] = {}
            for row in rows:
                if _inbox_item(row, titles) is None:
                    continue
                read, marked_unread = _read_flags(
                    row, watermark=watermark, read=read_ids, unread=unread, held=held, copies=copies)
                states[str(int(row["id"]))] = {"read": read, "marked_unread": marked_unread}
        finally:
            conn.close()
    except sqlite3.Error as exc:
        log.warning("inbox state read failed: %s", exc)
        return JSONResponse({"detail": "inbox unavailable"}, status_code=503)
    return JSONResponse({"states": states})


@router.get("/merged-jobs")
async def get_merged_jobs(session: str = ""):
    """The chat's folded rows that swallowed a job result, as their originals (see _merged_job_parts)."""
    if not 0 < len(session) <= 200:
        return JSONResponse({"detail": "session must be a chat id"}, status_code=400)
    try:
        conn = _inbox_conn()
        try:
            rows = _merged_job_parts(conn, session)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        log.warning("merged-jobs read failed: %s", exc)
        return JSONResponse({"detail": "history unavailable"}, status_code=503)
    return JSONResponse({"rows": rows})


async def _inbox_ids(request: Request) -> tuple[list[int] | None, bool, JSONResponse | None]:
    """The {"ids": [...], "manual": bool} body of the read and unread routes."""
    body, error = await _json_body(request)
    if error is not None:
        return None, False, error
    assert body is not None
    ids = body.get("ids")
    if not isinstance(ids, list) or len(ids) > INBOX_MAX_POST_IDS:
        return None, False, JSONResponse(
            {"detail": f"ids must be a list of at most {INBOX_MAX_POST_IDS} message ids"}, status_code=400)
    clean: list[int] = []
    for value in ids:
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            return None, False, JSONResponse({"detail": "ids must be whole message ids"}, status_code=400)
        clean.append(value)
    return clean, body.get("manual") is True, None


@router.post("/inbox/read")
async def inbox_mark_read(request: Request):
    clean, manual, error = await _inbox_ids(request)
    if error is not None:
        return error
    assert clean is not None
    try:
        with _INBOX_LOCK:
            state = _read_inbox_state()
            watermark = int(state.get("watermark") or 0)
            read = set(state.get("read") or [])
            unread = set(state.get("unread") or [])
            keys: dict[int, tuple[str, str]] = {}
            conn = None
            try:
                conn = _inbox_conn()
                if unread:
                    keys = _message_keys(conn, unread | set(clean))
            except sqlite3.Error:
                pass  # identity unknown: fall back to row ids below
            held_keys = {keys[value] for value in unread if value in keys}
            # A message marked unread by hand stays unread until it is marked read by hand ("manual": a tap on the
            # Inbox row, the swipe or the hover toggle). Seeing it in the chat does not clear it - nor a compaction
            # copy of it (same chat and message_uid).
            if not manual:
                clean = [value for value in clean if value not in unread and keys.get(value) not in held_keys]
            released = {keys[value] for value in clean if value in keys}
            for value in clean:
                if value > watermark:
                    read.add(value)
            state["read"] = sorted(read)[-INBOX_MAX_READ_IDS:]
            # Marking read releases the message under every row id it has had.
            state["unread"] = sorted(value for value in unread
                                     if value not in set(clean) and keys.get(value) not in released)
            try:
                if conn is not None:
                    _prune_inbox_state(conn, state)
            except sqlite3.Error:
                pass  # the tracker is still correct; pruning retries on a later call
            finally:
                if conn is not None:
                    conn.close()
            _write_inbox_state(state)
    except Exception as exc:  # noqa: BLE001
        log.warning("inbox read save failed: %s", exc)
        return JSONResponse({"detail": "could not save the read marker"}, status_code=500)
    return JSONResponse({"ok": True, "watermark": watermark})


@router.post("/inbox/unread")
async def inbox_mark_unread(request: Request):
    """Marks messages unread again (the Inbox's swipe and hover toggle). Wins over the watermark and read copies, and
    holds until it is marked read by hand ("manual" on /inbox/read: the row tap, the swipe or the hover toggle) or
    by Mark all."""
    clean, _manual, error = await _inbox_ids(request)
    if error is not None:
        return error
    assert clean is not None
    try:
        with _INBOX_LOCK:
            state = _read_inbox_state()
            watermark = int(state.get("watermark") or 0)
            wanted = set(clean)
            state["read"] = [value for value in state.get("read") or [] if value not in wanted]
            state["unread"] = sorted(set(state.get("unread") or []) | wanted)[-INBOX_MAX_POST_IDS:]
            _write_inbox_state(state)
    except Exception as exc:  # noqa: BLE001
        log.warning("inbox unread save failed: %s", exc)
        return JSONResponse({"detail": "could not save the unread marker"}, status_code=500)
    return JSONResponse({"ok": True, "watermark": watermark})


@router.post("/inbox/read-all")
async def inbox_mark_all_read(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    try:
        upto = None
        if body.get("upto") is not None:
            raw = body.get("upto")
            if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
                return JSONResponse({"detail": "upto must be a whole message id"}, status_code=400)
            upto = raw
        if upto is None:
            # The feed's max id needs the database; keep the lock for the small file write only.
            conn = _inbox_conn()
            try:
                upto = _max_feed_id(conn, _scope_titles(conn))
            finally:
                conn.close()
        with _INBOX_LOCK:
            state = _read_inbox_state()
            watermark = max(int(state.get("watermark") or 0), int(upto or 0))
            state["watermark"] = watermark
            state["read"] = [value for value in state.get("read") or [] if value > watermark]
            state["unread"] = [value for value in state.get("unread") or [] if value > watermark]
            _write_inbox_state(state)
    except sqlite3.Error as exc:
        log.warning("inbox read-all failed: %s", exc)
        return JSONResponse({"detail": "inbox unavailable"}, status_code=503)
    except Exception as exc:  # noqa: BLE001
        log.warning("inbox read-all save failed: %s", exc)
        return JSONResponse({"detail": "could not save the read marker"}, status_code=500)
    return JSONResponse({"ok": True, "watermark": watermark})


@router.get("/inbox/unread-count")
async def inbox_unread_count():
    try:
        with _INBOX_LOCK:
            state = _read_inbox_state()
        conn = _inbox_conn()
        try:
            count = _unread_count(conn, _scope_titles(conn), state)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        log.warning("inbox unread count failed: %s", exc)
        return JSONResponse({"detail": "inbox unavailable"}, status_code=503)
    return JSONResponse({"count": count})


# ---------- to-do list ----------
# The app's own list: no external service, one small JSON file shared by every device. Items keep their stored order
# (a new one goes on top), so the client never sorts the open ones. A missing or corrupt file is an empty list, never
# an error, and every write is atomic so a half-written file cannot lose the list.
# An item also carries "indent": 0 (top level) or 1 (a child of the parent above it), one level only, like a Keep
# checklist. A list saved before it existed has no indent and reads as flat.
# A BLOCK is a top-level item plus the indent-1 items directly below it, always stored contiguously.
# A block's section follows its parent: the block is active while the parent is not done, and in Done once it is, so a
# ticked child stays in its active block and no block is ever half in each list. Done blocks keep their stored place
# next to the active ones, which is what puts a reopened block back where it was; the client draws them most recently
# finished first, by the parent's done_at.

MAX_TODO_ITEMS = 500
MAX_TODO_CHARS = 500
_TODOS_LOCK = threading.Lock()


def _todo_indent(value: Any) -> int | None:
    """The clean indent, or None when it is not the integer 0 or 1 (a bool is not an int here)."""
    if isinstance(value, int) and not isinstance(value, bool) and value in (0, 1):
        return value
    return None


def _set_todo_done(item: dict[str, Any], done: bool, stamp: int) -> None:
    """Sets done and its date only when it really changes, so an untouched row keeps its finish time."""
    if item["done"] is done:
        if not done:
            item["done_at"] = None
        return
    item["done"] = done
    item["done_at"] = stamp if done else None


def _todo_blocks(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The stored list split into blocks, in order.

    A child with no parent above it - legacy data, or a parent that has just been deleted - is promoted to a parent, so
    the first active item is always top level and the list always reads as whole contiguous blocks.
    """
    blocks: list[dict[str, Any]] = []
    for item in items:
        if item["indent"] == 1 and blocks:
            blocks[-1]["children"].append(item)
        else:
            item["indent"] = 0
            blocks.append({"parent": item, "children": []})
    return blocks


def _normalise_todos(items: list[dict[str, Any]]) -> None:
    """Block semantics after every stored change.

    The list is always whole contiguous blocks, and a done block always has every child done: ticking a parent ticks
    its children (rule 3) and unticking a child of a done block reopens the parent (rule 5), so Done never shows an
    unticked child. Legacy data - items with no indent, or a done child stored under an open parent - loads into the
    same shape.
    """
    stamp = int(time.time())
    for block in _todo_blocks(items):
        if block["parent"]["done"]:
            for child in block["children"]:
                _set_todo_done(child, True, stamp)


def _todo_active_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every row of the active section, in stored order: active blocks with their children, ticked ones included."""
    return [
        entry
        for block in _todo_blocks(items)
        if not block["parent"]["done"]
        for entry in [block["parent"], *block["children"]]
    ]


def _todo_toggle_rules(items: list[dict[str, Any]], item: dict[str, Any], toggled: bool) -> None:
    """The block's tick rules, in one place, applied after every PATCH.

    1. Ticking a parent ticks all its children; unticking it unticks them all (rules 3 and 4).
    2. A child ticked when it is the last unticked one takes its parent with it (rule 2).
    3. A child unticked in a done block reopens the parent; its siblings keep their state (rule 5).
    4. An indent change can move a row into another block - and when that row is a parent, its children travel with it,
       all staying at indent 1 - so the block it now sits in is checked the same way.
    """
    stamp = int(time.time())
    holder = None
    for block in _todo_blocks(items):
        if block["parent"]["id"] == item["id"] or any(child["id"] == item["id"] for child in block["children"]):
            holder = block
            break
    if holder is None:
        return
    parent, children = holder["parent"], holder["children"]
    if parent["id"] == item["id"]:
        # A parent carries its children with it, ticked or unticked.
        for child in children:
            _set_todo_done(child, parent["done"], stamp)
    elif toggled and not item["done"] and parent["done"]:
        # A child unticked in a done block reopens that block; the other children keep their state.
        _set_todo_done(parent, False, stamp)
    if children and not parent["done"] and all(child["done"] for child in children):
        # The last unticked child has just been ticked: the parent closes with it.
        _set_todo_done(parent, True, stamp)


def _todos_path() -> Path:
    return core.data_file("todos.json")


def _read_todos() -> list[dict[str, Any]]:
    try:
        data = json.loads(_todos_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception as exc:  # noqa: BLE001 - a bad file means "no to-dos", never a broken app
        log.warning("to-do store unreadable: %s", exc)
        return []
    raw_items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(raw_items, list):
        return []
    items: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        item_id = raw.get("id")
        text = raw.get("text")
        # A blank row is a real entry now, so only a missing or non-string text is dropped.
        if not isinstance(item_id, str) or not item_id or not isinstance(text, str):
            continue
        created = raw.get("created")
        done_at = raw.get("done_at")
        items.append({
            "id": item_id[:64],
            "text": text[:MAX_TODO_CHARS],
            "done": raw.get("done") is True,
            "created": int(created) if isinstance(created, (int, float)) and not isinstance(created, bool) else 0,
            "done_at": int(done_at) if isinstance(done_at, (int, float)) and not isinstance(done_at, bool) else None,
            "indent": 1 if _todo_indent(raw.get("indent")) == 1 else 0,
            "tracked": raw.get("tracked") is not False,
        })
    return items[:MAX_TODO_ITEMS]


def _write_todos(items: list[dict[str, Any]]) -> None:
    path = _todos_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}), encoding="utf-8")
    tmp.replace(path)


def _todo_text(value: Any) -> str | None:
    """The clean text, or None when it is not a string of at most 500 characters.

    An empty text is allowed: a blank entry is a real to-do, so "" is kept rather than refused
    or dropped. Only a non-string, or more than 500 characters, is a bad request.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if len(text) <= MAX_TODO_CHARS else None


def _todos_response(items: list[dict[str, Any]]) -> JSONResponse:
    return JSONResponse({"items": items})


@router.get("/todos")
async def get_todos():
    with _TODOS_LOCK:
        items = _read_todos()
        # In memory only: a read never writes, but a legacy file still comes back as whole blocks.
        _normalise_todos(items)
        return _todos_response(items)


@router.post("/todos")
async def add_todo(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    # text "" is a blank entry and is stored like any other; only a missing one, a non-string or
    # more than 500 characters is refused.
    text = _todo_text(body.get("text"))
    if text is None:
        return JSONResponse({"detail": f"text must be a string of at most {MAX_TODO_CHARS} characters"}, status_code=400)
    # An optional index places the new item among the ACTIVE rows, counted from the top: every row of every active
    # block, a ticked child included, so the app can add a row below the one being typed in (Keep-style "+ Add item",
    # Done blocks are skipped over - the new row goes just before the active row at that index,
    # just after the last active row when the index is past the end, and on top when nothing is active. Without an
    # index the new item still goes on top.
    index = body.get("index")
    if "index" in body and (not isinstance(index, int) or isinstance(index, bool) or index < 0):
        return JSONResponse({"detail": "index must be a whole number, 0 or more"}, status_code=400)
    # An optional indent places a typed row under the one above it. It is one level only, and a
    # row that would be the first of the active list is flattened again by the normalise below.
    indent = _todo_indent(body.get("indent", 0))
    if indent is None:
        return JSONResponse({"detail": "indent must be 0 or 1"}, status_code=400)
    tracked = body.get("tracked", True)
    if "tracked" in body and not isinstance(tracked, bool):
        return JSONResponse({"detail": "tracked must be true or false"}, status_code=400)
    try:
        with _TODOS_LOCK:
            items = _read_todos()
            if len(items) >= MAX_TODO_ITEMS:
                return JSONResponse({"detail": "the to-do list is full"}, status_code=409)
            item = {"id": secrets.token_hex(6), "text": text, "done": False,
                    "created": int(time.time()), "done_at": None, "indent": indent, "tracked": tracked}
            active = _todo_active_rows(items) if index is not None else []
            if index is None:
                # Newest on top: the stored order is the display order.
                items.insert(0, item)
            elif index < len(active):
                items.insert(next(at for at, entry in enumerate(items) if entry["id"] == active[index]["id"]), item)
            elif active:
                last = active[-1]["id"]
                items.insert(next(at for at, entry in enumerate(items) if entry["id"] == last) + 1, item)
            else:
                items.insert(0, item)
            _normalise_todos(items)
            _write_todos(items)
    except Exception as exc:  # noqa: BLE001
        log.warning("to-do save failed: %s", exc)
        return JSONResponse({"detail": "could not save the to-do"}, status_code=500)
    # The new row's id rides along, so the app can turn the row it is still typing in into this saved one.
    return JSONResponse({"items": items, "id": item["id"]})


@router.post("/todos/clear-done")
async def clear_done_todos():
    """Removes every done block wholesale: its parent and all its children.

    A ticked child of an active block is NOT cleared - it is still part of its active block (rule 1) - and an active
    parent is never cleared either, whatever its children are.
    """
    try:
        with _TODOS_LOCK:
            items = [
                entry
                for block in _todo_blocks(_read_todos())
                if not block["parent"]["done"]
                for entry in [block["parent"], *block["children"]]
            ]
            _normalise_todos(items)
            _write_todos(items)
    except Exception as exc:  # noqa: BLE001
        log.warning("to-do clear failed: %s", exc)
        return JSONResponse({"detail": "could not clear the done items"}, status_code=500)
    return _todos_response(items)


@router.post("/todos/order")
async def order_todos(request: Request):
    """Reorders the active rows (drag to sort).

    The client sends every row of the active section in the new display order - parents and children alike, a ticked
    child included - and the indents the drag changed. Ids it does not know, and ids of done blocks, are ignored, so an
    older view on one device can never drop, duplicate or un-done a row. Active rows the client leaves out keep their
    previous relative order after the listed ones.

    Done blocks are written after the active rows in their stored order - a rule stated here because it is this
    endpoint's choice: a tick or untick never calls it, so a block coming back from Done still lands where it was
    stored (rule 8), and this one only runs when the user has just dragged something anyway.

    "indents" is applied in the same write as the order, so the two can never disagree.
    """
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    order = body.get("ids")
    if not isinstance(order, list) or len(order) > MAX_TODO_ITEMS:
        return JSONResponse({"detail": f"ids must be a list of at most {MAX_TODO_ITEMS} to-do ids"}, status_code=400)
    seen: set[str] = set()
    for item_id in order:
        if not isinstance(item_id, str) or not 0 < len(item_id) <= 40 or item_id in seen:
            return JSONResponse({"detail": "ids must be unique to-do ids of 1 to 40 characters"}, status_code=400)
        seen.add(item_id)
    indents: dict[str, int] = {}
    raw_indents = body.get("indents")
    if raw_indents is not None and not isinstance(raw_indents, dict):
        return JSONResponse({"detail": "indents must be an object of id to 0 or 1"}, status_code=400)
    if isinstance(raw_indents, dict):
        if len(raw_indents) > MAX_TODO_ITEMS:
            return JSONResponse({"detail": "too many indents"}, status_code=400)
        for key, value in raw_indents.items():
            clean = _todo_indent(value)
            if clean is None:
                return JSONResponse({"detail": "indents must be an object of id to 0 or 1"}, status_code=400)
            indents[str(key)] = clean
    try:
        with _TODOS_LOCK:
            items = _read_todos()
            blocks = _todo_blocks(items)
            active = [entry for block in blocks if not block["parent"]["done"]
                      for entry in [block["parent"], *block["children"]]]
            by_id = {entry["id"]: entry for entry in active}
            listed = [by_id[item_id] for item_id in order if item_id in by_id]
            placed = {entry["id"] for entry in listed}
            active = listed + [entry for entry in active if entry["id"] not in placed]
            done = [entry for block in blocks if block["parent"]["done"]
                    for entry in [block["parent"], *block["children"]]]
            items = active + done
            for entry in active:
                if entry["id"] in indents:
                    entry["indent"] = indents[entry["id"]]
            _normalise_todos(items)
            _write_todos(items)
    except Exception as exc:  # noqa: BLE001
        log.warning("to-do reorder failed: %s", exc)
        return JSONResponse({"detail": "could not save the order"}, status_code=500)
    return _todos_response(items)


@router.patch("/todos/{item_id}")
async def update_todo(item_id: str, request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    text: str | None = None
    if "text" in body:
        # "" empties a row in place; it is stored, not refused or restored.
        text = _todo_text(body.get("text"))
        if text is None:
            return JSONResponse({"detail": f"text must be a string of at most {MAX_TODO_CHARS} characters"}, status_code=400)
    done = body.get("done")
    if "done" in body and not isinstance(done, bool):
        return JSONResponse({"detail": "done must be true or false"}, status_code=400)
    indent: int | None = None
    if "indent" in body:
        indent = _todo_indent(body.get("indent"))
        if indent is None:
            return JSONResponse({"detail": "indent must be 0 or 1"}, status_code=400)
    tracked = body.get("tracked")
    if "tracked" in body and not isinstance(tracked, bool):
        return JSONResponse({"detail": "tracked must be true or false"}, status_code=400)
    try:
        with _TODOS_LOCK:
            items = _read_todos()
            item = next((entry for entry in items if entry["id"] == item_id), None)
            if item is None:
                return JSONResponse({"detail": "no such to-do"}, status_code=404)
            if text is not None:
                item["text"] = text
            if indent is not None:
                item["indent"] = indent
            if isinstance(tracked, bool):
                item["tracked"] = tracked
            toggled = isinstance(done, bool)
            if toggled:
                _set_todo_done(item, done, int(time.time()))
            # The block's rules live in one place, applied after every PATCH.
            _todo_toggle_rules(items, item, toggled)
            _normalise_todos(items)
            _write_todos(items)
    except Exception as exc:  # noqa: BLE001
        log.warning("to-do update failed: %s", exc)
        return JSONResponse({"detail": "could not save the to-do"}, status_code=500)
    return _todos_response(items)


@router.delete("/todos/{item_id}")
async def delete_todo(item_id: str):
    try:
        with _TODOS_LOCK:
            items = _read_todos()
            target = next((item for item in items if item["id"] == item_id), None)
            if target is None:
                return JSONResponse({"detail": "no such to-do"}, status_code=404)
            # Deleting a parent removes its sub-items too.
            drop_ids = {item_id}
            for block in _todo_blocks(items):
                if block["parent"]["id"] == item_id:
                    for child in block["children"]:
                        drop_ids.add(child["id"])
            kept = [item for item in items if item["id"] not in drop_ids]
            _normalise_todos(kept)
            _write_todos(kept)
    except Exception as exc:  # noqa: BLE001
        log.warning("to-do delete failed: %s", exc)
        return JSONResponse({"detail": "could not delete the to-do"}, status_code=500)
    return _todos_response(kept)


# ---------- bookmarks ----------
# Agent replies the person kept, across the app's chats. The store is one small JSON file of ids; every read resolves
# the id against state.db with the Inbox's own rules, so a bookmark whose chat or message is gone is simply left out.
# A missing or corrupt file reads as an empty list, never an error, and every write is atomic.
#
# Context compaction archives every row (active 0, compacted 1: still drawn) and writes the messages it carries forward
# again as new rows: new id, same chat, same message_uid and, since Hermes's display slots, the same display_order, so
# the chat draws the new copy in the original's place (the live row wins its slot). A stored id is therefore read as
# "this message": every route follows it to the row the chat draws now (_drawn_ids), so the list opens the copy, the
# reply's button shows it as kept, and keeping or removing the copy acts on the stored original.

MAX_BOOKMARKS = 500
BOOKMARK_LOOKUP_CHUNK = 200
_BOOKMARKS_LOCK = threading.Lock()


def _bookmarks_path() -> Path:
    return core.data_file("bookmarks.json")


def _read_bookmarks() -> list[dict[str, Any]]:
    try:
        data = json.loads(_bookmarks_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception as exc:  # noqa: BLE001 - a bad file means "no bookmarks", never a broken app
        log.warning("bookmark store unreadable: %s", exc)
        return []
    raw_items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(raw_items, list):
        return []
    items: list[dict[str, Any]] = []
    seen: set[int] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        item_id = raw.get("id")
        if isinstance(item_id, bool) or not isinstance(item_id, int) or item_id <= 0 or item_id in seen:
            continue
        seen.add(item_id)
        session_id = raw.get("session_id")
        added = raw.get("added")
        items.append({
            "id": item_id,
            "session_id": session_id[:200] if isinstance(session_id, str) else "",
            "added": int(added) if isinstance(added, (int, float)) and not isinstance(added, bool) else 0,
        })
    return items[:MAX_BOOKMARKS]


def _write_bookmarks(items: list[dict[str, Any]]) -> None:
    path = _bookmarks_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}), encoding="utf-8")
    tmp.replace(path)


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _drawn_ids(conn: sqlite3.Connection, ids: list[int]) -> dict[int, int]:
    """Stored id -> the id of the row the chat draws for that message now (the id itself unless compaction carried it
    forward). A row archived by compaction (active 0, compacted 1) whose message has a later copy in the same chat and
    the same display slot is drawn as that copy (hermes_state_messages._display_rows_from_conn: active first, then
    highest id). A copy in a slot of its own (older Hermes) is drawn beside the original, so the original keeps its
    id. A schema without message_uid or display_order maps every id to itself."""
    drawn = {item_id: item_id for item_id in ids}
    if not ids or not {"message_uid", "display_order", "active", "compacted"} <= _table_columns(conn, "messages"):
        return drawn
    for start in range(0, len(ids), BOOKMARK_LOOKUP_CHUNK):
        chunk = ids[start:start + BOOKMARK_LOOKUP_CHUNK]
        marks = ",".join("?" for _ in chunk)
        for original, copy in conn.execute(
            "SELECT o.id, ("
            "  SELECT c.id FROM messages c"
            "  WHERE c.session_id = o.session_id AND c.message_uid = o.message_uid"
            "    AND c.display_order = o.display_order AND c.id > o.id AND (c.active = 1 OR c.compacted = 1)"
            "  ORDER BY c.active DESC, c.id DESC LIMIT 1"
            f") FROM messages o WHERE o.id IN ({marks}) AND o.active = 0 AND o.compacted = 1"
            " AND o.message_uid IS NOT NULL AND o.display_order IS NOT NULL",
            chunk,
        ):
            if copy is not None:
                drawn[int(original)] = int(copy)
    return drawn


def _bookmark_items(conn: sqlite3.Connection, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The Inbox item for each stored id that still resolves, in the records' order, plus when it was bookmarked. Each
    item is the row the chat draws now (_drawn_ids); two stored ids that are now one drawn message are listed once."""
    titles = _scope_titles(conn)
    if not titles or not records:
        return []
    drawn = _drawn_ids(conn, [record["id"] for record in records])
    ids = list(dict.fromkeys(drawn[record["id"]] for record in records))
    by_id: dict[int, dict[str, Any]] = {}
    for start in range(0, len(ids), BOOKMARK_LOOKUP_CHUNK):
        chunk = ids[start:start + BOOKMARK_LOOKUP_CHUNK]
        rows = _candidate_rows(conn, list(titles), only_ids=chunk, limit=len(chunk), by_id=True)
        for row in rows:
            item = _inbox_item(row, titles)
            if item is not None:
                by_id[item["id"]] = item
    items: list[dict[str, Any]] = []
    listed: set[int] = set()
    for record in records:
        item = by_id.get(drawn[record["id"]])
        if item is None or item["id"] in listed:
            continue
        listed.add(item["id"])
        items.append({**item, "bookmarked_at": record["added"]})
    return items


def _existing_message_ids(conn: sqlite3.Connection, ids: list[int]) -> set[int]:
    """The ids that still have a row in state.db's messages table (deleting a chat deletes its rows)."""
    found: set[int] = set()
    for start in range(0, len(ids), BOOKMARK_LOOKUP_CHUNK):
        chunk = ids[start:start + BOOKMARK_LOOKUP_CHUNK]
        marks = ",".join("?" for _ in chunk)
        found.update(int(row[0]) for row in conn.execute(f"SELECT id FROM messages WHERE id IN ({marks})", chunk))
    return found


def _prune_bookmarks(dead: set[int]) -> None:
    """Drops bookmarks whose message row is gone for good. Message ids are never reused (AUTOINCREMENT), so a gone row
    cannot come back. Re-read under the lock so a bookmark added meanwhile is kept; a failure only logs."""
    try:
        with _BOOKMARKS_LOCK:
            records = _read_bookmarks()
            kept = [record for record in records if record["id"] not in dead]
            if len(kept) != len(records):
                _write_bookmarks(kept)
    except Exception as exc:  # noqa: BLE001 - tidying the store must never break the list
        log.warning("bookmark prune failed: %s", exc)


@router.get("/bookmarks")
async def get_bookmarks():
    """The bookmarked replies, newest bookmark first.

    A bookmark is shown only while its reply still resolves with the Inbox's rules. One whose message row no longer
    exists at all (its chat or message was deleted) is also removed from the store here, like the Inbox, which keeps
    nothing for a deleted chat. A row that exists but does not resolve (for example a chat outside the app's scope for
    now) is only hidden, never removed, so a passing state can never wipe the list.
    """
    with _BOOKMARKS_LOCK:
        records = _read_bookmarks()
    if not records:
        return JSONResponse({"items": []})
    ordered = sorted(records, key=lambda record: (record["added"], record["id"]), reverse=True)
    try:
        conn = _inbox_conn()
        try:
            items = _bookmark_items(conn, ordered)
            existing = _existing_message_ids(conn, [record["id"] for record in ordered])
        finally:
            conn.close()
    except sqlite3.Error as exc:
        log.warning("bookmarks read failed: %s", exc)
        return JSONResponse({"detail": "bookmarks unavailable"}, status_code=503)
    dead = {record["id"] for record in ordered} - existing
    if dead:
        _prune_bookmarks(dead)
    return JSONResponse({"items": items})


@router.get("/bookmarks/ids")
async def get_bookmark_ids():
    """Every bookmarked id, for the action row's button state: the stored ids plus the rows the chat draws for them
    now (_drawn_ids), so a reply compaction carried forward still shows as kept. Without state.db, the stored ids."""
    with _BOOKMARKS_LOCK:
        records = _read_bookmarks()
    ids = [record["id"] for record in records]
    if ids:
        try:
            conn = _inbox_conn()
            try:
                ids = list(dict.fromkeys([*ids, *_drawn_ids(conn, ids).values()]))
            finally:
                conn.close()
        except sqlite3.Error as exc:
            log.warning("bookmark ids lookup failed: %s", exc)
    return JSONResponse({"ids": ids})


def _kept_as(conn: sqlite3.Connection | None, records: list[dict[str, Any]], item_id: int) -> set[int]:
    """The stored ids that are this message: the id itself, and any stored original the chat now draws as item_id."""
    stored = {record["id"] for record in records}
    found = {item_id} & stored
    if conn is not None and stored:
        found.update(original for original, drawn in _drawn_ids(conn, sorted(stored)).items() if drawn == item_id)
    return found


@router.post("/bookmarks")
async def add_bookmark(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    item_id = body.get("id")
    if isinstance(item_id, bool) or not isinstance(item_id, int) or item_id <= 0:
        return JSONResponse({"detail": "id must be a positive whole message id"}, status_code=400)
    try:
        conn = _inbox_conn()
        try:
            # Already kept, under this id or as the original a compaction copy stands for: nothing to add.
            with _BOOKMARKS_LOCK:
                if _kept_as(conn, _read_bookmarks(), item_id):
                    return JSONResponse({"ok": True, "id": item_id})
            titles = _scope_titles(conn)
            rows = _candidate_rows(conn, list(titles), only_ids=[item_id], limit=1, by_id=True)
            item = next((found for found in (_inbox_item(row, titles) for row in rows) if found is not None), None)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        log.warning("bookmark lookup failed: %s", exc)
        return JSONResponse({"detail": "bookmarks unavailable"}, status_code=503)
    if item is None or item["id"] != item_id:
        return JSONResponse({"detail": "no such reply"}, status_code=404)
    try:
        with _BOOKMARKS_LOCK:
            records = _read_bookmarks()
            if any(record["id"] == item_id for record in records):
                return JSONResponse({"ok": True, "id": item_id})
            if len(records) >= MAX_BOOKMARKS:
                return JSONResponse({"detail": "the bookmark list is full"}, status_code=409)
            records.append({"id": item_id, "session_id": item["session_id"], "added": int(time.time())})
            _write_bookmarks(records)
    except Exception as exc:  # noqa: BLE001
        log.warning("bookmark save failed: %s", exc)
        return JSONResponse({"detail": "could not save the bookmark"}, status_code=500)
    return JSONResponse({"ok": True, "id": item_id})


@router.delete("/bookmarks/{item_id}")
async def delete_bookmark(item_id: int):
    """Removes a bookmark, given its stored id or the id the chat draws it as now (a compaction copy). Unknown ids are
    a no-op: a tap on one already gone is still what the person wanted."""
    try:
        conn = _inbox_conn()
    except sqlite3.Error as exc:
        log.warning("bookmark lookup failed: %s", exc)
        conn = None
    try:
        with _BOOKMARKS_LOCK:
            records = _read_bookmarks()
            try:
                gone = _kept_as(conn, records, item_id)
            except sqlite3.Error as exc:
                log.warning("bookmark lookup failed: %s", exc)
                gone = {item_id}
            kept = [record for record in records if record["id"] not in gone]
            if len(kept) != len(records):
                _write_bookmarks(kept)
    except Exception as exc:  # noqa: BLE001
        log.warning("bookmark delete failed: %s", exc)
        return JSONResponse({"detail": "could not delete the bookmark"}, status_code=500)
    finally:
        if conn is not None:
            conn.close()
    return JSONResponse({"ok": True})


# ---------- activity trees (per-turn narration outlines) ----------
# Stored in data/hermes-mini/activity.json outside Hermes's state.db. Anchor row ids follow replies across context
# compaction through _drawn_ids just like bookmarks; anchor text + timestamps cover bubbles still unindexed at stop.

MAX_ACTIVITY_SESSIONS = 200
MAX_ACTIVITY_TREES_PER_SESSION = 200
MAX_ACTIVITY_STEPS = 60
MAX_ACTIVITY_STR_CHARS = 160
MAX_ACTIVITY_STEP_IMAGES = 8
MAX_ACTIVITY_IMAGE_REF_CHARS = 500
MAX_ACTIVITY_STEP_URLS = 8
MAX_ACTIVITY_URL_CHARS = 500
MAX_ACTIVITY_BODY_BYTES = 48 * 1024
_ACTIVITY_LOCK = threading.Lock()
_VALID_ACTIVITY_STATUSES = {"running", "done", "stopped"}
_ACTIVITY_IMAGE_EXT_RE = re.compile(r"\.(?:png|jpe?g|webp|gif|bmp|avif|svg|ico|tiff?)(?:$|[?#])", re.IGNORECASE)
_ACTIVITY_URL_IGNORED_TOOLS = {
    "web_search",
    "x_search",
    "vision_analyze",
    "session_search",
    "search_files",
    "image_generate",
}
_ACTIVITY_FETCH_HINT_RE = re.compile(
    r"\b(?:curl|wget|fetch|urlopen|urlretrieve|urllib|requests\.(?:get|post|head|request|Session)|httpx\.(?:get|post|head|request|Client|AsyncClient)|aiohttp|http\.client|read_html|read_csv|read_excel|read_json|web_extract|goto_url|new_tab)\b",
    re.IGNORECASE,
)
_ACTIVITY_WIKI_RAW_HOST_RE = re.compile(r"\.(?:wikipedia|wikimedia|wiktionary|wikisource|wikibooks)\.org$", re.IGNORECASE)
_ACTIVITY_SEARCH_API_HOSTS = {
    "api.search.brave.com",
    "api.tavily.com",
    "api.exa.ai",
    "api.firecrawl.dev",
    "api.perplexity.ai",
    "serpapi.com",
    "search.yahoo.com",
}
_ACTIVITY_PACKAGE_MIRROR_HOSTS = {
    "pypi.org",
    "files.pythonhosted.org",
    "registry.npmjs.org",
    "archive.ubuntu.com",
    "security.ubuntu.com",
    "deb.debian.org",
}
_ACTIVITY_SILENCE_MARKERS = {"NO_REPLY", "HEARTBEAT_OK"}


def _is_public_url_host(host: str) -> bool:
    """A host the app may link to: not local, not a private range, and a real domain name."""
    if not host or host == "localhost" or host.endswith((".local", ".internal")):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host:
            return False
    else:
        if not ip.is_global:
            return False
    return True


def _clean_activity_image_ref(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    ref = value.strip()
    if not ref or len(ref) > MAX_ACTIVITY_IMAGE_REF_CHARS or any(ch.isspace() or ord(ch) < 32 for ch in ref):
        return None
    if ref.startswith("file://"):
        ref = ref[7:]
    if ref.startswith("https://"):
        if "{" in ref or "}" in ref:
            return None
        try:
            parsed = urlsplit(ref)
        except ValueError:
            return None
        if parsed.scheme.lower() != "https":
            return None
        if parsed.username or parsed.password:
            return None
        if not _is_public_url_host((parsed.hostname or "").lower().rstrip(".")):
            return None
        return ref
    if ref.startswith(("/", "~/")):
        if _ACTIVITY_IMAGE_EXT_RE.search(ref):
            return ref
        return None
    return None


def _clean_activity_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    ref = value.strip()
    if not ref or len(ref) > MAX_ACTIVITY_URL_CHARS or any(ch.isspace() or ord(ch) < 32 for ch in ref):
        return None
    if "{" in ref or "}" in ref:
        return None
    try:
        parsed = urlsplit(ref)
    except ValueError:
        return None
    if parsed.scheme.lower() not in ("http", "https"):
        return None
    if parsed.username or parsed.password:
        return None
    host = (parsed.hostname or "").lower().rstrip(".")
    if not _is_public_url_host(host):
        return None
    qs = parse_qs(parsed.query or "", keep_blank_values=True)
    if (
        _ACTIVITY_WIKI_RAW_HOST_RE.search(host)
        and (parsed.path or "").lower().endswith("/w/index.php")
        and any(v.lower() == "raw" for v in qs.get("action", []))
    ):
        title = (qs.get("title", [""])[0] or "").strip()
        if not title or len(title) > 300 or any(ch.isspace() or ord(ch) < 32 or ch in "{}" for ch in title):
            return None
        ref = f"https://{host}/wiki/{quote(title.replace(' ', '_'), safe='/:')}"
        if len(ref) > MAX_ACTIVITY_URL_CHARS:
            return None
        try:
            parsed = urlsplit(ref)
        except ValueError:
            return None
        qs = parse_qs(parsed.query or "", keep_blank_values=True)
    path_lower = (parsed.path or "").lower()
    if path_lower == "/api.php" or path_lower.endswith("/api.php") or "action=raw" in (parsed.query or "").lower():
        return None
    bare_host = host[4:] if host.startswith("www.") else host
    if bare_host in _ACTIVITY_SEARCH_API_HOSTS or bare_host in _ACTIVITY_PACKAGE_MIRROR_HOSTS:
        return None
    if (re.search(r"(?:^|\.)google\.[a-z.]+$", bare_host) or re.search(r"(?:^|\.)bing\.com$", bare_host)) and re.match(r"^/search(?:/|$)", path_lower):
        return None
    if re.search(r"(?:^|\.)duckduckgo\.com$", bare_host) and ("q" in qs or re.match(r"^/(?:html|lite)(?:/|$)", path_lower)):
        return None
    return ref


def _norm_activity_match(text: str) -> str:
    return " ".join(str(text or "").split()).lower()[:MAX_ACTIVITY_STR_CHARS].strip()


def _match_prefix_score(hay: str, needle: str) -> bool:
    return bool(hay and needle and (hay.startswith(needle) or needle.startswith(hay)))


def _extract_balanced_call_args(code: str, pattern: str) -> list[str]:
    slices: list[str] = []
    for match in re.finditer(pattern, code):
        i = match.end()
        arg_start = i
        depth = 1
        quote = ""
        triple = False
        n = len(code)
        while i < n and depth > 0:
            ch = code[i]
            if quote:
                if ch == "\\":
                    i += 2
                    continue
                if triple:
                    if code[i : i + 3] == quote * 3:
                        quote = ""
                        triple = False
                        i += 3
                        continue
                elif ch == quote:
                    quote = ""
                i += 1
                continue
            if ch in ("'", '"') and code[i : i + 3] == ch * 3:
                quote = ch
                triple = True
                i += 3
                continue
            if ch in ("'", '"'):
                quote = ch
                triple = False
                i += 1
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        if depth == 0:
            slices.append(code[arg_start : i - 1])
    return slices


def _extract_quoted_urls(snippet: str) -> list[str]:
    return [m.group(2) for m in re.finditer(r"""(["'])(https?://[^"'\r\n\\]+)\1""", snippet or "")]


def _strip_balanced_call_spans(code: str, pattern: str) -> str:
    src = code or ""
    parts: list[str] = []
    last_end = 0
    for match in re.finditer(pattern, src):
        if match.start() < last_end:
            continue
        i = match.end()
        depth = 1
        quote = ""
        triple = False
        n = len(src)
        while i < n and depth > 0:
            ch = src[i]
            if quote:
                if ch == "\\":
                    i += 2
                    continue
                if triple:
                    if src[i : i + 3] == quote * 3:
                        quote = ""
                        triple = False
                        i += 3
                        continue
                elif ch == quote:
                    quote = ""
                i += 1
                continue
            if ch in ("'", '"') and src[i : i + 3] == ch * 3:
                quote = ch
                triple = True
                i += 3
                continue
            if ch in ("'", '"'):
                quote = ch
                triple = False
                i += 1
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        if depth == 0:
            parts.append(src[last_end : match.start()])
            parts.append(" ")
            last_end = i
    parts.append(src[last_end:])
    return "".join(parts)


def _trim_balanced_url(raw: str) -> str:
    u = re.sub(r"""[,;:.!?'"\\]+$""", "", raw or "")
    while True:
        if u.endswith(")") and u.count(")") > u.count("("):
            u = u[:-1]
            continue
        if u.endswith("]") and u.count("]") > u.count("["):
            u = u[:-1]
            continue
        break
    return re.sub(r"""[,;:.!?'"\\]+$""", "", u)


def _extract_fetch_urls_from_text(text: str) -> list[str]:
    if not isinstance(text, str) or not _ACTIVITY_FETCH_HINT_RE.search(text):
        return []
    cleaned = _strip_balanced_call_spans(
        text,
        r"\b(?:web_search|x_search|print|console\.log|warnings\.warn|logging\.(?:debug|info|warning|error))\s*\(",
    )
    cleaned = re.sub(r"^[ \t]*#.*$", " ", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"(?:^|;|&&|\|\|)[ \t]*echo\b[^;&\n]*", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"""(?:^|\s)(?:-A|--user-agent)(?:\s+|=)(["'])[^\n]*?\1""", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"""user-agent(["']?)\s*[:=]\s*(["'])[^\n]*?\2""", " ", cleaned, flags=re.IGNORECASE)
    if not _ACTIVITY_FETCH_HINT_RE.search(cleaned):
        return []
    out: list[str] = []
    for m in re.finditer(r"""https?://[^\s"'`<>\\]+""", cleaned):
        u = _trim_balanced_url(m.group(0))
        if u:
            out.append(u)
    return out


def _extract_web_extract_urls_from_code(code: str) -> list[str]:
    out: list[str] = []
    for sl in _extract_balanced_call_args(code, r"\bweb_extract\s*\("):
        out.extend(_extract_quoted_urls(sl))
        pos = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)", sl)
        kw = re.search(r"(?:^|,)\s*urls\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)", sl)
        var_name = (kw and kw.group(1)) or (pos and pos.group(1))
        if var_name:
            assign_re = re.compile(
                rf"""(?:^|[\n;])\s*{re.escape(var_name)}\s*=\s*(\[[\s\S]*?\]|\([\s\S]*?\)|["']https?://[^"'\r\n]+["'])""",
                re.MULTILINE,
            )
            for am in assign_re.finditer(code):
                out.extend(_extract_quoted_urls(am.group(1)))
    return out


def _parse_tool_result_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    text = raw.strip()
    if text.startswith("<untrusted_tool_result"):
        idx = text.find("{")
        if idx != -1:
            text = text[idx:]
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:  # noqa: BLE001
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            try:
                parsed = json.loads(text[start : end + 1])
                return parsed if isinstance(parsed, dict) else {}
            except Exception:  # noqa: BLE001
                return {}
    return {}


def _extract_tool_images_from_call(args: dict[str, Any], result: dict[str, Any]) -> list[str]:
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    candidates: list[Any] = [
        args.get("image_path"),
        args.get("image_url"),
        result.get("image_path"),
        result.get("screenshot_path"),
        result.get("image"),
        meta.get("image_path"),
        meta.get("screenshot_path"),
    ]
    if isinstance(result.get("images"), list):
        candidates.extend(result["images"])
    out: list[str] = []
    for item in candidates:
        clean = _clean_activity_image_ref(item)
        if clean and clean not in out:
            out.append(clean)
            if len(out) >= MAX_ACTIVITY_STEP_IMAGES:
                break
    return out


def _extract_tool_urls_from_call(name: str, args: dict[str, Any], result: dict[str, Any]) -> list[str]:
    tool = (name or "").strip().lower()
    if tool in _ACTIVITY_URL_IGNORED_TOOLS:
        return []
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    candidates: list[Any] = []
    if tool in ("web_extract", "web_fetch", "fetch_url"):
        candidates.append(args.get("url"))
        if isinstance(args.get("urls"), list):
            candidates.extend(args["urls"])
        candidates.append(result.get("url"))
        if isinstance(result.get("results"), list):
            for item in result["results"]:
                if isinstance(item, dict):
                    candidates.append(item.get("url"))
    elif tool == "browser_exec":
        code = args.get("code")
        if isinstance(code, str):
            for sl in _extract_balanced_call_args(code, r"\b(?:goto_url|new_tab|open_url|navigate)\s*\("):
                candidates.extend(_extract_quoted_urls(sl))
        candidates.extend([args.get("url"), result.get("url"), meta.get("url")])
    elif tool == "browser_cdp":
        method = str(args.get("method") or "").strip()
        if not method or method in ("Page.navigate", "Target.createTarget"):
            params = args.get("params") if isinstance(args.get("params"), dict) else {}
            candidates.extend([args.get("url"), params.get("url"), result.get("url")])
    elif tool in ("browser_navigate", "browser_open"):
        candidates.append(args.get("url"))
        if isinstance(args.get("urls"), list):
            candidates.extend(args["urls"])
        candidates.append(result.get("url"))
    elif tool == "terminal":
        cmd = args.get("command")
        if isinstance(cmd, str):
            candidates.extend(_extract_fetch_urls_from_text(cmd))
    elif tool == "execute_code":
        code = args.get("code")
        if isinstance(code, str):
            candidates.extend(_extract_web_extract_urls_from_code(code))
            candidates.extend(_extract_fetch_urls_from_text(code))
    image_refs = set(_extract_tool_images_from_call(args, result))
    out: list[str] = []
    for item in candidates:
        clean = _clean_activity_url(item)
        if not clean:
            continue
        try:
            if _ACTIVITY_IMAGE_EXT_RE.search(urlsplit(clean).path or ""):
                continue
        except ValueError:
            continue
        if clean not in image_refs and clean not in out:
            out.append(clean)
            if len(out) >= MAX_ACTIVITY_STEP_URLS:
                break
    return out


def _activity_path() -> Path:
    return core.data_file("activity.json")


def _clean_anchor_id(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _normalize_activity_tree(raw: Any, fallback_id: str = "") -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    tree_id = raw.get("id")
    if not isinstance(tree_id, str) or not tree_id.strip():
        tree_id = fallback_id
    tree_id = tree_id.strip()[:120]
    if not tree_id or "/" in tree_id:
        return None
    status = raw.get("status")
    if not isinstance(status, str) or status not in _VALID_ACTIVITY_STATUSES:
        status = "done"
    raw_steps = raw.get("steps")
    raw_step_images = raw.get("step_images")
    raw_step_urls = raw.get("step_urls")
    steps: list[str] = []
    step_images: list[list[str]] = []
    step_urls: list[list[str]] = []
    has_step_images = isinstance(raw_step_images, list)
    has_step_urls = isinstance(raw_step_urls, list)
    if isinstance(raw_steps, list):
        for idx, item in enumerate(raw_steps[:MAX_ACTIVITY_STEPS]):
            if isinstance(item, str):
                cleaned = " ".join(item.split())[:MAX_ACTIVITY_STR_CHARS].strip()
                if cleaned:
                    steps.append(cleaned)
                    if has_step_images:
                        raw_imgs = raw_step_images[idx] if idx < len(raw_step_images) else []
                        imgs: list[str] = []
                        if isinstance(raw_imgs, list):
                            for candidate in raw_imgs:
                                clean_ref = _clean_activity_image_ref(candidate)
                                if clean_ref and clean_ref not in imgs:
                                    imgs.append(clean_ref)
                                    if len(imgs) >= MAX_ACTIVITY_STEP_IMAGES:
                                        break
                        step_images.append(imgs)
                    if has_step_urls:
                        raw_urls = raw_step_urls[idx] if idx < len(raw_step_urls) else []
                        urls: list[str] = []
                        if isinstance(raw_urls, list):
                            for candidate in raw_urls:
                                clean_url = _clean_activity_url(candidate)
                                if clean_url and clean_url not in urls:
                                    urls.append(clean_url)
                                    if len(urls) >= MAX_ACTIVITY_STEP_URLS:
                                        break
                        step_urls.append(urls)
    title = raw.get("title")
    clean_title = " ".join(title.split())[:MAX_ACTIVITY_STR_CHARS].strip() if isinstance(title, str) else ""
    turn_id = raw.get("turn_id")
    clean_turn_id = turn_id.strip()[:120] if isinstance(turn_id, str) else ""
    started = raw.get("started_at")
    ended = raw.get("ended_at")
    started_at = float(started) if isinstance(started, (int, float)) and not isinstance(started, bool) else 0.0
    ended_at = float(ended) if isinstance(ended, (int, float)) and not isinstance(ended, bool) else 0.0
    before_match = raw.get("anchor_before_match")
    after_match = raw.get("anchor_after_match")
    return {
        "id": tree_id,
        "turn_id": clean_turn_id,
        "title": clean_title,
        "steps": steps,
        "step_images": step_images if any(step_images) else [],
        "step_urls": step_urls if any(step_urls) else [],
        "status": status,
        "started_at": started_at,
        "ended_at": ended_at,
        "anchor_before_id": _clean_anchor_id(raw.get("anchor_before_id")),
        "anchor_before_match": (
            " ".join(before_match.lower().split())[:MAX_ACTIVITY_STR_CHARS].strip()
            if isinstance(before_match, str)
            else ""
        ),
        "anchor_after_id": _clean_anchor_id(raw.get("anchor_after_id")),
        "anchor_after_match": (
            " ".join(after_match.lower().split())[:MAX_ACTIVITY_STR_CHARS].strip()
            if isinstance(after_match, str)
            else ""
        ),
    }


def _trim_activity_sessions(sessions: dict[str, list[dict[str, Any]]], *, keep_sid: str = "") -> None:
    if len(sessions) <= MAX_ACTIVITY_SESSIONS:
        return
    protected = {s for s in (_home_id(), keep_sid) if s}
    for key in list(sessions.keys()):
        if len(sessions) <= MAX_ACTIVITY_SESSIONS:
            break
        if key in protected:
            continue
        sessions.pop(key, None)


def _read_activity() -> dict[str, list[dict[str, Any]]]:
    try:
        data = json.loads(_activity_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001
        log.warning("activity store unreadable: %s", exc)
        return {}
    raw_sessions = data.get("sessions") if isinstance(data, dict) else None
    if not isinstance(raw_sessions, dict):
        return {}
    sessions: dict[str, list[dict[str, Any]]] = {}
    for sid, raw_list in raw_sessions.items():
        if not isinstance(sid, str) or not sid.strip() or not isinstance(raw_list, list):
            continue
        trees: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for raw in raw_list[-MAX_ACTIVITY_TREES_PER_SESSION:]:
            norm = _normalize_activity_tree(raw)
            if norm and norm["id"] not in seen_ids:
                seen_ids.add(norm["id"])
                trees.append(norm)
        if trees:
            sessions[sid[:200]] = trees
    _trim_activity_sessions(sessions)
    return sessions


def _write_activity(sessions: dict[str, list[dict[str, Any]]]) -> None:
    path = _activity_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"version": 1, "sessions": sessions}), encoding="utf-8")
    tmp.replace(path)


def _delete_session_activity(session_id: str) -> None:
    if not session_id:
        return
    with _ACTIVITY_LOCK:
        sessions = _read_activity()
        if session_id in sessions:
            sessions.pop(session_id, None)
            _write_activity(sessions)


def _prune_session_activity(
    session_id: str,
    *,
    from_row_id: int | None = None,
    from_ts: float | None = None,
    before_ts: float | None = None,
) -> int:
    if not session_id:
        return 0
    if from_row_id is None and (from_ts is None or from_ts <= 0):
        _delete_session_activity(session_id)
        return 0
    with _ACTIVITY_LOCK:
        snapshot = list(_read_activity().get(session_id, []))
    if not snapshot:
        return 0
    cutoff_ts = float(from_ts) if (from_ts is not None and from_ts > 0) else 0.0
    anchor_ids: list[int] = []
    for tree in snapshot:
        if isinstance(tree.get("anchor_before_id"), int):
            anchor_ids.append(tree["anchor_before_id"])
        if isinstance(tree.get("anchor_after_id"), int):
            anchor_ids.append(tree["anchor_after_id"])
    drawn: dict[int, int] = {}
    if from_row_id is not None or anchor_ids:
        try:
            conn = _inbox_conn()
            try:
                if from_row_id is not None:
                    row = conn.execute(
                        "SELECT timestamp FROM messages WHERE session_id = ? AND id = ?",
                        (session_id, from_row_id),
                    ).fetchone()
                    if row is not None:
                        db_ts = float(row["timestamp"] or 0.0)
                        if db_ts > 0.0:
                            cutoff_ts = min(cutoff_ts, db_ts) if cutoff_ts > 0.0 else db_ts
                if anchor_ids:
                    drawn = _drawn_ids(conn, sorted(set(anchor_ids)))
            finally:
                conn.close()
        except sqlite3.Error as exc:
            log.warning("activity prune lookup failed: %s", exc)

    def _should_prune(tree: dict[str, Any]) -> bool:
        if before_ts is not None and before_ts > 0.0 and float(tree.get("started_at") or 0.0) > before_ts:
            return False
        raw_b = tree.get("anchor_before_id")
        raw_a = tree.get("anchor_after_id")
        b_id = drawn.get(raw_b, raw_b) if isinstance(raw_b, int) else None
        a_id = drawn.get(raw_a, raw_a) if isinstance(raw_a, int) else None
        if from_row_id is not None:
            if (b_id is not None and b_id >= from_row_id) or (a_id is not None and a_id >= from_row_id):
                return True
            if b_id is not None and b_id < from_row_id:
                return False
        if cutoff_ts > 0.0 and float(tree.get("started_at") or 0.0) >= cutoff_ts - 2.0:
            return True
        return False

    with _ACTIVITY_LOCK:
        sessions = _read_activity()
        current = sessions.get(session_id, [])
        if not current:
            return 0
        kept = [tree for tree in current if not _should_prune(tree)]
        removed = len(current) - len(kept)
        if removed > 0:
            if kept:
                sessions[session_id] = kept
            else:
                sessions.pop(session_id, None)
            _write_activity(sessions)
        return removed


def _valid_activity_session(session_id: str) -> str | None:
    clean = str(session_id or "").strip()
    if not clean or len(clean) > 200 or "/" in clean:
        return None
    return clean


def _merge_step_artifacts(existing: list[list[str]], steps: list[str], extra: list[str], limit: int) -> list[list[str]]:
    if not steps:
        return []
    aligned = [list(existing[i])[:limit] if i < len(existing) and isinstance(existing[i], list) else [] for i in range(len(steps))]
    seen = {ref for sublist in aligned for ref in sublist}
    for ref in extra:
        if ref in seen:
            continue
        if len(aligned[-1]) >= limit:
            break
        aligned[-1].append(ref)
        seen.add(ref)
    return aligned if any(aligned) else []


def _is_turn_starting_user_row(row: sqlite3.Row, visible_text: str) -> bool:
    if not visible_text:
        return False
    kind = (row["display_kind"] or "").strip().lower()
    if kind in USER_SKIP_KINDS_SET or kind in {"steer", "job_delivery"}:
        return False
    raw = str(row["content"] or "").strip()
    for text in (visible_text, raw):
        if LEGACY_HEARTBEAT_RE.match(text) or STEER_WRAP_RE.search(text) or text.startswith("[System:"):
            return False
    return True


def _reconcile_running_trees(sid: str, trees: list[dict[str, Any]], conn: sqlite3.Connection) -> list[dict[str, Any]]:
    if not any(t.get("status") == "running" for t in trees):
        return []
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
    except sqlite3.Error:
        return []
    if not {"id", "session_id", "role", "content", "timestamp"}.issubset(cols):
        return []
    opt_cols = [
        "tool_calls" if "tool_calls" in cols else "NULL AS tool_calls",
        "tool_name" if "tool_name" in cols else "NULL AS tool_name",
        "tool_call_id" if "tool_call_id" in cols else "NULL AS tool_call_id",
        "display_kind" if "display_kind" in cols else "NULL AS display_kind",
        "display_metadata" if "display_metadata" in cols else "NULL AS display_metadata",
        "_compressed_summary" if "_compressed_summary" in cols else "0 AS _compressed_summary",
        "active" if "active" in cols else "1 AS active",
        "compacted" if "compacted" in cols else "0 AS compacted",
        "display_order" if "display_order" in cols else "NULL AS display_order",
        "message_uid" if "message_uid" in cols else "NULL AS message_uid",
    ]
    rows_raw = conn.execute(
        f"SELECT id, role, content, timestamp, {', '.join(opt_cols)} FROM messages WHERE session_id = ? ORDER BY id ASC",
        (sid,),
    ).fetchall()
    visible = [
        r
        for r in rows_raw
        if (r["display_kind"] or "").strip().lower() != "hidden"
        and not (r["active"] == 0 and (r["compacted"] or 0) == 0)
        and not _model_only(r["display_metadata"])
    ]

    # A compaction copies earlier messages into new rows in the same display slot: the chat draws one bubble per slot,
    # so collapse each slot to the copy it draws (active first, then highest id) before scanning. Scanning the archived
    # copies as separate rows made a pre-compaction tool run look like a second turn.
    grouped: dict[tuple[str, int], dict[str, Any]] = {}
    for r in visible:
        if r["display_order"] is not None:
            key = ("slot", int(r["display_order"]))
            sort_order = int(r["display_order"])
        else:
            key = ("id", int(r["id"]))
            sort_order = int(r["id"])
        entry = grouped.get(key)
        if entry is None:
            grouped[key] = {"sort_order": sort_order, "members": [r]}
        else:
            entry["members"].append(r)
    slots: list[tuple[int, Any, list[sqlite3.Row]]] = []
    for entry in grouped.values():
        members = entry["members"]
        winner = max(members, key=lambda r: (int(r["active"] or 0), int(r["id"])))
        slots.append((entry["sort_order"], winner, members))
    slots.sort(key=lambda item: (item[0], int(item[1]["id"])))
    rows = [winner for _, winner, _ in slots]
    slot_members = [members for _, _, members in slots]
    if not rows:
        return []

    sorted_starts = sorted(float(t.get("started_at") or 0.0) for t in trees if float(t.get("started_at") or 0.0) > 0.0)
    reconciled: list[dict[str, Any]] = []

    after_ids = {
        int(t["anchor_after_id"])
        for t in trees
        if t.get("status") == "running" and isinstance(t.get("anchor_after_id"), int) and int(t["anchor_after_id"]) > 0
    }
    drawn_after = _drawn_ids(conn, sorted(after_ids)) if after_ids else {}

    for tree in trees:
        if tree.get("status") != "running":
            continue
        started = float(tree.get("started_at") or 0.0)
        next_start = next((s for s in sorted_starts if s > started), None)

        # Find index of preceding bubble (`anchor_after`) so we scan strictly forward from there.
        start_idx = -1
        after_id = tree.get("anchor_after_id")
        if isinstance(after_id, int) and after_id > 0:
            resolved_after = drawn_after.get(after_id, after_id)
            for idx in range(len(rows)):
                if int(rows[idx]["id"]) == resolved_after or any(
                    int(m["id"]) in (after_id, resolved_after) for m in slot_members[idx]
                ):
                    start_idx = idx
                    break
        if start_idx == -1 and tree.get("anchor_after_match"):
            needle = _norm_activity_match(tree["anchor_after_match"])
            best_idx = -1
            best_dist = float("inf")
            for idx, r in enumerate(rows):
                r_ts = float(r["timestamp"] or 0.0)
                if started > 0.0 and r_ts > 0.0 and abs(r_ts - started) > 1800.0:
                    continue
                if _match_prefix_score(_norm_activity_match(_row_text(r)), needle):
                    dist = abs(r_ts - started) if (started > 0.0 and r_ts > 0.0) else 0.0
                    if dist < best_dist:
                        best_dist = dist
                        best_idx = idx
            start_idx = best_idx
        if start_idx == -1 and started > 0.0:
            for idx in range(len(rows) - 1, -1, -1):
                r_ts = float(rows[idx]["timestamp"] or 0.0)
                if r_ts <= started + 2.0:
                    start_idx = idx
                    break

        scan_start = max(0, start_idx + 1)
        boundary_idx = len(rows)
        reply_idx: int | None = None
        failed_idx: int | None = None
        next_user_idx: int | None = None

        for idx in range(scan_start, len(rows)):
            r = rows[idx]
            r_ts = float(r["timestamp"] or 0.0)
            if start_idx == -1 and started > 0.0 and r_ts > 0.0 and r_ts < started - 2.0:
                continue
            if next_start is not None and r_ts > 0.0 and r_ts >= next_start - 1.0:
                boundary_idx = idx
                break
            role = (r["role"] or "").lower()
            if role == "user":
                visible_text = _row_text(r)
                if not _is_turn_starting_user_row(r, visible_text):
                    continue
                next_user_idx = idx
                boundary_idx = idx
                break
            if role == "assistant":
                kind = (r["display_kind"] or "").strip().lower()
                if kind == "failed_turn":
                    failed_idx = idx
                    boundary_idx = idx
                    break
                visible_text = _row_text(r)
                if visible_text and visible_text not in _ACTIVITY_SILENCE_MARKERS and not _is_silence_marker(visible_text):
                    reply_idx = idx
                    boundary_idx = idx
                    break

        if reply_idx is None and failed_idx is None and next_user_idx is None and next_start is None:
            continue

        tool_results_by_id: dict[str, dict[str, Any]] = {}
        for idx in range(scan_start, boundary_idx):
            for m in slot_members[idx]:
                if (m["role"] or "").lower() == "tool" and m["tool_call_id"]:
                    tool_results_by_id[str(m["tool_call_id"])] = _parse_tool_result_dict(m["content"])

        found_images: list[str] = []
        found_urls: list[str] = []
        calls_start = start_idx if start_idx >= 0 else scan_start
        for idx in range(calls_start, boundary_idx):
            for m in slot_members[idx]:
                r_ts = float(m["timestamp"] or 0.0)
                if start_idx == -1 and started > 0.0 and r_ts > 0.0 and r_ts < started - 2.0:
                    continue
                raw_tcalls = m["tool_calls"]
                if not isinstance(raw_tcalls, str) or not raw_tcalls.strip():
                    continue
                try:
                    calls = json.loads(raw_tcalls)
                except Exception:  # noqa: BLE001
                    continue
                if not isinstance(calls, list):
                    continue
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
                    tname = str(fn.get("name") or "")
                    raw_args = fn.get("arguments")
                    targs: dict[str, Any] = {}
                    if isinstance(raw_args, str) and raw_args.strip():
                        try:
                            parsed_args = json.loads(raw_args)
                            if isinstance(parsed_args, dict):
                                targs = parsed_args
                        except Exception:  # noqa: BLE001
                            pass
                    elif isinstance(raw_args, dict):
                        targs = raw_args
                    cid = str(call.get("id") or call.get("call_id") or "")
                    tres = tool_results_by_id.get(cid, {})
                    for img in _extract_tool_images_from_call(targs, tres):
                        if img not in found_images:
                            found_images.append(img)
                    for u in _extract_tool_urls_from_call(tname, targs, tres):
                        if u not in found_urls:
                            found_urls.append(u)

        steps = list(tree.get("steps") or [])
        if not steps and (found_images or found_urls):
            steps = [tree.get("title") or "Completed background steps"]
        tree["steps"] = steps
        tree["step_images"] = _merge_step_artifacts(tree.get("step_images") or [], steps, found_images, MAX_ACTIVITY_STEP_IMAGES)
        tree["step_urls"] = _merge_step_artifacts(tree.get("step_urls") or [], steps, found_urls, MAX_ACTIVITY_STEP_URLS)

        if reply_idx is not None:
            reply_row = rows[reply_idx]
            tree["status"] = "done"
            tree["ended_at"] = float(reply_row["timestamp"] or started or 0.0)
            tree["anchor_before_id"] = int(reply_row["id"])
            tree["anchor_before_match"] = _norm_activity_match(_row_text(reply_row))
        elif failed_idx is not None:
            tree["status"] = "done"
            tree["ended_at"] = float(rows[failed_idx]["timestamp"] or started or 0.0)
            tree["anchor_before_id"] = None
            tree["anchor_before_match"] = ""
        else:
            tree["status"] = "stopped"
            last_ts = started
            if boundary_idx > scan_start:
                last_ts = float(rows[boundary_idx - 1]["timestamp"] or started or 0.0)
            tree["ended_at"] = last_ts

        norm = _normalize_activity_tree(tree, fallback_id=tree.get("id", ""))
        if norm:
            tree.update(norm)
            reconciled.append(dict(norm))

    return reconciled


@router.get("/activity/{session_id}")
async def get_activity(session_id: str):
    sid = _valid_activity_session(session_id)
    if sid is None:
        return JSONResponse({"detail": "invalid session id"}, status_code=400)
    with _ACTIVITY_LOCK:
        trees = [dict(t) for t in _read_activity().get(sid, [])]
    has_running = any(t.get("status") == "running" for t in trees)
    has_anchors = any(
        isinstance(t.get("anchor_before_id"), int) or isinstance(t.get("anchor_after_id"), int)
        for t in trees
    )
    if trees and (has_running or has_anchors):
        try:
            conn = _inbox_conn()
            try:
                if has_running:
                    reconciled = _reconcile_running_trees(sid, trees, conn)
                    if reconciled:
                        by_id = {t["id"]: t for t in reconciled}
                        with _ACTIVITY_LOCK:
                            sessions = _read_activity()
                            stored = sessions.get(sid, [])
                            changed = False
                            for idx, existing in enumerate(stored):
                                eid = existing.get("id")
                                if existing.get("status") == "running" and eid in by_id:
                                    stored[idx] = by_id[eid]
                                    changed = True
                            if changed:
                                sessions[sid] = stored
                                _write_activity(sessions)
                anchor_ids: list[int] = []
                for tree in trees:
                    if isinstance(tree.get("anchor_before_id"), int):
                        anchor_ids.append(tree["anchor_before_id"])
                    if isinstance(tree.get("anchor_after_id"), int):
                        anchor_ids.append(tree["anchor_after_id"])
                if anchor_ids:
                    drawn = _drawn_ids(conn, sorted(set(anchor_ids)))
                    for tree in trees:
                        if isinstance(tree.get("anchor_before_id"), int):
                            tree["anchor_before_id"] = drawn.get(tree["anchor_before_id"], tree["anchor_before_id"])
                        if isinstance(tree.get("anchor_after_id"), int):
                            tree["anchor_after_id"] = drawn.get(tree["anchor_after_id"], tree["anchor_after_id"])
            finally:
                conn.close()
        except sqlite3.Error as exc:
            log.warning("activity reconcile/anchor lookup failed: %s", exc)
    trees.sort(key=lambda t: t.get("started_at") or 0.0)
    return JSONResponse({"trees": trees})


@router.put("/activity/{session_id}/{tree_id}")
async def put_activity_tree(session_id: str, tree_id: str, request: Request):
    sid = _valid_activity_session(session_id)
    tid = tree_id.strip()[:120]
    if sid is None or not tid or "/" in tid:
        return JSONResponse({"detail": "invalid session or tree id"}, status_code=400)
    raw = await request.body()
    if len(raw) > MAX_ACTIVITY_BODY_BYTES:
        return JSONResponse({"detail": "body too large"}, status_code=413)
    try:
        body = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"detail": "invalid json"}, status_code=400)
    record = _normalize_activity_tree(body, fallback_id=tid)
    if record is None:
        return JSONResponse({"detail": "invalid activity tree"}, status_code=400)
    record["id"] = tid
    try:
        with _ACTIVITY_LOCK:
            sessions = _read_activity()
            trees = sessions.get(sid, [])
            replaced = False
            for idx, existing in enumerate(trees):
                if existing.get("id") == tid:
                    # A late "running" save must never roll back a tree the server already closed; a browser tab
                    # resuming after a reload can otherwise resurrect a spinner over a finished outline.
                    if existing.get("status") in ("done", "stopped") and record.get("status") == "running":
                        return JSONResponse({"ok": True, "tree": existing})
                    if existing.get("status") in ("done", "stopped") and record.get("status") == existing.get("status"):
                        for field in ("anchor_before_id", "anchor_before_match", "anchor_after_id", "anchor_after_match"):
                            if not record.get(field) and existing.get(field):
                                record[field] = existing[field]
                        if float(record.get("ended_at") or 0.0) <= 0.0 < float(existing.get("ended_at") or 0.0):
                            record["ended_at"] = existing["ended_at"]
                    trees[idx] = record
                    replaced = True
                    break
            if not replaced:
                trees.append(record)
            trees.sort(key=lambda t: t.get("started_at") or 0.0)
            sessions.pop(sid, None)
            sessions[sid] = trees[-MAX_ACTIVITY_TREES_PER_SESSION:]
            _trim_activity_sessions(sessions, keep_sid=sid)
            _write_activity(sessions)
    except Exception as exc:  # noqa: BLE001
        log.warning("activity write failed: %s", exc)
        return JSONResponse({"detail": "could not save activity"}, status_code=500)
    return JSONResponse({"ok": True, "tree": record})


@router.delete("/activity/{session_id}")
async def delete_activity(
    session_id: str,
    from_row_id: int | None = None,
    from_ts: float | None = None,
    before_ts: float | None = None,
):
    sid = _valid_activity_session(session_id)
    if sid is None:
        return JSONResponse({"detail": "invalid session id"}, status_code=400)
    if from_row_id is not None and from_row_id <= 0:
        return JSONResponse({"detail": "invalid row id"}, status_code=400)
    if from_ts is not None and (math.isnan(from_ts) or math.isinf(from_ts) or from_ts < 0):
        return JSONResponse({"detail": "invalid timestamp"}, status_code=400)
    if before_ts is not None and (math.isnan(before_ts) or math.isinf(before_ts) or before_ts < 0):
        return JSONResponse({"detail": "invalid before timestamp"}, status_code=400)
    try:
        if from_row_id is None and from_ts is None:
            _delete_session_activity(sid)
            return JSONResponse({"ok": True})
        removed = _prune_session_activity(sid, from_row_id=from_row_id, from_ts=from_ts, before_ts=before_ts)
        return JSONResponse({"ok": True, "removed": removed})
    except Exception as exc:  # noqa: BLE001
        log.warning("activity delete failed: %s", exc)
        return JSONResponse({"detail": "could not delete activity"}, status_code=500)


# ---------- search ----------
# One query across the app's chats: chat titles and the visible text of user and assistant messages. Every read comes
# from state.db (read-only) with the chat's own scope and visibility rules (app.js chatEntries + the Inbox's SQL
# prefilter), so a hit is always something the chat draws and always opens. messages_fts is a fast path when the store
# carries it; the LIKE scan underneath is the fallback (an older schema, an FTS5 syntax error, or a mid-word substring
# FTS never indexes as a prefix).

SEARCH_MAX_TOKENS = 6
SEARCH_MAX_CHATS = 10
SEARCH_MAX_LIMIT = 50
SEARCH_SNIPPET_CHARS = 150

# app.js chatEntries(): user-role display_kinds and wrappers that are never drawn as user bubbles.
USER_SKIP_KINDS = (
    "hidden", "failed_turn", "model_switch",
    "internal_notification", "process_complete", "async_delegation_complete",
    "personality_switch", "auto_continue",
)
USER_SKIP_KINDS_SET = frozenset(USER_SKIP_KINDS)
USER_SKIP_KINDS_SQL = ", ".join(f"'{kind}'" for kind in USER_SKIP_KINDS)
LEGACY_HEARTBEAT_RE = re.compile(r"^\[Background process \S+ heartbeat #\d+ ")
STEER_WRAP_RE = re.compile(
    r"\[OUT-OF-BAND USER MESSAGE\b[^\]]*\]\s*([\s\S]*?)\s*\[/OUT-OF-BAND USER MESSAGE\]"
)
ATTACHED_CONTEXT_TAIL_RE = re.compile(r"(?:^|\n)--- Attached Context ---\s*\n[\s\S]*$")
CONTEXT_WARNINGS_TAIL_RE = re.compile(r"(?:^|\n)--- Context Warnings ---[\s\S]*$")
DISCORD_TRIGGERING_NOTE_RE = re.compile(
    r"(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply/react/pin via the discord tools\.\]\n*"
)
IMAGE_REF_RE = re.compile(r"@image:\S+")
FILE_REF_RE = re.compile(r'@file:(?:"[^"\n]+"|\'[^\'\n]+\'|`[^`\n]+`|\S+)')
OTHER_REF_RE = re.compile(r'@(?:folder|url|tool|terminal):(?:"[^"\n]+"|\'[^\'\n]+\'|`[^`\n]+`|\S+)')
SCHEDULE_REF_RE = re.compile(r"\[Schedule: ([^\]\n]+?) · job [\w-]+\]")

# slash.js describeSkillInvocation() / agent/skill_commands.py describe_skill_invocation(): a message sent with skills
# is stored as the expanded skill prompt, and drawn in chat as the skill pills plus the person's own words.
SKILL_PREFIX = "[IMPORTANT: The user has invoked the "
SKILL_NAME_RE = re.compile(r'^\[IMPORTANT: The user has invoked the "([^"]*)"')
SINGLE_SKILL_MARKER = "The full skill content is loaded below.]"
SINGLE_SKILL_INSTRUCTION = "The user has provided the following instruction alongside the skill invocation: "
SKILL_RUNTIME_NOTE = "\n\n[Runtime note:"
BUNDLE_SKILL_MARKER = " skill bundle,"
BUNDLE_SKILL_INSTRUCTION = "\nUser instruction: "
BUNDLE_FIRST_BLOCK = "\n\n[Loaded as part of the "
SKILL_EXCERPT_JOINT = "\x1e"


def _cut_after(content: str, marker: str, stop: str, *, last: bool) -> str | None:
    at = content.rfind(marker) if last else content.find(marker)
    if at < 0:
        return None
    return content[at + len(marker):].split(stop, 1)[0].strip() or None


def _describe_skill_invocation(content: str) -> tuple[list[str], str] | None:
    """(skill names, user text) for a stored skill message, or None (slash.js describeSkillInvocation)."""
    if not isinstance(content, str) or not content.startswith(SKILL_PREFIX):
        return None
    match = SKILL_NAME_RE.match(content)
    name = (match.group(1) if match else "").strip()
    instruction: str | None = None
    if BUNDLE_SKILL_MARKER in content:
        instruction = _cut_after(content, BUNDLE_SKILL_INSTRUCTION, BUNDLE_FIRST_BLOCK, last=False)
    elif SINGLE_SKILL_MARKER in content:
        instruction = _cut_after(content, SINGLE_SKILL_INSTRUCTION, SKILL_RUNTIME_NOTE, last=True)
    text = " ".join(instruction.split(SKILL_EXCERPT_JOINT, 1)[0].split()) if instruction else ""
    if not name:
        names: list[str] = []
    elif name.startswith("/"):
        names = [part.lstrip("/") for part in name.split() if part.lstrip("/")]
    else:
        names = [name]
    if not names and not text:
        return None
    return names, text


def _search_user_text(raw: str) -> str:
    """The text a user-role row draws in a user bubble, or '' when app.js chatEntries skips it."""
    stripped = raw.lstrip()
    if not stripped or stripped.startswith("[System:") or LEGACY_HEARTBEAT_RE.match(stripped):
        return ""
    skill = _describe_skill_invocation(raw)
    text = skill[1] if skill else raw
    text = ATTACHED_CONTEXT_TAIL_RE.sub("", text)
    text = CONTEXT_WARNINGS_TAIL_RE.sub("", text)
    text = DISCORD_TRIGGERING_NOTE_RE.sub(r"\1", text)
    text = IMAGE_REF_RE.sub("", text)
    text = FILE_REF_RE.sub("", text)
    text = OTHER_REF_RE.sub("", text)
    text = STEER_WRAP_RE.sub(r"\1", text)
    text = SCHEDULE_REF_RE.sub(r"\1", text)
    text = core.strip_cron_wrapper(text).strip()
    if skill:
        return " ".join([*(f"/{name}" for name in skill[0]), *([text] if text else [])])
    return text


def _unfold_survivor_user_text(conn: sqlite3.Connection, row: sqlite3.Row) -> str | None:
    """For a folded user row that swallowed a job result (_merged_job_parts), return only the user's own part(s)
    so the job part is listed once under its own original id, not a second time as 'You: [Scheduled job result]…'."""
    if str(row["role"] or "") != "user" or row["display_kind"]:
        return None
    keys = row.keys()
    if "absorbed_message_uids" not in keys or "message_uid" not in keys:
        return None
    raw_absorbed = row["absorbed_message_uids"]
    uid = row["message_uid"]
    if not raw_absorbed or not uid:
        return None
    try:
        absorbed = json.loads(raw_absorbed)
    except (ValueError, TypeError):
        return None
    uids = [uid, *(absorbed if isinstance(absorbed, list) else [])]
    if len(uids) <= 1 or not all(isinstance(item, str) and item for item in uids):
        return None
    originals = _constituent_rows(conn, str(row["session_id"]), uids, int(row["id"]))
    if len(originals) != len(set(uids)):
        return None
    if not any(orig["display_kind"] == "job_delivery" for orig in originals.values()):
        return None
    user_parts: list[str] = []
    for item_uid in dict.fromkeys(uids):
        orig = originals[item_uid]
        content = orig["content"]
        if not isinstance(content, str) or content.startswith("\x00"):
            return None
        if orig["display_kind"] != "job_delivery":
            user_parts.append(content)
    return _unwrap_compaction_summary("\n".join(user_parts))


def _search_snippet(text: str, tokens: list[str]) -> str:
    """~150 chars around the first matching token, with an ellipsis where the text was trimmed."""
    lower = text.lower()
    at = next((lower.find(token) for token in tokens if lower.find(token) >= 0), 0)
    start = max(0, at - (SEARCH_SNIPPET_CHARS // 3))
    end = min(len(text), start + SEARCH_SNIPPET_CHARS)
    start = max(0, end - SEARCH_SNIPPET_CHARS)
    # Prefer whole words at both edges when that does not cut the match itself.
    if start > 0:
        space = text.find(" ", start)
        if 0 <= space < at:
            start = space + 1
    if end < len(text):
        space = text.rfind(" ", at + 1, end)
        if space > at:
            end = space
    snippet = text[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def _search_tokens(q: str) -> list[str]:
    return [token.lower() for token in q.strip().split()][:SEARCH_MAX_TOKENS]


def _search_chats(conn: sqlite3.Connection, titles: dict[str, str], tokens: list[str]) -> list[dict[str, Any]]:
    """The in-scope chats whose display title holds every token, newest activity first (max SEARCH_MAX_CHATS)."""
    columns = _table_columns(conn, "sessions")
    started = "started_at" if "started_at" in columns else "NULL AS started_at"
    active = "last_active" if "last_active" in columns else "NULL AS last_active"
    home = _home_id()
    home_label = core.agent_identity()["home_label"]
    chats: list[dict[str, Any]] = []
    for row in conn.execute(f"SELECT id, title, {started}, {active} FROM sessions"):
        sid = str(row["id"])
        if sid not in titles:
            continue
        is_home = bool(home) and sid == home
        display = home_label if is_home else (str(row["title"] or "") or "Untitled")
        haystack = f"{display}\n{row['title'] or ''}".lower()
        if not all(token in haystack for token in tokens):
            continue
        ts = float(row["last_active"] or row["started_at"] or 0)
        chats.append({"session_id": sid, "title": display, "home": is_home, "ts": ts})
    chats.sort(key=lambda chat: (chat["ts"], chat["session_id"]), reverse=True)
    return chats[:SEARCH_MAX_CHATS]


def _search_visible_text(row: sqlite3.Row, *, raw_override: str | None = None) -> tuple[str, str] | None:
    """(role, plain text) for a row the chat draws as a person or agent message, or None (app.js chatEntries)."""
    role = str(row["role"] or "")
    kind = str(row["display_kind"] or "")
    raw = raw_override if raw_override is not None else _row_text(row)
    display_role = "assistant"
    if role == "user":
        if kind == "job_delivery":
            # Drawn on the agent's side, body without the job header, lifecycle notices skipped.
            body = core.strip_cron_wrapper(JOB_PREFIX.sub("", raw, count=1).strip())
            text = _policy.display_text(body, notice=True)
            if not text or LIFECYCLE_NOTICE.match(text):
                return None
        else:
            if kind in USER_SKIP_KINDS_SET or _model_only(row["display_metadata"]):
                return None
            text = _search_user_text(raw)
            if not text:
                return None
            display_role = "user"
    elif role == "assistant":
        if kind in ("hidden", "failed_turn") or _model_only(row["display_metadata"]):
            return None
        if "finish_reason" in row.keys() and str(row["finish_reason"] or "") == "tool_calls":
            return None
        if "tool_calls" in row.keys():
            calls = row["tool_calls"]
            if calls and str(calls) not in ("", "[]"):
                return None
        text = _policy.display_text(raw)
        if not text or _is_silence_marker(text):
            return None
    else:
        return None  # tool rows, system rows: never drawn
    plain = _search_plain_text(text)
    return (display_role, plain) if plain else None


SEARCH_COLUMNS = ("m.id, m.session_id, m.role, m.content, m.display_kind, m.display_metadata, m.timestamp,"
                   " m.finish_reason, m.tool_calls")


def _search_select_columns(columns: set[str]) -> str:
    extra = [
        "m._compressed_summary" if "_compressed_summary" in columns else "0 AS _compressed_summary",
        "m.message_uid" if "message_uid" in columns else "NULL AS message_uid",
        "m.absorbed_message_uids" if "absorbed_message_uids" in columns else "NULL AS absorbed_message_uids",
    ]
    return f"{SEARCH_COLUMNS}, " + ", ".join(extra)


def _search_visible_sql(conn: sqlite3.Connection, session_ids: list[str],
                        columns: set[str]) -> tuple[str, list[Any]]:
    """The SQL prefilter for rows the chat can draw as a user or assistant bubble (_candidate_rows + user turns)."""
    clauses: list[str] = []
    params: list[Any] = []
    if {"active", "compacted"} <= columns:
        merged = _merged_job_ids(conn, session_ids)
        folded = f" OR m.id IN ({','.join('?' for _ in merged)})" if merged else ""
        clauses.append(f"(m.active = 1 OR m.compacted = 1{folded})")
        params.extend(merged)
    if {"display_kind", "finish_reason", "tool_calls"} <= columns:
        clauses.append(
            "((m.role = 'assistant' AND COALESCE(m.display_kind, '') NOT IN ('hidden', 'failed_turn')"
            "  AND (m.finish_reason IS NULL OR m.finish_reason != 'tool_calls')"
            "  AND (m.tool_calls IS NULL OR m.tool_calls = '' OR m.tool_calls = '[]'))"
            f" OR (m.role = 'user' AND COALESCE(m.display_kind, '') NOT IN ({USER_SKIP_KINDS_SQL})))"
        )
    else:
        clauses.append("m.role IN ('user', 'assistant')")
    return " AND " + " AND ".join(clauses), params


def _search_fts_rows(conn: sqlite3.Connection, session_ids: list[str], tokens: list[str],
                     select_cols: str, visible_sql: str, visible_params: list[Any], over: int) -> list[sqlite3.Row]:
    """The FTS5 fast path, or [] when the store has no messages_fts or the query cannot run."""
    try:
        present = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_fts'").fetchone()
    except sqlite3.Error:
        return []
    if not present:
        return []
    marks = ",".join("?" for _ in session_ids)
    # Every token is a quoted prefix, so punctuation (column_total, v0.2.1, quotes, -) never breaks FTS5 syntax.
    phrase = " AND ".join('"' + token.replace('"', '""') + '"*' for token in tokens)
    try:
        return conn.execute(
            f"SELECT {select_cols} FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid"
            f" WHERE m.session_id IN ({marks}){visible_sql}"
            " AND messages_fts MATCH ? ORDER BY m.timestamp DESC, m.id DESC LIMIT ?",
            [*session_ids, *visible_params, phrase, over],
        ).fetchall()
    except sqlite3.Error as exc:
        log.warning("search: FTS query failed, using LIKE: %s", exc)
        return []


def _search_like_rows(conn: sqlite3.Connection, session_ids: list[str], tokens: list[str],
                      select_cols: str, visible_sql: str, visible_params: list[Any], over: int) -> list[sqlite3.Row]:
    """The plain scan: every token must appear somewhere in the content (the visible-text check follows)."""
    marks = ",".join("?" for _ in session_ids)
    clauses: list[str] = []
    params: list[Any] = [*session_ids, *visible_params]
    for token in tokens:
        needle = token.lstrip("/") or token
        escaped = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        clauses.append("LOWER(m.content) LIKE ? ESCAPE '\\'")
        params.append(f"%{escaped}%")
    return conn.execute(
        f"SELECT {select_cols} FROM messages m WHERE m.session_id IN ({marks}){visible_sql} AND "
        + " AND ".join(clauses) + " ORDER BY m.timestamp DESC, m.id DESC LIMIT ?",
        [*params, over],
    ).fetchall()


def _collect_search_hits(conn: sqlite3.Connection, rows: list[sqlite3.Row], titles: dict[str, str],
                         tokens: list[str], select_cols: str, hits: dict[int, dict[str, Any]]) -> None:
    """Resolve compaction copies and folded job survivors among candidate rows, keeping visible matches in `hits`."""
    if not rows:
        return
    home = _home_id()
    home_label = core.agent_identity()["home_label"]
    ids = [int(row["id"]) for row in rows]
    drawn = _drawn_ids(conn, ids)
    by_id = {int(row["id"]): row for row in rows}
    # A candidate carried forward by compaction is listed as the copy the chat draws, never as both.
    missing = [drawn_id for row_id, drawn_id in drawn.items() if drawn_id != row_id and drawn_id not in by_id]
    for start in range(0, len(missing), BOOKMARK_LOOKUP_CHUNK):
        chunk = missing[start:start + BOOKMARK_LOOKUP_CHUNK]
        marks = ",".join("?" for _ in chunk)
        for row in conn.execute(f"SELECT {select_cols} FROM messages m WHERE m.id IN ({marks})", chunk):
            by_id[int(row["id"])] = row
    for row in rows:
        drawn_id = drawn.get(int(row["id"]), int(row["id"]))
        row = by_id.get(drawn_id)
        if row is None or drawn_id in hits:
            continue
        unfolded = _unfold_survivor_user_text(conn, row)
        visible = _search_visible_text(row, raw_override=unfolded)
        if visible is None:
            continue
        display_role, plain = visible
        lower = plain.lower()
        if not all(token in lower for token in tokens):
            continue
        sid = str(row["session_id"])
        is_home = bool(home) and sid == home
        thread = home_label if is_home else (titles.get(sid) or "Untitled")
        hits[drawn_id] = {
            "id": drawn_id,
            "session_id": sid,
            "thread": thread,
            "home": is_home,
            "role": display_role,
            "ts": float(row["timestamp"] or 0),
            "snippet": _search_snippet(plain, tokens),
        }


def _search_messages(conn: sqlite3.Connection, titles: dict[str, str], tokens: list[str],
                     limit: int) -> list[dict[str, Any]]:
    """Message hits across the in-scope chats, compaction-resolved, deduped and newest first."""
    session_ids = list(titles)
    if not session_ids:
        return []
    columns = _table_columns(conn, "messages")
    select_cols = _search_select_columns(columns)
    visible_sql, visible_params = _search_visible_sql(conn, session_ids, columns)
    over = max(300, limit * 10)
    hits: dict[int, dict[str, Any]] = {}
    fts_rows = _search_fts_rows(conn, session_ids, tokens, select_cols, visible_sql, visible_params, over)
    _collect_search_hits(conn, fts_rows, titles, tokens, select_cols, hits)
    if len(hits) < limit:
        seen = {int(row["id"]) for row in fts_rows}
        like_rows = [row for row in _search_like_rows(
            conn, session_ids, tokens, select_cols, visible_sql, visible_params, over)
            if int(row["id"]) not in seen]
        _collect_search_hits(conn, like_rows, titles, tokens, select_cols, hits)
    items = sorted(hits.values(), key=lambda item: (item["ts"], item["id"]), reverse=True)
    return items[:limit]


@router.get("/search")
async def search(q: str = "", limit: int = 30):
    """Search chat titles and the visible text of user and assistant messages across the app's chats."""
    if not q or not q.strip():
        return JSONResponse({"chats": [], "messages": []})
    try:
        page_size = max(1, min(int(limit), SEARCH_MAX_LIMIT))
    except (TypeError, ValueError):
        page_size = 30
    tokens = _search_tokens(q)
    if not tokens:
        return JSONResponse({"chats": [], "messages": []})
    try:
        conn = _inbox_conn()
        try:
            titles = _scope_titles(conn)
            if not titles:
                return JSONResponse({"chats": [], "messages": []})
            chats = _search_chats(conn, titles, tokens)
            messages = _search_messages(conn, titles, tokens, page_size)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        log.warning("search failed: %s", exc)
        return JSONResponse({"detail": "search unavailable"}, status_code=503)
    return JSONResponse({"chats": chats, "messages": messages})


# ---------- gateway stops and starts (the main chat's restart lines) ----------
# Written by the gateway half (bridge.py) and by this module's restart route for the app's own stop, into this profile's
# data folder; the app draws them in the main chat only.
GATEWAY_EVENTS_PAGE = 50


@router.get("/gateway-events")
async def get_gateway_events():
    return {"events": core.gateway_events()[-GATEWAY_EVENTS_PAGE:]}


# ---------- gateway restart from the app ----------
# The person presses the button themselves (after a confirm), so this is their restart, not the agent's. It runs fully
# detached (own session, short sleep first) so the restarter never kills itself. The Hermes executable and home are
# resolved for this install instead of being hard-coded to one user's paths.
_last_restart = 0.0


def _gateway_state_path() -> Path:
    return core.hermes_home() / "gateway_state.json"


def _gateway_restart_log() -> Path:
    return core.hermes_home() / "logs" / "gateway-restart-app.log"


def _gateway_status() -> dict[str, Any]:
    try:
        data = json.loads(_gateway_state_path().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - no state file means "unknown", the app still shows the confirm
        return {"state": "unknown", "pid": None, "active_agents": 0}
    return {"state": data.get("gateway_state") or "unknown", "pid": data.get("pid"),
            "active_agents": int(data.get("active_agents") or 0)}


@router.get("/gateway/status")
async def gateway_status():
    import os

    # dashboard_pid lets the app see the dashboard itself come back after the restart button.
    return JSONResponse({**_gateway_status(), "dashboard_pid": os.getpid()})


# The button restarts everything: the gateway (forced), then this dashboard, which serves the app and
# runs its chats. The script runs in its own session, so killing the dashboard does not kill it. Dashboard pid lookup and
# relaunch match the documented manual restart (hermes-agent skill).
def _argv_option(flag: str) -> str | None:
    """The value of ``--flag value`` or ``--flag=value`` in this process's argv, if any."""
    argv = sys.argv[1:]
    for index, arg in enumerate(argv):
        if arg == flag:
            return argv[index + 1] if index + 1 < len(argv) else None
        if arg.startswith(flag + "="):
            return arg[len(flag) + 1:]
    return None


def _argv_flag(flag: str) -> bool:
    """Whether this process was started with a bare ``--flag``."""
    return flag in sys.argv[1:]


def _restart_target() -> tuple[str, str]:
    """The dashboard's own bind address, so the relaunch matches how it was started."""
    host = _argv_option("--host") or "127.0.0.1"
    if not re.fullmatch(r"[0-9A-Za-z.:\-]+", host):
        host = "127.0.0.1"
    port = _argv_option("--port") or "9119"
    if not re.fullmatch(r"[0-9]+", port):
        port = "9119"
    return host, port


def _restart_all_command() -> str:
    """Restart the gateway, then the dashboard that serves this app, with resolved paths.

    The executable comes from ``core.find_hermes_executable()`` and the home from Hermes' own
    resolver, so the same code works for any install location and profile.
    """
    import shlex

    host, port = _restart_target()
    executable = core.find_hermes_executable()
    if not executable:
        raise RuntimeError("could not resolve the hermes executable")
    home = str(core.hermes_home())
    # The dashboard is this process: killing its own pid avoids guessing at the launch arguments.
    skip_build = " --skip-build" if _argv_flag("--skip-build") else ""
    return (
        "sleep 3; "
        # --detach returns once the replacement gateway is started; without it the CLI runs the
        # gateway in the foreground and this script never reaches the dashboard step.
        f"{shlex.quote(executable)} gateway restart -y --detach; "
        f"kill {os.getpid()} 2>/dev/null; sleep 3; "
        f"exec {shlex.quote(executable)} dashboard --no-open --port {port} --host {host}{skip_build}"
        # HERMES_HOME travels through the environment set below.
        if home else ""
    )


@router.post("/gateway/restart")
async def gateway_restart():
    import os
    import subprocess
    import time

    global _last_restart
    now = time.time()
    if now - _last_restart < 60:
        return JSONResponse({"detail": "a restart was just requested"}, status_code=429)
    _last_restart = now
    before = _gateway_status()
    try:
        restart_log = _gateway_restart_log()
        restart_log.parent.mkdir(parents=True, exist_ok=True)
        log_fd = os.open(str(restart_log), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            subprocess.Popen(
                # -y: always forced. Without it the CLI asks y/N when anything is live and, with no
                # terminal here, refuses, so the button would silently do nothing mid-turn.
                ["bash", "-c", _restart_all_command()],
                stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, start_new_session=True,
                env={**os.environ, "HERMES_HOME": str(core.hermes_home())}, close_fds=True)
        finally:
            os.close(log_fd)
    except Exception as exc:  # noqa: BLE001
        log.warning("gateway restart failed to start: %s", exc)
        _last_restart = 0.0
        return JSONResponse({"detail": "could not start the restart"}, status_code=500)
    # The main chat's "restarting" line, written now: the restart script waits a few seconds before it stops anything,
    # and it restarts this dashboard too, so the app could not read a stop the gateway records itself until it is all
    # back up. The gateway's own record of the same stop (bridge.py) is then a repeat and is not written twice.
    event = {"ts": time.time(), "kind": "down"}
    try:
        if not core.record_gateway_event("down", ts=event["ts"]):
            event = core.gateway_events()[-1]
    except Exception as exc:  # noqa: BLE001 - a missing line must not fail a restart that is already under way
        log.warning("could not record the restart: %s", exc)
        event = None
    return JSONResponse({"ok": True, "pid_before": before.get("pid"), "dashboard_pid_before": os.getpid(),
                         "event": event})


@router.get("/push/key")
async def push_key():
    """The key the browser subscribes with.

    A key that does not exist yet is reported as ``null``: this route never generates one, so
    merely opening the app cannot create push state. The POST that the person's explicit "turn on"
    action sends generates it.
    """
    try:
        store = _push_store()
        return JSONResponse({"key": store.public_key_b64url(), "available": store.crypto_available()})
    except Exception as exc:  # noqa: BLE001
        log.warning("push key read failed: %s", exc)
        return JSONResponse({"key": None, "available": False, "detail": "push key unavailable"}, status_code=500)


@router.post("/push/key")
async def push_key_create():
    """Generate the VAPID key pair: the explicit opt-in that turning notifications on performs."""
    store = _push_store()
    if not store.crypto_available():
        return JSONResponse({"detail": "notifications need the cryptography package"}, status_code=503)
    try:
        return JSONResponse({"key": store.ensure_public_key_b64url()})
    except Exception as exc:  # noqa: BLE001
        log.warning("push key creation failed: %s", exc)
        return JSONResponse({"detail": "could not create the push key"}, status_code=500)


@router.post("/push/subscribe")
async def push_subscribe(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    subscription = _subscription_from_body(body, request.headers.get("user-agent", ""))
    if subscription is None:
        return JSONResponse({"detail": "invalid subscription"}, status_code=400)
    try:
        _push_store().add_subscription(subscription)
    except Exception as exc:  # noqa: BLE001
        log.warning("push subscribe failed: %s", exc)
        return JSONResponse({"detail": "could not store subscription"}, status_code=500)
    return JSONResponse({"ok": True})


@router.post("/push/unsubscribe")
async def push_unsubscribe(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    endpoint = str(body.get("endpoint") or "").strip()
    if not endpoint:
        return JSONResponse({"detail": "endpoint required"}, status_code=400)
    try:
        _push_store().remove_subscription(endpoint)
    except Exception as exc:  # noqa: BLE001
        log.warning("push unsubscribe failed: %s", exc)
        return JSONResponse({"detail": "could not remove subscription"}, status_code=500)
    return JSONResponse({"ok": True})


@router.post("/push/test")
async def push_test():
    try:
        store = _push_store()
        count = len(store.list_subscriptions())
        store.notify("test", core.agent_identity()["name"], "Notifications are on", "", "test")
        return JSONResponse({"ok": True, "count": count})
    except Exception as exc:  # noqa: BLE001
        log.warning("push test failed: %s", exc)
        return JSONResponse({"ok": False, "count": 0}, status_code=500)


@router.post("/push/approval")
async def push_approval(request: Request):
    """The notification's Approve/Deny buttons land here; it is the same resolution the in-app card uses."""
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    session_key = str(body.get("session_key") or "").strip()
    choice = str(body.get("choice") or "").strip()
    if not session_key or choice not in PUSH_CHOICES:
        return JSONResponse({"detail": "invalid approval"}, status_code=400)
    try:
        from tools.approval import resolve_gateway_approval

        resolved = resolve_gateway_approval(session_key, choice, resolve_all=False)
        return JSONResponse({"ok": bool(resolved)})
    except Exception as exc:  # noqa: BLE001 - an unanswered push is not an error the client should retry
        log.warning("push approval failed: %s", exc)
        return JSONResponse({"ok": False})


@router.get("/push/muted")
async def push_get_muted():
    try:
        store = _push_store()
        return JSONResponse({"muted": store.get_muted_sessions()})
    except Exception as exc:  # noqa: BLE001
        log.warning("push get muted failed: %s", exc)
        return JSONResponse({"muted": []})


@router.post("/push/mute")
async def push_set_mute(request: Request):
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    session_id = str(body.get("session_id") or "").strip()
    if not session_id:
        return JSONResponse({"detail": "session_id is required"}, status_code=400)
    muted = bool(body.get("muted"))
    try:
        store = _push_store()
        muted_list = store.set_muted(session_id, muted)
        return JSONResponse({"ok": True, "session_id": session_id, "muted": muted, "muted": muted_list})
    except Exception as exc:  # noqa: BLE001
        log.warning("push set mute failed: %s", exc)
        return JSONResponse({"detail": "could not update mute state"}, status_code=500)


# ---------- speech dictation (Hermes' configured STT provider) ----------
# The browser records audio and posts it here; this route writes the upload to a private temp file and
# hands it to Hermes' own transcription pipeline (``tools.transcription_tools.transcribe_audio``), so
# whichever STT adapter the user configured — local whisper, a command provider, Groq, OpenAI, Mistral,
# xAI, ElevenLabs, DeepInfra or a plugin provider — is the one that runs. No provider URL or provider
# credential is read or copied here, and a plugin/command provider is reached through the same
# documented dispatch. When no provider is configured the route says so and the microphone is hidden.
MAX_DICTATE_AUDIO_BYTES = 10 * 1024 * 1024
_ALLOWED_AUDIO_SUFFIXES = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
}


def _audio_suffix(content_type: str) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    return _ALLOWED_AUDIO_SUFFIXES.get(ct, ".webm")


def _dictation_unavailable_reason() -> str | None:
    """None when Hermes has a usable STT provider; else a short, non-technical reason.

    Uses the documented resolution path: ``_get_provider`` on the loaded ``stt`` config reports
    ``"none"`` when nothing is configured and never reports a provider it cannot use. This probe is
    passive: it installs nothing and makes no network call.
    """
    try:
        from tools.transcription_tools import _get_provider, _load_stt_config

        if _get_provider(_load_stt_config() or {}) == "none":
            return "No speech-to-text provider is configured yet."
        return None
    except Exception as exc:  # noqa: BLE001 - an unavailable helper means "no dictation", not a crash
        log.info("dictation: provider probe unavailable: %s", exc)
        return "Speech-to-text is not available in this Hermes install."


def _transcribe_sync(path: str) -> dict[str, Any]:
    """Transcribe one upload through Hermes' configured provider, mapping errors to friendly codes."""
    from tools.transcription_tools import transcribe_audio

    result = transcribe_audio(path, source="hermes-mini")
    if result.get("success"):
        return {"ok": True, "text": str(result.get("transcript") or "").strip()}
    error = str(result.get("error") or "Could not transcribe the recording.")
    lowered = error.lower()
    if "no stt provider" in lowered or "no provider" in lowered:
        code = "no_provider"
        message = "No speech-to-text provider is configured yet."
    elif "rate limit" in lowered or "429" in lowered or "quota" in lowered:
        code = "rate_limit"
        message = "The speech service is busy. Try again in a moment."
    elif "api key" in lowered or "unauthor" in lowered or "credential" in lowered or "401" in lowered or "403" in lowered:
        code = "auth"
        message = "The speech service rejected its credentials. Check the STT provider setup in Hermes."
    elif "too large" in lowered or "size" in lowered:
        code = "too_large"
        message = "That recording is too large."
    elif "timed out" in lowered or "timeout" in lowered:
        code = "timeout"
        message = "Transcription timed out — please try again."
    else:
        code = "error"
        message = "Could not transcribe the recording."
    log.warning("dictation failed (%s): %s", code, error[:300])
    return {"ok": False, "code": code, "error": message}


@router.post("/dictate")
async def dictate(request: Request):
    """Transcribe one recorded clip with the provider Hermes is configured to use."""
    temp_path = ""
    try:
        body = await _read_capped(request, MAX_DICTATE_AUDIO_BYTES + 1)
        if body is None:
            return JSONResponse({"ok": False, "code": "too_large", "error": "That recording is too large."})
        if not body or len(body) < 100:
            return JSONResponse({"ok": True, "text": ""})
        content_type = (request.headers.get("content-type") or "audio/webm").split(";")[0].strip().lower()
        if not content_type.startswith("audio/"):
            return JSONResponse({"ok": False, "code": "bad_type", "error": "That upload is not audio."},
                                status_code=415)
        fd, temp_path = tempfile.mkstemp(prefix="hermes-mini-dictate-", suffix=_audio_suffix(content_type))
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
        result = await asyncio.to_thread(_transcribe_sync, temp_path)
        return JSONResponse(result)
    except Exception as exc:  # noqa: BLE001 - dictation must never take the page down
        log.warning("dictation endpoint failed: %s", exc)
        return JSONResponse({"ok": False, "code": "error", "error": "Dictation failed."})
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# First-run identity and app settings
# ---------------------------------------------------------------------------
# Every route below is mounted under Hermes' authenticated /api, so the server's own session cookie is
# the gate: there is no separate credential and no secret is ever sent to the browser.

MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024


async def _read_capped(request: Request, limit: int) -> bytes | None:
    """The request body, or None once it exceeds *limit* (streamed, so an oversize upload is not held)."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _avatar_url(filename: str) -> str:
    return f"/api/plugins/hermes-mini/avatar/{quote(filename, safe='')}" if filename else ""


def _identity_payload() -> dict[str, Any]:
    identity = core.agent_identity()
    settings = core.load_settings()
    avatar_file = settings["agent"]["avatar"]
    return {
        "product": core.PRODUCT_NAME,
        "name": identity["name"],
        # Where the name came from, so a caller can explain it.
        "name_source": identity["source"],
        # An uploaded picture wins; otherwise use the picture Hermes already has for this bot.
        "avatar_url": _avatar_url(avatar_file) if avatar_file else core.hermes_avatar_data_url(),
        "home_label": identity["home_label"],
        "onboarding_complete": settings["onboarding"]["complete"],
        "saved_name": settings["agent"]["name"],
        "has_custom_avatar": bool(avatar_file),
        # The Hermes profile the name and picture are read from: the one the editor saves to.
        "profile": core.identity_profile(),
    }


@router.get("/provider-key-fields")
def provider_key_fields():
    """Expose only the key field names accepted by Hermes's model.save_key."""
    from hermes_cli.auth import PROVIDER_REGISTRY

    return {
        "providers": {
            slug: provider.api_key_env_vars[0]
            for slug, provider in PROVIDER_REGISTRY.items()
            if provider.auth_type == "api_key" and provider.api_key_env_vars
        },
    }


@router.get("/identity")
async def get_identity():
    """The agent name and picture for this profile. A pure read: creates no file or directory."""
    try:
        return JSONResponse(_identity_payload())
    except Exception as exc:  # noqa: BLE001 - the page must still render
        log.warning("identity read failed: %s", exc)
        return JSONResponse({"product": core.PRODUCT_NAME, "name": core.FALLBACK_AGENT_NAME,
                             "name_source": "default", "avatar_url": "", "home_label": core.FALLBACK_AGENT_NAME,
                             "onboarding_complete": False}, status_code=200)


@router.post("/identity")
async def save_identity(request: Request):
    """Persist the user's confirmed name and their own picture.

    Called only from an explicit save request, never on a page load. The picture is sent as the raw
    image body with its media type; ``?name=`` carries the confirmed name so the body stays a single
    image and large uploads are still streamed.
    """
    existing = core.load_settings()
    name = request.query_params.get("name")
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    avatar_bytes: bytes | None = None
    if content_type.startswith("image/"):
        body = await _read_capped(request, MAX_AVATAR_UPLOAD_BYTES)
        if body is None:
            return JSONResponse({"detail": "That image is too large."}, status_code=413)
        avatar_bytes = body
    elif content_type == "application/json":
        raw = await _read_capped(request, 64 * 1024)
        if raw is None:
            return JSONResponse({"detail": "body too large"}, status_code=413)
        try:
            payload = json.loads(raw or b"{}")
        except (ValueError, UnicodeDecodeError):
            return JSONResponse({"detail": "invalid json"}, status_code=400)
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "invalid json"}, status_code=400)
        if name is None and isinstance(payload.get("name"), str):
            name = payload["name"]

    final_name = core.clean_name(name) if name is not None else existing["agent"]["name"]
    if not final_name:
        final_name = core.identity_from_hermes()[0]
    # Changing only the name keeps the saved picture; saving setup requires the person's own picture
    # only when they are completing first-run setup, which the client tells us with ?complete=1.
    completing = request.query_params.get("complete") in ("1", "true", "yes")
    try:
        core.save_identity(final_name, avatar_bytes, complete=completing or existing["onboarding"]["complete"])
    except ValueError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    except OSError as exc:
        log.warning("identity save failed: %s", exc)
        return JSONResponse({"detail": "Could not save your settings."}, status_code=500)
    return JSONResponse(_identity_payload())


@router.post("/identity/forget-upload")
async def forget_uploaded_avatar():
    """After a new picture is saved through Hermes, stop showing one uploaded through the app's old setup."""
    try:
        removed = core.forget_uploaded_avatar()
    except OSError as exc:
        log.warning("forget uploaded picture failed: %s", exc)
        return JSONResponse({"detail": "Could not update your settings."}, status_code=500)
    return JSONResponse({"removed": removed, **_identity_payload()})


@router.get("/avatar/{filename}")
async def get_avatar(filename: str):
    """Serve this profile's uploaded picture from the external assets directory."""
    name = Path(filename).name
    if not name or name != filename or not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", name):
        return JSONResponse({"detail": "not found"}, status_code=404)
    path = core.assets_dir() / name
    try:
        resolved = path.resolve()
        resolved.relative_to(core.assets_dir().resolve())
    except (OSError, ValueError):
        return JSONResponse({"detail": "not found"}, status_code=404)
    if not resolved.is_file():
        return JSONResponse({"detail": "not found"}, status_code=404)
    suffix = resolved.suffix.lower()
    media = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}.get(suffix)
    if media is None:
        return JSONResponse({"detail": "not found"}, status_code=404)
    return FileResponse(resolved, media_type=media,
                        headers={"Cache-Control": "private, max-age=300"})


AUDIO_EXTENSIONS = frozenset({".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac"})
AUDIO_BARS = 40
_AUDIO_RATE = 2000  # Hz: enough for a waveform's shape, small enough to decode an hour in a few seconds
_AUDIO_MAX_BYTES = 1 << 30
_audio_meta_cache: dict[tuple[str, int, int, int], dict[str, Any]] = {}
_audio_meta_lock = threading.Lock()


def _ffmpeg_binary() -> str | None:
    """ffmpeg on PATH, else the copy Hermes installs under its own tools directory: ``bin/ffmpeg`` on Linux,
    ``bin/ffmpeg.exe`` on Windows, a bare ``ffmpeg`` at the package root on macOS. Newest version first."""
    import shutil

    found = shutil.which("ffmpeg")
    if found:
        return found
    tools = core.hermes_home() / "tools"
    for package in sorted(tools.glob("ffmpeg-*"), reverse=True):
        for rel in ("bin/ffmpeg", "bin/ffmpeg.exe", "ffmpeg"):
            candidate = package / rel
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def _audio_target(raw: str) -> Path | None:
    """The audio file a MEDIA: tag names: absolute or ~/, a regular file, an audio extension."""
    value = str(raw or "").strip()
    if value.startswith("~/"):
        value = str(Path.home() / value[2:])
    if not value.startswith("/") or "\0" in value:
        return None
    try:
        target = Path(value).resolve()
    except (OSError, RuntimeError):
        return None
    if target.suffix.lower() not in AUDIO_EXTENSIONS or not target.is_file():
        return None
    return target


def audio_peaks(samples: "array", bars: int) -> list[float]:
    """*bars* heights in 0..1 from 16-bit mono samples: each bucket's loudness (RMS), stretched between the
    quietest and loudest bucket. A long recording's raw loudness is nearly flat bucket to bucket, so the stretch is
    what makes its real variation visible; the quietest bar still shows at 0.2."""
    import math

    if not samples:
        return [0.0] * bars
    sumprod = getattr(math, "sumprod", None) or (lambda a, b: sum(x * y for x, y in zip(a, b)))  # 3.12+ is fast
    step = len(samples) / bars
    levels = []
    for i in range(bars):
        chunk = samples[int(i * step):max(int((i + 1) * step), int(i * step) + 1)]
        levels.append(math.sqrt(sumprod(chunk, chunk) / len(chunk)) if chunk else 0.0)
    lo, hi = min(levels), max(levels)
    if hi <= 0:
        return [0.0] * bars
    if hi - lo < hi * 1e-6:
        return [1.0] * bars
    return [round(0.2 + 0.8 * (level - lo) / (hi - lo), 3) for level in levels]


def _audio_meta(target: Path) -> dict[str, Any]:
    from array import array

    st = target.stat()
    key = (str(target), st.st_mtime_ns, st.st_size, AUDIO_BARS)
    with _audio_meta_lock:
        if key in _audio_meta_cache:
            return _audio_meta_cache[key]
    if st.st_size > _AUDIO_MAX_BYTES:
        raise ValueError("too large")
    binary = _ffmpeg_binary()
    if binary is None:
        raise FileNotFoundError("ffmpeg")
    done = subprocess.run(
        [binary, "-v", "error", "-nostdin", "-i", str(target), "-vn", "-ac", "1", "-ar", str(_AUDIO_RATE),
         "-f", "s16le", "-"],
        capture_output=True, timeout=90, check=False,
    )
    if done.returncode != 0 or not done.stdout:
        raise ValueError("undecodable")
    samples = array("h")
    samples.frombytes(done.stdout[: len(done.stdout) // 2 * 2])
    if sys.byteorder != "little":
        samples.byteswap()
    meta = {"duration": round(len(samples) / _AUDIO_RATE, 2), "peaks": audio_peaks(samples, AUDIO_BARS)}
    with _audio_meta_lock:
        if len(_audio_meta_cache) > 64:
            _audio_meta_cache.clear()
        _audio_meta_cache[key] = meta
    return meta


@router.get("/audio-meta")
async def get_audio_meta(path: str):
    """Duration and a small waveform for an audio file a reply attached, so the player draws before it loads."""
    target = _audio_target(path)
    if target is None:
        return JSONResponse({"detail": "Audio file not found"}, status_code=404)
    try:
        meta = await asyncio.to_thread(_audio_meta, target)
    except FileNotFoundError:
        return JSONResponse({"detail": "ffmpeg is not installed"}, status_code=503)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return JSONResponse({"detail": "Could not read that audio file"}, status_code=422)
    return JSONResponse(meta, headers={"Cache-Control": "private, max-age=3600"})


@router.get("/settings")
async def get_settings():
    """The app's own external settings (no secrets are stored in this file)."""
    settings = core.load_settings()
    return JSONResponse({
        "agent_name": settings["agent"]["name"],
        "home_label": settings["agent"]["home_label"],
        "public_url": settings["server"]["public_url"],
        "push_contact": settings["push"]["contact"],
        "config_path": str(core.config_path()),
        "schema": settings["schema"],
    })


@router.post("/settings")
async def put_settings(request: Request):
    """Change the optional app settings (home label, public URL, push contact)."""
    body, error = await _json_body(request)
    if error is not None:
        return error
    assert body is not None
    settings = core.load_settings()
    if "home_label" in body:
        settings["agent"]["home_label"] = core.clean_name(body.get("home_label"))
    if "public_url" in body:
        raw = str(body.get("public_url") or "").strip()
        cleaned = core.clean_public_url(raw)
        if raw and not cleaned:
            return JSONResponse({"detail": "Use an http(s) URL."}, status_code=400)
        settings["server"]["public_url"] = cleaned
    if "push_contact" in body:
        raw = str(body.get("push_contact") or "").strip()
        cleaned = core.clean_public_url(raw)
        if raw and not cleaned:
            return JSONResponse({"detail": "Use an http(s) URL."}, status_code=400)
        settings["push"]["contact"] = cleaned
    try:
        core.save_settings(settings)
    except OSError as exc:
        log.warning("settings save failed: %s", exc)
        return JSONResponse({"detail": "Could not save settings."}, status_code=500)
    return await get_settings()


# ---------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------
# One authenticated route that answers only booleans, so the page can hide a control that would be a
# dead button. It never returns a key, a path or a config value. A probe failure keeps today's UI
# (controls visible) rather than hiding something that might work; the server always enforces access.


def _desktop_prerequisites() -> bool:
    """Whether Hermes' Bot Desktop can be shown here (installed and supported, running or startable)."""
    try:
        from tools.bot_desktop import runtime

        status = runtime.status()
        if not getattr(status, "supported", False) or not getattr(status, "installed", False):
            return False
        # Starting a desktop is the viewer's own on-demand action; a blocker means it could not start.
        return getattr(status, "blocker", None) is None
    except Exception as exc:  # noqa: BLE001 - an absent optional module means "no computer"
        log.debug("capability: desktop status unavailable: %s", exc)
        return False


def _capabilities() -> dict[str, bool]:
    push_ok = False
    try:
        store = _push_store()
        push_ok = store.crypto_available() and store.httpx_available()
    except Exception:  # noqa: BLE001
        push_ok = False
    return {
        "computer": _desktop_prerequisites(),
        "push": push_ok,
        "dictation": _dictation_unavailable_reason() is None,
        "model_configured": core.model_configured(),
    }


@router.get("/capabilities")
async def capabilities():
    """Booleans only: computer, push, dictation and whether a model is configured."""
    try:
        return JSONResponse(_capabilities())
    except Exception as exc:  # noqa: BLE001 - a failed probe must not break the page
        log.warning("capabilities probe failed: %s", exc)
        return JSONResponse({"computer": True, "push": True, "dictation": True, "model_configured": True},
                            status_code=200)


def _ensure_home_target() -> None:
    """Record the main chat as this platform's default delivery chat, once.

    Hermes resolves a bare ``deliver: hermes-mini`` through the platform's home channel, and only
    the install's own config holds one. Writing it here means nobody sets it by hand and a fresh
    clone gets it the first time the app loads. An existing value always wins; a read-only home or a
    missing helper only logs, never breaks the app.
    """
    try:
        from hermes_cli.config import load_config, save_config

        config = load_config()
        block = config.setdefault("platforms", {}).setdefault(core.PLUGIN_ID, {})
        if block.get("home_channel"):
            return
        block["home_channel"] = {
            "platform": core.PLUGIN_ID,
            "chat_id": "main",
            "name": "Hermes Mini main chat",
        }
        block.setdefault("enabled", True)
        save_config(config)
        log.info("hermes-mini: recorded the main chat as the default delivery target")
    except Exception:  # noqa: BLE001 - the app must load even if the config cannot be written
        log.warning("hermes-mini: could not record the default delivery target", exc_info=True)


@router.get("/status")
async def status():
    """What the app needs at load: identity, capabilities and how to finish Hermes setup."""
    _ensure_home_target()
    payload = _identity_payload()
    try:
        caps = _capabilities()
    except Exception:  # noqa: BLE001
        caps = {"computer": True, "push": True, "dictation": True, "model_configured": True}
    return JSONResponse({
        **payload,
        "features": caps,
        "config_dir": str(core.app_dir()),
        "data_dir": str(core.data_dir()),
    })


# ---------------------------------------------------------------------------
# Optional computer module routes
# ---------------------------------------------------------------------------
# Mounted under /api/plugins/hermes-mini/computer/ so the bundled viewer's clipboard verbs resolve
# inside this one plugin. Importing this module is cheap: the desktop runtime is imported inside the
# handlers, so merely loading the app never touches a desktop.
def _mount_computer_routes() -> None:
    import importlib.util
    import sys

    name = "hermes_mini_computer_api"
    module = sys.modules.get(name)
    if module is None:
        path = Path(__file__).resolve().parent / "computer_api.py"
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            log.warning("computer module: cannot load %s", path)
            return
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:  # noqa: BLE001 - a broken optional module must not break the app
            sys.modules.pop(name, None)
            log.warning("computer module: failed to load", exc_info=True)
            return
    sub = getattr(module, "router", None)
    if sub is not None:
        router.include_router(sub, prefix="/computer")


_mount_computer_routes()
