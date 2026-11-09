"""Hermes Mini core: profile-scoped paths, external settings, identity, and asset validation.

Loaded by both halves of the plugin (``__init__.py`` and ``dashboard/plugin_api.py``) under the
single fixed ``sys.modules`` name ``hermes_mini_core`` so they share one implementation. The two
halves are imported under different module names by Hermes, so a plain relative import would give
them separate module objects.

Everything here is resolved *per call* from Hermes's own home resolver. Nothing is cached at
import time, so a process that serves more than one profile reads and writes the profile it is
acting for. The plugin package is never written to: settings live in
``$HERMES_HOME/hermes-mini/config.yaml``, uploaded images in ``$HERMES_HOME/hermes-mini/assets/``,
and mutable app state in ``$HERMES_HOME/data/hermes-mini/``.
"""

from __future__ import annotations

import json
import base64
import logging
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("hermes_mini.core")

PLUGIN_ID = "hermes-mini"
PRODUCT_NAME = "Hermes Mini"
FALLBACK_AGENT_NAME = "Hermes"

# Limits for the user's own profile picture. Small on purpose: it is a chat avatar, not a gallery.
MAX_AVATAR_BYTES = 4 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
MAX_NAME_CHARS = 60
MAX_AVATAR_EDGE = 2048

_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)

DEFAULT_SETTINGS: dict[str, Any] = {
    "schema": 1,
    "agent": {
        "name": "",
        "avatar": "",
        "home_label": "",
    },
    "onboarding": {
        "complete": False,
        "completed_at": None,
    },
    "server": {
        "public_url": "",
    },
    "push": {
        "contact": "",
    },
}


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def hermes_home() -> Path:
    """The active Hermes home, resolved through Hermes's own resolver on every call.

    Falls back to ``$HERMES_HOME`` and then ``~/.hermes`` for the isolated test harness, where the
    Hermes package may not be importable. The fallback is the documented platform default, not a
    hard-coded profile.
    """
    try:
        from hermes_constants import get_hermes_home  # documented plugin-safe helper

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - importable from a test harness without Hermes
        env = os.environ.get("HERMES_HOME", "").strip()
        return Path(env).expanduser() if env else Path.home() / ".hermes"


def app_dir() -> Path:
    """``$HERMES_HOME/hermes-mini`` — settings and user assets."""
    return hermes_home() / PLUGIN_ID


def config_path() -> Path:
    return app_dir() / "config.yaml"


def assets_dir() -> Path:
    return app_dir() / "assets"


def data_dir() -> Path:
    """``$HERMES_HOME/data/hermes-mini`` — mutable state, outside the package."""
    return hermes_home() / "data" / PLUGIN_ID


def data_file(name: str) -> Path:
    return data_dir() / name


def instructions_path() -> Path:
    """Optional operator-supplied app instructions, never bundled and never written by the plugin."""
    return data_dir() / "app-instructions.md"


def package_dir() -> Path:
    return Path(__file__).resolve().parent


def find_hermes_executable() -> str | None:
    """Locate the Hermes launcher for the restart route without hard-coding a user path.

    Order: ``$HERMES_BIN``, the executable that started this process's server if it is a Hermes
    launcher, ``shutil.which("hermes")``, then the conventional wrapper beside the running Python.
    """
    env = os.environ.get("HERMES_BIN", "").strip()
    if env and Path(env).is_file():
        return env
    # The wrapper that launched this process, when it is the hermes entry point.
    candidate = Path(sys.argv[0]).expanduser() if sys.argv and sys.argv[0] else None
    if candidate and candidate.name == "hermes" and candidate.is_file():
        return str(candidate)
    found = shutil.which("hermes")
    if found:
        return found
    # Last resort: the conventional per-user wrapper beside the running interpreter's bin directory.
    sibling = Path(sys.executable).resolve().parent / "hermes"
    if sibling.is_file():
        return str(sibling)
    home_wrapper = Path.home() / ".local" / "bin" / "hermes"
    return str(home_wrapper) if home_wrapper.is_file() else None


# ---------------------------------------------------------------------------
# Settings files
# ---------------------------------------------------------------------------


def _yaml_loaders():
    """YAML readers in order of preference: Hermes' own policy, then ruamel, then PyYAML.

    Hermes ships ``hermes_yaml``; a bare test harness may only have one of the others. Yielding the
    callables (not the modules) keeps this a per-call lookup, so nothing is cached across profiles.
    """
    loaders = []
    try:
        import hermes_yaml

        loaders.append(hermes_yaml.safe_load)
    except Exception:  # noqa: BLE001 - optional outside a Hermes install
        pass
    try:
        from ruamel.yaml import YAML

        loaders.append(lambda text: YAML(typ="safe", pure=True).load(text))
    except Exception:  # noqa: BLE001
        pass
    try:
        import yaml as _pyyaml

        loaders.append(_pyyaml.safe_load)
    except Exception:  # noqa: BLE001
        pass
    return loaders


