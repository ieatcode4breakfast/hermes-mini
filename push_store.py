"""Web Push for Hermes Mini: subscriptions, RFC 8291 encryption, VAPID, and a queue-backed sender.

Loaded by both halves of the plugin (``__init__.py`` and ``dashboard/plugin_api.py``) under the
single fixed ``sys.modules`` name ``hermes_mini_push`` so subscription state, the VAPID key, the
dedupe table and the sender thread are shared.

Everything writable lives in ``$HERMES_HOME/data/hermes-mini/push`` resolved per call, never in the
plugin package. The optional crypto/HTTP libraries are imported lazily: when they are missing push
simply turns itself off instead of breaking a chat turn.

The VAPID private key is generated only when the user explicitly turns notifications on. Reading
the public key, probing availability, importing this module and starting Hermes never create it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import queue
import struct
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


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

log = logging.getLogger("hermes_mini.push")

VAPID_TTL = 12 * 3600
MAX_SUBSCRIPTIONS = 20
RECORD_SIZE = 4096
MAX_PAYLOAD_BYTES = 3000
BODY_CHARS = 180
MATCH_MIN_CHARS = 40  # a shortened deep-link match still has to be long enough to pick one reply out
DEDUPE_SECONDS = 30.0
# RFC 2606 reserved name: a truthful "not a real domain" fallback, never a personal address.
SUB_FALLBACK = "https://hermes-mini.invalid"

# Reentrant: generate_key() holds it while it calls _load_private_key(), which takes it again.
_lock = threading.RLock()
_subs: list[dict[str, Any]] | None = None
_muted: set[str] | None = None
_private_key: Any = None
_private_key_path: str | None = None
_recent: dict[tuple[str, str, str], float] = {}
_queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=200)
_sender: threading.Thread | None = None
_sender_lock = threading.Lock()


# ---------- paths ----------


def _push_dir() -> Path:
    return mini_core.data_dir() / "push"


def _key_path() -> Path:
    return _push_dir() / "vapid_private.pem"


def _subs_path() -> Path:
    return _push_dir() / "subscriptions.json"


def _muted_path() -> Path:
    return _push_dir() / "muted-sessions.json"


def _shown_path() -> Path:
    return _push_dir() / "shown.json"


def _ensure_dir() -> Path:
    path = _push_dir()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


# ---------- base64url ----------


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(value: str) -> bytes:
    value = (value or "").strip()
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)


# ---------- files ----------


def _atomic_write(path: Path, data: bytes) -> None:
    """Temp file in the same directory, then ``os.replace``: readers never see half a file."""
    _ensure_dir()
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_subscriptions() -> list[dict[str, Any]]:
    try:
        raw = _subs_path().read_bytes()
    except FileNotFoundError:
        return []
    except OSError as exc:
        log.warning("push: cannot read subscriptions: %s", exc)
        return []
    try:
        data = json.loads(raw or b"[]")
    except (ValueError, UnicodeDecodeError):
        log.warning("push: subscriptions.json is not valid JSON; starting empty")
        return []
    if isinstance(data, dict):
        data = data.get("subscriptions") or []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict) and item.get("endpoint")]


def _write_subscriptions(subs: list[dict[str, Any]]) -> None:
    _atomic_write(_subs_path(), json.dumps(subs, ensure_ascii=False, indent=2).encode("utf-8"))


def _load() -> list[dict[str, Any]]:
    global _subs
    if _subs is None:
        _subs = _read_subscriptions()
    return _subs


def _persist() -> None:
    _write_subscriptions(_load())


# ---------- muted sessions ----------


def _read_muted() -> set[str]:
    try:
        raw = _muted_path().read_bytes()
    except FileNotFoundError:
        return set()
    except OSError as exc:
        log.warning("push: cannot read muted-sessions.json: %s", exc)
        return set()
    try:
        data = json.loads(raw or b"[]")
    except (ValueError, UnicodeDecodeError):
        log.warning("push: muted-sessions.json is not valid JSON; starting empty")
        return set()
    if isinstance(data, dict):
        data = data.get("muted") or []
    if not isinstance(data, list):
        return set()
    return {str(x) for x in data if isinstance(x, str) and x}


def _load_muted() -> set[str]:
    global _muted
    if _muted is None:
        _muted = _read_muted()
    return _muted


def _write_muted(muted: set[str]) -> None:
    _atomic_write(_muted_path(), json.dumps(sorted(muted), ensure_ascii=False, indent=2).encode("utf-8"))


def is_muted(session_id: str) -> bool:
    if not session_id:
        return False
    with _lock:
        return str(session_id).strip() in _load_muted()


def get_muted_sessions() -> list[str]:
    with _lock:
        return sorted(_load_muted())


def set_muted(session_id: str, muted: bool) -> list[str]:
    sid = str(session_id or "").strip()
    if not sid:
        return get_muted_sessions()
    with _lock:
        current = _load_muted()
        if muted:
            current.add(sid)
        else:
            current.discard(sid)
        _write_muted(current)
        return sorted(current)


# ---------- VAPID key ----------


def crypto_available() -> bool:
    """True when the optional crypto library imports; a passive probe that installs nothing."""
    try:
        import cryptography  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def httpx_available() -> bool:
    try:
        import httpx  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def keys_exist() -> bool:
    """Whether a VAPID key has been generated for this profile. A pure read."""
    return _key_path().is_file()


def _load_private_key():
    """Load the saved key, or return None when it does not exist. Never generates."""
    global _private_key, _private_key_path
    path = str(_key_path())
    if _private_key is not None and _private_key_path == path:
        return _private_key
    with _lock:
        if _private_key is not None and _private_key_path == path:
            return _private_key
        try:
            pem = Path(path).read_bytes()
        except FileNotFoundError:
            return None
        from cryptography.hazmat.primitives import serialization

        _private_key = serialization.load_pem_private_key(pem, password=None)
        _private_key_path = path
        return _private_key


def generate_key() -> Any:
    """Create the VAPID key on explicit opt-in. Called only from the enable/subscribe routes."""
    global _private_key, _private_key_path
    with _lock:
        existing = _load_private_key()
        if existing is not None:
            return existing
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        _ensure_dir()
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        _atomic_write(_key_path(), pem)
        _private_key = key
        _private_key_path = str(_key_path())
        return key


def _private_key_obj():
    key = _load_private_key()
    if key is None:
        raise RuntimeError("no VAPID key yet")
    return key


def public_key_b64url() -> str | None:
    """The browser's applicationServerKey, or None when push has never been enabled here."""
    from cryptography.hazmat.primitives import serialization

    key = _load_private_key()
    if key is None:
        return None
    point = key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    return b64url_encode(point)


