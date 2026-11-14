"""Hermes Mini app backend — mounted at /api/plugins/hermes-mini/.

The chat itself rides Hermes' own authenticated ``/api/ws`` and REST routes; this router adds the
app's own data (to-dos, pins, seen markers, inbox read state), first-run identity, capability
advertisement, live narration, Web Push and dictation. It also records the app's main chat as the
platform's default scheduled-job delivery target once, so a bare ``hermes-mini`` address has a
destination. The dashboard's dashboard-auth dependency is
attached by ``web_server_dashboard._mount_one_plugin_api`` (the same cookie auth as the rest of
``/api``), so this file only has to be a FastAPI ``router``.

Every path is resolved per call from Hermes' own home resolver (``mini_core``), so the package is
never written to and the active profile decides where data lives.

It must never break the chat: narration failures answer ``{"line": null}`` and log a warning.
"""

from __future__ import annotations

import asyncio
import json
import logging
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
from urllib.parse import quote, urlsplit

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
MAX_EVENTS = 12
MAX_REQUEST_CHARS = 300
MAX_ARG_CHARS = 200
MAX_THINKING_CHARS = 400
MAX_LINE_CHARS = 90


def _narration_system_prompt() -> str:
    return (
        f"You narrate, for a non-technical person, what their assistant {core.agent_identity()['name']} is doing right now. "
        "Write ONE short line, at most 10 words, present continuous, ending with an ellipsis, warm and "
        "plain (e.g. 'Comparing tonight's prices with your last statement…'). No tool names, code, file "
        "paths, IDs or jargon. Say only what the activity shows; never invent results or numbers. Don't "
        "repeat the previous lines; describe the newest step. Output only the line."
    )


NARRATION_PROVIDER = None
NARRATION_MODEL = None
NARRATION_MAX_TOKENS = 80
NARRATION_TIMEOUT = 8.0
NARRATION_REASONING = {"enabled": True, "effort": "low"}

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


@router.post("/narrate")
async def narrate(request: Request):
    try:
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            log.warning("narrate: body too large (%d bytes)", len(raw))
            return _null(413)
        try:
            body = json.loads(raw or b"{}")
        except (ValueError, UnicodeDecodeError):
            return _null(400)
        if not isinstance(body, dict):
            return _null(400)

        events = body.get("events")
        has_events = isinstance(events, list) and any(isinstance(e, dict) and (e.get("name") or e.get("text")) for e in events)
        if not has_events:
            return _null()  # nothing new to narrate: no model call

        from agent.auxiliary_client import async_call_llm

        response = await async_call_llm(
            task="hermes_mini_narration",
            provider=NARRATION_PROVIDER,
            model=NARRATION_MODEL,
            messages=[
                {"role": "system", "content": _narration_system_prompt()},
                {"role": "user", "content": _build_user_message(body)},
            ],
            temperature=None,
            max_tokens=NARRATION_MAX_TOKENS,
            timeout=NARRATION_TIMEOUT,
            reasoning_config=NARRATION_REASONING,
        )
        content = response.choices[0].message.content
        line = _clean_line(content)
        if not line:
            log.warning("narrate: model returned no usable line")
            return _null()
        return JSONResponse({"line": line})
    except Exception as exc:  # noqa: BLE001 - narration must never surface as an error to the client
        log.warning("narrate failed: %s", exc)
        return _null()


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
        _app_chats().set_home("")
    except Exception as exc:  # noqa: BLE001
        log.warning("app-chats home clear failed: %s", exc)
        return JSONResponse({"detail": "registry unavailable"}, status_code=503)
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
    return {"since": int(since) if isinstance(since, (int, float)) and not isinstance(since, bool) else 0, "seen": seen}


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
            data = {"since": int(time.time()), "seen": {}}
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
                data = {"since": now, "seen": {}}
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


# ---------- Inbox ----------
# One feed of every agent bubble the app draws, across the chats it lists. The Inbox stores no messages of its own:
# every read comes from state.db (read-only), so deleting a chat makes its rows disappear and nothing is unopenable.
# What it DOES store is identity and read state only (message ids), in its own file - never text - so the drawer's
# unread markers (seen.json) and this tracker stay independent.


INBOX_PAGE = 50
INBOX_MAX_TEXT = 400
INBOX_MAX_READ_IDS = 50000
INBOX_MAX_POST_IDS = 1000
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
    """The same read-only handle style app_chats.py uses; no other code shares it."""
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


def _row_text(row: sqlite3.Row) -> str:
    """app.js chatEntries(): display_content wins, else the decoded content, trimmed.

    The stored row has no display_content column; the REST projection adds it only for steers and compaction
    carriers, which are not assistant bubbles here. So the raw content IS the drawn text for every row in scope.
    """
    raw = row["content"]
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8", "replace")
    text = _content_text(raw) if isinstance(raw, (str, list)) else ("" if raw is None else str(raw))
    if isinstance(text, str) and text[:1] in ("[", "{"):
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, (list, dict)):
            text = _content_text(parsed)
    return text.strip()


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


def _plain_text(text: str) -> str:
    """Markdown stripped, whitespace collapsed; an inline image becomes "Photo"."""
    value = IMAGE_MD_RE.sub(" Photo ", str(text or ""))
    value = MEDIA_PATH_RE.sub(" Photo ", value)
    value = LINK_MD_RE.sub(r"\1", value)
    value = re.sub(r"```[^\n]*", "", value)  # fences, keeping their contents
    value = re.sub(r"[*_`>#~|]+", "", value)  # bridge.py _plain's set, and the app's markdown marks
    value = re.sub(r"(?m)^\s{0,3}(?:[-+*]|\d+\.)\s+", "", value)  # list bullets
    value = re.sub(r"\s+", " ", value).strip()
    return value[:INBOX_MAX_TEXT]


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
                item_id = item["id"]
                on_hold = _is_held(row, unread, held)  # marked unread by hand: held until marked read by hand
                item["read"] = not on_hold and (item_id <= watermark or item_id in read or item_id in copies)
                item["marked_unread"] = on_hold
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
    enough to poll: the SQL prefilters, and the scan stops as soon as the badge cannot grow past 99+ anyway."""
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
            if not _is_held(row, unread, held) and (cursor in read or cursor in copies):
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
    try:
        with _TODOS_LOCK:
            items = _read_todos()
            if len(items) >= MAX_TODO_ITEMS:
                return JSONResponse({"detail": "the to-do list is full"}, status_code=409)
            item = {"id": secrets.token_hex(6), "text": text, "done": False,
                    "created": int(time.time()), "done_at": None, "indent": indent}
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
    return _todos_response(items)


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
            # A deleted parent leaves its children behind as top-level rows: a child only exists under its parent
            #.
            for block in _todo_blocks(items):
                if block["parent"]["id"] == item_id:
                    for child in block["children"]:
                        child["indent"] = 0
            kept = [item for item in items if item["id"] != item_id]
            _normalise_todos(kept)
            _write_todos(kept)
    except Exception as exc:  # noqa: BLE001
        log.warning("to-do delete failed: %s", exc)
        return JSONResponse({"detail": "could not delete the to-do"}, status_code=500)
    return _todos_response(kept)


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
    return JSONResponse({"ok": True, "pid_before": before.get("pid"), "dashboard_pid_before": os.getpid()})


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
