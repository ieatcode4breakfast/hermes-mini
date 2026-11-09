"""Hermes Mini hook half: turn agent lifecycle moments into Web Push notifications.

Registered by Hermes' plugin loader; the app half (``dashboard/plugin_api.py``) serves the browser
routes. Both halves load ``mini_core.py`` and ``push_store.py`` under fixed module names so they
share settings, subscriptions, the VAPID key and the sender thread.

Every hook enqueues and returns — ``pre_approval_request`` and ``on_human_input_request`` run
inline on the thread that is about to block on the human, so any real work there delays the very
card being announced.
"""

from __future__ import annotations

import importlib.util
import logging
import re
import sys
import threading
from pathlib import Path
from typing import Any


# Hermes imports the two halves of this plugin separately (the hook package and the dashboard
# module), so sibling modules are loaded by file path under fixed module names instead of relying
# on a package path that only one of the two importers provides.
def _sibling(name: str, filename: str):
    module = sys.modules.get(name)
    if module is not None:
        return module
    path = Path(__file__).resolve().parent / filename
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


mini_core = _sibling("hermes_mini_core", "mini_core.py")

log = logging.getLogger("hermes_mini.hooks")

_LOAD_LOCK = threading.Lock()


def _module(name: str, filename: str):
    """A shared plugin module by file path, under a fixed name (Hermes imports each half separately)."""
    module = sys.modules.get(name)
    if module is not None:
        return module
    with _LOAD_LOCK:
        module = sys.modules.get(name)
        if module is not None:
            return module
        path = Path(__file__).resolve().parent / filename
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


def _push():
    return _module("hermes_mini_push", "push_store.py")


def _chats():
    return _module("hermes_mini_app_chats", "app_chats.py")


