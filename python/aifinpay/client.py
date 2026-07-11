"""Low-level Agent client. Non-custodial: keypair never leaves this process."""
from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import nacl.signing  # PyNaCl
import base58
import requests

from .errors import (
    AiFinPayError,
    FundingTimeoutError,
    SeatNotFoundError,
    UnsupportedFacilitatorError,
    X402Error,
)
from .facilitators import PayOptions, detect_facilitator

# Canonical domain is aifinpay.io. The legacy aifinpay.company host is
# fully retired (DNS removed) — do not use it.
DEFAULT_BASE_URL = "https://aifinpay.io"
DEFAULT_TIMEOUT = 30  # seconds

# AIFP-1 self-declared client attribution header. Attached to every outbound
# SDK request (402 flow + AiFinPay API) when ``framework`` is configured.
# No default — the header is absent unless the integrator declares it.
FRAMEWORK_HEADER = "AIFP-Agent-Framework"
_FRAMEWORK_RE = re.compile(r"^[a-z0-9-]{1,32}$")


def _normalize_framework(value: Optional[str]) -> Optional[str]:
    """Lowercase + validate an AIFP-1 framework token ([a-z0-9-]{1,32})."""
    if value is None:
        return None
    v = value.strip().lower()
    if not _FRAMEWORK_RE.match(v):
        raise AiFinPayError(
            f"framework must be a short token matching [a-z0-9-]{{1,32}}, got {value!r}"
        )
    return v


@dataclass
class Invoice:
    """An on-chain payment invoice returned by the AiFinPay backend."""

    amount_usd: float
    treasury_vault: str
    program_id: str
    nonce: str
    raw: Dict[str, Any]


