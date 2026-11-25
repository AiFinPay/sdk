"""Five-minute traffic summaries (conformance/SPEC.md, "Traffic summary"): an in-memory tally and its own sender."""

import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request

LANGUAGE_PREFIXES = ("ar bg bn ca cs da de el en es et fa fi fr he hi hr hu id it ja ko lt lv ms nl no pl pt ro ru "
                     "sk sl sr sv th tr uk vi zh").split()
ASSET_EXTENSIONS = "avif bmp css eot gif ico jpeg jpg js map mjs mp3 mp4 otf png svg ttf wasm webm webp woff woff2".split()
_CAPS = {"sections": 30, "countries": 20, "networks": 50}
_TABLES = ("classes", "operators", "sections", "countries", "networks")
_MAX_ROWS = 600
_MAX_COUNT = 10 ** 9
_MAX_ASN = 4294967295
# Distinct values held per window; the rest go straight to `_other` so memory stays bounded.
_MAX_DISTINCT = 1000
_SECTION = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
_LANGUAGE = re.compile(r"(?:%s)(?:[-_][a-z]{2,4})?" % "|".join(LANGUAGE_PREFIXES))
_ASN = re.compile(r"(?:AS|as)?(0|[1-9][0-9]{0,9})")
_ASCII_UPPER = re.compile(r"[A-Z]")
# Absent means the site has no source for the value.
ABSENT = object()


def _lower(s):
    return _ASCII_UPPER.sub(lambda m: m.group(0).lower(), s)


def _path(target):
    return re.split(r"[?#]", str(target), maxsplit=1)[0]


def section_of(target):
    segments = [_lower(s) for s in _path(target).split("/") if s]
    index = 1 if segments and _LANGUAGE.fullmatch(segments[0]) else 0
    if index >= len(segments):
        return "/"
    segment = segments[index]
    digits = sum(c.isascii() and c.isdigit() for c in segment)
    return f"/{segment}" if _SECTION.fullmatch(segment) and digits <= 4 else "_other"


def counted(target, outcome):
    """A page's images and scripts served free are not visitors."""
    if outcome != "served":
        return True
    p = _path(target)
    last = _lower(p[p.rfind("/") + 1:])
    return not any(last.endswith("." + ext) for ext in ASSET_EXTENSIONS)


def country_of(value):
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z]{2}", value) and value.upper() != "XX":
        return value.upper()
    return "ZZ"


def network_of(value):
    n = None
    if isinstance(value, int) and not isinstance(value, bool):
        n = value
    elif isinstance(value, str):
        m = _ASN.fullmatch(value)
        if m:
            n = int(m.group(1))
    return f"AS{n}" if n is not None and 1 <= n <= _MAX_ASN else "AS0"


class TrafficTally:
    """Counts for one window; adding is synchronous and allocation-light."""

    def __init__(self):
        self._tables = {name: {} for name in _TABLES}
        self._distinct = {"sections": set(), "networks": set()}

    def add(self, target, ua_class, operator, outcome, country=ABSENT, network=ABSENT, n=1):
        """False when the request is not counted (an asset served free)."""
        if not counted(target, outcome):
            return False
        agent = ua_class != "human"
        self._bump("classes", (ua_class, outcome), n)
        if agent:
            self._bump("operators", (operator, ua_class, outcome), n)
            self._bump("sections", (self._bounded("sections", section_of(target)), ua_class), n)
        if country is not ABSENT:
            self._bump("countries", (country_of(country), ua_class), n)
        if agent and network is not ABSENT:
            self._bump("networks", (self._bounded("networks", network_of(network)), ua_class), n)
        return True

    def _bounded(self, name, value):
        seen = self._distinct[name]
        if value in seen:
            return value
        if len(seen) >= _MAX_DISTINCT:
            return "_other"
        seen.add(value)
        return value

    def _bump(self, name, cells, n):
        table = self._tables[name]
        table[cells] = table.get(cells, 0) + n

    def body(self, window):
        """The request body, or None when nothing was counted."""
        rows = {}
        for name in _TABLES:
            table = {k: n * window["sample"] for k, n in self._tables[name].items()}
            if name in _CAPS:
                table = _cap(table, _CAPS[name])
            rows[name] = sorted(([*k, min(n, _MAX_COUNT)] for k, n in table.items() if n > 0), key=lambda r: r[:-1])
        if not rows["classes"]:
            return None
        total = sum(len(rows[name]) for name in _TABLES)
        for name in ("networks", "countries", "sections", "operators"):
            if total <= _MAX_ROWS:
                break
            total -= len(rows[name])
            rows[name] = []
        body = {"v": 1, "id": window["id"], "from": window["from"], "to": window["to"], "mode": window["mode"],
                "charge": window["charge"], "sample": window["sample"], "classes": rows["classes"]}
        for name in _TABLES[1:]:
            if rows[name]:
                body[name] = rows[name]
        return json.dumps(body, separators=(",", ":"), ensure_ascii=False)


def _cap(table, limit):
    """Folds every value past the cap into ``_other``, per class."""
    totals = {}
    for key, n in table.items():
        if key[0] != "_other":
            totals[key[0]] = totals.get(key[0], 0) + n
    kept = {v for v, _ in sorted(totals.items(), key=lambda t: (-t[1], t[0]))[:limit]}
    out = {}
    for key, n in table.items():
        if key[0] != "_other" and key[0] not in kept:
            key = ("_other", *key[1:])
        out[key] = out.get(key, 0) + n
    return out


