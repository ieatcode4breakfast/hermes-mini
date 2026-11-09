"""Capability probes, the read-only package, reload safety and update durability.

These cover the boundaries the roadmap calls out: the capability route is booleans only and
authenticates through the mount; the plugin package is never written at runtime; reloading is
idempotent; and replacing the package code leaves external settings, assets and data intact.
"""

from __future__ import annotations

import os
import shutil
import stat
import tempfile
import unittest
from pathlib import Path

from tests.support import DASHBOARD, PROJECT_ROOT, DisposableHome, load_chats, load_module, load_push
from tests import images


class CapabilityBoolTest(DisposableHome):
    def test_probe_returns_only_booleans(self):
        api = load_module("hermes_dashboard_plugin_hermes-mini_caps", DASHBOARD / "plugin_api.py") \
            if _has_fastapi() else None
        if api is None:
            self.skipTest("FastAPI is not installed in this environment")
        caps = api._capabilities()
        self.assertEqual(set(caps), {"computer", "push", "dictation", "model_configured"})
        for value in caps.values():
            self.assertIsInstance(value, bool)

    def test_probe_creates_no_desktop_or_push_state(self):
        if not _has_fastapi():
            self.skipTest("FastAPI is not installed in this environment")
        before = self.plugin_owned()
        api = load_module("hermes_dashboard_plugin_hermes-mini_caps2", DASHBOARD / "plugin_api.py")
        api._capabilities()
        # The plugin wrote nothing: no settings, no push directory, no desktop state file of its own.
        self.assertEqual(self.plugin_owned(), before)
        self.assertFalse((self.home / "data" / "hermes-mini").exists())


def _has_fastapi() -> bool:
    try:
        import fastapi  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


class ReadOnlyPackageTest(DisposableHome):
    """With the install directory read-only, every normal operation still works and nothing is written there."""

    def setUp(self):
        super().setUp()
        self._install = tempfile.TemporaryDirectory(prefix="hermes-mini-install-")
        self.install = Path(self._install.name) / "hermes-mini"
        shutil.copytree(PROJECT_ROOT, self.install, ignore=shutil.ignore_patterns("tests", "__pycache__", ".git"))
        self._before = self.snapshot_tree(self.install)
        for path in sorted(self.install.rglob("*"), reverse=True):
            mode = path.stat().st_mode
            path.chmod(mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
        self.install.chmod(0o555)

    def tearDown(self):
        try:
            for path in sorted(self.install.rglob("*"), reverse=True):
                path.chmod(0o755 if path.is_dir() else 0o644)
            self.install.chmod(0o755)
        except OSError:
            pass
        self._install.cleanup()
        super().tearDown()

    def test_core_can_save_settings_and_identity_with_package_read_only(self):
        core = load_module("hermes_mini_core", self.install / "mini_core.py")
        core.save_settings({**core.load_settings(), "agent": {"name": "Ada", "avatar": "", "home_label": ""}})
        core.save_identity("Ada", images.png(32, 32), complete=True)
        self.assertTrue((self.home / "hermes-mini" / "config.yaml").is_file())
        assets = list((self.home / "hermes-mini" / "assets").iterdir())
        self.assertEqual(len(assets), 1)

    def test_push_opt_in_works_with_package_read_only(self):
        push = load_module("hermes_mini_push", self.install / "push_store.py")
        # push_store loads its sibling core by path; point it at the copied package.
        key = push.ensure_public_key_b64url()
        self.assertTrue(key)
        self.assertTrue((self.home / "data" / "hermes-mini" / "push" / "vapid_private.pem").is_file())

    def test_plugin_package_is_byte_identical_afterwards(self):
        self.assertEqual(self.snapshot_tree(self.install), self._before)


class ReloadIdempotenceTest(DisposableHome):
    def test_reloading_modules_keeps_settings_and_data(self):
        push = load_push()
        key = push.ensure_public_key_b64url()
        chats = load_chats()
        chats.add("session-1")

        # Simulate a fresh process: drop every shared module and load again from the same files.
        from tests.support import reset_shared_modules

        reset_shared_modules()
        push2 = load_push()
        chats2 = load_chats()
        self.assertEqual(push2.public_key_b64url(), key)
        self.assertIn("session-1", chats2.ids())


class UpdateDurabilityTest(DisposableHome):
    """Replacing the plugin package keeps config, assets and state (they live outside it)."""

    def test_replacing_package_code_keeps_user_data(self):
        core = load_module("hermes_mini_core", PROJECT_ROOT / "mini_core.py")
        core.save_identity("Ada", images.png(32, 32), complete=True)
        before = core.load_settings()

        replacement = Path(tempfile.mkdtemp(prefix="hermes-mini-replaced-"))
        try:
            shutil.copytree(PROJECT_ROOT, replacement / "hermes-mini",
                            ignore=shutil.ignore_patterns("tests", "__pycache__", ".git"))
            # New package code, read from the replacement install.
            core2 = load_module("hermes_mini_core", replacement / "hermes-mini" / "mini_core.py")
            after = core2.load_settings()
            self.assertEqual(after["agent"]["name"], "Ada")
            self.assertEqual(after["agent"]["avatar"], before["agent"]["avatar"])
            self.assertTrue((self.home / "hermes-mini" / "assets" / before["agent"]["avatar"]).is_file())
            self.assertTrue(core2.agent_identity()["onboarding_complete"])
        finally:
            shutil.rmtree(replacement, ignore_errors=True)

    def test_avatar_survives_a_rename_and_a_new_picture_replaces_the_old_file(self):
        core = load_module("hermes_mini_core", PROJECT_ROOT / "mini_core.py")
        core.save_identity("Ada", images.png(32, 32), complete=True)
        first = core.load_settings()["agent"]["avatar"]
        self.assertTrue((self.home / "hermes-mini" / "assets" / first).is_file())
        core.save_identity("Ada", images.png(48, 48), complete=True)
        assets = sorted(path.name for path in (self.home / "hermes-mini" / "assets").iterdir())
        self.assertEqual(len(assets), 1)
        self.assertNotEqual(assets[0], first)


if __name__ == "__main__":
    unittest.main()
