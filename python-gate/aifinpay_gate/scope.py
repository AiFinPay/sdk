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
        if resource == "/" or path == resource:
            return True
        # The trailing slash stops /articles covering /articles-internal.
        return path.startswith(resource if resource.endswith("/") else resource + "/")
    return pattern_covers(resource, path)  # "exact", and anything unrecognised