WINDOW = 300.0
_HOLD = 3
_STALE = 3600.0
_PAUSE_404 = 21600.0
_PAUSE_OTHER = 86400.0
_TIMEOUT = 5.0


def _utc(seconds):
    return datetime.fromtimestamp(int(seconds), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class TrafficSender:
    """Its own state and thread: nothing here is shared with the event reporter or receipt use.

    ``record`` is synchronous and never waits on the network. ``flush`` closes
    the open window and runs one tick. ``now`` and ``post`` are injectable;
    ``opener`` returns the urllib opener at send time.
    """

    def __init__(self, endpoint, secret, headers, opener=None, now=time.time, post=None, thread=True, redirect=()):
        self._endpoint = endpoint
        self._redirect = redirect
        self._secret = secret
        self._headers = headers
        self._opener = opener
        self._now = now
        self._post = post or self._http
        self._thread_wanted = thread
        self._condition = threading.Condition()
        self._tick_lock = threading.Lock()
        self._open = None
        self._pending = []
        self._held = []
        self._paused_until = None
        self._sent = 0
        self._dropped = 0
        self._last_status = None
        self._closed = False
        self._thread = None

    @property
    def stats(self):
        with self._condition:
            return {"held": len(self._held), "sent": self._sent, "dropped": self._dropped,
                    "paused_until": self._paused_until, "last_status": self._last_status}

    def record(self, target, ua_class, operator, outcome, mode, charge, country=ABSENT, network=ABSENT):
        try:
            with self._condition:
                if self._closed:
                    return
                now = self._now()
                if self._open is not None and now >= self._open["from"] + WINDOW:
                    # The thread is late; close it here and let the thread send it.
                    self._queue_closed(self._open["from"] + WINDOW)
                if not counted(target, outcome):
                    return
                if self._open is None:
                    self._open = {"from": now, "mode": mode, "charge": charge, "tally": TrafficTally()}
                    self._start()
                self._open["tally"].add(target, ua_class, operator, outcome, country, network)
                self._condition.notify_all()
        except Exception:  # noqa: BLE001 — counting never fails a request
            pass

    def _start(self):
        if self._thread is None and self._thread_wanted:
            self._thread = threading.Thread(target=self._run, name="aifinpay-gate-traffic", daemon=True)
            self._thread.start()

    def _close_open(self, to):
        w, self._open = self._open, None
        if w is None:
            return None
        start = int(w["from"])
        end = max(int(to), start + 1)
        body = w["tally"].body({"id": str(uuid.uuid4()), "from": _utc(start), "to": _utc(end),
                                "mode": w["mode"], "charge": w["charge"], "sample": 1})
        return {"body": body, "to": end} if body else None

    def _queue_closed(self, to):
        closed = self._close_open(to)
        if closed is not None:
            self._pending.append(closed)

    def _run(self):
        while True:
            with self._condition:
                if self._closed:
                    return
                now = self._now()
                if self._open is not None and now >= self._open["from"] + WINDOW:
                    self._queue_closed(self._open["from"] + WINDOW)
                if not self._pending:
                    wait = None if self._open is None else max(0.05, self._open["from"] + WINDOW - now)
                    self._condition.wait(timeout=wait)
                    continue
                closed = self._pending.pop(0)
            with self._tick_lock:
                self._tick(closed)

    def flush(self):
        """Close the open window and run one tick, in the caller's thread."""
        with self._condition:
            closed = [*self._pending, self._close_open(self._now())]
            self._pending = []
        with self._tick_lock:
            for w in closed[:-1]:
                self._tick(w)
            self._tick(closed[-1])
        return self.stats

    def close(self):
        stats = self.flush()
        with self._condition:
            self._closed = True
            self._condition.notify_all()
        return stats

    def _tick(self, just_closed):
        """The SPEC's tick: hold what just closed, trim, then send oldest first until one is not accepted."""
        with self._condition:
            at = self._now()
            if self._paused_until is not None and at >= self._paused_until:
                self._paused_until = None
            if just_closed is not None:
                if self._paused_until is None:
                    self._held.append(just_closed)
                else:
                    self._dropped += 1
            while len(self._held) > _HOLD:
                self._held.pop(0)
                self._dropped += 1
            fresh = [w for w in self._held if not w["to"] < at - _STALE]
            self._dropped += len(self._held) - len(fresh)
            self._held = fresh
        while True:
            with self._condition:
                if self._paused_until is not None or not self._held:
                    return
                w = self._held[0]
            status = self._post(w["body"])
            with self._condition:
                self._last_status = status
                if isinstance(status, int) and 200 <= status < 300:
                    self._held.pop(0)
                    self._sent += 1
                    continue
                if status == "none" or status in (408, 429) or status >= 500 or status < 200:
                    return
                self._dropped += len(self._held)
                self._held = []
                self._paused_until = at + (_PAUSE_404 if status == 404 else _PAUSE_OTHER)

    def _http(self, body):
        request = Request(self._endpoint, data=body.encode("utf-8"), method="POST", headers={
            **self._headers(), "Content-Type": "application/json", "AIFP-Merchant-Secret": self._secret})
        try:
            with self._opener().open(request, timeout=_TIMEOUT) as response:
                return response.status
        except self._redirect:
            return 302
        except HTTPError as error:
            code = error.code
            error.close()
            return code
        except Exception:  # noqa: BLE001 — timeout, network or anything else: no answer
            return "none"
