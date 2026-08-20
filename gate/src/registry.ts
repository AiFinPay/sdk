import { matchResource } from "./match.js";
import type { AifpMerchant } from "./management.js";
import type { AifpResource, Tier } from "./types.js";

export interface ResourceRegistryOptions {
  merchant: AifpMerchant;
  /** Poll interval. Default 60s — a price change should reach a partner's
   *  gate within a minute without a redeploy, and that is the whole point. */
  refreshMs?: number;
  fallbackTier?: Tier;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly merchant: AifpMerchant;
  private readonly refreshMs: number;

  constructor(opts: ResourceRegistryOptions) {
    this.merchant = opts.merchant;
    this.refreshMs = opts.refreshMs ?? 60_000;
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
    } catch {
      /* keep the last good snapshot — see the class comment */
    }
    return this.resources;
  }

  match(path: string): AifpResource | null {
    return matchResource(this.resources, path);
  }

  snapshot(): { resources: AifpResource[]; fetched_at: string | null; stale: boolean } {
    const stale =
      this.fetchedAt == null || Date.now() - Date.parse(this.fetchedAt) > this.refreshMs * 3;
    return { resources: [...this.resources], fetched_at: this.fetchedAt, stale };
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    // Jitter so a fleet that restarted together does not poll in lockstep.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
