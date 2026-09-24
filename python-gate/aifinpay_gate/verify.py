"""Receipt verification — local, stateless, pinned to EdDSA.

A port of gate/src/verify.ts (jose.jwtVerify with algorithms: ["EdDSA"]). The
gate never asks AiFinPay whether a receipt is good; it checks an Ed25519
signature against the published JWKS in the merchant's own process.

Pinning the algorithm removes the algorithm-confusion class outright,
including an HS256 token that reuses the JWKS public key bytes as an HMAC
secret. Where this port is stricter than jose it says so: a receipt with no
numeric ``exp`` is refused (jose would accept it and the meter would then have
no TTL to give the counter).
"""

import base64
import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

import nacl.exceptions
import nacl.signing

DEFAULT_ISSUER = "https://api.aifinpay.io"
DEFAULT_JWKS_URI = "https://api.aifinpay.io/.well-known/jwks.json"

# (kind, payload_or_reason): kind is "ok" | "expired" | "invalid" | "jwks_unavailable"
VerifyResult = Tuple[str, Any]


class JwksUnavailable(Exception):
    pass


def _b64url(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _fetch_jwks(uri: str, timeout_s: float) -> List[Dict[str, Any]]:
    req = urllib.request.Request(uri, headers={"accept": "application/json", "user-agent": "aifinpay-gate-py"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:  # noqa: S310 — the JWKS URI is operator config
            doc = json.loads(r.read(1_000_000))
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise JwksUnavailable(f"{type(e).__name__}: {e}") from e
    keys = doc.get("keys") if isinstance(doc, dict) else None
    if not isinstance(keys, list):
        raise JwksUnavailable("JWKS document has no keys array")
    return keys


class RemoteJwks:
    """Long cache, short cooldown — jose's createRemoteJWKSet defaults: a
    rotated key is picked up within 30 s, a JWKS outage is survivable for
    10 minutes of traffic."""

    def __init__(self, uri: str, cache_max_age_s: float = 600, cooldown_s: float = 30,
                 timeout_s: float = 5, fetch: Callable[[str, float], List[Dict[str, Any]]] = _fetch_jwks):
        self.uri = uri
        self.cache_max_age_s = cache_max_age_s
        self.cooldown_s = cooldown_s
        self.timeout_s = timeout_s
        self._fetch = fetch
        self._keys: Optional[List[Dict[str, Any]]] = None
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    def _reload(self) -> None:
        keys = self._fetch(self.uri, self.timeout_s)
        self._keys, self._fetched_at = keys, time.monotonic()

    def keys(self, kid: Optional[str]) -> List[Dict[str, Any]]:
        with self._lock:
            now = time.monotonic()
            if self._keys is None or now - self._fetched_at > self.cache_max_age_s:
                self._reload()
            found = _candidates(self._keys or [], kid)
            if not found and now - self._fetched_at > self.cooldown_s:
                self._reload()  # an unknown kid may be a freshly rotated key
                found = _candidates(self._keys or [], kid)
            return found


class LocalJwks:
    """A pinned key set: no network I/O, a redeploy on key rotation."""

    def __init__(self, jwks: Dict[str, Any]):
        self._keys = list(jwks.get("keys") or [])

    def keys(self, kid: Optional[str]) -> List[Dict[str, Any]]:
        return _candidates(self._keys, kid)


def _candidates(keys: List[Dict[str, Any]], kid: Optional[str]) -> List[Dict[str, Any]]:
    out = []
    for k in keys:
        if not isinstance(k, dict) or k.get("kty") != "OKP" or k.get("crv") != "Ed25519" or "x" not in k:
            continue
        if kid is not None and k.get("kid") != kid:
            continue
        if k.get("alg") not in (None, "EdDSA") or k.get("use") not in (None, "sig"):
            continue
        if "key_ops" in k and "verify" not in (k.get("key_ops") or []):
            continue
        out.append(k)
    return out


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class Verifier:
    def __init__(self, issuer: str, audience: str, clock_tolerance_s: int = 30,
                 jwks_uri: str = DEFAULT_JWKS_URI, jwks: Optional[Dict[str, Any]] = None,
                 now: Callable[[], float] = time.time):
        self.issuer = issuer
        self.audience = audience
        self.tolerance = clock_tolerance_s
        self.key_set = LocalJwks(jwks) if jwks is not None else RemoteJwks(jwks_uri)
        self._now = now

    def __call__(self, token: str) -> VerifyResult:
        try:
            if not isinstance(token, str) or token.count(".") != 2 or len(token) > 32768:
                return ("invalid", "malformed JWT")
            h_part, p_part, s_part = token.split(".")
            header = json.loads(_b64url(h_part))
            payload = json.loads(_b64url(p_part))
            signature = _b64url(s_part)
        except (ValueError, UnicodeDecodeError) as e:
            return ("invalid", f"malformed JWT: {type(e).__name__}")
        if not isinstance(header, dict) or not isinstance(payload, dict):
            return ("invalid", "malformed JWT")
        if header.get("alg") != "EdDSA":
            return ("invalid", f'unexpected "alg" {header.get("alg")!r}')
        if "crit" in header:
            return ("invalid", 'unsupported "crit" header')
        kid = header.get("kid")
        if kid is not None and not isinstance(kid, str):
            return ("invalid", 'invalid "kid"')
        try:
            candidates = self.key_set.keys(kid)
        except JwksUnavailable as e:
            return ("jwks_unavailable", str(e))
        signed = f"{h_part}.{p_part}".encode()
        for key in candidates:
            try:
                nacl.signing.VerifyKey(_b64url(key["x"])).verify(signed, signature)
                break
            except (nacl.exceptions.BadSignatureError, ValueError, TypeError):
                continue
        else:
            return ("invalid", "signature verification failed" if candidates else "no applicable key in the JWKS")

        now = self._now()
        if payload.get("iss") != self.issuer:
            return ("invalid", 'unexpected "iss" claim value')
        aud = payload.get("aud")
        if not (aud == self.audience or (isinstance(aud, list) and self.audience in aud)):
            return ("invalid", 'unexpected "aud" claim value')
        for claim in ("iat", "nbf"):
            if claim in payload and not _is_num(payload[claim]):
                return ("invalid", f'"{claim}" claim must be a number')
        if "nbf" in payload and payload["nbf"] > now + self.tolerance:
            return ("invalid", '"nbf" claim timestamp check failed')
        if not _is_num(payload.get("exp")):
            return ("invalid", '"exp" claim must be a number')
        if payload["exp"] <= now - self.tolerance:
            return ("expired", '"exp" claim timestamp check failed')
        return ("ok", payload)