def _yaml_module():
    """Hermes' shared YAML policy when available; the dumper is only used for our own settings file."""
    try:
        import hermes_yaml

        return hermes_yaml
    except Exception:  # noqa: BLE001 - optional in a bare test harness
        return None


def read_document(path: Path) -> dict[str, Any]:
    """Read a YAML document, accepting a JSON document too (JSON is valid YAML 1.1).

    Returns ``{}`` for a missing or unreadable file. Never creates anything.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        log.warning("%s: cannot read %s: %s", PLUGIN_ID, path.name, exc)
        return {}
    text = raw.strip()
    if not text:
        return {}
    if text[0] in "{[":
        try:
            data = json.loads(text)
            return data if isinstance(data, dict) else {}
        except ValueError:
            pass
    for load in _yaml_loaders():
        try:
            data = load(text)
        except Exception:  # noqa: BLE001 - try the next reader; a corrupt file is reported below
            continue
        if isinstance(data, dict):
            return data
        if data is not None:
            return {}
    else:
        if not _yaml_loaders():
            log.warning("%s: %s cannot be read without a YAML parser", PLUGIN_ID, path.name)
            return {}
    log.warning("%s: %s is not a YAML mapping", PLUGIN_ID, path.name)
    return {}


def _dump_document(data: dict[str, Any]) -> str:
    module = _yaml_module()
    if module is not None:
        try:
            return module.safe_dump(data, sort_keys=False)
        except Exception:  # noqa: BLE001
            pass
    try:
        from ruamel.yaml import YAML

        from io import StringIO

        buffer = StringIO()
        YAML().dump(data, buffer)
        return buffer.getvalue()
    except Exception:  # noqa: BLE001
        pass
    return json.dumps(data, indent=2, sort_keys=False) + "\n"


def _atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Settings validation and access
# ---------------------------------------------------------------------------


def clean_name(value: Any) -> str:
    text = "" if value is None else str(value)
    text = " ".join(text.split())
    return text[:MAX_NAME_CHARS]


def clean_public_url(value: Any) -> str:
    text = "" if value is None else str(value).strip()
    if not text:
        return ""
    if not re.fullmatch(r"https?://[^\s/]+(?:/[^\s]*)?", text):
        return ""
    if not text.startswith("https://") and not re.match(r"http://(localhost|127\.0\.0\.1|\[::1\])", text):
        return ""
    return text.rstrip("/")


def normalize_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Validate an on-disk document; unknown keys are dropped, bad values fall back to defaults."""
    raw = raw if isinstance(raw, dict) else {}
    agent = raw.get("agent") if isinstance(raw.get("agent"), dict) else {}
    onboarding = raw.get("onboarding") if isinstance(raw.get("onboarding"), dict) else {}
    server = raw.get("server") if isinstance(raw.get("server"), dict) else {}
    push = raw.get("push") if isinstance(raw.get("push"), dict) else {}
    avatar = str(agent.get("avatar") or "").strip()
    if avatar and not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", avatar):
        avatar = ""
    if avatar and not (assets_dir() / avatar).is_file():
        avatar = ""
    completed = onboarding.get("complete") is True
    completed_at = onboarding.get("completed_at")
    settings: dict[str, Any] = {
        "schema": 1,
        "agent": {
            "name": clean_name(agent.get("name")),
            "avatar": avatar,
            "home_label": clean_name(agent.get("home_label")),
        },
        "onboarding": {
            "complete": completed,
            "completed_at": int(completed_at)
            if isinstance(completed_at, (int, float)) and not isinstance(completed_at, bool)
            else None,
        },
        "server": {"public_url": clean_public_url(server.get("public_url"))},
        "push": {"contact": clean_public_url(push.get("contact"))},
    }
    return settings


def load_settings() -> dict[str, Any]:
    """Current settings with bundled defaults. A pure read: creates no file or directory."""
    return normalize_settings(read_document(config_path()))


def save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Validate and atomically persist settings outside the package."""
    normalized = normalize_settings(settings)
    _atomic_write(config_path(), _dump_document(normalized), mode=0o600)
    return normalized


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


def profile_meta() -> dict[str, Any]:
    """``profile.yaml`` of the serving profile, if present (pure read)."""
    path = hermes_home() / "profile.yaml"
    return read_document(path)


def default_hermes_home() -> Path:
    """The default profile's home (``~/.hermes``), also when a named profile is serving."""
    try:
        from hermes_constants import get_default_hermes_root  # documented plugin-safe helper

        return Path(get_default_hermes_root())
    except Exception:  # noqa: BLE001 - derive it from the active home
        home = hermes_home()
        if "profiles" in home.parts:
            index = home.parts.index("profiles")
            return Path(*home.parts[:index])
        return home


