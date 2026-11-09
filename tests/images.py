"""Small, dependency-free test image.

A real, decodable RGB PNG: the same bytes pass the structural header checks and Pillow's decode, so
the validated path is exercised whether or not Pillow is installed in the test environment. Keeping
the generator here (rather than shipping binary fixtures) means a test reads like the rule it asserts.
"""

from __future__ import annotations

import struct
import zlib


def png(width: int = 32, height: int = 32, color: tuple[int, int, int] = (20, 120, 120)) -> bytes:
    """A minimal, valid RGB PNG of the requested size."""
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def truncated_png(width: int = 32, height: int = 32) -> bytes:
    """A PNG signature and IHDR with no image data: the header sniffs, the decode must fail."""
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", len(header))
        + b"IHDR"
        + header
    )


# Bytes whose *content* is a vector image or a script, whatever the client calls them.
SVG_BYTES = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
HTML_BYTES = b"<!doctype html><html><body><script>alert(1)</script></body></html>"
GIF_BYTES = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"
