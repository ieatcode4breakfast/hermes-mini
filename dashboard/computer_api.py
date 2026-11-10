"""Optional computer-module backend: authenticated clipboard access.

The viewer itself is the bundled ``dashboard/computer`` module and the stream is Hermes' own
``/api/display/ws`` (single-use display ticket + control lease). This router only adds the two
clipboard verbs. Hermes starts the desktop with ``-SendCutText=0`` so watchers never receive the
holder's clipboard over RFB; reading it here instead keeps that rule while letting the person who
holds control copy and paste.

Authorization is Hermes' Bot Desktop lease (``tools.bot_desktop.lease.human_holds``): only the
person who currently holds control may read or write the clipboard. Every route is mounted under the
authenticated ``/api`` scope, so there is no separate secret and nothing is weakened.

This module is loaded only when the computer routes are requested; the app shell never imports it.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)

router = APIRouter()

# Xvnc's own cut-text limit.
CLIPBOARD_MAX_BYTES = 256 * 1024
IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")
IMAGE_MAX_BYTES = 15 * 1024 * 1024


# Copying reads the X selection straight through Tk, with no external clipboard tool to install or break. The same
# interpreter runs the helper with only the desktop's display and authority. Tk asks for text, so an image-only
# clipboard reads as empty instead of arriving as decoded image bytes.
_CLIPBOARD_READER = r"""
import sys
import tkinter

selection = "PRIMARY" if sys.argv[1] == "primary" else "CLIPBOARD"
root = tkinter.Tk()
root.withdraw()
try:
    try:
        text = (root.selection_get(selection=selection, type="UTF8_STRING")
                if selection == "PRIMARY" else root.clipboard_get(type="UTF8_STRING"))
    except tkinter.TclError:
        text = (root.selection_get(selection=selection, type="STRING")
                if selection == "PRIMARY" else root.clipboard_get(type="STRING"))
except tkinter.TclError:
    text = ""
finally:
    root.destroy()
sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
"""


def _read_desktop_clipboard(which: str = "clipboard") -> str:
    import os
    import subprocess
    import sys

    from tools.bot_desktop.runtime import published_env

    env = published_env()
    if not env or not env.get("DISPLAY"):
        raise RuntimeError("desktop not running")
    child_env = {
        "PATH": "/usr/bin:/bin",
        "HOME": os.environ.get("HOME", "/root"),
        **{k: env[k] for k in ("DISPLAY", "XAUTHORITY", "LANG", "LC_ALL") if env.get(k)},
    }
    try:
        done = subprocess.run(
            [sys.executable, "-c", _CLIPBOARD_READER, which],
            env=child_env, capture_output=True, timeout=3, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return ""  # the helper could not start or the display did not answer
    if done.returncode != 0:
        return ""
    return done.stdout[:CLIPBOARD_MAX_BYTES].decode("utf-8", errors="replace")


def _human_holds() -> tuple[bool, str]:
    """``(allowed, refusal)`` from the desktop control lease (the only authority for this verb)."""
    try:
        from tools.bot_desktop import lease

        if not lease.human_holds():
            return False, "take over first"
        return True, ""
    except Exception:  # noqa: BLE001 - without the lease we cannot prove control, so refuse
        log.warning("computer clipboard: lease check failed", exc_info=True)
        return False, "control state unavailable"


@router.get("/clipboard")
async def desktop_clipboard(which: str = "clipboard"):
    """Read the selection on the desktop: ``clipboard`` (Ctrl+C) or ``primary`` (highlighted text)."""
    if which not in ("clipboard", "primary"):
        return JSONResponse({"detail": "which must be clipboard or primary"}, status_code=400)
    allowed, refusal = _human_holds()
    if not allowed:
        return JSONResponse({"detail": refusal}, status_code=403 if refusal == "take over first" else 503)
    try:
        text = await asyncio.to_thread(_read_desktop_clipboard, which)
    except Exception as exc:  # noqa: BLE001
        log.warning("computer clipboard: read failed: %s", exc)
        return JSONResponse({"detail": "could not read the clipboard"}, status_code=500)
    return {"text": text}


def _png_bytes(data: bytes, mime: str) -> tuple[bytes, str]:
    """(bytes, target type) to hand xclip: PNG when Pillow can convert, else the original bytes and type."""
    if mime == "image/png":
        return data, "image/png"
    try:
        import io

        from PIL import Image
    except Exception:  # noqa: BLE001 - no Pillow: xclip advertises the image as it arrived
        return data, mime
    with Image.open(io.BytesIO(data)) as image:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
    return buffer.getvalue(), "image/png"


def _write_desktop_clipboard_image(data: bytes, mime: str) -> None:
    """Put image bytes on the desktop CLIPBOARD selection. Blocking: the route runs it in a worker."""
    import subprocess

    from tools.bot_desktop.runtime import published_env

    data, target = _png_bytes(data, mime)
    env = published_env()
    if not env or not env.get("DISPLAY"):
        raise RuntimeError("desktop not running")
    child_env = {"PATH": "/usr/bin:/bin", **{k: v for k, v in env.items() if k in ("DISPLAY", "XAUTHORITY")}}
    # xclip forks a child to own the selection after reading stdin, so stdout/stderr go to DEVNULL:
    # otherwise that child keeps our pipes open and subprocess.run waits on it until the timeout.
    done = subprocess.run(
        ["xclip", "-selection", "clipboard", "-t", target, "-i"],
        input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=child_env, timeout=5,
    )
    if done.returncode != 0:
        raise RuntimeError(f"xclip exited {done.returncode}")


async def _read_capped(request: Request, limit: int) -> bytes | None:
    """The request body, or None once it exceeds *limit* (streamed so an oversize upload is not held)."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/clipboard-image")
async def desktop_clipboard_image(request: Request):
    """Set the desktop clipboard to a picture (a screenshot from the device)."""
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if mime not in IMAGE_TYPES:
        return JSONResponse({"detail": "send a PNG, JPEG, WebP or GIF image"}, status_code=415)
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > IMAGE_MAX_BYTES:
        return JSONResponse({"detail": "image too large"}, status_code=413)
    allowed, refusal = _human_holds()
    if not allowed:
        return JSONResponse({"detail": refusal}, status_code=403 if refusal == "take over first" else 503)
    try:
        body = await _read_capped(request, IMAGE_MAX_BYTES)
    except Exception as exc:  # noqa: BLE001 - client went away mid-upload
        log.warning("computer clipboard image: upload failed: %s", exc)
        return JSONResponse({"detail": "could not read the image"}, status_code=400)
    if body is None:
        return JSONResponse({"detail": "image too large"}, status_code=413)
    if not body:
        return JSONResponse({"detail": "empty image"}, status_code=400)
    try:
        await asyncio.to_thread(_write_desktop_clipboard_image, body, mime)
    except Exception as exc:  # noqa: BLE001
        log.warning("computer clipboard image: write failed: %s", exc)
        return JSONResponse({"detail": "could not set the clipboard"}, status_code=500)
    return {"ok": True}