def ensure_public_key_b64url() -> str:
    """Generate on explicit opt-in and return the public key (raises without the crypto library)."""
    from cryptography.hazmat.primitives import serialization

    point = generate_key().public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    return b64url_encode(point)


# ---------- subscriptions ----------


def add_subscription(sub: Any) -> dict[str, Any]:
    """Add or replace one subscription (dedupe by endpoint), keeping at most 20, newest last."""
    endpoint = ""
    keys: dict[str, str] = {}
    user_agent = ""
    if isinstance(sub, dict):
        endpoint = str(sub.get("endpoint") or "").strip()
        raw_keys = sub.get("keys")
        if isinstance(raw_keys, dict):
            keys = {
                "p256dh": str(raw_keys.get("p256dh") or ""),
                "auth": str(raw_keys.get("auth") or ""),
            }
        user_agent = str(sub.get("user_agent") or "")[:300]
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("subscription needs an endpoint and keys.p256dh/keys.auth")
    entry = {
        "endpoint": endpoint,
        "keys": keys,
        "created_at": time.time(),
        "user_agent": user_agent,
    }
    with _lock:
        subs = _load()
        subs[:] = [item for item in subs if item.get("endpoint") != endpoint]
        subs.append(entry)
        if len(subs) > MAX_SUBSCRIPTIONS:
            del subs[: len(subs) - MAX_SUBSCRIPTIONS]
        _persist()
        return dict(entry)


