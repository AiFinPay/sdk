"""The gate — a framework-agnostic decision function.

A port of gate/src/core.ts (createGate), in the same order, with the same
answers and the same sentences — tests/test_parity.py replays scenarios
recorded from the Node package and requires identical results. The ASGI and
WSGI adapters are thin wrappers around :meth:`Gate.decide`.

What it deliberately does not do, as in Node: free-unit allowances, daily caps
and per-agent blocks stay in the hosted control plane, so there is one source
of truth for a rule the merchant edits in the dashboard.
"""

import math
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Protocol, Sequence

from .challenge import build_challenge
from .pricing import weight_for_tier
from .scope import pattern_covers, scope_covers
from .stores import MemoryStore
from .verify import DEFAULT_ISSUER, DEFAULT_JWKS_URI, Verifier

DETAIL_QUOTA_EXHAUSTED = "quota exhausted — prepay the next batch"
DETAIL_RECEIPT_EXPIRED = "receipt expired — prepay a new batch"
DETAIL_VERIFY_FAILED = "receipt verification failed (signature/issuer/audience)"
HEADER_QUOTA_REMAINING = "AIFP-Quota-Remaining"
TIERS = ("standard", "complex", "premium")


class GateRequest(Protocol):
    path: str

    def header(self, name: str) -> Optional[str]: ...


@dataclass
class SimpleRequest:
    """A request as the gate needs it: a path, headers and (for routes) a method."""

    path: str
    headers: Dict[str, str] = field(default_factory=dict)
    method: str = "GET"

    def __post_init__(self):
        self._lower = {k.lower(): v for k, v in self.headers.items()}

    def header(self, name: str) -> Optional[str]:
        return self._lower.get(name.lower())


@dataclass(frozen=True)
class Route:
    """One paid route. ``pattern`` is exact or ends in ``/*`` (the section and
    everything under it) — the same matcher as the hosted gateway. The longest
    matching pattern wins. ``methods=None`` gates every method."""

    pattern: str
    tier: str = "standard"
    weight: Optional[int] = None
    methods: Optional[FrozenSet[str]] = None
    paywall: bool = True

    def __post_init__(self):
        if not self.pattern.startswith("/"):
            raise ValueError(f'route pattern must start with "/": {self.pattern!r}')
        if "*" in self.pattern[:-1] or (self.pattern.endswith("*") and not self.pattern.endswith("/*")):
            raise ValueError(f'only a trailing "/*" wildcard is supported: {self.pattern!r}')
        if self.tier not in TIERS:
            raise ValueError(f"tier must be one of {TIERS}: {self.tier!r}")
        if self.weight is not None and (not isinstance(self.weight, int) or self.weight < 1):
            raise ValueError("weight must be a positive integer")
        if self.methods is not None:
            object.__setattr__(self, "methods", frozenset(m.upper() for m in self.methods))


@dataclass
class GateResult:
    ok: bool
    status: int
    headers: Dict[str, str]
    body: Optional[Dict[str, Any]] = None
    aifp: Optional[Dict[str, Any]] = None

    def as_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"ok": self.ok, "status": self.status, "headers": self.headers}
        if self.body is not None:
            out["body"] = self.body
        if self.aifp is not None:
            out["aifp"] = self.aifp
        return out


def _json_headers(**extra: str) -> Dict[str, str]:
    return {"Content-Type": "application/json", **extra}


