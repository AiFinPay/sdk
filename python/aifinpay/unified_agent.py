"""
AiFinPayAgent — unified, chain-opaque developer surface (Phase 1+).

Mirrors `@aifinpay/agent`'s `AiFinPayAgent` TypeScript class. One seed
derives BOTH a Solana base58 pubkey AND a Polygon EVM 0x address.
Per-call payment via `agent.call(provider=…)` does:

  1. Registry lookup at /api/providers
  2. POST to the bridge → expect HTTP 402
  3. Build + sign + send the on-chain payment:
       - Polygon  → B2BSplitter.payMatic(merchant, ipCreator, orderId)
                    with msg.value = total_wei
       - Solana   → b2b_pay_with_split(merchant_amount_lamports, order_id)
                    on program 5g9zWHF1…KFx2
  4. Retry the bridge POST with x-tx-hash + x-order-id (Polygon) or
     x-solana-tx + x-order-id (Solana)
  5. Return the upstream response body

Dependencies (declared in pyproject.toml):
  • PyNaCl, base58   (already there)
  • web3, eth-account, eth-utils  (Polygon EVM)
  • solders          (Solana tx building)
"""

from __future__ import annotations

import hashlib
import os
import struct
import time
from dataclasses import dataclass
from typing import Any, Optional

import nacl.signing
import nacl.encoding
import base58
import requests

from .errors import AiFinPayError, X402Error
from .client import Agent  # legacy Solana-only agent (we wrap it)
from .facilitators import PayOptions
from .cross_chain import (
    EVM_CHAINS,
    USDC_NATIVE,
    BridgeQuote,
    BridgeReceipt,
    bridge_quote as _bridge_quote,
    bridge_execute as _bridge_execute,
    bridge_wait_for_arrival as _bridge_wait_for_arrival,
)

# ── EVM imports — heavyish, lazy via top-level so missing deps fail clearly ──
try:
    from eth_account import Account as EvmAccount
    from eth_account.messages import encode_defunct
    from web3 import Web3
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "AiFinPayAgent requires web3 + eth_account. "
        "Install with: pip install 'aifinpay-agent[unified]' "
        "or: pip install web3 eth-account"
    ) from e

# POA middleware moved between web3 majors: v6 exports geth_poa_middleware,
# v7 renamed it to ExtraDataToPOAMiddleware. Importing it inside the hard
# block above used to make the WHOLE module unimportable on web3 v7 with a
# misleading "install web3" error. Optional by design — Polygon RPCs work
# without it for our read/sign/send path.
try:  # web3 v6
    from web3.middleware import geth_poa_middleware as _poa_middleware  # type: ignore[attr-defined]
except ImportError:
    try:  # web3 v7+
        from web3.middleware import ExtraDataToPOAMiddleware as _poa_middleware  # type: ignore[attr-defined]
    except ImportError:  # pragma: no cover
        _poa_middleware = None

# ── Solana imports — solders for tx building, nacl already in deps ──
try:
    from solders.pubkey import Pubkey as SolPubkey
    from solders.keypair import Keypair as SolKeypair
    from solders.instruction import Instruction, AccountMeta
    from solders.system_program import ID as SYSTEM_PROGRAM_ID
    from solders.transaction import Transaction as SolTransaction
    from solders.message import Message as SolMessage
    from solders.hash import Hash as SolHash
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "AiFinPayAgent requires solders. "
        "Install with: pip install 'aifinpay-agent[unified]' or: pip install solders"
    ) from e


# ── Constants ───────────────────────────────────────────────────────────────

# Canonical domain is aifinpay.io. The legacy aifinpay.company host is
# fully retired (DNS removed) — do not use it.
DEFAULT_REGISTRY_URL = "https://api.aifinpay.io/api/providers"
DEFAULT_POLYGON_RPC  = "https://polygon.drpc.org"
DEFAULT_SOLANA_RPC   = "https://api.mainnet-beta.solana.com"

# Polygon B2BSplitter.payMatic ABI (single-function slice — full ABI not needed)
SPLITTER_PAY_MATIC_ABI = [{
    "type": "function",
    "name": "payMatic",
    "stateMutability": "payable",
    "inputs": [
        {"type": "address", "name": "merchant"},
        {"type": "address", "name": "ipCreator"},
        {"type": "string",  "name": "orderId"},
    ],
    "outputs": [],
}]

# Anchor convention: discriminator = sha256("global:<fn_name>")[:8]
B2B_PAY_WITH_SPLIT_DISC = hashlib.sha256(b"global:b2b_pay_with_split").digest()[:8]


# ── Provider / Challenge types (lightweight, dict-backed) ──────────────────

@dataclass
class ProviderEntry:
    name:             str
    service_type:     Optional[str]
    bridge_url:       Optional[str]
    price_usd:        Optional[float]
    preferred_chain:  str = "polygon"

    @classmethod
    def from_dict(cls, d: dict) -> "ProviderEntry":
        return cls(
            name            = d.get("name", ""),
            service_type    = d.get("service_type"),
            bridge_url      = d.get("bridge_url"),
            price_usd       = d.get("price_usd"),
            preferred_chain = d.get("preferred_chain", "polygon"),
        )


@dataclass
class NetworkAgent:
    """A published entry in the public AiFinPay agent network — what
    ``search()`` returns and ``register()`` produces. Identity is the agent's
    EVM address. Mirrors the ``NetworkAgent`` interface in @aifinpay/agent."""
    address:      Optional[str]
    name:         Optional[str]
    description:  Optional[str]
    endpoint:     Optional[str]
    capabilities: list[str]
    pricing:      Optional[dict]   # {"per_call": float, "currency": str}
    rating:       Optional[float]
    published_at: Optional[int]
    created_at:   Optional[int]

    @classmethod
    def from_dict(cls, d: dict) -> "NetworkAgent":
        return cls(
            address      = d.get("address"),
            name         = d.get("name"),
            description  = d.get("description"),
            endpoint     = d.get("endpoint"),
            capabilities = d.get("capabilities") or [],
            pricing      = d.get("pricing"),
            rating       = d.get("rating"),
            published_at = d.get("published_at"),
            created_at   = d.get("created_at"),
        )


