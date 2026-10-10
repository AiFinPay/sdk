"""Opt-in gate request reporting. No payment, receipt or quota behavior changes."""

import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
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


SERVER_OBSERVATIONS = ("access_challenged", "access_admitted", "resource_response_completed")
_CHANNELS = ("browser", "api", "unknown")
_CONSENTS = ("granted", "denied", "unknown")
_REASONS = ("receipt_missing", "receipt_rejected", "quota_exhausted", "upstream_error", "client_abort", "unknown")


def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _uuid(value):
    return isinstance(value, str) and bool(re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", value))


def _utc(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        raise ValueError("invalid reporting time")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def _context(value):
    if not isinstance(value, dict) or set(value) - {"channel", "consent", "client_id", "reporting_token"}:
        raise ValueError("invalid reporting context")
    result = dict(value)
    result.setdefault("channel", "unknown")
    result.setdefault("consent", "unknown")
    if result["channel"] not in _CHANNELS or result["consent"] not in _CONSENTS:
        raise ValueError("invalid reporting context")
    if "client_id" in result and (result["consent"] != "granted" or not _uuid(result["client_id"])):
        raise ValueError("invalid observed identity")
    if "reporting_token" in result and (not isinstance(result["reporting_token"], str)
                                        or not re.fullmatch(r"[A-Za-z0-9_-]{43}", result["reporting_token"])):
        raise ValueError("invalid reporting capability")
    return result


@dataclass(frozen=True)
class ReportingFlow:
    """In-memory observation capability, never an access/payment credential."""
    flow_id: str
    reporting_token: str = field(repr=False)
    expires_at: str
    mode: str
    resource: str


class GateReporterV2(GateReporter):
    """Explicit frozen-v2 producer. Instantiate separately in each worker.

    ``on_event`` validates and copies only exact wire facts. ``mint_flow`` is
    an explicit, bounded call, never performed by a gate. No persistence/logs.
    The inherited v1 reporter is unchanged and must not be attached alongside
    this producer. Pending includes in-flight events until a valid durable ack.
    """

    HEALTH_INTERVAL = 5.0  # <=12/min/producer
    version = 2

    def __init__(self, *, merchant_id, merchant_secret, supported, api_base="https://api.aifinpay.io"):
        # The base constructor starts our worker only after this state exists.
        if not isinstance(merchant_secret, str) or not re.fullmatch(r"[\x21-\x7e]+", merchant_secret):
            raise ValueError("GateReporterV2: merchant_secret must be printable ASCII")
        if (not isinstance(supported, (list, tuple)) or not supported
                or any(stage not in SERVER_OBSERVATIONS for stage in supported)
                or len(set(supported)) != len(supported)):
            raise ValueError("GateReporterV2: declare the supported server observations")
        self._supported = tuple(supported)
        self._producer_id = str(uuid.uuid4())
        self._sequence = 0
        self._io_lock = threading.Lock()
        self._health_lock = threading.Lock()
        self._last_sample = None
        self._health_at = time.monotonic() + self.HEALTH_INTERVAL
        self._health_retry = None
        self._health_created = None
        self._health_attempts = 0
        super().__init__(merchant_id=merchant_id, merchant_secret=merchant_secret, api_base=api_base)
        # Worker checks this publication barrier before issuing any I/O.
        self._endpoint = self._endpoint.replace("/v1/", "/v2/")
        self._v2_ready = True

    def __repr__(self):
        return "GateReporterV2(secret=[redacted])"

    def _snapshot(self):
        return {**super()._snapshot(), "producer_id": self._producer_id,
                "pending": len(self._queue), "last_sample": dict(self._last_sample,
                    supported=list(self._last_sample["supported"])) if self._last_sample else None}

    @property
    def stats(self):
        if os.getpid() != self._pid:
            return {"queued": None, "pending": None, "delivered": None, "dropped": None, "retries": None,
                    "producer_id": None, "last_sample": None, "last_error": "wrong_process",
                    "stopped": True, "closed": True}
        with self._condition:
            return self._snapshot()

    @staticmethod
    def _valid_resource(value):
        return (GateReporter._valid_resource(value) and ":" not in value
                and "{" not in value and "}" not in value
                and ("*" not in value or value.endswith("/*") and "*" not in value[:-1]))

    def on_event(self, event):
        if os.getpid() != self._pid:
            return False
        valid = False
        try:
            required = {"id", "name", "resource", "at", "channel", "consent"}
            optional = {"client_id", "reporting_token", "outcome", "status", "reason"}
            if not isinstance(event, dict) or not required <= set(event) or set(event) - required - optional:
                raise ValueError()
            wire = dict(event)  # All permitted values are scalar, immutable facts.
            if not _uuid(wire["id"]) or wire["name"] not in self._supported or not self._valid_resource(wire["resource"]):
                raise ValueError()
            _utc(wire["at"])
            _context({k: wire[k] for k in ("channel", "consent", "client_id", "reporting_token") if k in wire})
            if "reason" in wire and wire["reason"] not in _REASONS:
                raise ValueError()
            if wire["name"] != "resource_response_completed":
                if "outcome" in wire or "status" in wire:
                    raise ValueError()
            else:
                outcome, status = wire.get("outcome"), wire.get("status")
                if outcome not in ("success", "redirect", "error", "abort"):
                    raise ValueError()
                if "status" in wire and (type(status) is not int or not 100 <= status <= 599):
                    raise ValueError()
                if outcome != "abort" and (status is None or outcome != (
                        "success" if 200 <= status < 300 else "redirect" if 300 <= status < 400 else "error")):
                    raise ValueError()
            valid = True
        except (ValueError, TypeError):
            pass
        with self._condition:
            if valid:
                existing = next((i for i in self._queue if i["event"]["id"] == wire["id"]), None)
                if existing and existing["event"] == wire:
                    return True  # Compare pending facts before freshness checks.
                age = (datetime.now(timezone.utc) - _utc(wire["at"])).total_seconds()
                valid = existing is None and -300 <= age <= 86400
            if not valid or self._closed or self._stopped:
                self._dropped += 1
                self._last_error = "rejected" if not valid else "retry_exhausted"
                return False
            self._expire()
            if len(self._queue) >= self.MAX_QUEUE:
                self._dropped += 1
                self._last_error = "queue_full"
                return False
            now = time.monotonic()
            self._queue.append({"event": wire, "created": now, "attempts": 0, "next_at": now + self.DELAY})
            self._condition.notify_all()
            return True

    __call__ = on_event

    def _expire(self):
        super()._expire()
        if self._last_error == "expired":
            self._last_error = "retry_exhausted"

    def _http(self, endpoint, payload):
        """One bounded transport per reporter, including DNS/header/body time.

        urllib's socket timeout alone cannot bound a dribbling body or DNS.
        A deadline wait bounds callers; one nonblocking transport lock prevents
        accumulation of threads if the underlying OS operation outlives it.
        A late response is discarded, so a lost ack retries the original facts.
        """
        if os.getpid() != self._pid:
            return None, "network", True
        if not self._io_lock.acquire(blocking=False):
            return None, "timeout", False
        done, result = threading.Event(), []

        def perform():
            try:
                raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode()
                cap = 8192 if endpoint.endswith("/health") else 65536
                if len(raw) > cap:
                    result.append((None, "rejected", True))
                    return
                req = Request(endpoint, data=raw, method="POST", headers={
                    "Content-Type": "application/json", "AIFP-Merchant-Secret": self._secret})
                try:
                    with self._opener.open(req, timeout=self.HTTP_TIMEOUT) as response:
                        status = response.status
                        if not 200 <= status < 300:
                            result.append(self._http_failure(status))
                            return
                        body = response.read(8193)
                        if len(body) > 8192:
                            raise ValueError()
                        def strict_object(pairs):
                            obj = {}
                            for key, value in pairs:
                                if key in obj:
                                    raise ValueError()
                                obj[key] = value
                            return obj
                        parsed = json.loads(body, object_pairs_hook=strict_object,
                                            parse_constant=lambda _v: (_ for _ in ()).throw(ValueError()))
                        result.append((parsed, None, False))
                except HTTPError as exc:
                    result.append(self._http_failure(exc.code))
                    exc.close()
                except _RedirectBlocked:
                    result.append((None, "rejected", True))
                except (TimeoutError, URLError) as exc:
                    reason = exc.reason if isinstance(exc, URLError) else exc
                    result.append((None, "timeout" if isinstance(reason, TimeoutError) else "network", False))
                except Exception:
                    result.append((None, "rejected", False))
            finally:
                self._io_lock.release()
                done.set()

        try:
            threading.Thread(target=perform, name="aifinpay-reporting-v2-http", daemon=True).start()
        except RuntimeError:
            self._io_lock.release()
            return None, "network", False
        if not done.wait(self.HTTP_TIMEOUT):
            return None, "timeout", False
        return result[0] if result else (None, "rejected", False)

    @staticmethod
    def _http_failure(status):
        if status in (401, 403):
            return None, "auth", True
        if 300 <= status < 500 and status not in (408, 429):
            return None, "rejected", True
        return None, "storage", False

    @staticmethod
    def _ack(body, count):
        try:
            if (not isinstance(body, dict) or set(body) != {"version", "accepted", "duplicates", "received_at"}
                    or type(body["version"]) is not int or body["version"] != 2
                    or type(body["accepted"]) is not int or type(body["duplicates"]) is not int
                    or body["accepted"] < 0 or body["duplicates"] < 0
                    or body["accepted"] + body["duplicates"] != count):
                return False
            _utc(body["received_at"])
            return True
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _health_ack(body):
        # Health has its own acknowledgment: one sample, so `duplicate` replaces the batch counts.
        return (isinstance(body, dict) and set(body) == {"version", "duplicate"}
                and type(body["version"]) is int and body["version"] == 2
                and type(body["duplicate"]) is bool)

    def _send(self, batch):
        body, error, permanent = self._http(self._endpoint, {"version": 2, "events": [i["event"] for i in batch]})
        if error is None and not self._ack(body, len(batch)):
            return "rejected", False
        return error, permanent

    def mint_flow(self, *, resource, channel="unknown", consent="unknown", client_id=None, request_id=None):
        """Return a validated in-memory ReportingFlow, or None on any failure.

        Caller may reuse request_id for an explicit mint retry. No automatic
        mint retry and no gate/financial action. Backend validates stored scope.
        """
        if os.getpid() != self._pid:
            return None
        try:
            context = _context({"channel": channel, "consent": consent,
                                **({"client_id": client_id} if client_id is not None else {})})
            request_id = str(uuid.uuid4()) if request_id is None else request_id
            if not _uuid(request_id) or not self._valid_resource(resource):
                return None
            with self._condition:
                if self._closed or self._stopped:
                    return None
            body, error, _ = self._http(self._endpoint.rsplit("/", 1)[0] + "/reporting/flows",
                                       {"version": 2, "request_id": request_id, "resource": resource, **context})
            if (error or not isinstance(body, dict)
                    or set(body) != {"version", "flow_id", "reporting_token", "expires_at", "mode", "resource"}
                    or type(body["version"]) is not int or body["version"] != 2
                    or not _uuid(body["flow_id"]) or body["resource"] != resource
                    or body["mode"] not in ("live", "test", "internal")):
                return None
            _context({"reporting_token": body["reporting_token"]})
            life = (_utc(body["expires_at"]) - datetime.now(timezone.utc)).total_seconds()
            if not 0 < life <= self.MAX_AGE + 5:
                return None
            return ReportingFlow(body["flow_id"], body["reporting_token"], body["expires_at"], body["mode"], resource)
        except Exception:
            return None

    def health_sample(self):
        """Strict frozen sample, sequence allocated atomically; None after fork."""
        if os.getpid() != self._pid:
            return None
        with self._condition:
            if self._sequence >= 10 ** 20 - 1:
                return None
            self._sequence += 1
            return {"version": 2, "producer_id": self._producer_id, "sequence": str(self._sequence), "at": _utc_now(),
                    "supported": list(self._supported), "pending": len(self._queue),
                    "dropped": str(min(self._dropped, 10 ** 20 - 1)), "retries": str(min(self._retries, 10 ** 20 - 1)),
                    "last_error": self._last_error if self._last_error in (
                        "network", "timeout", "auth", "rejected", "storage", "queue_full", "retry_exhausted") else "none"}

    def health(self):
        """Attempt one health sample within the12/minute bound; False if not due.

        Failed attempts keep identical sample/sequence, at most five attempts.
        A valid acknowledged sample is exposed as stats['last_sample']; until
        then remote pending/drop coverage is unknown, not an acknowledged zero.
        """
        if os.getpid() != self._pid or not self._health_lock.acquire(blocking=False):
            return False
        reserved = False
        try:
            with self._condition:
                if self._closed or self._stopped or self._sending or time.monotonic() < self._health_at:
                    return False
                if self._health_retry is not None and time.monotonic() - self._health_created >= self.MAX_AGE:
                    self._health_retry = None
                    self._health_attempts = 0
                    self._last_error = "retry_exhausted"
                if self._health_retry is None:
                    self._health_retry = self.health_sample()
                    self._health_created = time.monotonic()
                if self._health_retry is None:
                    self._health_at = time.monotonic() + self.HEALTH_INTERVAL
                    return False
                self._health_attempts += 1
                self._health_at = time.monotonic() + max(self.HEALTH_INTERVAL, 2 ** (self._health_attempts - 1))
                self._sending = True
                reserved = True
            body, error, permanent = self._http(self._endpoint.rsplit("/", 1)[0] + "/reporting/health", self._health_retry)
            acknowledged = error is None and self._health_ack(body)
            with self._condition:
                if acknowledged:
                    self._last_sample = self._health_retry
                else:
                    self._last_error = error or "rejected"
                    if error == "auth":
                        self._stopped = True
                        self._dropped += len(self._queue)
                        self._queue = []
                    elif not permanent and self._health_attempts < self.MAX_ATTEMPTS:
                        self._retries += 1
                if acknowledged or permanent or self._health_attempts >= self.MAX_ATTEMPTS:
                    self._health_retry = None
                    self._health_attempts = 0
            return acknowledged
        finally:
            with self._condition:
                # This caller owns _sending only if it reserved a health send.
                # The health lock alone is not ownership of an event attempt.
                if reserved:
                    self._sending = False
                    self._condition.notify_all()
            self._health_lock.release()

    def _run(self):
        while True:
            with self._condition:
                if self._terminate:
                    return
                if self._sending:
                    self._condition.wait(.01)
                    continue
                if not getattr(self, "_v2_ready", False):
                    self._condition.wait(.01)
                    continue
                self._expire()
                now = time.monotonic()
                flush_ids = self._flush_ids
                if flush_ids is not None:
                    eligible = [i for i in self._queue if i["event"]["id"] in flush_ids
                                and i["event"]["id"] not in self._flush_attempted]
                    if not eligible:
                        self._flush_ids = None
                        self._flush_attempted.clear()
                        self._condition.notify_all()
                else:
                    eligible = self._queue
                batch = [i for i in eligible if i["next_at"] <= now
                         or flush_ids is not None and i["attempts"] == 0][:self.MAX_BATCH]
                health_due = now >= self._health_at and not self._closed and not self._stopped
                if not batch and not health_due:
                    self._condition.wait(max(.01, min(self.DELAY, min(
                        (i["next_at"] - now for i in eligible), default=self.DELAY))))
                    continue
                if health_due:
                    batch = []
                if batch:
                    self._sending = True
                    for i in batch:
                        i["attempts"] += 1
                        if self._flush_ids is not None:
                            self._flush_attempted.add(i["event"]["id"])
            if not batch:
                self.health()
                continue
            error, permanent = self._send(batch)
            with self._condition:
                self._sending = False
                if self._terminate:
                    self._condition.notify_all()
                    return
                ids = {i["event"]["id"] for i in batch}
                if error is None:
                    self._delivered += len(batch)
                    self._queue = [i for i in self._queue if i["event"]["id"] not in ids]
                    self._last_error = None
                elif permanent:
                    if error == "auth":
                        self._stopped = True
                        self._dropped += len(self._queue)
                        self._queue = []
                        self._flush_ids = None
                    else:
                        self._dropped += len(batch)
                        self._queue = [i for i in self._queue if i["event"]["id"] not in ids]
                    self._last_error = error
                else:
                    self._last_error = error
                    for i in batch:
                        if i["attempts"] >= self.MAX_ATTEMPTS or time.monotonic() - i["created"] >= self.MAX_AGE:
                            self._queue.remove(i)
                            self._dropped += 1
                            self._last_error = "retry_exhausted"
                        else:
                            self._retries += 1
                            i["next_at"] = time.monotonic() + 2 ** (i["attempts"] - 1)
                self._condition.notify_all()
