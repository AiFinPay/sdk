"""The path a pattern is matched against: a port of gate/src/path.ts."""

import re
from typing import NamedTuple

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_ESCAPE = re.compile(r"%([0-9a-fA-F]{2})")
_NON_ASCII = re.compile(r"[^\x00-\x7f]+")
_LOWER_HEX = re.compile(r"%[0-9a-fA-F]{2}")


class InspectedPath(NamedTuple):
    path: str
    ambiguous: bool


def _decode_round(text: str) -> str:
    """``?`` and ``#`` stay escaped: decoded, they would end the path the next time it is read."""
    return _ESCAPE.sub(
        lambda m: chr(int(m[1], 16)) if int(m[1], 16) < 0x80 and int(m[1], 16) not in (0x3F, 0x23) else m[0],
        text,
    ).replace("\\", "/")


def _escape_non_ascii(text: str) -> str:
    return _NON_ASCII.sub(lambda m: "".join(f"%{b:02x}" for b in m[0].encode("utf-8", "replace")), text)


def inspect_path(raw_target: str, *, case_sensitive: bool = False) -> InspectedPath:
    """For an origin whose routing the gate cannot see. The origin still receives
    what the client sent. Origins disagree on dot segments: ``/paid/..;/../a`` is
    ``/a`` to one and ``/paid/a`` to another, so ``ambiguous`` marks those, a raw
    ``#``, which no client sends for a real page, and a spelling still decoding
    after the last round. Anything else reads the same when read again."""
    target = ("/" if raw_target is None else str(raw_target)).split("?", 1)[0]
    path = target.split("#", 1)[0] or "/"
    for _ in range(3):
        decoded = _decode_round(path)
        if decoded == path:
            break
        path = decoded
    ambiguous = "#" in target or _CONTROL.search(path) is not None or _decode_round(path) != path
    out = []
    for raw in path.split("/"):
        segment = raw.split(";", 1)[0]
        if segment == "":
            continue
        if segment in (".", ".."):
            ambiguous = True
            if segment == ".." and out:
                out.pop()
            continue
        out.append(segment)
    canonical = _escape_non_ascii("/" + "/".join(out))
    if case_sensitive:
        return InspectedPath(_LOWER_HEX.sub(lambda m: m[0].lower(), canonical), ambiguous)
    return InspectedPath(canonical.lower(), ambiguous)


def spelled_as_path(resource: str, *, case_sensitive: bool = False) -> str:
    """A pattern, a receipt or a mount names a resource as the merchant spelled
    it: read it as a path is read, keeping a wildcard."""
    if not resource.startswith("/"):
        return resource
    wild = resource.endswith("/*")
    path = inspect_path(resource[:-2] if wild else resource, case_sensitive=case_sensitive).path
    if not wild:
        return path
    return "/*" if path == "/" else f"{path}/*"
