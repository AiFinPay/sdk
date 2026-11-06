"""The path a pattern is matched against: a port of gate/src/path.ts."""

import re
from typing import NamedTuple

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_ESCAPE = re.compile(r"%([0-9a-fA-F]{2})")


class InspectedPath(NamedTuple):
    path: str
    ambiguous: bool


def _decode_ascii(text: str) -> str:
    return _ESCAPE.sub(lambda m: chr(int(m[1], 16)) if int(m[1], 16) < 0x80 else m[0], text)


def inspect_path(raw_target: str, *, case_sensitive: bool = False) -> InspectedPath:
    """For an origin whose routing the gate cannot see. The origin still receives
    what the client sent. Origins disagree on dot segments: ``/paid/..;/../a`` is
    ``/a`` to one and ``/paid/a`` to another, so ``ambiguous`` marks those."""
    path = re.split(r"[?#]", "/" if raw_target is None else str(raw_target), maxsplit=1)[0] or "/"
    for _ in range(3):
        decoded = _decode_ascii(path).replace("\\", "/")
        if decoded == path:
            break
        path = decoded
    ambiguous = _CONTROL.search(path) is not None
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
    canonical = "/" + "/".join(out)
    return InspectedPath(canonical if case_sensitive else canonical.lower(), ambiguous)


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