class Agent:
    """A non-custodial AiFinPay agent.

    The Ed25519 keypair lives only in this Python process. The SDK never
    transmits the secret key; only ``signature(SHA256("AiFinPay-x402:{nonce}:{pubkey}"))``
    is sent in the ``x-signature`` header for the AiFinPay-native flow,
    or a base64 ``PaymentPayload`` in ``PAYMENT-SIGNATURE`` for the
    Coinbase x402 flow (when wired).
    """

    def __init__(
        self,
        signing_key: nacl.signing.SigningKey,
        base_url: str = DEFAULT_BASE_URL,
        timeout: int = DEFAULT_TIMEOUT,
        framework: Optional[str] = None,
    ):
        """
        :param framework: AIFP-1 self-declared client attribution. When set,
            every HTTP request the SDK makes — the x402 flow (initial request
            + paid retry) and AiFinPay API calls (quote/pay/invoice/…) —
            carries the ``AIFP-Agent-Framework: <value>`` header.
            Well-known values: ``chatgpt``, ``claude``, ``perplexity``,
            ``gemini``, ``cursor``, ``openai-agents``, ``windsurf``,
            ``custom`` — but any short token matching ``[a-z0-9-]{1,32}``
            is accepted (input is lowercased first). No default: the header
            is simply absent when not configured — honest self-declaration,
            not fingerprinting.
        """
        self._sk = signing_key
        self._vk = signing_key.verify_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers["User-Agent"] = "aifinpay-agent-py/1.0.0"
        # Central attribution point: every SDK request goes through
        # self._session, so setting the header here covers the 402 flow
        # (pay()) and all AiFinPay API paths (quote_split, invoices, …).
        self.framework = framework

    # ── AIFP-1 client attribution ────────────────────────────────────────

    @property
    def framework(self) -> Optional[str]:
        """AIFP-1 self-declared framework token, or None (header omitted)."""
        return self._framework

    @framework.setter
    def framework(self, value: Optional[str]) -> None:
        self._framework = _normalize_framework(value)
        if self._framework:
            self._session.headers[FRAMEWORK_HEADER] = self._framework
        else:
            self._session.headers.pop(FRAMEWORK_HEADER, None)

    # ── Constructors ────────────────────────────────────────────────────────

    @classmethod
    def new(cls, **kwargs) -> "Agent":
        """Generate a fresh Ed25519 keypair locally."""
        return cls(nacl.signing.SigningKey.generate(), **kwargs)

    @classmethod
    def from_secret_b58(cls, secret_b58: str, **kwargs) -> "Agent":
        """Load from a 64-byte base58 secret (Solana style: secret + pub)."""
        raw = base58.b58decode(secret_b58)
        if len(raw) == 64:
            raw = raw[:32]
        if len(raw) != 32:
            raise AiFinPayError(
                f"secret must decode to 32 or 64 bytes, got {len(raw)}"
            )
        return cls(nacl.signing.SigningKey(raw), **kwargs)

    @classmethod
    def from_keypair_file(cls, path: str, **kwargs) -> "Agent":
        """Load a Solana CLI ``solana-keygen`` JSON file (array of 64 ints)."""
        with open(path) as f:
            arr = json.load(f)
        if not isinstance(arr, list) or len(arr) != 64:
            raise AiFinPayError(f"{path}: expected 64-byte array")
        return cls(nacl.signing.SigningKey(bytes(arr[:32])), **kwargs)

    # ── Public properties ──────────────────────────────────────────────────

    @property
    def address(self) -> str:
        """Solana base58 public key."""
        return base58.b58encode(bytes(self._vk)).decode()

    @property
    def secret_b58(self) -> str:
        """Base58-encoded secret. Save this somewhere safe."""
        return base58.b58encode(bytes(self._sk) + bytes(self._vk)).decode()

    # ── Manifesto / discovery (AiFinPay native) ─────────────────────────────

    def manifesto(self) -> Dict[str, Any]:
        r = self._session.get(
            f"{self.base_url}/manifesto.json", timeout=self.timeout
        )
        r.raise_for_status()
        return r.json()

    def well_known(self) -> Dict[str, Any]:
        r = self._session.get(
            f"{self.base_url}/.well-known/x402.json", timeout=self.timeout
        )
        r.raise_for_status()
        return r.json()

    # ── x402 auth (AiFinPay native — kept for backwards compat) ────────────

    def _fetch_nonce(self) -> Dict[str, Any]:
        r = self._session.get(f"{self.base_url}/nonce", timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def _sign_nonce(self, nonce: str) -> str:
        msg = f"AiFinPay-x402:{nonce}:{self.address}".encode()
        digest = hashlib.sha256(msg).digest()
        sig = self._sk.sign(digest).signature
        return base58.b58encode(sig).decode()

    def auth_headers(self) -> Dict[str, str]:
        """Build a fresh AiFinPay-native x402 header set (one-time, 60s TTL)."""
        nonce_info = self._fetch_nonce()
        nonce = nonce_info["nonce"]
        return {
            "x-agent-pubkey": self.address,
            "x-nonce": nonce,
            "x-signature": self._sign_nonce(nonce),
        }

    # ── Funding / Seat ────────────────────────────────────────────────────

    def has_seat(self) -> bool:
        r = self._session.get(
            f"{self.base_url}/api/seat/{self.address}", timeout=self.timeout
        )
        r.raise_for_status()
        return bool(r.json().get("has_seat"))

    def wait_for_funding(
        self, min_usd_cents: int = 100, poll_seconds: int = 5, timeout: int = 600
    ) -> None:
        """Poll the leaderboard until this address shows up with at least
        ``min_usd_cents`` reserved on its Seat. Raises FundingTimeoutError."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self._session.get(
                f"{self.base_url}/api/leaderboard?merge=true",
                timeout=self.timeout,
            )
            r.raise_for_status()
            for entry in r.json().get("leaderboard", []):
                if entry.get("pubkey") == self.address:
                    cents = int(float(entry.get("usd", 0)) * 100)
                    if cents >= min_usd_cents:
                        return
            time.sleep(poll_seconds)
        raise FundingTimeoutError(
            f"address {self.address} never reached {min_usd_cents} cents on-chain"
        )

    # ── Invoices (AiFinPay native — server returns instructions) ────────────

    def reserve_seat_invoice(
        self, amount_usd: float, asset: str = "USDC"
    ) -> Invoice:
        """Request an invoice for reserving a Seat. The returned ``raw`` dict
        contains everything you need to build and submit the on-chain
        transaction with the Solana / Polygon SDK of your choice."""
        endpoint = "/api/invoice" if asset.upper() == "SOL" else "/api/invoice-spl"
        payload: Dict[str, Any] = {
            "amount_usd": amount_usd,
            "agent_pubkey": self.address,
        }
        if asset.upper() != "SOL":
            payload["asset"] = asset.upper()
        r = self._session.post(
            f"{self.base_url}{endpoint}", json=payload, timeout=self.timeout
        )
        r.raise_for_status()
        data = r.json()
        return Invoice(
            amount_usd=amount_usd,
            treasury_vault=data.get("treasury_vault", ""),
            program_id=data.get("program_id", ""),
            nonce=data.get("nonce", ""),
            raw=data,
        )

    # ── Fee-on-top split (b2b_pay_with_split / AiFinPaySplitter) ──────────

    def quote_split(self, *, chain: str, merchant_amount: int) -> Dict[str, Any]:
        """Pure-view fee-on-top breakdown — no payment, no auth.

        Returns merchant amount, treasury fee, IP creator fee, and total —
        so the agent can decide whether to pay BEFORE building the tx.
        """
        if chain not in ("solana", "polygon"):
            raise AiFinPayError(f"chain must be 'solana' or 'polygon', got {chain!r}")
        param = (
            "merchant_amount_lamports" if chain == "solana" else "merchant_amount_wei"
        )
        r = self._session.get(
            f"{self.base_url}/api/b2b/quote-split",
            params={param: str(merchant_amount)},
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()

    def pay_with_split_invoice(
        self,
        *,
        chain: str,
        merchant_wallet: str,
        merchant_amount: int,
        order_id: str,
        fee_recipient: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get the on-chain instructions for a fee-on-top split payment.

        The merchant receives ``merchant_amount`` units (lamports for Solana,
        wei for Polygon). Treasury fee + IP-creator fee are added ON TOP.
        Total is what the agent's signed tx must transfer.

        This method **does not submit the transaction** — the SDK is
        non-custodial. Use the returned ``args`` + ``accounts`` (Solana) or
        ``args`` + ``msg_value_wei`` (Polygon) with the chain SDK of your
        choice (``@solana/web3.js`` / ``solana-py`` / ``viem`` / ``ethers``).

        Returns the parsed JSON. Raises ``X402Error`` (subclass) if the
        backend reports the corresponding splitter is not deployed yet.
        """
        from .errors import FacilitatorNotImplementedError

        if chain not in ("solana", "polygon"):
            raise AiFinPayError(f"chain must be 'solana' or 'polygon', got {chain!r}")
        if not order_id or len(order_id) > 64:
            raise AiFinPayError("order_id required, max 64 chars")

        payload: Dict[str, Any] = {
            "chain": chain,
            "agent_pubkey": self.address,
            "merchant_wallet": merchant_wallet,
            "merchant_amount": str(merchant_amount),
            "order_id": order_id,
        }
        if fee_recipient:
            payload["fee_recipient"] = fee_recipient

        r = self._session.post(
            f"{self.base_url}/api/b2b/pay-with-split",
            json=payload,
            timeout=self.timeout,
        )
        if r.status_code == 503:
            try:
                msg = r.json().get("message", "splitter not deployed")
            except Exception:
                msg = "splitter not deployed"
            raise FacilitatorNotImplementedError(msg)
        r.raise_for_status()
        return r.json()

    # ── Generic x402 — works against any supported facilitator ─────────────

    def pay(
        self,
        url: str,
        *,
        method: str = "GET",
        max_retries: int = 1,
        options: Optional[PayOptions] = None,
        **request_kwargs,
    ) -> requests.Response:
        """HTTP request that auto-handles x402 across multiple facilitators.

        First sends the request unauthenticated. On 402, detects which
        facilitator flavor the server speaks (AiFinPay native, Coinbase
        x402, etc.), builds the appropriate auth payload, and retries.

        Args:
            url: target URL.
            method: HTTP verb. Defaults to GET.
            max_retries: how many times to retry after a 402. Default 1.
            options: PayOptions for budget caps, facilitator overrides.
            **request_kwargs: forwarded to ``requests.Session.request``.

        Raises:
            UnsupportedFacilitatorError: 402 from a flavor we don't know.
            FacilitatorNotImplementedError: known flavor, can't pay yet.
            PaymentTooExpensiveError: cost exceeds ``options.max_amount_usd``.
            X402Error: still 402 after ``max_retries`` retries.
        """
        opts = options or PayOptions()
        base_headers = request_kwargs.pop("headers", {}) or {}

        # First attempt — unauthenticated.
        resp = self._session.request(
            method,
            url,
            headers={**base_headers, **opts.extra_headers},
            timeout=self.timeout,
            **request_kwargs,
        )

        attempt = 0
        while resp.status_code == 402 and attempt < max_retries:
            attempt += 1
            facilitator = detect_facilitator(resp, override=opts.facilitator)
            auth = facilitator.build_auth(resp, self, opts)
            retry_kwargs = {**request_kwargs}
            if "method" in auth:
                method = auth["method"]
            if "body" in auth:
                retry_kwargs["data"] = auth["body"]
            merged_headers = {
                **base_headers,
                **auth.get("headers", {}),
                **opts.extra_headers,
            }
            resp = self._session.request(
                method,
                url,
                headers=merged_headers,
                timeout=self.timeout,
                **retry_kwargs,
            )

        if resp.status_code == 402:
            try:
                challenge: Any = resp.json()
            except ValueError:
                challenge = {"raw": resp.text[:500]}
            raise X402Error(
                f"402 Payment Required after {attempt} retry/retries. "
                f"Challenge: {challenge}"
            )

        return resp

    # ── Backwards-compat wrappers ────────────────────────────────────────

    def request(
        self,
        method: str,
        url: str,
        *,
        max_retries: int = 1,
        **kwargs,
    ) -> requests.Response:
        """Compat wrapper. New code should call ``pay()`` directly."""
        return self.pay(
            url, method=method, max_retries=max_retries, **kwargs
        )

    get = lambda self, url, **kw: self.pay(url, method="GET", **kw)
    post = lambda self, url, **kw: self.pay(url, method="POST", **kw)