def _merge_args(args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
    """Hooks are dispatched as ``hook(**payload)``; tolerate a positional payload dict too."""
    merged: dict[str, Any] = {}
    if args and isinstance(args[0], dict):
        merged.update(args[0])
    merged.update(kwargs)
    return merged


def _clip(value: Any, limit: int = 180) -> str:
    text = "" if value is None else str(value)
    text = " ".join(text.split())
    return text[:limit]


def _plain(text: Any) -> str:
    """Strip the markdown symbols a notification would show literally."""
    value = "" if text is None else str(text)
    value = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", value)  # images -> alt text
    value = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", value)  # links -> label
    value = re.sub(r"[*_`>#~|]+", "", value)
    return " ".join(value.split())


def _session_meta(session_id: str) -> tuple[str | None, str | None]:
    """(title, source) from state.db in one cheap read; (None, None) on any failure."""
    try:
        from hermes_state import SessionDB

        db = SessionDB()
        title = None
        try:
            title = db.get_session_title(session_id)
        except Exception:  # noqa: BLE001 - a missing title is normal for young chats
            log.debug("push: title lookup failed", exc_info=True)
        source = None
        try:
            row = db.get_session(session_id)  # documented read API (hermes_state.SessionDB)
            if row is not None:
                source = row.get("source")
        except Exception:  # noqa: BLE001 - reported to the caller as "unknown, notify anyway"
            log.debug("push: source lookup failed", exc_info=True)
        return title, source
    except Exception:  # noqa: BLE001
        log.debug("push: SessionDB unavailable", exc_info=True)
        return None, None


# What the app shows: chats from these sources plus the home thread by title.
_APP_SOURCES = {"tui"}
_HOME_TITLE = "Hermes Mini"  # bridge.py HOME_TITLE
_LEGACY_HOME_TITLES: set[str] = set()


def _registered_app_chat(session_id: str) -> bool:
    """True when the app started this chat (app_chats.py registry). Fails closed: no registry, no push."""
    try:
        return session_id in _chats().ids()
    except Exception:  # noqa: BLE001 - a hook must never break the turn
        log.debug("push: app-chat registry unavailable", exc_info=True)
        return False


def _app_chat(*candidates: Any) -> tuple[str, str | None] | None:
    """The first candidate id that is a chat the app lists, as (session_id, title); None otherwise.

    Fails closed: an id with no session row (a gateway key, a task id), a Discord/cron/subagent
    chat, or a lookup error means the message would never appear in the app, so no push.
    """
    seen: set[str] = set()
    for value in candidates:
        session = str(value or "").strip()
        if not session or session in seen:
            continue
        seen.add(session)
        title, source = _session_meta(session)
        if source is None:
            continue
        if str(title or "").startswith("Subagent:"):
            return None
        if title == _HOME_TITLE or title in _LEGACY_HOME_TITLES:
            return session, title
        if source in _APP_SOURCES and _registered_app_chat(session):
            return session, title
        return None  # a real chat, but one the app does not list
    return None


def _context_session_id() -> str:
    """The session the current tool call runs in, for hooks whose payload carries only a gateway key."""
    try:
        from tools import approval_context

        return str(approval_context._approval_session_id.get() or "")
    except Exception:  # noqa: BLE001
        return ""


def _pre_approval_request(*args: Any, **kwargs: Any) -> None:
    try:
        kw = _merge_args(args, kwargs)
        if kw.get("coalesced"):
            return None  # a follower of an identical pending approval: one card, one push
        body = _clip(kw.get("description") or kw.get("command") or "")
        if not body:
            return None
        chat = _app_chat(kw.get("session_id"), kw.get("session_key"), _context_session_id())
        if chat is None:
            return None  # the approval card shows somewhere else (Discord, CLI, ...)
        session = chat[0]
        _push().notify(
            "approval",
            f"{mini_core.agent_identity()['name']} needs your approval",
            body,
            session,
            f"approval:{session}",
            session_key=session,
        )
    except Exception:  # noqa: BLE001 - a hook must never break the turn
        log.warning("push: approval hook failed", exc_info=True)
    return None


def _on_human_input_request(*args: Any, **kwargs: Any) -> None:
    try:
        payload = _merge_args(args, kwargs)
        if payload.get("kind") != "clarify":
            return None
        prompt = _clip(payload.get("prompt") or "")
        if not prompt:
            return None
        chat = _app_chat(payload.get("session_id"), payload.get("session_key"), _context_session_id())
        if chat is None:
            return None
        session = chat[0]
        _push().notify(
            "clarify",
            f"{mini_core.agent_identity()['name']} has a question",
            prompt,
            session,
            f"clarify:{session}",
        )
    except Exception:  # noqa: BLE001
        log.warning("push: clarify hook failed", exc_info=True)
    return None


# gateway/response_filters.py LIVE_GATEWAY_SILENT_MARKERS: a whole reply that means "chose not to answer".
_SILENT_MARKERS = {"[SILENT]", "SILENT", "NO_REPLY", "NO REPLY", "[静默]", "静默", "[沉默]", "沉默"}


def _is_silence(text: Any) -> bool:
    value = " ".join(str(text or "").strip().upper().split())
    value = value.strip("*_`.!?,;:'\"")
    return value in _SILENT_MARKERS


def _post_llm_call(*args: Any, **kwargs: Any) -> None:
    try:
        kw = _merge_args(args, kwargs)
        # Delegated helpers run as hidden child chats (platform "subagent"): their output goes to the
        # agent, not to the person reading the app.
        if str(kw.get("platform") or "") == "subagent":
            return None
        # Intermediate tool-call steps must never trigger push notifications.
        if kw.get("finish_reason") == "tool_calls" or kw.get("tool_calls"):
            return None
        history = kw.get("conversation_history")
        if isinstance(history, list) and history:
            last = history[-1]
            if isinstance(last, dict):
                if last.get("finish_reason") == "tool_calls":
                    return None
                tc = last.get("tool_calls")
                if tc and str(tc) not in ("", "[]"):
                    return None
        response = kw.get("assistant_response")
        if not response or _is_silence(response):
            return None
        chat = _app_chat(kw.get("session_id"), kw.get("task_id"))
        if chat is None:
            return None  # Discord, cron, subagent or unknown: the reply never shows in the app
        session, title = chat
        # Check the latest message persisted for this chat is not an intermediate tool-step.
        try:
            from hermes_state import SessionDB

            db = SessionDB()
            row = db._read_one(
                "SELECT finish_reason, tool_calls FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                (session,),
            )
            if row is not None:
                if str(row["finish_reason"] or "") == "tool_calls":
                    return None
                tc = row["tool_calls"]
                if tc and str(tc) not in ("", "[]"):
                    return None
        except Exception:
            pass
        body = _clip(_plain(response))
        if not body:
            return None
        # Hermes hands this hook no row id, so the notification carries the reply's opening instead:
        # the app finds the message whose text starts with it. Raw response, markdown and all.
        name = mini_core.agent_identity()["name"]
        _push().notify(
            "reply",
            # The main chat's stored title is an internal key; notifications read the agent's name.
            _clip(name if not title or title == _HOME_TITLE or title in _LEGACY_HOME_TITLES else title, 120),
            body,
            session,
            f"reply:{session}",
            match=_clip(response, 200),
        )
    except Exception:  # noqa: BLE001
        log.warning("push: post_llm_call hook failed", exc_info=True)
    return None


# ---------- optional app-only instructions ----------
# An operator may place a text file at ``$HERMES_HOME/data/hermes-mini/app-instructions.md``. Its
# contents ride along with every user message in an app chat (and its subagents), never in Discord,
# cron or other chats. Nothing is injected by default: the plugin ships no personal rules.
_app_instructions_cache: tuple[float, str] = (-1.0, "")


def _app_instructions() -> str:
    global _app_instructions_cache
    path = mini_core.instructions_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return ""
    if mtime != _app_instructions_cache[0]:
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
        _app_instructions_cache = (mtime, text)
    return _app_instructions_cache[1]


def _in_app_chat(*candidates: Any, fail_closed: bool = True) -> bool:
    """True when any candidate session, or an ancestor up to 4 levels (subagents, branches), is an
    app chat. Fails closed by default: a lookup error counts as an app chat, so the guard holds when
    the database is unreadable. ``fail_closed=False`` (instructions) treats an error as "not an app
    chat"."""
    try:
        from hermes_state import SessionDB

        db = SessionDB()
        for value in candidates:
            session = str(value or "").strip()
            for _ in range(5):
                if not session:
                    break
                row = db.get_session(session)
                if row is None:
                    break
                title = str(row.get("title") or "")
                if title == _HOME_TITLE or title in _LEGACY_HOME_TITLES:
                    return True
                if row.get("source") in _APP_SOURCES and _registered_app_chat(session):
                    return True
                session = str(row.get("parent_session_id") or "")
        return False
    except Exception:  # noqa: BLE001
        if not fail_closed:
            log.warning("app-chat lookup failed", exc_info=True)
            return False
        log.warning("guard: session lookup failed; blocking", exc_info=True)
        return True


def _pre_llm_call(*args: Any, **kwargs: Any) -> dict[str, str] | None:
    try:
        text = _app_instructions()
        if not text:
            return None
        kw = _merge_args(args, kwargs)
        if _in_app_chat(kw.get("session_id"), kw.get("parent_session_id"), fail_closed=False):
            return {"context": text}
    except Exception:  # noqa: BLE001 - never break a turn
        log.warning("app instructions hook failed", exc_info=True)
    return None


# ---------- self-edit guard ----------
# A turn running in an app chat (or a subagent it spawned) cannot change this plugin's own package.
# Reading is fine. The package is replaceable code: user settings and data live outside it. This is
# not configurable on purpose — changes to the app come from whoever installs and updates it.
_PLUGIN_DIR = str(Path(__file__).resolve().parent)
_PLUGIN_REF = re.compile(r"plugins/hermes-mini(?![\w-])")
_SHELL_WRITE_CMDS = (
    r"(?:^|[\s;&|(`])(?:rm|mv|cp|tee|touch|truncate|chmod|chown|ln|install|rsync|unzip|patch|dd|shred|mkdir|rmdir)\s"
    r"|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i"
    r"|\bgit\s+(?:checkout|restore|reset|apply|stash|clean|mv|rm|pull|merge|rebase|am)\b|\btar\s+[^|;&]*-?x")
_REDIRECT = r"(?<![0-9&<>=\-])>{1,2}(?![&>=])\s*(?!/dev/null\b)['\"]?[\w~/$.{]"
_REDIRECT_TO_PLUGIN = r"(?<![0-9&<>=\-])>{1,2}\s*['\"]?[^\s'\"<>|;&]*plugins/hermes-mini(?![\w-])"
_SHELL_WRITE = re.compile(_SHELL_WRITE_CMDS + "|" + _REDIRECT)
_SHELL_WRITE_IN_CODE = re.compile(_SHELL_WRITE_CMDS + "|" + _REDIRECT_TO_PLUGIN)
_CODE_WRITE = re.compile(
    r"open\([^)]*,\s*['\"][^'\"]*[wax+][^'\"]*['\"]|mode\s*=\s*['\"][^'\"]*[wax+]|write_text|write_bytes|\.write\("
    r"|os\.(?:remove|unlink|rename|replace|rmdir|removedirs|truncate|chmod)|shutil\.|\.(?:unlink|rename|touch)\("
    r"|subprocess|os\.system")


def _guard_message() -> str:
    return (f"Blocked: chats in the {mini_core.agent_identity()['name']} app cannot change the app's plugin "
            "files. Reading them is fine. Tell the person what you would change; they update the plugin.")


def _targets_plugin(tool_name: str, args: dict[str, Any]) -> bool:
    if tool_name in ("write_file", "patch"):
        path = str(args.get("path") or "")
        if path:
            try:
                real = str(Path(path).expanduser().resolve())  # follows symlinks and ../ out of other dirs
            except Exception:  # noqa: BLE001
                real = path
            if real == _PLUGIN_DIR or real.startswith(_PLUGIN_DIR + "/"):
                return True
        return any(_PLUGIN_REF.search(text) for text in (path, str(args.get("patch") or "")))
    if tool_name == "terminal":
        command = str(args.get("command") or "")
        return bool(_PLUGIN_REF.search(command) and _SHELL_WRITE.search(command))
    if tool_name == "execute_code":
        code = str(args.get("code") or "")
        return bool(_PLUGIN_REF.search(code) and (_CODE_WRITE.search(code) or _SHELL_WRITE_IN_CODE.search(code)))
    return False


def _pre_tool_call(*args: Any, **kwargs: Any) -> dict[str, str] | None:
    try:
        kw = _merge_args(args, kwargs)
        tool_args = kw.get("args") if isinstance(kw.get("args"), dict) else {}
        if not _targets_plugin(str(kw.get("tool_name") or ""), tool_args):
            return None
        if _in_app_chat(kw.get("session_id"), kw.get("task_id"), _context_session_id()):
            log.warning("guard: blocked %s on the plugin from an app chat", kw.get("tool_name"))
            return {"action": "block", "message": _guard_message()}
    except Exception:  # noqa: BLE001 - never break a turn; a broken check lets the call through and logs it
        log.warning("guard: check failed", exc_info=True)
    return None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("pre_approval_request", _pre_approval_request)
    ctx.register_hook("on_human_input_request", _on_human_input_request)
    ctx.register_hook("post_llm_call", _post_llm_call)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    if hasattr(ctx, "register_auxiliary_task"):
        try:
            ctx.register_auxiliary_task(
                "hermes_mini_narration",
                display_name="Hermes Mini turn narration",
                description="Short live progress line while a reply streams in the app",
                defaults={"provider": "auto", "model": "", "timeout": 8},
                inherit_from="title_generation",
            )
        except Exception:  # noqa: BLE001
            log.warning("auxiliary task registration failed", exc_info=True)
    # The ``hermes-mini`` delivery destination: scheduled jobs land in the app's main chat.
    try:
        _module("hermes_mini_bridge", "bridge.py").register_platform(ctx)
    except Exception:  # noqa: BLE001 - push hooks must keep working even if the bridge cannot register
        log.warning("bridge: platform registration failed", exc_info=True)
