"""The content licence a receipt was bought under travels with the content it
unlocks. Facts come from the signed ``lic`` claim; the URL is built here."""
import re
from typing import Any, Dict, Optional
from urllib.parse import quote

HEADER_LICENSE = "AIFP-License"
_RE_ID = re.compile(r"^clic_[0-9a-f]{24}$")
_RE_SHA = re.compile(r"^[0-9a-f]{64}$")


def receipt_license(claim: Any) -> Optional[Dict[str, Any]]:
    """The ``lic`` claim when it is well formed, else None."""
    if not isinstance(claim, dict):
        return None
    lic_id, sha, rev = claim.get("id"), claim.get("sha256"), claim.get("rev")
    if not isinstance(lic_id, str) or not _RE_ID.match(lic_id):
        return None
    if not isinstance(sha, str) or not _RE_SHA.match(sha):
        return None
    if isinstance(rev, bool) or not isinstance(rev, int) or rev < 1:
        return None
    out: Dict[str, Any] = {"id": lic_id, "rev": rev, "sha256": sha, "confirmed": claim.get("confirmed") is True}
    if isinstance(claim.get("v"), str):
        out["v"] = claim["v"]
    return out


def license_headers(api_base: str, merchant_id: str, lic: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """``AIFP-License`` and ``Link: rel="license"`` for a response that unlocked content."""
    if not lic:
        return {}
    url = f"{api_base.rstrip('/')}/v1/merchants/{quote(merchant_id, safe='')}/license/{lic['rev']}"
    return {
        HEADER_LICENSE: f'id={lic["id"]}; rev={lic["rev"]}; sha256={lic["sha256"]}; url="{url}"',
        "Link": f'<{url}/text>; rel="license"',
    }
