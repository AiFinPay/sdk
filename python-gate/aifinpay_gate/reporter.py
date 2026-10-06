"""Opt-in gate request reporting. No payment, receipt or quota behavior changes."""

import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _RedirectBlocked(Exception):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise _RedirectBlocked()


class GateReporter:
    """One reporter per merchant per worker process, created after a fork.

    ``on_event`` only enqueues. A daemon thread sends bounded batches. ``flush``
    attempts its queue snapshot once and waits at most ``timeout`` seconds;
    retries remain queued. ``close`` stops enqueueing, flushes once, drops the
    remaining queue and stops the worker. An in-flight request may finish after
    the shutdown deadline; it cannot start another request.
    """

    MAX_QUEUE = 1000
    MAX_BATCH = 50
    MAX_AGE = 15 * 60
    MAX_ATTEMPTS = 5
    HTTP_TIMEOUT = 3.0
    DELAY = 1.0

    def __init__(self, *, merchant_id, merchant_secret, api_base="https://api.aifinpay.io"):
        if not isinstance(merchant_id, str) or not re.fullmatch(r"mrch_[a-f0-9]{16}", merchant_id):
            raise ValueError("GateReporter: valid merchant_id is required")
        if not isinstance(merchant_secret, str) or not merchant_secret or re.search(r"[\x00-\x1f\x7f]", merchant_secret):
            raise ValueError("GateReporter: merchant_secret is required")
        try:
            base = urlsplit(api_base)
            # Access port now so malformed ports fail before any background work.
            base.port
            if (base.scheme != "https" or not base.hostname or base.username or base.password
                    or base.query or base.fragment or base.path not in ("", "/")
                    or re.search(r"[\s\\?#]", api_base)):
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("GateReporter: api_base must be an HTTPS origin") from None
        self._endpoint = "https://" + base.netloc + "/v1/merchants/" + merchant_id + "/gate-events"
        self._secret = merchant_secret
        self._opener = build_opener(_NoRedirect())
        self._pid = os.getpid()
        self._condition = threading.Condition()
        self._queue = []
        self._sending = False
        self._flush_ids = None
        self._flush_attempted = set()
        self._closed = False
        self._stopped = False
        self._terminate = False
        self._delivered = 0
        self._dropped = 0
        self._retries = 0
        self._last_error = None
        self._worker = threading.Thread(target=self._run, name="aifinpay-gate-reporter", daemon=True)
        self._worker.start()

    def __repr__(self):
        return "GateReporter(secret=[redacted])"

    def _snapshot(self):
        return {"queued": len(self._queue), "delivered": self._delivered,
                "dropped": self._dropped, "retries": self._retries,
                "last_error": self._last_error, "stopped": self._stopped, "closed": self._closed}

    @property
    def stats(self):
        if os.getpid() != self._pid:
            return {"queued": 0, "delivered": 0, "dropped": 0, "retries": 0,
                    "last_error": "wrong_process", "stopped": True, "closed": True}
        with self._condition:
            return self._snapshot()

    @staticmethod
    def _valid_resource(value):
        return (isinstance(value, str) and bool(re.fullmatch(r"/(?!/)[A-Za-z0-9_./:*{}-]{0,511}", value))
                and not re.search(r"[\s\\?#%\x00-\x1f\x7f]", value)
                and "//" not in value
                and not any(segment in (".", "..") for segment in value.split("/")))

    def on_event(self, event):
        """Gate callback: copy only kind and registered path, never request data."""
        if os.getpid() != self._pid:
            return  # Never acquire a possibly inherited locked mutex after fork.
        if not isinstance(event, dict) or event.get("exempt") or event.get("kind") not in ("402", "serve"):
            return
        with self._condition:
            if self._closed or self._stopped:
                self._dropped += 1
                if not self._stopped:
                    self._last_error = "closed"
                return
            if not self._valid_resource(event.get("resource")):
                self._dropped += 1
                self._last_error = "invalid_event"
                return
            self._expire()
            if len(self._queue) >= self.MAX_QUEUE:
                self._dropped += 1
                self._last_error = "queue_full"
                return
            now = time.monotonic()
            wire = {"id": str(uuid.uuid4()), "kind": event["kind"], "resource": event["resource"],
                    "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
            self._queue.append({"event": wire, "created": now, "attempts": 0, "next_at": now + self.DELAY})
            self._condition.notify_all()

    __call__ = on_event

    def _expire(self):
        now = time.monotonic()
        # Do not remove entries currently being sent. _run expires before send.
        if self._sending:
            return
        remaining = [item for item in self._queue if now - item["created"] < self.MAX_AGE]
        if len(remaining) != len(self._queue):
            self._dropped += len(self._queue) - len(remaining)
            self._last_error = "expired"
            self._queue = remaining

    def _send(self, batch):
        body = json.dumps({"events": [item["event"] for item in batch]}, separators=(",", ":")).encode("utf-8")
        request = Request(self._endpoint, data=body, method="POST", headers={
            "Content-Type": "application/json", "AIFP-Merchant-Secret": self._secret})
        try:
            with self._opener.open(request, timeout=self.HTTP_TIMEOUT) as response:
                status = response.status
                if 300 <= status < 400:
                    return "redirect", True
                if status in (401, 403):
                    return "auth", True
                if 400 <= status < 500 and status not in (408, 429):
                    return "rejected", True
                if not 200 <= status < 300:
                    return "server", False
                # Bounded body; only aggregate counts are accepted. No error
                # bodies, headers or exception strings ever enter diagnostics.
                raw = response.read(4097)
                if len(raw) > 4096:
                    return "invalid_response", False
                result = json.loads(raw)
                accepted, duplicates = result.get("accepted"), result.get("duplicates")
                if (type(accepted) is not int or type(duplicates) is not int
                        or accepted < 0 or duplicates < 0 or accepted + duplicates != len(batch)):
                    return "invalid_response", False
                return None, False
        except _RedirectBlocked:
            return "redirect", True
        except HTTPError as error:
            code = error.code
            error.close()
            if 300 <= code < 400:
                return "redirect", True
            if code in (401, 403):
                return "auth", True
            if 400 <= code < 500 and code not in (408, 429):
                return "rejected", True
            return "server", False
        except (TimeoutError, URLError) as error:
            reason = error.reason if isinstance(error, URLError) else error
            return ("timeout" if isinstance(reason, TimeoutError) else "network"), False
        except Exception:
            return "invalid_response", False

    def _run(self):
        while True:
            with self._condition:
                if self._terminate or self._stopped:
                    return
                self._expire()
                now = time.monotonic()
                if self._flush_ids is not None:
                    batch = [item for item in self._queue if item["event"]["id"] in self._flush_ids
                             and item["event"]["id"] not in self._flush_attempted][:self.MAX_BATCH]
                    if not batch:
                        self._flush_ids = None
                        self._flush_attempted.clear()
                        self._condition.notify_all()
                else:
                    batch = [item for item in self._queue if item["next_at"] <= now][:self.MAX_BATCH]
                if not batch:
                    delay = min((item["next_at"] - now for item in self._queue), default=self.DELAY)
                    self._condition.wait(timeout=max(0.01, delay))
                    continue
                self._sending = True
                for item in batch:
                    item["attempts"] += 1
                    if self._flush_ids is not None:
                        self._flush_attempted.add(item["event"]["id"])
            error, permanent = self._send(batch)
            with self._condition:
                self._sending = False
                if self._terminate:
                    self._condition.notify_all()
                    return
                ids = {item["event"]["id"] for item in batch}
                if self._flush_ids is not None:
                    self._flush_attempted.update(ids)
                if permanent:
                    self._stopped = True
                    self._last_error = error
                    self._dropped += len(self._queue)
                    self._queue = []
                    self._flush_ids = None
                elif error is None:
                    self._delivered += len(batch)
                    self._queue = [item for item in self._queue if item["event"]["id"] not in ids]
                    self._last_error = None
                else:
                    self._last_error = error
                    for item in batch:
                        if item["attempts"] >= self.MAX_ATTEMPTS or time.monotonic() - item["created"] >= self.MAX_AGE:
                            self._queue.remove(item)
                            self._dropped += 1
                        else:
                            self._retries += 1
                            item["next_at"] = time.monotonic() + min(30, self.DELAY * 2 ** item["attempts"])
                    if all(item["attempts"] >= self.MAX_ATTEMPTS for item in batch):
                        self._last_error = "retry_exhausted"
                self._condition.notify_all()

    def flush(self, timeout=10.0):
        """Wait at most timeout seconds for one attempt per pending event.

        Return status even on timeout; the background worker retains retries.
        Calls from the reporter worker itself are rejected to avoid a deadlock.
        """
        if os.getpid() != self._pid:
            return self.stats
        if threading.current_thread() is self._worker:
            raise RuntimeError("GateReporter.flush cannot run on the reporter thread")
        if timeout < 0:
            raise ValueError("timeout must be non-negative")
        deadline = time.monotonic() + timeout
        with self._condition:
            while self._flush_ids is not None and not self._terminate:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self._snapshot()
                self._condition.wait(timeout=remaining)
            if self._terminate or self._stopped:
                return self._snapshot()
            self._flush_ids = {item["event"]["id"] for item in self._queue}
            self._flush_attempted = set()
            self._condition.notify_all()
            while self._flush_ids is not None and not self._terminate and not self._stopped:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self._snapshot()
                self._condition.wait(timeout=remaining)
            return self._snapshot()

    def close(self, timeout=10.0):
        """Stop acceptance, flush once within deadline, discard unsent events."""
        if os.getpid() != self._pid:
            return self.stats
        deadline = time.monotonic() + max(0.0, timeout)
        with self._condition:
            self._closed = True
        self.flush(timeout=max(0.0, deadline - time.monotonic()))
        with self._condition:
            self._terminate = True
            if self._queue:
                self._dropped += len(self._queue)
                self._queue = []
                if not self._stopped:
                    self._last_error = "shutdown"
            self._condition.notify_all()
        self._worker.join(timeout=max(0.0, deadline - time.monotonic()))
        return self.stats
