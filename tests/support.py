"""Shared test helpers: a disposable HERMES_HOME and fresh module imports.

Every test that touches settings, state or the routes runs against a temporary home; nothing in this
suite reads or writes the user's real ``~/.hermes``. The plugin modules resolve their paths through
``hermes_constants.get_hermes_home()`` (or ``$HERMES_HOME``), so pointing the environment at a fresh
directory is the whole isolation story.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = PROJECT_ROOT / "dashboard"

# Fixed module names the two halves of the plugin use to share implementations.
SHARED_MODULES = ("hermes_mini_core", "hermes_mini_push", "hermes_mini_app_chats", "hermes_mini_bridge")


def hermes_agent_root() -> Path | None:
    """The Hermes checkout whose modules the real-ABI tests exercise, when one is available.

    A test environment that has the managed venv also has the source tree; point
    ``HERMES_AGENT_ROOT`` at it (``hermes plugins doctor`` runs with that directory on
    ``sys.path`` too). Tests that need Hermes' own modules skip when it is absent, so the suite is
    honest on a bare interpreter instead of silently importing a stub.
    """
    configured = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates += [Path("/root/.hermes/hermes-agent")]
    for candidate in candidates:
        try:
            if (candidate / "tools" / "transcription_tools.py").is_file():
                return candidate
        except OSError:
            # An unreadable path (another user's home, a restricted mount) is simply not a checkout.
            continue
    return None


def ensure_hermes_on_path() -> bool:
    """Put the Hermes checkout first on ``sys.path``; True when ``tools`` is importable afterwards."""
    try:
        import tools  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        pass
    root = hermes_agent_root()
    if root is None:
        return False
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    try:
        import tools  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def reset_shared_modules() -> None:
    for name in list(sys.modules):
        if name in SHARED_MODULES or name.startswith("hermes_mini_"):
            sys.modules.pop(name, None)


def load_module(name: str, path: Path):
    """Import a plugin file by path under a fixed name, exactly as the plugin's own loaders do."""
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
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


def load_core():
    return load_module("hermes_mini_core", PROJECT_ROOT / "mini_core.py")


def load_push():
    load_core()
    return load_module("hermes_mini_push", PROJECT_ROOT / "push_store.py")


def load_chats():
    load_core()
    return load_module("hermes_mini_app_chats", PROJECT_ROOT / "app_chats.py")


class DisposableHome(unittest.TestCase):
    """A test case whose ``HERMES_HOME`` is a fresh temp directory for the duration of each test."""

    def setUp(self) -> None:
        reset_shared_modules()
        self._old_home = os.environ.get("HERMES_HOME")
        self._tmp = tempfile.TemporaryDirectory(prefix="hermes-mini-test-")
        self.home = Path(self._tmp.name)
        os.environ["HERMES_HOME"] = str(self.home)
        self.core = load_core()

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self._old_home
        reset_shared_modules()
        self._tmp.cleanup()

    # Convenience helpers -------------------------------------------------

    def write_config(self, text: str) -> Path:
        path = self.home / "hermes-mini" / "config.yaml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def write_profile(self, text: str) -> Path:
        path = self.home / "profile.yaml"
        path.write_text(text, encoding="utf-8")
        return path

    def snapshot_tree(self, root: Path) -> dict[str, bytes]:
        """Every file under *root* with its bytes, for a before/after comparison."""
        return {
            str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*")
            if path.is_file()
        }

    def plugin_owned(self) -> dict[str, bytes]:
        """The files this plugin owns: its settings, assets and data — never vanilla Hermes files.

        A fresh Hermes home seeds its own files (``SOUL.md``, ``config.yaml``) the first time config
        is read, so a whole-home snapshot would blame the plugin for Hermes' own first-run writes.
        """
        owned: dict[str, bytes] = {}
        for base in (self.home / "hermes-mini", self.home / "data" / "hermes-mini"):
            if base.exists():
                for path in base.rglob("*"):
                    if path.is_file():
                        owned[str(path)] = path.read_bytes()
        return owned
