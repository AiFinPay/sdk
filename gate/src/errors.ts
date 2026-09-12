/**
 * Distinct classes rather than one message, because the recoveries differ: a
 * validation error is a bug in the caller's deploy script and should stop it,
 * an auth error means a wrong/rotated secret and should page someone, a
 * conflict is routine and `ensureResources` swallows it by design, and a meter
 * error is an infrastructure fault the gate must decide about per-request.
 */
export class AifpGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** 403 from the management API — wrong or rotated AIFP-Merchant-Secret. */
export class AifpAuthError extends AifpGateError {}

/** 409 — a resource with this route_pattern already exists. */
export class AifpConflictError extends AifpGateError {
  constructor(message: string, public readonly resourceId?: string) {
    super(message);
  }
}

/** 400 — carries the server's own `detail` string so the operator sees the
 *  same sentence the API returned rather than a paraphrase of it. */
export class AifpValidationError extends AifpGateError {
  constructor(public readonly detail: string) {
    super(detail);
  }
}

/** The quota store rejected. Never swallowed: `onStoreError` decides whether
 *  the request is refused (default) or served, and either way it is visible. */
export class AifpMeterError extends AifpGateError {}

/**
 * MemoryStore is full of counters that are all still live.
 *
 * Its own subclass because the fix is unlike any other meter error: no retry
 * helps and no backend is down. Either the process is metering more concurrent
 * batches than `maxKeys` allows, or — the case worth checking first — it is a
 * single-process store under traffic that deserves `redisStore`.
 */
export class StoreCapacityError extends AifpMeterError {
  constructor(public readonly maxKeys: number) {
    super(
      `MemoryStore is at capacity (${maxKeys} live counters). Refusing to evict a ` +
        `live counter: that would reset a prepaid batch's spend to zero and serve it ` +
        `again. Raise maxKeys, or move to a shared store (redisStore).`,
    );
  }
}
