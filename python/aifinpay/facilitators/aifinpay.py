"""Native AiFinPay x402 facilitator with request-bound Ed25519 authorization."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import base58
import requests

from .base import Facilitator, PayOptions
from ..errors import UntrustedPaymentTargetError

if TYPE_CHECKING:
    from ..client import Agent


SIGNATURE_SCHEME = "aifinpay-ed25519-v2"
MAX_CHALLENGE_TTL_SECONDS = 5 * 60


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise UntrustedPaymentTargetError(
            "[AIFINPAY_AUTH_UNTRUSTED] unable to determine response/base origin"
        )
    return parsed.scheme.lower(), parsed.hostname.lower(), parsed.port


def _resource(url: str) -> str:
    parsed = urlsplit(url)
    path = parsed.path or "/"
    return f"{path}?{parsed.query}" if parsed.query else path


def _canonical_signing_message(
    *,
    nonce: str,
    agent: str,
    method: str,
    resource: str,
    expires: str,
    min_usd: str,
    agreement_hash: str,
) -> str:
    return "\n".join(
        [
            "AiFinPay-x402-v2",
            f"nonce={nonce}",
            f"agent={agent}",
            f"method={method}",
            f"resource={resource}",
            f"expires={expires}",
            f"min_usd={min_usd}",
            f"agreement_hash={agreement_hash}",
        ]
    )


def _parse_expiry(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise UntrustedPaymentTargetError(
            "[AIFINPAY_AUTH_INVALID] challenge expiry is invalid"
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


class AiFinPayFacilitator:
    """Adapter for the AiFinPay native x402 flow.

    Only the configured AiFinPay origin may request a signature. The accepted
    v2 challenge binds the signature to method, resource, expiry, minimum value
    terms and agreement hash. Legacy generic nonce signatures are rejected.
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

    @staticmethod
    def _sign_message(agent: "Agent", message: str) -> str:
        digest = hashlib.sha256(message.encode()).digest()
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
                f"[AIFINPAY_AUTH_UNTRUSTED] refusing AiFinPay signature for {response_url}"
            )

        try:
            body: dict[str, Any] = resp.json()
        except ValueError as exc:
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] trusted 402 response is not valid JSON"
            ) from exc
        if not isinstance(body, dict):
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] trusted 402 response is not an object"
            )

        nonce = body.get("x-nonce")
        signing = body.get("signing")
        if not isinstance(nonce, str) or not nonce or not isinstance(signing, dict):
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] missing bound nonce/signing challenge"
            )

        if (
            signing.get("scheme") != SIGNATURE_SCHEME
            or signing.get("hash") != "sha256"
            or signing.get("message_version") != 2
        ):
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] unsupported or legacy signing scheme"
            )

        method = str(signing.get("method") or "").upper()
        resource = str(signing.get("resource") or "")
        expires = str(signing.get("expires") or "")
        min_usd = str(signing.get("min_usd") or "")
        agreement_hash = str(signing.get("agreement_hash") or "")

        if not method.isalpha() or method != method.upper():
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] invalid bound HTTP method"
            )
        expected_resource = _resource(response_url)
        if resource != expected_resource:
            raise UntrustedPaymentTargetError(
                f"[AIFINPAY_AUTH_INVALID] challenge resource {resource or '<missing>'} "
                f"does not match {expected_resource}"
            )

        expiry = _parse_expiry(expires)
        now = datetime.now(timezone.utc)
        ttl = (expiry - now).total_seconds()
        if ttl <= 0 or ttl > MAX_CHALLENGE_TTL_SECONDS:
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] challenge expiry is invalid"
            )

        try:
            min_usd_number = float(min_usd)
        except ValueError as exc:
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] challenge value terms are invalid"
            ) from exc
        if min_usd_number < 0 or min_usd_number != min_usd_number:
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] challenge value terms are invalid"
            )
        if len(agreement_hash) != 64 or any(c not in "0123456789abcdefABCDEF" for c in agreement_hash):
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] agreement hash is invalid"
            )

        if str(body.get("min_usd", "")) != min_usd or str(body.get("agreement_hash", "")) != agreement_hash:
            raise UntrustedPaymentTargetError(
                "[AIFINPAY_AUTH_INVALID] signing terms disagree with challenge body"
            )

        message = _canonical_signing_message(
            nonce=nonce,
            agent=agent.address,
            method=method,
            resource=resource,
            expires=expires,
            min_usd=min_usd,
            agreement_hash=agreement_hash,
        )
        headers = {
            "x-agent-pubkey": agent.address,
            "x-nonce": nonce,
            "x-signature": self._sign_message(agent, message),
            "x-aifinpay-signature-scheme": SIGNATURE_SCHEME,
        }
        return {"headers": headers}
