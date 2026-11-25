"""What a gate tells AiFinPay about itself on every merchant-secret request (conformance/SPEC.md, "Gate identity")."""

import re

# This package's version; a test keeps it equal to pyproject.toml.
VERSION = "0.11.1"

_VALUE = re.compile(r"[a-z0-9._-]{1,32}")


def _version(ver):
    v = re.sub(r"[A-Z]", lambda m: m.group(0).lower(), ver).split("+")[0] if isinstance(ver, str) else ""
    return v if _VALUE.fullmatch(v) else "unknown"


def gate_headers(info):
    """``User-Agent`` and ``AIFP-Gate`` exactly as the SPEC's ``format`` vectors."""
    ver = _version(info.get("ver"))
    platform = info.get("platform")
    platform = platform if isinstance(platform, str) and _VALUE.fullmatch(platform) else "unknown"
    return {
        "User-Agent": f"aifinpay-gate-{info['pkg']}/{ver}",
        "AIFP-Gate": f"pkg={info['pkg']}; ver={ver}; platform={platform}; mode={info['mode']}; charge={info['charge']}",
    }


def tag_charge(rule, charge):
    """Marks a shipped charge rule so a gate can name it without reading its source."""
    rule._aifp_charge = charge
    return rule


def charge_of(should_charge):
    if should_charge is None:
        return "everyone"
    return getattr(should_charge, "_aifp_charge", None) or "custom"


def user_agent():
    return f"aifinpay-gate-py/{_version(VERSION)}"