# ── Helpers ─────────────────────────────────────────────────────────────────

def _normalize_pricing(p: Optional[dict]) -> Optional[dict]:
    """Accept {"per_call"|"perCall": float, "currency"?: str}; default USDC."""
    if not p:
        return None
    per_call = p.get("per_call", p.get("perCall"))
    if per_call is None:
        return None
    return {"per_call": per_call, "currency": p.get("currency", "USDC")}


def _safe_json(r: requests.Response) -> dict:
    try:
        data = r.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _evm_key_from_seed(seed: bytes) -> bytes:
    """Canonical cross-SDK EVM key derivation: SHA-256("aifinpay:evm:v1\\0" + seed).

    Must stay byte-for-byte identical to `crypto32()` in the Node SDK
    (node/src/unifiedAgent.ts) — same seed MUST yield the same EVM address
    in both SDKs."""
    if len(seed) != 32:
        raise AiFinPayError(f"seed must be 32 bytes, got {len(seed)}")
    return hashlib.sha256(b"aifinpay:evm:v1\0" + seed).digest()


def _signed_raw_tx(signed: Any) -> bytes:
    """web3 v7 renamed SignedTransaction.rawTransaction → raw_transaction.
    Support both so the pinned range web3>=6.0 actually works."""
    raw = getattr(signed, "raw_transaction", None)
    if raw is None:
        raw = getattr(signed, "rawTransaction")
    return raw


def _guard_challenge_usd(est_usd: float, cap: Optional[float], label: str) -> None:
    """Sanity-check the USD estimate of an on-chain challenge amount BEFORE
    signing. Mirrors the Node SDK's guardChallengeAmount: the estimate uses
    env-priced MATIC/SOL (AIFINPAY_MATIC_USD / AIFINPAY_SOL_USD), so a 2x +
    $0.05 tolerance absorbs price drift while still catching the dangerous
    case — a bridge quoting $0.01 in the registry then demanding 100x in
    the 402 challenge. No cap declared → no check (caller opted out)."""
    from .errors import PaymentTooExpensiveError
    if cap is None or not est_usd or est_usd <= 0:
        return
    limit = max(cap * 2, cap + 0.05)
    if est_usd > limit:
        raise PaymentTooExpensiveError(
            f"bridge {label} challenge demands ≈${est_usd:.4f} on-chain, above "
            f"the allowed ${limit:.4f} (cost cap {cap:.4f} + tolerance). Set "
            f"AIFINPAY_MATIC_USD / AIFINPAY_SOL_USD for a tighter estimate."
        )


class _SpendTracker:
    """24h rolling spend ring buffer. Mirrors SpendTracker in unifiedAgent.ts."""

    def __init__(self) -> None:
        self._ring: list[tuple[float, float]] = []  # (ts_seconds, usd)

    def add(self, usd: float) -> None:
        now = time.time()
        self._ring.append((now, usd))
        cutoff = now - 24 * 3600
        while self._ring and self._ring[0][0] < cutoff:
            self._ring.pop(0)

    def total_24h(self) -> float:
        return sum(usd for _, usd in self._ring)


# ── Main class ──────────────────────────────────────────────────────────────

