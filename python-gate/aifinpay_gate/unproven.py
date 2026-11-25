"""Unproven pays: only a reader with a signed cookie or a verified free bot reads without a receipt.

A port of gate/src/unproven.ts; conformance/vectors/reader-proof-v1.json holds both to the same bytes.
"""

import base64
import hashlib
import hmac
import ipaddress
import re
import socket
import threading
import time
import weakref
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable, List, Optional, Tuple, Union

from .agents import AI_AGENT_UA_MARKERS
from .identity import tag_charge

READER_COOKIE = "__aifp_human"
READER_TTL_SECONDS = 2592000

_MIN_KEY_BYTES = 32
_COOKIE_VALUE = re.compile(r"(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})\Z")
_SPLIT = re.compile(r";[ \t]*")
_MAX_SAFE_INTEGER = 2**53 - 1


class ReaderProof:
    """The reader cookie ``<exp>.<sig>``: HMAC-SHA-256 of ``<exp>\\n<user-agent>``, base64url without padding."""

    cookie_name = READER_COOKIE

    def __init__(self, key: Union[str, bytes], ttl_seconds: int = READER_TTL_SECONDS):
        key_bytes = key.encode("utf-8") if isinstance(key, str) else bytes(key or b"")
        if len(key_bytes) < _MIN_KEY_BYTES:
            raise ValueError(f"reader key must be at least {_MIN_KEY_BYTES} bytes")
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be a positive integer")
        self._key = key_bytes
        self.ttl_seconds = ttl_seconds

    def _sign(self, exp: str, user_agent: str) -> str:
        digest = hmac.new(self._key, f"{exp}\n{user_agent}".encode("utf-8"), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")

    def issue(self, user_agent: Optional[str], now: Optional[float] = None) -> str:
        """A cookie value for this User-Agent; ``now`` in Unix seconds."""
        exp = str(int(time.time() if now is None else now) + self.ttl_seconds)
        return f"{exp}.{self._sign(exp, user_agent or '')}"

    def verify(self, cookie_header: Optional[str], user_agent: Optional[str], now: Optional[float] = None) -> bool:
        """True when the first ``__aifp_human`` cookie in the header is unexpired and signed for this User-Agent."""
        prefix = READER_COOKIE + "="
        part = next((c for c in _SPLIT.split(cookie_header or "") if c.startswith(prefix)), None)
        if part is None:
            return False
        m = _COOKIE_VALUE.match(part[len(prefix):])
        if not m:
            return False
        exp = int(m.group(1))
        if exp > _MAX_SAFE_INTEGER or exp <= (time.time() if now is None else now):
            return False
        return hmac.compare_digest(m.group(2), self._sign(m.group(1), user_agent or ""))

    def set_cookie(self, value: str) -> str:
        """A ``Set-Cookie`` header value for an issued cookie."""
        return f"{READER_COOKIE}={value}; Path=/; Max-Age={self.ttl_seconds}; HttpOnly; Secure; SameSite=Lax"


# operator, User-Agent product tokens, PTR suffixes (leading dot included), category.
SEARCH_BOT_TABLE: Tuple[Tuple[str, Tuple[str, ...], Tuple[str, ...], str], ...] = (
    ("google", ("googlebot", "googlebot-image", "googlebot-news", "googlebot-video"), (".googlebot.com",), "search"),
    ("microsoft", ("bingbot",), (".search.msn.com",), "search"),
    ("apple", ("applebot",), (".applebot.apple.com",), "search"),
    ("yandex", ("yandexbot", "yandeximages", "yandexmobilebot"), (".yandex.ru", ".yandex.net", ".yandex.com"), "search"),
    ("baidu", ("baiduspider", "baiduspider-image", "baiduspider-render"), (".baidu.com", ".baidu.jp"), "search"),
)
FREE_BOT_CATEGORIES = ("search", "preview", "monitoring")
SEARCH_BOT_CACHE_MAX = 10000
_TTL_VERIFIED = 86400
_TTL_REFUSED = 3600
_TTL_ERROR = 60
_NAME = re.compile(r"[a-z0-9-]+(\.[a-z0-9-]+)+\Z")


class SystemResolver:
    """The platform resolver: ``reverse``, ``resolve4`` and ``resolve6`` as in ``node:dns``."""

    def reverse(self, ip: str) -> List[str]:
        name, aliases, _ = socket.gethostbyaddr(ip)
        return [name, *aliases]

    def _forward(self, name: str, family: int) -> List[str]:
        return [info[4][0] for info in socket.getaddrinfo(name, None, family, socket.SOCK_STREAM)]

    def resolve4(self, name: str) -> List[str]:
        return self._forward(name, socket.AF_INET)

    def resolve6(self, name: str) -> List[str]:
        return self._forward(name, socket.AF_INET6)


_default_resolver = SystemResolver()
_pool: Optional[ThreadPoolExecutor] = None
_lock = threading.Lock()
_caches: "weakref.WeakKeyDictionary[Any, OrderedDict]" = weakref.WeakKeyDictionary()


def _normalize_ip(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str) or "%" in value:
        return None
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return str(ip.ipv4_mapped)
    return str(ip)


def _claimed(user_agent: str):
    ua = user_agent.lower()
    if any(marker in ua for marker in AI_AGENT_UA_MARKERS):
        return None
    tokens = set(re.split(r"[^a-z0-9-]+", ua))
    claimed = [entry for entry in SEARCH_BOT_TABLE if any(t in tokens for t in entry[1])]
    return claimed[0] if len(claimed) == 1 else None


def _forward_confirmed(resolver, ip: str, suffixes: Tuple[str, ...]) -> bool:
    version = ipaddress.ip_address(ip).version
    for raw in list(resolver.reverse(ip))[:8]:
        if not isinstance(raw, str) or len(raw) > 254:
            continue
        name = raw.lower()
        name = name[:-1] if name.endswith(".") else name
        if not _NAME.match(name) or not any(name.endswith(s) for s in suffixes):
            continue
        addresses = resolver.resolve4(name) if version == 4 else resolver.resolve6(name)
        if any(_normalize_ip(a) == ip for a in list(addresses)[:32]):
            return True
    return False


def _run(fn: Callable[[], bool], timeout: float) -> bool:
    global _pool
    with _lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="aifp-dns")
    return _pool.submit(fn).result(timeout=timeout)


