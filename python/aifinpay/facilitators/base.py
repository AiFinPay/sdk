"""Facilitator protocol — the abstract interface every adapter implements."""
from __future__ import annotations

from dataclasses import dataclass, field
import ipaddress
from typing import TYPE_CHECKING, Any, Optional, Protocol, runtime_checkable
from urllib.parse import urlsplit

import requests

if TYPE_CHECKING:
    from ..client import Agent


@dataclass
class PayOptions:
    """Caller-supplied controls for a `pay()` call.

    All fields are optional. The SDK applies sensible defaults.
    """

    max_amount_usd: Optional[float] = None
    """Refuse to pay if the facilitator requires more than this. None = no cap."""

    preferred_chain: Optional[str] = None
    """Hint for facilitators that accept multiple chains (e.g. 'solana', 'polygon')."""

    facilitator: str = "auto"
    """`auto` | `aifinpay` | `coinbase-x402`. Forces a specific adapter."""

    extra_headers: dict = field(default_factory=dict)
    """Extra headers to attach AFTER the facilitator's auth headers."""


def canonical_origin(url: str) -> str:
    """Normalize an http(s) origin exactly like URL.origin in the Node SDK."""
    parsed = urlsplit(url)
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("expected an absolute http(s) URL without credentials")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("URL has an invalid port") from exc
    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower()
    if ":" in host:
        # urllib removes IPv6 brackets; put them back so this agrees with
        # WHATWG URL.origin.  Scope-zone URLs are deliberately unsupported.
        if "%" in host:
            raise ValueError("URL has an unsupported IPv6 scope zone")
        try:
            host = f"[{ipaddress.IPv6Address(host).compressed}]"
        except ValueError as exc:
            raise ValueError("URL has an invalid IPv6 host") from exc
    if port is None or (scheme == "https" and port == 443) or (scheme == "http" and port == 80):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


@runtime_checkable
class Facilitator(Protocol):
    """A facilitator handles one x402 wire format.

    Implementations are usually stateless; state (keypair, base URL) lives on
    the Agent. The Facilitator just translates challenge → auth payload.
    """

    name: str

    @staticmethod
    def detect(resp: requests.Response) -> bool:
        """Return True if this facilitator is the right adapter for `resp`."""
        ...

    def build_auth(
        self,
        resp: requests.Response,
        agent: "Agent",
        opts: PayOptions,
        context: Optional[dict[str, Any]] = None,
    ) -> dict:
        """Return the kwargs to merge into the retry request.

        Returned dict typically contains:
            - "headers": dict of headers to set on the retry
            - optional "body": replacement body
            - optional "method": override method

        May raise:
            - PaymentTooExpensiveError if cost > opts.max_amount_usd
            - FacilitatorNotImplementedError if the facilitator is detected
              but we can't pay it yet (e.g. EVM wallet not wired)
        """
        ...
