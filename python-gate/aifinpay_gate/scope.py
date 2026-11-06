"""Receipt scope — a line-for-line port of backend/aifp/scope.js via
gate/src/scope.ts. A port, not an interpretation: a gate stricter than the
hosted one refuses receipts the agent already paid for."""

from typing import Optional


def pattern_covers(pattern: str, path: str) -> bool:
    """"/movies/*" covers "/movies" and everything under "/movies/"; anything
    else is an exact compare."""
    pat = str(pattern or "")
    if not pat.endswith("/*"):
        return path == pat
    return path == pat[:-2] or path.startswith(pat[:-1])


def scope_covers(scope: Optional[str], resource: str, path: str) -> bool:
    if scope == "merchant":
        return True
    if scope == "prefix":
        # A discovery document lists a section as "/x/*" with scope prefix.
        base = resource[:-1] if resource.endswith("/*") else resource
        if base == "/" or path == base:
            return True
        # The trailing slash stops /articles covering /articles-internal.
        boundary = base if base.endswith("/") else base + "/"
        # The SDKs buy "/paid/" for a "/paid/*" 402, and that wildcard covers "/paid" itself.
        return path == boundary[:-1] or path.startswith(boundary)
    return pattern_covers(resource, path)  # "exact", and anything unrecognised