def bot_title(home: Path) -> str:
    """The bot title recorded on ``home``'s ``profile.yaml``, or ``""``."""
    meta = read_document(home / "profile.yaml")
    ui_meta = meta.get("ui_meta") if isinstance(meta, dict) else None
    bots = ui_meta.get("hermes-bots") if isinstance(ui_meta, dict) else None
    return clean_name(bots.get("title")) if isinstance(bots, dict) else ""


_HERMES_AVATAR_EXTS = ("png", "jpg", "jpeg", "webp")
_HERMES_AVATAR_MAX_BYTES = 1_500_000


def hermes_avatar() -> Path | None:
    """The picture Hermes stores for the bot (``assets/avatar.<ext>``), default profile first."""
    seen: list[Path] = []
    for home in (default_hermes_home(), hermes_home()):
        if home in seen:
            continue
        seen.append(home)
        for ext in _HERMES_AVATAR_EXTS:
            path = home / "assets" / f"avatar.{ext}"
            if path.is_file():
                return path
    return None


def hermes_avatar_data_url() -> str:
    """The bot picture as an inline ``data:`` URL, or ``""``.

    A plain ``<img src="/api/...">`` cannot carry the dashboard's session token, so the picture
    travels with the identity payload instead of through a protected route. The format is taken
    from the bytes themselves, and an oversized file is ignored rather than bloating every load.
    """
    path = hermes_avatar()
    if path is None:
        return ""
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    if not data or len(data) > _HERMES_AVATAR_MAX_BYTES:
        return ""
    media = sniff_image_type(data)
    if not media:
        return ""
    return f"data:{media};base64,{base64.b64encode(data).decode('ascii')}"


def profile_label() -> str:
    """A non-generic profile id, or ``""``.

    ``default`` and ``custom`` are Hermes' generic names and are never shown to a person as the
    agent's name.
    """
    try:
        from hermes_cli.profiles import get_active_profile_name  # documented profile helper

        name = str(get_active_profile_name() or "").strip()
    except Exception:  # noqa: BLE001 - derive from the home path instead
        home = hermes_home()
        parts = home.parts
        name = ""
        if "profiles" in parts:
            index = parts.index("profiles")
            if index + 1 < len(parts):
                name = parts[index + 1]
        elif home.name == ".hermes":
            name = "default"
    if name.lower() in ("default", "custom", ""):
        return ""
    return clean_name(name)


def identity_from_hermes() -> tuple[str, str]:
    """``(name, source)`` for the serving bot/profile, without renaming anything in Hermes.

    The bot's name is configured on the default profile (``~/.hermes/profile.yaml``), so that
    is read first; a named serving profile may carry its own title.
    """
    title = bot_title(default_hermes_home()) or bot_title(hermes_home())
    if title:
        return title, "bot_title"
    meta = profile_meta()
    display = clean_name(meta.get("display_name"))
    if display:
        return display, "display_name"
    profile = profile_label()
    if profile:
        return profile, "profile"
    return FALLBACK_AGENT_NAME, "default"


def agent_identity() -> dict[str, str]:
    """The name and avatar for user-facing text and images.

    The name is always the Hermes bot's (default profile first, then the serving profile), then
    the display name, a named profile id, and finally ``Mini``. There is no app-level override.
    """
    settings = load_settings()
    name, source = identity_from_hermes()
    return {
        "name": name,
        "source": source,
        "avatar": settings["agent"]["avatar"],
        "home_label": settings["agent"]["home_label"] or name,
        "onboarding_complete": settings["onboarding"]["complete"],
    }


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def sniff_image_type(data: bytes) -> str:
    """The media type from the bytes themselves; ``""`` when it is not an accepted raster image."""
    if not data:
        return ""
    for magic, mime in _IMAGE_MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height = int.from_bytes(data[index + 5:index + 7], "big")
            width = int.from_bytes(data[index + 7:index + 9], "big")
            return width, height
        length = int.from_bytes(data[index + 2:index + 4], "big")
        if length < 2:
            return None
        index += 2 + length
    return None


def image_size(data: bytes, mime: str) -> tuple[int, int] | None:
    """Decode the image and return ``(width, height)``; ``None`` means it did not decode."""
    try:
        import io

        from PIL import Image  # optional: validated structurally when Pillow is missing

        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            return int(image.width), int(image.height)
    except ImportError:
        if mime == "image/png":
            return _png_size(data)
        if mime == "image/jpeg":
            return _jpeg_size(data)
        return (1, 1)
    except Exception:  # noqa: BLE001 - a corrupt image is a validation failure, not an error page
        return None