class Gate:
    """Decide whether a request is served, and meter it.

    Two ways to mount it, as in Node:

    * ``Gate(merchant_id, resource="/api/search", tier="complex")`` — one paid
      resource; every request handed to it is charged against it.
    * ``Gate(merchant_id, routes=[Route("/create", "premium", methods={"POST"}),
      Route("/api/*")])`` — for middleware over a whole app: matched routes are
      charged, :meth:`decide` returns ``None`` for everything else.
    """

    def __init__(
        self,
        merchant_id: str,
        *,
        resource: Optional[str] = None,
        tier: str = "standard",
        weight: Optional[int] = None,
        routes: Optional[Sequence[Route]] = None,
        store: Any = None,
        issuer: str = DEFAULT_ISSUER,
        jwks_uri: str = DEFAULT_JWKS_URI,
        jwks: Optional[Dict[str, Any]] = None,
        key_prefix: str = "aifp:",
        clock_tolerance_s: int = 30,
        api_base: Optional[str] = None,
        replay: str = "auto",
        require_agent_match: bool = False,
        on_store_error: str = "closed",
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        allow: Optional[Callable[[Dict[str, Any]], bool]] = None,
        should_charge: Optional[Callable[[GateRequest], bool]] = None,
        now: Callable[[], float] = time.time,
    ):
        if not merchant_id:
            raise ValueError("Gate: merchant_id is required")
        if resource is not None and routes is not None:
            raise ValueError("Gate: pass either resource (one mount) or routes (middleware), not both")
        if replay not in ("auto", "always", "off"):
            raise ValueError("replay must be auto, always or off")
        if on_store_error not in ("closed", "open"):
            raise ValueError("on_store_error must be closed or open")
        self.merchant_id = merchant_id
        self.resource = resource
        self.tier = tier
        self.mount_weight = weight if isinstance(weight, int) and weight > 0 else weight_for_tier(tier)
        self.routes: Optional[List[Route]] = list(routes) if routes is not None else None
        self.store = store if store is not None else MemoryStore()
        self.key_prefix = key_prefix
        self.api_base = api_base
        self.replay = replay
        self.require_agent_match = require_agent_match
        self.on_store_error = on_store_error
        self.on_event = on_event
        self.allow = allow
        self.should_charge = should_charge
        self._now = now
        self.verify = Verifier(issuer, merchant_id, clock_tolerance_s, jwks_uri, jwks, now=now)

    # ── routing ─────────────────────────────────────────────────────────────

    def route_for(self, path: str, method: Optional[str] = None) -> Optional[Route]:
        best: Optional[Route] = None
        for r in self.routes or ():
            if r.methods is not None and method is not None and method.upper() not in r.methods:
                continue
            if not pattern_covers(r.pattern, path):
                continue
            if best is None or len(r.pattern) > len(best.pattern):
                best = r
        return best

    def discovery_resources(self) -> List[Dict[str, Any]]:
        if self.routes is None:
            return [{"resource": self.resource, "tier": self.tier}] if self.resource else []
        return [{"resource": r.pattern, "tier": r.tier} for r in self.routes if r.paywall]

    # ── helpers ─────────────────────────────────────────────────────────────

    def _emit(self, event: Dict[str, Any]) -> None:
        if self.on_event is None:
            return
        try:
            self.on_event(event)
        except Exception:  # noqa: BLE001 — observability is never load-bearing
            pass

    def _allowed(self, ctx: Dict[str, Any]) -> bool:
        if self.allow is None:
            return True
        try:
            return self.allow(ctx) is not False
        except Exception:  # noqa: BLE001 — a throwing veto is "no opinion"
            return True

    def _challenge(self, resource: str, weight: int, tier: str, detail: Optional[str] = None) -> GateResult:
        self._emit({"kind": "402", "resource": resource, "weight": weight, "detail": detail})
        body = build_challenge(self.merchant_id, resource, tier, weight, detail=detail, api_base=self.api_base)
        return GateResult(False, 402, _json_headers(), body=body)

    def _forbid(self, resource: str, weight: int, detail: str) -> GateResult:
        self._emit({"kind": "403", "resource": resource, "weight": weight, "detail": detail})
        return GateResult(False, 403, _json_headers(), body={"error": "AIFP-403", "detail": detail})

    def _free(self, resource: str, agent: Optional[str], mode: str, paywall_header: str) -> GateResult:
        return GateResult(True, 200, {"AIFP-Paywall": paywall_header}, aifp={
            "agent": agent, "receipt_id": "", "resource": resource, "weight": 0,
            "unit_quota": 0, "used": 0, "remaining": 0, "mode": mode,
        })

    # ── the decision ────────────────────────────────────────────────────────

    def decide(self, req: GateRequest) -> Optional[GateResult]:
        """``None`` means this gate does not cover the path (routes mode only)."""
        path = req.path
        if self.routes is not None:
            route = self.route_for(path, getattr(req, "method", None))
            if route is None:
                return None
            resource, tier = route.pattern, route.tier
            weight = route.weight or weight_for_tier(tier)
            scope_path = path  # a receipt names a real path; "/api/*" is not one
        else:
            route = None
            resource, tier, weight = (self.resource or path), self.tier, self.mount_weight
            scope_path = self.resource or path
        agent_header = req.header("AIFP-Agent-Id")

        # Explicitly free route: no metering, no batch spend.
        if route is not None and not route.paywall:
            if not self._allowed({"path": path, "resource": resource, "weight": weight,
                                  "agent": agent_header, "receipt_id": None}):
                return self._forbid(resource, weight, "blocked by merchant policy")
            self._emit({"kind": "serve", "resource": resource, "weight": weight, "agent": agent_header})
            return self._free(resource, agent_header, "open", "off")

        # WHO pays — before the missing-receipt challenge, or a human reader
        # would meet the 402. A predicate that raises charges.
        if self.should_charge is not None:
            try:
                charge = bool(self.should_charge(req))
            except Exception:  # noqa: BLE001
                charge = True
            if not charge:
                if not self._allowed({"path": path, "resource": resource, "weight": weight,
                                      "agent": agent_header, "receipt_id": None}):
                    return self._forbid(resource, weight, "blocked by merchant policy")
                self._emit({"kind": "serve", "resource": resource, "weight": weight, "agent": agent_header,
                            "exempt": True})
                return self._free(resource, agent_header, "exempt", "exempt")

        token = req.header("AIFP-Receipt")
        if not token:
            return self._challenge(resource, weight, tier)

        kind, payload = self.verify(token)
        if kind != "ok":
            if kind == "expired":
                return self._challenge(resource, weight, tier, DETAIL_RECEIPT_EXPIRED)
            if kind == "jwks_unavailable":
                # Fail CLOSED: failing open would make a paid API free for the
                # length of an AiFinPay outage.
                self._emit({"kind": "meter_error", "resource": resource, "weight": weight, "detail": payload})
                return GateResult(False, 503, _json_headers(**{"Retry-After": "30"}), body={
                    "error": "AIFP-503-METER",
                    "detail": "receipt verification is temporarily unavailable — retry shortly",
                })
            return self._forbid(resource, weight, DETAIL_VERIFY_FAILED)

        # A valid signature is not a licence to spend: only quota receipts buy
        # calls. Allow-list, so a token kind added later is refused today.
        typ = payload.get("typ_aifp")
        if typ is not None and typ != "quota":
            return self._forbid(
                resource, weight, f'receipt type "{typ}" is not spendable — this endpoint needs a quota receipt'
            )
        receipt_id = payload.get("receipt_id")
        if not isinstance(receipt_id, str) or receipt_id == "":
            return self._forbid(resource, weight, "receipt carries no receipt_id and cannot be metered")

        if not scope_covers(payload.get("scope"), payload.get("resource"), scope_path):
            return self._forbid(
                resource, weight,
                f"receipt is scoped to {payload.get('resource')} ({payload.get('scope') or 'exact'}), not {scope_path}",
            )

        sub = payload.get("sub")
        if self.require_agent_match and agent_header and sub and agent_header != sub:
            return self._forbid(resource, weight, "AIFP-Agent-Id does not match the receipt subject")

        if not self._allowed({"path": path, "resource": resource, "weight": weight,
                              "agent": sub, "receipt_id": receipt_id}):
            return self._forbid(resource, weight, "blocked by merchant policy")

        # Limit in billing units; a legacy request `quota` converts at the tier
        # weight it was priced for.
        if payload.get("unit_quota") is not None:
            limit = _number(payload["unit_quota"])
        else:
            quota = _number(payload.get("quota"))
            limit = (quota if quota == quota and quota != 0 else 1) * weight_for_tier(payload.get("tier"))
        # Stricter than the Node gate: a non-numeric quota compares false with
        # everything, so "used > limit" would never refuse and the batch would
        # never run out.
        if not (limit == limit and math.isfinite(limit)) or limit <= 0:
            return self._forbid(resource, weight, "receipt carries no usable unit_quota")
        # The counter dies with the receipt — never later, never earlier.
        ttl_ms = max(1000, int(payload["exp"] * 1000 - self._now() * 1000))

        if self.replay == "always" or (self.replay == "auto" and limit <= 1):
            nonce = payload.get("nonce")
            if not isinstance(nonce, str) or nonce == "":
                return self._forbid(resource, weight, "single-use receipt carries no nonce")
            try:
                seen = self.store.incr_by(f"{self.key_prefix}nonce:{nonce}", 1, ttl_ms)
            except Exception as e:  # noqa: BLE001
                return self._store_failure(e, resource, weight, payload, limit)
            if seen > 1:
                return self._forbid(resource, weight, "receipt already spent (single-use)")

        try:
            used = self.store.incr_by(f"{self.key_prefix}used:{receipt_id}", weight, ttl_ms)
        except Exception as e:  # noqa: BLE001
            return self._store_failure(e, resource, weight, payload, limit)

        # Post-increment compare: whichever request crosses the limit is the one
        # refused, exactly once.
        if used > limit:
            return self._challenge(resource, weight, tier, DETAIL_QUOTA_EXHAUSTED)

        self._emit({"kind": "serve", "resource": resource, "weight": weight, "agent": sub, "receipt_id": receipt_id})
        remaining = _int_if_whole(limit - used)
        return GateResult(True, 200, {HEADER_QUOTA_REMAINING: str(remaining)}, aifp={
            "agent": sub, "receipt_id": receipt_id, "resource": resource, "weight": weight,
            "unit_quota": _int_if_whole(limit), "used": used, "remaining": remaining, "mode": "paid",
        })

    def _store_failure(self, e: Exception, resource: str, weight: int, payload: Dict[str, Any],
                       limit: float) -> GateResult:
        self._emit({"kind": "meter_error", "resource": resource, "weight": weight, "detail": str(e)})
        if self.on_store_error == "open":
            # Availability chosen over metering: served and NOT counted.
            return GateResult(True, 200, {"AIFP-Meter": "degraded"}, aifp={
                "agent": payload.get("sub"), "receipt_id": payload["receipt_id"], "resource": resource,
                "weight": weight, "unit_quota": _int_if_whole(limit), "used": 0,
                "remaining": _int_if_whole(limit), "mode": "paid",
            })
        return GateResult(False, 503, _json_headers(**{"Retry-After": "5"}), body={
            "error": "AIFP-503-METER", "detail": "quota store unavailable — retry shortly",
        })

    def refund(self, aifp: Dict[str, Any]) -> None:
        """Give back the units a call consumed after the handler failed. Best effort."""
        decr = getattr(self.store, "decr_by", None)
        if decr is None or not aifp or aifp.get("mode") != "paid" or aifp.get("weight", 0) <= 0:
            return
        try:
            decr(f"{self.key_prefix}used:{aifp['receipt_id']}", aifp["weight"])
        except Exception:  # noqa: BLE001
            pass


def _number(v: Any) -> float:
    """JavaScript Number(): the meter compares like the Node gate does."""
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return v
    try:
        n = float(str(v).strip() or 0)
    except ValueError:
        return math.nan
    return n


def _int_if_whole(v: float):
    return int(v) if isinstance(v, float) and v.is_integer() else v
