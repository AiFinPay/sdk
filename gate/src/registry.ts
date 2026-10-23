import { matchResource } from "./match.js";
import type { AifpMerchant } from "./management.js";
import { normalizeOperatorPolicy } from "./operator-policy.js";
import type { AifpResource, OperatorPolicy, Tier } from "./types.js";

export interface ResourceRegistryOptions {
  merchant: AifpMerchant;
  /** Poll interval. Default 60s — a price change should reach a partner's
   *  gate within a minute without a redeploy, and that is the whole point. */
  refreshMs?: number;
  fallbackTier?: Tier;
  /** Called on every failed refresh. Without it a rotated or revoked API key
   *  is indistinguishable from "this merchant has no endpoints" — the gate
   *  would meter the partner's whole API at the mount default, silently and
   *  forever. Wire it to your logger. */
  onError?: (err: unknown, ctx: { neverLoaded: boolean }) => void;
}

/**
 * The local mirror of the merchant's endpoint registry.
 *
 * This is what makes "register it with your API key, your own gate charges for
 * it" true without shipping code: the registry is fetched, matched per
 * request, and refreshed in the background.
 *
 * A failed refresh KEEPS THE LAST GOOD SNAPSHOT. Replacing it with an empty
 * list on a network blip would un-paywall the partner's whole API — a
 * transient control-plane error must never become free traffic. And if no
 * fetch has ever succeeded, `match` returns null, which the gate reads as
 * "paywalled at the mount's default tier", not as "free".
 */
export class ResourceRegistry {
  private resources: AifpResource[] = [];
  private fetchedAt: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly merchant: AifpMerchant;
  private readonly refreshMs: number;
  private readonly onError?: (err: unknown, ctx: { neverLoaded: boolean }) => void;
  private warnedNeverLoaded = false;
  /** Last refresh failure, or null after any success. Exposed on snapshot(). */
  private lastError: unknown = null;
  /** The merchant's operator rules as last read from the public merchant
   *  view, null until the first successful read. Same contract as the
   *  resources: a failed read keeps the last good copy, and "never loaded"
   *  leaves the gate deciding as it always has — a rule that is not applied
   *  yet costs the merchant nothing it was not already paying. */
  private policy: OperatorPolicy | null = null;

  constructor(opts: ResourceRegistryOptions) {
    this.merchant = opts.merchant;
    this.refreshMs = opts.refreshMs ?? 60_000;
    this.onError = opts.onError;
  }

  /** True until the FIRST successful fetch. Distinct from "loaded and empty":
   *  an empty registry is a real answer, never having reached the control
   *  plane is not. The gate must not price traffic in this state. */
  get neverLoaded(): boolean {
    return this.fetchedAt == null;
  }

  /** Never throws into a request path: callers are a boot script (which may
   *  want to await it) and a background timer (which must not crash). */
  async refresh(): Promise<AifpResource[]> {
    try {
      const next = await this.merchant.listResources();
      if (Array.isArray(next)) {
        this.resources = next;
        this.fetchedAt = new Date().toISOString();
      }
      // The operator rules ride on the public merchant view, read on the same
      // cadence so a rule saved on the dashboard reaches the gate as fast as
      // a price change does. Only after the resources came back: the two
      // share a transport and a key, and one failure is one failure.
      this.policy = normalizeOperatorPolicy(await this.merchant.merchant());
    } catch (err) {
      // Keep the last good snapshot (see the class comment) but never swallow
      // the reason. A revoked API key raises here exactly like a network blip,
      // and the difference matters: one recovers, the other never will.
      this.lastError = err;
      try {
        this.onError?.(err, { neverLoaded: this.neverLoaded });
      } catch {
        /* a logger must not break the poll loop */
      }
      if (this.neverLoaded && !this.warnedNeverLoaded) {
        this.warnedNeverLoaded = true;
        // Once, loudly: this is the state where a partner believes their API is
        // paywalled and it is not priced from the registry at all.
        console.warn(
          "[aifinpay/gate] resource registry has never loaded — check AIFP-Merchant-Secret and network reachability. Requests are being priced at the mount default until the first successful fetch.",
          err
        );
      }
    }
    return this.resources;
  }

  match(path: string): AifpResource | null {
    return matchResource(this.resources, path);
  }

  /** The merchant's operator rules (allow / charge / block per operator) as
   *  last read, or null before the first successful read. The gate reads
   *  this on every request; see GateOptions.operatorPolicy. */
  operatorPolicy(): OperatorPolicy | null {
    return this.policy;
  }

  snapshot(): {
    resources: AifpResource[];
    fetched_at: string | null;
    stale: boolean;
    never_loaded: boolean;
    last_error: unknown;
    operator_policy: OperatorPolicy | null;
  } {
    const stale = this.fetchedAt == null || Date.now() - Date.parse(this.fetchedAt) > this.refreshMs * 3;
    return {
      resources: [...this.resources],
      fetched_at: this.fetchedAt,
      stale,
      never_loaded: this.neverLoaded,
      last_error: this.lastError,
      operator_policy: this.policy,
    };
  }

  /** Returns the FIRST refresh so a boot script can await it and fail fast
   *  rather than serving traffic against an empty registry. */
  start(): Promise<AifpResource[]> {
    if (this.timer) return Promise.resolve(this.resources);
    const first = this.refresh();
    this.schedule();
    return first;
  }

  /** Self-rescheduling timeout rather than setInterval, so each tick can carry
   *  its own jitter — a fleet that restarted together must not poll in
   *  lockstep and turn a routine refresh into a thundering herd. */
  private schedule(): void {
    const jitter = this.refreshMs * (0.85 + Math.random() * 0.3);
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => {
        if (this.timer) this.schedule();
      });
    }, jitter);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