class AiFinPayAgent:
    """
    Unified, chain-opaque agent. Wraps the legacy Solana `Agent` and adds
    an EVM signer + high-level `call()` that selects + settles per call.
    """

    inner:        Agent
    evm_account:  Any            # eth_account.LocalAccount
    sol_keypair:  SolKeypair
    registry_url: str
    polygon_rpc:  str
    solana_rpc:   str

    # ── Constructors ────────────────────────────────────────────────────────

    def __init__(self, inner: Agent, evm_private_key_hex: str, *,
                 registry_url: Optional[str] = None,
                 polygon_rpc:  Optional[str] = None,
                 solana_rpc:   Optional[str] = None,
                 base_url:     Optional[str] = None,
                 telemetry:    bool = True,
                 budget_caps:  Optional[dict] = None,
                 heartbeat_interval_ms: int = 5 * 60 * 1000,
                 framework:    Optional[str] = None):
        self.inner       = inner
        # AIFP-1 client attribution — stored on the inner Agent (which
        # validates/lowercases and attaches it to its own session), and
        # mirrored onto the bridge 402 flow via _attribution_headers().
        if framework is not None:
            self.inner.framework = framework
        self.evm_account = EvmAccount.from_key(evm_private_key_hex)
        self.sol_keypair = SolKeypair.from_seed(
            nacl.signing.SigningKey(
                base58.b58decode(inner.secret_b58)[:32]
            ).encode(),
        )
        self.registry_url = registry_url or os.environ.get(
            "AIFINPAY_REGISTRY_URL",
            (base_url or "https://api.aifinpay.io").rstrip("/") + "/api/providers",
        )
        self.polygon_rpc = polygon_rpc or os.environ.get("AIFINPAY_POLYGON_RPC", DEFAULT_POLYGON_RPC)
        self.solana_rpc  = solana_rpc  or os.environ.get("AIFINPAY_SOLANA_RPC",  DEFAULT_SOLANA_RPC)
        self._w3: Optional[Web3] = None
        self._registry_cache: Optional[list[ProviderEntry]] = None
        # Telemetry (opt-out) — mirrors unifiedAgent.ts's `telemetry` flag.
        self._telemetry   = telemetry
        self._spend_24h   = _SpendTracker()
        self.budget_caps  = budget_caps or {}
        # Auto-heartbeat throttle — mirrors unifiedAgent.ts's maybeHeartbeat().
        # _last_heartbeat_ts=0 means "never fired yet this process", so the
        # first opportunistic heartbeat always goes out.
        self._heartbeat_interval_ms = heartbeat_interval_ms
        self._last_heartbeat_ts: float = 0
        # Cheap reuse: last balance() snapshot (from any caller), keyed by
        # wall-clock ms, so maybeHeartbeat() can skip a fresh RPC round-trip
        # when a recent one is already available.
        self._last_balance_snapshot: Optional[tuple[float, dict]] = None
        # Cookie for the operator's user-session (magic-link login). See
        # establish_user_session() / list_my_agents() — same mechanism the
        # MCP agent_claim_self tool uses.
        self._user_session_cookie: Optional[str] = None
        self._treasury_cache: dict = {}

    @classmethod
    def new(cls, **kwargs) -> "AiFinPayAgent":
        """Fresh dual-chain identity: random Solana keypair + random EVM key."""
        inner = Agent.new()
        evm_pk = "0x" + os.urandom(32).hex()
        return cls(inner, evm_pk, **kwargs)

    @classmethod
    def from_seed(cls, seed_hex: str, **kwargs) -> "AiFinPayAgent":
        """
        Derive both keypairs from one 32-byte hex seed.
          Solana key = nacl.sign.keyPair.fromSeed(seed)
          EVM key    = SHA-256(b"aifinpay:evm:v1\\0" + seed)
        Independent paths — NOT BIP-44. Byte-for-byte the Node SDK's
        derivation (it shipped first and settled the live pilot, so it is
        the canonical one). Earlier 0.3.0a releases of THIS package used
        keccak256(seed) here, which produced a DIFFERENT EVM address than
        Node for the same seed — that was a parity bug, fixed 2026-06-09.
        """
        seed = bytes.fromhex(seed_hex.removeprefix("0x"))
        if len(seed) != 32:
            raise AiFinPayError(f"seed must be 32 bytes, got {len(seed)}")
        signing = nacl.signing.SigningKey(seed)
        # secret_b58 is 64 bytes (secret + public) per tweetnacl convention
        secret_64 = signing.encode() + signing.verify_key.encode()
        inner = Agent.from_secret_b58(base58.b58encode(secret_64).decode())
        return cls(inner, "0x" + _evm_key_from_seed(seed).hex(), **kwargs)

    @classmethod
    def from_solana_secret(cls, secret_b58: str, *, evm_private_key: Optional[str] = None,
                            **kwargs) -> "AiFinPayAgent":
        """Load the Solana side from an existing secret. The EVM key is
        derived deterministically from the secret's 32-byte seed (same
        domain-separated SHA-256 as ``from_seed``) unless ``evm_private_key``
        is given. A random key here would change the EVM address on every
        restart and strand anything sent to the previous one."""
        inner = Agent.from_secret_b58(secret_b58)
        sol_seed = base58.b58decode(secret_b58)[:32]
        evm_pk = evm_private_key or ("0x" + _evm_key_from_seed(sol_seed).hex())
        return cls(inner, evm_pk, **kwargs)

    # ── Identity ───────────────────────────────────────────────────────────

    @property
    def id(self) -> str:
        """Canonical identity — Solana pubkey (for back-compat with the leaderboard)."""
        return self.inner.address

    @property
    def solana_address(self) -> str:
        return self.inner.address

    @property
    def evm_address(self) -> str:
        return self.evm_account.address

    @property
    def framework(self) -> Optional[str]:
        """AIFP-1 self-declared framework token (see Agent.framework)."""
        return self.inner.framework

    def _attribution_headers(self) -> dict:
        """Central AIFP-1 attribution for the bridge 402 flow, which uses
        bare ``requests`` (not the inner Agent's session). Empty when no
        framework is declared — the header is never sent by default."""
        fw = self.inner.framework
        return {"AIFP-Agent-Framework": fw} if fw else {}

    # ── Registry ──────────────────────────────────────────────────────────

    def fetch_registry(self, force: bool = False) -> list[ProviderEntry]:
        if self._registry_cache and not force:
            return self._registry_cache
        r = requests.get(self.registry_url, timeout=10)
        r.raise_for_status()
        data = r.json()
        providers = data.get("providers", [])
        self._registry_cache = [ProviderEntry.from_dict(p) for p in providers]
        return self._registry_cache

    def resolve_provider(self, name: str) -> ProviderEntry:
        for p in self.fetch_registry():
            if p.name == name:
                return p
        # Refresh once before giving up — registry may have new entries.
        self._registry_cache = None
        for p in self.fetch_registry():
            if p.name == name:
                return p
        raise AiFinPayError(f"Provider {name!r} not in registry at {self.registry_url}")

    # ── Network directory (publish / discover) ────────────────────────────
    #
    # Self-sovereign: the agent proves control of its EVM address by signing a
    # one-time nonce with its own key (EIP-191) — no partner account needed.
    # Backend verifies the same canonical message with viem.verifyMessage; the
    # template MUST stay byte-for-byte in sync with the Node SDK and
    # routes/network-agents.js.

    def register(self, *, name: str, endpoint: str,
                 description: Optional[str] = None,
                 capabilities: Optional[list[str]] = None,
                 pricing: Optional[dict] = None,
                 timeout: float = 10.0) -> NetworkAgent:
        """Publish this agent to the public AiFinPay network so other agents
        can discover and call it. ``pricing`` is a dict like
        ``{"per_call": 0.01, "currency": "USDC"}`` (``perCall`` also accepted)."""
        base  = self.inner.base_url
        addr  = self.evm_address.lower()
        nonce = self._network_nonce(timeout=timeout)
        signature = self._sign_evm(f"AiFinPay-network-publish:polygon:{addr}:{nonce}")

        payload = {
            "name":         name,
            "description":  description,
            "endpoint":     endpoint,
            "capabilities": capabilities or [],
            "pricing":      _normalize_pricing(pricing),
            "nonce":        nonce,
            "signature":    signature,
        }
        r = requests.post(
            f"{base}/api/network/agents/{addr}/publish",
            json=payload, timeout=timeout,
            headers={"content-type": "application/json"},
        )
        data = _safe_json(r)
        if not r.ok or not data.get("ok") or not data.get("agent"):
            raise AiFinPayError(
                f"network publish failed: {data.get('error') or r.status_code}"
            )
        return NetworkAgent.from_dict(data["agent"])

    def unregister(self, *, timeout: float = 10.0) -> None:
        """Remove this agent from the public directory (same signature proof)."""
        base  = self.inner.base_url
        addr  = self.evm_address.lower()
        nonce = self._network_nonce(timeout=timeout)
        signature = self._sign_evm(f"AiFinPay-network-unpublish:polygon:{addr}:{nonce}")
        r = requests.post(
            f"{base}/api/network/agents/{addr}/unpublish",
            json={"nonce": nonce, "signature": signature}, timeout=timeout,
            headers={"content-type": "application/json"},
        )
        if not r.ok:
            raise AiFinPayError(
                f"network unpublish failed: {_safe_json(r).get('error') or r.status_code}"
            )

    def search(self, capability: Optional[str] = None, *,
               q: Optional[str] = None, limit: Optional[int] = None,
               timeout: float = 10.0) -> list[NetworkAgent]:
        """Search the public network. Pass a bare capability
        (``agent.search("weather")``) or use ``q`` / ``limit`` for finer
        control. Returns directory entries; invoking one lands in a later
        release."""
        params: dict[str, Any] = {}
        if capability:
            params["capability"] = capability
        if q:
            params["q"] = q
        if limit:
            params["limit"] = limit
        r = requests.get(
            f"{self.inner.base_url}/api/network/agents",
            params=params, timeout=timeout,
        )
        if not r.ok:
            raise AiFinPayError(f"network search {self.inner.base_url} → {r.status_code}")
        return [NetworkAgent.from_dict(a) for a in (_safe_json(r).get("agents") or [])]

    def _network_nonce(self, *, timeout: float = 10.0) -> str:
        r = requests.get(f"{self.inner.base_url}/api/network/nonce", timeout=timeout)
        if not r.ok:
            raise AiFinPayError(f"network nonce → {r.status_code}")
        nonce = _safe_json(r).get("nonce")
        if not nonce:
            raise AiFinPayError("network nonce: empty response")
        return nonce

    def _sign_evm(self, message: str) -> str:
        """EIP-191 personal_sign with the agent's own EVM key — produces a
        signature verifiable by viem.verifyMessage on the backend."""
        signed = self.evm_account.sign_message(encode_defunct(text=message))
        sig = signed.signature.hex()
        return sig if sig.startswith("0x") else "0x" + sig

    # ── Lazy clients ──────────────────────────────────────────────────────

    def _web3(self) -> Web3:
        if self._w3 is None:
            w3 = Web3(Web3.HTTPProvider(self.polygon_rpc, request_kwargs={"timeout": 30}))
            if _poa_middleware is not None:
                try:
                    w3.middleware_onion.inject(_poa_middleware, layer=0)
                except Exception:
                    pass
            self._w3 = w3
        return self._w3

    def _splitter_treasury(self, splitter: str) -> Optional[str]:
        """Read + cache B2BSplitter.treasury(). None on RPC failure."""
        cache = getattr(self, "_treasury_cache", None)
        if cache is None:
            cache = self._treasury_cache = {}
        key = splitter.lower()
        if key in cache:
            return cache[key]
        try:
            w3 = self._web3()
            c = w3.eth.contract(
                address=Web3.to_checksum_address(splitter),
                abi=[{"type": "function", "name": "treasury",
                      "stateMutability": "view", "inputs": [],
                      "outputs": [{"type": "address"}]}],
            )
            treasury = c.functions.treasury().call()
            if not treasury or int(treasury, 16) == 0:
                return None
            cache[key] = treasury
            return treasury
        except Exception:
            return None

    # ── Public: chain-opaque call ─────────────────────────────────────────

    def call(self, provider: str, body: Optional[dict] = None, *,
             method: str = "POST", chain: Optional[str] = None,
             cost: Optional[float] = None, timeout: float = 60.0) -> requests.Response:
        """
        Make a paid call to a registered provider. Returns the upstream
        Response after the on-chain settlement has been confirmed.

        :param provider: Registry name ("exa", "io-net", "venice", …)
        :param body: JSON-serializable body forwarded to the bridge
        :param method: HTTP method (default POST)
        :param chain: Force a chain ("polygon" | "solana"). Defaults to
                      provider.preferred_chain or Polygon.
        :param cost: Soft override of the registry price (used as budget cap
                     hint — bridges quote the actual price in the 402).
        :param timeout: HTTP timeout per request, seconds.
        """
        p = self.resolve_provider(provider)
        url = p.bridge_url
        if not url:
            raise AiFinPayError(f"Provider {provider!r} has no bridge_url")

        # `cost` is a budget cap, not just a hint — enforce it. (It used to
        # be accepted and silently ignored.) Registry-level pre-check here;
        # the challenge-level guard runs in the settle path with the actual
        # on-chain amount.
        from .errors import PaymentTooExpensiveError
        if cost is not None and p.price_usd is not None and p.price_usd > cost:
            raise PaymentTooExpensiveError(
                f"provider {provider!r} lists ${p.price_usd:.4f} per call, "
                f"caller cap is ${cost:.4f}"
            )

        path = {
            "search":    "/search",
            "inference": "/chat/completions",
            "compute":   "/run",
            "analytics": "/query",
        }.get(p.service_type or "", "/")
        full_url = url.rstrip("/") + path

        picked_chain = (chain or p.preferred_chain or "polygon").lower()
        # Registry price is what actually gets billed/tracked; `cost` (when
        # given) is only a caller-side cap, not the amount to report.
        reported_cost = p.price_usd if p.price_usd is not None else (cost or 0)

        # 1. Initial unauthenticated POST → expect 402
        init_resp = requests.request(
            method, full_url,
            json=body if body is not None else None,
            timeout=timeout,
            headers={"content-type": "application/json",
                     **self._attribution_headers()},
        )
        if init_resp.status_code != 402:
            # Bridge didn't ask for payment — pass through. Nothing was
            # paid, so this does NOT count against budget caps.
            if self._telemetry:
                self._report_telemetry(kind="call", provider=p.name, chain=picked_chain,
                                        cost=reported_cost, free=True)
            self._maybe_heartbeat()
            return init_resp

        try:
            challenge = init_resp.json()
        except Exception:
            raise X402Error("bridge returned 402 with non-JSON body")

        if picked_chain == "solana":
            return self._settle_solana(full_url, challenge, method, body, timeout, cost=cost,
                                        provider_name=p.name, reported_cost=reported_cost)
        return self._settle_polygon(full_url, challenge, method, body, timeout, cost=cost,
                                     provider_name=p.name, reported_cost=reported_cost)

    # ── Cross-chain orchestration (Phase 1.5a: EVM↔EVM via LiFi) ───────────
    #
    # We orchestrate; we do not custody. The agent signs every step.
    # See Obsidian/21 - Unified Agent Economy non-goals.
    #
    # Typical flow for "agent has USDC on Base, merchant wants USDC on Polygon":
    #
    #   quote   = agent.bridge_quote(from_chain="base", to_chain="polygon",
    #                                amount_usdc=1.0)
    #   receipt = agent.bridge_execute(quote)            # sign source tx
    #   arrival = agent.bridge_wait_for_arrival(receipt.source_tx)
    #   # ...then proceed with agent.call(provider=..., chain="polygon")

    def bridge_quote(
        self,
        from_chain: str,
        to_chain:   str,
        *,
        amount_usdc: Optional[float] = None,
        from_token:  Optional[str]   = None,
        to_token:    Optional[str]   = None,
        from_amount: Optional[str]   = None,
        to_address:  Optional[str]   = None,
        slippage:    Optional[float] = None,
    ) -> BridgeQuote:
        """Quote a USDC-denominated cross-chain transfer via LiFi.

        Convenience: pass `amount_usdc` and the chain names — defaults to
        native USDC on both chains. For arbitrary token corridors, pass
        `from_token`, `to_token` (ERC-20 addresses) and `from_amount` (base
        units as a string). The agent's EVM address is used as both
        `fromAddress` and `toAddress` unless overridden.
        """
        ft = from_token or USDC_NATIVE.get(from_chain)
        tt = to_token   or USDC_NATIVE.get(to_chain)
        if not ft or not tt:
            raise AiFinPayError(
                f"bridge_quote: no default USDC token for {from_chain!r}/{to_chain!r}; "
                f"pass from_token + to_token explicitly"
            )
        amt = from_amount
        if amt is None and amount_usdc is not None:
            # USDC has 6 decimals.
            amt = str(round(amount_usdc * 1_000_000))
        if not amt:
            raise AiFinPayError(
                "bridge_quote: provide either amount_usdc OR from_amount (base units)"
            )
        return _bridge_quote(
            from_chain=from_chain,
            to_chain=to_chain,
            from_token=ft,
            to_token=tt,
            from_amount=amt,
            from_address=self.evm_address,
            to_address=to_address or self.evm_address,
            slippage=slippage,
        )

    def bridge_execute(self, quote: BridgeQuote) -> BridgeReceipt:
        """Execute a previously-fetched bridge quote.

        Signs and submits the source-chain transaction with the agent's EVM
        key on the SOURCE chain. Returns once source-side inclusion is
        confirmed; dest-side arrival is async — call
        ``bridge_wait_for_arrival(receipt.source_tx)`` if you need to block
        on it.

        web3.py is a required dependency of this SDK, so this method works
        out of the box. Internally we point the SDK's Web3 instance at the
        source chain. If you've configured `polygon_rpc` only and want to
        bridge from a non-Polygon source chain, override the Web3 endpoint
        before calling: set `agent._w3 = Web3(HTTPProvider(<source-rpc>))`.

        For operators who'd rather sign out-of-band (e.g. on a hardware
        wallet), grab `quote.raw_quote["transactionRequest"]` from the
        quote object and sign+broadcast it yourself.
        """
        return _bridge_execute(
            quote,
            evm_account=self.evm_account,
            web3=self._web3(),
        )

    def bridge_wait_for_arrival(
        self,
        source_tx_hash:   str,
        *,
        poll_interval_ms: int = 5000,
        timeout_ms:       int = 30 * 60 * 1000,
    ) -> dict:
        """Wait for the bridge to deliver on the destination chain.

        Wraps LiFi's /status polling; timeout default is 30 minutes (Circle
        CCTP can take 15-25 min on Polygon side). Raises AiFinPayError on
        timeout.
        """
        return _bridge_wait_for_arrival(
            source_tx_hash,
            poll_interval_ms=poll_interval_ms,
            timeout_ms=timeout_ms,
        )

    # ── Polygon settlement ─────────────────────────────────────────────────

    def _settle_polygon(self, full_url: str, challenge: dict, method: str,
                        body: Optional[dict], timeout: float,
                        cost: Optional[float] = None,
                        provider_name: Optional[str] = None,
                        reported_cost: float = 0) -> requests.Response:
        pm = challenge.get("pay_matic")
        if not pm:
            raise X402Error(
                "bridge returned 402 but no pay_matic block — "
                "use chain='solana' if the bridge supports it, or use the "
                "legacy generic facilitator client for non-AiFinPay 402s."
            )

        w3 = self._web3()
        splitter = w3.eth.contract(
            address=Web3.to_checksum_address(pm["splitter"]),
            abi=SPLITTER_PAY_MATIC_ABI,
        )
        merchant = Web3.to_checksum_address(pm["merchant_wallet"])
        # ipCreator routing: prefer the challenge's explicit ip_creator; else
        # route the royalty slot to the splitter's treasury (mirrors the Node
        # SDK + Solana branch). Passing address(0) would skip the transfer and
        # permanently strand the 1bp inside B2BSplitter — no sweep function.
        ip_creator = pm.get("ip_creator") or self._splitter_treasury(pm["splitter"]) \
            or ("0x" + "00" * 20)
        ip_creator = Web3.to_checksum_address(ip_creator)
        order_id = pm["order_id"]
        total_wei = int(pm["total_wei"])

        matic_usd = float(os.environ.get("AIFINPAY_MATIC_USD", "0.70"))
        _guard_challenge_usd(total_wei / 1e18 * matic_usd, cost, full_url)

        nonce = w3.eth.get_transaction_count(self.evm_address)
        gas_price = w3.eth.gas_price
        tx = splitter.functions.payMatic(merchant, ip_creator, order_id).build_transaction({
            "from":     self.evm_address,
            "value":    total_wei,
            "nonce":    nonce,
            "gasPrice": gas_price,
            "chainId":  137,  # Polygon mainnet
        })
        # Estimate gas with a small buffer
        try:
            gas_est = w3.eth.estimate_gas(tx)
            tx["gas"] = int(gas_est * 1.2)
        except Exception:
            tx["gas"] = 300_000  # safe default

        signed = w3.eth.account.sign_transaction(tx, self.evm_account.key)
        tx_hash = w3.eth.send_raw_transaction(_signed_raw_tx(signed))
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise AiFinPayError(f"Polygon tx reverted: {tx_hash.hex()}")

        # Retry the bridge with payment proof
        paid_resp = requests.request(
            method, full_url,
            json=body if body is not None else None,
            timeout=timeout,
            headers={
                "content-type": "application/json",
                "x-tx-hash":    tx_hash.hex(),
                "x-order-id":   order_id,
                **self._attribution_headers(),
            },
        )
        if not paid_resp.ok:
            raise AiFinPayError(
                f"Bridge retry failed {paid_resp.status_code} after on-chain payment "
                f"{tx_hash.hex()}: {paid_resp.text[:300]}"
            )
        self._spend_24h.add(reported_cost)
        if self._telemetry:
            self._report_telemetry(kind="call", provider=provider_name, chain="polygon",
                                    cost=reported_cost, tx=tx_hash.hex())
        self._maybe_heartbeat()
        return paid_resp

    # ── Solana settlement (b2b_pay_with_split) ───────────────────────────

    def _settle_solana(self, full_url: str, challenge: dict, method: str,
                       body: Optional[dict], timeout: float,
                       cost: Optional[float] = None,
                       provider_name: Optional[str] = None,
                       reported_cost: float = 0) -> requests.Response:
        ps = challenge.get("pay_solana")
        if not ps:
            raise X402Error(
                f"bridge returned 402 without a pay_solana block — operator has not "
                f"set BRIDGE_MERCHANT_SOLANA. Use chain='polygon' instead."
            )

        sol_usd = float(os.environ.get("AIFINPAY_SOL_USD", "200"))
        lamports_est = int(ps.get("total_lamports") or ps["merchant_amount_lamports"])
        _guard_challenge_usd(lamports_est / 1e9 * sol_usd, cost, full_url)

        program_id = SolPubkey.from_string(ps["program_id"])
        merchant   = SolPubkey.from_string(ps["merchant_wallet"])
        treasury   = SolPubkey.from_string(ps["treasury"])
        ip_creator = treasury  # default routing; future: per-merchant slot
        order_id   = ps["order_id"]
        merchant_amount_lamports = int(ps["merchant_amount_lamports"])

        # PDAs derived from program_id with seeds ["config"] and ["vault"]
        config_pda, _ = SolPubkey.find_program_address([b"config"], program_id)
        vault_pda,  _ = SolPubkey.find_program_address([b"vault"],  program_id)

        # Instruction data: discriminator + Borsh(u64 + string)
        order_bytes = order_id.encode("utf-8")
        if len(order_bytes) > 64:
            raise AiFinPayError(f"order_id too long ({len(order_bytes)} bytes > 64)")
        data = (
            B2B_PAY_WITH_SPLIT_DISC
            + struct.pack("<Q", merchant_amount_lamports)
            + struct.pack("<I", len(order_bytes))
            + order_bytes
        )

        agent_pubkey = self.sol_keypair.pubkey()
        keys = [
            AccountMeta(pubkey=config_pda,            is_signer=False, is_writable=False),
            AccountMeta(pubkey=vault_pda,             is_signer=False, is_writable=False),
            AccountMeta(pubkey=agent_pubkey,          is_signer=True,  is_writable=True),
            AccountMeta(pubkey=treasury,              is_signer=False, is_writable=True),
            AccountMeta(pubkey=ip_creator,            is_signer=False, is_writable=True),
            AccountMeta(pubkey=merchant,              is_signer=False, is_writable=True),
            AccountMeta(pubkey=SolPubkey.from_string(str(SYSTEM_PROGRAM_ID)), is_signer=False, is_writable=False),
        ]
        ix = Instruction(program_id=program_id, accounts=keys, data=data)

        # Fetch recent blockhash + submit
        rpc_req = lambda payload: requests.post(self.solana_rpc, json=payload, timeout=timeout).json()
        bh_resp = rpc_req({"jsonrpc": "2.0", "id": 1, "method": "getLatestBlockhash",
                           "params": [{"commitment": "confirmed"}]})
        blockhash = SolHash.from_string(bh_resp["result"]["value"]["blockhash"])

        msg = SolMessage.new_with_blockhash([ix], agent_pubkey, blockhash)
        tx  = SolTransaction([self.sol_keypair], msg, blockhash)

        # Solana RPC sendTransaction accepts base58 (deprecated) or base64 —
        # NOT hex. The old {"encoding": "hex"} form failed on every node.
        import base64 as _b64
        send_resp = rpc_req({"jsonrpc": "2.0", "id": 1, "method": "sendTransaction",
                             "params": [_b64.b64encode(bytes(tx)).decode("ascii"),
                                        {"encoding": "base64", "preflightCommitment": "confirmed"}]})
        if "error" in send_resp:
            raise AiFinPayError(f"Solana send failed: {send_resp['error']}")
        tx_sig = send_resp["result"]

        # Wait for confirmation (poll up to ~30s)
        deadline = time.time() + 30
        confirmed = False
        while time.time() < deadline:
            time.sleep(2)
            st = rpc_req({"jsonrpc": "2.0", "id": 1, "method": "getSignatureStatuses",
                          "params": [[tx_sig], {"searchTransactionHistory": True}]})
            value = (st.get("result", {}) or {}).get("value", [None])[0]
            if value and value.get("confirmationStatus") in ("confirmed", "finalized"):
                if value.get("err") is not None:
                    raise AiFinPayError(f"Solana tx errored: {value['err']}")
                confirmed = True
                break
        if not confirmed:
            raise AiFinPayError(f"Solana tx {tx_sig} not confirmed within 30s")

        paid_resp = requests.request(
            method, full_url,
            json=body if body is not None else None,
            timeout=timeout,
            headers={
                "content-type": "application/json",
                "x-solana-tx":  tx_sig,
                "x-order-id":   order_id,
                **self._attribution_headers(),
            },
        )
        if not paid_resp.ok:
            raise AiFinPayError(
                f"Bridge retry failed {paid_resp.status_code} after Solana payment "
                f"{tx_sig}: {paid_resp.text[:300]}"
            )
        self._spend_24h.add(reported_cost)
        if self._telemetry:
            self._report_telemetry(kind="call", provider=provider_name, chain="solana",
                                    cost=reported_cost, tx=tx_sig)
        self._maybe_heartbeat()
        return paid_resp

    # ── Budget caps ─────────────────────────────────────────────────────────

    def set_budget(self, *, daily_usd: Optional[float] = None,
                    per_call_usd: Optional[float] = None) -> None:
        """Set soft budget caps. Mirrors ``setBudget()`` in unifiedAgent.ts.
        Only enforced by ``call()``'s registry-level pre-check today (the
        Node SDK's on_limit_exceeded="skip" behavior is not ported here)."""
        caps: dict = {}
        if daily_usd is not None:
            caps["daily_usd"] = daily_usd
        if per_call_usd is not None:
            caps["per_call_usd"] = per_call_usd
        self.budget_caps = caps

    def get_spend_24h(self) -> float:
        """Current 24h rolling spend across paid calls made by this
        instance. Mirrors ``getSpend24h()`` in unifiedAgent.ts."""
        return self._spend_24h.total_24h()

    # ── Balance ─────────────────────────────────────────────────────────────

    def balance(self) -> dict:
        """Snapshot the agent's funds across both chains, USD-normalised.
        Mirrors ``balance()`` in unifiedAgent.ts (Phase 1.4 scope: native
        MATIC/SOL via RPC + SPL/ERC-20 USDC; Pyth feeds are TODO — uses
        ``AIFINPAY_MATIC_USD`` / ``AIFINPAY_SOL_USD`` env, defaulting to
        0.70 / 200). Never raises — RPC failures degrade to 0 balances so
        this stays safe to call from ``report_heartbeat()``."""
        matic_usd = float(os.environ.get("AIFINPAY_MATIC_USD", "0.70"))
        sol_usd   = float(os.environ.get("AIFINPAY_SOL_USD", "200"))

        polygon      = self._fetch_polygon_native()
        polygon_usdc = self._fetch_polygon_usdc()
        solana       = self._fetch_solana_native()
        solana_usdc  = self._fetch_solana_usdc()

        snapshot = {
            "agent_balance_usd": polygon * matic_usd + solana * sol_usd + polygon_usdc + solana_usdc,
            "chains": {
                "solana":  {"sol": solana, "usdc": solana_usdc, "msecco_balance": 0},
                "polygon": {"matic": polygon, "usdc": polygon_usdc, "msecco_balance": 0},
            },
            "spend_24h_usd": self.get_spend_24h(),
            "budget_caps": self.budget_caps,
            "priced_at": int(time.time()),
        }
        # Cache for maybe_heartbeat() reuse — see rationale there.
        self._last_balance_snapshot = (time.time() * 1000, snapshot)
        return snapshot

    def _fetch_polygon_native(self) -> float:
        try:
            wei = self._web3().eth.get_balance(self.evm_address)
            return wei / 1e18
        except Exception:
            return 0

    def _fetch_polygon_usdc(self) -> float:
        # Native Polygon USDC ERC20 (Circle-native, not bridged USDC.e)
        usdc_addr = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
        try:
            w3 = self._web3()
            c = w3.eth.contract(
                address=Web3.to_checksum_address(usdc_addr),
                abi=[{"type": "function", "name": "balanceOf", "stateMutability": "view",
                      "inputs": [{"type": "address", "name": "owner"}],
                      "outputs": [{"type": "uint256"}]}],
            )
            raw = c.functions.balanceOf(self.evm_address).call()
            return raw / 1e6  # USDC has 6 decimals on Polygon
        except Exception:
            return 0

    def _fetch_solana_native(self) -> float:
        try:
            r = requests.post(self.solana_rpc, timeout=10, json={
                "jsonrpc": "2.0", "id": 1, "method": "getBalance",
                "params": [self.solana_address],
            })
            lamports = ((r.json() or {}).get("result") or {}).get("value") or 0
            return lamports / 1e9
        except Exception:
            return 0

    def _fetch_solana_usdc(self) -> float:
        # Mainnet USDC SPL mint on Solana (Circle native, not Wormhole-wrapped)
        usdc_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        try:
            r = requests.post(self.solana_rpc, timeout=10, json={
                "jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
                "params": [self.solana_address, {"mint": usdc_mint}, {"encoding": "jsonParsed"}],
            })
            accounts = ((r.json() or {}).get("result") or {}).get("value") or []
            total = 0.0
            for acc in accounts:
                try:
                    ui = acc["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmount"]
                    if isinstance(ui, (int, float)):
                        total += ui
                except (KeyError, TypeError):
                    continue
            return total
        except Exception:
            return 0

    # ── Owner user-session (magic-link) ────────────────────────────────────

    def establish_user_session(self, magic_link_url: str, *, timeout: float = 10.0) -> None:
        """Establish the operator's user-session by hitting a magic-link
        URL — same mechanism the MCP ``agent_claim_self`` tool uses inline:
        the link is a one-shot, ~15-min-TTL sign-in URL like
        ``https://aifinpay.io/api/auth/verify?token=…`` that the user
        pastes in after signing in at https://aifinpay.io/login. The
        resulting session cookie (``__aifinpay_user_session``) is cached on
        this instance and reused by ``list_my_agents()`` — call this once
        per process, not per call.
        """
        r = requests.get(magic_link_url, timeout=timeout, allow_redirects=False)
        set_cookie = r.headers.get("set-cookie")
        if not set_cookie:
            raise AiFinPayError(
                f"Magic link did not return a session cookie (HTTP {r.status_code}). "
                f"Link may be expired or already used."
            )
        # Some setups split multiple cookies; keep the header verbatim minus
        # attributes (Path=/, HttpOnly, …) — same trim as the Node SDK /
        # agent-claim-self.ts.
        self._user_session_cookie = "; ".join(
            part.strip().split(";")[0] for part in set_cookie.split(",")
        )

    def adopt_user_session_cookie(self, cookie_header: str) -> None:
        """Adopt an already-computed session cookie header (e.g. one an MCP
        ``agent_claim_self``-equivalent flow derived from the same magic
        link) without re-fetching the magic link."""
        self._user_session_cookie = cookie_header

    def list_my_agents(self, *, timeout: float = 10.0) -> list[dict]:
        """List agents owned by the signed-in operator, with balance/spend/
        health fields for each, over a rolling window. Requires
        ``establish_user_session()`` (or ``adopt_user_session_cookie()``) to
        have run first — otherwise raises ``AiFinPayError``.

        Calls ``GET {base_url}/api/me/agents/overview`` — owner-gated, same
        ``__aifinpay_user_session`` cookie as ``/api/me/agents/challenge``
        and ``/api/me/agents/claim``. Returns the parsed ``agents`` array
        from ``{ window, agents: [...] }``.
        """
        if not self._user_session_cookie:
            raise AiFinPayError(
                "No user session established. Run the claim flow first — "
                "sign in at https://aifinpay.io/login, then call "
                "establish_user_session(magic_link_url) with the emailed "
                "link, or use the MCP agent_claim_self tool, before calling "
                "list_my_agents()."
            )
        r = requests.get(
            f"{self.inner.base_url}/api/me/agents/overview",
            timeout=timeout,
            headers={"accept": "application/json", "cookie": self._user_session_cookie},
        )
        if r.status_code == 401:
            raise AiFinPayError(
                "User session expired or invalid — re-run establish_user_session() "
                "with a fresh magic link."
            )
        if not r.ok:
            raise AiFinPayError(f"GET /api/me/agents/overview → {r.status_code}")
        data = _safe_json(r)
        return data.get("agents") or []

    # ── Telemetry (opt-out) ─────────────────────────────────────────────────

    def _report_telemetry(self, **payload: Any) -> None:
        """Best-effort, non-blocking-in-spirit report. No body content,
        only metadata. Mirrors ``reportTelemetry()`` in unifiedAgent.ts —
        the Node SDK fires this without awaiting; Python's ``requests`` is
        synchronous, so we use a short timeout and swallow all errors so a
        slow/unreachable telemetry endpoint never breaks a paid call."""
        try:
            requests.post(
                f"{self.inner.base_url}/api/telemetry",
                timeout=3,
                json={"agent_id": self.id, **payload, "ts": int(time.time() * 1000)},
            )
        except Exception:
            pass

    def report_heartbeat(self) -> None:
        """Opt-in "advisory" heartbeat — reports the agent's own view of
        its budget caps, 24h spend, and balances so an operator dashboard
        can show "reported by your agent" liveness. This is NOT
        server-enforced: the backend does not verify these numbers
        on-chain, it just displays what the agent self-reports. Respects
        the same telemetry opt-out as ``call()``'s per-request reporting.
        Best-effort — never raises."""
        if not self._telemetry:
            return
        try:
            bal = self.balance()
        except Exception:
            return
        self._report_telemetry(
            kind="heartbeat",
            budget_caps=self.budget_caps,
            spend_24h_usd=bal["spend_24h_usd"],
            balances=bal["chains"],
        )
        self._last_heartbeat_ts = time.time() * 1000

    def _maybe_heartbeat(self) -> None:
        """Opportunistic, throttled heartbeat — called internally after a
        SUCCESSFUL call()/pay() so the dashboard's "agent-reported caps"
        section stays warm without every caller having to remember to call
        report_heartbeat() by hand. Mirrors maybeHeartbeat() in
        unifiedAgent.ts.

        Throttle: at most once per ``_heartbeat_interval_ms`` (default
        5 min), tracked via ``_last_heartbeat_ts`` — never fires more often
        than that regardless of call volume.

        Cost control: does NOT force a fresh balance() RPC round-trip on
        every heartbeat. It reuses ``_last_balance_snapshot`` if one exists
        and is no older than ``_heartbeat_interval_ms``; otherwise it sends
        budget_caps + spend_24h only (balances omitted) rather than paying
        for a live RPC call on this opportunistic path. Call ``balance()``
        or ``report_heartbeat()`` explicitly for a heartbeat with a
        guaranteed-fresh balance.

        Best-effort: never raises, never blocks call()/pay() (Python's
        ``requests`` is synchronous, so "non-blocking" here means "bounded
        by the same short timeout as ``_report_telemetry``", matching the
        existing per-call telemetry reporting in this file).
        """
        if not self._telemetry:
            return
        now = time.time() * 1000
        if now - self._last_heartbeat_ts < self._heartbeat_interval_ms:
            return
        self._last_heartbeat_ts = now  # claim the slot before the network call

        fresh = None
        if self._last_balance_snapshot is not None:
            snap_at, snap = self._last_balance_snapshot
            if now - snap_at < self._heartbeat_interval_ms:
                fresh = snap

        payload: dict[str, Any] = {
            "kind": "heartbeat",
            "budget_caps": self.budget_caps,
            "spend_24h_usd": self.get_spend_24h(),
        }
        if fresh is not None:
            payload["balances"] = fresh["chains"]
        try:
            self._report_telemetry(**payload)
        except Exception:
            pass

    def pay(self, url: str, *, method: str = "GET", max_retries: int = 1,
            options: Optional[PayOptions] = None, **request_kwargs) -> requests.Response:
        """Generic x402 payment with telemetry — thin wrapper over
        ``inner.pay(url)`` that reports a ``kind="call", via="pay"``
        telemetry event on success, mirroring the reporting ``call()``
        already does for registry-resolved payments. Unlike ``call()``,
        the generic x402 flow (native AiFinPay + Coinbase facilitators)
        does not settle through a bridge that returns a verifiable tx hash
        here, so ``cost`` reflects the caller's declared
        ``options.max_amount_usd`` cap (if any) rather than a confirmed
        on-chain amount — same "advisory" caveat as ``report_heartbeat()``.
        """
        resp = self.inner.pay(url, method=method, max_retries=max_retries,
                               options=options, **request_kwargs)
        if self._telemetry:
            try:
                from urllib.parse import urlparse
                host = urlparse(url).netloc or None
            except Exception:
                host = None
            max_amount_usd = options.max_amount_usd if options else None
            self._report_telemetry(kind="call", via="pay", provider=host, cost=max_amount_usd)
        self._maybe_heartbeat()
        return resp
