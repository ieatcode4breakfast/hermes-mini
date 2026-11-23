"""Hermes Mini session-store adapter: Hermes v0.23.3+ storage interface with v0.23.0 fallback.

Uses ``persistence_assembly.open_persistence`` (the process-shared store anchored to the active
Hermes home) when available, and falls back to ``hermes_state.SessionDB`` on Hermes 0.23.0-0.23.2.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

try:
    from persistence.conversation.messages import NewMessage, TranscriptRead, TranscriptView
    from persistence.conversation.sessions import SessionWindow
    from persistence_assembly import open_persistence, profile_scope
except ImportError:
    try:
        from hermes_state import SessionDB
    except ImportError:
        SessionDB = None  # type: ignore[assignment]


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


def _is_in_memory_fake(module_name: str) -> bool:
    mod = sys.modules.get(module_name)
    return mod is not None and not getattr(mod, "__file__", None)


def _use_persistence() -> bool:
    if _is_in_memory_fake("persistence_assembly"):
        return True
    if _is_in_memory_fake("hermes_state"):
        return False
    return "open_persistence" in globals() or "persistence_assembly" in sys.modules


def _persistence_symbols():
    pa = sys.modules.get("persistence_assembly")
    pm = sys.modules.get("persistence.conversation.messages")
    ps = sys.modules.get("persistence.conversation.sessions")
    open_fn = getattr(pa, "open_persistence", None) or globals().get("open_persistence")
    scope_fn = getattr(pa, "profile_scope", None) or globals().get("profile_scope")
    new_msg = getattr(pm, "NewMessage", None) or globals().get("NewMessage")
    t_read = getattr(pm, "TranscriptRead", None) or globals().get("TranscriptRead")
    t_view = getattr(pm, "TranscriptView", None) or globals().get("TranscriptView")
    s_win = getattr(ps, "SessionWindow", None) or globals().get("SessionWindow")
    if not all((open_fn, scope_fn, new_msg, t_read, t_view, s_win)):
        raise ImportError("persistence interface is not available")
    return open_fn, scope_fn, new_msg, t_read, t_view, s_win


def _legacy_db():
    hs = sys.modules.get("hermes_state")
    cls = getattr(hs, "SessionDB", None) if hs is not None else globals().get("SessionDB")
    if cls is None:
        raise ImportError("hermes_state.SessionDB is not available")
    return cls()


def _as_dict(record: Any) -> dict[str, Any] | None:
    if record is None:
        return None
    if isinstance(record, dict):
        return dict(record)
    if hasattr(record, "as_session_row"):
        return dict(record.as_session_row())
    if hasattr(record, "as_wire_row"):
        return dict(record.as_wire_row())
    return dict(record)


class SessionStore:
    """Unified session & message store over Hermes v0.23.3+ persistence or legacy SessionDB."""

    def _open_shared(self):
        open_fn, scope_fn, *_ = _persistence_symbols()
        return open_fn(scope_fn(home=mini_core.hermes_home()))

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        if _use_persistence():
            with self._open_shared() as store:
                return _as_dict(store.sessions.get(session_id))
        return _as_dict(_legacy_db().get_session(session_id))

    def get_session_by_title(self, title: str) -> dict[str, Any] | None:
        if _use_persistence():
            with self._open_shared() as store:
                return _as_dict(store.sessions.get_by_title(title))
        return _as_dict(_legacy_db().get_session_by_title(title))

    def search_sessions(self, *, limit: int = 20) -> list[dict[str, Any]]:
        if _use_persistence():
            *_, s_win = _persistence_symbols()
            with self._open_shared() as store:
                entries = store.sessions.search_sessions(window=s_win(limit=limit))
                rows = []
                for entry in entries:
                    session = getattr(entry, "session", entry)
                    row = _as_dict(session)
                    if row is not None:
                        rows.append(row)
                return rows
        return [dict(r) for r in _legacy_db().search_sessions(limit=limit)]

    def get_messages(
        self,
        session_id: str,
        *,
        limit: int | None = None,
        latest: bool = False,
    ) -> list[dict[str, Any]]:
        if _use_persistence():
            _, _, _, t_read, t_view, _ = _persistence_symbols()
            with self._open_shared() as store:
                req = t_read(view=t_view.ACTIVE, limit=limit, latest=latest)
                return [
                    row
                    for item in store.messages.read_transcript(session_id, req)
                    if (row := _as_dict(item)) is not None
                ]
        return [dict(r) for r in _legacy_db().get_messages(session_id, limit=limit, latest=latest)]

    def append_message(
        self,
        *,
        session_id: str,
        role: str,
        content: str,
        display_kind: str | None = None,
        display_metadata: dict[str, Any] | None = None,
    ) -> int:
        if _use_persistence():
            _, _, new_msg, *_ = _persistence_symbols()
            payload = {
                "role": role,
                "content": content,
                "display_kind": display_kind,
                "display_metadata": display_metadata,
            }
            message = new_msg.from_live(payload) if hasattr(new_msg, "from_live") else new_msg(**payload)
            with self._open_shared() as store:
                return int(store.messages.append(session_id, message))
        return int(
            _legacy_db().append_message(
                session_id=session_id,
                role=role,
                content=content,
                display_kind=display_kind,
                display_metadata=display_metadata,
            )
        )