def verify_search_bot(user_agent: Optional[str], ip: Optional[str], resolver: Any = None,
                      now: Optional[float] = None, timeout: float = 1.0) -> Optional[str]:
    """Forward-confirmed reverse DNS for a crawler naming a search operator; None when not proven, errors included."""
    address = _normalize_ip(ip)
    entry = _claimed(user_agent or "")
    if address is None or entry is None:
        return None
    operator, _, suffixes, category = entry
    dns = resolver if resolver is not None else _default_resolver
    clock = time.time() if now is None else now
    key = f"{operator}|{address}"
    with _lock:
        cache = _caches.get(dns)
        if cache is None:
            cache = _caches[dns] = OrderedDict()
        hit = cache.get(key)
        if hit is not None and hit[1] > clock:
            return hit[0]
        cache.pop(key, None)
    try:
        ok = _run(lambda: _forward_confirmed(dns, address, suffixes), timeout)
        result = (category, clock + _TTL_VERIFIED) if ok else (None, clock + _TTL_REFUSED)
    except Exception:  # noqa: BLE001 — an error or timeout is not a verification
        result = (None, clock + _TTL_ERROR)
    with _lock:
        while len(cache) >= SEARCH_BOT_CACHE_MAX:
            cache.popitem(last=False)
        cache[key] = result
    return result[0]


_verify_search_bot = verify_search_bot


def unproven_pays(reader_proof: ReaderProof, verify_search_bot: Optional[Callable[[str, str], Optional[str]]] = None,
                  free_bots: Iterable[str] = FREE_BOT_CATEGORIES) -> Callable[[Any], bool]:
    """A ``should_charge`` that is False only for a valid reader cookie or a verified free bot; reads ``req.ip``."""
    if reader_proof is None or not callable(getattr(reader_proof, "verify", None)):
        raise TypeError("unproven_pays needs a reader_proof")
    verify = verify_search_bot or _verify_search_bot
    free = tuple(free_bots)

    def should_charge(req: Any) -> bool:
        if req.header("AIFP-Receipt") or req.header("AIFP-Agent-Id"):
            return True
        user_agent = req.header("user-agent") or ""
        if reader_proof.verify(req.header("cookie"), user_agent):
            return False
        ip = getattr(req, "ip", None)
        if not ip or not free:
            return True
        try:
            category = verify(user_agent, ip)
        except Exception:  # noqa: BLE001 — a verifier that raises charges
            return True
        return not (category is not None and category in free)

    return tag_charge(should_charge, "unproven")


__all__: List[str] = [
    "FREE_BOT_CATEGORIES", "READER_COOKIE", "READER_TTL_SECONDS", "ReaderProof", "SEARCH_BOT_CACHE_MAX",
    "SEARCH_BOT_TABLE", "SystemResolver", "unproven_pays", "verify_search_bot",
]
