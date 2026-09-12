"""Native AiFinPay flavor — three custom headers, JSON body in the 402."""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import TYPE_CHECKING, Any, Optional
from urllib.parse import urlsplit

import base58
import requests

from .base import Facilitator, PayOptions, canonical_origin

if TYPE_CHECKING:
    from ..client import Agent


class AiFinPayFacilitator:
    """Adapter for the AiFinPay native x402 flow.

    Wire format:
        - 402 carries a JSON body with `program_id`, `manifesto`,
          `agreement_hash`, `treasury_vault`, …
        - Client retries with three headers:
            x-agent-pubkey, x-nonce, x-signature
        - Signature: Ed25519 over SHA-256(canonical v2 request binding)
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
        # AiFinPay 402 carries `protocol: "AiFinPay vX.Y"` plus either
        # `agreement_hash` (most common) or `manifesto` ref.
        protocol = body.get("protocol", "")
        if isinstance(protocol, str) and protocol.startswith("AiFinPay"):
            return True
        # Fallback fingerprint when an upstream proxy strips `protocol`.
        return ("agreement_hash" in body or "manifesto" in body) and (
            "treasury_vault" in body or "program_id" in body
        )

    @staticmethod
    def _sign_request(
        agent: "Agent",
        nonce: str,
        origin: str,
        method: str,
        resource: str,
        body_digest: str,
        expires_at: int,
    ) -> str:
        # Must match JSON.stringify([...]) in the Node SDK and backend.
        msg = json.dumps(
            [
                "AiFinPay-x402",
                "v2",
                nonce,
                agent.address,
                origin,
                method.upper(),
                resource,
                body_digest,
                expires_at,
            ],
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode()
        digest = hashlib.sha256(msg).digest()
        sig = agent._sk.sign(digest).signature
        return base58.b58encode(sig).decode()

    def build_auth(
        self,
        resp: requests.Response,
        agent: "Agent",
        opts: PayOptions,
        context: Optional[dict[str, Any]] = None,
    ) -> dict:
        if not context:
            raise ValueError(
                "AiFinPay native auth v1 is no longer supported. Retry through Agent.pay() so the SDK can bind the challenge to the request."
            )
        target = urlsplit(str(context["url"]))
        trusted_origin = str(context["trusted_origin"])
        target_origin = canonical_origin(str(context["url"]))
        if target_origin != trusted_origin:
            raise ValueError(
                f"refusing native authentication for untrusted origin {target_origin}; configure Agent.base_url for that facilitator explicitly"
            )
        if resp.url:
            try:
                response_origin = canonical_origin(resp.url)
            except ValueError as exc:
                raise ValueError("refusing native authentication for an invalid response origin") from exc
            if response_origin != trusted_origin:
                raise ValueError("refusing native authentication after a cross-origin response")

        body_digest = str(context["body_digest"])
        challenge = self._inband_challenge(resp, body_digest)
        if challenge is None:
            raise ValueError(
                "AiFinPay native auth v2 requires an in-band request-bound challenge. Retry the original request without credentials."
            )
        nonce, expires_at = challenge
        resource = target.path or "/"
        if target.query:
            resource += f"?{target.query}"
        headers = {
            "x-agent-pubkey": agent.address,
            "x-nonce": nonce,
            "x-signature": self._sign_request(
                agent,
                nonce,
                trusted_origin,
                str(context["method"]),
                resource,
                body_digest,
                expires_at,
            ),
            "x-aifinpay-auth-version": "2",
        }
        return {"headers": headers}

    @staticmethod
    def _inband_challenge(
        resp: requests.Response, expected_body_digest: str = ""
    ) -> tuple[str, int] | None:
        """Read the v2 challenge issued for this exact unauthenticated request."""
        try:
            body = resp.json()
        except ValueError:
            return None
        if not isinstance(body, dict):
            return None
        nonce = body.get("x-nonce")
        expires_at = body.get("x-nonce-expires-at")
        version = body.get("x-aifinpay-auth-version")
        body_digest = body.get("x-aifinpay-body-sha256")
        if (
            not isinstance(nonce, str)
            or re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce) is None
            or str(version) != "2"
            or not isinstance(expires_at, (str, int))
            or not (str(expires_at).isdigit() and 1 <= len(str(expires_at)) <= 16)
            or not isinstance(body_digest, str)
            or len(body_digest) != 64
            or any(ch not in "0123456789abcdef" for ch in body_digest)
            or body_digest != expected_body_digest
        ):
            return None
        parsed_expiry = int(expires_at)
        now = int(time.time() * 1000)
        return (
            (nonce, parsed_expiry)
            if now < parsed_expiry <= now + 5 * 60_000
            else None
        )