def remove_subscription(endpoint: str) -> bool:
    endpoint = str(endpoint or "").strip()
    if not endpoint:
        return False
    with _lock:
        subs = _load()
        before = len(subs)
        subs[:] = [item for item in subs if item.get("endpoint") != endpoint]
        removed = len(subs) != before
        if removed:
            _persist()
        return removed


def list_subscriptions() -> list[dict[str, Any]]:
    with _lock:
        return [json.loads(json.dumps(item)) for item in _load()]


# ---------- RFC 8291 encryption ----------


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    """RFC 5869 expand, one block is enough for the 32/16/12-byte outputs here."""
    output = b""
    counter = 1
    while len(output) < length:
        output += hmac.new(prk, info + bytes([counter]), hashlib.sha256).digest()
        counter += 1
    return output[:length]


def encrypt_payload(
    payload: bytes,
    p256dh_b64: str,
    auth_b64: str,
    *,
    ephemeral_key: Any = None,
    salt: bytes | None = None,
) -> bytes:
    """Encrypt one push message as aes128gcm (RFC 8188) with the RFC 8291 key schedule.

    ``ephemeral_key`` and ``salt`` are injectable only so the RFC 8291 Appendix A vector can be
    reproduced byte for byte; production callers leave them None.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    curve = ec.SECP256R1()
    ua_public = b64url_decode(p256dh_b64)
    auth_secret = b64url_decode(auth_b64)
    if len(auth_secret) != 16:
        raise ValueError("auth secret must be 16 bytes")
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(curve, ua_public)

    if ephemeral_key is None:
        ephemeral_key = ec.generate_private_key(curve)
    as_public = ephemeral_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    if salt is None:
        salt = os.urandom(16)
    if len(salt) != 16:
        raise ValueError("salt must be 16 bytes")

    ecdh_secret = ephemeral_key.exchange(ec.ECDH(), ua_key)

    prk_key = hmac.new(auth_secret, ecdh_secret, hashlib.sha256).digest()
    key_info = b"WebPush: info\x00" + ua_public + as_public
    ikm = _hkdf_expand(prk_key, key_info, 32)

    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)

    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)

    header = salt + struct.pack(">I", RECORD_SIZE) + bytes([len(as_public)]) + as_public
    return header + ciphertext


def _encrypt_for(subscription: dict[str, Any], payload: bytes) -> bytes:
    keys = subscription.get("keys") or {}
    return encrypt_payload(payload, keys.get("p256dh", ""), keys.get("auth", ""))


# ---------- VAPID (RFC 8292) ----------


def _b64url_json(value: Any) -> str:
    return b64url_encode(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def vapid_subject(origin: str = "") -> str:
    """The VAPID ``sub`` claim: an app/operator-set contact or Hermes' configured public URL, else the
    request origin."""
    configured = mini_core.configured_public_origin()
    for candidate in (configured, origin):
        url = mini_core.clean_public_url(candidate)
        if url:
            return url
    return SUB_FALLBACK


def vapid_jwt(endpoint: str, now: float | None = None, *, origin: str = "") -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    parts = urlsplit(endpoint)
    aud = f"{parts.scheme}://{parts.netloc}"
    issued = int(now if now is not None else time.time())
    header = {"typ": "JWT", "alg": "ES256"}
    claims = {"aud": aud, "exp": issued + VAPID_TTL, "sub": vapid_subject(origin)}
    signing_input = f"{_b64url_json(header)}.{_b64url_json(claims)}".encode("ascii")
    der = _private_key_obj().sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{signing_input.decode('ascii')}.{b64url_encode(signature)}"


def vapid_headers(endpoint: str, *, origin: str = "") -> dict[str, str]:
    token = vapid_jwt(endpoint, origin=origin)
    return {
        "Authorization": f"vapid t={token}, k={public_key_b64url()}",
        "Content-Encoding": "aes128gcm",
        "TTL": "3600",
        "Urgency": "high",
        "Content-Type": "application/octet-stream",
    }


def _post(endpoint: str, body: bytes, *, origin: str = "") -> int:
    import httpx

    with httpx.Client(timeout=10.0) as client:
        response = client.post(endpoint, content=body, headers=vapid_headers(endpoint, origin=origin))
        return int(response.status_code)


# ---------- sender ----------


def _host(endpoint: str) -> str:
    try:
        return urlsplit(endpoint).hostname or endpoint[:60]
    except ValueError:
        return endpoint[:60]


# Queue-only field: a subscription endpoint the item must not be sent to (dismiss's reader). Never in the payload.
_SKIP_KEY = "_skip_endpoint"


def _broadcast(payload: dict[str, Any]) -> None:
    payload = dict(payload)
    skip = str(payload.pop(_SKIP_KEY, "") or "")
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    subscriptions = list_subscriptions()
    if not subscriptions:
        log.debug("push: no subscriptions, dropping %s", payload.get("kind"))
        return
    for sub in subscriptions:
        endpoint = str(sub.get("endpoint") or "")
        if skip and endpoint == skip:
            continue
        try:
            body = _encrypt_for(sub, data)
            status = _post(endpoint, body)
        except Exception as exc:  # noqa: BLE001 - one bad subscription must not stop the others
            log.warning("push: send to %s failed: %s", _host(endpoint), exc)
            continue
        if status in (404, 410):
            remove_subscription(endpoint)
            log.info("push: removed gone subscription %s (%s)", _host(endpoint), status)
        elif status >= 400:
            log.warning("push: %s answered HTTP %s", _host(endpoint), status)


def _drain() -> None:
    while True:
        item = _queue.get()
        try:
            if item is not None:
                _broadcast(item)
        except Exception as exc:  # noqa: BLE001 - the sender thread must never die
            log.warning("push: broadcast failed: %s", exc)
        finally:
            _queue.task_done()


def _ensure_sender() -> None:
    global _sender
    if _sender is not None and _sender.is_alive():
        return
    with _sender_lock:
        if _sender is not None and _sender.is_alive():
            return
        thread = threading.Thread(target=_drain, name="hermes-mini-push-sender", daemon=True)
        thread.start()
        _sender = thread


# ---------- public notification entry point ----------


def _dedupe(key: tuple[str, str, str], now: float) -> bool:
    with _lock:
        cutoff = now - DEDUPE_SECONDS
        for old in [item for item, stamp in _recent.items() if stamp < cutoff]:
            _recent.pop(old, None)
        if key in _recent:
            return True
        _recent[key] = now
        return False


def _payload_size(payload: dict[str, Any]) -> int:
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def _fit_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Trim the long strings until the payload fits the push limit.

    Trimmed in this order: ``body`` to BODY_CHARS, then the deep-link ``match`` (shortening it keeps
    it a valid prefix of the reply, so the app still finds the message), then ``body`` down, and
    only a payload that still does not fit loses the ``match`` entirely.
    """
    body = payload.get("body")
    if isinstance(body, str) and len(body) > BODY_CHARS:
        payload["body"] = body[:BODY_CHARS]
    while _payload_size(payload) > MAX_PAYLOAD_BYTES:
        match = payload.get("match")
        if isinstance(match, str) and len(match) > MATCH_MIN_CHARS:
            keep = max(MATCH_MIN_CHARS, len(match) - 20)
            payload["match"] = match[:keep]
            continue
        body = payload.get("body") or ""
        if not body:
            break
        payload["body"] = body[:-20] if len(body) > 20 else ""
    if _payload_size(payload) > MAX_PAYLOAD_BYTES:
        payload.pop("match", None)
    return payload


