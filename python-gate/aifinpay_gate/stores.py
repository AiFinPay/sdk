"""Quota counters. The concurrency contract, from gate/src/stores/types.ts:

1. ``incr_by`` is atomic and returns the POST-increment value. The gate adds
   the call's weight and compares what comes back; a read-then-write store lets
   N concurrent requests all see room and overspend a batch N times.
2. The TTL is set on the FIRST write only. The counter must die with the
   receipt: never after (paid calls refused), never before (the whole batch
   becomes spendable again).

A backend failure must RAISE. ``on_store_error`` decides what happens then.
"""

import threading
import time
from typing import Any, Dict, Optional, Tuple


class StoreCapacityError(Exception):
    def __init__(self, max_keys: int):
        super().__init__(f"quota store is full ({max_keys} live counters); refusing rather than forgetting one")


class MemoryStore:
    """Per-process counters. Correct in ONE process only: under gunicorn with
    several workers, or several pods, each gets a full copy of every batch.
    Use RedisStore the moment more than one process serves the gated routes."""

    durable = False
    shared_across_processes = False

    def __init__(self, max_keys: int = 100_000):
        self.max_keys = max_keys
        self._map: Dict[str, Tuple[int, float]] = {}
        self._lock = threading.Lock()

    def incr_by(self, key: str, by: int, ttl_ms: int) -> int:
        with self._lock:
            now = time.monotonic()
            cur = self._map.get(key)
            if cur and cur[1] > now:
                v = cur[0] + by
                self._map[key] = (v, cur[1])  # TTL untouched: it belongs to the receipt
                return v
            if len(self._map) >= self.max_keys and not self._sweep(now):
                # Never evict a live counter: that is a refund nobody asked for.
                raise StoreCapacityError(self.max_keys)
            self._map[key] = (by, now + ttl_ms / 1000)
            return by

    def decr_by(self, key: str, by: int) -> int:
        with self._lock:
            cur = self._map.get(key)
            if not cur or cur[1] <= time.monotonic():
                return 0
            self._map[key] = (cur[0] - by, cur[1])
            return cur[0] - by

    def get(self, key: str) -> Optional[int]:
        with self._lock:
            cur = self._map.get(key)
            if not cur or cur[1] <= time.monotonic():
                return None
            return cur[0]

    def _sweep(self, now: float) -> bool:
        before = len(self._map)
        for k in [k for k, (_, exp) in self._map.items() if exp <= now]:
            del self._map[k]
        return len(self._map) < before


REDIS_INCRBY_SCRIPT = """
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return v
""".strip()


class RedisStore:
    """Shared counters on your own redis-py client (``redis.Redis``, sync).

    One round-trip; the script repairs a counter that ever lost its TTL, so a
    dropped connection between INCRBY and PEXPIRE cannot leave an immortal key.
    Errors propagate, deliberately — never a silent fallback to memory."""

    durable = True
    shared_across_processes = True

    def __init__(self, client: Any, key_prefix: str = ""):
        self.client = client
        self.key_prefix = key_prefix
        register = getattr(client, "register_script", None)
        self._script = register(REDIS_INCRBY_SCRIPT) if callable(register) else None

    def incr_by(self, key: str, by: int, ttl_ms: int) -> int:
        k, by, ttl = self.key_prefix + key, max(1, int(by)), max(1000, int(ttl_ms))
        if self._script is not None:
            return int(self._script(keys=[k], args=[by, ttl]))
        return int(self.client.eval(REDIS_INCRBY_SCRIPT, 1, k, by, ttl))

    def decr_by(self, key: str, by: int) -> int:
        return int(self.client.decrby(self.key_prefix + key, max(1, int(by))))

    def get(self, key: str) -> Optional[int]:
        raw = self.client.get(self.key_prefix + key)
        return None if raw is None else int(raw)
