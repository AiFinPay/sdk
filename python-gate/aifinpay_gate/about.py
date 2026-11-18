"""What a page is, for the 402: plain text, capped, the same bytes as gate/src/about.ts."""

import re
from typing import Any, Dict, Optional

ABOUT_TITLE_MAX = 200
ABOUT_DESCRIPTION_MAX = 300

_TAG = re.compile(r"<[A-Za-z/!?][^<>]*>")
_ENTITY = re.compile(r"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});")
# Cc minus the whitespace below, plus unpaired surrogates.
_CONTROL = re.compile(r"[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F\uD800-\uDFFF]")
_SPACE = re.compile(r"[\t\n\u000B\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+")
_EDGE = re.compile(r"^ | $")

_NAMED = {
    "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": "\u00A0",
    "ndash": "\u2013", "mdash": "\u2014", "hellip": "\u2026", "lsquo": "\u2018", "rsquo": "\u2019",
    "sbquo": "\u201A", "ldquo": "\u201C", "rdquo": "\u201D", "bdquo": "\u201E", "laquo": "\u00AB",
    "raquo": "\u00BB", "middot": "\u00B7", "bull": "\u2022", "copy": "\u00A9", "reg": "\u00AE",
    "trade": "\u2122", "deg": "\u00B0", "euro": "\u20AC", "pound": "\u00A3", "yen": "\u00A5",
    "cent": "\u00A2", "sect": "\u00A7", "para": "\u00B6", "times": "\u00D7", "divide": "\u00F7",
    "plusmn": "\u00B1",
}


def _decode(match: "re.Match[str]") -> str:
    ref = match.group(1)
    if ref[0] != "#":
        return _NAMED.get(ref, match.group(0))
    code = int(ref[2:], 16) if ref[1] in "xX" else int(ref[1:], 10)
    if code == 0 or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
        return match.group(0)
    return chr(code)


def plain_text(value: str, limit: int) -> str:
    """Tags stripped, entities decoded once, control characters removed, whitespace collapsed, cut at ``limit`` code points."""
    text = _SPACE.sub(" ", _CONTROL.sub("", _ENTITY.sub(_decode, _TAG.sub("", value))))
    text = _EDGE.sub("", text)[:limit]
    return text[:-1] if text.endswith(" ") else text


def page_about(value: Any) -> Optional[Dict[str, str]]:
    """The ``about`` object for a 402, or None when there is nothing to say or the value has the wrong shape."""
    if not isinstance(value, dict):
        return None
    title, description = value.get("title"), value.get("description")
    if (title is not None and not isinstance(title, str)) or (description is not None and not isinstance(description, str)):
        return None
    t = plain_text(title, ABOUT_TITLE_MAX) if isinstance(title, str) else ""
    d = plain_text(description, ABOUT_DESCRIPTION_MAX) if isinstance(description, str) else ""
    if not t and not d:
        return None
    out: Dict[str, str] = {}
    if t:
        out["title"] = t
    if d:
        out["description"] = d
    return out