def validate_avatar(data: bytes) -> tuple[str, str]:
    """Return ``(mime, filename)`` for a valid upload; raise ``ValueError`` with a user-facing reason.

    The filename is generated here, so a hostile or misleading client filename can never reach the
    filesystem. SVG and every other vector/executable format is refused by content sniffing.
    """
    if not data:
        raise ValueError("Choose an image to upload.")
    if len(data) > MAX_AVATAR_BYTES:
        raise ValueError(f"That image is larger than {MAX_AVATAR_BYTES // (1024 * 1024)} MB.")
    mime = sniff_image_type(data)
    if mime not in ALLOWED_IMAGE_TYPES:
        raise ValueError("Use a PNG, JPEG or WebP image.")
    size = image_size(data, mime)
    if not size:
        raise ValueError("That file could not be read as an image.")
    width, height = size
    if width < 16 or height < 16:
        raise ValueError("That image is too small to use.")
    if width > MAX_AVATAR_EDGE or height > MAX_AVATAR_EDGE:
        raise ValueError(f"That image is larger than {MAX_AVATAR_EDGE}x{MAX_AVATAR_EDGE}.")
    extension = ALLOWED_IMAGE_TYPES[mime]
    filename = f"avatar-{int(time.time())}-{os.urandom(6).hex()}{extension}"
    return mime, filename


def save_avatar(data: bytes) -> dict[str, str]:
    """Validate, then write the profile picture under the external assets directory."""
    mime, filename = validate_avatar(data)
    target = assets_dir() / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".avatar-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {"avatar": filename, "mime": mime}


def remove_avatar(filename: str) -> None:
    """Delete a previously saved avatar, staying inside the assets directory."""
    name = Path(str(filename or "")).name
    if not name:
        return
    try:
        (assets_dir() / name).unlink()
    except OSError:
        pass


def save_identity(name: Any, avatar_bytes: bytes | None, complete: bool = True) -> dict[str, Any]:
    """Persist the user-confirmed agent name and an optional new picture.

    Only called from an explicit save request; a page load never reaches this. Completing first-run
    setup requires the person's own picture: a neutral placeholder is shown until then, and an
    install must never be delivered as if somebody had already chosen an identity.
    """
    cleaned = clean_name(name)
    if not cleaned:
        raise ValueError("Enter a name for your agent.")
    settings = load_settings()
    previous = settings["agent"]["avatar"]
    if complete and not settings["onboarding"]["complete"] and avatar_bytes is None and not previous:
        raise ValueError("Choose a picture for your agent.")
    if avatar_bytes is not None:
        saved = save_avatar(avatar_bytes)
        settings["agent"]["avatar"] = saved["avatar"]
    settings["agent"]["name"] = cleaned
    if complete:
        settings["onboarding"]["complete"] = True
        settings["onboarding"]["completed_at"] = int(time.time())
    normalized = save_settings(settings)
    if avatar_bytes is not None and previous and previous != normalized["agent"]["avatar"]:
        remove_avatar(previous)
    return normalized


# ---------------------------------------------------------------------------
# Reading the vanilla install (pure reads only)
# ---------------------------------------------------------------------------


def vanilla_config() -> dict[str, Any]:
    """Hermes' own ``config.yaml`` for the serving profile, read-only."""
    return read_document(hermes_home() / "config.yaml")


def configured_public_origin(configured: dict[str, Any] | None = None) -> str:
    """A stable contact origin for the VAPID ``sub`` claim.

    The app's own external setting wins, then Hermes' configured dashboard public URL, then the
    request origin (the route supplies it). No personal domain is ever baked in.
    """
    settings = load_settings()
    for candidate in (settings["push"]["contact"], settings["server"]["public_url"]):
        if candidate:
            return candidate
    config = configured if configured is not None else vanilla_config()
    dashboard = config.get("dashboard") if isinstance(config.get("dashboard"), dict) else {}
    url = clean_public_url(dashboard.get("public_url"))
    if url:
        return url
    gateway = config.get("gateway") if isinstance(config.get("gateway"), dict) else {}
    url = clean_public_url(gateway.get("public_url"))
    if url:
        return url
    return ""


def model_configured(config: dict[str, Any] | None = None) -> bool:
    """Whether Hermes has a model selected, so the app can offer friendly setup guidance."""
    config = config if config is not None else vanilla_config()
    model = config.get("model")
    if isinstance(model, str):
        return bool(model.strip())
    if not isinstance(model, dict):
        return False
    default = model.get("default") or model.get("model")
    if isinstance(default, dict):
        default = default.get("model") or default.get("default")
    if isinstance(default, str) and default.strip():
        return True
    return bool(str(model.get("base_url") or "").strip())
