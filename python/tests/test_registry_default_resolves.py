"""The default registry URL must be a host+path pair that actually serves JSON.

unified_agent.py carries a table of which host serves the registry on which
path, and the two disagree:

    aifinpay.io/api/providers      -> JSON
    aifinpay.io/providers          -> 200 HTML (the SPA catch-all)
    api.aifinpay.io/providers      -> JSON
    api.aifinpay.io/api/providers  -> 404

The default was built by concatenating one host with the other host's path, so
it pointed at the single 404 cell in that table — three lines below the comment
documenting it. It never surfaced as a bug because the fallback path rescued it:
the cost was a wasted round-trip and a 404 in every Python user's debug log, on
every first discovery, forever.

That is the failure mode worth guarding: not a crash, but a default that is
wrong and self-heals quietly enough that nobody looks. This test is offline and
structural on purpose — it must fail in a bare checkout with no network, because
a network test would be skipped in exactly the environments where this breaks.
"""

import re
from pathlib import Path

import aifinpay.unified_agent as ua

SRC = (Path(__file__).resolve().parents[1] / "aifinpay" / "unified_agent.py").read_text(encoding="utf-8")

# The host/path combinations that serve JSON, from the module's own table.
# Verified live 2026-08-12.
WORKING = {
    "https://aifinpay.io/api/providers",
    "https://api.aifinpay.io/providers",
}

# The one that 404s. Named explicitly so a reader sees what is being prevented.
KNOWN_404 = "https://api.aifinpay.io/api/providers"


def test_default_registry_url_is_a_working_pair():
    assert ua.DEFAULT_REGISTRY_URL in WORKING, (
        f"DEFAULT_REGISTRY_URL is {ua.DEFAULT_REGISTRY_URL!r}, which is not one of the "
        f"host/path pairs that serve JSON. The host and the path are not "
        f"interchangeable — see the table in unified_agent.py."
    )


def test_default_is_not_the_known_404():
    assert ua.DEFAULT_REGISTRY_URL != KNOWN_404, (
        "DEFAULT_REGISTRY_URL is back to the api.aifinpay.io + /api/providers "
        "combination, which returns 404. Every first discovery request is wasted."
    )


def test_default_host_matches_the_node_sdk():
    """Both SDKs must default to the same host.

    They disagreeing is the reason this went unnoticed: the Node SDK hit 200 on
    its first try, so nobody debugging Python's extra 404 had a reference to
    compare against.
    """
    node_agent = Path(__file__).resolve().parents[2] / "node" / "src" / "agent.ts"
    if not node_agent.exists():          # python package published on its own
        return
    m = re.search(r'DEFAULT_BASE_URL\s*=\s*"([^"]+)"', node_agent.read_text(encoding="utf-8"))
    assert m, "node/src/agent.ts no longer declares DEFAULT_BASE_URL — update this test"
    node_host = m.group(1).rstrip("/")
    assert ua.DEFAULT_REGISTRY_HOST.rstrip("/") == node_host, (
        f"Python defaults to {ua.DEFAULT_REGISTRY_HOST!r}, Node to {node_host!r}. "
        f"Pick one; divergent defaults hide host-specific routing bugs."
    )


def test_path_order_is_still_deliberate():
    """/api/providers must stay first, and the reason must stay written down.

    Guessing wrong with /api/providers yields a clean 404. Guessing wrong with
    /providers yields 200-with-HTML from the SPA catch-all, which looks like
    success and is far worse to debug. If someone reverses the order for
    tidiness, this fails.
    """
    assert ua.DEFAULT_REGISTRY_PATHS[0] == "/api/providers"
    assert "SPA catch-all" in SRC, (
        "the comment explaining why /api/providers is probed first is gone; "
        "without it the order looks arbitrary and will be 'cleaned up'"
    )
