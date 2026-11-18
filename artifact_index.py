"""Artifacts the agent produced in the app's chats: the extraction rules, with no I/O.

This is the pure half of the read-only ``GET /artifacts`` route. It turns stored message text into
candidate values (a delivered ``MEDIA:`` tag, a markdown image or link, a bare URL, an absolute
path) and a tool row's payload into the files and links it names, following the Hermes desktop
app's artifact rules. Deduplication and item shape live in ``collect_rows``.

Nothing here opens a file, reads ``state.db``, or imports Hermes or FastAPI. The route in
``dashboard/plugin_api.py`` supplies the rows and filters values it cannot show in a browser
(``data:`` URIs, relative paths, paths with control characters).
"""

from __future__ import annotations

import json
import re
from urllib.parse import unquote, urlsplit
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Patterns (ported from the desktop app's desktop-artifact-utils.ts)
# ---------------------------------------------------------------------------

MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
# No backslash or non-ASCII: a URL inside escaped JSON or a terminal frame ends where the escape or box drawing starts.
URL_RE = re.compile(r"https?://[^\s<>\"')`\\\u0080-\uffff]+")
URL_TAIL = ".,;:!?*_~"
PATH_RE = re.compile(
    r"(^|[\s(\"'`])((?:/|~[\\/]|\.\.?[\\/]|\\\\)[^\s\"'`<>]+(?:\.[a-z0-9]{1,8})?)", re.IGNORECASE
)
WINDOWS_PATH_RE = re.compile(r"(^|[\s(\"'`])([A-Za-z]:[\\/][^\s\"'`<>]+(?:\.[a-z0-9]{1,8})?)", re.IGNORECASE)
IMAGE_EXT_RE = re.compile(r"\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?.*)?$", re.IGNORECASE)
FILE_EXT_RE = re.compile(
    r"\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|txt|json|md|csv|xlsx?|docx?|pptx?|html|zip|tar|gz|avi|flac|m4a|mkv"
    r"|mp3|ogg|opus|wav|webm|mp4|mov)(?:\?.*)?$",
    re.IGNORECASE,
)

# A tool name that produces deliverables: create/download/export/generate/render/save/speak/write.
ARTIFACT_PRODUCER_TOOL_RE = re.compile(
    r"(?:^|_)(?:creat(?:e|ion)|download|export|generat(?:e|ion)|render|save|speech|tts|write)(?:_|$)", re.IGNORECASE
)

STRONG_TOOL_ARTIFACT_KEY_RE = re.compile(
    r"^(?:artifact_(?:file|image|path|url)|files?_(?:created|modified|written)|generated_(?:file|image|path|url)"
    r"|media_tag|output_(?:file|path|url)|result_(?:file|path|url)|saved_to|screenshot_path)$",
    re.IGNORECASE,
)
PRODUCER_TOOL_ARTIFACT_KEY_RE = re.compile(
    r"^(?:artifact(?:s|_(?:file|image|path|url))?|attachment(?:s|_(?:file|image|path|url))?"
    r"|download(?:s|_(?:file|path|url))?|(?:audio|image|video)(?:_(?:file|path|url))?|file_path|local_path"
    r"|media(?:_(?:file|path|url))?|path)$",
    re.IGNORECASE,
)
SHELL_OUTPUT_KEY_RE = re.compile(r"^(?:output|stdout|path)$", re.IGNORECASE)
SCREENSHOT_PATH_RE = re.compile(r"Screenshot path:\s*([^\r\n<>]+)", re.IGNORECASE)

# Hermes' native attachment directive (the same syntax dashboard/media-path.js parses).
MEDIA_TAG_RE = re.compile(
    r"\bMEDIA:\s*(?:\"([^\"\n]+)\"|'([^'\n]+)'|`([^`\n]+)`|([^\s\"'`*<>]+))", re.IGNORECASE
)

# pip's own traffic is not session output: it logs every wheel it downloads and keeps files in its cache.
PIP_CACHE_DIR_RE = re.compile(r"/(?:\.cache/pip|library/caches/pip|appdata/local/pip/cache)/")
WHEEL_RE = re.compile(r"\.whl(?:\.metadata)?$")
PACKAGE_INDEX_DIST_RE = re.compile(r"/packages/.+\.(?:tar\.gz|tar\.bz2|zip|egg)(?:\.metadata)?$")

_UNQUOTE_RE = re.compile(r"[`\"'*_]{1,3}$")
_TRAILING_MARKS_RE = re.compile(r"[`*]+$")
_TRAILING_PUNCT_RE = re.compile(r"[),.;]+$")
_BARE_TRAILER_RE = re.compile(r"[.,;:!?)\]}]+$")
_UNSAFE_RE = re.compile(r"[\x00-\x1f\"'<>]")
_DIGITS_RE = re.compile(r"\d+")

MAX_VALUE_CHARS = 4096

# A pushValue callback: a candidate value plus whether the author delivered it explicitly (a MEDIA: tag,
# or an explicit artifact key in a tool payload) rather than a path scraped out of prose.
PushValue = Callable[[str, bool], None]


# ---------------------------------------------------------------------------
# Value rules
# ---------------------------------------------------------------------------


def normalize(value: Any) -> str:
    """The value with surrounding quotes and trailing prose marks removed (desktop normalizeValue)."""
    text = "" if value is None else str(value).strip()
    for _ in range(3):
        if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'`":
            text = text[1:-1].strip()
        else:
            break
    text = _TRAILING_MARKS_RE.sub("", text)
    return _TRAILING_PUNCT_RE.sub("", text)


def _decode_media_href(value: str) -> str:
    """Chat renders a file ref as ``[label](#media:<encoded path>)``; keep the path, not the href."""
    if not value.startswith("#media:"):
        return value
    try:
        return unquote(value[len("#media:"):])
    except (ValueError, UnicodeDecodeError):
        return value


def _excluded(value: str) -> bool:
    """Values the app cannot show: inline data, relative paths, unsafe characters, absurd length."""
    return (
        not value
        or len(value) > MAX_VALUE_CHARS
        or value.startswith("data:")
        or value.startswith(("./", "../", ".\\", "..\\"))
        or bool(_UNSAFE_RE.search(value))
    )


def _is_python_package_download(value: str) -> bool:
    if value.startswith(("http://", "https://", "file://")):
        try:
            path = unquote(urlsplit(value).path).lower()
        except ValueError:
            path = value.replace("\\", "/").lower()
    else:
        path = value.replace("\\", "/").lower()
    return bool(
        PIP_CACHE_DIR_RE.search(path)
        or WHEEL_RE.search(path)
        or (value.startswith(("http://", "https://")) and PACKAGE_INDEX_DIST_RE.search(path))
    )


def _is_local_path(value: str) -> bool:
    return value.startswith("/") or value.startswith("~/")


def looks_like_artifact(value: str, explicit: bool = False) -> bool:
    """Whether a value belongs in the artifacts list.

    Every http(s) URL is a link. A local path needs an image/file extension unless it was delivered
    explicitly, where it is an artifact even with an unknown extension. Relative paths, inline data,
    and pip's own downloads are never artifacts here.
    """
    if _excluded(value):
        return False
    if not explicit and _is_python_package_download(value):
        return False
    if value.startswith(("http://", "https://")):
        return True
    is_local = _is_local_path(value)
    if not is_local:
        return False
    # A path that is not explicitly delivered needs a known extension: an extensionless path scraped
    # from prose is usually a command or a directory, not something to show.
    return bool(explicit or IMAGE_EXT_RE.search(value) or FILE_EXT_RE.search(value))


def kind(value: str) -> str:
    """``"image"`` for a picture, ``"file"`` for a local deliverable, ``"link"`` for a URL."""
    if IMAGE_EXT_RE.search(value):
        return "image"
    if _is_local_path(value):
        return "file"
    return "link"


def label(value: str) -> str:
    """The file name for a path; the host and path for a link."""
    if value.startswith(("http://", "https://")):
        try:
            parts = urlsplit(value)
        except ValueError:
            return value
        return f"{parts.netloc}{parts.path}" or value
    parts = [part for part in re.split(r"[\\/]", value) if part]
    return parts[-1] if parts else value


# ---------------------------------------------------------------------------
# MEDIA: tags (dashboard/media-path.js mediaTags())
# ---------------------------------------------------------------------------


def _unquote_media(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'`":
        return text[1:-1]
    return _UNQUOTE_RE.sub("", text)


def _plausible_media_path(value: str) -> bool:
    text = _unquote_media(value)
    return bool(text) and _is_local_path(text) and not text.startswith("//") and not _excluded(text)


def media_values(text: str) -> list[str]:
    """The paths in ``MEDIA:`` tags; a bare tag sheds the sentence punctuation that follows it."""
    found: list[str] = []
    for match in MEDIA_TAG_RE.finditer(str(text or "")):
        quoted = match.group(1) or match.group(2) or match.group(3)
        raw = quoted if quoted is not None else (match.group(4) or "")
        if quoted is None:
            raw = _BARE_TRAILER_RE.sub("", raw)
        if not _plausible_media_path(raw):
            continue
        found.append(_unquote_media(raw))
    return found


# ---------------------------------------------------------------------------
# Tool payloads
# ---------------------------------------------------------------------------


def _parse_maybe_json(value: str) -> Any:
    if not value.strip():
        return None
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return None


def _untrusted_tool_payload(value: str) -> str | None:
    """The payload inside ``<untrusted_tool_result>…</untrusted_tool_result>``, if that is the shape."""
    text = value.strip()
    match = re.match(r"<untrusted_tool_result\b[^>]*>\s*", text)
    if not match:
        return None
    close = text.rfind("</untrusted_tool_result>")
    if close <= match.end():
        return None
    wrapped = text[match.end():close].strip()
    start = wrapped.find("\n\n")
    return (wrapped if start == -1 else wrapped[start + 2:]).strip()


def _parse_tool_payloads(text: str) -> list[Any]:
    payloads: list[Any] = []
    for candidate in (text, _untrusted_tool_payload(text)):
        if not candidate:
            continue
        parsed = _parse_maybe_json(candidate)
        if parsed is not None:
            payloads.append(parsed)
    return payloads


def _collect_string_values(value: Any, key_path: str, collector: Callable[[str, str], None]) -> None:
    """Walk a payload, handing every string value to ``collector`` with its dotted key path."""
    if isinstance(value, str):
        collector(value, key_path)
        return
    if isinstance(value, list):
        for index, entry in enumerate(value):
            _collect_string_values(entry, f"{key_path}.{index}", collector)
        return
    if not isinstance(value, dict):
        return
    for key, child in value.items():
        _collect_string_values(child, f"{key_path}.{key}" if key_path else str(key), collector)


def _segments(key_path: str) -> list[str]:
    """The key path's named segments; array indices are dropped on purpose (``outputs.0.output``)."""
    return [segment for segment in key_path.split(".") if segment and not _DIGITS_RE.fullmatch(segment)]


def explicit_tool_artifact_key(key_path: str, producer_tool: bool) -> bool:
    """Whether a payload key is one the desktop app treats as an explicit artifact."""
    return any(
        STRONG_TOOL_ARTIFACT_KEY_RE.fullmatch(segment) is not None
        or (producer_tool and PRODUCER_TOOL_ARTIFACT_KEY_RE.fullmatch(segment) is not None)
        for segment in _segments(key_path)
    )


def is_artifact_producer_tool(name: str) -> bool:
    """A tool whose output is a deliverable (``write_file``, ``image_generate``, ``download_*``…)."""
    lowered = str(name or "").strip().lower()
    return bool(ARTIFACT_PRODUCER_TOOL_RE.search(lowered)) or lowered.startswith("bfl_flux3_")


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


# In command output a path is often a listing (ls, find, a log line), not a delivery. There, skip paths inside hidden
# folders (tool state and caches) and data/log files; a picture, a document or a MEDIA: tag still counts.
_OUTPUT_NOISE_EXT_RE = re.compile(r"\.(?:json|log|lock)$", re.IGNORECASE)


def _output_noise(value: str) -> bool:
    path = normalize(value)
    return any(part.startswith(".") and part not in (".", "..") for part in path.split("/")[:-1]) \
        or bool(_OUTPUT_NOISE_EXT_RE.search(path))


def _collect_from_text(text: str, push: PushValue, *, links: bool = True) -> None:
    """``links=False`` for tool and command output: a web address printed there (a clone URL, a search hit) is not
    something the agent handed over, so only pictures and files are taken from it."""
    for value in media_values(text):
        push(value, True)

    for match in MARKDOWN_IMAGE_RE.finditer(text):
        push(match.group(2) or "", False)

    for match in MARKDOWN_LINK_RE.finditer(text):
        if match.start() > 0 and text[match.start() - 1] == "!":
            continue
        value = _decode_media_href(match.group(2) or "")
        if not links and value.startswith(("http://", "https://")):
            continue
        if looks_like_artifact(value):
            push(value, False)

    for match in URL_RE.finditer(text):
        value = (match.group(0) or "").rstrip(URL_TAIL)
        if not links and kind(value) == "link":
            continue
        if looks_like_artifact(value):
            push(value, False)

    for match in PATH_RE.finditer(text):
        value = match.group(2) or ""
        if not links and _output_noise(value):
            continue
        push(value, False)

    for match in WINDOWS_PATH_RE.finditer(text):
        push(match.group(2) or "", False)


def collect_from_message(role: str, tool_name: str, text: str) -> list[tuple[str, bool]]:
    """Candidate ``(value, explicit)`` pairs from one stored message.

    An assistant message's text is scanned for MEDIA: tags, markdown images and links, bare URLs and
    absolute paths. A tool row is scanned only when the tool produces artifacts (or is ``terminal``),
    its JSON payload is walked with the explicit-key and shell-output rules, and
    ``browser_vision``'s "Screenshot path:" lines are read directly.
    """
    raw = "" if text is None else str(text)
    candidates: list[tuple[str, bool]] = []

    def push(value: str, explicit: bool = False) -> None:
        candidates.append((value, explicit))

    if role == "assistant":
        if raw:
            _collect_from_text(raw, push)
        return candidates
    if role != "tool":
        return candidates

    name = str(tool_name or "").strip().lower()
    producer = is_artifact_producer_tool(name)
    terminal = name == "terminal"

    payloads = _parse_tool_payloads(raw)
    # A JSON payload is read value by value below; scanning its raw text would pick up escape sequences (\\n) as part
    # of a path or URL.
    if raw and (producer or terminal) and not payloads:
        _collect_from_text(raw, push, links=False)

    if name == "browser_vision" and raw:
        for match in SCREENSHOT_PATH_RE.finditer(raw):
            push((match.group(1) or "").strip(), False)

    for parsed in payloads:
        def collector(value: str, key_path: str, *, _producer: bool = producer, _terminal: bool = terminal) -> None:
            shell_output = _terminal and any(
                SHELL_OUTPUT_KEY_RE.fullmatch(segment) is not None for segment in _segments(key_path)
            )
            if not shell_output and not explicit_tool_artifact_key(key_path, _producer):
                return
            if shell_output:
                # Shell output is free text: scan it rather than treating the whole line as one path.
                if value:
                    _collect_from_text(value, push, links=False)
                return
            for media in media_values(value):
                push(media, True)
            normalized = normalize(_decode_media_href(value))
            if normalized and looks_like_artifact(normalized):
                push(normalized, False)

        _collect_string_values(parsed, "tool_result", collector)

    return candidates


def _item(session_id: str, value: str, message_id: int, timestamp: Any) -> dict[str, Any]:
    return {
        "id": f"{session_id}:{value}",
        "kind": kind(value),
        "value": value,
        "label": label(value),
        "session_id": session_id,
        "message_id": message_id,
        "ts": _timestamp(timestamp),
    }


def _timestamp(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number > 0 else 0.0


def collect_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Artifact items from message rows, deduplicated per (chat, value).

    Rows are iterated NEWEST FIRST. The same value can be mentioned again and again; the item keeps
    the earliest occurrence's id and timestamp - where it was actually made - so the last one seen
    for a key wins. Each item is ``{"id", "kind", "value", "label", "session_id", "message_id", "ts"}``.
    """
    found: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        role = str(row.get("role") or "")
        if role not in ("assistant", "tool"):
            continue
        session_id = str(row.get("session_id") or "")
        row_id = int(row.get("id") or 0)
        text = "" if row.get("text") is None else str(row.get("text"))
        for value, explicit in collect_from_message(role, str(row.get("tool_name") or ""), text):
            value = normalize(_decode_media_href(value))
            if not value or not looks_like_artifact(value, explicit):
                continue
            found[(session_id, value)] = _item(session_id, value, row_id, row.get("timestamp"))
    return list(found.values())
