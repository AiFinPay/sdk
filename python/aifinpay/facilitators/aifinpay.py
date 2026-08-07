"""Native AiFinPay flavor — three custom headers, JSON body in the 402."""
from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import base58
import requests

from .base import Facilitator, PayOptions
from ..errors import UntrustedPaymentTargetError

if TYPE_CHECKING:
    from ..client import Agent


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise UntrustedPaymentTargetError(
            "[AIFINPAY_AUTH_UNTRUSTED] unable to determine response/base origin"
        )
    return parsed.scheme.lower(), parsed.hostname.lower(), parsed.port


class AiFinPayFacilitator:
    """Adapter for the AiFinPay native x402 flow.

    Security policy:
        - never accept a nonce from the 402 responder;
        - obtain the nonce only from the configured AiFinPay base URL;
        - never emit the legacy bearer-style signature to another origin.

    The production verifier still expects the legacy signature
    ``AiFinPay-x402:{nonce}:{pubkey}``. Origin restriction closes the arbitrary
    endpoint signing-oracle path while request-bound origin/resource/amount/
    expiry signatures are implemented end-to-end on both client and verifier.
    """

    name = "aifinpay"

    @staticmethod
    def detect(resp: requests.Response) -> bool:
        if resp.status_code != 402:
            return False
        try:
            body = resp.json()
        except ValueError:
            return False
        if not isinstance(body, dict):
            return False
        protocol = body.get("protocol", "")
        if isinstance(protocol, str) and protocol.startswith("AiFinPay"):
            return True
        return ("agreement_hash" in body or "manifesto" in body) and (
            "treasury_vault" in body or "program_id" in body
        )

    def __init__(self, base_url: str = "https://aifinpay.io", timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _fetch_nonce(self, session: requests.Session) -> str:
        r = session.get(
            f"{self.base_url}/nonce",
            timeout=self.timeout,
            allow_redirects=False,
        )
        if 300 <= r.status_code < 400:
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_UNTRUSTED] nonce endpoint redirected"
            )
        r.raise_for_status()
        nonce = r.json().get("nonce")
        if not isinstance(nonce, str) or not nonce:
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_UNTRUSTED] nonce endpoint returned no nonce"
            )
        return nonce

    @staticmethod
    def _sign_nonce(agent: "Agent", nonce: str) -> str:
        msg = f"AiFinPay-x402:{nonce}:{agent.address}".encode()
        digest = hashlib.sha256(msg).digest()
        sig = agent._sk.sign(digest).signature
        return base58.b58encode(sig).decode()

    def build_auth(
        self,
        resp: requests.Response,
        agent: "Agent",
        opts: PayOptions,
    ) -> dict:
        response_url = getattr(resp, "url", "") or ""
        if _origin(response_url) != _origin(self.base_url):
            raise UntrustedPaymentTargetError(
                f"[AIFINPAY_AUTH_UNTRUSTED] refusing legacy AiFinPay signature for {response_url}"
            )

        # C-8: the responder cannot choose bytes that the wallet signs.
        nonce = self._fetch_nonce(agent._session)
        headers = {
            "x-agent-pubkey": agent.address,
            "x-nonce": nonce,
            "x-signature": self._sign_nonce(agent, nonce),
        }
        return {"headers": headers}