# ---------- retracting a notification once its chat is read ----------
# A reply or job notification stays on a device until tapped or swiped. When the chat is read anywhere (the app's
# /seen mark), every other device is sent a "dismiss" push that closes that chat's notifications and shows nothing
# (the reader closes its own; /seen passes its endpoint so it is skipped). The
# hooks (gateway process) record which chats have a notification out in shown.json; the /seen route (dashboard
# process) reads it, so a dismiss is only sent for a chat that was actually notified, at most once per notification.
# That keeps silent pushes rare, which browsers require of a push subscription.
DISMISSABLE_KINDS = ("reply", "job")
MAX_SHOWN = 200


def _shown_lock():
    """An exclusive lock across the gateway and dashboard processes (a no-op where fcntl is missing)."""
    import contextlib

    @contextlib.contextmanager
    def held():
        try:
            import fcntl
        except ImportError:
            yield
            return
        _ensure_dir()
        with open(_push_dir() / ".shown.lock", "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    return held()


def _read_shown() -> dict[str, int]:
    try:
        data = json.loads(_shown_path().read_bytes() or b"{}")
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        log.warning("push: cannot read shown.json: %s", exc)
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): int(v) for k, v in data.items() if isinstance(k, str) and k and isinstance(v, (int, float))}


def _write_shown(shown: dict[str, int]) -> None:
    if len(shown) > MAX_SHOWN:
        shown = dict(sorted(shown.items(), key=lambda item: item[1], reverse=True)[:MAX_SHOWN])
    _atomic_write(_shown_path(), json.dumps(shown, ensure_ascii=False).encode("utf-8"))


