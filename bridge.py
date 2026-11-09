"""Hermes Mini delivery destination for scheduled-job output.

Jobs use ``deliver: hermes-mini`` (main chat), ``hermes-mini:<session_id>`` or
``hermes-mini:<title>`` for a named chat, or ``discord:...,hermes-mini`` for both. The gateway owns
cron delivery, so this registers a minimal gateway platform: nothing inbound, ``send`` only.

Targets resolve at delivery time, in this order: a live chat id, the reserved ``main``/``home``
words, an exact live title, then a case-insensitive title only when one live chat carries it. A
missing, renamed, archived or ambiguous target falls back to the app's main chat, so the result is
never lost. The fallback is logged, not shown in the app. The plugin records the main chat as the
platform's default address on first run, so bare ``hermes-mini`` resolves too.

The output is stored as a USER-role row with a labelled prefix (an assistant-role row would sit next
to the agent's own turn and break strict alternation). ``display_kind = "job_delivery"`` tells the
app to draw it as an agent-side message marked as a scheduled job. No model call is made. A push
notification follows, through the shared push store.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid
from typing import Any, Optional


# Hermes imports the two halves of this plugin separately (the hook package and the dashboard
# module), so sibling modules are loaded by file path under fixed module names instead of relying
# on a package path that only one of the two importers provides.
def _sibling(name: str, filename: str):
    import importlib.util
    import sys
    from pathlib import Path

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

log = logging.getLogger("hermes_mini.bridge")

PLATFORM = "hermes-mini"
# Internal stored title of the app's main chat. Never shown to a person: the app displays the
# external home label (or the agent name) for that row.
HOME_TITLE = "Hermes Mini"
LEGACY_HOME_TITLES: tuple[str, ...] = ()
DISPLAY_KIND = "job_delivery"
PREFIX = "[Scheduled job result]"
MAX_LEN = 60000
# Gateway lifecycle notices: "⚠️ Hermes is shutting down — ...", "♻ Restarting gateway. ...". Matched at
# the start only, so a real reply that mentions a restart still gets through.
_LIFECYCLE_NOTICE = re.compile(r"^\W{0,4}(?:Hermes is (?:shutting down|restarting)\b|Restarting gateway\b)")

_LOAD_LOCK = threading.Lock()


def _module(name: str, filename: str):
    """A shared plugin module by file path, under the fixed name both halves use."""
    import importlib.util
    import sys

    module = sys.modules.get(name)
    if module is not None:
        return module
    with _LOAD_LOCK:
        module = sys.modules.get(name)
        if module is not None:
            return module
        path = mini_core.package_dir() / filename
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


def _store():
    return _module("hermes_mini_push", "push_store.py")


def _plain(text: str) -> str:
    """Markdown symbols stripped and whitespace collapsed, for the notification body."""
    value = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    value = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"[*_`>#~|]+", "", value)
    return " ".join(value.split())


def _app_chats():
    """The app-chat registry, shared with the dashboard and hook halves."""
    return _module("hermes_mini_app_chats", "app_chats.py")


def _home_session_id(db) -> Optional[str]:
    """The app's main chat: the id it recorded, else a registered chat still holding HOME_TITLE.

    Once an id is recorded, the title is irrelevant: a chat that later takes the title cannot capture
    the home. A recorded id that is gone or archived returns None instead of following the name. With
    no id yet (migration), only an app-registered title holder is accepted.
    """
    try:
        chats = _app_chats()
        recorded = chats.home()
    except Exception:  # noqa: BLE001 - a missing registry must not crash delivery
        log.warning("bridge: app-chat registry unavailable", exc_info=True)
        return None
    if recorded:
        row = db.get_session(recorded)
        if row is not None and not row.get("archived"):
            return str(row["id"])
        return None
    try:
        registered = chats.ids()
    except Exception:  # noqa: BLE001
        registered = frozenset()
    for title in (HOME_TITLE, *LEGACY_HOME_TITLES):
        row = db.get_session_by_title(title)  # documented read API
        if row is not None and not row.get("archived") and str(row["id"]) in registered:
            return str(row["id"])
    return None


def _resolve_session_id(db, target: str) -> tuple[Optional[str], str]:
    """``(session_id, how)`` for a delivery target: 'id', 'title' or 'home'.

    Resolution order: a live chat id, the reserved main-chat words, an exact live title, then a
    case-insensitive title only when exactly one live chat carries it. Anything else - missing,
    renamed, archived, or ambiguous - falls back to the main chat, so a result is never lost. The
    fallback is logged, not shown to the person.
    """
    name = (target or "").strip()
    if name and name not in ("main", "home"):
        row = db.get_session(name)
        if row is not None and not row.get("archived"):
            return str(row["id"]), "id"
        row = db.get_session_by_title(name)
        if row is not None and not row.get("archived"):
            return str(row["id"]), "title"
        # A spelling difference should not move a result to the wrong chat: accept a
        # case-insensitive title only when it names one live chat. Two case variants are ambiguous
        # and fall back instead of guessing.
        rows = db._read_all(
            "SELECT id FROM sessions WHERE lower(title) = lower(?) "
            "AND COALESCE(archived, 0) = 0 LIMIT 2",
            (name,),
        )
        if len(rows) == 1:
            return str(rows[0]["id"]), "title"
        log.warning("bridge: target %r is unavailable — falling back to the main chat", name)
    home = _home_session_id(db)
    return home, "home"


def deliver_text(content: str, target: str = "main") -> dict[str, Any]:
    """Store one job result in the target chat (or the main chat) and notify."""
    text = mini_core.strip_cron_wrapper((content or "").strip())
    if not text:
        return {"error": "bridge: empty message"}
    if _LIFECYCLE_NOTICE.match(text):
        # Gateway shutdown/restart notices are machinery, not news: never stored in the app.
        log.info("bridge: dropped a gateway lifecycle notice")
        return {"success": True, "message_id": "suppressed-lifecycle-notice"}
    try:
        from hermes_state import SessionDB

        db = SessionDB()
        session_id, how = _resolve_session_id(db, target)
    except Exception as exc:  # noqa: BLE001
        log.warning("bridge: chat lookup failed: %s", exc)
        return {"error": f"bridge: chat lookup failed: {exc}"}
    if not session_id:
        return {"error": "bridge: no chat to deliver to (open the app once)"}
    try:
        from hermes_state import SessionDB

        row_id = SessionDB().append_message(
            session_id=session_id, role="user", content=f"{PREFIX}\n{text[:MAX_LEN]}",
            display_kind=DISPLAY_KIND,
            display_metadata={"source": "hermes-mini-bridge", "target": (target or "main")})
    except Exception as exc:  # noqa: BLE001
        log.warning("bridge: write to %s failed: %s", session_id, exc)
        return {"error": f"bridge: write failed: {exc}"}
    try:
        # The stored row id is the state.db messages.id the app can scroll to, so the notification
        # opens on the result itself rather than the bottom of the chat.
        _store().notify("job", mini_core.agent_identity()["name"], _plain(text)[:180], session_id,
                        f"job:{row_id}", message_id=row_id)
    except Exception:  # noqa: BLE001 - the message is stored; a missed push is not a failed delivery
        log.warning("bridge: push failed", exc_info=True)
    log.info("bridge: job result stored in %s via %s (row %s)", session_id, how, row_id)
    return {"success": True, "platform": PLATFORM, "chat_id": session_id, "resolved_by": how,
            "message_id": str(row_id)}


def _adapter_class():
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult

    class MiniBridgeAdapter(BasePlatformAdapter):
        """Outbound only: ``send`` stores into the target app chat. Never produces inbound messages."""

        MAX_MESSAGE_LENGTH = MAX_LEN

        def __init__(self, config):
            super().__init__(config=config, platform=Platform(PLATFORM))

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            self._running = True
            self._mark_connected()
            return True

        async def disconnect(self) -> None:
            self._running = False
            self._mark_disconnected()

        async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                       metadata: Optional[dict[str, Any]] = None) -> SendResult:
            import asyncio

            result = await asyncio.to_thread(deliver_text, content, chat_id)
            if result.get("success"):
                return SendResult(success=True, message_id=result.get("message_id") or uuid.uuid4().hex)
            return SendResult(success=False, error=str(result.get("error")))

        async def send_typing(self, chat_id: str, metadata: Optional[dict[str, Any]] = None) -> None:
            return None

        async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None,
                             reply_to: Optional[str] = None,
                             metadata: Optional[dict[str, Any]] = None) -> SendResult:
            return await self.send(chat_id, "\n".join(x for x in (caption, image_url) if x))

        async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
            return {"name": f"{mini_core.agent_identity()['name']} chat", "type": "dm", "chat_id": chat_id}

    return MiniBridgeAdapter


async def _standalone_send(pconfig, chat_id: str, message: str, *, thread_id=None, media_files=None,
                           force_document: bool = False, **_kw) -> dict[str, Any]:
    """Out-of-process delivery (cron outside the gateway): the same store-and-notify."""
    import asyncio

    return await asyncio.to_thread(deliver_text, message, chat_id)


def register_platform(ctx: Any) -> None:
    ctx.register_platform(
        name=PLATFORM, label=mini_core.agent_identity()["name"],
        adapter_factory=lambda cfg: _adapter_class()(cfg),
        check_fn=lambda: True, is_connected=lambda cfg: True,
        cron_deliver_env_var="HERMES_MINI_HOME_CHANNEL", standalone_sender_fn=_standalone_send,
        max_message_length=MAX_LEN, emoji="✨", pii_safe=True,
        platform_hint="Messages here are stored in the Hermes Mini app's chats; nobody replies through this channel.",
    )
