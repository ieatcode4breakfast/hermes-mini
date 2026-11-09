"""Paths, external settings and identity priority.

These exercise the contract that makes the package replaceable: nothing is written into the plugin
directory, reads create no files, and the agent name follows "default-profile bot title, serving
bot title, display name, named profile, then Hermes" without ever renaming a Hermes bot or profile.
"""

from __future__ import annotations

import os
import unittest

from tests.support import PROJECT_ROOT, DisposableHome
from tests import images


class PathsTest(DisposableHome):
    def test_app_paths_live_under_the_active_home(self):
        self.assertEqual(self.core.app_dir(), self.home / "hermes-mini")
        self.assertEqual(self.core.config_path(), self.home / "hermes-mini" / "config.yaml")
        self.assertEqual(self.core.assets_dir(), self.home / "hermes-mini" / "assets")
        self.assertEqual(self.core.data_dir(), self.home / "data" / "hermes-mini")
        self.assertEqual(self.core.data_file("todos.json"), self.home / "data" / "hermes-mini" / "todos.json")

    def test_paths_follow_a_changed_home_without_a_reimport(self):
        """The resolver is read per call, so a process serving another profile sees that profile's paths."""
        first = self.core.app_dir()
        other = self.home / "profiles" / "writer"
        os.environ["HERMES_HOME"] = str(other)
        try:
            self.assertEqual(self.core.app_dir(), other / "hermes-mini")
            self.assertNotEqual(self.core.app_dir(), first)
        finally:
            os.environ["HERMES_HOME"] = str(self.home)

    def test_package_dir_is_the_project(self):
        self.assertEqual(self.core.package_dir(), PROJECT_ROOT)

    def test_reads_create_nothing(self):
        before = self.snapshot_tree(self.home)
        self.core.load_settings()
        self.core.agent_identity()
        self.core.model_configured()
        self.core.configured_public_origin()
        self.assertEqual(self.snapshot_tree(self.home), before)
        self.assertFalse(self.core.config_path().exists())


class SettingsTest(DisposableHome):
    def test_missing_file_reads_defaults(self):
        settings = self.core.load_settings()
        self.assertEqual(settings["agent"]["name"], "")
        self.assertFalse(settings["onboarding"]["complete"])
        self.assertEqual(settings["schema"], 1)

    def test_save_then_read_roundtrip(self):
        settings = self.core.load_settings()
        settings["agent"]["name"] = "Ada"
        settings["server"]["public_url"] = "https://chat.example.com"
        self.core.save_settings(settings)
        again = self.core.load_settings()
        self.assertEqual(again["agent"]["name"], "Ada")
        self.assertEqual(again["server"]["public_url"], "https://chat.example.com")
        self.assertEqual(self.core.config_path().stat().st_mode & 0o777, 0o600)

    def test_invalid_values_are_dropped_not_trusted(self):
        self.write_config(
            "schema: 99\n"
            "agent:\n"
            "  name: '  Ada   Lovelace  '\n"
            "  avatar: ../../etc/passwd\n"
            "server:\n"
            "  public_url: 'javascript:alert(1)'\n"
            "push:\n"
            "  contact: 'http://192.168.0.5'\n"
            "onboarding:\n"
            "  complete: 'yes'\n"
        )
        settings = self.core.load_settings()
        self.assertEqual(settings["schema"], 1)
        self.assertEqual(settings["agent"]["name"], "Ada Lovelace")
        self.assertEqual(settings["agent"]["avatar"], "")
        self.assertEqual(settings["server"]["public_url"], "")
        self.assertEqual(settings["push"]["contact"], "")
        self.assertFalse(settings["onboarding"]["complete"])

    def test_unknown_keys_are_not_persisted(self):
        self.write_config("agent:\n  name: Ada\nsecret:\n  token: abc\n")
        settings = self.core.load_settings()
        self.assertNotIn("secret", settings)

    def test_loopback_public_url_allowed_but_plain_remote_is_not(self):
        self.assertEqual(self.core.clean_public_url("http://localhost:9119"), "http://localhost:9119")
        self.assertEqual(self.core.clean_public_url("https://x.example/app/"), "https://x.example/app")
        self.assertEqual(self.core.clean_public_url("http://example.com"), "")


class IdentityTest(DisposableHome):
    def test_defaults_to_mini_and_never_shows_generic_profile(self):
        name, source = self.core.identity_from_hermes()
        self.assertEqual(name, "Hermes")
        self.assertEqual(source, "default")
        self.assertEqual(self.core.profile_label(), "")

    def test_bot_title_wins_over_display_name(self):
        self.write_profile(
            "display_name: Grace\n"
            "ui_meta:\n"
            "  hermes-bots:\n"
            "    title: Navigator\n"
        )
        name, source = self.core.identity_from_hermes()
        self.assertEqual(name, "Navigator")
        self.assertEqual(source, "bot_title")

    def test_bot_picture_is_inlined_when_the_app_has_none(self):
        assets = self.home / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        (assets / "avatar.png").write_bytes(images.png(32, 32))
        url = self.core.hermes_avatar_data_url()
        self.assertTrue(url.startswith("data:image/png;base64,"), url[:30])

    def test_no_bot_picture_means_no_inline_image(self):
        self.assertEqual(self.core.hermes_avatar_data_url(), "")

    def test_display_name_is_second(self):
        self.write_profile("display_name: Grace\n")
        self.assertEqual(self.core.identity_from_hermes(), ("Grace", "display_name"))

    def test_named_profile_id_is_third(self):
        named = self.home / "profiles" / "writer"
        os.environ["HERMES_HOME"] = str(named)
        try:
            self.assertEqual(self.core.profile_label(), "writer")
            name, source = self.core.identity_from_hermes()
            self.assertEqual((name, source), ("writer", "profile"))
        finally:
            os.environ["HERMES_HOME"] = str(self.home)

    def test_hermes_bot_title_beats_a_stale_saved_name(self):
        self.write_profile("ui_meta:\n  hermes-bots:\n    title: Vesper\n")
        settings = self.core.load_settings()
        settings["agent"]["name"] = "Ada"
        self.core.save_settings(settings)
        identity = self.core.agent_identity()
        self.assertEqual(identity["name"], "Vesper")
        self.assertEqual(identity["source"], "bot_title")

    def test_saving_identity_does_not_touch_profile_yaml(self):
        profile = self.write_profile("display_name: Grace\n")
        before = profile.read_bytes()
        self.core.save_identity("Ada", images.png(64, 64), complete=True)
        self.assertEqual(profile.read_bytes(), before)
        self.assertEqual(self.core.load_settings()["agent"]["name"], "Ada")

    def test_completing_setup_requires_the_users_own_picture(self):
        with self.assertRaises(ValueError):
            self.core.save_identity("Ada", None, complete=True)

    def test_renaming_later_keeps_the_saved_picture(self):
        self.core.save_identity("Ada", images.png(64, 64), complete=True)
        first = self.core.load_settings()["agent"]["avatar"]
        self.assertTrue(first)
        self.core.save_identity("Grace", None, complete=True)
        settings = self.core.load_settings()
        self.assertEqual(settings["agent"]["name"], "Grace")
        self.assertEqual(settings["agent"]["avatar"], first)


if __name__ == "__main__":
    unittest.main()
