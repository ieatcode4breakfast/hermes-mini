"""Which chats were started in the Hermes Mini app.

Hermes stores app chats as plain ``tui`` sessions, the same source as the dashboard chat page and
``hermes --tui``, so the source alone cannot tell them apart. This registry is the app's own tag:
the app adds every chat it creates (new chat, branch, the main chat), and the chat list and the push
filter check it instead of guessing from the source.

Loaded by both halves of the plugin under the fixed ``sys.modules`` name ``hermes_mini_app_chats``.
Reads are cached by file mtime. The registry lives in ``$HERMES_HOME/data/hermes-mini`` and is
created on the first chat the app registers, never on a read.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path


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

log = logging.getLogger(__name__)

MAX_IDS = 5000
_LOCK = threading.Lock()
_cache: tuple[str, float, frozenset[str]] | None = None


def _path() -> Path:
    return mini_core.data_file("app-chats.json")


def _read() -> list[str]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception as exc:  # noqa: BLE001 - a bad file means "no registered chats", never a broken app
        log.warning("app-chats: registry unreadable: %s", exc)
        return []
    raw = data.get("ids") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        log.warning("app-chats: registry malformed; keeping it, treating as empty")
        return []
    return [item for item in raw if isinstance(item, str) and item]


def _write(ids: list[str]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".app-chats.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"ids": ids[-MAX_IDS:]}))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ids() -> frozenset[str]:
    """Every chat id the app started. A pure read; an absent registry is an empty set."""
    global _cache
    path = _path()
    with _LOCK:
        try:
            stat = path.stat()
            stamp, mtime = str(path), stat.st_mtime
        except FileNotFoundError:
            return frozenset()
        if _cache is not None and _cache[0] == stamp and _cache[1] == mtime:
            return _cache[2]
        result = frozenset(_read())
        _cache = (stamp, mtime, result)
        return result


def add(session_id: str) -> bool:
    """Registers a chat the app created. True when it was new."""
    global _cache
    session_id = str(session_id or "").strip()
    if not session_id or len(session_id) > 200:
        return False
    with _LOCK:
        current = _read()
        if session_id in current:
            return False
        current.append(session_id)
        _write(current)
        _cache = None
        return True