def _note_shown(session_id: str, now: float) -> None:
    try:
        with _shown_lock():
            shown = _read_shown()
            shown[session_id] = int(now)
            _write_shown(shown)
    except Exception as exc:  # noqa: BLE001 - only the later retraction is lost
        log.warning("push: cannot record shown notification: %s", exc)


def dismiss(session_id: str, seen_at: float, reader_endpoint: str = "") -> bool:
    """Retract a read chat's notifications on the other devices. Returns True when a dismiss push was queued.

    Sent only when a reply or job notification went out for this chat at or before ``seen_at`` (the read mark), and
    only once: the record is cleared as the push is queued. ``reader_endpoint`` is the push subscription of the device
    that read the chat: it closes its own notifications locally, so it is skipped, and when no other device is
    subscribed nothing is sent at all. A push that shows nothing counts against the browser's silent-push allowance.
    Never raises.
    """
    try:
        session_id = str(session_id or "").strip()
        reader_endpoint = str(reader_endpoint or "").strip()
        if not session_id or not keys_exist():
            return False
        with _shown_lock():
            shown = _read_shown()
            sent = shown.get(session_id)
            if sent is None or sent > int(seen_at):
                return False
            shown.pop(session_id, None)
            _write_shown(shown)
        if reader_endpoint and not any(sub.get("endpoint") != reader_endpoint for sub in list_subscriptions()):
            return False  # the reader is the only device: it already closed its own
        item: dict[str, Any] = {"kind": "dismiss", "session_id": session_id, "ts": int(time.time())}
        if reader_endpoint:
            item[_SKIP_KEY] = reader_endpoint
        _queue.put_nowait(item)
        _ensure_sender()
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("push: dismiss failed: %s", exc)
        return False


def notify(kind: str, title: str, body: str, session_id: str = "", tag: str = "", **extra: Any) -> bool:
    """Queue one push for every subscription. Returns True when it was queued, never raises."""
    try:
        if not keys_exist():
            return False  # notifications were never turned on here
        now = time.time()
        sid = str(session_id or extra.get("session_key") or "").strip()
        if sid and is_muted(sid):
            log.debug("push: session %s is muted, skipped", sid)
            return False
        session_id = str(session_id or "")
        tag = str(tag or "")
        key = (str(kind or ""), session_id, tag)
        if _dedupe(key, now):
            log.debug("push: duplicate %s within %.0fs, skipped", key, DEDUPE_SECONDS)
            return False
        payload: dict[str, Any] = {
            "kind": str(kind or ""),
            "title": str(title or mini_core.agent_identity()["name"])[:120],
            "body": str(body or ""),
            "session_id": session_id,
            "tag": tag,
            "ts": int(now),
        }
        for name, value in extra.items():
            if value is not None:
                payload[name] = value
        payload = _fit_payload(payload)
        _queue.put_nowait(payload)
        _ensure_sender()
        if session_id and payload["kind"] in DISMISSABLE_KINDS:
            _note_shown(session_id, now)
        return True
    except Exception as exc:  # noqa: BLE001 - notifications are best effort, never a turn failure
        log.warning("push: notify failed: %s", exc)
        return False
